import { randomUUID } from 'node:crypto'

const EXPIRED = 'Computer control ended. Select a target again in the conversation.'
const BUSY = 'This computer is already in use.'
const TURN_LIFETIME = 5 * 60_000
const WAIT_HEARTBEAT = 12_000
const sameOwner = (a, b) => a.session === b.session && a.turn === b.turn

export function createComputerControl(backends) {
  const slots = new Map()

  function slotFor(target, scope) {
    const backend = backends[target]
    if (closed || !backend) throw new Error(EXPIRED)
    const key = scope === undefined ? target : `${target}:${scope}`
    if (!slots.has(key)) slots.set(key, { backend, scope, waiters: [] })
    return slots.get(key)
  }
  let closed = false

  function stop(slot) {
    const lease = slot.lease
    if (!lease) return slot.draining ?? Promise.resolve()
    slot.lease = undefined
    clearTimeout(lease.timer)
    lease.signal.abort()
    slot.drainingType = lease.type
    // A new owner must wait for the driver and the in-flight call to finish releasing input.
    slot.draining = Promise.all([lease.done.catch(error => {
      if (error instanceof AggregateError) throw error
    }), lease.tail]).then(async ([driver]) => {
      await driver?.close()
    }).catch(error => { slot.failed = true; throw error }).finally(() => {
      slot.draining = undefined
      slot.drainingType = undefined
    })
    return slot.draining
  }

  // FIFO admission adapted from OpenMausBot's TurnResources. Only a fresh poll can claim.
  function queue(slot) {
    slot.waiters = slot.waiters.filter(entry => entry.until > Date.now())
    return slot.waiters
  }

  function wait(slot, owner, grant) {
    if (closed || slot.failed) throw new Error(EXPIRED)
    const waiters = queue(slot)
    const index = waiters.findIndex(entry => entry.grant === grant && sameOwner(entry.owner, owner))
    const until = Date.now() + WAIT_HEARTBEAT
    if (index >= 0) {
      waiters[index].until = until
      return index + 1
    }
    waiters.push({ owner, grant, until })
    return waiters.length
  }

  function cancelWaiting(slot, grant, owner) {
    slot.waiters = queue(slot).filter(entry => entry.grant !== grant || (owner && !sameOwner(entry.owner, owner)))
  }

  function acquire(slot, owner, type, runningInstance) {
    if (closed || !slot || slot.failed || slot.draining || slot.lease) throw new Error(BUSY)
    if (!owner || typeof owner.session !== 'string' || typeof owner.turn !== 'string') throw new Error(EXPIRED)
    const signal = new AbortController()
    const lease = { id: randomUUID(), owner: { ...owner }, type, signal, tail: Promise.resolve() }
    slot.lease = lease
    lease.expiresAt = Date.now() + TURN_LIFETIME
    lease.done = Promise.resolve().then(() => slot.backend.open(undefined, signal.signal, slot.scope, Boolean(runningInstance), undefined, runningInstance))
    lease.done.catch(() => { if (slot.lease === lease) void stop(slot).catch(() => {}) })
    lease.timer = setTimeout(() => { if (slot.lease === lease) void stop(slot).catch(() => {}) }, TURN_LIFETIME)
    lease.timer.unref()
    return lease.id
  }

  function requireLease(slot, id, owner, type) {
    const lease = slot?.lease
    if (!lease || lease.id !== id || lease.type !== type || lease.owner.session !== owner.session || lease.owner.turn !== owner.turn) {
      throw new Error(EXPIRED)
    }
    return lease
  }

  function run(slot, id, owner, type, action) {
    const lease = requireLease(slot, id, owner, type)
    if (lease.queued) throw new Error('A computer action is already in progress.')
    lease.queued = true
    const result = lease.tail.then(async () => {
      const driver = await lease.done
      requireLease(slot, id, owner, type)
      const output = await driver.run(action, lease.signal.signal)
      requireLease(slot, id, owner, type)
      return output
    }).finally(() => { lease.queued = false })
    lease.tail = result.catch(() => {})
    return result
  }

  function release(slot, id, owner, type) {
    if (slot?.lease?.id !== id) return slot?.draining ?? Promise.resolve()
    requireLease(slot, id, owner, type)
    return stop(slot)
  }

  return {
    slotFor, acquire, run, release, wait, cancelWaiting,
    async ready(slot, id, owner, type) {
      const lease = requireLease(slot, id, owner, type)
      await lease.done
      requireLease(slot, id, owner, type)
    },
    async live(slot, id, owner, port) {
      const lease = requireLease(slot, id, owner, 'user')
      const driver = await lease.done
      requireLease(slot, id, owner, 'user')
      if (!driver.openLive) throw new Error(EXPIRED)
      return driver.openLive(port)
    },
    holder(slot) {
      if (slot.failed) return { expiresAt: Infinity }
      if (slot.lease) return slot.lease
      if (slot.draining || slot.handoff || queue(slot).length) return { expiresAt: Date.now() }
      return null
    },
    waitCount: slot => queue(slot).length,
    available: slot => !closed && !slot.failed && !slot.lease && !slot.draining && !slot.handoff,
    active: (slot, id) => slot?.lease?.id === id,
    humanBusy: () => [...slots.values()].some(slot => slot.lease?.type === 'user' || slot.drainingType === 'user'),
    busy: (target, matches = () => true) => [...slots.values()].some(slot => slot.backend === backends[target] && matches(slot.scope)
      && (slot.lease || slot.draining || slot.failed || slot.handoff || queue(slot).length)),
    async drain(target, matches = () => true) {
      const selected = [...slots.values()].filter(slot => slot.backend === backends[target] && matches(slot.scope))
      await Promise.all(selected.map(stop))
      if (selected.some(slot => slot.failed)) throw new Error(EXPIRED)
    },
    status: (slot, id) => {
      if (!slot) return 'unavailable'
      if (slot.failed) return 'unavailable'
      if (slot.draining) return 'stopping'
      if (!slot.lease) return 'idle'
      return slot.lease.id === id ? slot.lease.type : 'busy'
    },
    async close() {
      closed = true
      await Promise.allSettled([...slots.values()].map(stop))
      await Promise.all(Object.values(backends).map(backend => backend.close?.()))
    },
  }
}

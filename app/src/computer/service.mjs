import { randomUUID } from 'node:crypto'
import { createComputerControl } from './control.mjs'
import { DesktopSeatPool, isPoolOperator, poolOperator } from './seat-pool.mjs'

const key = value => typeof value === 'string' && /^[\w-]{1,120}$/u.test(value)
const changed = () => new Error('Computer control ended. Select a target again in the conversation.')
const CHOICE_LIFETIME = 30_000
const PREVIEW_LIFETIME = 30_000

export function createComputerService(backends, confirm, { privateMode = () => 'shared', privateScope, maxInstances = () => 2 } = {}) {
  const control = createComputerControl(backends)
  const pool = new DesktopSeatPool(maxInstances)
  const grants = new Map()
  let choice
  let selecting
  let closed = false
  let privateMaintenance
  let takingControl = false
  const underMaintenance = operator => privateMaintenance && (privateMode() === 'pool' || privateMaintenance(operatorFor(operator)))
  const validOperator = operator => {
    if (privateMode() === 'shared') return operator === undefined
    if (privateMode() === 'pool') return isPoolOperator(operator) && Number(operator.slice(-1)) <= maxInstances()
    return key(operator) && !isPoolOperator(operator)
  }
  const operatorFor = operator => privateMode() === 'per-bot' ? operator : undefined
  const revoking = new Map()

  function discard(conversation) {
    if (choice?.conversation === conversation) choice = undefined
    if (selecting?.conversation === conversation) selecting = undefined
  }

  function clearPreview(grant) {
    grant.preview = undefined
    grant.previewRevision = Symbol()
  }

  function previewOf(grant) {
    return grant?.preview?.until > Date.now() ? grant.preview.image : undefined
  }

  function setPreview(grant, image) {
    grant.preview = { image, until: Date.now() + PREVIEW_LIFETIME }
  }

  function release(grant) {
    clearPreview(grant)
    const lease = grant.lease
    if (!lease) return grant.draining ?? Promise.resolve()
    if (lease.type === 'bot') grant.finishedTurns.add(lease.owner.turn)
    if (lease.type !== 'viewer' && grant.seat !== undefined) pool.renew(grant.conversation, grant.seat)
    lease.released = true
    grant.lease = undefined
    const draining = control.release(grant.slot, lease.id, lease.owner, lease.type).finally(() => {
      if (grant.draining === draining) grant.draining = undefined
    })
    grant.draining = draining
    return draining
  }

  function revoke(conversation) {
    const pending = revoking.get(conversation)
    if (pending) return pending
    discard(conversation)
    const grant = grants.get(conversation)
    grants.delete(conversation)
    if (grant) control.cancelWaiting(grant.slot, grant)
    const draining = grant ? release(grant) : Promise.resolve()
    revoking.set(conversation, draining)
    return draining.finally(() => {
      if (revoking.get(conversation) === draining) revoking.delete(conversation)
    })
  }

  function view(conversation) {
    const grant = grants.has(conversation) ? current(conversation) : undefined
    return {
      targets: Object.keys(backends), target: grant?.target, operator: grant?.operator,
      status: grant ? control.status(grant.slot, grant.lease?.id) : 'idle',
      waiting: grant ? control.waitCount(grant.slot) : 0, privateMode: privateMode(),
    }
  }

  async function choose(conversation, target, operator) {
    const group = typeof conversation === 'string' && conversation.startsWith('room-')
    if (group ? operator !== undefined || target !== 'private-desktop' || privateMode() !== 'shared' : !key(operator)) throw changed()
    if (closed || !key(conversation) || !Object.hasOwn(backends, target) || selecting || (target === 'private-desktop' && underMaintenance(operator))) throw changed()
    const pending = { conversation, target, operator, token: randomUUID() }
    selecting = pending
    choice = undefined
    try {
      if (!await confirm(target)) return null
      if (closed || selecting !== pending || (target === 'private-desktop' && underMaintenance(operator))) throw changed()
      choice = { ...pending, until: Date.now() + CHOICE_LIFETIME }
      return pending.token
    } finally {
      if (selecting === pending) selecting = undefined
    }
  }

  async function select(conversation, token, operator) {
    const approved = choice
    if (selecting || !approved || approved.conversation !== conversation || approved.token !== token || approved.operator !== operator || approved.until <= Date.now()) throw changed()
    const released = revoke(conversation)
    selecting = approved
    try {
      await released
      const isPrivate = approved.target === 'private-desktop'
      if (closed || selecting !== approved || (isPrivate && underMaintenance(operator))
        || (conversation.startsWith('room-') && privateMode() !== 'shared')) throw changed()
      let scope = isPrivate ? operatorFor(operator) : undefined
      let seat
      if (isPrivate && privateMode() === 'pool') {
        seat = pool.assign(conversation, index => control.holder(control.slotFor(approved.target, poolOperator(index))))
        scope = poolOperator(seat)
      }
      const slot = control.slotFor(approved.target, scope)
      grants.set(conversation, { ...approved, slot, seat, display: randomUUID(), finishedTurns: new Set() })
      return view(conversation)
    } finally {
      if (selecting === approved) selecting = undefined
    }
  }

  function claim(grant, owner, type) {
    if (grant.target === 'private-desktop' && privateMaintenance?.(grant.slot.scope)) throw new Error('The private desktop is unavailable while it is being prepared.')
    const id = control.acquire(grant.slot, owner, type)
    const lease = { id, owner, type }
    clearPreview(grant)
    grant.lease = lease
    return lease
  }

  async function action(grant, owner, type, input) {
    const lease = grant.lease ?? claim(grant, owner, type)
    const result = await control.run(grant.slot, lease.id, owner, type, input)
    if (grant.lease !== lease) throw changed()
    if (input.kind === 'observe') setPreview(grant, result)
    return result
  }

  function current(conversation) {
    const grant = grants.get(conversation)
    if (closed || !grant) throw changed()
    if (grant.lease && !control.active(grant.slot, grant.lease.id)) {
      if (grant.lease.type === 'bot') grant.finishedTurns.add(grant.lease.owner.turn)
      grant.lease = undefined
      clearPreview(grant)
    }
    return grant
  }

  function observe(grant, conversation) {
    const { lease } = grant
    if (grant.observing && grant.observing.lease === lease) return grant.observing.task
    const observing = { lease, task: capture(grant, conversation) }
    if (!lease && grant.lease?.type === 'viewer') observing.lease = grant.lease
    grant.observing = observing
    return observing.task.finally(() => {
      if (grant.observing === observing) grant.observing = undefined
    })
  }

  async function capture(grant, conversation) {
    if (grant.lease?.type === 'bot') return
    if (grant.lease?.type === 'user') {
      const lease = grant.lease
      try {
        await action(grant, lease.owner, 'user', { kind: 'observe' })
      } catch (error) {
        if (!lease.released) throw error
      }
      return
    }
    if (control.waitCount(grant.slot) || !control.available(grant.slot)) return
    const owner = { session: conversation, turn: randomUUID() }
    const lease = claim(grant, owner, 'viewer')
    let preview
    let revision
    try {
      preview = await control.run(grant.slot, lease.id, owner, 'viewer', { kind: 'observe' })
    } catch (error) {
      if (!lease.released) throw error
      return
    } finally {
      if (grant.lease === lease) {
        const draining = release(grant)
        revision = grant.previewRevision
        await draining
      }
    }
    if (revision && grant.previewRevision === revision && grants.get(conversation) === grant && !grant.lease && !grant.transition) setPreview(grant, preview)
  }

  async function maintainPrivate(revokeGrants, action, matches = () => true) {
    if (closed || privateMaintenance) throw changed()
    privateMaintenance = matches
    try {
      if (revokeGrants) {
        if (choice?.target === 'private-desktop' && matches(operatorFor(choice.operator))) choice = undefined
        if (selecting?.target === 'private-desktop' && matches(operatorFor(selecting.operator))) selecting = undefined
        const conversations = [...grants].filter(([, grant]) => grant.target === 'private-desktop' && matches(grant.slot.scope))
        await Promise.all(conversations.map(([conversation]) => revoke(conversation)))
        await control.drain('private-desktop', matches)
      } else if (control.busy('private-desktop', matches)) throw new Error('Stop computer control before preparing the private desktop.')
      if (closed) throw changed()
      return await action()
    } finally { privateMaintenance = undefined }
  }

  const sameOwner = (a, b) => Boolean(a && b && a.session === b.session && a.turn === b.turn)
  return {
    choose,
    async checkStartup(operator) {
      const backend = backends['private-desktop']
      if (!backend?.checkStartup || !validOperator(operator)) throw changed()
      return maintainPrivate(false, () => backend.checkStartup(operator), scope => scope === operator)
    },
    async previewPrivateInstance(operator) {
      const backend = backends['private-desktop']
      if (!backend?.previewInstance || (operator !== undefined && !key(operator))) throw changed()
      return maintainPrivate(false, () => backend.previewInstance(operator), scope => scope === operator)
    },
    async setup(rebuild, report) {
      if (!backends['private-desktop']?.setup) throw changed()
      await maintainPrivate(rebuild, () => backends['private-desktop'].setup(rebuild, report))
    },
    async changePrivatePolicy(save) {
      await maintainPrivate(true, async () => {
        await backends['private-desktop'].stopManaged()
        if (closed) throw changed()
        save()
        pool.clear()
      })
    },
    async stopPrivate() {
      await maintainPrivate(true, () => backends['private-desktop'].stopManaged())
    },
    async stopPrivateInstance(scope) {
      if (!privateScope || !backends['private-desktop']?.stopInstance) throw changed()
      await maintainPrivate(true, () => backends['private-desktop'].stopInstance(scope), operator => privateScope(operator) === scope)
    },
    async deletePrivateInstance(scope, id) {
      const backend = backends['private-desktop']
      if (!privateScope || !backend?.deleteInstance) throw changed()
      await maintainPrivate(true, () => backend.deleteInstance(scope, id), operator => privateScope(operator) === scope)
    },
    async startPrivateInstance(operator, restart, report) {
      const backend = backends['private-desktop']
      if (!privateScope || !backend?.startInstance || !validOperator(operator)) throw changed()
      const scope = privateScope(operator)
      return maintainPrivate(restart, async () => {
        if (restart) await backend.stopInstance(scope)
        if (closed) throw changed()
        return backend.startInstance(operator, report)
      }, active => privateScope(active) === scope)
    },
    async request({ op, conversation, token, operator, owner, action: input } = {}) {
      if (closed || !key(conversation)) throw changed()
      if (op === 'status') return view(conversation)
      if (op === 'select') return select(conversation, token, operator)
      if (op === 'stop') { await revoke(conversation); return view(conversation) }
      if (op === 'release' && !grants.has(conversation)) return view(conversation)
      const grant = current(conversation)
      if (grant.token !== token || !key(owner?.session) || !key(owner?.turn)) throw changed()
      if (op === 'release') {
        control.cancelWaiting(grant.slot, grant, owner)
        grant.finishedTurns.add(owner.turn)
        if (grant.finishedTurns.size >= 4096) { await revoke(conversation); return view(conversation) }
        if (grant.lease?.type === 'bot' && sameOwner(owner, grant.lease.owner)) await release(grant)
        return view(conversation)
      }
      if (op !== 'action' || grant.finishedTurns.has(owner.turn)) throw changed()
      if (grant.lease?.type === 'bot' && sameOwner(grant.lease.owner, owner) && !grant.transition) {
        return action(grant, owner, 'bot', input)
      }
      if (input?.kind !== 'observe') throw changed()
      if (grant.target === 'private-desktop' && privateMaintenance?.(grant.slot.scope)) throw changed()
      const position = control.wait(grant.slot, owner, grant)
      if (position !== 1 || grant.transition || !control.available(grant.slot)) return { waiting: true, position }
      control.cancelWaiting(grant.slot, grant, owner)
      return action(grant, owner, 'bot', input)
    },
    async inline(conversation, op, input, display) {
      if (op === 'status') {
        if (closed || !key(conversation)) throw changed()
        const state = view(conversation)
        const grant = grants.get(conversation)
        return { ...state, preview: previewOf(grant), display: grant?.display }
      }
      if (!['observe', 'take', 'hand-back', 'input'].includes(op)) throw changed()
      const grant = grants.get(conversation)
      const passive = op === 'observe' || op === 'hand-back'
      if (!grant || typeof display !== 'string' || grant.display !== display) {
        if (passive) return null
        throw changed()
      }
      try {
        return { ...await this.local(conversation, op, input, grant.token), display }
      } catch (error) {
        if (passive && grants.get(conversation) !== grant) return null
        throw error
      }
    },
    async live(conversation, display, port) {
      const grant = current(conversation)
      const lease = grant.lease
      if (grant.display !== display || grant.target !== 'private-desktop' || lease?.type !== 'user' || lease.live) throw changed()
      lease.live = true
      const end = () => { if (grant.lease === lease) void release(grant).catch(() => {}) }
      port.once('close', end)
      try {
        await control.live(grant.slot, lease.id, lease.owner, port)
      } finally {
        port.off('close', end)
        end()
      }
    },
    viewerBinding(conversation) {
      const grant = current(conversation)
      if (grant.target !== 'private-desktop') throw changed()
      return grant.token
    },
    async local(conversation, op, input, binding) {
      if (closed || !key(conversation)) throw changed()
      if (binding !== undefined && grants.get(conversation)?.token !== binding) throw changed()
      if (op === 'status') return { ...view(conversation), preview: previewOf(grants.get(conversation)) }
      if (op === 'hand-back' && !grants.has(conversation)) return view(conversation)
      const grant = current(conversation)
      if (op === 'hand-back') {
        grant.transition = undefined
        if (grant.lease?.type !== 'bot') await release(grant)
      } else if (op === 'take') {
        if (grant.transition || grant.slot.handoff) throw changed()
        if (grant.lease?.type === 'user') return { ...view(conversation), preview: previewOf(grant) }
        if (takingControl || control.humanBusy()) throw new Error('Hand back the other desktop before taking control here.')
        takingControl = true
        const transition = Symbol()
        grant.transition = transition
        grant.slot.handoff = transition
        try {
          const holder = [...grants.values()].find(entry => entry.slot === grant.slot && entry.lease && entry.lease.type !== 'user')
          if (holder) await release(holder)
          else await grant.slot.draining
          if (closed || grants.get(conversation) !== grant || grant.transition !== transition) throw changed()
          claim(grant, { session: conversation, turn: randomUUID() }, 'user')
        } finally {
          if (grant.transition === transition) grant.transition = undefined
          if (grant.slot.handoff === transition) grant.slot.handoff = undefined
          takingControl = false
        }
      } else if (op === 'observe') {
        if (grant.transition) throw changed()
        await observe(grant, conversation)
      } else if (op === 'input') {
        if (grant.lease?.type !== 'user' || grant.target !== 'private-desktop' || input?.kind === 'observe') throw changed()
        await action(grant, grant.lease.owner, 'user', input)
      } else throw changed()
      if (grants.get(conversation) !== grant) throw changed()
      return { ...view(conversation), preview: previewOf(grant) }
    },
    async reset() {
      selecting = undefined
      choice = undefined
      await Promise.all([...grants.keys()].map(revoke))
    },
    async close() {
      closed = true
      selecting = undefined
      choice = undefined
      grants.clear()
      await control.close()
    },
  }
}

// Seat selection adapted from OpenMausBot server/local-vm-seat-pool.ts (Apache-2.0, see NOTICE).
const AFFINITY_TTL = 30 * 60_000

export const poolOperator = seat => `pool-seat-${seat + 1}`
export const isPoolOperator = value => typeof value === 'string' && /^pool-seat-[1-8]$/u.test(value)

export class DesktopSeatPool {
  #affinity = new Map()

  constructor(count, now = Date.now) {
    this.#count = count
    this.#now = now
  }

  #count
  #now

  assign(threadId, holderOf) {
    const now = this.#now()
    const seats = this.#count()
    for (const [id, entry] of this.#affinity) {
      if (entry.expiresAt <= now || entry.seat >= seats) this.#affinity.delete(id)
    }
    const seat = this.#affinity.get(threadId)?.seat ?? this.#selectSeat(threadId, holderOf, now)
    this.renew(threadId, seat)
    return seat
  }

  renew(threadId, seat) {
    this.#affinity.set(threadId, { seat, expiresAt: this.#now() + AFFINITY_TTL })
  }

  clear() {
    this.#affinity.clear()
  }

  #selectSeat(threadId, holderOf, now) {
    const seats = this.#count()
    const holders = []
    for (let seat = 0; seat < seats; seat += 1) holders.push(holderOf(seat))
    const softHeld = new Set()
    for (const [otherId, entry] of this.#affinity) {
      if (otherId !== threadId && entry.expiresAt > now && entry.seat < seats) softHeld.add(entry.seat)
    }
    for (let pass = 0; pass < 2; pass += 1) {
      for (let seat = 0; seat < seats; seat += 1) {
        if (holders[seat] !== null) continue
        if (pass === 0 && softHeld.has(seat)) continue
        return seat
      }
    }
    let soonest = 0
    for (let seat = 1; seat < seats; seat += 1) {
      const best = holders[soonest]
      const current = holders[seat]
      if (best && current && current.expiresAt < best.expiresAt) soonest = seat
    }
    return soonest
  }
}

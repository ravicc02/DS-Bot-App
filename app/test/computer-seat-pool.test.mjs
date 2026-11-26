import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DesktopSeatPool } from '../src/computer/seat-pool.mjs'

test('a pool prefers unused idle desktops, then idle desktops, then the earliest release', () => {
  let now = 0
  const pool = new DesktopSeatPool(() => 3, () => now)
  const idle = () => null
  assert.equal(pool.assign('a', idle), 0)
  assert.equal(pool.assign('b', idle), 1)
  assert.equal(pool.assign('c', seat => seat === 2 ? { expiresAt: 3 } : null), 0)
  assert.equal(pool.assign('a', () => ({ expiresAt: 9 })), 0)
  assert.equal(pool.assign('d', seat => ({ expiresAt: [9, 6, 7][seat] })), 1)
  now += 31 * 60_000
  assert.equal(pool.assign('b', idle), 0)
})

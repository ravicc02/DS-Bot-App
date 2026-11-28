import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkedAction, createDriver } from '../src/computer/driver.mjs'

const point = { x: { type: 'number' }, y: { type: 'number' } }
const button = { type: 'string', enum: ['left', 'middle', 'right'] }
const common = {
  target: { type: 'object', properties: { kind: { type: 'string', const: 'desktop' }, display_id: { type: 'string' } } },
  delivery_mode: { type: 'string', enum: ['foreground'] },
}
const tool = (name, properties) => ({ name, inputSchema: { type: 'object', properties: { ...common, ...properties } } })
const imageHeader = Buffer.from('89504e470d0a1a0a0000000d494844520000004000000020', 'hex').toString('base64')

async function fixture(t, bindCapture) {
  const calls = []
  const driver = await createDriver({
    initialize: async () => [
      tool('get_desktop_state', {}),
      tool('click', { ...point, button, count: { type: 'integer' }, capture_id: { type: 'string' } }),
      tool('drag', { button, from_x: point.x, from_y: point.y, to_x: point.x, to_y: point.y }),
      tool('type_text', { text: { type: 'string' } }),
      tool('press_key', { key: { type: 'string' } }),
      tool('hotkey', { keys: { type: 'array', items: { type: 'string' } } }),
      tool('scroll', { ...point, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer' } }),
    ],
    call: async (name, args) => {
      calls.push({ name, ...args })
      return name === 'get_desktop_state'
        ? { content: [{ type: 'image', mimeType: 'image/png', data: imageHeader }], structuredContent: { capture_id: 'frame-1' } }
        : { content: [] }
    },
    close: async () => {},
  }, { signal: new AbortController().signal, bindCapture })
  t.after(driver.close)
  return { calls, run: driver.run }
}

test('Windows forwards old click calls and consumes the exact capture for each click', async t => {
  const { calls, run } = await fixture(t, true)
  await run({ kind: 'observe' })
  await run({ kind: 'click', x: 3, y: 5 })
  assert.deepEqual(calls.at(-1), {
    name: 'click', x: 3, y: 5, count: 1, button: 'left', capture_id: 'frame-1',
    target: { kind: 'desktop', display_id: 'primary' }, delivery_mode: 'foreground',
  })
  await assert.rejects(run({ kind: 'click', x: 3, y: 5 }), /latest computer screenshot/u)
  assert.equal(calls.length, 2)
  await run({ kind: 'observe' })
  await run({ kind: 'click', x: 3, y: 5, count: 2, button: 'right' })
  assert.equal(calls.at(-1).count, 2)
  assert.equal(calls.at(-1).button, 'right')
})

test('drag validates both endpoints, clears the frame and forwards horizontal scroll after observing', async t => {
  const { calls, run } = await fixture(t, false)
  const drag = { kind: 'drag', from_x: 6, from_y: 6, to_x: 30, to_y: 9 }
  const scroll = { kind: 'scroll', x: 5, y: 4, direction: 'right', amount: 2 }
  await run({ kind: 'observe' })
  await assert.rejects(run({ ...drag, from_x: 64 }), /latest computer screenshot/u)
  await assert.rejects(run({ ...drag, to_y: 32 }), /latest computer screenshot/u)
  assert.equal(calls.length, 1)
  await run(drag)
  assert.equal(calls.at(-1).name, 'drag')
  assert.equal(calls.at(-1).button, 'left')
  assert.equal(calls.at(-1).capture_id, undefined)
  await assert.rejects(run(scroll), /latest computer screenshot/u)
  await run({ kind: 'observe' })
  await run(scroll)
  assert.equal(calls.at(-1).direction, 'right')
  await run({ kind: 'hotkey', keys: ['ctrl', 'a'] })
  assert.deepEqual(calls.at(-1).keys, ['ctrl', 'a'])
})

test('input rejects unrecognized click options and malformed shortcuts', () => {
  for (const action of [
    { kind: 'click', x: 1, y: 3, count: 3 },
    { kind: 'click', x: 1, y: 3, button: 'other' },
    { kind: 'hotkey', keys: ['ctrl', 'ctrl', 'a'] },
    { kind: 'hotkey', keys: ['ctrl', 'shift'] },
    { kind: 'hotkey', keys: ['ctrl+a'] },
  ]) assert.throws(() => checkedAction(action), /Invalid computer action/u)
})

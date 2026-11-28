import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installComputer } from '../src/host/computer/index.js'
import { scopeComputerImages } from '../src/host/computer/images.js'

function fixture(requestComputer) {
  const listeners = new Map()
  const calls = []
  const approvals = []
  let reset
  const rt = {
    ctx: {
      on: (name, handler) => listeners.set(name, handler),
      effect() {},
      get: name => ({
        approval: { request: request => { approvals.push(request); return approvals.respond(request) } },
        attachments: { saveImage: async image => ({ ...image, attachmentId: 'shot' }) },
      })[name],
      llm: { resolveModelInfo: async () => ({ inputModalities: ['image'] }) },
    },
    teamTools: [], config: {}, readOnly: () => undefined,
    chatOwners: new Map([['private', 'bot']]), groupOwners: new Map(),
    botOf: id => id === 'bot' ? { id } : undefined, chatOf: () => 'private', roomOf: () => undefined,
  }
  approvals.respond = async () => 'allowed-once'
  installComputer(rt, {
    onReset: listener => { reset = listener },
    call: async request => {
      calls.push(request)
      if (requestComputer) return requestComputer(request)
      if (request.op === 'action') return { mediaType: 'image/png', data: 'ZmFrZQ==', width: 1, height: 1 }
    },
  })
  const session = { id: 'private', requestHeader: () => ({ config: { provider: 'test', model: 'vision' } }) }
  const observe = rt.teamTools.find(tool => tool.name === 'computer_observe')
  return {
    rt, calls, approvals, reset,
    select: token => rt.computerChannel('select', { subject: 'bot', token }),
    turn: (type, id = session.id) => listeners.get('session/event')({ ...session, id }, { type }),
    selectGroup: operator => rt.computerChannel('select', { subject: 'room', token: 'group', operator }),
    observe: overrides => observe.execute({}, {
      name: observe.name, agent: { session }, signal: new AbortController().signal,
      callId: 'root', rootCallId: 'root', ...overrides,
    }),
  }
}

test('desktop navigation cancels pending approval and refuses the old turn', async () => {
  const test = fixture()
  const approval = Promise.withResolvers()
  const waiting = Promise.withResolvers()
  test.approvals.respond = request => { waiting.resolve(request); return approval.promise }
  await test.select('first')
  test.turn('turn/start')
  const rejected = assert.rejects(test.observe(), /control ended/u)
  const { signal } = await waiting.promise
  test.reset()
  assert.equal(signal.aborted, true)
  approval.resolve('allowed-once')
  await rejected
  assert.deepEqual(test.calls.map(call => call.op), ['select'])
  await test.select('second')
  await assert.rejects(test.observe(), /control ended/u)
  test.turn('turn/start')
  await test.observe()
  assert.deepEqual(test.calls.map(call => call.op), ['select', 'select', 'action'])
})

test('a fresh part keeps the selected desktop and needs its own turn approval', async () => {
  const test = fixture()
  await test.select('first')
  test.turn('turn/start')
  await test.observe()
  test.rt.chatOf = () => 'fresh'
  test.rt.chatOwners.delete('private')
  test.rt.chatOwners.set('fresh', 'bot')
  test.rt.checkComputerOwners()

  await assert.rejects(test.observe(), /control ended/u)
  assert.equal(test.rt.computerImageForRequest({ sessionId: 'private', provider: 'test', model: 'vision' }), undefined)
  assert.deepEqual(test.calls.map(call => call.op), ['select', 'action', 'release'])

  test.turn('turn/start', 'fresh')
  await test.observe({ agent: { session: { id: 'fresh', requestHeader: () => ({ config: { provider: 'test', model: 'vision' } }) } } })
  assert.equal(test.approvals.length, 2)
  assert.deepEqual(test.calls.at(-1).owner.session, 'fresh')
  assert.equal(test.calls.at(-1).token, 'first')
})

test('computer tools reject indirect calls before requesting approval or input', async () => {
  const test = fixture()
  await test.select('first')
  test.turn('turn/start')
  await assert.rejects(test.observe({ parent: {}, callId: 'child' }), /directly from the model/u)
  await assert.rejects(test.observe({ rootCallId: 'other' }), /directly from the model/u)
  assert.equal(test.approvals.length, 0)
  assert.deepEqual(test.calls.map(call => call.op), ['select'])
})

test('screenshots are visible only to the approved session, turn and model route', async () => {
  const test = fixture()
  await test.select('first')
  test.turn('turn/start')
  const { attachment } = await test.observe()
  const messages = [{ role: 'tool', content: [{ type: 'image', attachment }] }]
  const request = { sessionId: 'private', provider: 'test', model: 'vision' }
  const scoped = options => scopeComputerImages(messages, test.rt.computerImageForRequest(options))
  assert.equal(scoped(request), messages)
  for (const changes of [{ model: 'other' }, { provider: 'other' }, { sessionId: 'other' }, { purpose: 'summary' }]) {
    assert.equal(scoped({ ...request, ...changes })[0].content[0].type, 'text')
  }
  test.turn('turn/end')
  assert.equal(scoped(request)[0].content[0].type, 'text')
  test.turn('turn/start')
  assert.equal(scoped(request)[0].content[0].type, 'text')
})


test('shared desktop members receive individual approval and removed members lose access', async () => {
  const test = fixture()
  const room = { id: 'room', members: ['one', 'two'], sessions: { one: 'a', two: 'b' } }
  test.rt.roomOf = id => id === room.id ? room : undefined
  test.rt.botOf = id => room.members.includes(id) ? { id } : undefined
  test.rt.groupOwners.set('a', { roomId: 'room', botId: 'one' })
  test.rt.groupOwners.set('b', { roomId: 'room', botId: 'two' })
  const observe = id => test.observe({ agent: { session: { id, requestHeader: () => ({ config: { provider: 'test', model: 'vision' } }) } } })

  await assert.rejects(test.selectGroup('other'), /control ended/u)
  await test.selectGroup()
  test.turn('turn/start', 'a')
  test.turn('turn/start', 'b')
  await observe('a')
  await observe('b')
  assert.equal(test.approvals.length, 2)
  assert.equal(test.calls[0].operator, undefined)
  assert.deepEqual(test.calls.slice(1).map(request => request.owner.session), ['a', 'b'])
  room.members = ['two']
  test.rt.checkComputerOwners()
  await assert.rejects(observe('a'), /control ended/u)
  await observe('b')
  assert.equal(test.approvals.length, 2)
  await test.rt.computerChannel('stop', { subject: 'room' })
  await assert.rejects(observe('b'), /control ended/u)
  assert.deepEqual(test.calls.map(call => call.op), ['select', 'action', 'action', 'release', 'action', 'release', 'stop'])
})


test('approved group turns wait for the same desktop and resume in FIFO order', { timeout: 8000 }, async t => {
  const { createComputerService } = await import('../../app/src/computer/service.mjs')
  const image = { mediaType: 'image/png', data: 'ZnJhbWU=', width: 1, height: 1 }
  const frames = []
  const service = createComputerService({ 'private-desktop': {
    open: async () => ({ run: async () => { frames.push(image); return image }, close: async () => {} }),
  } }, async () => true)
  t.after(() => service.close())
  const token = await service.choose('room-room', 'private-desktop')
  const queued = new Map(['b', 'c', 'd'].map(id => [id, Promise.withResolvers()]))
  const test = fixture(async request => {
    const result = await service.request(request)
    if (result?.waiting) queued.get(request.owner.session)?.resolve(result.position)
    return result
  })
  const room = { id: 'room', members: ['one', 'two', 'three', 'four'], sessions: { one: 'a', two: 'b', three: 'c', four: 'd' } }
  test.rt.roomOf = id => id === room.id ? room : undefined
  test.rt.botOf = id => room.members.includes(id) ? { id } : undefined
  for (const [botId, id] of Object.entries(room.sessions)) test.rt.groupOwners.set(id, { roomId: room.id, botId })
  await test.rt.computerChannel('select', { subject: room.id, token })
  const observe = id => test.observe({ agent: { session: { id, requestHeader: () => ({ config: { provider: 'test', model: 'vision' } }) } } })

  test.turn('turn/start', 'a')
  await observe('a')
  for (const [id, position] of [['b', 1], ['c', 2], ['d', 3]]) {
    test.turn('turn/start', id)
    const action = observe(id)
    if (id === 'b') queued.get(id).result = assert.rejects(action, { name: 'AbortError' })
    else queued.get(id).result = action
    assert.equal(await queued.get(id).promise, position)
  }
  assert.equal(test.approvals.length, 4)
  assert.equal(frames.length, 1)
  test.turn('turn/end', 'b')
  await queued.get('b').result
  test.turn('turn/end', 'a')
  assert.ok((await queued.get('c').result).attachment)
  assert.equal(frames.length, 2)
  assert.equal((await service.local('room-room', 'status')).waiting, 1)
  test.turn('turn/end', 'c')
  assert.ok((await queued.get('d').result).attachment)
  assert.equal(frames.length, 3)
  assert.equal(test.approvals.length, 4)
  test.turn('turn/end', 'd')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { createComputerService } from '../src/computer/service.mjs'
import { computerViewer } from '../src/computer/viewer.mjs'

const image = { width: 1280, height: 900, mediaType: 'image/png', data: 'frame' }
const observe = { kind: 'observe' }
const controllable = () => Promise.withResolvers()

async function select(service, conversation = 'bot-one', operator = conversation.startsWith('room-') ? undefined : 'operator') {
  const token = await service.choose(conversation, 'private-desktop', operator)
  await service.request({ op: 'select', conversation, token, operator })
  return {
    conversation, token,
    action: (turn, action = observe, session = conversation) => service.request({ op: 'action', conversation, token, owner: { session, turn }, action }),
    end: (turn, session = conversation) => service.request({ op: 'release', conversation, token, owner: { session, turn } }),
  }
}

function fixture(t, { confirm = async () => true, run = async () => image, close = async () => {} } = {}) {
  const service = createComputerService({ 'private-desktop': { open: async (_window, signal) => ({ run: input => run(input, signal), close }) } }, confirm)
  t.after(() => service.close())
  return service
}

test('stop during desktop confirmation invalidates the pending selection', async t => {
  const confirmation = controllable()
  const service = fixture(t, { confirm: () => confirmation.promise })
  const choice = service.choose('bot-one', 'private-desktop', 'operator')
  await service.request({ op: 'stop', conversation: 'bot-one' })
  confirmation.resolve(true)
  await assert.rejects(choice, /control ended/u)
  assert.equal((await service.local('bot-one', 'status')).target, undefined)
})

test('a native selection cannot be redeemed for a different Bot', async t => {
  const service = fixture(t)
  const conversation = 'bot-one'
  const token = await service.choose(conversation, 'private-desktop', 'member-one')
  const request = { op: 'select', conversation, token }
  await assert.rejects(service.request({ ...request, operator: 'member-two' }), /control ended/u)
  assert.equal((await service.request({ ...request, operator: 'member-one' })).operator, 'member-one')
})

test('shared members wait in turn order across conversations and cancellation advances the queue', async t => {
  const service = fixture(t)
  const bot = await select(service)
  const room = await select(service, 'room-one')
  const another = await select(service, 'room-two')
  assert.equal(await bot.action('first'), image)
  assert.deepEqual(await room.action('second', observe, 'member-one'), { waiting: true, position: 1 })
  assert.deepEqual(await room.action('third', observe, 'member-two'), { waiting: true, position: 2 })
  assert.deepEqual(await another.action('fourth'), { waiting: true, position: 3 })
  assert.equal((await service.local(room.conversation, 'status')).waiting, 3)
  await bot.end('first')
  await assert.rejects(bot.action('first'), /control ended/u)
  const queued = await service.inline(room.conversation, 'status')
  assert.equal(queued.status, 'idle')
  assert.equal(queued.waiting, 3)
  const refresh = await service.inline(room.conversation, 'observe', undefined, queued.display)
  assert.equal(refresh.preview, undefined)
  assert.equal(refresh.waiting, 3)
  await room.end('second', 'member-one')
  await assert.rejects(room.action('second', observe, 'member-one'), /control ended/u)
  assert.deepEqual(await another.action('fourth'), { waiting: true, position: 2 })
  assert.equal(await room.action('third', observe, 'member-two'), image)
  await service.request({ op: 'stop', conversation: room.conversation })
  assert.equal(await another.action('fourth'), image)
})

test('private desktop scope follows the Bot across conversations and policy changes revoke granted and pending access', async t => {
  let privateMode = 'per-bot'
  let confirmation
  const closed = []
  const stopping = controllable()
  const service = createComputerService({ 'private-desktop': {
    open: async (_window, _signal, scope) => ({ run: async () => scope, close: async () => { closed.push(scope) } }),
    stopManaged: () => stopping.promise,
  } }, () => confirmation?.promise ?? true, { privateMode: () => privateMode })
  t.after(() => service.close())
  await assert.rejects(select(service, 'room-team'), /control ended/u)
  const one = await select(service, 'one', 'alpha')
  const two = await select(service, 'two', 'beta')
  const room = await select(service, 'room', 'alpha')
  assert.equal(await one.action('a'), 'alpha')
  assert.equal(await two.action('b'), 'beta')
  assert.deepEqual(await room.action('c'), { waiting: true, position: 1 })
  await one.end('a')
  assert.equal(await room.action('c'), 'alpha')

  confirmation = controllable()
  const choice = service.choose('pending', 'private-desktop', 'gamma')
  const changed = service.changePrivatePolicy(() => { privateMode = 'shared' })
  confirmation.resolve(true)
  await assert.rejects(choice, /control ended/u)
  await assert.rejects(two.action('e'), /control ended/u)
  await assert.rejects(room.action('f'), /control ended/u)
  stopping.resolve()
  await changed
  assert.deepEqual(closed.sort(), ['alpha', 'alpha', 'beta'])
  const shared = await select(service, 'one', 'alpha')
  assert.equal(await shared.action('g'), undefined)
})

test('stopping one private desktop revokes only its grants and drains it before stopping', async t => {
  const stopping = controllable()
  const closed = []
  const service = createComputerService({ 'private-desktop': {
    open: async (_window, _signal, scope) => ({ run: async () => scope, close: async () => { closed.push(scope) } }),
    stopInstance: async scope => {
      assert.equal(scope, 'alpha')
      assert.deepEqual(closed, ['alpha'])
      await stopping.promise
    },
  } }, async () => true, { privateMode: () => 'per-bot', privateScope: operator => operator })
  t.after(() => service.close())
  const one = await select(service, 'one', 'alpha')
  const room = await select(service, 'room', 'alpha')
  const two = await select(service, 'two', 'beta')
  assert.equal(await one.action('a'), 'alpha')
  assert.equal(await two.action('b'), 'beta')
  const stop = service.stopPrivateInstance('alpha')
  await assert.rejects(one.action('a'), /control ended/u)
  await assert.rejects(room.action('c'), /control ended/u)
  await assert.rejects(select(service, 'new', 'alpha'), /control ended/u)
  assert.equal(await two.action('b'), 'beta')
  await two.end('b')
  const sharedRoom = await select(service, 'shared-room', 'beta')
  assert.equal(await sharedRoom.action('d'), 'beta')
  stopping.resolve()
  await stop
  const reopened = await select(service, 'one', 'alpha')
  assert.equal(await reopened.action('e'), 'alpha')
})

test('takeover waits for driver shutdown, and hand-back invalidates a pending takeover', async t => {
  const closeStarted = controllable()
  const closed = controllable()
  const service = fixture(t, { close: () => { closeStarted.resolve(); return closed.promise } })
  const bot = await select(service)
  await bot.action('first')
  const take = service.local(bot.conversation, 'take')
  const rejected = assert.rejects(take, /control ended/u)
  await closeStarted.promise
  assert.equal((await service.local(bot.conversation, 'status')).status, 'stopping')
  await assert.rejects(service.local(bot.conversation, 'input', { kind: 'type', text: 'old' }), /control ended/u)
  const handBack = service.local(bot.conversation, 'hand-back')
  closed.resolve()
  await handBack
  await rejected
  assert.equal((await service.local(bot.conversation, 'status')).status, 'idle')
  await assert.rejects(bot.action('first'), /control ended/u)
})

test('local takeover reserves the desktop for physical input and releases the first approved waiter', async t => {
  const service = createComputerService({
    'local-desktop': { open: async () => ({ run: async () => image, close: async () => {} }) },
  }, async () => true)
  t.after(() => service.close())
  const conversation = 'bot-one'
  const operator = 'operator'
  const token = await service.choose(conversation, 'local-desktop', operator)
  await service.request({ op: 'select', conversation, token, operator })
  const { display } = await service.inline(conversation, 'status')
  const action = turn => service.request({ op: 'action', conversation, token, owner: { session: conversation, turn }, action: observe })
  assert.equal(await action('interrupted'), image)
  assert.equal((await service.inline(conversation, 'take', undefined, display)).status, 'user')
  await assert.rejects(action('interrupted'), /control ended/u)
  assert.deepEqual(await action('next'), { waiting: true, position: 1 })
  await assert.rejects(service.inline(conversation, 'input', { kind: 'key', key: 'tab' }, display), /control ended/u)
  assert.equal((await service.inline(conversation, 'observe', undefined, display)).preview, image)
  assert.equal((await service.inline(conversation, 'hand-back', undefined, display)).status, 'idle')
  assert.equal(await action('next'), image)
})

test('only one private desktop can be taken over, including while its input driver is releasing', async t => {
  const closing = controllable()
  const service = createComputerService({ 'private-desktop': {
    open: async (_window, _signal, scope) => ({
      run: async () => image,
      close: () => scope === 'alpha' ? closing.promise : Promise.resolve(),
    }),
  } }, async () => true, { privateMode: () => 'per-bot' })
  t.after(() => { closing.resolve(); return service.close() })
  const alpha = await select(service, 'one', 'alpha')
  const beta = await select(service, 'two', 'beta')
  const busy = /Hand back the other desktop/u
  await alpha.action('first')
  const taking = service.local(alpha.conversation, 'take')
  await assert.rejects(service.local(beta.conversation, 'take'), busy)
  closing.resolve()
  assert.equal((await taking).status, 'user')
  assert.equal(await beta.action('second'), image)
  await assert.rejects(service.local(beta.conversation, 'take'), busy)
  const returning = service.local(alpha.conversation, 'hand-back')
  await assert.rejects(service.local(beta.conversation, 'take'), busy)
  await returning
  assert.equal((await service.local(beta.conversation, 'take')).status, 'user')
  await assert.rejects(beta.action('second'), /control ended/u)
})

test('the Bot waits for an inline preview to release the driver after hand-back', async t => {
  const closeStarted = controllable()
  const closed = controllable()
  let captures = 0
  const service = fixture(t, {
    run: async () => { captures++; return image },
    close: () => { closeStarted.resolve(); return closed.promise },
  })
  const bot = await select(service)
  const { display } = await service.inline(bot.conversation, 'status')
  await service.inline(bot.conversation, 'take', undefined, display)
  await service.inline(bot.conversation, 'observe', undefined, display)
  const handBack = service.inline(bot.conversation, 'hand-back', undefined, display)
  await closeStarted.promise
  assert.deepEqual(await bot.action('cancelled'), { waiting: true, position: 1 })
  assert.deepEqual(await bot.action('next'), { waiting: true, position: 2 })
  await bot.end('cancelled')
  assert.equal(captures, 1)
  closed.resolve()
  await handBack
  await assert.rejects(bot.action('cancelled'), /control ended/u)
  assert.equal(await bot.action('next'), image)
  assert.equal(captures, 2)
})

test('overlapping requests share the in-flight frame for the same operator', async t => {
  const started = controllable()
  const captured = controllable()
  let requests = 0
  const service = fixture(t, { run: () => {
    requests += 1
    started.resolve()
    return captured.promise
  } })
  const bot = await select(service)
  const { display } = await service.inline(bot.conversation, 'status')
  await service.inline(bot.conversation, 'take', undefined, display)
  const first = service.inline(bot.conversation, 'observe', undefined, display)
  await started.promise
  const second = service.inline(bot.conversation, 'observe', undefined, display)
  captured.resolve(image)
  const frames = await Promise.all([first, second])
  assert.equal(requests, 1)
  assert.ok(frames.every(frame => frame.preview === image && frame.status === 'user'))
})

test('inline preview interruptions do not report a driver failure', async t => {
  let started = controllable()
  const service = fixture(t, { run: (_input, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    started.resolve()
  }) })
  const bot = await select(service)
  const { display } = await service.inline(bot.conversation, 'status')
  await service.inline(bot.conversation, 'take', undefined, display)
  const refresh = service.inline(bot.conversation, 'observe', undefined, display)
  await started.promise
  await service.inline(bot.conversation, 'hand-back', undefined, display)
  assert.equal((await refresh).preview, undefined)

  started = controllable()
  const firstFrame = service.inline(bot.conversation, 'observe', undefined, display)
  await started.promise
  await service.request({ op: 'stop', conversation: bot.conversation })
  assert.equal(await firstFrame, null)
  assert.equal(await service.inline(bot.conversation, 'observe', undefined, display), null)
  await select(service, bot.conversation)
  assert.equal(await service.inline(bot.conversation, 'hand-back', undefined, display), null)
  await assert.rejects(service.inline(bot.conversation, 'take', undefined, display), /control ended/u)
  await assert.rejects(service.inline(bot.conversation, 'input', { kind: 'type', text: 'stale' }, display), /control ended/u)
})

test('an inline preview reports failures when its lease was not released', async t => {
  const service = fixture(t, { run: async () => { throw new Error('Capture failed') } })
  const bot = await select(service)
  const { display } = await service.inline(bot.conversation, 'status')
  await assert.rejects(service.inline(bot.conversation, 'observe', undefined, display), /Capture failed/u)
})

test('stop aborts an active action and discards a late screenshot', async t => {
  const started = controllable()
  const completion = controllable()
  const service = fixture(t, { run: (_input, signal) => { started.resolve(signal); return completion.promise } })
  const bot = await select(service)
  const running = bot.action('first')
  const rejected = assert.rejects(running, /control ended/u)
  const signal = await started.promise
  const stop = service.request({ op: 'stop', conversation: bot.conversation })
  assert.equal(signal.aborted, true)
  completion.resolve(image)
  await rejected
  await stop
  assert.equal((await service.local(bot.conversation, 'status')).preview, undefined)
  await assert.rejects(bot.action('first'), /control ended/u)
})

test('a read-only preview expires and cannot be restored by an in-flight hand-back', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1 })
  const service = fixture(t)
  const bot = await select(service)
  assert.equal((await service.local(bot.conversation, 'observe')).preview, image)
  t.mock.timers.tick(30_001)
  assert.equal((await service.local(bot.conversation, 'status')).preview, undefined)
  const started = controllable()
  const closed = controllable()
  const other = fixture(t, { close: () => { started.resolve(); return closed.promise } })
  const group = await select(other, 'room-two')
  const refresh = other.local(group.conversation, 'observe')
  await started.promise
  const handBack = other.local(group.conversation, 'hand-back')
  closed.resolve()
  await handBack
  assert.equal((await refresh).preview, undefined)
})

class TestWindow extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler() {} })
  isDestroyed() { return this.destroyed }
  isVisible() { return true }
  async loadURL(url) { this.webContents.mainFrame.url = url }
  show() {}
  destroy() { this.destroyed = true; this.emit('closed') }
  constructor() { super(); TestWindow.last = this }
}

test('viewer IPC is tied to its exact page and selection, and closing it revokes input', async t => {
  const service = fixture(t)
  const bot = await select(service)
  let request
  const viewer = computerViewer({ ipcMain: { handle: (_channel, handler) => { request = handler } }, BrowserWindow: TestWindow, computer: service })
  await viewer.open(bot.conversation, new TestWindow())
  const win = TestWindow.last
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  const url = event.senderFrame.url
  event.senderFrame.url = url.replace('file:', 'https:')
  assert.throws(() => request(event, 'take'), /no longer available/u)
  event.senderFrame.url = url
  assert.equal((await request(event, 'take')).status, 'user')
  assert.equal((await request(event, 'observe')).preview, image)
  viewer.close(bot.conversation)
  assert.throws(() => request(event, 'input', { kind: 'click', x: 1, y: 1 }), /no longer available/u)
  assert.equal((await service.local(bot.conversation, 'status')).preview, undefined)
  await viewer.open(bot.conversation, new TestWindow())
  const old = TestWindow.last.webContents
  await select(service)
  await assert.rejects(request({ sender: old, senderFrame: old.mainFrame }, 'status'), /control ended/u)
  viewer.close()
})

test('the viewer ignores a capture interrupted by hand-back or close', async t => {
  let started = controllable()
  const service = fixture(t, { run: (_input, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    started.resolve()
  }) })
  const bot = await select(service)
  let request
  const viewer = computerViewer({ ipcMain: { handle: (_channel, handler) => { request = handler } }, BrowserWindow: TestWindow, computer: service })
  await viewer.open(bot.conversation, new TestWindow())
  const sender = TestWindow.last.webContents
  const event = { sender, senderFrame: sender.mainFrame }
  await request(event, 'take')
  const refresh = request(event, 'observe')
  await started.promise
  assert.equal((await request(event, 'hand-back')).status, 'idle')
  assert.deepEqual(await refresh, {})
  started = controllable()
  const firstFrame = request(event, 'observe')
  await started.promise
  viewer.close()
  assert.deepEqual(await firstFrame, {})
})

test('navigation reset rejects a late screenshot and requires a new selection', async t => {
  const started = controllable()
  const completion = controllable()
  const service = fixture(t, { run: (_input, signal) => { started.resolve(signal); return completion.promise } })
  const previous = await select(service)
  const observed = assert.rejects(previous.action('first'), /control ended/u)
  const signal = await started.promise
  const reset = service.reset()
  assert.equal(signal.aborted, true)
  assert.equal((await service.local(previous.conversation, 'status')).target, undefined)
  completion.resolve(image)
  await observed
  await reset
  const next = await select(service, 'room-one')
  await assert.rejects(previous.action('first'), /control ended/u)
  assert.equal(await next.action('second', observe, 'room-member'), image)
})

test('navigation revokes the human lease even when a viewer has already taken control', async t => {
  const service = fixture(t)
  const previous = await select(service)
  const binding = service.viewerBinding(previous.conversation)
  await service.local(previous.conversation, 'take', undefined, binding)
  await service.local(previous.conversation, 'observe', undefined, binding)
  await service.reset()
  await assert.rejects(service.local(previous.conversation, 'input', { kind: 'click', x: 1, y: 1 }, binding), /control ended/u)
  const next = await select(service, previous.conversation)
  await assert.rejects(service.local(next.conversation, 'status', undefined, binding), /control ended/u)
  assert.equal(await next.action('another-turn'), image)
})

test('startup check uses the selected isolation mode and does not inspect a busy Bot desktop', async t => {
  let mode = 'shared'
  const seen = []
  const service = createComputerService({ 'private-desktop': {
    open: async () => ({ run: async () => image, close: async () => {} }),
    checkStartup: async operator => { seen.push(operator); return image },
  } }, async () => true, { privateMode: () => mode })
  t.after(() => service.close())

  assert.equal(await service.checkStartup(), image)
  await assert.rejects(service.checkStartup('alpha'), /control ended/u)
  mode = 'per-bot'
  await assert.rejects(service.checkStartup(), /control ended/u)
  const alpha = await select(service, 'one', 'alpha')
  await alpha.action('turn')
  await assert.rejects(service.checkStartup('alpha'), /Stop computer control/u)
  assert.equal(await service.checkStartup('beta'), image)
  assert.deepEqual(seen, [undefined, 'beta'])
})

test('starting preserves authorization and restart or deletion drains only its selected desktop', async t => {
  const events = []
  const service = createComputerService({ 'private-desktop': {
    open: async (_window, _signal, scope) => ({ run: async () => scope, close: async () => { events.push(['close', scope]) } }),
    stopInstance: async scope => { events.push(['stop', scope]) },
    deleteInstance: async (scope, id) => { events.push(['delete', scope, id]) },
    startInstance: async scope => { events.push(['start', scope]) },
  } }, async () => true, { privateMode: () => 'per-bot', privateScope: operator => operator })
  t.after(() => service.close())
  const one = await select(service, 'one', 'alpha')
  const two = await select(service, 'two', 'beta')
  assert.equal(await two.action('b'), 'beta')
  await assert.rejects(service.startPrivateInstance(undefined, false), /control ended/u)
  await service.startPrivateInstance('alpha', false)
  assert.equal(await one.action('a'), 'alpha')
  await assert.rejects(service.startPrivateInstance('alpha', false), /Stop computer control/u)
  await service.startPrivateInstance('alpha', true)
  assert.deepEqual(events, [['start', 'alpha'], ['close', 'alpha'], ['stop', 'alpha'], ['start', 'alpha']])
  await assert.rejects(one.action('a'), /control ended/u)
  const replacement = await select(service, 'one', 'alpha')
  assert.equal(await replacement.action('new'), 'alpha')
  await service.deletePrivateInstance('alpha', 'container-id')
  assert.deepEqual(events.slice(-2), [['close', 'alpha'], ['delete', 'alpha', 'container-id']])
  await assert.rejects(replacement.action('new'), /control ended/u)
  assert.equal(await two.action('b'), 'beta')
})

test('private desktop pool binds each grant to its seat and preserves that affinity on reauthorization', async t => {
  let size = 2
  let stopped = 0
  const service = createComputerService({ 'private-desktop': {
    open: async (_window, _signal, scope) => ({ run: async () => scope, close: async () => {} }),
    stopManaged: async () => { stopped++ },
  } }, async () => true, { privateMode: () => 'pool', maxInstances: () => size })
  t.after(() => service.close())
  await assert.rejects(select(service, 'room-team'), /control ended/u)
  const a = await select(service)
  const b = await select(service, 'bot-two')
  assert.equal(await a.action('first'), 'pool-seat-1')
  assert.equal(await b.action('second'), 'pool-seat-2')
  const c = await select(service, 'bot-three')
  assert.deepEqual(await c.action('third'), { waiting: true, position: 1 })
  await a.end('first')
  assert.equal(await c.action('third'), 'pool-seat-1')
  await c.end('third')
  const again = await select(service)
  assert.equal(await again.action('again'), 'pool-seat-1')
  await service.changePrivatePolicy(() => { size = 1 })
  assert.equal(stopped, 1)
  await assert.rejects(again.action('again'), /control ended/u)
  const restarted = await select(service, 'bot-two')
  assert.equal(await restarted.action('new-turn'), 'pool-seat-1')
})

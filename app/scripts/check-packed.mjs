// Check a packaged app: process an image with its sharp, then start it on throwaway folders with the ds-bot mock model, choose a model,
// send a message, wait for the reply, then close the window the way a user does: the window hides
// and the app goes on. The window comes back when the app is started again, and the app ends the
// way the tray's Quit ends it. Fails on a page error or a non-zero exit.
// Usage: node scripts/check-packed.mjs [app executable] [screenshot.png]
// The executable defaults to the one that `npm run pack` or `npm run dist` writes into dist-pack/.
import { spawn, spawnSync } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { hostExecutable } from '../src/host-process.mjs'
import { windowsBackend } from '../src/computer/driver.mjs'
import { checkComputer, startComputerWindow } from './check-packed-computer.mjs'
import { stringify } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [given, shotFile] = process.argv.slice(2)
const executable = given || packedExecutable()
const computerMode = process.env.DS_BOT_PACKED_COMPUTER
const computerCheck = ['1', 'windows', 'linux', 'browser', 'files', 'live'].includes(computerMode)
const liveCheck = computerMode === 'live'
const linuxCheck = ['linux', '1', 'live'].includes(computerMode)

function packedExecutable() {
  const out = join(root, 'dist-pack')
  if (process.platform === 'win32') return join(out, 'win-unpacked', 'DS Bot App.exe')
  // executableName in electron-builder.yml.
  if (process.platform === 'linux') return join(out, 'linux-unpacked', 'ds-bot-app')
  const dir = ['mac-arm64', 'mac'].find(name => existsSync(join(out, name))) ?? 'mac'
  return join(out, dir, 'DS Bot App.app', 'Contents', 'MacOS', 'DS Bot App')
}

if (!existsSync(executable)) {
  console.error(`check-packed: no app at ${executable}. Run npm run pack first.`)
  process.exit(2)
}

// The Office payload sits next to the asar as extraResources, and the LibreOffice Kit CLI is a
// plain file in the unpacked tree; without them the app's Office skills and tools cannot run.
{
  const resources = process.platform === 'darwin' ? join(dirname(executable), '..', 'Resources') : join(dirname(executable), 'resources')
  const windows = process.platform === 'win32'
  const unpacked = process.platform === 'linux' ? 'app' : 'app.asar.unpacked'
  const required = [
    'primary-runtime/runtime.json',
    join('primary-runtime', 'dependencies', 'python', ...(windows ? ['python.exe'] : ['bin', 'python3'])),
    join('primary-runtime', 'dependencies', 'node', 'bin', windows ? 'node.exe' : 'node'),
    join('office-skills', 'office', 'SKILL.md'),
    join(unpacked, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js'),
    join(unpacked, 'node_modules', 'ds-bot', 'office.js'),
    ...(windows && process.arch === 'x64' ? [
      'computer/cua-driver.exe', 'computer/cua-driver-uia.exe', 'computer/CUA-LICENSE.txt', 'computer/seccomp.json',
      'computer/image/Dockerfile', 'computer/image/start-desktop.sh',
      'computer/image/cua_driver-0.37.0-py3-none-manylinux_2_31_x86_64.whl',
    ] : []),
  ]
  const missing = required.filter((entry) => !existsSync(join(resources, entry)))
  if (missing.length > 0) {
    console.error(`check-packed: FAILED: missing from ${resources}:\n  ${missing.join('\n  ')}`)
    process.exit(1)
  }
}

const work = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'ds-bot-packed-')))
mkdirSync(join(work, 'home'))
mkdirSync(join(work, 'shell'))
// CDP cannot answer the native first-close dialog. The notice has its own tests; this check
// exercises hiding and reopening a window after the user has acknowledged it.
writeFileSync(join(work, 'shell', 'tray-close-acknowledged'), '')
const children = []

function stopChildren() {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    // On Windows a plain kill ends only the main process; /T takes the Host and Electron's helpers along.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill()
  }
}

// An app that hangs, for example behind its error box, must not hold up CI.
const timeoutMinutes = linuxCheck ? 24 : 8
setTimeout(() => {
  console.error(`check-packed: FAILED: gave up after ${timeoutMinutes} minutes`)
  stopChildren()
  process.exit(1)
}, timeoutMinutes * 60_000).unref()

// Run from inside this checkout, the app would find a module that the build left out in the
// checkout's own node_modules, so the check runs a copy of the app from the throwaway folder.
function outsideCheckout(file) {
  const fromCheckout = relative(resolve(root, '..'), file)
  if (fromCheckout.startsWith('..') || isAbsolute(fromCheckout)) return file
  const appDir = process.platform === 'darwin' ? resolve(file, '..', '..', '..') : dirname(file)
  const copy = join(work, basename(appDir))
  cpSync(appDir, copy, { recursive: true, verbatimSymlinks: true })
  console.log(`check-packed: runs a copy of ${appDir} in ${work}`)
  return join(copy, relative(appDir, file))
}

function checkSharp(app) {
  const resources = process.platform === 'darwin' ? resolve(app, '..', '..', 'Resources') : join(dirname(app), 'resources')
  const linux = process.platform === 'linux'
  const script = `
    const assert = require('node:assert/strict')
    const { createRequire } = require('node:module')
    ${linux ? "assert.equal(process.versions.electron, undefined, 'Linux image processing must not run in Electron')" : ''}
    const appRequire = createRequire(${JSON.stringify(join(resources, linux ? 'app' : 'app.asar', 'package.json'))})
    const sharp = appRequire('sharp')
    ;(async () => {
      const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer()
      const { data, info } = await sharp(image).resize(2, 2).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      assert.equal(info.width, 2)
      assert.equal(info.height, 2)
      assert.deepEqual([...data], Array.from({ length: 4 }, () => [255, 0, 0]).flat())
      console.log('check-packed: sharp image processing passed (libvips ' + sharp.versions.vips + ')')
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `
  // Use the Host's runtime and dependencies outside the checkout, not the CI runner's Node.
  const result = spawnSync(linux ? hostExecutable(resources) : app, ['-e', script], {
    cwd: work, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' },
    encoding: 'utf8', timeout: 30_000,
  })
  if (result.error || result.status !== 0) throw new Error(`packaged sharp failed (exit ${String(result.status)}, signal ${String(result.signal)}): ${result.error?.message ?? ''}\n${result.stderr ?? ''}`)
  console.log(result.stdout.trim())
}

function startMock() {
  const mock = spawn(process.execPath, [join(root, '..', 'ds-bot', 'dev', 'mock-llm.mjs')], {
    env: { ...process.env, MOCK_PORT: '0', MOCK_LOG: join(work, 'mock.log') }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  children.push(mock)
  return new Promise((done, reject) => {
    let text = ''
    mock.stdout.setEncoding('utf8')
    mock.stdout.on('data', (chunk) => {
      text += chunk
      const url = /http:\/\/127\.0\.0\.1:\d+\/v1/u.exec(text)?.[0]
      if (url) done(url)
    })
    mock.once('exit', (code) => { reject(new Error(`check-packed: the mock model stopped (exit ${String(code)})`)) })
  })
}

// Let the OS avoid occupied and reserved ports instead of guessing a fixed range.
async function freePort() {
  const server = createServer()
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const { port } = server.address()
  await new Promise((done, reject) => { server.close(error => error ? reject(error) : done()) })
  return port
}

async function appPage(port, deadline, main = false) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
      // The first launch also opens a hidden loopback document to migrate drafts.
      const page = targets.find(target => main ? target.type === 'node' : target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/$/u.test(target.url))
      if (page) return page
    } catch {
      // The debugging port is not listening yet.
    }
    await sleep(500)
  }
  throw new Error('the app window did not appear')
}

// The Host goes on while the window is hidden: its port answers.
async function hostAlive() {
  const { port } = JSON.parse(readFileSync(join(work, 'shell', 'host-port.json'), 'utf8'))
  await new Promise((done, reject) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); done() })
    socket.once('error', reject)
  })
}

// The tray's Quit ends the app. The check cannot click the tray icon, so it asks the browser
// target of the debugging port to close, which ends the app gracefully.
async function browserClose(port) {
  const version = await (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).json()
  const socket = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  socket.close()
}

function devtools(url, problems) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let next = 1
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.method === 'Runtime.exceptionThrown') problems.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(`console.error: ${message.params.args.map(arg => arg.value ?? arg.description).join(' ')}`)
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') problems.push(`log: ${message.params.entry.text} ${message.params.entry.url ?? ''}`)
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  const opened = new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', () => reject(new Error('Could not connect to DevTools')), { once: true })
  })
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) entry.reject(new Error('The DevTools target closed'))
    pending.clear()
  })
  const call = (method, params = {}) => new Promise((done, reject) => {
    const id = next++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`the window did not answer ${method}`))
    }, 30_000)
    const settle = action => (value) => { clearTimeout(timer); action(value) }
    pending.set(id, { resolve: settle(done), reject: settle(reject) })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { opened, call, close: () => { socket.close() } }
}

// mica.css styles DSH's own page, which can change with a DSH upgrade; every rule must still
// find an element, on every platform, so the change shows here and not as a broken window.
function micaRules() {
  const css = readFileSync(join(root, 'src', 'mica.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
  return [...css.matchAll(/([^{}]+)\{/gu)].map(([, selectors]) => selectors.split(',')
    .map(selector => selector.trim().replace(/::(?:before|after)$/u, ''))
    .filter(selector => selector !== '' && selector !== 'body'))
    .filter(rule => rule.length > 0)
}

async function chat(cdp, computer) {
  const evaluate = async expression => {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  const until = async (expression, label, ms = 120_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await evaluate(`Boolean(${expression})`)) return
      await sleep(250)
    }
    throw new Error(`timed out waiting for ${label}`)
  }
  // DSH shows a preview notice once per profile; it would keep the focus away from the composer.
  const dismissNotice = () => evaluate("[...document.querySelectorAll('[role=dialog] button')].find(node => /^(Continue|继续)$/u.test(node.textContent.trim()))?.click()")
  const text = needle => `document.body.innerText.includes(${JSON.stringify(needle)})`
  await cdp.call('Runtime.enable')
  await cdp.call('Log.enable')
  await until("document.querySelector('.bt-tile, .bt-row')", 'the team')
  const stale = await evaluate(`${JSON.stringify(micaRules())}.filter(rule => !rule.some(selector => document.querySelector(selector) !== null)).map(rule => rule.join(', '))`)
  if (stale.length > 0) throw new Error(`src/mica.css no longer matches DSH's page: ${stale.join(' | ')}`)
  await dismissNotice()
  const main = await evaluate("fetch('api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'state', payload: {} }) }).then(r => r.json()).then(r => r.value.mainBotId)")
  await evaluate(`document.querySelector(${JSON.stringify(`[data-bot-id="${main}"]`)}).click()`)
  await until("document.querySelector('.bt-model-chip:not(.bt-model-chip-quiet)')", 'the model choice')
  await evaluate("document.querySelector('.bt-model-chip:not(.bt-model-chip-quiet)').click()")
  // The mock model's greeting for a new team.
  await until(text('先让团队帮你做哪块'), 'the greeting')
  await dismissNotice()
  // The private desktop suite checks its own model round after authorizing the desktop.
  if (computer?.mode === 'linux') return checkComputer({ ...computer, cdp, evaluate, until, devtools })
  // Click the composer through the input pipeline. A bare focus() is not enough where no window
  // manager gives the window focus (xvfb in CI): the text and the Enter would go nowhere.
  const box = "[...document.querySelectorAll('[role=textbox][contenteditable=true], textarea')].at(-1)"
  const focusCheck = "(document.activeElement?.isContentEditable ?? false) || document.activeElement?.tagName === 'TEXTAREA'"
  // A greeting that just arrived leaves the composer rebinding: for a moment the field is
  // not editable, so a click lands on it but does not focus it. The probe and the click are
  // separate round trips, so keep probing and click only where the field itself is on top
  // until the field holds focus.
  const probe = `(() => {
    const el = ${box}
    if (el === undefined) return null
    const rect = el.getBoundingClientRect()
    for (const part of [0.5, 0.25, 0.75, 0.1, 0.9]) {
      const point = { x: rect.x + rect.width * part, y: rect.y + rect.height / 2 }
      const hit = document.elementFromPoint(point.x, point.y)
      if (hit === el || (hit !== null && el.contains(hit))) return { x: point.x, y: point.y }
    }
    return null
  })()`
  let shot = null
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !(await evaluate(`Boolean(${focusCheck})`))) {
    const point = await evaluate(probe)
    if (point !== null && point !== undefined) {
      shot = point
      await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await sleep(300)
    } else await sleep(250)
  }
  if (!(await evaluate(`Boolean(${focusCheck})`))) {
    // Say what was under the cursor, what held the focus and how large the window was.
    const state = await evaluate(`(() => {
      const el = ${box}
      const rect = el === undefined ? null : el.getBoundingClientRect().toJSON()
      const point = rect === null ? null : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      const hit = point === null ? null : document.elementFromPoint(point.x, point.y)
      const cover = hit?.closest?.('[role=dialog],[aria-modal=true],[data-slot]')
      const brief = node => (node === null || node === undefined ? null : { tag: node.tagName ?? null, class: String(node.getAttribute?.('class') ?? '').slice(0, 160) })
      return JSON.stringify({
        inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], screen: [screen.width, screen.height], dpr: devicePixelRatio, focused: document.hasFocus(),
        click: ${JSON.stringify(shot)}, probe: point, box: rect,
        hit: brief(hit),
        cover: cover === null || cover === undefined ? null : { tag: cover.tagName, slot: cover.getAttribute('data-slot'), role: cover.getAttribute('role'), modal: cover.getAttribute('aria-modal') },
        active: brief(document.activeElement),
      })
    })()`)
    throw new Error(`timed out waiting for the focused composer; page state: ${state}`)
  }
  await cdp.call('Input.insertText', { text: 'packaged app check' })
  await until(text('packaged app check'), 'the typed message', 10_000)
  for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  // The mock model starts its reply with 收到： and the message.
  try {
    await until(text('收到：packaged app check'), 'the reply')
  } catch (error) {
    const state = await evaluate("JSON.stringify({ active: document.activeElement?.tagName ?? null, editable: document.activeElement?.isContentEditable ?? null, tail: document.body.innerText.slice(-300) })")
    throw new Error(`${error.message}; page state: ${state}`)
  }
  await sleep(1000)
  console.log(`check-packed: chat ${JSON.stringify(await evaluate('document.body.innerText.slice(-200)'))}`)
  if (computer) return checkComputer({ ...computer, cdp, evaluate, until, devtools })
}

let failed = false
const problems = []
let closeApp
const desktops = new Map()
const grantSubjects = new Set()
try {
  const packedApp = outsideCheckout(resolve(executable))
  checkSharp(packedApp)
  if (process.platform === 'win32' && process.arch === 'x64') {
    const driver = await windowsBackend(join(dirname(packedApp), 'resources', 'computer', 'cua-driver.exe')).open(undefined, AbortSignal.timeout(15_000))
    try {
      const image = await driver.run({ kind: 'observe' })
      console.log(`check-packed: packaged Windows driver captured the primary desktop at ${image.width}x${image.height}`)
    } finally { await driver.close() }
  }
  const modelUrl = await startMock()
  const python = join(dirname(packedApp), 'resources', 'primary-runtime', 'dependencies', 'python', 'python.exe')
  if (liveCheck && (!process.env.DS_BOT_PACKED_VISION_URL || !process.env.DS_BOT_PACKED_VISION_KEY)) {
    throw new Error('Set the vision endpoint and credential in the environment for the live desktop check.')
  }
  const fixture = ['1', 'windows', 'live'].includes(computerMode) ? await startComputerWindow(children, work, python, liveCheck) : undefined
  if (computerCheck) {
    const profile = join(work, 'home', 'profiles', 'ds-bot')
    mkdirSync(profile, { recursive: true })
    const liveRoute = liveCheck ? stringify([{ id: 'llm-pi-ai', config: { providers: { 'qa-vision': {
      api: 'openai-responses', baseURL: process.env.DS_BOT_PACKED_VISION_URL, apiKeyEnv: 'DS_BOT_PACKED_VISION_KEY',
      models: [{ id: 'gpt-6.2-sol', contextWindow: 100_000, maxTokens: 8000, input: ['text', 'image'] }],
    } } } }]) : ''
    writeFileSync(join(profile, 'cordis.patch.yml'), `- id: llm-deepseek
  config:
    models:
      - { id: deepseek-flash, contextWindow: 100000, maxTokens: 8000, inputModalities: [text, image] }
      - { id: deepseek-v4-pro, contextWindow: 100000, maxTokens: 8000 }
${liveRoute}`)
  }
  const port = await freePort()
  const mainPort = await freePort()
  // A terminal inside an Electron-based editor may set ELECTRON_RUN_AS_NODE, which turns the app into plain Node.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  Object.assign(env, {
    DS_BOT_HOME: join(work, 'home'), DS_BOT_SHELL_DATA: join(work, 'shell'), DS_BOT_WORKSPACE: join(work, 'workspace'),
    DEEPSEEK_BASE_URL: modelUrl, DEEPSEEK_API_KEY: 'mock-key',
  })
  const app = spawn(packedApp, [`--remote-debugging-port=${String(port)}`, `--inspect=127.0.0.1:${String(mainPort)}`], { stdio: 'inherit', env })
  children.push(app)
  const exited = new Promise((done) => { app.once('exit', (code, signal) => { done({ code, signal }) }) })
  closeApp = async () => {
    if (app.exitCode !== null || app.signalCode !== null) return exited
    await browserClose(port)
    return Promise.race([exited, sleep(40_000, undefined, { ref: false })])
  }
  const cdp = devtools((await appPage(port, Date.now() + 120_000)).webSocketDebuggerUrl, problems)
  await cdp.opened
  const main = devtools((await appPage(mainPort, Date.now() + 30_000, true)).webSocketDebuggerUrl, problems)
  await main.opened
  const windowState = async expression => {
    const answer = await main.call('Runtime.evaluate', {
      expression: `(() => { const { BrowserWindow, desktopCapturer } = process.getBuiltinModule('module').createRequire(process.execPath)('electron'); const win = BrowserWindow.getAllWindows()[0]; return ${expression} })()`,
      returnByValue: true, awaitPromise: true,
    })
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text)
    return answer.result?.value
  }
  const windowEvents = computerCheck ? await windowState(`(() => {
    const events = [];
    const record = name => () => {
      events.push([name, Date.now(), win.isDestroyed() ? null : win.isVisible()]);
      if (events.length > 30) events.shift();
    };
    for (const name of ['show', 'hide', 'minimize', 'restore', 'close', 'closed']) win.on(name, record(name));
    win.webContents.on('render-process-gone', record('render-process-gone'));
    if (process.platform === 'win32') win.setMinimizable(false);
    globalThis.packedCheckWindowEvents = events;
    return { visible: win.isVisible(), minimized: win.isMinimized() };
  })()`) : undefined
  const chatError = await chat(cdp, computerCheck && { fixture, port, work, python, pid: app.pid, problems, mode: computerMode, windowState,
    onDesktop: value => desktops.set(value.name, value),
    onGrant: subject => grantSubjects.add(subject),
  }).then(() => undefined, error => error)
  if (shotFile) {
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(shotFile), Buffer.from(data, 'base64'))
    console.log(`check-packed: saved ${resolve(shotFile)}`)
  }
  if (chatError && windowEvents) {
    const state = await windowState(`({ initial: ${JSON.stringify(windowEvents)},
      current: win ? { visible: win.isVisible(), minimized: win.isMinimized() } : null,
      events: globalThis.packedCheckWindowEvents })`).catch(error => ({ error: error.message }))
    console.error(`check-packed: native window state ${JSON.stringify(state)}`)
  }
  if (computerCheck && process.platform === 'win32') await windowState('win?.setMinimizable(true)')
  if (chatError) throw problems.length ? new Error(`${chatError.message}\n${problems.join('\n')}`, { cause: chatError }) : chatError
  // Close the native window: a renderer-initiated close can stop page CDP evaluations even
  // when Electron prevents the close. Read visibility from the main process as well.
  await windowState('win.close()')
  await sleep(4000)
  if (app.exitCode !== null) throw new Error('the app ended with its window')
  if (await windowState('win !== undefined && !win.isDestroyed() && !win.isVisible()') !== true) throw new Error('the window is not hidden')
  await hostAlive()
  console.log('check-packed: the window is hidden and the Host goes on')
  // Starting the app again brings the window back; the second copy ends at once, because the
  // first one holds the lock.
  const second = spawn(packedApp, [`--remote-debugging-port=${String(await freePort())}`], { stdio: 'ignore', env })
  children.push(second)
  const secondExit = await Promise.race([new Promise((done) => { second.once('exit', (code) => { done(code) }) }), sleep(30_000).then(() => undefined)])
  if (secondExit === undefined) throw new Error('the second copy of the app did not end')
  if (app.exitCode !== null) throw new Error('the app ended when it was started again')
  if (await windowState('win !== undefined && !win.isDestroyed() && win.isVisible()') !== true) throw new Error('the window did not come back')
  console.log('check-packed: the window came back when the app was started again')
  // The tray's Quit is the way out; the check cannot click the tray, so it asks the browser
  // target to close, which ends the app gracefully.
  // Stopping the Host closes its event stream; that expected shutdown is not a page failure.
  if (problems.length > 0) throw new Error(`page problems:\n  ${problems.join('\n  ')}`)
  cdp.close()
  main.close()
  const outcome = await closeApp()
  if (outcome === undefined) throw new Error('the app did not exit after the quit')
  console.log(`check-packed: app exited (code ${String(outcome.code)}, signal ${String(outcome.signal)})`)
  if (outcome.code !== 0) throw new Error(`the app exited with code ${String(outcome.code)}`)
  if (desktops.size) {
    for (const entry of desktops.values()) {
      const running = await entry.runDocker('container', 'inspect', '--format', '{{.State.Running}}', entry.container)
      if (running.stdout.trim() !== 'false') throw new Error('An isolated private desktop did not stop at app exit.')
    }
    console.log('check-packed: exiting the app stopped the isolated desktop')
  }
  if (grantSubjects.size) {
    const restartPort = await freePort()
    const restarted = spawn(packedApp, [`--remote-debugging-port=${String(restartPort)}`], { stdio: 'inherit', env })
    children.push(restarted)
    const restartExit = new Promise(done => { restarted.once('exit', (code, signal) => done({ code, signal })) })
    closeApp = async () => {
      if (restarted.exitCode === null && restarted.signalCode === null) await browserClose(restartPort)
      return Promise.race([restartExit, sleep(40_000, undefined, { ref: false })])
    }
    const restartPage = devtools((await appPage(restartPort, Date.now() + 120_000)).webSocketDebuggerUrl, problems)
    try {
      await restartPage.opened
      await restartPage.call('Runtime.enable')
      for (const subject of grantSubjects) {
        const deadline = Date.now() + 60_000
        let status
        while (Date.now() < deadline) {
          const reply = await restartPage.call('Runtime.evaluate', {
            expression: `fetch('/api/bot', { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify(${JSON.stringify({ endpoint: 'computer-status', payload: { subject } })}) }).then(r => r.json())`,
            awaitPromise: true, returnByValue: true,
          })
          status = reply.result?.value
          if (status?.ok) break
          await sleep(500)
        }
        if (!status?.ok) throw new Error('Could not read computer authorization after restart.')
        if (status.value?.target !== undefined) throw new Error('A previous computer authorization survived restart.')
      }
    } finally { restartPage.close() }
    if ((await closeApp())?.code !== 0) throw new Error('The restarted app did not quit cleanly.')
    console.log('check-packed: restarting the app requires fresh computer authorization')
  }
  console.log('check-packed: passed')
} catch (error) {
  failed = true
  console.error(`check-packed: FAILED: ${error instanceof Error ? error.stack : String(error)}`)
  await closeApp?.().catch(() => {})
}
stopChildren()
await sleep(500)
for (const desktop of desktops.values()) {
  try {
    const label = 'io.github.qingj01.dsbot.cua-instance'
    const { stdout } = await desktop.runDocker('container', 'ls', '--all', '--no-trunc', '--filter', `name=${desktop.name}`, '--format', '{{.Names}}|{{.ID}}')
    const entry = stdout.trim().split('\n').map(line => line.trim().split('|')).find(([name]) => name === desktop.name)
    if (entry) {
      const [, id] = entry
      if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid test desktop ID.')
      const { stdout: state } = await desktop.runDocker('container', 'inspect', '--format', `{{.Id}}|{{index .Config.Labels "${label}"}}|{{.State.Running}}`, id)
      const [current, owner, running] = state.trim().split('|')
      if (current !== id || owner !== desktop.instance) throw new Error('The test desktop ownership changed.')
      if (running === 'true' && failed) await desktop.runDocker('container', 'stop', '--time', '3', id)
      else if (running !== 'false') throw new Error('The test desktop was not stopped.')
      await desktop.runDocker('container', 'rm', id)
    }
    for (const suffix of ['workspace', 'chromium']) {
      const name = `${desktop.name}-${suffix}`
      const result = await desktop.runDocker('volume', 'inspect', '--format', `{{index .Labels "${label}"}}`, name)
      if (result.stdout.trim() !== desktop.instance) throw new Error(`Ownership changed for test volume ${name}.`)
      await desktop.runDocker('volume', 'rm', name)
    }
  } catch (error) {
    failed = true
    console.error(`check-packed: private desktop fixture cleanup incomplete: ${error.message}`)
  }
}
rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
process.exit(failed ? 1 : 0)

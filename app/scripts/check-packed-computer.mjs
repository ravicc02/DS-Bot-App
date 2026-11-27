import { desktopRuntime } from '../src/computer/docker-installation.mjs'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const temporaryWindow = `DS Bot Computer Check ${process.pid}`

export async function startComputerWindow(children, work, python, live = false) {
  assert.equal(process.platform, 'win32')
  assert.equal(process.arch, 'x64')
  const script = join(work, 'test-window.py')
  const marker = live ? `desk-${randomBytes(4).toString('hex')}` : ''
  const activate = join(work, 'local-activate')
  writeFileSync(script, `import ctypes
import tkinter as tk
ctypes.windll.user32.SetProcessDPIAware()
window = tk.Tk()
window.title(${JSON.stringify(temporaryWindow)})
window.geometry(f"420x240+{max(0, window.winfo_screenwidth() - 440)}+80")
window.attributes("-topmost", True)
from pathlib import Path

tk.Label(window, text="Isolated local desktop fixture").pack()
entry = tk.Entry(window)
entry.pack()
entry.focus_set()
def select_all(_):
    entry.selection_range(0, "end")
    return "break"
entry.bind("<Control-a>", select_all)
entry.bind("<Return>", lambda _: Path(${JSON.stringify(join(work, 'local-input.txt'))}).write_text(entry.get(), encoding="utf-8"))
repaint = Path(${JSON.stringify(join(work, 'local-repaint'))})
def check_repaint():
    color = "#ff00ff" if repaint.exists() else "#00ffff"
    if entry.cget("bg") != color:
        entry.config(bg=color)
    window.after(100, check_repaint)
window.after(100, check_repaint)
marker = ${JSON.stringify(marker)}
if marker:
    window.attributes("-topmost", False)
    window.withdraw()
    def activate():
        if not Path(${JSON.stringify(activate)}).exists():
            window.after(100, activate)
            return
        window.deiconify()
        window.attributes("-fullscreen", True)
        window.attributes("-topmost", True)
        window.lift()
        tk.Label(window, text="Copy this code into the input above: " + marker, font=("Consolas", 38)).pack(pady=100)
        entry.config(font=("Consolas", 24), width=30)
        entry.focus_force()
        window.after(500, lambda: Path(${JSON.stringify(join(work, 'local-fixture-ready'))}).touch())
        def deactivate():
            if Path(${JSON.stringify(join(work, 'local-deactivate'))}).exists():
                window.destroy()
            else:
                window.after(100, deactivate)
        window.after(100, deactivate)
    window.after(100, activate)
window.update()
from json import dumps
Path(${JSON.stringify(join(work, 'local-click.json'))}).write_text(dumps({"x": entry.winfo_rootx() + entry.winfo_width() // 2, "y": entry.winfo_rooty() + entry.winfo_height() // 2}), encoding="utf-8")
print("ready", flush=True)
window.mainloop()
`)
  const child = spawn(python, [script], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(child)
  await Promise.race([
    new Promise((resolve, reject) => {
      child.stdout.once('data', output => String(output).includes('ready') ? resolve() : reject(new Error('Windows fixture failed to open.')))
      child.once('exit', () => reject(new Error('Windows fixture exited.')))
      child.once('error', reject)
    }),
    sleep(15_000, undefined, { ref: false }).then(() => { throw new Error('Windows fixture did not open.') }),
  ])
  return { marker, activate }
}

const confirmDialog = String.raw`
import ctypes as c
from ctypes import wintypes as w
import re
import sys
import time

pid, labels = int(sys.argv[1]), sys.argv[2:]
user = c.WinDLL('user32', use_last_error=True)
walk = c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
for name, args, result in [
    ('EnumWindows', [walk, w.LPARAM], w.BOOL),
    ('EnumChildWindows', [w.HWND, walk, w.LPARAM], w.BOOL),
    ('GetWindowThreadProcessId', [w.HWND, c.POINTER(w.DWORD)], w.DWORD),
    ('GetWindowTextW', [w.HWND, w.LPWSTR, c.c_int], c.c_int),
    ('GetClassNameW', [w.HWND, w.LPWSTR, c.c_int], c.c_int),
    ('IsWindowVisible', [w.HWND], w.BOOL),
    ('IsWindowEnabled', [w.HWND], w.BOOL),
    ('SendMessageTimeoutW', [w.HWND, w.UINT, w.WPARAM, w.LPARAM, w.UINT, w.UINT, c.POINTER(c.c_size_t)], w.LPARAM),
]:
    fn = getattr(user, name)
    fn.argtypes, fn.restype = args, result

def windows(parent=None):
    result = []
    @walk
    def append(handle, _):
        result.append(handle)
        return True
    if parent is None:
        user.EnumWindows(append, 0)
    else:
        user.EnumChildWindows(parent, append, 0)
    return result

def read(handle, fn):
    buf = c.create_unicode_buffer(2048)
    fn(handle, buf, len(buf))
    return buf.value

def control_text(handle):
    buf = c.create_unicode_buffer(2048)
    result = c.c_size_t()
    user.SendMessageTimeoutW(handle, 0x000d, len(buf), c.addressof(buf), 2, 1000, c.byref(result))
    return buf.value

def owned(handle):
    owner = w.DWORD()
    user.GetWindowThreadProcessId(handle, c.byref(owner))
    return owner.value == pid

seen = set()
deadline = time.monotonic() + 45
while time.monotonic() < deadline:
    for dialog in windows():
        if not owned(dialog) or not user.IsWindowVisible(dialog):
            continue
        if read(dialog, user.GetClassNameW) != '#32770' or read(dialog, user.GetWindowTextW) != 'DS Bot App':
            continue
        controls = [(node, read(node, user.GetClassNameW), control_text(node))
                    for node in windows(dialog) if owned(node)]
        seen.update(kind + ':' + text for _, kind, text in controls if text)
        buttons = {re.sub(r'[&\s]', '', text) for _, kind, text in controls if kind.lower() == 'button'}
        if len(buttons) != 2 or not buttons.intersection({'Cancel', '取消'}):
            continue
        for node, kind, text in controls:
            if kind.lower() != 'button' or re.sub(r'[&\s]', '', text) not in labels:
                continue
            if not user.IsWindowVisible(node) or not user.IsWindowEnabled(node):
                continue
            result = c.c_size_t()
            if user.SendMessageTimeoutW(node, 0x00f5, 0, 0, 2, 3000, c.byref(result)):
                sys.exit(0)
    time.sleep(0.2)
print('Expected native test dialog could not be confirmed. Text: ' + ' | '.join(sorted(seen)))
sys.exit(1)
`

async function nativeButton(python, pid, names) {
  assert.ok(Number.isSafeInteger(pid))
  try {
    await exec(python, ['-X', 'utf8', '-c', confirmDialog, String(pid), ...names], { windowsHide: true, timeout: 50_000 })
  } catch (error) {
    throw new Error(error.stdout?.trim() || error.stderr?.trim() || 'The Windows helper could not confirm the test dialog.')
  }
}

// A Windows window thumbnail can omit a native child view. Read the composed display instead.
async function windowsDisplayColors(python, points) {
  const script = String.raw`
import ctypes as c
from ctypes import wintypes as w
import json
import sys

user = c.windll.user32
user.SetProcessDPIAware()
user.GetDC.restype = w.HDC
user.ReleaseDC.argtypes = [w.HWND, w.HDC]
get_pixel = c.windll.gdi32.GetPixel
get_pixel.argtypes = [w.HDC, c.c_int, c.c_int]
get_pixel.restype = w.DWORD

dc = user.GetDC(None)
if not dc:
    raise RuntimeError('Could not get the display device context.')
try:
    colors = []
    coords = iter(map(int, sys.argv[1:]))
    for x, y in zip(coords, coords):
        value = get_pixel(dc, x, y)
        colors.append(None if value == 0xffffffff else [(value >> shift) & 255 for shift in (0, 8, 16)])
    print(json.dumps(colors))
finally:
    user.ReleaseDC(None, dc)
`
  const coordinates = points.flatMap(({ x, y }) => [String(x), String(y)])
  try {
    const { stdout } = await exec(python, ['-c', script, ...coordinates], { windowsHide: true, timeout: 5000 })
    return JSON.parse(stdout)
  } catch (error) {
    throw new Error(error.stderr?.trim() || 'Could not sample the Windows display.', { cause: error })
  }
}

const byText = (selector, labels) => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(node => ${JSON.stringify(labels)}.includes(node.textContent.trim()))`
async function press(cdp, key, code, windowsVirtualKeyCode) {
  for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode })
}

export async function checkComputer({ cdp, until, evaluate, work, python, pid, mode, windowState, onDesktop, onGrant, fixture, legacyDockerImage }) {
  const click = async (selector, ...labels) => {
    const find = byText(selector, labels)
    await until(`(() => { const button = ${find}; if (!button || button.disabled) return false; button.click(); return true })()`, labels[0], 25_000)
  }
  const panel = '.bt-panel:not([data-leaving])'
  const livePanel = `${panel} > .bt-panel-view`
  const openWorkTab = async view => {
    await until(`(() => {
      const tab = document.querySelector('${panel} [data-work-tab=${view}]')
      if (tab?.getAttribute('aria-pressed') === 'true') return true
      if (tab) tab.click()
      else if (!document.querySelector('${panel}')) document.querySelector('.bt-header-computer')?.click()
      return false
    })()`, `the ${view} tab for the current conversation`, 25_000)
  }
  const pane = `${livePanel} .bt-computer button`
  const settings = '.bt-computer-settings button'
  const screen = `document.querySelector(${JSON.stringify(`${livePanel} .bt-computer-preview`)})`
  const settingsFrame = `document.querySelector('.bt-computer-settings-preview')?.naturalWidth === 1280`
  const frameReady = `${screen}?.naturalWidth > 0`
  const canvas = `document.querySelector(${JSON.stringify(`${livePanel} .bt-computer-live[data-connected] canvas`)})`
  const activeFrame = `Boolean(${canvas}?.width)`
  const privateLabels = ['Private desktop', '私有桌面']
  const authorizePrivate = async (trigger = () => click(pane, ...privateLabels)) => {
    try { await Promise.all([nativeButton(python, pid, ['Allow', '允许']), trigger()]) } catch (error) {
      const details = await evaluate(`({
        pane: document.querySelector('.bt-computer')?.innerText,
        places: [...document.querySelectorAll('.bt-computer-places button')].map(button => [button.textContent, button.disabled, button.getAttribute('aria-pressed')]),
        selected: [...document.querySelectorAll('[data-bot-id][aria-current=page]')].map(node => node.innerText),
        focused: document.hasFocus(),
        alert: document.querySelector('.bt-computer [role=alert]')?.textContent,
        setup: Boolean(document.querySelector('.bt-computer-setup')),
      })`)
      throw new Error(`${error.message} ${JSON.stringify(details)}`)
    }
  }
  const openPane = () => openWorkTab('computer')
  if (mode === 'browser') return checkBrowser()
  if (mode === 'files') return checkFiles()
  if (mode === 'routines') return checkRoutines()
  await openPane()
  await until(`(document.querySelector(${JSON.stringify(`${livePanel} .bt-computer`)})?.offsetWidth ?? 0) >= 430`,
    'the expanded screen preview in the main window')
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.bt-computer-places button')].map(node => node.textContent.trim())"),
    await evaluate("document.querySelector('.bt-computer-places button').textContent.trim() === '自动'")
      ? ['自动', '私有桌面', '这台电脑', '关闭'] : ['Automatic', 'Private desktop', 'This computer', 'Off'])
  assert.equal(await evaluate("document.querySelectorAll('.bt-computer-places button svg').length"), 4)
  if (mode !== 'linux') await checkWindows()
  if (mode === 'windows') return
  await checkLinux()

  async function checkWindows() {
    const local = ['This computer', '这台电脑']
    await Promise.all([nativeButton(python, pid, ['Allow', '允许']), click(pane, ...local)])
    await until(`${frameReady} && ${byText('.bt-computer-target', local)}`, 'the first primary desktop screenshot in the conversation', 30_000)
    const frame = await evaluate(`({ width: ${screen}.naturalWidth, height: ${screen}.naturalHeight })`)
    const primary = await windowState(`(() => { const { screen } = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
      const { size, scaleFactor } = screen.getPrimaryDisplay(); return { width: Math.round(size.width * scaleFactor), height: Math.round(size.height * scaleFactor) } })()`)
    assert.ok(Math.abs(frame.width - primary.width) <= 2 && Math.abs(frame.height - primary.height) <= 2,
      `Expected the primary screen, got ${JSON.stringify(frame)} vs ${JSON.stringify(primary)}`)
    console.log('check-packed: primary screen rendered in the app after authorization')
    if (mode !== 'live') {
      const { x, y } = JSON.parse(readFileSync(join(work, 'local-click.json'), 'utf8'))
      const hasFixtureColor = red => `(() => {
        const image = ${screen};
        if (!image?.complete || !image.naturalWidth) return false;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        context.drawImage(image, ${x + 10}, ${y}, 1, 1, 0, 0, 1, 1);
        const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
        return b > 230 && ${red ? 'r > 230 && g < 32' : 'r < 32 && g > 230'};
      })()`
      await until(hasFixtureColor(false), 'the initial Windows fixture color')
      writeFileSync(join(work, 'local-repaint'), '')
      await until(hasFixtureColor(true), 'the next primary desktop screenshot after updating the fixture', 30_000)
      console.log('check-packed: the primary screen updated without manual refresh')
      await capture(process.env.DS_BOT_PACKED_LOCAL_SCREENSHOT)
      await click(pane, 'Take control', '接管')
      await until(byText(`${livePanel} .bt-computer [role=status]`, ['Use your mouse and keyboard on this computer.', '请直接使用这台电脑的鼠标和键盘。']), 'physical input takeover on this computer')
      unlinkSync(join(work, 'local-repaint'))
      await until(hasFixtureColor(false), 'the primary screen updating during physical input takeover', 20_000)
      console.log('check-packed: the primary screen kept updating during physical input takeover')
      await click(pane, 'Hand back', '交还')
      await until(`${frameReady} && (${byText(pane, ['Take control', '接管'])})?.disabled === false`, 'this computer after hand-back')
      console.log('check-packed: this computer can be reserved for physical input and handed back')
    }
    await closePane()
    const path = join(work, 'local-input.txt')
    if (mode === 'live') {
      await useLiveModel()
      writeFileSync(fixture.activate, '')
      await waitFor(() => existsSync(join(work, 'local-fixture-ready')), 'the synthetic Windows screen', 10_000)
      try {
        await checkLiveDesktop('local', fixture.marker, () => existsSync(path) ? readFileSync(path, 'utf8') : undefined)
      } finally { writeFileSync(join(work, 'local-deactivate'), '') }
      return
    }
    const { x, y } = JSON.parse(readFileSync(join(work, 'local-click.json'), 'utf8'))
    await checkBotDesktop('local', () => existsSync(path) ? readFileSync(path, 'utf8') : undefined, { x, y })
  }

  async function checkFiles() {
    const { mainBotId } = await api('state', {})
    const dir = join(work, 'workspace')
    mkdirSync(dir, { recursive: true })
    const fixtureText = 'Workspace preview fixture content.'
    const removed = join(dir, 'removed-fixture.txt')
    writeFileSync(join(dir, 'desktop-fixture.txt'), fixtureText)
    writeFileSync(removed, 'This file will be removed.')
    await api('send', { sessionId: mainBotId, text: 'Computer files smoke' })
    await until("document.body.innerText.includes('Computer files smoke finished.')", 'the mock model presenting workspace files', 60_000)
    await openWorkTab('data')
    const list = `${livePanel} .bt-computer-files`
    const fileButton = `${list} button`
    await openWorkTab('data')
    await until(byText(fileButton, ['removed-fixture.txt']), 'the second presented file can be opened')
    await openPane()
    unlinkSync(removed)
    await openWorkTab('data')
    await until(`(${byText(fileButton, ['desktop-fixture.txt'])}) && !document.querySelector('${list} [title="removed-fixture.txt"]')`,
      'the missing file is filtered out after reopening the pane')
    await click(fileButton, 'desktop-fixture.txt')
    await until(`Array.from(document.querySelectorAll('[data-textpreview-line]')).some(node => node.textContent.includes(${JSON.stringify(fixtureText)}))`,
      'the workspace file opens in the document preview')
    console.log('check-packed: the workspace file list opened a presented file and removed the missing file from the list')
  }

  async function checkRoutines() {
    const { mainBotId } = await api('state', {})
    const title = 'Work panel routine check'
    const form = "document.querySelector('.bt-settings .bt-task-form')"
    const edit = async (selector, value) => {
      await evaluate(`(${form}).querySelector(${JSON.stringify(selector)}).focus()`)
      await cdp.call('Input.insertText', { text: value })
      await until(`(${form})?.querySelector(${JSON.stringify(selector)}).value === ${JSON.stringify(value)}`, selector)
    }
    await openWorkTab('routines')
    await click(`${livePanel} .bt-more`, 'No scheduled tasks yet. Add one', '还没有定时任务，去添加')
    await until(form, 'the scheduled task form')
    assert.equal(await evaluate(`${form}.querySelector('.bt-task-bot').value`), mainBotId)
    await edit('input.bt-bs-input', title)
    await edit('textarea', 'Summarize the fixture workspace.')
    await click('.bt-task-form button[type=submit]', 'Create task', '创建任务')
    await until(byText('.bt-settings .bt-task-title', [title]), 'the new scheduled task')
    await evaluate("document.querySelector('.bt-settings-close').click()")
    await until("!document.querySelector('.bt-settings-layer')", 'routine settings closed')
    await openWorkTab('routines')
    await until(`(() => {
      const task = ${byText(`${livePanel} .bt-task-line-title`, [title])};
      if (!task) return false;
      task.closest('button').click();
      return true;
    })()`, 'the routine in the current Bot panel')
    await until(byText('.bt-settings .bt-task-title', [title]), 'the task can be managed from the panel')
    await until(`(() => {
      const remove = document.querySelector('.bt-settings .bt-task-remove');
      if (!remove || remove.disabled) return false;
      remove.click();
      return true;
    })()`, 'task delete confirmation')
    await click('.bt-task-remove[data-confirm]', 'Delete', '删除')
    await until(`!(${byText('.bt-settings .bt-task-title', [title])})`, 'the deleted scheduled task is gone')
    await evaluate("document.querySelector('.bt-settings-close').click()")
    await until("!document.querySelector('.bt-settings-layer')", 'routine settings closed after deleting')
    await openWorkTab('routines')
    await until(`!!(${byText(`${livePanel} .bt-more`, ['No scheduled tasks yet. Add one', '还没有定时任务，去添加'])})`, 'the routine was removed from the panel')
    console.log('check-packed: the routines panel selected the active Bot and supported creating, reopening, and deleting a scheduled task')
  }

  async function closePane() {
    await until(`(() => {
      if (!document.querySelector('${panel}')) return true
      document.querySelector('${panel} .bt-work-head > button:last-child')?.click()
      return false
    })()`, 'the computer pane to close')
  }

  async function capture(path) {
    if (!path) return
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path, Buffer.from(data, 'base64'))
    console.log(`check-packed: saved ${path}`)
  }

  async function api(endpoint, payload) {
    return evaluate(`fetch('/api/bot', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(${JSON.stringify({ endpoint, payload })}) }).then(r => r.json()).then(result => {
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        return result.value;
      })`)
  }

  async function waitFor(predicate, label, ms) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await predicate()) return
      await sleep(250)
    }
    throw new Error(`Timed out waiting for ${label}.`)
  }

  async function useLiveModel() {
    const { mainBotId } = await api('state', {})
    const updated = await api('update-bot', { id: mainBotId, model: 'qa-vision/gpt-6.2-sol' })
    assert.equal(updated.model, 'qa-vision/gpt-6.2-sol')
  }

  async function checkLiveDesktop(target, marker, readInput) {
    const { mainBotId } = await api('state', {})
    const text = 'This is a desktop QA fixture. Use the computer tools only. First observe the selected desktop. '
      + 'Read the visible desk code. Copy exactly that code into the test input and press Return once. '
      + (target === 'local' ? 'Click the input at its location in the screenshot before typing. ' : 'The terminal is already focused. ')
      + 'Then reply with the code you saw. Do not use shell or file tools or interact with anything outside the fixture.'
    await api('send', { sessionId: mainBotId, text })
    await until(`${byText('[data-approval-key] button', ['Allow once', '允许一次'])} || document.body.innerText.includes('Choose an image-capable model')`,
      `the ${target} computer tool approval`, 110_000)
    await click('[data-approval-key] button', 'Allow once', '允许一次')
    await waitFor(async () => await readInput() === marker, `gpt-6.2-sol to submit the visible ${target} desktop code`, 180_000)
    await waitFor(async () => {
      const state = await api('state', {})
      const session = state.bots.find(bot => bot.id === mainBotId).sessionId
      return !state.work.turns[session]
    }, `gpt-6.2-sol to finish the ${target} desktop turn`, 90_000)
    console.log(`check-packed: gpt-6.2-sol read and submitted the on-screen ${target} desktop code`)
  }

  async function checkBotDesktop(target, readInput, point) {
    const log = () => readFileSync(join(work, 'mock.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const previous = log().length
    const state = await api('state', {})
    const session = state.bots.find(bot => bot.id === state.mainBotId).sessionId
    const marker = `fixture-${target}-${Date.now()}`
    const mode = !readInput ? 'observe' : point ? 'replace-local' : 'replace-private'
    await api('send', { sessionId: state.mainBotId, text: `Computer smoke: ${mode} ${marker}${point ? ` ${point.x} ${point.y}` : ''}` })
    try {
      await click('[data-approval-key] button', 'Allow once', '允许一次')
    } catch (error) {
      const current = await api('state', {})
      const active = current.bots.find(bot => bot.id === current.mainBotId).sessionId
      const { target: selected } = await api('computer-status', { subject: current.mainBotId })
      const requests = log().slice(previous).map(row => ({
        currentSession: row.session === active,
        hasPrompt: row.last?.includes(marker) ?? false,
        handoff: row.last?.startsWith('[Handoff · part ') ?? false,
        hasComputerTool: row.toolNames?.includes('computer_observe') ?? false,
        calledComputerTool: row.out?.some(part => part.name === 'computer_observe') ?? false,
        computerFailed: row.out?.some(part => part.text?.startsWith(`Computer smoke ${marker}: failed.`)) ?? false,
      }))
      throw new Error(`${target} desktop: ${error.message} ${JSON.stringify({
        selected, sameSession: active === session, switching: current.work.bots[current.mainBotId]?.switching === true,
        running: Boolean(current.work.turns[active]), approvalPending: current.work.approvals.some(entry => entry.sessionId === active),
        approvalButtons: await evaluate("document.querySelectorAll('[data-approval-key] button').length"), requests,
      })}`, { cause: error })
    }
    const response = `document.body.innerText.split('\\n').find(line => line.startsWith(${JSON.stringify(`Computer smoke ${marker}:`)}))`
    await until(response, 'the mock model reporting its computer action', 45_000)
    assert.equal(await evaluate(response), `Computer smoke ${marker}: ${readInput ? 'submitted.' : 'screenshot received.'}`)
    const deadline = Date.now() + 10_000
    let verification
    while (Date.now() < deadline) {
      const rows = log().slice(previous)
      const sawImage = rows.some(row => row.images > 0 && row.out?.some(part => readInput
        ? point ? part.name === 'computer_click' && part.input?.x === point.x && part.input?.y === point.y
          : part.name === 'computer_type' && part.input?.text === 'replace-me'
        : part.text === `Computer smoke ${marker}: screenshot received.`))
      const current = await api('state', {})
      const sawShortcut = !readInput || rows.some(row => row.out?.some(part => part.name === 'computer_hotkey'))
      const input = await readInput?.()
      const turnFinished = !current.work.turns[session]
      verification = { sawImage, sawShortcut, turnFinished, inputReceived: input !== undefined, inputMatches: input === marker }
      if (sawImage && sawShortcut && turnFinished && (!readInput || input === marker)) {
        console.log(`check-packed: the mock model received a real ${target} desktop screenshot${readInput ? ' and replaced input using a keyboard shortcut' : ''} after approval`)
        return
      }
      await sleep(250)
    }
    throw new Error(`The ${target} desktop action could not be verified: ${JSON.stringify(verification)}`)
  }

  async function checkLinux() {
    await until("!!document.querySelector('.bt-account')", 'the account menu button')
    await evaluate("document.querySelector('.bt-account').click()")
    await click('.bt-account-menu [role=menuitem]', 'Bot settings', 'Bot 设置')
    await click('.bt-settings-item', 'Computer and browser', '电脑与浏览器')
    await click(settings, 'Set up', '设置')
    await until("document.querySelector('.bt-computer-setup')?.open === true", 'the private desktop setup dialog')
    assert.equal(await evaluate("document.querySelectorAll('.bt-computer-steps li').length"), 4)
    assert.equal(await evaluate("document.querySelector('.bt-computer-setup-details') === null"), true)
    const imageRecord = join(work, 'shell', 'computer-image.json')
    if (legacyDockerImage) assert.equal(JSON.parse(readFileSync(imageRecord, 'utf8')).id, legacyDockerImage)
    else assert.equal(existsSync(imageRecord), false, 'Use a fresh app profile for setup.')
    await click(settings, 'Refresh status', '重新检测')
    await until("document.querySelector('.bt-computer-setup footer button:last-child')?.disabled === false", 'setup status refreshed')
    const setupStage = await evaluate("window.dsBotApp.computer.settings('readiness')")
    console.log(`check-packed: ${legacyDockerImage ? 'legacy Docker' : 'fresh'} setup opened at stage ${setupStage}`)
    if (legacyDockerImage) assert.equal(setupStage, 'prepare')
    const freshMachine = process.env.DS_BOT_PACKED_FRESH_MACHINE === '1'
    if (freshMachine) assert.equal(setupStage, 'start', 'Start this test with no DS Bot Podman machine.')
    const setupProgress = step => `document.querySelector('.bt-computer-steps li:nth-child(${step}) .bt-computer-progress')`
    const checkConfirmation = async progress => {
      await until(`/Waiting for confirmation|等待确认/.test(${progress}?.textContent ?? '')`, 'waiting for desktop confirmation')
      await sleep(1200)
      assert.equal(await evaluate(`Boolean(${progress}?.querySelector('progress, time'))`), false)
    }
    const checkProgress = async (step, screenshot, mustAdvance = false) => {
      const progress = setupProgress(step)
      await until(`${progress}?.querySelector('progress') && /[0-9]+:[0-9]{2}/.test(${progress}.querySelector('time')?.textContent ?? '')`,
        `setup progress for step ${step}`)
      if (mustAdvance) {
        const initial = await evaluate(`${progress}?.querySelector('time')?.textContent`)
        await until(`${progress}?.querySelector('time') && ${progress}.querySelector('time').textContent !== ${JSON.stringify(initial)}`,
          `the timer advancing for step ${step}`, 6_000)
      }
      await capture(screenshot)
    }
    if (setupStage === 'start') {
      await click(settings, 'Start Podman machine', '启动 Podman 虚拟机')
      if (freshMachine) {
        await until(`/Initializing the Podman machine|正在初始化 Podman/.test(${setupProgress(2)}?.textContent ?? '')`,
          'fresh Podman machine initialization', 20_000)
      }
      await checkProgress(2, process.env.DS_BOT_PACKED_RUNTIME_PROGRESS_SCREENSHOT)
      const prepareButton = byText(settings, ['Prepare desktop', '准备桌面'])
      const setupAlert = `document.querySelector('.bt-computer-settings [role="alert"]')?.innerText`
      await until(`${prepareButton}?.disabled === false || Boolean(${setupAlert})`, 'desktop runtime started', 10 * 60_000)
      assert.equal(await evaluate(`${prepareButton}?.disabled`), false, await evaluate(setupAlert))
      console.log('check-packed: the setup guide started the Podman machine')
    }
    await click(settings, 'Prepare desktop', '准备桌面')
    await checkConfirmation(setupProgress(3))
    await nativeButton(python, pid, ['Cancel', '取消'])
    await until(`!${setupProgress(3)}`, 'preparation cancellation clears progress')
    assert.equal(existsSync(imageRecord), Boolean(legacyDockerImage))
    await click(settings, 'Prepare desktop', '准备桌面')
    await checkConfirmation(setupProgress(3))
    await nativeButton(python, pid, ['Prepare', '准备'])
    await checkProgress(3, process.env.DS_BOT_PACKED_PREPARE_PROGRESS_SCREENSHOT)
    const preparedButton = byText(settings, ['Create desktop', '创建桌面'])
    const setupEnd = Date.now() + 16 * 60_000
    let setupState
    let prepared = false
    while (Date.now() < setupEnd) {
      setupState = await evaluate(`({
        ready: !!(${preparedButton} && !${preparedButton}.disabled),
        error: document.querySelector('.bt-computer-settings [role="alert"]')?.innerText,
      })`)
      if (setupState.error) throw new Error(setupState.error)
      if (setupState.ready && existsSync(imageRecord)) {
        const image = JSON.parse(readFileSync(imageRecord, 'utf8'))
        assert.match(image.id, /^sha256:[a-f0-9]{64}$/u)
        if (legacyDockerImage) {
          assert.equal(image.runtime, 'docker')
          assert.notEqual(image.id, legacyDockerImage)
        }
        prepared = true
        break
      }
      await sleep(1000)
    }
    assert.ok(prepared, `The desktop preparation did not finish: ${JSON.stringify(setupState)}`)
    console.log('check-packed: private desktop image prepared')
    const waitView = (expression, label) => until(expression, label, 45_000)
    const { runtime = 'docker' } = JSON.parse(readFileSync(imageRecord, 'utf8'))
    const backend = desktopRuntime(runtime)
    await backend.verify()
    const instance = readFileSync(join(work, 'shell', 'computer-instance.txt'), 'utf8').trim()
    assert.match(instance, /^[a-f0-9-]{36}$/u)
    const name = `ds-bot-cua-${instance}`
    const runDocker = (...args) => backend.command(args)
    const startedAt = target => runDocker('container', 'inspect', '--format', '{{.State.StartedAt}}', target).then(result => result.stdout.trim())
    const running = target => runDocker('container', 'inspect', '--format', '{{.State.Running}}', target).then(result => result.stdout.trim())
    const label = 'io.github.qingj01.dsbot.cua-instance'
    const state = await api('state', {})
    async function registerDesktop(target) {
      const { stdout } = await runDocker('container', 'inspect', '--format', `{{.Id}}|{{index .Config.Labels "${label}"}}`, target)
      const [container, owner] = stdout.trim().split('|')
      assert.match(container, /^[a-f0-9]{64}$/u)
      assert.equal(owner, instance)
      onDesktop({ container, name: target, instance, runDocker })
      return container
    }
    assert.deepEqual(await evaluate("window.dsBotApp.computer.settings('inventory', [])"), [])
    const startupBegan = performance.now()
    await click(settings, 'Create desktop', '创建桌面')
    await checkProgress(4, process.env.DS_BOT_PACKED_CREATE_PROGRESS_SCREENSHOT, true)
    const startupAlert = `document.querySelector('.bt-computer-settings [role="alert"]')?.textContent?.trim()`
    await until(`(${settingsFrame}) || Boolean(${startupAlert})`, 'the desktop creation result', 75_000)
    const container = await registerDesktop(name)
    assert.ok(await evaluate(settingsFrame), await evaluate(startupAlert))
    assert.equal(await running(container), 'true', 'The setup guide must leave the new desktop running.')
    console.log(`check-packed: setup created a running private desktop and rendered its first frame in ${Math.round((performance.now() - startupBegan) / 1000)}s`)
    await capture(process.env.DS_BOT_PACKED_SETUP_SCREENSHOT)
    if (mode === 'live') {
      await click(settings, 'Open private desktop', '打开私有桌面').catch(async () => {
        if (await evaluate("!!document.querySelector('.bt-computer-setup')")) await click(settings, 'Close', '关闭')
        await evaluate("document.querySelector('.bt-settings-close')?.click()")
      })
      await openPane()
      await authorizePrivate()
      await waitView(`${screen}?.naturalWidth === 1280`, 'the isolated private desktop in the main window')
      await closePane()
      const botInput = '/home/cua/workspace/live-bot-check.txt'
      const marker = `desk-${randomBytes(4).toString('hex')}`
      await runDocker('exec', '-d', container, '/usr/bin/xfce4-terminal', '--disable-server', '--maximize',
        '--title=Private desktop QA', '-x', 'sh', '-c', 'printf "Copy this code: %s\\n> " "$2"; IFS= read -r line && printf "%s" "$line" > "$1"',
        'fixture', botInput, marker)
      await waitFor(async () => {
        const { stdout } = await runDocker('exec', container, 'xprop', '-root', '_NET_ACTIVE_WINDOW')
        const id = stdout.match(/0x[0-9a-f]+/u)?.[0]
        return id && id !== '0x0' && (await runDocker('exec', container, 'xprop', '-id', id, '_NET_WM_NAME')).stdout.includes('Private desktop QA')
      }, 'the isolated desktop input fixture', 15_000)
      await checkLiveDesktop('private', marker, () => runDocker('exec', container, 'cat', botInput).then(({ stdout }) => stdout, () => undefined))
      return
    }
    const activeWindow = async () => {
      const { stdout } = await runDocker('exec', container, 'xprop', '-root', '_NET_ACTIVE_WINDOW')
      const id = stdout.match(/0x[\da-f]+/u)?.[0]
      return id && id !== '0x0' ? (await runDocker('exec', container, 'xprop', '-id', id, '_NET_WM_NAME')).stdout : ''
    }
    if (process.env.DS_BOT_PACKED_GROUP_ONLY === '1') {
      await click(settings, 'Close', '关闭')
      await until("!document.querySelector('.bt-computer-setup')", 'setup closed after creation')
      await evaluate("document.querySelector('.bt-settings-close').click()")
      await until("!document.querySelector('.bt-settings-layer')", 'settings closed after setup')
      // Reproduce the Chromium visibility report without obscuring the native permission dialog.
      await evaluate("Object.defineProperty(document, 'hidden', { configurable: true, value: true })")
      try {
        assert.equal(await windowState('win.isVisible() && !win.isMinimized()'), true)
        await checkGroup()
      } finally {
        await evaluate("Reflect.deleteProperty(document, 'hidden')")
      }
      return
    }
    if (process.env.DS_BOT_PACKED_POOL_ONLY === '1') {
      await click(settings, 'Close', '关闭')
      await until("!document.querySelector('.bt-computer-setup')", 'setup closed after creation')
      await evaluate("document.querySelector('.bt-settings-close').click()")
      await until("!document.querySelector('.bt-settings-layer')", 'settings closed after setup')
      const member = await createOtherBot()
      const room = await api('create-room', { name: 'Desktop pool QA', members: [state.mainBotId, member.other.id], admin: state.mainBotId })
      const groupRow = `document.querySelector(${JSON.stringify(`[data-room-id="${room.id}"]`)})`
      await checkIsolation(groupRow, member, true)
      return
    }
    const { width, height } = await windowState('win.getBounds()')
    try {
      await windowState('win.setSize(520, 510)')
      await until(`(() => {
        const dialog = document.querySelector('.bt-computer-setup')
        const body = dialog.querySelector('.bt-computer-setup-body')
        const footer = dialog.querySelector('footer').getBoundingClientRect()
        const outer = dialog.getBoundingClientRect()
        return innerWidth < 540 && outer.left >= 0 && outer.right <= innerWidth && outer.bottom <= innerHeight
          && footer.bottom <= outer.bottom && body.scrollHeight > body.clientHeight && body.scrollWidth <= body.clientWidth
      })()`, 'the scrollable setup dialog at a narrow window size')
      await capture(process.env.DS_BOT_PACKED_SETUP_NARROW_SCREENSHOT)
    } finally { await windowState(`win.setSize(${width}, ${height})`) }
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await until("!document.querySelector('.bt-computer-setup') && !!document.querySelector('.bt-settings-layer')", 'Escape closes only the setup dialog')
    assert.equal(await evaluate(`document.activeElement === ${byText(settings, ['Manage', '管理'])}`), true, 'Closing setup must return focus to its settings button.')
    await evaluate("document.querySelector('.bt-settings-close').click()")
    await until("!document.querySelector('.bt-settings-layer')", 'settings closed after setup')
    await openPane()
    await authorizePrivate()
    try {
      await waitView(`(() => {
        const screen = ${screen};
        if (!screen || screen.naturalWidth !== 1280 || screen.naturalHeight !== 900) return false;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 16;
        const context = canvas.getContext('2d');
        context.drawImage(screen, 0, 0, 16, 16);
        const pixels = context.getImageData(0, 0, 16, 16).data;
        return pixels.some((value, index) => index % 4 !== 3 && value > 16);
      })()`, 'the visible private desktop on first open')
    } catch (error) {
      const status = await api('computer-status', { subject: state.mainBotId })
      const panel = await evaluate(`({ active: document.querySelector('[data-bot-id][aria-current=page]')?.dataset.botId,
        message: document.querySelector('.bt-computer')?.innerText,
        width: ${screen}?.naturalWidth, height: ${screen}?.naturalHeight })`)
      throw new Error(`${error.message}: ${JSON.stringify({ status, panel })}`, { cause: error })
    }
    await capture(process.env.DS_BOT_PACKED_VIEWER_SCREENSHOT)
    await evaluate(`window.dsBotPreviewBefore = ${screen}.getAttribute('src'); true`)
    await runDocker('exec', '-d', container, '/usr/bin/xfce4-terminal', '--disable-server', '--maximize',
      '--title=DS Bot preview check', '-x', 'sh', '-c', 'printf "Private desktop preview check\\n"; sleep 45')
    await waitView(`${frameReady} && ${screen}.getAttribute('src') !== window.dsBotPreviewBefore`,
      'the next private desktop screenshot after opening the fixture')
    console.log('check-packed: the private desktop updated without manual refresh')
    await windowState('win.setMinimizable(true)')
    try {
      await windowState('win.minimize()')
      assert.equal(await windowState('win.isMinimized()'), true)
      await waitFor(async () => (await api('computer-status', { subject: state.mainBotId })).target === undefined,
        'the minimized window to revoke the desktop grant', 15_000)
    } finally {
      await windowState('(() => { win.restore(); win.focus(); win.setMinimizable(false) })()')
    }
    await until(`!document.hidden && !(${screen}) && !(${byText(pane, privateLabels)})?.disabled`,
      'the restored window with the previous preview cleared')
    await authorizePrivate()
    await waitView(frameReady, 'the first desktop frame after authorizing again')
    console.log('check-packed: minimizing cleared the desktop grant and restoring allowed a fresh preview')
    await click(pane, 'Take control', '接管')
    await waitView(`${activeFrame}`, 'human control in the main window')
    const path = '/home/cua/workspace/viewer-check.txt'
    await runDocker('exec', '-d', container, '/usr/bin/xfce4-terminal', '--disable-server',
      '--title=DS Bot viewer input', '-x', 'sh', '-c', 'IFS= read -r line && printf "%s" "$line" > "$1"', 'fixture', path)
    for (let attempt = 0; !(await activeWindow()).includes('DS Bot viewer input'); attempt++) {
      assert.ok(attempt < 25, 'The terminal fixture did not get focus.')
      await sleep(200)
    }
    for (const [key, code, virtualKey] of [['d', 'KeyD', 68], ['s', 'KeyS', 83], ['Enter', 'Enter', 13]]) {
      await waitView(activeFrame, 'viewer input readiness')
      await evaluate(`${canvas}.focus()`)
      await press(cdp, key, code, virtualKey)
      await sleep(350)
    }
    let typed
    for (let attempt = 0; attempt < 25; attempt++) {
      typed = await runDocker('exec', container, 'cat', path).then(({ stdout }) => stdout.trim(), () => undefined)
      if (typed !== undefined) break
      await sleep(200)
    }
    assert.equal(typed, 'ds')
    const html = `<title>Desktop input fixture</title><style>
      body{height:4000px;width:4000px;user-select:none} input{position:fixed;inset:0;width:320px;height:40px;margin:auto}
      </style><input aria-label="Desktop input fixture"><script>
      const input = document.querySelector('input');
      document.addEventListener('click', () => { input.focus(); document.title = 'Click verified'; });
      input.addEventListener('input', () => {
        if (input.value === 'DS Bot clipboard check') document.title = 'Paste verified';
        if (input.value === 'DS Bot clipboard check \u4e2d\u6587') document.title = 'Text entry verified';
        if (input.value === 'Edited clipboard \u4fee\u6539') document.title = 'Clipboard edit verified';
      });
      document.addEventListener('keydown', event => {
        if (event.key === 'Tab' || event.key === 'Escape') {
          event.preventDefault();
          document.title = event.key + ' key verified';
        }
      });
      document.addEventListener('dblclick', () => { document.title = 'Double click verified'; });
      document.addEventListener('contextmenu', event => { event.preventDefault(); document.title = 'Right click verified'; });
      document.addEventListener('auxclick', event => {
        if (event.button === 1) { event.preventDefault(); document.title = 'Middle click verified'; }
      });
      let down;
      document.addEventListener('mousedown', event => {
        if (event.button === 0) down = event.clientX;
        else if (event.button === 1) event.preventDefault();
      });
      document.addEventListener('mouseup', event => {
        if (event.button !== 0 || down === undefined) return;
        const dragged = Math.abs(event.clientX - down) > 30;
        down = undefined;
        if (dragged) requestAnimationFrame(() => { document.title = 'Drag verified'; });
      });
      addEventListener('scroll', () => {
        if (scrollX > 0) document.title = 'Horizontal scroll verified';
        else if (scrollY > 0) document.title = 'Vertical scroll verified';
      });
      </script>`
    await runDocker('exec', container, 'sh', '-c', 'printf "%s" "$1" > /home/cua/workspace/scroll.html', 'fixture', html)
    await runDocker('exec', '-d', container, 'chromium', '--no-first-run', '--start-maximized',
      'file:///home/cua/workspace/scroll.html')
    for (let attempt = 0; !(await activeWindow()).includes('Desktop input fixture'); attempt++) {
      assert.ok(attempt < 35, 'The desktop input fixture did not get focus.')
      await sleep(300)
    }
    // The driver must stay connected past the short Docker command deadline.
    await sleep(16_000)
    await waitView(activeFrame, 'the viewer staying connected')
    const pointer = await evaluate(`(() => {
      const { x, y, width, height } = ${canvas}.getBoundingClientRect()
      return { x: Math.round(x + width / 2), y: Math.round(y + height / 2) }
    })()`)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.call('Input.dispatchMouseEvent', { type, ...pointer, button: 'left', clickCount: 1 })
    }
    for (let attempt = 0; !(await activeWindow()).includes('Click verified'); attempt++) {
      assert.ok(attempt < 30, 'The click did not focus the remote input.')
      await sleep(200)
    }
    await evaluate(`(() => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'DS Bot clipboard check');
      ${canvas}.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    })()`)
    for (let attempt = 0; !(await activeWindow()).includes('Paste verified'); attempt++) {
      assert.ok(attempt < 30, 'Pasting did not insert text in the remote input.')
      await sleep(200)
    }
    const verifyInput = async (title) => {
      for (let attempt = 0; !(await activeWindow()).includes(title); attempt++) {
        assert.ok(attempt < 30, `The remote page did not report: ${title}`)
        await sleep(200)
      }
    }
    const desktopControls = `${livePanel} .bt-computer-live-controls`
    // Grab the guest keyboard briefly so XFCE cannot handle this combination as logout.
    const keys = '/tmp/ds-bot-packed-key-events'
    await runDocker('exec', '-d', container, '/usr/bin/python3', '-c', `
import ctypes as c
from pathlib import Path
import time

class KeyEvent(c.Structure):
    _fields_ = [('type', c.c_int), ('serial', c.c_ulong), ('send_event', c.c_int),
                ('display', c.c_void_p), ('window', c.c_ulong), ('root', c.c_ulong),
                ('subwindow', c.c_ulong), ('time', c.c_ulong), ('x', c.c_int), ('y', c.c_int),
                ('x_root', c.c_int), ('y_root', c.c_int), ('state', c.c_uint), ('keycode', c.c_uint)]

x11 = c.CDLL('libX11.so.6')
for name, args, result in [
    ('XOpenDisplay', [c.c_char_p], c.c_void_p),
    ('XDefaultRootWindow', [c.c_void_p], c.c_ulong),
    ('XGrabKeyboard', [c.c_void_p, c.c_ulong, c.c_int, c.c_int, c.c_int, c.c_ulong], c.c_int),
    ('XPending', [c.c_void_p], c.c_int),
    ('XNextEvent', [c.c_void_p, c.c_void_p], c.c_int),
    ('XkbKeycodeToKeysym', [c.c_void_p, c.c_ubyte, c.c_int, c.c_int], c.c_ulong),
    ('XCloseDisplay', [c.c_void_p], c.c_int),
]:
    fn = getattr(x11, name)
    fn.argtypes = args
    fn.restype = result

display = x11.XOpenDisplay(None)
path = Path('${keys}')
assert display
received = []
try:
    assert x11.XGrabKeyboard(display, x11.XDefaultRootWindow(display), 0, 1, 1, 0) == 0
    path.with_suffix('.ready').touch()
    deadline = time.monotonic() + 10
    data = (c.c_long * 24)()
    event = KeyEvent.from_buffer(data)
    while len(received) < 6 and time.monotonic() < deadline:
        if not x11.XPending(display):
            time.sleep(0.01)
            continue
        x11.XNextEvent(display, c.byref(data))
        if event.type in (2, 3):
            key = x11.XkbKeycodeToKeysym(display, event.keycode, 0, 0)
            received.append(f'{event.type}:{key:x}')
finally:
    x11.XCloseDisplay(display)
path.write_text(' '.join(received))
`)
    await waitFor(() => runDocker('exec', container, 'test', '-f', `${keys}.ready`).then(() => true, () => false),
      'the guest keyboard fixture to grab input', 8_000)
    await click(`${desktopControls} button`, 'Keyboard', '\u952e\u76d8')
    await click(`${desktopControls} .bt-computer-keyboard-panel button`, 'Ctrl+Alt+Del')
    let keyEvents
    await waitFor(async () => {
      keyEvents = await runDocker('exec', container, 'cat', keys).then(({ stdout }) => stdout, () => undefined)
      return keyEvents !== undefined
    }, 'the guest keyboard event sequence', 12_000)
    assert.equal(keyEvents.trim(), '2:ffe3 2:ffe9 2:ffff 3:ffff 3:ffe9 3:ffe3')
    console.log('check-packed: the private desktop received all Ctrl+Alt+Del press and release events')
    const fullscreenBar = '.bt-computer-viewport:fullscreen .bt-computer-fullscreen-toolbar'
    const enterFullscreen = async () => {
      const button = byText(pane, ['Full screen', '\u5168\u5c4f'])
      await cdp.call('Page.bringToFront')
      const center = `(() => {
        const control = ${button};
        if (!control || control.disabled) return null;
        control.scrollIntoView({ block: 'nearest' });
        const rect = control.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        return control.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
      })()`
      await until(center, 'the visible full-screen button', 10_000)
      const point = await evaluate(center)
      assert.ok(point, 'The full-screen button moved before input.')
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.call('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
      }
      try {
        await waitView(`!!document.querySelector('${fullscreenBar}') && ${activeFrame}`, 'full screen with live controls')
      } catch (error) {
        const state = await evaluate(`({
          fullscreen: document.fullscreenElement?.className,
          allowed: document.fullscreenEnabled,
          focused: document.hasFocus(),
          activeElement: document.activeElement?.className,
          connected: ${activeFrame},
          errors: [...document.querySelectorAll('.bt-computer .bt-error')].map(node => node.textContent),
        })`)
        throw new Error(`${error.message}: ${JSON.stringify(state)}`, { cause: error })
      }
    }
    await enterFullscreen()
    await evaluate(`document.querySelector('${fullscreenBar} input').focus()`)
    await cdp.call('Input.insertText', { text: ' \u4e2d\u6587' })
    await click(`${fullscreenBar} button`, 'Send to desktop', '\u53d1\u9001\u5230\u684c\u9762')
    await verifyInput('Text entry verified')
    const keyboardButton = byText(`${desktopControls} button`, ['Keyboard', '\u952e\u76d8'])
    await evaluate(`document.querySelector('${desktopControls} [role=group] button').click()`)
    await waitView(`!(${keyboardButton}) && ${activeFrame}`, 'the desktop tools collapsed while input stayed connected')
    await evaluate(`document.querySelector('${desktopControls} [role=group] button').click()`)
    await waitView(`!!(${keyboardButton})`, 'the desktop tools expanded')
    for (const [button, key] of [['Tab', 'Tab'], ['Esc', 'Escape']]) {
      await click(`${desktopControls} button`, 'Keyboard', '\u952e\u76d8')
      await click(`${desktopControls} .bt-computer-keyboard-panel button`, button)
      await verifyInput(key + ' key verified')
    }
    console.log('check-packed: the private desktop toolbar collapsed and sent Tab and Esc to Chromium')
    const clipboardTools = `${desktopControls} button`
    const clipboardText = `document.querySelector('.bt-computer-clipboard-panel textarea')`
    const shortcut = async (key, virtualKey) => {
      const control = { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 }
      await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, ...control })
      for (const type of ['rawKeyDown', 'keyUp']) {
        await cdp.call('Input.dispatchKeyEvent', { type, modifiers: 2, key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: virtualKey })
      }
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...control })
    }
    await shortcut('a', 65)
    await shortcut('c', 67)
    await click(clipboardTools, 'Clipboard', '\u526a\u8d34\u677f')
    await waitView(`${clipboardText}?.value === 'DS Bot clipboard check \u4e2d\u6587'`, 'Chromium copied Unicode text to the desktop clipboard panel')
    await capture(process.env.DS_BOT_PACKED_CLIPBOARD_SCREENSHOT)
    await evaluate(`${clipboardText}.select()`)
    await cdp.call('Input.insertText', { text: 'Edited clipboard \u4fee\u6539' })
    await waitView(`${clipboardText}?.value === 'Edited clipboard \u4fee\u6539'`, 'edited desktop clipboard text')
    const clipboardPrototype = 'Object.getPrototypeOf(navigator.clipboard)'
    await evaluate(`(() => {
      const proto = ${clipboardPrototype};
      window.packedClipboardWrite = proto.writeText;
      proto.writeText = value => { window.packedClipboardText = value; return Promise.resolve(); };
    })()`)
    try {
      await click(clipboardTools, 'Copy', '\u590d\u5236')
      await waitView(`window.packedClipboardText === 'Edited clipboard \u4fee\u6539'`, 'Copy sent the edited text to the host clipboard API')
    } finally {
      await evaluate(`(() => {
        ${clipboardPrototype}.writeText = window.packedClipboardWrite;
        delete window.packedClipboardWrite;
        delete window.packedClipboardText;
      })()`)
    }
    await click(clipboardTools, 'Paste on desktop', '\u7c98\u8d34\u5230\u684c\u9762')
    await verifyInput('Clipboard edit verified')
    await click(clipboardTools, 'Clipboard', '\u526a\u8d34\u677f')
    await click(clipboardTools, 'Clear clipboard', '\u6e05\u7a7a\u526a\u8d34\u677f')
    await waitView(`${clipboardText}?.value === ''`, 'the clipboard panel cleared')
    await press(cdp, 'Escape', 'Escape', 27)
    await waitView(`!(${clipboardText}) && ${activeFrame}`, 'clipboard panel closed without losing control')
    // Read the guest X11 selection without synthesizing a host paste event.
    const guestClipboard = async () => {
      const { stdout } = await runDocker('exec', container, '/usr/bin/python3', '-c', `
import ctypes
from ctypes import c_char_p, c_void_p

gtk = ctypes.CDLL('libgtk-3.so.0')
gtk.gdk_atom_intern_static_string.argtypes = [c_char_p]
gtk.gdk_atom_intern_static_string.restype = c_void_p
gtk.gtk_clipboard_get.argtypes = [c_void_p]
gtk.gtk_clipboard_get.restype = c_void_p
gtk.gtk_clipboard_wait_for_text.argtypes = [c_void_p]
gtk.gtk_clipboard_wait_for_text.restype = c_char_p
assert gtk.gtk_init_check(None, None)
selection = gtk.gdk_atom_intern_static_string(b'CLIPBOARD')
value = gtk.gtk_clipboard_wait_for_text(gtk.gtk_clipboard_get(selection))
print((value or b'').decode(), end='')
`)
      return stdout
    }
    await waitFor(async () => await guestClipboard() === '', 'the guest clipboard cleared', 10_000)
    console.log('check-packed: the private desktop copied, edited, pasted and cleared Unicode clipboard text in full screen')
    await click(`${fullscreenBar} button`, 'Exit full screen', '\u9000\u51fa\u5168\u5c4f')
    await waitView(`!document.fullscreenElement && ${activeFrame}`, 'exit full screen without losing input')
    console.log('check-packed: full screen sent Unicode text to Chromium and exited without losing control')
    const mouse = (type, button, buttons, point = pointer) => cdp.call('Input.dispatchMouseEvent', {
      type, button, buttons, ...point, clickCount: 1,
    })
    for (const [button, buttons, title] of [['right', 2, 'Right click verified'], ['middle', 4, 'Middle click verified']]) {
      await mouse('mousePressed', button, buttons)
      await mouse('mouseReleased', button, 0)
      await verifyInput(title)
    }
    for (let count = 0; count < 2; count++) {
      await mouse('mousePressed', 'left', 1)
      await mouse('mouseReleased', 'left', 0)
    }
    await verifyInput('Double click verified')
    const dragStart = { x: pointer.x - 80, y: pointer.y + 45 }
    const dragEnd = { ...dragStart, x: pointer.x + 80 }
    await mouse('mousePressed', 'left', 1, dragStart)
    await mouse('mouseMoved', 'none', 1, dragEnd)
    await mouse('mouseReleased', 'left', 0, dragEnd)
    await verifyInput('Drag verified')
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...pointer, deltaX: 0, deltaY: 120 })
    await verifyInput('Vertical scroll verified')
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...pointer, deltaX: 120, deltaY: 0 })
    await verifyInput('Horizontal scroll verified')
    console.log('check-packed: the live viewer clicked, pasted, double-clicked, right-clicked, middle-clicked, dragged, and scrolled both axes in Chromium')
    await runDocker('exec', container, 'pkill', '-f', '[s]ocket.create_connection')
    const takeControl = byText(pane, ['Take control', '接管'])
    await waitView(`${frameReady} && !(${activeFrame}) && (${takeControl})?.disabled === false`,
      'the desktop preview after losing the live connection')
    await click(pane, 'Take control', '接管')
    await waitView(activeFrame, 'the reconnected live desktop')
    await waitView(`!(${clipboardText})`, 'the new connection starts with the clipboard panel closed')
    console.log('check-packed: losing the live connection restored the preview and allowed a new takeover')
    await enterFullscreen()
    await click(`${fullscreenBar} button`, 'Hand back', '\u4ea4\u8fd8')
    await waitView(`${frameReady} && !(${activeFrame}) && !!(${byText(`${fullscreenBar} button`, ['Take control', '\u63a5\u7ba1'])})`,
      'hand back in full screen with a visible desktop')
    await click(`${fullscreenBar} button`, 'Exit full screen', '\u9000\u51fa\u5168\u5c4f')
    await waitView(`!document.fullscreenElement && ${frameReady}`, 'the desktop preview after exiting full screen')
    console.log('check-packed: private desktop rendered, accepted input, and handed control back in the main window')
    await closePane()
    const botInput = '/home/cua/workspace/bot-check.txt'
    await runDocker('exec', '-d', container, '/usr/bin/xfce4-terminal', '--disable-server',
      '--title=DS Bot model input', '-x', 'sh', '-c', 'IFS= read -r line && printf "%s" "$line" > "$1"', 'fixture', botInput)
    for (let attempt = 0; !(await activeWindow()).includes('DS Bot model input'); attempt++) {
      assert.ok(attempt < 25, 'The model input fixture did not get focus.')
      await sleep(200)
    }
    await checkBotDesktop('private', () => runDocker('exec', container, 'cat', botInput).then(({ stdout }) => stdout, () => undefined))
    await openPane()
    const previousPart = (await api('state', {})).bots.find(bot => bot.id === state.mainBotId).sessionId
    const workDir = join(work, 'rollover-workspace')
    mkdirSync(workDir)
    const mockLog = join(work, 'mock.log')
    const logOffset = readFileSync(mockLog).length
    const updated = await api('update-bot', { id: state.mainBotId, workDir })
    assert.ok(updated.workDir, 'The test Bot did not save the new working folder.')
    const rolloverDeadline = Date.now() + 60_000
    for (;;) {
      const { bots, work: activity } = await api('state', {})
      const current = bots.find(bot => bot.id === state.mainBotId)
      if (current.sessionId !== previousPart && current.parts.includes(previousPart)) break
      if (Date.now() >= rolloverDeadline) {
        const noteRequests = readFileSync(mockLog).subarray(logOffset).toString('utf8').trim().split('\n')
          .filter(Boolean).map(line => JSON.parse(line)).filter(row => row.last?.startsWith('You are now writing a handoff note')).length
        assert.fail(`The test Bot did not start a new conversation part after moving folders. ${JSON.stringify({
          previousPart, sessionId: current.sessionId, parts: current.parts, workDir: current.workDir,
          work: activity.bots[state.mainBotId], turn: activity.turns[previousPart], noteRequests,
        })}`)
      }
      await sleep(500)
    }
    await checkBotDesktop('rollover')
    assert.equal((await api('computer-status', { subject: state.mainBotId })).target, 'private-desktop')
    onGrant(state.mainBotId)
    await openPane()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await click(pane, 'Off', '关闭')
      await waitView(`!(${screen}) && (${byText(pane, ['Off', '关闭'])})?.getAttribute('aria-pressed') === 'true' && !(${byText(pane, privateLabels)})?.disabled`,
        'completed target revocation')
      assert.equal((await api('computer-status', { subject: state.mainBotId })).target, undefined)
      await authorizePrivate()
      try {
        await waitView(`${byText(pane, privateLabels)}?.getAttribute('aria-pressed') === 'true' && ${screen}?.naturalWidth > 0`, `the re-opened private desktop (${attempt + 1})`)
      } catch (error) {
        const status = await api('computer-status', { subject: state.mainBotId })
        const diagnostics = await evaluate(`({ message: document.querySelector('.bt-computer')?.innerText,
          frameWidth: ${screen}?.naturalWidth, places: [...document.querySelectorAll('.bt-computer-places button')]
            .map(node => [node.textContent, node.getAttribute('aria-pressed'), node.disabled]) })`)
        throw new Error(`${error.message}: ${JSON.stringify({ status, diagnostics })}`, { cause: error })
      }
    }
    console.log('check-packed: reopened the private desktop four times after revoking access')
    const { other, otherRow } = await createOtherBot()
    await until(`!!${otherRow}`, 'the other test conversation')
    await evaluate(`${otherRow}.click()`)
    await until(`${otherRow}?.getAttribute('aria-current') === 'page'`, 'the other conversation selected')
    await until(`!(${screen})`, 'the previous computer preview to disappear')
    assert.equal((await api('computer-status', { subject: state.mainBotId })).target, undefined)
    console.log('check-packed: changing conversations removed the preview and revoked access')
    const groupRow = await checkGroup({ other, otherRow })
    await checkIsolation(groupRow, { other, otherRow })
    await checkBrowser()

    async function createOtherBot() {
      const other = await api('create-bot', { name: 'Computer QA', role: 'Tester' })
      return { other, otherRow: `document.querySelector(${JSON.stringify(`[data-bot-id="${other.id}"]`)})` }
    }

    async function checkGroup(member) {
      const { other, otherRow } = member ?? await createOtherBot()
      const room = await api('create-room', { name: 'Shared desktop QA', members: [state.mainBotId, other.id], admin: state.mainBotId })
      const row = `document.querySelector(${JSON.stringify(`[data-room-id="${room.id}"]`)})`
      await until(`!!${row}`, 'the test group')
      await evaluate(`${row}.click()`)
      await until(`${row}?.getAttribute('aria-current') === 'page'`, 'the group conversation selected')
      await openPane()
      const allow = byText(pane, ['Allow desktop access', '授权使用'])
      try {
        await until(`!!(${allow}) && !(${allow}).disabled`, 'group using shared desktop settings')
      } catch (error) {
        const details = await evaluate(`({ visible: !document.hidden,
          panel: document.querySelector('${livePanel}')?.innerText.slice(-460),
          buttons: [...document.querySelectorAll(${JSON.stringify(pane)})].map(button => [button.textContent, button.disabled]),
        })`)
        const { privateMode } = await evaluate("window.dsBotApp.computer.settings('read')").catch(() => ({}))
        throw new Error(`${error.message}: ${JSON.stringify({ ...details, privateMode })}`, { cause: error })
      }
      assert.equal(await evaluate(`document.querySelector('${livePanel} .bt-computer .bt-computer-places, ${livePanel} .bt-computer select')`), null)
      await capture(process.env.DS_BOT_PACKED_GROUP_SCREENSHOT)
      await authorizePrivate(() => click(pane, 'Allow desktop access', '授权使用'))
      await waitView(frameReady, 'the shared desktop showing in the test group')
      assert.equal((await api('computer-status', { subject: room.id })).target, 'private-desktop')
      onGrant(room.id)
      await capture(process.env.DS_BOT_PACKED_GROUP_FRAME_SCREENSHOT)
      await checkGroupQueue(room)
      await click(pane, 'Revoke access', '撤销连接权限')
      await until(`!(${screen})`, 'the group screen disappearing after revocation')
      assert.equal((await api('computer-status', { subject: room.id })).target, undefined)
      await evaluate(`${otherRow}.click()`)
      await until(`${otherRow}?.getAttribute('aria-current') === 'page'`, 'the other test conversation selected again')
      console.log('check-packed: the group followed shared settings, showed the desktop, and revoked group access')
      return row
    }

    async function checkGroupQueue(room) {
      const file = '/home/cua/workspace/group-queue.txt'
      await runDocker('exec', '-d', container, '/usr/bin/xfce4-terminal', '--disable-server',
        '--title=DS Bot group queue fixture', '--hold', '-x', 'sh', '-c',
        'for n in 1 2; do IFS= read -r line || exit 1; printf "%s\\n" "$line" >> "$1"; done', 'fixture', file)
      await waitFor(async () => (await activeWindow()).includes('DS Bot group queue fixture'), 'the shared desktop input fixture', 10_000)
      const marker = `fixture-group-${Date.now()}`
      const details = `document.querySelector('${panel} .bt-work-head button[aria-label="Details"], ${panel} .bt-work-head button[aria-label="\u8be6\u60c5"]')`
      await until(`(() => { const tab = ${details}; if (!tab) return false; tab.click(); return true })()`, 'the group details tab')
      await api('send', { sessionId: room.id, text: `Computer queue smoke: ${marker} @all` })
      const approveMember = async bot => {
        await until(`(() => {
          const member = [...document.querySelectorAll('.bt-member')].find(node => node.querySelector('.bt-member-name')?.textContent === ${JSON.stringify(bot)});
          const allow = [...(member?.querySelectorAll('.bt-mw-actions button') ?? [])].find(node => ['Allow once', '允许一次'].includes(node.textContent.trim()));
          if (!allow || allow.disabled) return false;
          allow.click(); return true;
        })()`, `computer tool approval for ${bot}`, 45_000)
      }
      const first = (await api('state', {})).bots.find(bot => bot.id === state.mainBotId)
      await until("document.querySelectorAll('.bt-mw-card').length >= 2", 'both group members asking for approval', 45_000)
      await approveMember(first.name)
      const groupStatus = () => api('computer-status', { subject: room.id })
      await waitFor(async () => (await groupStatus()).status === 'bot', 'the first group member acquiring the desktop', 15_000)
      await approveMember('Computer QA')
      await waitFor(async () => (await groupStatus()).waiting === 1, 'the second group member entering the desktop queue', 7_500)
      await openPane()
      const groupScreenStatus = `document.querySelector('${livePanel} .bt-computer-status')?.textContent ?? ''`
      await until(`/(?:Bots waiting|\u6392\u961f\u4e2d\u7684 Bot): 1/.test(${groupScreenStatus})`, 'the queue count in the group desktop pane', 5_000)
      await until(frameReady, 'the group preview during a queued turn', 5_000)
      await capture(process.env.DS_BOT_PACKED_GROUP_QUEUE_SCREENSHOT)
      const submitted = async () => runDocker('exec', container, 'cat', file).then(({ stdout }) => stdout.trim().split('\n'), () => [])
      const transitions = []
      const began = performance.now()
      let nextRead = 0
      let lines = []
      try {
        await waitFor(async () => {
          if (performance.now() >= nextRead) {
            lines = await submitted()
            nextRead = performance.now() + 1500
          }
          const { status, waiting } = await groupStatus()
          const phase = `${status}/${waiting}/${lines.length}`
          if (transitions.at(-1)?.phase !== phase) transitions.push({ phase, seconds: Math.round((performance.now() - began) / 1000) })
          return lines.length === 2
        }, 'both group members sending input to the shared desktop', 135_000)
      } catch (error) {
        const model = readFileSync(join(work, 'mock.log'), 'utf8').trim().split('\n')
          .map(line => JSON.parse(line)).filter(row => row.last?.includes(marker) || row.out?.some(part =>
            part.input?.text?.startsWith(marker) || part.text?.startsWith(`Computer smoke ${marker}`) ||
            ['computer_observe', 'computer_key'].includes(part.name)))
          .slice(-14).map(row => ({ time: row.t, images: row.images, out: row.out?.map(part =>
            part.name ?? (part.text?.startsWith(`Computer smoke ${marker}`) ? part.text : part.type)) }))
        throw new Error(`${error.message} Queue phases: ${transitions.map(({ phase, seconds }) => `${phase} at ${seconds}s`).join(' → ')}. Mock results: ${JSON.stringify(model)}.`, { cause: error })
      }
      assert.deepEqual(await submitted(), [`${marker}-first`, `${marker}-second`])
      await waitFor(async () => {
        const status = await groupStatus()
        return status.status === 'idle' && status.waiting === 0
      }, 'the shared group desktop queue to drain', 20_000)
      await openPane()
      console.log('check-packed: the second approved group member waited and both members submitted input in order')
    }

    async function checkTwoDesktops(first, second) {
      const workspace = '.bt-computer-workspace'
      const panel = index => `${workspace} [data-desktop-pane="${index}"]`
      const watcher = index => `document.querySelector(${JSON.stringify(`${panel(index)} img`)})`
      const liveView = index => `document.querySelector(${JSON.stringify(`${panel(index)} .bt-computer-live[data-connected] canvas`)})`
      await click(pane, 'Open two desktops', '打开双桌面')
      await waitView(`${watcher(1)}?.naturalWidth === 1280 && ${watcher(2)}?.naturalWidth === 1280`, 'both private desktop frames')
      assert.equal(await evaluate(`document.querySelector('${panel(1)} select').value`), state.mainBotId)
      await capture(process.env.DS_BOT_PACKED_TWO_DESKTOPS_SCREENSHOT)
      const write = async (index, target, letter, keyCode) => {
        const file = `/home/cua/workspace/workspace-input-${index}.txt`
        const title = `DS Bot workspace input ${index}`
        await runDocker('exec', '-d', target, '/usr/bin/xfce4-terminal', '--disable-server',
          `--title=${title}`, '-x', 'sh', '-c', 'IFS= read -r line && printf "%s" "$line" > "$1"', 'fixture', file)
        await waitFor(async () => {
          const { stdout } = await runDocker('exec', target, 'xprop', '-root', '_NET_ACTIVE_WINDOW')
          const active = stdout.match(/0x[\da-f]+/u)?.[0]
          if (!active || active === '0x0') return false
          return (await runDocker('exec', target, 'xprop', '-id', active, '_NET_WM_NAME')).stdout.includes(title)
        }, `input fixture in desktop ${index}`, 12_000)
        await click(`${panel(index)} button`, 'Take control', '接管')
        await waitView(`Boolean(${liveView(index)}?.width) && !${liveView(3 - index)}`, `control switched to desktop ${index}`)
        await evaluate(`${liveView(index)}.focus()`)
        await press(cdp, letter, `Key${letter.toUpperCase()}`, keyCode)
        await press(cdp, 'Enter', 'Enter', 13)
        await waitFor(async () => (await runDocker('exec', target, 'cat', file).catch(() => ({}))).stdout?.trim() === letter,
          `keyboard input in desktop ${index}`, 12_000)
        await assert.rejects(runDocker('exec', index === 1 ? second : first, 'test', '-e', file))
      }
      await write(1, first, 'a', 65)
      await write(2, second, 'b', 66)
      await evaluate(`document.querySelector('${workspace} > header button').click()`)
      await until(`!document.querySelector('${workspace}')`, 'both workspace viewers closed')
      assert.equal(await running(first), 'true')
      assert.equal(await running(second), 'true')
      console.log('check-packed: two private desktops displayed, and control switched between the two input fixtures')
    }

    async function checkIsolation(groupRow, { other, otherRow }, poolOnly = false) {
      const firstRow = `document.querySelector(${JSON.stringify(`[data-bot-id="${state.mainBotId}"]`)})`
      const settingsFile = join(work, 'shell', 'computer-settings.json')
      const scopedName = bot => `${name}-bot-${createHash('sha256').update(bot).digest('hex').slice(0, 32)}`
      const authorization = bot => api('computer-status', { subject: bot })
      const openSettings = async () => {
        await openPane()
        await click(pane, 'Computer and browser settings', '电脑与浏览器设置')
        await click(settings, 'Manage', '管理')
        await until("!!document.querySelector('.bt-computer-setup[data-managing] .bt-computer-setup-details')", 'desktop management on first open')
        await until(`!!document.querySelector('.bt-computer-isolation button:not(:disabled)')`, 'desktop isolation settings')
      }
      const closeSettings = async () => {
        await click(settings, 'Close', '关闭')
        await until("!document.querySelector('.bt-computer-setup')", 'desktop management closed')
        await evaluate("document.querySelector('.bt-settings-close').click()")
        await until("!document.querySelector('.bt-settings-layer')", 'settings closed')
        await openPane()
      }
      const waitSaved = () => until(`document.querySelector('.bt-computer-settings [role=status]')?.textContent.match(/^(Saved|已保存)$/)`, 'desktop settings saved')
      const resourceLimits = async desktop => {
        const { stdout } = await runDocker('container', 'inspect', '--format', '{{json .HostConfig}}', desktop)
        const { Memory, MemorySwap, NanoCpus } = JSON.parse(stdout)
        return [Memory / 1024 ** 3, MemorySwap / 1024 ** 3, NanoCpus / 10 ** 9]
      }
      const setLimit = async value => {
        await until(`(() => {
          const select = document.querySelector('[data-computer-limit]');
          if (!select || select.disabled) return false;
          select.value = ${JSON.stringify(value)};
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`, 'saving desktop instance limit')
        await waitSaved()
      }
      const switchBot = async row => {
        await evaluate(`${row}.click()`)
        await until(`${row}?.getAttribute('aria-current') === 'page'`, 'the test conversation selected')
        await openPane()
      }
      const assertScope = async bot => {
        const target = scopedName(bot)
        const { stdout } = await runDocker('container', 'inspect', '--format', '{{json .}}', target)
        const info = JSON.parse(stdout)
        assert.equal(info.Config.Labels['io.github.qingj01.dsbot.cua-instance'], instance)
        assert.equal(info.State.Running, true)
        assert.deepEqual(info.Mounts.map(m => m.Name).sort(), [`${target}-chromium`, `${target}-workspace`])
        onDesktop({ container: info.Id, name: target, instance, runDocker })
        return info.Id
      }

      const allow = byText(pane, ['Allow desktop access', '授权使用'])
      if (poolOnly) return checkPool()

      await openSettings()
      const sharedStartedAt = await startedAt(container)
      await click(settings, 'Check startup', '检查启动')
      await waitView(settingsFrame, 'the running shared desktop screenshot')
      assert.equal(await running(container), 'true', 'The startup check must preserve a running desktop.')
      assert.equal(await startedAt(container), sharedStartedAt)
      await click('.bt-computer-isolation button', 'Desktop per Bot', '按 Bot 隔离')
      await waitSaved()
      assert.equal(await running(container), 'false')
      await closeSettings()
      await evaluate(`${groupRow}.click()`)
      await openPane()
      await until(`(${allow})?.disabled && /Enable shared mode|开启共享|启用共享/.test(document.querySelector('.bt-computer-group-access')?.innerText ?? '')`,
        'group desktop access disabled in per-Bot mode')
      await evaluate(`${otherRow}.click()`)
      await until(`${otherRow}?.getAttribute('aria-current') === 'page'`, 'the test Bot conversation restored')
      await openSettings()
      await setLimit('1')
      await evaluate(`(() => {
        const select = document.querySelector('.bt-computer-settings select:not([data-computer-limit])');
        if (select) {
          select.value = ${JSON.stringify(other.id)};
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()`)
      await click(settings, 'Check startup', '检查启动')
      await waitView(settingsFrame, 'the selected Bot startup check screenshot')
      assert.equal(await running(scopedName(other.id)), 'false', 'The startup check must stop its selected test instance.')
      assert.equal(await running(container), 'false', 'A scoped startup check must not start the shared desktop.')
      assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), { idleMinutes: 480, privateMode: 'per-bot', maxInstances: 1, limits: { memoryGb: 2, cpus: 2 } })
      await closeSettings()
      await authorizePrivate()
      await waitView(frameReady, 'the second Bot desktop frame')
      const second = await assertScope(other.id)
      await runDocker('exec', second, 'sh', '-c', 'printf isolation > /home/cua/workspace/scope-check.txt')
      await switchBot(firstRow)
      await authorizePrivate()
      await click(pane, 'Refresh preview', '刷新预览')
      await waitView("/All private desktops|已达运行上限/.test(document.querySelector('.bt-computer [role=alert]')?.textContent ?? '')", 'the private desktop instance limit')
      await openSettings()
      await setLimit('2')
      await closeSettings()
      await click(pane, 'Refresh preview', '刷新预览')
      await waitView(frameReady, 'the first Bot desktop frame after increasing the limit')
      const first = await assertScope(state.mainBotId)
      assert.notEqual(first, second)
      await assert.rejects(runDocker('exec', first, 'test', '-e', '/home/cua/workspace/scope-check.txt'))
      await checkBotDesktop('per-bot')
      await checkTwoDesktops(first, second)
      await openSettings()
      await until(`!(${byText(settings, ['Stop desktops', '停止桌面'])})?.disabled`, 'running desktop inventory')
      const rows = '.bt-computer-settings .bt-computer-instance'
      const secondRow = `Array.from(document.querySelectorAll(${JSON.stringify(rows)})).find(row => row.querySelector('.bt-set-copy span')?.textContent === ${JSON.stringify(other.name)})`
      const secondStop = `(${secondRow})?.querySelector('button')`
      await until(`!!(${secondStop}) && !(${secondStop}).disabled`, 'the second Bot desktop in the inventory')
      await Promise.all([nativeButton(python, pid, ['Stop', '停止']), evaluate(`(${secondStop}).click()` )])
      await until(`/Desktop stopped|已停止/.test((${secondRow})?.innerText ?? '')`, 'the second Bot desktop stopped')
      assert.equal(await running(second), 'false')
      assert.equal(await running(first), 'true')
      assert.equal((await authorization(state.mainBotId)).target, 'private-desktop')
      assert.equal((await authorization(other.id)).target, undefined)
      const secondActions = `${secondRow}?.querySelectorAll('button')`
      const secondAction = label => `Array.from((${secondActions}) ?? []).find(button => ${JSON.stringify(label)}.includes(button.textContent.trim()))`
      const start = secondAction(['Start desktop', '启动桌面'])
      const restart = secondAction(['Restart desktop', '重启桌面'])
      await until(`!!(${start}) && !(${start}).disabled`, 'start button for the stopped desktop')
      await evaluate(`(${start}).click()`)
      await until(`!!(${restart}) && !(${restart}).disabled`, 'the second Bot desktop started from settings')
      assert.equal(await running(second), 'true', 'Start desktop must leave the selected instance running.')
      assert.deepEqual(await resourceLimits(second), [2, 2, 2])
      for (const [labels, value] of [[['Memory (GiB)', '内存（GiB）'], '3'], [['CPU cores', 'CPU 核数'], '1']]) {
        await evaluate(`(() => {
          const input = Array.from(document.querySelectorAll('.bt-computer-settings input')).find(input =>
            ${JSON.stringify(labels)}.includes(input.getAttribute('aria-label')));
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`)
      }
      await click(settings, 'Save resource limits', '保存资源限制')
      await waitSaved()
      assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')).limits, { memoryGb: 3, cpus: 1 })
      assert.deepEqual(await resourceLimits(second), [2, 2, 2], 'Saving limits must not interrupt a running desktop.')
      const beforeRestart = await startedAt(second)
      await evaluate(`(${restart}).click()`)
      await checkConfirmation("document.querySelector('.bt-computer-feedback .bt-computer-progress')")
      await nativeButton(python, pid, ['Restart', '重启'])
      await until(`!!(${restart}) && !(${restart}).disabled && /is running|正在运行/.test(document.querySelector('.bt-computer-settings [role=status]')?.textContent ?? '')`, 'the second Bot desktop restarted from settings')
      assert.notEqual(await startedAt(second), beforeRestart)
      assert.deepEqual(await resourceLimits(second), [3, 3, 1])
      assert.deepEqual(await resourceLimits(first), [2, 2, 2])
      console.log('check-packed: edited memory and CPU limits applied only when the selected desktop restarted')
      assert.equal((await authorization(state.mainBotId)).target, 'private-desktop')
      assert.equal((await runDocker('exec', second, 'cat', '/home/cua/workspace/scope-check.txt')).stdout.trim(), 'isolation')
      const beforePreview = await startedAt(second)
      const viewScreen = secondAction(['View screen', '查看屏幕'])
      await until(`!!(${viewScreen}) && !(${viewScreen}).disabled`, 'the selected instance preview button')
      await evaluate(`(${viewScreen}).click()`)
      await waitView(settingsFrame, 'the instance screenshot in settings')
      await capture(process.env.DS_BOT_PACKED_SETTINGS_SCREENSHOT)
      await click(settings, 'Hide screenshot', '隐藏截图')
      assert.equal(await running(second), 'true', 'Closing a screenshot must preserve the desktop.')
      assert.equal(await startedAt(second), beforePreview)
      assert.equal((await authorization(state.mainBotId)).target, 'private-desktop')
      console.log('check-packed: settings preview, start and restart preserved the workspace and the other Bot authorization')
      await Promise.all([nativeButton(python, pid, ['Stop', '停止']), click(settings, 'Stop desktops', '停止桌面')])
      await until("/stopped|已停止/.test(document.querySelector('.bt-computer-settings [role=status]')?.textContent ?? '')", 'private desktops stopped')
      assert.equal(await running(first), 'false')
      assert.equal(await running(second), 'false')
      assert.equal((await authorization(state.mainBotId)).target, undefined)
      await closeSettings()
      await switchBot(otherRow)
      await authorizePrivate()
      await waitView(frameReady, 'the restarted Bot desktop frame')
      assert.equal(await assertScope(other.id), second)
      assert.equal((await runDocker('exec', second, 'cat', '/home/cua/workspace/scope-check.txt')).stdout.trim(), 'isolation')
      console.log('check-packed: isolated Bot desktops respected the running limit and kept separate workspaces after stop and restart')
      await openSettings()
      const remove = secondAction(['Delete desktop', '删除桌面'])
      await until(`!!(${remove}) && !(${remove}).disabled`, 'delete button for the selected desktop')
      await Promise.all([nativeButton(python, pid, ['Cancel', '取消']), evaluate(`(${remove}).click()`)])
      await until(`!!(${remove}) && !(${remove}).disabled`, 'cancel deletion returned to the selected desktop')
      assert.equal(await running(second), 'true')
      assert.equal((await authorization(other.id)).target, 'private-desktop')

      await Promise.all([nativeButton(python, pid, ['Delete', '删除']), evaluate(`(${remove}).click()`)])
      await waitView(`!(${secondRow}) && /was deleted|已删除/.test(document.querySelector('.bt-computer-settings [role=status]')?.textContent ?? '')`, 'selected desktop removed from the inventory')
      await assert.rejects(running(second))
      assert.equal(await running(first), 'false')
      assert.equal((await authorization(other.id)).target, undefined)

      await closeSettings()
      await authorizePrivate()
      try {
        const target = scopedName(other.id)
        await until(`${frameReady} && ${byText(pane, privateLabels)}?.getAttribute('aria-pressed') === 'true'`, 'recreated Bot desktop frame', 75_000)
        const deadline = Date.now() + 25_000
        while (await running(target).catch(() => 'missing') !== 'true' && Date.now() < deadline) await sleep(250)
      } catch (error) {
        const target = scopedName(other.id)
        const paneState = await evaluate(`({ text: document.querySelector('.bt-computer')?.innerText,
          selected: document.querySelector('[data-bot-id][aria-current=page]')?.dataset.botId })`)
        const status = await authorization(other.id)
        const containerState = await running(target).catch(() => 'missing')
        throw new Error(`${error.message}: ${JSON.stringify({ paneState, status, containerState })}`, { cause: error })
      }
      const recreated = await assertScope(other.id)
      assert.notEqual(recreated, second)
      assert.equal((await runDocker('exec', recreated, 'cat', '/home/cua/workspace/scope-check.txt')).stdout.trim(), 'isolation')
      console.log('check-packed: cancel preserved the running instance; delete removed only its container, and recreation recovered its workspace')

      await checkPool()

      async function checkPool() {
        await openSettings()
        await click('.bt-computer-isolation button', 'Desktop pool', '桌面池')
        await waitSaved()
        await closeSettings()
        await evaluate(`${groupRow}.click()`)
        await openPane()
        await until(`(${allow})?.disabled && /Enable shared mode|开启共享|启用共享/.test(document.querySelector('.bt-computer-group-access')?.innerText ?? '')`,
          'group desktop access disabled in pool mode')
        await switchBot(firstRow)
        await authorizePrivate()
        await waitView(frameReady, 'the first pool desktop frame')
        const seatOne = await assertScope('pool-seat-1')
        await runDocker('exec', seatOne, 'sh', '-c', 'printf pool > /home/cua/workspace/pool-check.txt')
        await switchBot(otherRow)
        await authorizePrivate()
        await waitView(frameReady, 'the second pool desktop frame')
        const seatTwo = await assertScope('pool-seat-2')
        assert.notEqual(seatOne, seatTwo)
        const isolated = await runDocker('exec', seatTwo, 'sh', '-c', 'test ! -f /home/cua/workspace/pool-check.txt && printf isolated')
        assert.equal(isolated.stdout.trim(), 'isolated')
        await openSettings()
        await setLimit('1')
        assert.equal(await running(seatOne), 'false')
        assert.equal(await running(seatTwo), 'false')
        assert.equal((await authorization(other.id)).target, undefined)
        await closeSettings()
        await until(`${otherRow}?.getAttribute('aria-current') === 'page' && !(${screen})
          && (${byText(pane, ['Off', '关闭'])})?.getAttribute('aria-pressed') === 'true'`, 'the old pool authorization and preview to clear')
        try {
          await authorizePrivate()
          await waitFor(async () => (await authorization(other.id)).target === 'private-desktop',
            'the resized pool authorization for the selected Bot', 30_000)
          await waitView(`${frameReady} && ${otherRow}?.getAttribute('aria-current') === 'page'`,
            'the retained pool desktop after reducing the pool size')
        } catch (error) {
          const status = await authorization(other.id)
          const paneState = await evaluate(`({ text: document.querySelector('.bt-computer')?.innerText,
            selected: ${otherRow}?.getAttribute('aria-current'), frameWidth: ${screen}?.naturalWidth })`)
          const windows = await windowState('({ visible: win.isVisible(), minimized: win.isMinimized() })')
          throw new Error(`${error.message}: ${JSON.stringify({ status, paneState, windows,
            seatOneRunning: await running(seatOne), seatTwoRunning: await running(seatTwo) })}`, { cause: error })
        }
        assert.equal((await authorization(other.id)).target, 'private-desktop')
        onGrant(other.id)
        assert.equal(await assertScope('pool-seat-1'), seatOne)
        assert.equal((await runDocker('exec', seatOne, 'cat', '/home/cua/workspace/pool-check.txt')).stdout.trim(), 'pool')
        console.log('check-packed: pool mode assigned separate desktops, disabled group access, and retained workspace files after shrinking')
      }
    }
  }

  async function checkBrowser() {
    const { mainBotId } = await api('state', {})
    const row = `document.querySelector(${JSON.stringify(`[data-bot-id="${mainBotId}"]`)})`
    await until(`(() => {
      const button = ${row};
      if (button?.getAttribute('aria-current') === 'page') return true;
      button?.click();
      return false;
    })()`, 'the main Bot conversation')
    await openWorkTab('browser')
    const address = "document.querySelector('.bt-browser-address input')"
    const focusAddress = async () => {
      const hit = `(() => {
        const element = ${address};
        if (!element) return null;
        const box = element.getBoundingClientRect();
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        return document.elementFromPoint(point.x, point.y) === element ? point : null;
      })()`
      await until(hit, 'the address bar to settle', 10_000)
      const point = await evaluate(hit)
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.call('Input.dispatchMouseEvent', { ...point, type, button: 'left', clickCount: 1 })
      }
      await until(`document.activeElement === ${address} && document.hasFocus() &&
        ${address}.selectionStart === 0 && ${address}.selectionEnd === ${address}.value.length`,
      'the address bar to hold focus and select its contents', 10_000)
    }
    await focusAddress()
    const requested = Promise.withResolvers()
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<title>Embedded browser fixture</title><style>html{background:#164e63;color:white;font:20px system-ui}body{margin:24px}</style><h1>Embedded browser fixture</h1>')
      if (request.url === '/browser-fixture') requested.resolve(true)
    })
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      const url = `http://127.0.0.1:${server.address().port}/browser-fixture`
      await evaluate(`(() => {
        window.__addressTrace = [];
        const element = ${address};
        const snapshot = type => window.__addressTrace.push({ type, value: element.value,
          active: document.activeElement === element, focus: document.hasFocus(),
          start: element.selectionStart, end: element.selectionEnd });
        for (const type of ['focus', 'blur', 'beforeinput', 'input', 'change']) element.addEventListener(type, () => snapshot(type));
        snapshot('before');
      })()`)
      await cdp.call('Input.insertText', { text: url })
      try {
        await until(`${address}.value === ${JSON.stringify(url)}`, 'the complete fixture address', 10_000)
      } catch (error) {
        const trace = await evaluate(`({ events: window.__addressTrace, value: ${address}?.value,
          active: document.activeElement === ${address}, focus: document.hasFocus() })`)
        throw new Error(`${error.message}: ${JSON.stringify(trace)}`, { cause: error })
      }
      await press(cdp, 'Enter', 'Enter', 13)
      try {
        assert.ok(await Promise.race([requested.promise, sleep(10_000, false, { ref: false })]), 'The embedded browser did not load the fixture.')
        await until("Boolean(document.querySelector('.bt-browser-frame[data-guest]')?.offsetWidth)", 'the embedded browser view', 10_000)
      } catch (error) {
        const details = await evaluate(`({ address: ${address}?.value, body: document.querySelector('.bt-panel-browser')?.innerText, focused: document.hasFocus() })`)
        throw new Error(`${error.message}: ${JSON.stringify(details)}`, { cause: error })
      }
      if (process.platform === 'win32') {
        const expected = await evaluate(`(() => {
          const { left, top, width, height } = document.querySelector('.bt-browser-frame[data-guest]').getBoundingClientRect();
          return [left, top, width, height].map(value => Math.round(value));
        })()`)
        const native = await windowState(`(() => {
          const views = win.contentView.children.filter(view => view.webContents?.getURL() === ${JSON.stringify(url)});
          return {
            views: views.map(view => ({ bounds: view.getBounds(), visible: view.getVisible() })),
          };
        })()`)
        assert.equal(native.views.length, 1, 'The fixture must belong to exactly one native child view.')
        assert.equal(native.views[0].visible, true, 'The browser child view must be visible.')
        const { x, y, width, height } = native.views[0].bounds
        assert.deepEqual([x, y, width, height], expected, 'The native browser view must fill its app panel.')
        const fixtureState = await windowState(`(async () => {
          const view = win.contentView.children.find(view => view.webContents?.getURL() === ${JSON.stringify(url)});
          return view.webContents.executeJavaScript("({ title: document.title, background: getComputedStyle(document.documentElement).backgroundColor, devicePixelRatio, width: innerWidth, height: innerHeight })");
        })()`)
        assert.equal(fixtureState.background, 'rgb(22, 78, 99)', JSON.stringify(fixtureState))
        const points = await windowState(`(() => {
          const { screen } = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
          const { x, y } = win.getContentBounds();
          return [0.35, 0.55, 0.75].map(step => screen.dipToScreenPoint({
            x: Math.round(x + ${x} + ${width} * step), y: Math.round(y + ${y} + ${height} * step),
          }));
        })()`)
        const colors = Array.from({ length: 3 }, () => [22, 78, 99])
        let composed
        try {
          await windowState(`(() => { win.setAlwaysOnTop(true); win.focus(); })()`)
          await waitFor(async () => {
            composed = await windowsDisplayColors(python, points)
            return JSON.stringify(composed) === JSON.stringify(colors)
          }, 'the browser fixture pixels on the Windows display', 8_000)
        } catch (error) {
          const state = await windowState(`(() => {
            const view = win.contentView.children.find(view => view.webContents?.getURL() === ${JSON.stringify(url)});
            return { focused: win.isFocused(), view: view?.getBounds(), window: win.getBounds(), content: win.getContentBounds(), children: win.contentView.children.length };
          })()`)
          throw new Error(`${error.message} Windows sampled ${JSON.stringify(composed)} at ${JSON.stringify(points)}. ${JSON.stringify({ state, fixtureState })}`, { cause: error })
        } finally {
          await windowState('win.setAlwaysOnTop(false)')
        }
      }
      const takeover = '.bt-browser-takeover button'
      const access = "document.querySelector('.bt-browser-access [role=switch]')"
      await click(takeover, 'Take over', '接管')
      await until(byText(takeover, ['Give back', '交还']), 'browser control handed to the user')
      const chrome = '.bt-browser-display-controls'
      const browserControl = labels => `Array.from(document.querySelectorAll('${chrome} button')).find(button =>
        ${JSON.stringify(labels)}.includes(button.getAttribute('aria-label')))`
      const displayButton = async (...labels) => {
        const expression = `(() => {
          const button = ${browserControl(labels)};
          if (!button) return null;
          const box = button.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          return button.contains(document.elementFromPoint(x, y)) ? {x, y} : null;
        })()`
        await until(expression, labels[0], 10_000)
        const point = await evaluate(expression)
        for (const type of ['mousePressed', 'mouseReleased']) {
          await cdp.call('Input.dispatchMouseEvent', { ...point, type, button: 'left', clickCount: 1 })
        }
      }
      const normalWidth = await evaluate("document.querySelector('.bt-browser-frame').offsetWidth")
      const checkBounds = async label => {
        const getRect = "document.querySelector('.bt-browser-frame').getBoundingClientRect().toJSON()"
        await waitFor(async () => {
          const expected = await evaluate(getRect)
          const actual = await windowState(`win.contentView.children.find(view => view.webContents?.getURL() === ${JSON.stringify(url)})?.getBounds()`)
          return actual != null && ['x', 'y', 'width', 'height'].every(key => Math.abs(actual[key] - expected[key]) <= 2)
        }, label, 10_000)
      }
      await displayButton('Maximize browser panel', '放大浏览器面板')
      await until(`document.querySelector('.bt-panel[data-maximized]') && document.querySelector('.bt-browser-frame').offsetWidth > ${normalWidth}`, 'expanded browser')
      await checkBounds('the native browser bounds after maximizing')
      await displayButton('Full screen', '全屏')
      await until("document.fullscreenElement?.classList.contains('bt-panel-browser')", 'the browser entering full screen', 10_000)
      await checkBounds('the native browser bounds in full screen')
      await until(byText(takeover, ['Give back', '交还']), 'browser takeover in full screen')
      await displayButton('Exit full screen', '退出全屏')
      await until("!document.fullscreenElement && document.querySelector('.bt-panel[data-maximized]')", 'the browser returning to the maximized panel', 10_000)
      await displayButton('Restore browser panel', '还原浏览器面板')
      await until(`!document.querySelector('.bt-panel[data-maximized]') && document.querySelector('.bt-browser-frame').offsetWidth === ${normalWidth}`, 'the original browser panel width')
      await checkBounds('the native browser bounds after restoring')
      console.log('check-packed: browser maximized, entered full screen, and restored with matching native view bounds and takeover')
      await openWorkTab('routines')
      await openWorkTab('browser')
      await until(byText(takeover, ['Give back', '交还']), 'browser takeover survives a panel tab switch')
      await click(takeover, 'Give back', '交还')
      await until(byText(takeover, ['Take over', '接管']), 'browser control returned to the Bot')
      await evaluate("document.querySelector('.bt-work-head > button:first-child').click()")
      const settingsAccess = "document.querySelector('.bt-browser-settings [role=switch]')"
      await until(`${settingsAccess}?.getAttribute('aria-checked') === 'true'`, 'browser access in settings')
      await evaluate(`${settingsAccess}.click()`)
      await until(`${settingsAccess}?.getAttribute('aria-checked') === 'false'`, 'browser permission switched off in settings')
      await evaluate("document.querySelector('.bt-settings-close').click()")
      await until(`!document.querySelector('.bt-settings-layer') && ${access}?.getAttribute('aria-checked') === 'false'`, 'browser panel follows the saved access setting')
      await api('send', { sessionId: mainBotId, text: '看网页结构' })
      await until("document.body.innerText.includes('The user has disabled browser access for this Bot.')", 'the browser tool rejects the Bot while access is disabled', 60_000)
      const secondUrl = `${url}?manual=1`
      await focusAddress()
      await cdp.call('Input.insertText', { text: secondUrl })
      await until(`${address}.value === ${JSON.stringify(secondUrl)}`, 'the user can enter a new address with access disabled')
      await press(cdp, 'Enter', 'Enter', 13)
      await waitFor(() => windowState(`win.contentView.children.some(view => view.webContents?.getURL() === ${JSON.stringify(secondUrl)})`), 'manual navigation with Bot access disabled', 10_000)
      await evaluate(`${access}.click()`)
      await until(`${access}?.getAttribute('aria-checked') === 'true'`, 'browser access restored in the panel')
      await evaluate("document.querySelector('.bt-work-head > button:first-child').click()")
      await until(`${settingsAccess}?.getAttribute('aria-checked') === 'true'`, 'browser settings follow the panel switch')
      await evaluate("document.querySelector('.bt-settings-close').click()")
      await until("!document.querySelector('.bt-settings-layer')", 'browser settings closed')
      console.log('check-packed: native browser takeover, give-back, and per-Bot access worked from the panel and settings')
    } finally { server.closeAllConnections(); server.close() }
    console.log(process.platform === 'win32' ? 'check-packed: the app window displayed the browser fixture pixels' : 'check-packed: the embedded browser loaded the fixture')
  }
}

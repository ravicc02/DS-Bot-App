import { fileURLToPath } from 'node:url'

const page = new URL('./viewer.html', import.meta.url)
const preload = fileURLToPath(new URL('./viewer-preload.cjs', import.meta.url))

export function computerViewer({ ipcMain, BrowserWindow, computer, zh }) {
  let active

  function close(conversation) {
    const entry = active
    if (!entry || (conversation !== undefined && conversation !== entry.conversation)) return
    active = undefined
    void computer.local(entry.conversation, 'hand-back', undefined, entry.binding).catch(() => {})
    if (!entry.win.isDestroyed()) entry.win.destroy()
  }

  ipcMain.handle('ds-bot:computer-viewer', (event, op, input) => {
    const entry = active
    if (!entry || event.sender !== entry.win.webContents || event.senderFrame !== event.sender.mainFrame
      || event.senderFrame.url !== page.href
      || !['status', 'take', 'hand-back', 'observe', 'input'].includes(op)) {
      throw new Error('The desktop viewer is no longer available.')
    }
    if (op === 'hand-back') entry.revision += 1
    const revision = entry.revision
    const current = () => active === entry && revision === entry.revision
    return computer.local(entry.conversation, op, input, entry.binding).then(result => current() ? result : {}, error => {
      if (current()) throw error
      return {}
    })
  })

  async function open(conversation, parent) {
    if (parent.isDestroyed() || !parent.isVisible()) throw new Error('Select the private desktop first.')
    const binding = computer.viewerBinding(conversation)
    if (active?.conversation === conversation && active.binding === binding) { active.win.focus(); return }
    close()
    const win = new BrowserWindow({
      parent, title: zh ? '私有桌面' : 'Private desktop', width: 1080, height: 810,
      minWidth: 520, minHeight: 400, show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true, webviewTag: false,
        additionalArguments: zh ? ['--ds-bot-viewer-zh'] : [] },
    })
    const entry = { win, conversation, binding, revision: 0 }
    active = entry
    const disconnected = () => { if (active === entry) close() }
    win.on('closed', disconnected)
    win.webContents.on('render-process-gone', disconnected)
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.webContents.on('did-start-navigation', event => {
      if (event.isMainFrame && !event.isSameDocument && entry.loaded) disconnected()
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    try {
      await win.loadURL(page.href)
      entry.loaded = true
      if (active === entry && !win.isDestroyed()) win.show()
    } catch (error) { disconnected(); throw error }
  }

  return { open, close }
}

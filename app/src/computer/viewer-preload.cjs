const { ipcRenderer, contextBridge } = require('electron')

contextBridge.exposeInMainWorld('desktopViewer', {
  zh: process.argv.includes('--ds-bot-viewer-zh'),
  call: (op, input) => ipcRenderer.invoke('ds-bot:computer-viewer', op, input),
})

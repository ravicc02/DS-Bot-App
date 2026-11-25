const bridge = window.desktopViewer
const element = id => document.getElementById(id)
const text = (en, zh) => bridge.zh ? zh : en
const screen = element('screen')
const refresh = element('refresh')
const take = element('take')
const handBack = element('hand-back')
const error = element('error')
const LABELS = {
  idle: text('Ready to view', '可以观看'), viewer: text('Refreshing', '刷新中'),
  user: text('You have control', '你正在操控'), bot: text('Bot has control', 'Bot 正在操控'),
  busy: text('Another conversation is using this desktop', '另一个会话正在使用桌面'),
  stopping: text('Releasing control', '正在交还控制权'), unavailable: text('Unavailable', '不可用'),
}
let work
let state = {}
let lastFrame
let generation = 0

document.documentElement.lang = text('en', 'zh-CN')
document.title = text('Private desktop', '私有桌面')
refresh.textContent = text('Refresh', '刷新')
take.textContent = text('Take control', '接管')
handBack.textContent = text('Hand back', '交还')
screen.alt = text('Private desktop screenshot', '私有桌面截图')

function render() {
  if (!state.target) lastFrame = undefined
  else if (state.preview) lastFrame = state.preview
  const enabled = state.status === 'user' && !!state.preview
  const status = LABELS[state.status] ?? LABELS.unavailable
  element('status').textContent = work === 'observe' && !lastFrame
    ? text('Loading desktop…', '正在加载桌面…')
    : lastFrame && !state.preview ? `${status} · ${text('Last screenshot', '上一张截图')}` : status
  refresh.disabled = !!work || !state.target || ['busy', 'stopping', 'unavailable'].includes(state.status)
  take.disabled = !!work || !state.target || !['idle', 'bot'].includes(state.status)
  handBack.disabled = state.status !== 'user' && work !== 'take'
  screen.toggleAttribute('data-active', enabled)
  screen.tabIndex = enabled ? 0 : -1
  screen.hidden = !lastFrame
  if (!lastFrame) screen.removeAttribute('src')
  else {
    const url = `data:${lastFrame.mediaType};base64,${lastFrame.data}`
    if (screen.getAttribute('src') !== url) screen.src = url
  }
}

async function run(op, action) {
  if (work && op !== 'hand-back') return
  const current = ++generation
  work = op
  if (op !== 'status') error.hidden = true
  render()
  try {
    const result = await bridge.call(op, action)
    if (generation !== current) return
    state = result
  } catch (failure) {
    if (generation !== current) return
    error.textContent = failure.message.replace(/^Error invoking remote method '[^']+': Error: /u, '')
    error.hidden = false
    const currentState = await bridge.call('status').catch(() => ({}))
    if (generation === current) state = currentState
  } finally {
    if (generation === current) { work = undefined; render() }
  }
  if (generation === current && ['take', 'input'].includes(op) && state.status === 'user') {
    await run('observe')
    if (op === 'take' && state.status === 'user') screen.focus()
  }
  if (generation === current && op === 'hand-back' && state.status === 'idle') await run('observe')
}

refresh.onclick = () => void run('observe')
take.onclick = () => void run('take')
handBack.onclick = () => void run('hand-back')
function point(event) {
  const bounds = screen.getBoundingClientRect()
  return {
    x: Math.floor((event.clientX - bounds.left) * screen.naturalWidth / bounds.width),
    y: Math.floor((event.clientY - bounds.top) * screen.naturalHeight / bounds.height),
  }
}
const canInput = () => !work && state.status === 'user' && !!state.preview && screen.complete && screen.naturalWidth > 0
screen.addEventListener('click', event => { if (canInput()) void run('input', { kind: 'click', ...point(event) }) })
screen.addEventListener('wheel', event => {
  event.preventDefault()
  if (canInput() && event.deltaY) void run('input', { kind: 'scroll', ...point(event), direction: event.deltaY > 0 ? 'down' : 'up', amount: 1 })
}, { passive: false })
const keys = { Enter: 'return', Tab: 'tab', Escape: 'escape', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  ' ': 'space', Backspace: 'backspace', Delete: 'delete', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown' }
screen.addEventListener('keydown', event => {
  if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing || state.status !== 'user') return
  const key = keys[event.key]
  if (!key && [...event.key].length !== 1) return
  if (event.key === 'Tab' && event.shiftKey) return
  event.preventDefault()
  if (canInput()) void run('input', key ? { kind: 'key', key } : { kind: 'type', text: event.key })
})
void run('observe')
setInterval(() => { if (!work) void run(state.status === 'user' ? 'observe' : 'status') }, 1800)

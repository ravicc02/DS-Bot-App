// Workspace pane selection and hand-back ordering adapted from OpenMausBot (see NOTICE).
import { createElement as h, useEffect, useRef, useState } from 'react'
import { LiveDesktop } from './computer-live.js'
import { computerError } from './computer-error.js'
import { CloseIcon } from './icons.js'
import { t } from './i18n.js'

function Watching({ bridge, id, index }) {
  const [state, setState] = useState({})
  useEffect(() => {
    let active = true
    let timer
    async function update() {
      let delay = 1500
      try {
        const frame = await bridge.workspace('frame', id, index)
        if (active) setState({ frame })
      } catch (failure) {
        if (active) setState({ error: computerError(failure) })
        delay = 5000
      }
      if (active) timer = setTimeout(update, delay)
    }
    void update()
    return () => { active = false; clearTimeout(timer) }
  }, [bridge, id, index])
  const { frame, error } = state
  return frame
    ? h('img', { className: 'bt-computer-preview', draggable: false, alt: t('Desktop screenshot'), src: `data:${frame.mediaType};base64,${frame.data}` })
    : h('div', { className: 'bt-computer-empty', role: error ? 'alert' : 'status' }, error || t('Connecting to desktop…'))
}

export function DesktopWorkspace({ bridge, bots, primary, onClose }) {
  const dialog = useRef(null)
  const active = useRef(null)
  const busy = useRef(false)
  const [entries, setEntries] = useState(null)
  const [panes, setPanes] = useState(null)
  const [held, setHeld] = useState(null)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const node = dialog.current
    node.showModal()
    return () => node.close()
  }, [])

  useEffect(() => {
    let mounted = true
    void (async () => {
      const inventory = await bridge.settings('inventory', bots.map(bot => bot.id))
      if (!mounted) return
      const running = inventory.filter(entry => entry.running && entry.botId)
      const list = running.map(({ botId: operator, id }) => ({ operator, id }))
      const first = list.find(entry => entry.operator === primary) ?? list[0]
      const second = list.find(entry => entry !== first)
      setEntries(list)
      if (second) await open([first, second])
    })().catch(failure => { if (mounted) setError(computerError(failure)) }).finally(() => { if (mounted) setPending(false) })
    const unsubscribe = bridge.onWindowShown?.(shown => { if (!shown) onClose() })
    return () => {
      mounted = false
      unsubscribe?.()
      const id = active.current
      active.current = null
      if (id) void bridge.workspace('close', id).catch(() => {})
    }
  }, [bridge])

  async function open(selection) {
    const id = globalThis.crypto.randomUUID()
    active.current = id
    try {
      await bridge.workspace('open', id, selection)
      if (active.current === id) setPanes({ id, selection })
      else await bridge.workspace('close', id)
    } catch (failure) {
      if (active.current === id) active.current = null
      throw failure
    }
  }

  async function run(action) {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError('')
    try { await action() } catch (failure) { setError(computerError(failure)) }
    finally { busy.current = false; setPending(false) }
  }

  async function release() {
    if (!held) return
    setHeld(null)
    await bridge.workspace('hand-back', panes.id, held.index)
  }

  function take(index) {
    void run(async () => {
      await release()
      const binding = await bridge.workspace('take', panes.id, index)
      if (active.current === panes.id) setHeld({ ...binding, index })
    })
  }

  function select(index, operator) {
    const selection = [...panes.selection]
    const other = 1 - index
    if (selection[other].operator === operator) selection[other] = selection[index]
    selection[index] = entries.find(entry => entry.operator === operator)
    void run(async () => {
      await bridge.workspace('close', panes.id)
      if (active.current !== panes.id) return
      setHeld(null)
      setPanes(null)
      await open(selection)
    })
  }

  function close() {
    if (pending) return
    void run(async () => {
      if (active.current) await bridge.workspace('close', active.current)
      active.current = null
      onClose()
    })
  }

  const name = operator => bots.find(bot => bot.id === operator)?.name ?? t('Former Bot')
  return h('dialog', { ref: dialog, className: 'bt-computer-workspace', 'aria-labelledby': 'bt-desktop-workspace-title',
    onCancel: event => { event.preventDefault(); close() }, onKeyDown: event => { if (event.key === 'Escape') event.stopPropagation() } },
  h('header', null, h('h3', { id: 'bt-desktop-workspace-title' }, t('Two desktops')),
    h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), disabled: pending, onClick: close }, h(CloseIcon))),
  error ? h('p', { className: 'bt-error', role: 'alert' }, error) : null,
  panes ? h('div', { className: 'bt-computer-workspace-grid' }, panes.selection.map(({ operator }, index) => {
    const controlling = held?.index === index
    return h('section', { key: `${panes.id}-${index}`, 'data-desktop-pane': index + 1, 'aria-label': name(operator) },
      h('header', null, h('select', { className: 'bt-select', value: operator, disabled: pending,
        'aria-label': t('Desktop {number}', { number: index + 1 }), onChange: event => select(index, event.target.value) },
      entries.map(entry => h('option', { key: entry.operator, value: entry.operator }, name(entry.operator)))),
      h('button', { type: 'button', className: 'bt-browser-retry', disabled: pending, onClick: controlling ? () => void run(release) : () => take(index) },
        t(controlling ? 'Hand back' : 'Take control'))),
      h('div', { className: 'bt-computer-viewport', 'data-takeover': controlling || undefined }, controlling
        ? h(LiveDesktop, { bridge, conversation: held.conversation, display: held.display, onDisconnect: () => {
          if (!busy.current) void run(async () => { await release(); setError(t('Desktop disconnected. Take control to reconnect.')) })
        } }) : h(Watching, { bridge, id: panes.id, index })))
  })) : !error ? h('div', { className: 'bt-computer-workspace-message', role: 'status' },
    t(pending ? 'Loading desktops…' : 'Start two Bot desktops to view them here.')) : null)
}

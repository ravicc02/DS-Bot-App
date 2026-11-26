// Desktop focus, keyboard controls and clipboard adapted from OpenMausBot (see NOTICE).
import { Fragment, createElement as h, useId, useLayoutEffect, useRef, useState } from 'react'
import loadRfb from 'ds-bot-desktop-client'
import { t } from './i18n.js'
import { ChevronLeftIcon, ChevronRightIcon } from './icons.js'

function desktopChannel(bridge, conversation, display) {
  let transport
  const channel = {
    readyState: 'connecting', protocol: '', binaryType: 'arraybuffer',
    onopen: null, onclose: null, onerror: null, onmessage: null,
    send(data) {
      if (channel.readyState !== 'open') return
      for (let offset = 0; offset < data.length; offset += 64 * 1024) {
        transport.send(data.slice(offset, offset + 64 * 1024))
      }
    },
    close() {
      if (channel.readyState === 'closed') return
      channel.readyState = 'closed'
      transport?.close()
      queueMicrotask(() => channel.onclose?.({ code: 1000, reason: '' }))
    },
  }
  transport = bridge.live(conversation, display, bytes => {
    if (channel.readyState === 'closed') return
    if (channel.readyState === 'connecting') {
      channel.readyState = 'open'
      channel.onopen?.()
    }
    channel.onmessage?.({ data: bytes })
  }, () => channel.close())
  return channel
}

const CLIPBOARD_LIMIT = 65_536
const KEYBOARD_LIMIT = 4096
const controlKeys = { ControlLeft: 0xffe3, ControlRight: 0xffe4 }
const commandKeys = { MetaLeft: 0xffe9, MetaRight: 0xffeb }

function pasteOnDesktop(client, text, held) {
  client.clipboardPasteFrom(text)
  const ctrl = Object.hasOwn(controlKeys, held) ? held : 'ControlLeft'
  client.sendKey(controlKeys[ctrl], ctrl, true)
  if (Object.hasOwn(commandKeys, held)) client.sendKey(commandKeys[held], held, false)
  client.sendKey(0x76, 'KeyV')
  if (ctrl !== held) client.sendKey(controlKeys[ctrl], ctrl, false)
}

function forwardPaste(screen, client, signal, setClipboard) {
  const mac = /Mac/u.test(navigator.platform)
  const modifiers = mac ? commandKeys : controlKeys
  let held
  screen.addEventListener('keydown', event => {
    if (Object.hasOwn(modifiers, event.code)) held = event.code
    const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    const key = event.key.toLowerCase()
    if (modifier && !event.altKey && !event.shiftKey && (key === 'v' || (event.code === 'KeyV' && !/^[a-z]$/u.test(key)))) event.stopPropagation()
  }, { capture: true, signal })
  screen.addEventListener('keyup', event => { if (event.code === held) held = undefined }, { capture: true, signal })
  screen.addEventListener('focusout', () => { held = undefined }, { signal })
  screen.addEventListener('paste', event => {
    event.preventDefault()
    const text = event.clipboardData?.getData('text/plain')
    if (!text) return
    const value = text.slice(0, CLIPBOARD_LIMIT)
    setClipboard(value)
    pasteOnDesktop(client, value, held)
  }, { signal })
}

function typeOnDesktop(client, text) {
  for (const char of text) {
    const code = char.codePointAt(0)
    client.sendKey(code === 10 ? 0xff0d : code === 9 ? 0xff09 : code <= 255 ? code : 0x01000000 | code, null)
  }
}

export function LiveDesktop({ bridge, conversation, display, onDisconnect, renderToolbar }) {
  const screen = useRef(null)
  const inputClient = useRef(null)
  const disconnected = useRef(onDisconnect)
  disconnected.current = onDisconnect
  const [connected, setConnected] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const [panel, setPanel] = useState(null)
  const [text, setText] = useState('')
  const [clipboard, setClipboard] = useState('')
  const [copyStatus, setCopyStatus] = useState('')
  const panelId = useId()
  const editor = useRef(null)
  useLayoutEffect(() => {
    if (panel) editor.current?.focus({ preventScroll: true })
  }, [panel])
  useLayoutEffect(() => {
    setConnected(false)
    setExpanded(true)
    setPanel(null)
    setText('')
    setClipboard('')
    setCopyStatus('')
    const controller = new AbortController()
    const { signal } = controller
    const element = screen.current
    let channel
    let client
    const lost = event => {
      if (signal.aborted) return
      inputClient.current = null
      setConnected(false)
      setPanel(null)
      setText('')
      setClipboard('')
      setCopyStatus('')
      controller.abort()
      clearTimeout(deadline)
      if (event?.type !== 'disconnect') client?.disconnect()
      channel?.close()
      disconnected.current()
    }
    const deadline = setTimeout(lost, 30_000)
    void loadRfb().then(RFB => {
      if (signal.aborted) return
      channel = desktopChannel(bridge, conversation, display)
      client = new RFB(element, channel)
      client.scaleViewport = true
      client.background = 'var(--bt-main)'
      client.addEventListener('connect', () => {
        clearTimeout(deadline)
        inputClient.current = client
        setConnected(true)
        client.focus({ preventScroll: true })
      }, { once: true })
      client.addEventListener('disconnect', lost, { once: true })
      client.addEventListener('clipboard', event => {
        if (signal.aborted) return
        setClipboard(event.detail.text.slice(0, CLIPBOARD_LIMIT))
        setCopyStatus('')
      })
      forwardPaste(element, client, signal, text => {
        setClipboard(text)
        setCopyStatus('')
      })
      element.closest('.bt-computer-viewport')?.addEventListener('fullscreenchange', event => {
        if (event.target === event.currentTarget) inputClient.current?.focus({ preventScroll: true })
      }, { signal })
    }).catch(() => lost())
    return () => {
      inputClient.current = null
      if (signal.aborted) return
      controller.abort()
      clearTimeout(deadline)
      client?.disconnect()
      channel?.close()
    }
  }, [bridge, conversation, display])
  const sendText = connected ? text => {
    const client = inputClient.current
    if (!client) return false
    typeOnDesktop(client, text)
    client.focus({ preventScroll: true })
    return true
  } : undefined
  const closePanel = () => {
    setPanel(null)
    inputClient.current?.focus({ preventScroll: true })
  }
  const togglePanel = next => {
    if (panel === next) closePanel()
    else setPanel(next)
  }
  const sendKey = action => {
    const client = inputClient.current
    if (!client) return
    action(client)
    closePanel()
  }
  const writeClipboard = text => {
    const client = inputClient.current
    if (!client) return
    setClipboard(text)
    setCopyStatus('')
    client.clipboardPasteFrom(text)
  }
  const copyClipboard = async () => {
    const client = inputClient.current
    if (!client || !clipboard) return
    try {
      await navigator.clipboard.writeText(clipboard)
      if (inputClient.current === client) setCopyStatus('Copied')
    } catch {
      if (inputClient.current === client) setCopyStatus('Select the text and copy it manually.')
    }
  }
  const button = (label, onClick, props, content = t(label)) => h('button', {
    type: 'button', className: 'bt-browser-retry', onClick, ...props,
  }, content)
  const panelButton = (name, label) => button(label, () => togglePanel(name), {
    'aria-expanded': panel === name, 'aria-controls': panel === name ? panelId : undefined,
  })
  const toolbarLabel = expanded ? 'Hide desktop controls' : 'Show desktop controls'
  const keyboard = h('form', { onSubmit: event => {
    event.preventDefault()
    if (text && sendText?.(text)) {
      setText('')
      closePanel()
    }
  } },
  h('textarea', { ref: editor, 'aria-label': t('Text to type on desktop'), rows: 3, maxLength: KEYBOARD_LIMIT,
    autoComplete: 'off', autoCapitalize: 'off', spellCheck: false, value: text,
    onChange: event => setText(event.target.value) }),
  h('div', { className: 'bt-computer-actions' },
    h('button', { type: 'submit', className: 'bt-browser-retry', disabled: !text }, t('Send to desktop')),
    button('Tab', () => sendKey(client => client.sendKey(0xff09, 'Tab'))),
    button('Esc', () => sendKey(client => client.sendKey(0xff1b, 'Escape'))),
    button('Ctrl+Alt+Del', () => sendKey(client => client.sendCtrlAltDel()))))
  const clipboardTools = h(Fragment, null,
    h('textarea', { ref: editor, 'aria-label': t('Desktop clipboard'), rows: 4, maxLength: CLIPBOARD_LIMIT,
      autoComplete: 'off', autoCapitalize: 'off', spellCheck: false, value: clipboard,
      onChange: event => writeClipboard(event.target.value) }),
    h('div', { className: 'bt-computer-actions' },
      button('Copy', copyClipboard, { disabled: !clipboard }),
      button('Paste on desktop', () => sendKey(client => pasteOnDesktop(client, clipboard)), { disabled: !clipboard }),
      button('Clear clipboard', () => writeClipboard(''), { disabled: !clipboard })),
    copyStatus ? h('span', { role: 'status' }, t(copyStatus)) : null)
  return h(Fragment, null, renderToolbar?.(sendText),
    h('div', { className: 'bt-computer-live', 'data-connected': connected || undefined },
      h('div', { ref: screen, className: 'bt-computer-live-screen', role: 'application', 'aria-label': t('Private desktop') }),
      connected ? h('div', { className: 'bt-computer-live-controls' },
        h('div', { className: 'bt-computer-live-rail', role: 'group', 'aria-label': t('Desktop controls') },
          button(toolbarLabel, () => {
            if (panel) closePanel()
            setExpanded(!expanded)
          }, { 'aria-label': t(toolbarLabel), title: t(toolbarLabel), 'aria-expanded': expanded },
          h(expanded ? ChevronLeftIcon : ChevronRightIcon)),
          expanded ? panelButton('keyboard', 'Keyboard') : null,
          expanded ? panelButton('clipboard', 'Clipboard') : null),
        panel ? h('div', { id: panelId, className: `bt-computer-live-panel bt-computer-${panel}-panel`, role: 'group',
          'aria-label': t(panel === 'keyboard' ? 'Keyboard' : 'Desktop clipboard'), onKeyDown: event => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            closePanel()
          } }, panel === 'keyboard' ? keyboard : clipboardTools) : null)
        : h('div', { className: 'bt-computer-live-connecting', role: 'status' }, t('Connecting to desktop…'))))
}

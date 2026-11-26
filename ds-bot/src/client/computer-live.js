// Desktop focus and clipboard handling adapted from OpenMausBot (see NOTICE).
import { createElement as h, useLayoutEffect, useRef, useState } from 'react'
import loadRfb from 'ds-bot-desktop-client'
import { t } from './i18n.js'

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

const controlKeys = { ControlLeft: 0xffe3, ControlRight: 0xffe4 }
const commandKeys = { MetaLeft: 0xffe9, MetaRight: 0xffeb }

function forwardPaste(screen, client, signal) {
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
    client.clipboardPasteFrom(text)
    const ctrl = Object.hasOwn(controlKeys, held) ? held : 'ControlLeft'
    client.sendKey(controlKeys[ctrl], ctrl, true)
    if (Object.hasOwn(commandKeys, held)) client.sendKey(commandKeys[held], held, false)
    client.sendKey(0x76, 'KeyV')
    if (ctrl !== held) client.sendKey(controlKeys[ctrl], ctrl, false)
  }, { signal })
}

export function LiveDesktop({ bridge, conversation, display, onDisconnect }) {
  const screen = useRef(null)
  const disconnected = useRef(onDisconnect)
  disconnected.current = onDisconnect
  const [connected, setConnected] = useState(false)
  useLayoutEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    const element = screen.current
    let channel
    let client
    const lost = event => {
      if (signal.aborted) return
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
        setConnected(true)
        client.focus({ preventScroll: true })
      }, { once: true })
      client.addEventListener('disconnect', lost, { once: true })
      forwardPaste(element, client, signal)
    }).catch(() => lost())
    return () => {
      if (signal.aborted) return
      controller.abort()
      clearTimeout(deadline)
      client?.disconnect()
      channel?.close()
    }
  }, [bridge, conversation, display])
  return h('div', { className: 'bt-computer-live', 'data-connected': connected || undefined },
    h('div', { ref: screen, className: 'bt-computer-live-screen', role: 'application', 'aria-label': t('Private desktop') }),
    connected ? null : h('div', { className: 'bt-computer-live-connecting', role: 'status' }, t('Connecting to desktop…')))
}

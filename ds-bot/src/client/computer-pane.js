import { createElement as h, useLayoutEffect, useRef, useState } from 'react'
import { LiveDesktop } from './computer-live.js'
import { DesktopWorkspace } from './computer-workspace.js'
import { call } from './api.js'
import { computerError } from './computer-error.js'
import { t } from './i18n.js'
import { AutoLocationIcon, LocalDesktopIcon, PowerIcon, PrivateDesktopIcon } from './icons.js'

const PLACES = [
  { id: 'auto', label: 'Automatic', Icon: AutoLocationIcon },
  { id: 'private', label: 'Private desktop', target: 'private-desktop', Icon: PrivateDesktopIcon },
  { id: 'local', label: 'This computer', target: 'local-desktop', Icon: LocalDesktopIcon },
  { id: 'off', label: 'Off', Icon: PowerIcon },
]
const STATE = {
  idle: 'Ready', bot: 'Bot has control', user: 'You have control', viewer: 'Refreshing',
  busy: 'In use by another conversation', stopping: 'Releasing control', unavailable: 'Unavailable',
}
const OBSERVABLE = ['idle', 'user']
const PREVIEW_INTERVAL = 3000
const PREVIEW_RETRY_INTERVAL = 5000

function DesktopTextEntry({ sendText }) {
  const [text, setText] = useState('')
  return h('form', { className: 'bt-computer-text-entry', onSubmit: event => {
    event.preventDefault()
    if (text && sendText?.(text)) setText('')
  } },
  h('input', { type: 'text', value: text, maxLength: 4096, autoComplete: 'off', autoCapitalize: 'off', spellCheck: false,
    'aria-label': t('Text to type on desktop'), placeholder: t('Text to type on desktop'),
    onChange: event => setText(event.target.value) }),
  h('button', { type: 'submit', className: 'bt-browser-retry', disabled: !sendText || !text }, t('Send to desktop')))
}

export function ComputerScreen({ subject, conversation, members, bots, name, openSettings }) {
  const bridge = window.dsBotApp?.computer
  const [state, setState] = useState({})
  const group = Array.isArray(members)
  const operator = group ? undefined : subject
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [place, setPlace] = useState(null)
  const [workspace, setWorkspace] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const display = useRef()
  const lifetime = useRef()
  const viewport = useRef(null)

  useLayoutEffect(() => {
    const changed = () => setFullscreen(Boolean(viewport.current && viewport.current === document.fullscreenElement))
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])

  function showWorkspace(open) {
    if (lifetime.current) lifetime.current.workspace = open
    setWorkspace(open)
  }

  function show(value) {
    if (display.current !== value.display) setPreviewError('')
    display.current = value.display
    setState(previous => ({ ...value, lastFrame: value.preview ?? value.lastPreview ?? (previous.display === value.display && value.display ? previous.lastFrame : undefined) }))
  }

  async function refreshPreview(value, current, force = false) {
    const idle = value.status === 'idle' && !value.waiting
    const localTakeover = value.target === 'local-desktop' && value.status === 'user'
    if (!value.display || (!idle && !localTakeover)) return
    const scope = lifetime.current
    const schedule = scope.preview
    if (!force && schedule?.display === value.display && performance.now() < schedule.after) return

    let delay = PREVIEW_INTERVAL
    const sameDisplay = () => current() && display.current === value.display
    try {
      const frame = await bridge.view(conversation, 'observe', undefined, value.display)
      if (!frame || !sameDisplay()) return
      show(frame)
      if (frame.preview) setPreviewError('')
    } catch (failure) {
      delay = PREVIEW_RETRY_INTERVAL
      if (sameDisplay()) setPreviewError(computerError(failure))
    } finally {
      if (sameDisplay()) scope.preview = { display: value.display, after: performance.now() + delay }
    }
  }

  useLayoutEffect(() => {
    if (!bridge) return undefined
    const scope = { active: true, work: null, next: null }
    lifetime.current = scope
    display.current = undefined
    const refresh = () => {
      if (scope.work || !scope.shown) return
      void run('poll', async current => {
        const value = await bridge.view(conversation, 'status')
        if (!current()) return
        show(value)
        setError(previous => previous === t('Restore the app window to use computer control.') ? '' : previous)
        if (!scope.workspace) await refreshPreview(value, current)
      })
    }
    const visibility = shown => {
      if (!scope.active || scope.shown === shown) return
      scope.shown = shown
      if (shown) { refresh(); return }
      scope.work = null
      scope.next = null
      scope.preview = undefined
      setPending('')
      setPlace(null)
      setError('')
      display.current = undefined
      setPreviewError('')
      setState(previous => ({ privateMode: previous.privateMode }))
    }
    const documentVisibility = () => visibility(!document.hidden)
    let unsubscribe
    // An occluded Chromium page may report hidden even though its app window is still shown.
    if (bridge.onWindowShown && bridge.windowShown) {
      unsubscribe = bridge.onWindowShown(visibility)
      void bridge.windowShown().then(shown => {
        if (scope.shown === undefined) visibility(shown)
      }, () => {
        if (scope.shown === undefined) visibility(true)
      })
    } else {
      document.addEventListener('visibilitychange', documentVisibility)
      documentVisibility()
    }
    const timer = setInterval(refresh, 1500)
    return () => {
      scope.active = false
      clearInterval(timer)
      unsubscribe?.()
      document.removeEventListener('visibilitychange', documentVisibility)
      if (display.current) void bridge.view(conversation, 'hand-back', undefined, display.current).catch(() => {})
    }
  }, [bridge, conversation])

  async function run(name, operation) {
    const scope = lifetime.current
    if (!scope?.active) return
    const releasing = name === 'off' || name === 'hand-back'
    if (scope.work && !releasing) {
      if (name !== 'poll' && !scope.next && scope.work.name === 'poll') {
        scope.next = { name, operation }
        setPending(name)
      }
      return
    }
    if (releasing) {
      scope.next = null
    }
    const work = { name }
    scope.work = work
    const current = () => scope.active && scope.work === work
    if (name !== 'poll') setPending(name)
    if (name !== 'poll') setError('')
    try { await operation(current) } catch (failure) {
      if (current()) {
        setError(computerError(failure))
      }
    } finally {
      if (current()) {
        scope.work = null
        if (name !== 'poll') setPending('')
        if (scope.next) {
          const next = scope.next
          scope.next = null
          void run(next.name, next.operation)
        }
      }
    }
  }

  if (!bridge) return null
  const desktopPlace = PLACES.find(item => item.target && item.target === state.target)
  const activePlace = !desktopPlace ? 'off' : place === 'auto' && desktopPlace.id === 'private' ? 'auto' : desktopPlace.id
  const targetLabel = desktopPlace && t(group ? 'Shared group desktop' : desktopPlace.label)
  const live = state.target === 'private-desktop' && state.status === 'user' && typeof bridge.live === 'function'
  const busy = Boolean(pending)
  const status = pending === 'start' && !state.lastFrame ? 'Loading desktop…'
    : state.target ? STATE[state.status] ?? 'Unavailable'
    : group ? 'Shared desktop access is off.' : 'Choose a work location to show its screen.'

  async function choose(target, workPlace, current) {
    const token = await bridge.choose(conversation, target, operator)
    if (!token || !current()) return
    await call('computer-select', { subject, token, operator })
    const value = await bridge.view(conversation, 'status')
    if (!current()) return
    setPlace(workPlace)
    show(value)
    await refreshPreview(value, current, true)
  }

  function selectPrivate(next, resume = false) {
    const scope = lifetime.current
    void run('start', async current => {
      const readiness = await bridge.settings('readiness')
      if (!current()) return
      if (readiness !== 'prepared') {
        if (resume) throw new Error('Prepare the private desktop first.')
        openSettings(() => {
          if (scope?.active && lifetime.current === scope) selectPrivate(next, true)
        })
        return
      }
      await choose('private-desktop', next, current)
    })
  }

  function selectPlace(next) {
    if (next === 'off') {
      void run('off', async current => {
        await call('computer-stop', { subject })
        if (current()) { show({}); setPlace(null) }
      })
    } else if (next === 'local') {
      void run('start', current => choose('local-desktop', 'local', current))
    } else selectPrivate(next)
  }

  function desktop(op, after) {
    const binding = display.current
    if (!binding) return
    const expected = current => current() && display.current === binding
    void run(op, async current => {
      const value = await bridge.view(conversation, op, undefined, binding)
      if (!expected(current)) return
      if (!value) return
      show(value)
      after?.()
      if (op === 'observe' && value.preview) {
        lifetime.current.preview = { display: binding, after: performance.now() + PREVIEW_INTERVAL }
        setPreviewError('')
      }
      if (op === 'hand-back') await refreshPreview(value, current, true)
    })
  }

  const button = (label, onClick, disabled = busy, className = '') => h('button', {
    className: `bt-browser-retry ${className}`.trim(), type: 'button', disabled, onClick,
  }, t(label))
  const controlStatus = [t(status), state.waiting ? `${t('Bots waiting')}: ${state.waiting}` : null, state.lastFrame && !state.preview ? t('Last screenshot') : null].filter(Boolean).join(' · ')
  const toggleFullscreen = () => {
    const change = document.fullscreenElement === viewport.current ? document.exitFullscreen() : viewport.current?.requestFullscreen()
    void change?.catch(failure => setError(computerError(failure)))
  }
  const controlButton = () => state.status === 'user'
    ? button('Hand back', () => desktop('hand-back'), pending === 'hand-back' || pending === 'off', 'bt-computer-primary')
    : button('Take control', () => desktop('take'), busy || !['idle', 'bot'].includes(state.status), 'bt-computer-primary')
  const target = () => h('span', { className: 'bt-computer-target', title: targetLabel }, targetLabel || t('{name}’s screen', { name }))
  const statusLabel = () => h('span', { className: 'bt-computer-status', role: 'status' }, controlStatus)
  const fullscreenToolbar = sendText => h('header', { className: 'bt-computer-fullscreen-toolbar' },
    target(), statusLabel(),
    h('div', { className: 'bt-computer-actions' },
      live ? h(DesktopTextEntry, { sendText }) : null,
      button('Exit full screen', toggleFullscreen, false),
      state.target ? controlButton() : null),
    error || previewError ? h('p', { className: 'bt-error', role: 'alert' }, error || previewError) : null)
  return h('section', { className: 'bt-computer' },
    h('div', { className: 'bt-computer-monitor' },
      h('div', { className: 'bt-computer-toolbar' },
        target(), state.target ? statusLabel() : null),
      h('div', { ref: viewport, className: 'bt-computer-viewport', 'data-takeover': state.status === 'user' || undefined },
        fullscreen && !live ? fullscreenToolbar() : null,
        live ? h(LiveDesktop, { key: state.display, bridge, conversation, display: state.display,
          renderToolbar: fullscreen ? fullscreenToolbar : undefined,
          onDisconnect: () => desktop('hand-back', () => setError(t('Desktop disconnected. Take control to reconnect.'))) })
          : state.lastFrame ? (() => {
            const preview = h('img', { className: 'bt-computer-preview', draggable: false,
              alt: t('Desktop screenshot'), src: `data:${state.lastFrame.mediaType};base64,${state.lastFrame.data}` })
            return state.target === 'private-desktop' && ['idle', 'bot'].includes(state.status)
              ? h('button', { type: 'button', className: 'bt-computer-preview-button', disabled: busy,
                'aria-label': t('Take control'), onClick: () => desktop('take') }, preview) : preview
          })() : h('div', { className: 'bt-computer-empty', role: 'status' },
            t(state.target && !previewError && ['bot', 'viewer', 'idle'].includes(state.status)
              ? 'Waiting for the desktop image…' : status))),
      state.target ? h('div', { className: 'bt-computer-actions bt-computer-screen-actions' },
        controlButton(),
        button('Full screen', toggleFullscreen, !state.lastFrame && !live),
        live ? null : button('Refresh preview', () => desktop('observe'), busy || !OBSERVABLE.includes(state.status)),
        !group && bridge?.workspace && state.privateMode === 'per-bot' && state.target === 'private-desktop'
          ? button('Open two desktops', () => showWorkspace(true), busy || live) : null) : null,
      state.target === 'local-desktop' && state.status === 'user'
        ? h('p', { className: 'bt-set-hint', role: 'status' }, t('Use your mouse and keyboard on this computer.')) : null),
    h('section', { className: 'bt-computer-location', 'aria-label': t(group ? 'Shared group desktop' : 'Work location') },
      h('div', { className: 'bt-computer-location-heading' }, h('h3', null, t(group ? 'Shared group desktop' : 'Work location')),
        h('button', { type: 'button', className: 'bt-more', onClick: () => openSettings() }, t('Computer and browser settings'))),
      group ? h('div', { className: 'bt-computer-actions bt-computer-group-access' },
        h('span', { className: 'bt-set-hint' }, t(state.privateMode === 'shared' ? 'Shared mode is enabled in Settings.'
          : state.privateMode ? 'Enable shared mode in Settings to use a desktop in this group.' : 'Checking desktop settings…')),
        state.target ? button('Revoke access', () => selectPlace('off'), pending === 'off')
          : button('Allow desktop access', () => selectPlace('private'), busy || state.privateMode !== 'shared' || !members.length, 'bt-computer-primary'))
        : h('div', { className: 'bt-computer-places', role: 'group', 'aria-label': t('Work location') },
          ...PLACES.map(({ id, label, Icon }) => h('button', { key: id, type: 'button', 'aria-pressed': activePlace === id,
            disabled: id === 'off' ? pending === 'off' || (!state.target && !pending) : busy,
            onClick: () => selectPlace(id) }, h(Icon), t(label)))),
      error || previewError ? h('p', { className: 'bt-error', role: 'alert' }, error || previewError) : null),
    workspace ? h(DesktopWorkspace, { bridge, bots: bots ?? [], primary: subject, onClose: () => showWorkspace(false) }) : null)
}

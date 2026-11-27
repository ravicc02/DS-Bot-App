// The right column holds the conversation's work views, details and side chats.
import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BotMark } from './mark.js'
import { STORAGE } from './storage.js'
import { MIN_CHAT, PANEL_MIN } from './frame-layout.js'
import { chatRoom } from './frame-watch.js'
import { DetailsDrawer } from './details-drawer.js'
import { SideChatView } from './side-chat.js'
import { sideChatsOf, stripMenuKeys } from './side-model.js'
import { ClockIcon, DotsIcon, FolderIcon, GearIcon, InfoIcon, LocalDesktopIcon, SideIcon, TerminalIcon } from './icons.js'
import { t } from './i18n.js'
import { rectsOverlap } from './browser-overlap.js'
import { ComputerScreen } from './computer-pane.js'
import { ComputerFiles } from './computer-files.js'
import { computerConversation } from './sources.js'
import { currentPart } from './text.js'
import { ScheduleSummary } from './schedules.js'
import { Switch } from './bot-settings.js'
import { useEscape } from './overlay-hooks.js'

export const PANEL_LINGER_MS = 300
const WIDTH_KEY = STORAGE.browserWidth
const EMPTY_PAGE = { url: '', title: '', favicon: null, loading: false, canGoBack: false, canGoForward: false, error: null, excerpt: '' }
const EMPTY_TABS = { ids: [], active: null }
const DEFAULT_WIDTH = 560
const DETAILS_WIDTH = 320
const DETAILS_MAX = 520
const PANEL_MAX = 960

const icon = paths => function BrowserIcon() {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    paths.map((d, index) => h('path', { key: index, d })))
}
export const GlobeIcon = icon(['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M3 10h14', 'M10 3c2 2.2 2.9 4.5 2.9 7S12 14.8 10 17c-2-2.2-2.9-4.5-2.9-7S8 5.2 10 3z'])
const BackIcon = icon(['M12.5 4.5L7 10l5.5 5.5'])
const ForwardIcon = icon(['M7.5 4.5L13 10l-5.5 5.5'])
const ReloadIcon = icon(['M15.5 10a5.5 5.5 0 1 1-1.6-3.9', 'M15.5 3.5v3.5H12'])
const StopIcon = icon(['M5.5 5.5l9 9M14.5 5.5l-9 9'])
const CloseIcon = icon(['M5.5 5.5l9 9M14.5 5.5l-9 9'])
const PlusTabIcon = icon(['M10 5v10M5 10h10'])
const LockIcon = icon(['M6.5 9V7a3.5 3.5 0 0 1 7 0v2', 'M5.5 9h9v7h-9z'])
const ImportIcon = icon(['M10 3.5v8.5', 'M6 8.5l4 4 4-4', 'M4.5 14v1.5a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5V14'])
const FileIcon = icon(['M6 3.5h5.5L14.5 6.5v10H6z', 'M11 3.5v3.5h3.5'])
const WindowIcon = icon(['M4 5h12v9.5H4z', 'M4 7.5h12'])
const MaximizeIcon = icon(['M3.5 4.5h13v11h-13z', 'M3.5 7.5h13'])
const RestoreIcon = icon(['M6.5 7.5h10v9h-10z', 'M3.5 12.5v-9h10'])
const FullscreenIcon = icon(['M4 8V4h4m4 0h4v4m0 4v4h-4m-4 0H4v-4'])
const ExitFullscreenIcon = icon(['M4 8h4V4m4 0v4h4m0 4h-4v4m-4 0v-4H4'])

/** A page's favicon, or the globe while there is none or it fails to load. */
export function Favicon({ src, className }) {
  const [failed, setFailed] = useState(null)
  if (!src || failed === src) return h('span', { className: `${className} bt-ptab-globe` }, h(GlobeIcon))
  return h('img', { className, src, alt: '', 'aria-hidden': true, onError: () => setFailed(src) })
}

// null until the user sets a width: the Bot page then opens at DETAILS_WIDTH and the
// browser at DEFAULT_WIDTH.
const savedWidth = () => {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(value) && value >= DETAILS_WIDTH ? value : null
  } catch { return null }
}
// `room` is what the panel and the conversation share: the viewport minus the
// left column's footprint (frame-layout.js). The panel never takes the last
// MIN_CHAT px of it; below that it covers the conversation instead.
const widthRange = (view, room) => {
  const min = PANEL_MIN[view] ?? DETAILS_WIDTH
  const max = workTabs.some(([id]) => id === view) ? PANEL_MAX : DETAILS_MAX
  return [min, Math.max(min, Math.min(max, room - MIN_CHAT))]
}
const fitWidth = (width, [low, high]) => Math.round(Math.max(low, Math.min(width, high)))
// The address as the bar shows it while not editing: no scheme, no trailing slash.
const shortAddress = url => String(url ?? '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '')

const tabLabel = page => page.title || shortAddress(page.url) || t('New tab')

// The `···` popover anchored to its button. `items` holds {key, icon, label,
// onPick} and {sep:true} entries; Escape or a click outside closes it. The
// callers hide the button when the list is empty.
export function PanelMenu({ items, className, 'aria-label': label }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => { if (wrap.current && !wrap.current.contains(event.target)) setOpen(false) }
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])
  if (items.length === 0) return null
  return h('span', { className: 'bt-pmenu', ref: wrap },
    h('button', {
      type: 'button', className, 'aria-label': label, title: label,
      'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(value => !value),
    }, h(DotsIcon)),
    open ? h('div', { className: 'bt-pmenu-pop', role: 'menu' },
      items.map((item, index) => (item.sep
        ? h('span', { key: `sep-${index}`, className: 'bt-pmenu-sep', role: 'separator' })
        : h('button', {
          key: item.key, type: 'button', role: 'menuitem', className: 'bt-pmenu-item',
          onClick: () => { setOpen(false); item.onPick() },
        }, h(item.icon), h('span', null, item.label))))) : null)
}

// The menu builders in side-model.js give keys; each maps to an icon, a label
// and the action it runs. A rejected action surfaces through reportError.
export function menuItemFor(key, actions, subject) {
  const report = run => () => { void Promise.resolve(run()).catch(error => actions.reportError(error, 'panel-menu')) }
  switch (key) {
    case 'browser': return { key, icon: GlobeIcon, label: t('Browser'), onPick: report(() => actions.openBrowser(subject)) }
    case 'new-tab': return { key, icon: PlusTabIcon, label: t('New browser tab'), onPick: report(() => actions.browserNewTab(subject)) }
    case 'side': return { key, icon: SideIcon, label: t('Side chat'), onPick: report(() => actions.newSideChat(subject)) }
    case 'terminal': return { key, icon: TerminalIcon, label: t('Terminal'), onPick: report(() => actions.newTerminal()) }
    case 'files': return { key, icon: FolderIcon, label: t('Files'), onPick: report(() => actions.openFiles()) }
    default: return { sep: true }
  }
}

// A side chat tab names itself after its first question.
const sideTitle = chat => chat?.entries?.[0]?.question?.trim() || t('Side chat')

const workTabs = [
  ['computer', 'Screen', LocalDesktopIcon],
  ['routines', 'Routines', ClockIcon],
  ['browser', 'Browser', GlobeIcon],
  ['data', 'Data', FolderIcon],
]

function WorkHeader({ tabs, view, onView, subject, bot, canBrowse, sideChats, side, actions }) {
  const items = stripMenuKeys({
    canBrowse, inBrowser: false, hasBrowserTab: false,
    canTerminal: actions.canOpenTerminal?.() === true, canFiles: actions.canOpenFiles?.() === true,
  }).filter(key => key !== 'browser' && key !== 'new-tab' && (key !== 'side' || bot)).map(key => menuItemFor(key, actions, subject))
    .filter(item => !item.sep)
  for (const chat of sideChats) items.push({ key: chat.id, icon: SideIcon, label: sideTitle(chat), onPick: () => actions.openSideChat(subject, chat.id) })
  if (side) items.push({ key: 'close-side', icon: CloseIcon, label: t('Close side chat'), onPick: () => void actions.closeSideChat(side) })
  return h('header', { className: 'bt-work-head' },
    h('button', { type: 'button', className: 'bt-icon-btn', title: t('Computer and browser settings'), 'aria-label': t('Computer and browser settings'), onClick: () => actions.openSettings('browser') }, h(GearIcon)),
    h('div', { className: 'bt-work-tabs', role: 'group', 'aria-label': t('Computer and browser') },
      tabs.map(([id, label, Icon]) => h('button', { key: id, type: 'button', className: 'bt-work-tab', 'data-work-tab': id,
        'aria-pressed': view === id, onClick: () => onView(id) }, h(Icon), t(label)))),
    h('button', { type: 'button', className: 'bt-icon-btn', 'aria-pressed': view === 'details', title: t('Details'), 'aria-label': t('Details'), onClick: () => onView('details') }, h(InfoIcon)),
    items.length ? h(PanelMenu, { items, className: 'bt-ptab-new', 'aria-label': t('More') }) : null,
    h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close panel'), title: t('Close panel'), onClick: () => actions.closePanel() }, h(CloseIcon)))
}

function BrowserTabs({ bot, ids, active, actions, useBrowserPages, children }) {
  const pages = useBrowserPages(value => value)
  return h('div', { className: 'bt-browser-tabs', role: 'group', 'aria-label': t('Browser tabs') },
    h('div', { className: 'bt-browser-tab-list' }, ids.map(id => {
      const page = pages[id] ?? EMPTY_PAGE
      return h('div', { key: id, className: 'bt-browser-tab', 'data-active': active === id || undefined },
        h('button', { type: 'button', 'data-tab': id, className: 'bt-browser-tab-pick', 'aria-pressed': active === id,
          title: page.url || t('New tab'), onClick: () => actions.browserActivate(bot.id, id),
          onAuxClick: event => { if (event.button === 1) void actions.browserCloseTab(bot.id, id) } },
        h(Favicon, { src: page.favicon, className: 'bt-ptab-fav' }), h('span', null, tabLabel(page))),
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close tab'), title: t('Close tab'),
          onClick: () => void actions.browserCloseTab(bot.id, id) }, h(CloseIcon)))
    })),
    h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('New browser tab'), title: t('New browser tab'),
      onClick: () => actions.browserNewTab(bot.id) }, h(PlusTabIcon)),
    h('div', { className: 'bt-browser-display-controls' }, children))
}

// The browser view: toolbar (back, forward, reload/stop, address) over the frame
// the guest webview covers.
function BrowserView({ bot, ids, tabId, leaving, landed, actions, useBrowserPages, hold, maximized, onMaximize }) {
  const page = useBrowserPages(pages => pages[tabId ?? '']) ?? EMPTY_PAGE
  const frame = useRef(null)
  const browser = useRef(null)
  const input = useRef(null)
  const [draft, setDraft] = useState(null)
  const [covered, setCovered] = useState(false)
  const [savingAccess, setSavingAccess] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [displayError, setDisplayError] = useState('')
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === browser.current)
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [])
  useEffect(() => {
    if (leaving && fullscreen) void document.exitFullscreen().catch(() => {})
  }, [leaving, fullscreen])
  const toggleFullscreen = async () => {
    setDisplayError('')
    try {
      if (document.fullscreenElement === browser.current) await document.exitFullscreen()
      else await browser.current.requestFullscreen()
    } catch {
      setDisplayError(t('Could not change browser full screen.'))
    }
  }
  const toggleAccess = async () => {
    setSavingAccess(true)
    try { await actions.updateBot(bot.id, { browserAccess: bot.browserAccess === false }) }
    catch (error) { actions.reportError(error, 'browser-access') }
    finally { setSavingAccess(false) }
  }

  // Cookie imports (the desktop app's bridge only): 'menu' lists the sources; a card
  // stage then runs running → preview → result | error above the guest.
  const imports = actions.browserImport
  const [flow, setFlow] = useState(null)
  // A mirrored flow: the cleanup on leaving the tab or the panel can still cancel
  // an unconfirmed pending import.
  const flowRef = useRef(null)
  const [sources, setSources] = useState(null)
  const [busy, setBusy] = useState(false)
  const setFlowTracked = (next) => {
    flowRef.current = typeof next === 'function' ? next(flowRef.current) : next
    setFlow(flowRef.current)
  }

  // The guest goes on screen once the panel has landed and settled on its width,
  // and only over a page: the empty, error and import states are the panel's own.
  const showGuest = landed && !leaving && !covered && Boolean(page.url) && !page.error && flow === null

  useEffect(() => {
    const update = () => {
      const panel = frame.current?.getBoundingClientRect()
      const overlaps = panel && [...document.querySelectorAll('[role="dialog"],[role="menu"],[role="listbox"]')]
        .some(element => rectsOverlap(panel, element.getBoundingClientRect()))
      setCovered(Boolean(overlaps))
    }
    const observer = new MutationObserver(update)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['role', 'data-leaving'] })
    window.addEventListener('resize', update)
    document.addEventListener('fullscreenchange', update)
    update()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      document.removeEventListener('fullscreenchange', update)
    }
  }, [maximized])

  // Leaving the tab or the panel abandons an unconfirmed import.
  useEffect(() => {
    setFlowTracked(null)
    return () => {
      const id = typeof flowRef.current === 'object' && flowRef.current !== null ? flowRef.current.id : null
      if (id) void imports?.cancel(id).catch(() => {})
    }
    // The flow controls live in this component; the effect re-runs only per tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  const openImport = () => {
    setFlowTracked('menu')
    if (sources === null) void imports.sources().then(setSources, () => setSources([]))
  }
  const showPicked = (r) => {
    if (r?.id) setFlowTracked({ stage: 'preview', id: r.id, preview: r.preview, restarted: r.restarted === true })
    else if (r?.error) setFlowTracked({ stage: 'error', message: importError(r.error) })
    else setFlowTracked(null)
  }
  const job = async (work) => {
    setBusy(true)
    try { await work() } catch (error) { setFlowTracked({ stage: 'error', message: String(error?.message ?? error) }) } finally { setBusy(false) }
  }
  const pickFile = () => job(async () => showPicked(await imports.pick()))
  const pickSource = (source) => job(async () => {
    const r = await imports.live(source.id)
    if (r?.running) setFlowTracked({ stage: 'running', source })
    else showPicked(r)
  })
  const closeAndImport = () => job(async () => showPicked(await imports.live(flowRef.current?.source?.id, true)))
  const applyImport = () => job(async () => {
    const report = await imports.apply(bot.id, flowRef.current?.id)
    setFlowTracked((current) => ({ stage: 'result', report, label: current?.preview?.source?.label ?? null }))
  })
  const cancelImport = () => {
    const id = typeof flow === 'object' && flow !== null ? flow.id : null
    setFlowTracked(null)
    if (id) void imports?.cancel(id).catch(() => {})
  }
  useLayoutEffect(() => {
    const element = frame.current
    if (!element || leaving || !tabId) { void actions.browserShow(null); return undefined }
    let raf = 0
    const measure = () => {
      cancelAnimationFrame(raf)
      raf = 0
      const box = element.getBoundingClientRect()
      void actions.browserShow(tabId, showGuest ? { left: box.left, top: box.top, width: box.width, height: box.height } : null)
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure) }
    measure()
    // Measured inside the observer callback, where layout is fresh: the guest moves in
    // the same frame as the panel edge instead of one behind it.
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [tabId, showGuest, leaving, maximized, fullscreen])

  // A fresh tab starts on its address bar. Panel animation and resizing must
  // not reset text the user has already entered.
  useLayoutEffect(() => {
    setDraft(null)
    if (!page.url && input.current !== document.activeElement) input.current?.focus()
  }, [tabId])

  const go = (event) => {
    event.preventDefault()
    const text = input.current?.value ?? ''
    if (text.trim() === '') return
    setDraft(null)
    input.current?.blur()
    void actions.browserNavigate(tabId, text).then((opened) => { if (opened) actions.browserFocus(tabId) })
  }

  const editing = draft !== null
  const secure = /^https:/i.test(page.url)
  const displayButton = (label, Icon, onClick) => h('button', {
    type: 'button', className: 'bt-icon-btn', 'aria-label': t(label), title: t(label), onClick,
  }, h(Icon))
  const maximizeLabel = maximized ? 'Restore browser panel' : 'Maximize browser panel'
  const fullscreenLabel = fullscreen ? 'Exit full screen' : 'Full screen'
  return h('div', { ref: browser, className: 'bt-panel-view bt-panel-browser', 'aria-label': t("{name}'s browser", { name: bot.name }) },
    h('div', { className: 'bt-browser-access' },
      h('span', null, h(GlobeIcon), t('Let {name} use the browser', { name: bot.name })),
      h(Switch, { label: t('Let {name} use the browser', { name: bot.name }), on: bot.browserAccess !== false, disabled: savingAccess, onChange: toggleAccess })),
    h(BrowserTabs, { bot, ids, active: tabId, actions, useBrowserPages },
      fullscreen ? null : displayButton(maximizeLabel, maximized ? RestoreIcon : MaximizeIcon, onMaximize),
      document.fullscreenEnabled || fullscreen ? displayButton(fullscreenLabel, fullscreen ? ExitFullscreenIcon : FullscreenIcon, toggleFullscreen) : null),
    displayError ? h('p', { className: 'bt-error bt-browser-display-error', role: 'alert' }, displayError) : null,
    tabId && actions.browserTakeover ? h('div', { className: 'bt-browser-takeover', 'data-held': hold?.by === 'user' || undefined },
      h('span', null, hold?.by === 'user' ? t('You control this browser') : hold?.by === 'bot' ? t('The Bot handed this browser to you: {reason}', { reason: hold.reason }) : t('The Bot controls this browser')),
      hold?.by
        ? h('button', { type: 'button', onClick: () => void actions.browserGiveBack(bot.id) }, t('Give back'))
        : h('span', { className: 'bt-browser-takeover-actions' },
            h('button', { type: 'button', onClick: () => void actions.browserTakeover(bot.id) }, t('Take over')),
            h('button', { type: 'button', onClick: () => void actions.browserStop(bot.id) }, t('Stop')))) : null,
    tabId ? h('div', { className: 'bt-browser-bar' },
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back'), title: t('Back'), disabled: !page.canGoBack, onClick: () => actions.browserCommand(tabId, 'back') }, h(BackIcon)),
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Forward'), title: t('Forward'), disabled: !page.canGoForward, onClick: () => actions.browserCommand(tabId, 'forward') }, h(ForwardIcon)),
      h('button', {
        type: 'button', className: 'bt-icon-btn', disabled: !page.url,
        'aria-label': page.loading ? t('Stop') : t('Reload'), title: page.loading ? t('Stop') : t('Reload'),
        onClick: () => actions.browserCommand(tabId, page.loading ? 'stop' : 'reload'),
      }, h(page.loading ? StopIcon : ReloadIcon)),
      h('form', { className: 'bt-browser-address', onSubmit: go, 'data-editing': editing || undefined },
        h('span', { className: 'bt-browser-scheme', 'aria-hidden': true }, h(secure && !editing ? LockIcon : GlobeIcon)),
        h('input', {
          ref: input, type: 'text', spellCheck: false, autoComplete: 'off', 'aria-label': t('Address'),
          placeholder: t('Search or enter address'),
          value: editing ? draft : shortAddress(page.url),
          onFocus: (event) => { setDraft(page.url); const target = event.target; requestAnimationFrame(() => target.select()) },
          onBlur: () => setDraft(null),
          onChange: event => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return
            if (event.key === 'Enter') { event.stopPropagation(); go(event) }
            if (event.key === 'Escape') { event.stopPropagation(); setDraft(null); event.currentTarget.blur() }
          },
        })),
      imports ? h('button', {
        type: 'button', className: 'bt-icon-btn bt-import-btn', 'aria-label': t('Import cookies'), title: t('Import cookies'),
        'aria-expanded': flow === 'menu', disabled: busy,
        onClick: () => { if (flow === 'menu') setFlowTracked(null); else openImport() },
      }, h(ImportIcon)) : null,
      page.loading ? h('span', { className: 'bt-browser-progress', 'aria-hidden': true }) : null) : null,
    h('div', { ref: frame, className: 'bt-browser-frame', 'data-guest': showGuest || undefined },
      flow === 'menu' ? h(ImportMenu, { sources, busy, onFile: pickFile, onSource: pickSource, onClose: () => setFlowTracked(null) }) : null,
      typeof flow === 'object' && flow !== null
        ? h(ImportCard, { flow, page, busy, onApply: applyImport, onCancel: cancelImport, onCloseAndImport: closeAndImport, onDone: () => setFlowTracked(null), onReload: () => actions.browserCommand(tabId, 'reload') })
        : null,
      flow === null && page.error
        ? h('div', { className: 'bt-browser-empty' },
            h('div', { className: 'bt-browser-empty-title' }, t('This page didn’t load')),
            h('div', { className: 'bt-browser-empty-text' }, t(page.error)),
            page.url ? h('button', { type: 'button', className: 'bt-browser-retry', onClick: () => { void actions.browserNavigate(tabId, page.url) } }, t('Try again')) : null)
        : tabId && flow === null && !page.url
          ? h('div', { className: 'bt-browser-empty' },
              h(BotMark, { bot, size: 48, state: 'idle', live: true }),
              h('div', { className: 'bt-browser-empty-title' }, t("{name}'s browser", { name: bot.name })),
              h('div', { className: 'bt-browser-empty-text' }, t('Open a page here and {name} can read it with you. Logins and cookies stay with {name}; other Bots never see them.', { name: bot.name })),
              imports ? h('button', { type: 'button', className: 'bt-browser-retry', onClick: openImport }, t('Import cookies')) : null)
          : null))
}


function importError(error) {
  if (error === 'too-large') return t('That file is too large to be a cookie export.')
  if (error === 'unreadable') return t('That file could not be read.')
  if (error === 'app-bound') return t('This browser encrypts its cookies so only it can read them. Export them to a file first, then import that file.')
  return String(error)
}

// The sources popover: a cookie file, then every importable browser profile.
function ImportMenu({ sources, busy, onFile, onSource, onClose }) {
  useEffect(() => {
    const close = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])
  return h('div', { className: 'bt-import-menu', role: 'menu', 'aria-label': t('Import cookies') },
    h('div', { className: 'bt-import-menu-title' }, t('Import cookies')),
    h('button', { type: 'button', className: 'bt-import-item', role: 'menuitem', disabled: busy, onClick: onFile },
      h(FileIcon, { className: 'bt-import-item-icon' }),
      h('span', { className: 'bt-import-item-name' }, t('From a file…')),
      h('span', { className: 'bt-import-item-sub' }, t('cookies.txt, JSON, storageState'))),
    sources === null
      ? h('div', { className: 'bt-import-menu-note' }, t('Loading…'))
      : sources.length === 0
        ? h('div', { className: 'bt-import-menu-note' }, t('No browsers found'))
        : sources.map((source) => h('button', {
          key: source.id, type: 'button', className: 'bt-import-item', role: 'menuitem', disabled: busy,
          onClick: () => onSource(source),
        },
          h(WindowIcon, { className: 'bt-import-item-icon' }),
          h('span', { className: 'bt-import-item-name' }, source.label),
          h('span', { className: 'bt-import-item-sub' }, t('Copy of its cookies')))))
}

// The card that runs an import: close confirmation → preview → result | error.
function ImportCard({ flow, page, busy, onApply, onCancel, onCloseAndImport, onDone, onReload }) {
  const { stage } = flow
  if (stage === 'running') {
    return h('div', { className: 'bt-import-card' }, h('div', { className: 'bt-import-box' },
      h('div', { className: 'bt-import-title' }, t('{name} is running', { name: flow.source.name })),
      h('div', { className: 'bt-import-text' }, t('It must close for a moment so its cookies can be copied. It will reopen with your tabs.')),
      h('div', { className: 'bt-import-actions' },
        h('button', { type: 'button', className: 'bt-import-primary', disabled: busy, onClick: onCloseAndImport }, busy ? t('Closing…') : t('Close {name} and import', { name: flow.source.name })),
        h('button', { type: 'button', className: 'bt-import-plain', disabled: busy, onClick: onCancel }, t('Cancel')))))
  }
  if (stage === 'error') {
    return h('div', { className: 'bt-import-card' }, h('div', { className: 'bt-import-box' },
      h('div', { className: 'bt-import-title' }, t('Import failed')),
      h('div', { className: 'bt-import-text' }, flow.message),
      h('div', { className: 'bt-import-actions' }, h('button', { type: 'button', className: 'bt-import-plain', onClick: onCancel }, t('Close')))))
  }
  if (stage === 'result') {
    const { report } = flow
    const problems = [...(report.dropped ?? []), ...(report.failed ?? [])]
    return h('div', { className: 'bt-import-card' }, h('div', { className: 'bt-import-box' },
      h('div', { className: 'bt-import-title' }, report.stored > 0 ? t('Imported {count} cookies', { count: report.stored }) : t('No cookies were stored')),
      flow.label ? h('div', { className: 'bt-import-sub' }, flow.label) : null,
      problems.length ? h('div', { className: 'bt-import-list' },
        problems.slice(0, 8).map((item, index) => h('div', { key: index, className: 'bt-import-line' },
          h('span', { className: 'bt-import-line-name' }, item.name ?? '—'),
          h('span', { className: 'bt-import-line-reason' }, item.reason))),
        problems.length > 8 ? h('div', { className: 'bt-import-line' }, h('span', { className: 'bt-import-line-reason' }, t('and {count} more', { count: problems.length - 8 }))) : null) : null,
      h('div', { className: 'bt-import-actions' },
        page.url ? h('button', { type: 'button', className: 'bt-import-plain', onClick: onReload }, t('Reload the page')) : null,
        h('button', { type: 'button', className: 'bt-import-primary', onClick: onDone }, t('Done')))))
  }
  // stage === 'preview'
  const { preview } = flow
  return h('div', { className: 'bt-import-card' }, h('div', { className: 'bt-import-box' },
    h('div', { className: 'bt-import-title' }, t('Import {count} cookies', { count: preview.cookies })),
    h('div', { className: 'bt-import-sub' },
      preview.source?.label ?? '',
      flow.restarted ? ` · ${t('the browser was restarted')}` : ''),
    preview.sites.length ? h('div', { className: 'bt-import-list' },
      preview.sites.map((site) => h('div', { key: site.site, className: 'bt-import-line' },
        h('span', { className: 'bt-import-line-name' }, site.site),
        h('span', { className: 'bt-import-line-count' },
          t('{count}', { count: site.cookies }),
          site.session > 0 ? ` · ${t('{count} session', { count: site.session })}` : '')))) : null,
    preview.skipped.length ? h('div', { className: 'bt-import-list' },
      h('div', { className: 'bt-import-note' }, t('{count} skipped', { count: preview.skipped.length })),
      preview.skipped.slice(0, 5).map((item, index) => h('div', { key: index, className: 'bt-import-line' },
        h('span', { className: 'bt-import-line-name' }, item.name ?? item.where),
        h('span', { className: 'bt-import-line-reason' }, item.reason))),
      preview.skipped.length > 5 ? h('div', { className: 'bt-import-line' }, h('span', { className: 'bt-import-line-reason' }, t('and {count} more', { count: preview.skipped.length - 5 }))) : null) : null,
    preview.warnings.length ? h('details', { className: 'bt-import-warns' },
      h('summary', null, t('{count} adjusted', { count: preview.warnings.reduce((n, w) => n + w.count, 0) })),
      preview.warnings.map((w, index) => h('div', { key: index, className: 'bt-import-line' },
        h('span', { className: 'bt-import-line-reason' }, `${w.count} × ${w.message}`)))) : null,
    preview.notes.includes('session-cookies') ? h('div', { className: 'bt-import-note' }, t('Cookies without an expiry stay until the app closes.')) : null,
    preview.notes.includes('local-storage-left') ? h('div', { className: 'bt-import-note' }, t('Some sites also keep sign-in outside cookies; you may need to sign in again there.')) : null,
    h('div', { className: 'bt-import-actions' },
      h('button', { type: 'button', className: 'bt-import-primary', disabled: busy, onClick: onApply }, busy ? t('Importing…') : t('Import')),
      h('button', { type: 'button', className: 'bt-import-plain', disabled: busy, onClick: onCancel }, t('Cancel')))))
}

/**
 * One aside for the Bot's details, browser and side chats. `pane` is
 * `{ id, view: 'details'|'browser'|'side', renaming, tab, side }`; `id` is the
 * Session id the panel follows and `side` the open chat's id. Without the
 * Desktop bridge the browser view never shows; side chats need no bridge.
 */
export function BotPanel({ pane, leaving, room, overlay, roster, actions, desktopConversation, useSessions, useSessionStatus, useActivity, useWork, useBrowserTabs, useBrowserPages, useBrowserHolds }) {
  const bot = roster.byId[pane.id]
  const group = roster.roomsById[pane.id]
  const subject = bot?.id ?? group?.id ?? pane.id
  const hasComputer = Boolean((bot || group) && globalThis.window?.dsBotApp?.computer)
  const canBrowse = Boolean(bot && roster.browser === true && actions.browserShow)
  const tabs = workTabs.filter(([id]) => id === 'browser' ? canBrowse : id === 'routines' ? Boolean(bot) : hasComputer)
  const sideChats = bot ? sideChatsOf(roster, bot.id) : []
  const sideChat = sideChats.find(chat => chat?.id === pane.side)
  const requestedView = pane.view
  const view = tabs.some(([id]) => id === requestedView) || (requestedView === 'side' && sideChat) ? requestedView : 'details'
  const inWork = tabs.some(([id]) => id === view)
  const tabState = useBrowserTabs(map => (bot ? (map[bot.id] ?? EMPTY_TABS) : EMPTY_TABS))
  const active = tabState.ids.includes(tabState.active) ? tabState.active : null
  const hold = useBrowserHolds?.(map => bot ? map[bot.id] ?? null : null) ?? null
  const [error, setError] = useState('')
  const root = useRef(null)
  const dragCleanup = useRef(null)
  const [landed, setLanded] = useState(false)
  const [width, setWidth] = useState(savedWidth)
  const [dragging, setDragging] = useState(false)
  const [expandedBrowser, setExpandedBrowser] = useState(null)
  const maximized = view === 'browser' && expandedBrowser === subject
  const [resizing, setResizing] = useState(false)
  const instant = dragging || resizing
  const range = widthRange(view, room)
  const panelWidth = fitWidth(width ?? (inWork ? DEFAULT_WIDTH : DETAILS_WIDTH), range)
  const saveWidth = next => {
    setWidth(next)
    try { localStorage.setItem(WIDTH_KEY, String(next)) } catch { /* storage unavailable */ }
  }
  const closePanel = () => { if (!leaving) actions.closePanel() }
  useEscape(() => {
    if (document.fullscreenElement?.classList.contains('bt-panel-browser')) return
    if (maximized) setExpandedBrowser(null)
    else closePanel()
  })
  useEffect(() => { setExpandedBrowser(null) }, [subject, view])
  useLayoutEffect(() => { chatRoom.hold(instant) }, [instant])
  useLayoutEffect(() => { chatRoom.setRight(leaving || overlay ? null : panelWidth) }, [panelWidth, leaving, overlay])
  useEffect(() => () => { dragCleanup.current?.(); chatRoom.setRight(null); chatRoom.hold(false) }, [])
  useEffect(() => { if (leaving || overlay) dragCleanup.current?.() }, [leaving, overlay])
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return undefined }
    setResizing(true)
    const timer = setTimeout(() => setResizing(false), 160)
    return () => clearTimeout(timer)
  }, [room])
  useEffect(() => {
    const timer = setTimeout(() => setLanded(true), 360)
    return () => clearTimeout(timer)
  }, [])
  useEffect(() => { if (canBrowse) actions.browserEnsure(bot.id) }, [bot?.id, canBrowse])
  const switchView = next => {
    if (next === view || leaving) return
    setError('')
    if (next === 'browser' && active === null) actions.openBrowser(subject)
    else actions.setPanelView(next)
  }
  const run = async promise => {
    try { await promise; setError(''); return true }
    catch (failure) { setError(failure?.message ?? String(failure)); return false }
  }

  // A drag writes the width into the panel's and the column's own inline styles each
  // frame (each restyles one element) and renders once, on release.
  const startResize = (event) => {
    if (event.button !== 0 || leaving || overlay) return
    event.preventDefault()
    const panel = root.current
    const grip = event.currentTarget
    grip.setPointerCapture?.(event.pointerId)
    const from = { x: event.clientX, width: panelWidth }
    let next = panelWidth
    setDragging(true)
    chatRoom.hold(true)
    const columns = chatRoom.columns()
    for (const column of columns) column.style.setProperty('transition', 'none', 'important')
    const onMove = (move) => {
      next = fitWidth(from.width + from.x - move.clientX, range)
      panel.style.width = `${next}px`
      if (columns.length === 0) chatRoom.setRight(next)
      for (const column of columns) column.style.setProperty('margin-right', `${next}px`, 'important')
    }
    const ends = ['pointerup', 'pointercancel', 'lostpointercapture']
    const onEnd = (end) => {
      if (end?.type === 'pointerup') onMove(end)
      dragCleanup.current = null
      grip.removeEventListener('pointermove', onMove)
      for (const name of ends) grip.removeEventListener(name, onEnd)
      // Hand the width back to the rule and the panel's variable in the same frame.
      chatRoom.setRight(next)
      for (const column of columns) { column.style.removeProperty('margin-right'); column.style.removeProperty('transition') }
      panel.style.setProperty('--bt-panel-w', `${next}px`)
      panel.style.removeProperty('width')
      if (end) {
        setDragging(false)
        if (next !== from.width) saveWidth(next)
      }
    }
    dragCleanup.current = () => onEnd({ type: 'cancel' })
    grip.addEventListener('pointermove', onMove)
    for (const name of ends) grip.addEventListener(name, onEnd)
  }

  // The arrow toward the conversation grows the right-hand panel.
  const resizeWithKey = event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const step = event.shiftKey ? 80 : 40
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? range[0] : event.key === 'End' ? range[1]
      : panelWidth + (event.key === 'ArrowLeft' ? step : -step)
    saveWidth(fitWidth(next, range))
  }
  const conversation = computerConversation(roster, pane.id)
  const isCurrent = conversation !== undefined && conversation === desktopConversation
  const showHeader = Boolean(hasComputer || canBrowse || sideChats.length || bot)
  let content
  if (view === 'browser') {
    content = h(BrowserView, { key: subject, bot: { ...bot, mobileControl: tabState.mobileControl }, ids: tabState.ids, tabId: active,
      leaving, landed: landed && !dragging, actions, useBrowserPages, hold, maximized,
      onMaximize: () => setExpandedBrowser(maximized ? null : subject) })
  } else if (inWork) {
    let body
    if (view === 'routines') body = h(ScheduleSummary, { bot, actions, expanded: true })
    else if (!isCurrent || leaving) body = h('p', { className: 'bt-muted' }, t('Open this conversation to use the computer.'))
    else if (view === 'computer') body = h(ComputerScreen, {
      subject, conversation, bots: roster.bots, name: bot?.name ?? group?.name,
      members: group?.members.map(id => roster.byId[id]).filter(Boolean),
      openSettings: resume => actions.openSettings('browser', resume ? 'private-desktop' : null, resume),
    })
    else body = h(ComputerFiles, { sessionId: bot ? currentPart(bot) : pane.id, group: Boolean(group), workDir: (bot ?? group).workDir,
      actions, run, onPickFolder: workDir => run(bot ? actions.updateBot(bot.id, { workDir }) : actions.updateRoom(group.id, { workDir })) })
    content = h('div', { key: `${view}:${subject}`, className: 'bt-panel-view' },
      h('div', { className: 'bt-work-body' }, error ? h('p', { role: 'alert', className: 'bt-error' }, error) : null, body))
  } else if (view === 'side') {
    content = h('div', { key: `side:${sideChat.id}`, className: 'bt-panel-view' }, h(SideChatView, { subject, chat: sideChat, actions }))
  } else {
    content = h('div', { key: `details:${pane.id}:${pane.renaming ? 'rename' : ''}:${pane.tab === 'settings' ? 'settings' : ''}`, className: 'bt-panel-view' },
      h(DetailsDrawer, { sessionId: pane.id, startRenaming: pane.renaming, startTab: pane.tab, hasStrip: showHeader,
        roster, actions, useSessions, useSessionStatus, useActivity, useWork, useBrowserTabs, useBrowserPages }))
  }
  return h('aside', {
    ref: root, className: 'bt-panel', 'data-view': view, 'aria-label': t('Computer and browser'),
    'data-leaving': leaving || undefined, 'aria-hidden': leaving || undefined, inert: leaving || undefined,
    'data-instant': instant || undefined, 'data-dragging': dragging || undefined, 'data-overlay': overlay || undefined,
    'data-maximized': maximized || undefined, style: { '--bt-panel-w': `${panelWidth}px` },
    onAnimationEnd: event => { if (event.target === event.currentTarget) setLanded(true) },
  },
    leaving || overlay || maximized ? null : h('div', { className: 'bt-panel-grip', role: 'separator', tabIndex: 0, 'aria-orientation': 'vertical',
      'aria-label': t('Resize panel'), 'aria-valuemin': range[0], 'aria-valuemax': range[1], 'aria-valuenow': panelWidth,
      onPointerDown: startResize, onKeyDown: resizeWithKey }),
    dragging ? createPortal(h('div', { className: 'bt-drag-shield', 'aria-hidden': true }), document.body) : null,
    showHeader ? h(WorkHeader, { tabs, view, onView: switchView, subject, bot, canBrowse, sideChats, side: sideChat?.id, actions }) : null,
    content)
}

export const BROWSER_CSS = `
.bt-work-head{flex:none;display:flex;align-items:center;gap:4px;padding:8px 10px;border-bottom:.5px solid var(--bt-line)}
.bt-work-head>.bt-icon-btn{flex:none}
.bt-work-tabs{display:flex;gap:2px;align-items:center;min-width:0;margin-inline:auto;padding:3px;border-radius:999px;background:var(--bt-hover);overflow:auto;scrollbar-width:none}
.bt-work-tab{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:30px;flex:none;padding:0 8px;border:0;border-radius:999px;background:none;color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.bt-work-tab svg{width:15px;height:15px}
.bt-work-tab:hover,.bt-work-tab[aria-pressed=true]{color:var(--bt-ink);background:var(--bt-active)}
.bt-work-body{overflow:auto;min-height:0;padding:12px;flex:1}
.bt-work-head .bt-ptab-new{flex:none;width:28px;height:30px;border:0;background:none;color:var(--bt-ink-2);cursor:pointer}
.bt-panel-grip:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-panel-view{flex:1;min-height:0;display:flex;flex-direction:column;animation:bt-panel-view-in .22s cubic-bezier(.16,1,.3,1)}
@keyframes bt-panel-view-in{from{opacity:0}}
.bt-browser-access{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:10px 10px 6px;padding:8px 12px;border-radius:10px;background:var(--bt-hover);font-size:13px}
.bt-browser-access>span{display:flex;align-items:center;gap:6px}
.bt-browser-tabs{display:flex;align-items:center;gap:4px;min-width:0;padding:4px 10px;background:var(--bt-hover)}
.bt-panel[data-maximized]{width:100%;border-left:0;transition:none}
.bt-browser-display-controls{margin-left:auto;display:flex;align-items:center;gap:4px;flex:none}
.bt-browser-display-error{margin:8px 12px}
.bt-browser-tab-list{display:flex;gap:4px;min-width:0;overflow-x:auto;scrollbar-width:thin}
.bt-browser-tab{display:flex;align-items:center;flex:none;max-width:180px;border-radius:8px;color:var(--bt-ink-2)}
.bt-browser-tab[data-active]{color:var(--bt-ink);background:var(--bt-active)}
.bt-browser-tab-pick{display:flex;align-items:center;gap:6px;min-width:0;padding:0 6px;height:30px;border:0;background:none;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.bt-browser-tab-pick span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-browser-tab .bt-icon-btn{flex:none;width:24px;height:24px}
.bt-ptab-fav{width:14px;height:14px;flex:none;border-radius:3px;object-fit:cover;color:var(--bt-ink-3)}
@media(max-width:420px){.bt-work-head{gap:2px;padding-inline:5px}.bt-work-tab{padding-inline:5px}.bt-work-tab svg{display:none}}
.bt-panel-browser{position:relative}
.bt-panel-browser:fullscreen{background:var(--bt-main);color:var(--bt-ink)}
.bt-browser-bar{position:relative;display:flex;align-items:center;gap:2px;height:52px;padding:0 10px 0 12px;flex:none;border-bottom:.5px solid var(--bt-line)}
.bt-browser-takeover{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;background:var(--bt-hover);border-bottom:.5px solid var(--bt-line);font-size:12px;color:var(--bt-ink-2)}
.bt-browser-takeover[data-held]{background:var(--bt-active)}
.bt-browser-takeover-actions{display:flex;gap:6px}
.bt-browser-takeover button{border:1px solid var(--bt-line-2);border-radius:8px;padding:5px 9px;background:var(--bt-main);color:var(--bt-ink);font:inherit;cursor:pointer}
.bt-browser-bar .bt-icon-btn:disabled{opacity:.35;cursor:default;background:none}
.bt-browser-address{flex:1;min-width:0;display:flex;align-items:center;gap:6px;height:32px;margin:0 4px;padding:0 12px;border-radius:999px;background:var(--bt-hover);border:.5px solid transparent;transition:background-color .12s ease,border-color .12s ease,box-shadow .12s ease}
.bt-browser-address:hover{background:var(--bt-active)}
.bt-browser-address[data-editing]{background:var(--bt-main);border-color:var(--bt-line-2);box-shadow:0 2px 8px -1px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04)}
.bt-browser-scheme{display:inline-flex;color:var(--bt-ink-3);flex:none}
.bt-browser-scheme svg{width:14px;height:14px}
.bt-browser-address input{flex:1;min-width:0;border:0;background:none;outline:none;color:var(--bt-ink);font:inherit;font-size:13px;line-height:18px;padding:0;text-overflow:ellipsis}
.bt-browser-address input::placeholder{color:var(--bt-ink-3)}
.bt-browser-progress{position:absolute;left:0;right:0;bottom:-1px;height:2px;overflow:hidden;pointer-events:none}
.bt-browser-progress::after{content:"";position:absolute;inset:0;width:40%;background:var(--bt-accent,#4D6BFE);border-radius:2px;animation:bt-browser-load 1.1s cubic-bezier(.4,0,.2,1) infinite}
@keyframes bt-browser-load{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
.bt-browser-frame{position:relative;flex:1;min-height:0;background:var(--bt-main)}
.bt-browser-frame[data-guest]{background:#fff}
.bt-browser-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px;text-align:center;animation:bt-foot-in .3s ease}
.bt-browser-empty-title{font-size:15px;line-height:22px;font-weight:500;margin-top:6px}
.bt-browser-empty-text{max-width:300px;font-size:13px;line-height:19px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-browser-retry{margin-top:6px;height:32px;padding:0 14px;border-radius:999px;border:.5px solid var(--bt-line-2);background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:13px;cursor:pointer}
.bt-browser-retry:hover{background:var(--bt-hover)}
.bt-bcards{display:flex;flex-direction:column;gap:12px}
.bt-bcard{position:relative;border:.5px solid var(--bt-line-2);border-radius:12px;overflow:hidden;background:var(--bt-main);animation:bt-bcard-in .24s cubic-bezier(.16,1,.3,1) both;transition:border-color .12s ease,box-shadow .12s ease}
@keyframes bt-bcard-in{from{opacity:0;filter:blur(4px);transform:translateY(4px)}}
.bt-bcard[data-active]{border-color:var(--bt-accent,#4D6BFE);box-shadow:0 0 0 1px var(--bt-accent,#4D6BFE)}
.bt-bcard-shot{position:relative;display:block;width:100%;aspect-ratio:16/10;border:0;background:var(--bt-hover);padding:0;cursor:pointer}
.bt-bcard-blank{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--bt-ink-3);font-size:12px}
.bt-bcard-blank svg{width:20px;height:20px}
.bt-bcard-preview{position:absolute;inset:0;display:flex;flex-direction:column;gap:6px;padding:14px 16px;text-align:left;background:linear-gradient(to bottom,var(--bt-main),var(--bt-hover));overflow:hidden}
.bt-bcard-ptitle{font-size:13px;line-height:18px;font-weight:600;color:var(--bt-ink);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.bt-bcard-excerpt{font-size:12px;line-height:17px;color:var(--bt-ink-2);display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.bt-bcard-row{display:flex;align-items:center;gap:7px;padding:8px 10px;min-width:0}
.bt-bcard-fav{width:14px;height:14px;flex:none;border-radius:3px;color:var(--bt-ink-3)}
.bt-bcard-row svg.bt-bcard-fav{width:14px;height:14px}
.bt-bcard-title{flex:1;min-width:0;font-size:12.5px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink)}
.bt-bcard-host{flex:none;font-size:11px;line-height:15px;color:var(--bt-ink-3);max-width:38%;overflow:hidden;text-overflow:ellipsis}
.bt-bcard-x{position:absolute;top:6px;right:6px;width:22px;height:22px;border:0;border-radius:7px;background:color-mix(in srgb,var(--bt-main) 88%,transparent);color:var(--bt-ink-2);display:flex;align-items:center;justify-content:center;font-size:14px;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .12s ease;backdrop-filter:blur(4px)}
.bt-bcard:hover .bt-bcard-x{opacity:1;pointer-events:auto}
.bt-bcard-new{display:flex;align-items:center;justify-content:center;gap:6px;height:40px;border:.5px dashed var(--bt-line-2);border-radius:12px;background:none;color:var(--bt-ink-3);font:inherit;font-size:12.5px;cursor:pointer}
.bt-bcard-new:hover{color:var(--bt-ink);border-color:var(--bt-ink-3)}
.bt-bcard-new svg{width:14px;height:14px}
.bt-browser-empty-mark{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}
/* Cookie imports */
.bt-import-menu{position:absolute;top:6px;right:6px;z-index:6;width:236px;padding:6px;border-radius:16px;background:var(--bt-main);border:.5px solid var(--bt-line-2);box-shadow:0 10px 32px -8px rgba(0,0,0,.14),0 2px 8px rgba(0,0,0,.06);animation:bt-bcard-in .18s cubic-bezier(.16,1,.3,1) both}
.bt-import-menu-title{padding:6px 10px 8px;font-size:11px;font-weight:500;letter-spacing:.02em;color:var(--bt-ink-3)}
.bt-import-item{display:flex;align-items:center;gap:9px;width:100%;min-width:0;padding:8px 10px;border:0;border-radius:8px;background:none;color:var(--bt-ink);font:inherit;font-size:12.5px;text-align:left;cursor:pointer}
.bt-import-item:hover{background:var(--bt-hover)}
.bt-import-item:disabled{opacity:.5;cursor:default}
.bt-import-item-icon{flex:none;color:var(--bt-ink-3)}
.bt-import-item-icon svg,.bt-import-item svg{width:15px;height:15px}
.bt-import-item-name{flex:none;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-import-item-sub{flex:1;min-width:0;text-align:right;font-size:11px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-import-menu-note{padding:8px 10px 10px;font-size:12px;color:var(--bt-ink-3)}
.bt-import-card{position:absolute;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--bt-main);overflow:auto;animation:bt-foot-in .2s ease}
.bt-import-box{width:100%;max-width:340px;max-height:100%;display:flex;flex-direction:column;gap:10px;padding:20px;border:.5px solid var(--bt-line-2);border-radius:16px;background:var(--bt-main);box-shadow:0 12px 36px -12px rgba(0,0,0,.14);overflow:auto}
.bt-import-title{font-size:15px;line-height:21px;font-weight:600}
.bt-import-sub{font-size:12px;line-height:17px;color:var(--bt-ink-3);margin-top:-6px}
.bt-import-text{font-size:13px;line-height:19px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-import-list{max-height:180px;overflow:auto;border:.5px solid var(--bt-line);border-radius:10px;padding:4px 10px}
.bt-import-line{display:flex;align-items:baseline;gap:8px;padding:4px 0;min-width:0}
.bt-import-line-name{flex:none;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--bt-ink)}
.bt-import-line-count{flex:1;min-width:0;text-align:right;font-size:11.5px;color:var(--bt-ink-3);white-space:nowrap}
.bt-import-line-reason{flex:1;min-width:0;font-size:11.5px;line-height:16px;color:var(--bt-ink-3);overflow-wrap:anywhere}
.bt-import-note{font-size:12px;line-height:17px;color:var(--bt-ink-3)}
.bt-import-warns{font-size:12px;color:var(--bt-ink-3)}
.bt-import-warns summary{cursor:pointer;padding:2px 0}
.bt-import-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
.bt-import-primary{height:32px;padding:0 16px;border:0;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink);font:inherit;font-size:13px;cursor:pointer}
.bt-import-primary:disabled{opacity:.55;cursor:default}
.bt-import-plain{height:32px;padding:0 14px;border:.5px solid var(--bt-line-2);border-radius:999px;background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:13px;cursor:pointer}
.bt-import-plain:hover{background:var(--bt-hover)}
.bt-import-plain:disabled{opacity:.55;cursor:default}
/* A viewport too narrow to leave the conversation its room: the panel covers it,
   and its close controls get a touch-sized target. */
.bt-panel[data-overlay]{width:100vw}
.bt-panel[data-overlay] .bt-ptab-close,.bt-panel[data-overlay] .bt-drawer-top .bt-round{width:44px;height:44px}
/* Touch: the hidden-but-tappable tab and card close buttons stay visible at a
   finger-sized target instead. */
@media (hover:none){
  .bt-ptab-x,.bt-bcard-x{opacity:1;pointer-events:auto;width:44px;height:44px}
  .bt-ptab-close{width:44px;height:44px}
}
@media (prefers-reduced-motion:reduce){.bt-panel-view,.bt-bcard{animation:none}}
`

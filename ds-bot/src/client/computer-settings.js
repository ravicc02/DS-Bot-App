import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { computerError } from './computer-error.js'
import { writeClipboard } from './dsh-primitives.js'
import { CheckIcon, CloseIcon } from './icons.js'
import { Segmented, useLinger } from './motion.js'
import { t } from './i18n.js'

const installCommands = {
  docker: 'winget install --exact --id Docker.DockerDesktop',
  podman: 'winget install --exact --id RedHat.Podman-Desktop',
}

const PHASES = {
  'checking-runtime': 'Checking desktop runtime…', 'initializing-runtime': 'Initializing the Podman machine…',
  'starting-runtime': 'Starting the Podman machine…', 'enabling-runtime-limits': 'Enabling desktop resource limits…',
  'building-image': 'Building desktop image…',
  'downloading-image': 'Downloading desktop image…', 'checking-image': 'Verifying desktop image…',
  'checking-container': 'Checking desktop instance…', 'creating-container': 'Creating desktop instance…',
  'updating-resources': 'Applying desktop resource limits…',
  'starting-container': 'Starting desktop instance…', 'waiting-desktop': 'Waiting for the desktop to load…',
  'connecting-driver': 'Connecting to the desktop…', 'capturing-frame': 'Getting the first frame…',
}

function SetupDialog({ close, leaving, returnFocus, steps, managing, details, toggleDetails, check, busy, feedback, continueSetup, children }) {
  const dialog = useRef(null)
  useEffect(() => {
    const node = dialog.current
    node.showModal()
    return () => {
      node.close()
      returnFocus.current?.focus()
    }
  }, [returnFocus])
  return h('dialog', {
    className: 'bt-computer-setup', ref: dialog, 'data-leaving': leaving || undefined,
    'aria-labelledby': 'bt-computer-setup-title', 'data-managing': managing || undefined,
    onKeyDown: event => { if (event.key === 'Escape') event.stopPropagation() },
    onCancel: event => { event.preventDefault(); close() },
  }, h('div', { className: 'bt-computer-setup-layout', inert: leaving || undefined },
    h('header', null,
      h('h3', { id: 'bt-computer-setup-title' }, t(managing ? 'Manage private desktop' : 'Set up a private desktop')),
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), onClick: close }, h(CloseIcon))),
    h('div', { className: 'bt-computer-setup-body' },
      managing ? null : h('ol', { className: 'bt-computer-steps' }, steps.map(({ label, done, action, hint, extra }, index) =>
        h('li', { key: label, 'data-done': done || undefined, 'data-current': !done && steps.findIndex(step => !step.done) === index || undefined },
          h('span', { className: 'bt-computer-step-mark', role: 'img', 'aria-label': done ? t('Done') : `${index + 1}` }, done ? h(CheckIcon) : index + 1),
          h('div', { className: 'bt-computer-step-copy' },
            h('span', null, t(label)),
            hint ? h('span', { className: 'bt-set-hint' }, t(hint)) : null,
            action ? h('div', { className: 'bt-computer-step-actions' }, action) : null, extra)))),
      managing || details ? children : null),
    feedback,
    h('footer', null,
      managing ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-expanded': details, onClick: toggleDetails }, t(details ? 'Hide details' : 'Show details')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: close }, t('Close')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm' + (continueSetup ? '' : ' bt-computer-check'), onClick: check, disabled: busy }, t('Refresh status')),
      continueSetup ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-computer-check',
        onClick: continueSetup, disabled: busy }, t('Open private desktop')) : null)))
}

export function ComputerSettings({ Section, Row, bots, privateSetup = false, onContinue }) {
  const bridge = globalThis.window?.dsBotApp?.computer
  const [stage, setStage] = useState(null)
  const [idle, setIdle] = useState('')
  const [memory, setMemory] = useState('')
  const [cpuCount, setCpuCount] = useState('')
  const [settings, setSettings] = useState(null)
  const [instances, setInstances] = useState(null)
  const botIds = JSON.stringify(bots.map(bot => bot.id).sort())
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState(null)
  const [elapsed, setElapsed] = useState(0)
  const operation = useRef(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  const [setupFrame, setSetupFrame] = useState(null)
  const [checkBot, setCheckBot] = useState('')
  const [open, setOpen] = useState(privateSetup ? 'setup' : null)
  const [details, setDetails] = useState(false)
  const setupButton = useRef(null)
  const [shown, leaving] = useLinger(open, 160)

  useEffect(() => {
    if (!bridge?.settings) return undefined
    let active = true
    const report = failure => { if (active) setError(computerError(failure)) }
    void bridge.settings('read').then(result => {
      if (active) {
        setSettings(result)
        setIdle(String(result.idleMinutes))
        setMemory(String(result.limits.memoryGb))
        setCpuCount(String(result.limits.cpus))
      }
    }, report)
    void readStatus(bridge, botIds).then(result => {
      if (active) applyStatus(result)
    }, report)
    return () => { active = false }
  }, [bridge, botIds])

  useEffect(() => {
    if (!bridge?.settings || busy || (stage !== 'install' && stage !== 'start')) return undefined
    let active = true
    let timer
    async function check() {
      try {
        const result = await readStatus(bridge, botIds)
        if (!active) return
        if (result.stage !== stage) {
          applyStatus(result)
          setError('')
          return
        }
      } catch (failure) {
        if (active) setError(computerError(failure))
      }
      if (active) timer = setTimeout(check, 2500)
    }
    timer = setTimeout(check, 2500)
    return () => { active = false; clearTimeout(timer) }
  }, [bridge, botIds, busy, stage])

  useEffect(() => bridge?.onProgress?.(value => {
    if (value.id === operation.current && Object.hasOwn(PHASES, value.phase)) setProgress(value)
  }), [bridge])

  useEffect(() => {
    if (!busy) return undefined
    const started = Date.now()
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [busy])

  if (!bridge?.settings) return null
  async function run(op, action, success) {
    if (operation.current) return
    const id = globalThis.crypto.randomUUID()
    operation.current = id
    setBusy(op)
    setProgress(null)
    setElapsed(0)
    setError('')
    setNotice('')
    setPreview(null)
    try {
      if (await action(id) && success) setNotice(success)
    } catch (failure) {
      if (op !== 'check') {
        try { await recheck() } catch { /* Keep the original error. */ }
      }
      setError(computerError(failure))
    } finally {
      operation.current = null
      setBusy('')
    }
  }
  const button = (label, action, disabled = !!busy) => h('button', { className: 'bt-soft bt-soft-sm', type: 'button', disabled, onClick: action }, t(label))
  function applyStatus(result) {
    setStage(result.stage)
    setInstances(result.instances)
    setSetupFrame(frame => frame && result.instances?.some(instance => instance.id === frame.id && instance.running) ? frame : null)
  }
  async function recheck() {
    applyStatus(await readStatus(bridge, botIds))
    return true
  }
  function savePolicy(privateMode, maxInstances) {
    setSetupFrame(null)
    void run('save', async () => {
      setSettings(await bridge.settings('policy', { privateMode, maxInstances }))
      if (privateMode !== settings.privateMode) await recheck()
      return true
    }, 'Saved')
  }
  const memoryGb = Number(memory)
  const cpus = Number(cpuCount)
  const canSaveLimits = settings && Number.isInteger(memoryGb) && memoryGb >= 2 && memoryGb <= 128
    && Number.isInteger(cpus) && cpus >= 1 && cpus <= 64
    && (memoryGb !== settings.limits.memoryGb || cpus !== settings.limits.cpus)
  const runtimeRunning = ['prepare', 'rebuild', 'prepared'].includes(stage)
  const runtimeInstalled = stage === 'start' || runtimeRunning
  const running = instances?.filter(instance => instance.running).length
  const prepared = stage === 'prepared'
  const podman = settings?.runtime === 'podman'
  const installCommand = podman ? installCommands.podman : installCommands.docker
  const startRuntime = () => void run('start', async id => { await bridge.settings('start', null, id); return recheck() })
  const perBot = settings?.privateMode === 'per-bot'
  const pooled = settings?.privateMode === 'pool'
  const startupBot = perBot ? (bots.find(bot => bot.id === checkBot) ?? bots[0]) : undefined
  const startupSeat = pooled ? Number(checkBot) > 0 && Number(checkBot) <= settings.maxInstances ? Number(checkBot) : 1 : undefined
  const seatLabel = seat => `${t('Pool desktop')} ${seat}`
  const instanceOperator = instance => instance.seat ? `pool-seat-${instance.seat}` : instance.botId ?? null
  const setupOperator = startupSeat ? `pool-seat-${startupSeat}` : startupBot?.id ?? null
  const setupLabel = startupSeat ? seatLabel(startupSeat) : startupBot?.name ?? t('Private desktop')
  const matchesSetup = instance => setupOperator === null ? instance.scope === null : instanceOperator(instance) === setupOperator
  function copyInstallCommand() {
    void run('copy', async () => {
      if (!await writeClipboard(installCommand)) throw new Error('Could not copy. Select the text below and copy it.')
      return true
    }, 'Copied')
  }
  function prepare(rebuild) {
    setSetupFrame(null)
    void run('prepare', async id => {
      if (!await bridge.setup(rebuild, id)) return false
      await recheck()
      return true
    })
  }
  function stop(instance) {
    setSetupFrame(null)
    void run('stop', async () => {
      const stopped = instance ? await bridge.settings('stop-instance', instance.scope) : await bridge.settings('stop')
      if (!stopped) return false
      await recheck()
      return true
    }, instance ? 'The private desktop stopped.' : 'The private desktops stopped.')
  }
  function remove(instance) {
    setSetupFrame(null)
    void run('delete', async () => {
      if (!await bridge.settings('delete-instance', { scope: instance.scope, id: instance.id })) return false
      await recheck()
      return true
    }, 'The private desktop was deleted.')
  }
  function start(instance, restart) {
    void run('desktop', async id => {
      if (!await bridge.settings(restart ? 'restart-instance' : 'start-instance', instanceOperator(instance), id)) return false
      await recheck()
      return true
    }, 'The private desktop is running.')
  }
  function createDesktop() {
    void run('create', async id => {
      const image = await bridge.settings('start-instance', setupOperator, id)
      const result = await readStatus(bridge, botIds)
      applyStatus(result)
      const instance = result.instances?.find(instance => matchesSetup(instance) && instance.running)
      if (!instance) throw new Error('The private desktop is stopped.')
      setSetupFrame({ id: instance.id, image, label: setupLabel })
      return true
    })
  }
  function selectStartupDesktop() {
    if (pooled) return h('select', {
      className: 'bt-select', 'aria-label': t('Pool desktop'), value: startupSeat, disabled: !!busy,
      onChange: event => { setCheckBot(event.target.value); setPreview(null); setSetupFrame(null) },
    }, Array.from({ length: settings.maxInstances }, (_, index) =>
      h('option', { key: index + 1, value: index + 1 }, seatLabel(index + 1))))
    return perBot && startupBot ? h('select', {
    className: 'bt-select', 'aria-label': t('Bot for startup check'), value: startupBot.id, disabled: !!busy,
    onChange: event => { setCheckBot(event.target.value); setPreview(null); setSetupFrame(null) },
    }, bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))) : null
  }
  function viewScreen(scope, operator, label) {
    if (preview?.scope === scope) {
      setPreview(null)
      return
    }
    void run('check', async () => {
      const image = await bridge.settings(scope === 'startup' ? 'startup' : 'preview-instance', operator)
      setPreview({ scope, label, image })
      return true
    }, scope === 'startup' ? 'The private desktop started and returned a screenshot.' : undefined)
  }
  const previewImage = frame => h('img', {
    className: 'bt-computer-settings-preview', alt: frame.label,
    src: `data:${frame.image.mediaType};base64,${frame.image.data}`,
  })
  const previewFor = scope => preview?.scope === scope ? previewImage(preview) : null
  const visibleInstances = instances && prepared && settings?.privateMode === 'shared' && !instances.some(instance => instance.scope === null)
    ? [{ scope: null, running: false }, ...instances] : instances
  const listedInstances = instances && prepared && pooled
    ? [...Array.from({ length: settings.maxInstances }, (_, index) => index + 1).filter(seat => !instances.some(instance => instance.seat === seat))
      .map(seat => ({ scope: `pool-seat-${seat}`, seat, running: false })), ...instances]
      .sort((a, b) => (a.seat ?? Infinity) - (b.seat ?? Infinity))
    : visibleInstances
  const minutes = Number(idle)
  const invalid = idle === '' || !Number.isSafeInteger(minutes) || minutes < 0 || minutes > 1440

  const setupInstance = instances?.find(matchesSetup)
  const setupReady = prepared && Boolean(setupInstance?.running && setupFrame?.id === setupInstance.id)
  const progressView = fallback => {
    const label = t(PHASES[progress?.phase] ?? fallback)
    const { step, total } = progress?.detail ?? {}
    return h('div', { className: 'bt-computer-progress' },
      h('div', { role: 'status' }, label, step && total ? ` ${step}/${total}` : ''),
      h('time', null, `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`),
      h('progress', { 'aria-label': label, ...(step && total ? { value: step, max: total } : {}) }))
  }
  const canManage = prepared && Boolean(instances?.length)
  const steps = [
    { label: 'Install the desktop runtime', done: runtimeInstalled,
      action: stage === 'install' && settings ? button(podman ? 'Podman installation guide' : 'Docker Desktop installation guide',
        () => void run('install', () => bridge.settings('install'))) : null,
      hint: stage === 'install' && settings ? (podman ? 'Install Podman Desktop with the WSL 2 backend, then return here.'
        : 'Install Docker Desktop with the WSL 2 backend, then return here.') : undefined },
    { label: 'Start the desktop runtime', done: runtimeRunning,
      action: stage === 'start' && settings ? button(podman ? 'Start Podman machine' : 'Open Docker Desktop', startRuntime) : null,
      hint: stage === 'start' && settings ? (podman ? 'The first start may download the WSL 2 environment.'
        : 'Finish Docker Desktop setup and wait for the Linux engine.') : undefined,
      extra: busy === 'start' && podman ? progressView('Checking desktop runtime…') : null },
    { label: 'Desktop preparation', done: prepared,
      action: runtimeRunning && !prepared ? button(stage === 'rebuild' ? 'Rebuild desktop' : 'Prepare desktop', () => prepare(stage === 'rebuild')) : null,
      hint: stage === 'prepare' && busy !== 'prepare' ? 'The first setup may take several minutes.' : undefined,
      extra: busy === 'prepare' ? progressView('Preparing the private desktop…') : null },
    { label: 'Start the private desktop', done: setupReady,
      hint: prepared && perBot && !startupBot ? 'Add a Bot to check its private desktop.' : undefined,
      action: prepared && !setupReady ? h(Fragment, null, selectStartupDesktop(),
        button(setupInstance?.id ? 'Start desktop' : 'Create desktop', createDesktop, !!busy || (perBot && !startupBot))) : null,
      extra: busy === 'create' ? progressView('Loading desktop…') : setupReady ? previewImage(setupFrame) : null },
  ]
  const feedback = busy || notice || error ? h('div', { className: 'bt-computer-feedback' },
    busy === 'desktop' || ((busy === 'prepare' || busy === 'create') && shown === 'manage') ? progressView('Loading desktop…')
      : busy === 'prepare' || busy === 'create' || (busy === 'start' && podman) ? null
        : busy || notice ? h('span', { className: 'bt-muted', role: 'status' }, t(busy ? 'Working…' : notice)) : null,
    error ? h('p', { className: 'bt-error', role: 'alert' }, error) : null) : null

  const management = h(Section, { title: t('Private desktop'), className: 'bt-computer-setup-details' },
    stage === 'install' ? h(Row, { label: t('Install from PowerShell'), hint: t('If WinGet is unavailable, use the installation guide.') },
      h('code', { className: 'bt-computer-install-command' }, installCommand),
      button('Copy', copyInstallCommand)) : null,
    h(Row, { label: t('Startup check'), hint: prepared && perBot && !startupBot ? t('Add a Bot to check its private desktop.') : undefined },
      prepared ? selectStartupDesktop() : null,
      button(preview?.scope === 'startup' ? 'Hide screenshot' : 'Check startup',
        () => viewScreen('startup', setupOperator, setupLabel),
        !!busy || !settings || !prepared || (perBot && !startupBot))),
    previewFor('startup'),
    h(Row, { label: t('Running desktops') },
      h('span', { className: 'bt-muted' }, running ?? '—'),
      button('Stop desktops', () => stop(), !!busy || !running)),
    listedInstances?.map(instance => {
      const canStart = prepared && (instance.seat ? pooled && instance.seat <= settings.maxInstances
        : instance.scope === null ? settings?.privateMode === 'shared' : perBot && instance.botId)
      const name = instance.seat ? seatLabel(instance.seat) : instance.scope === null ? t('Shared private desktop')
        : bots.find(bot => bot.id === instance.botId)?.name ?? t('Former Bot')
      return h(Fragment, { key: instance.scope ?? 'shared' },
        h(Row, { className: 'bt-computer-instance', label: name },
          h('span', { className: 'bt-muted' }, t(instance.running ? 'Desktop running' : 'Desktop stopped')),
          instance.running ? button('Stop this desktop', () => stop(instance)) : null,
          canStart ? button(instance.running ? 'Restart desktop' : 'Start desktop', () => start(instance, instance.running)) : null,
          instance.running && prepared && (instance.scope === null || instance.botId || instance.seat)
            ? button(preview?.scope === instance.scope ? 'Hide screenshot' : 'View screen',
              () => viewScreen(instance.scope, instanceOperator(instance), name)) : null,
          instance.id ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-danger', disabled: !!busy,
            'aria-label': `${t('Delete desktop')} · ${name}`, onClick: () => remove(instance) }, t('Delete desktop')) : null),
        previewFor(instance.scope))
    }),
    h(Row, { label: t('Desktop isolation'), hint: t('Each Bot can have its own desktop, workspace, and browser profile.') },
      h(Segmented, { className: 'bt-computer-isolation', label: t('Desktop isolation'), value: settings?.privateMode ?? 'shared' },
        [['shared', 'Shared desktop'], ['per-bot', 'Desktop per Bot'], ['pool', 'Desktop pool']].map(([mode, label]) => h('button', {
          key: mode, type: 'button', 'aria-pressed': (settings?.privateMode ?? 'shared') === mode,
          disabled: !!busy || !settings, onClick: () => { if (mode !== settings.privateMode) savePolicy(mode, settings.maxInstances) },
        }, t(label))))),
    perBot || pooled ? h(Row, {
      label: t(pooled ? 'Pool size' : 'Maximum running desktops'),
      hint: t(pooled ? 'Reducing the pool size stops the pooled desktops. Their files are kept.' : 'Stopped desktops keep their workspace and browser profile.'),
    }, h('select', { className: 'bt-select', 'aria-label': t(pooled ? 'Pool size' : 'Maximum running desktops'), 'data-computer-limit': true, value: settings.maxInstances,
      disabled: !!busy, onChange: event => savePolicy(settings.privateMode, Number(event.target.value)) },
    Array.from({ length: 8 }, (_, index) => h('option', { key: index + 1, value: index + 1 }, index + 1)))) : null,
    h(Row, { label: t('Memory (GiB)'), hint: t('Resource limits apply to each private desktop on its next start.') },
      h('input', { type: 'number', className: 'bt-select', min: 2, max: 128, step: 1, value: memory,
        'aria-label': t('Memory (GiB)'), disabled: !!busy || !settings, onChange: event => setMemory(event.target.value) })),
    h(Row, { label: t('CPU cores') },
      h('input', { type: 'number', className: 'bt-select', min: 1, max: 64, step: 1, value: cpuCount,
        'aria-label': t('CPU cores'), disabled: !!busy || !settings, onChange: event => setCpuCount(event.target.value) }),
      button('Save resource limits', () => void run('save', async () => {
        setSettings(await bridge.settings('limits', { memoryGb, cpus }))
        return true
      }, 'Saved'), !!busy || !canSaveLimits)),
    h(Row, { label: t('Stop when idle'), hint: t('Minutes. Set to 0 to keep the desktop running.') },
      h('input', { type: 'number', className: 'bt-select', min: 0, max: 1440, step: 1, value: idle,
        'aria-label': t('Idle minutes'), disabled: !!busy || !settings, onChange: event => setIdle(event.target.value) }),
      button('Save', () => void run('save', async () => {
        const result = await bridge.settings('idle', minutes)
        setIdle(String(result.idleMinutes))
        setSettings(result)
        return true
      }, 'Saved'), !!busy || !settings || invalid || minutes === settings.idleMinutes)),
    prepared ? h(Row, { label: t('Desktop preparation') }, button('Rebuild desktop', () => prepare(true))) : null,
    h(Row, { label: t('Desktop isolation details'), hint: t('No host folders or ports are shared. The desktop can only access its own network loopback.') },
      h('code', { className: 'bt-computer-install-command', title: t('Persistent workspace inside the desktop') }, '/home/cua/workspace')))

  return h(Section, { title: t('Private desktop'), className: 'bt-computer-settings' },
    h(Row, { label: stage === null ? '\u2014' : t(canManage ? 'Ready' : 'Not set up') },
      h('button', { ref: setupButton, type: 'button', className: 'bt-soft bt-soft-sm',
        onClick: () => { setDetails(false); setSetupFrame(null); setOpen(canManage ? 'manage' : 'setup'); if (!busy) void run('check', recheck) },
      }, t(canManage ? 'Manage' : 'Set up'))),
    shown ? h(SetupDialog, {
      close: () => setOpen(null), leaving, returnFocus: setupButton, steps, managing: shown === 'manage', details, toggleDetails: () => setDetails(value => !value),
      check: () => void run('check', recheck), busy: !!busy, feedback, continueSetup: (shown === 'manage' ? canManage : setupReady) ? onContinue : undefined,
    }, management) : feedback)
}

async function readStatus(bridge, botIds) {
  const stage = await bridge.settings('readiness')
  const instances = stage === 'prepared' || stage === 'rebuild' ? await bridge.settings('inventory', JSON.parse(botIds)) : null
  return { stage, instances }
}

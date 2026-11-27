import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { desktopRuntime, podmanProfilePath } from './docker-installation.mjs'
import { createDriver, pngFrame } from './driver.mjs'
import { defaultDesktopLimits, inspectDesktopLimits, resourceArgs, validDesktopLimits } from './limits.mjs'
import { openLiveDesktop } from './live.mjs'
import { openMcp } from './mcp.mjs'
import seccomp from './seccomp.json' with { type: 'json' }

const label = 'io.github.qingj01.dsbot.cua-instance'
const imageLabel = 'io.github.qingj01.dsbot.cua-image'
const imageVersion = '6'
const podmanImageVersions = ['5', imageVersion]
const imageVersions = ['2', '3', '4', ...podmanImageVersions]
const temporaryFiles = 'rw,nosuid,nodev,noexec,size=256m,mode=1777'
const imageIdPattern = /^sha256:[a-f0-9]{64}$/u
const containerIdPattern = /^[a-f0-9]{64}$/u
const scopePattern = /^[a-f0-9]{32}$/u
const bundledPodmanProfile = /^\/mnt\/[a-z]\/(?:[^/\r\n]+\/)*(?:resources|runtime)\/computer\/seccomp\.json$/u
export const privateDesktopScope = operator => operator === undefined ? null : createHash('sha256').update(operator).digest('hex').slice(0, 32)
const noValues = value => value == null || Object.keys(value).length === 0
const same = (values, expected) => Array.isArray(values) && values.length === expected.length && expected.every(value => values.includes(value))
const desktopChanged = () => new Error('The private desktop changed. Refresh the desktop list and try again.')
const missingImage = () => Object.assign(new Error('Prepare the private desktop first.'), { code: 'CUA_IMAGE_MISSING' })
const unsafe = () => new Error('The private desktop configuration changed. Review the desktop runtime resources before starting it again.')
// X can accept connections before XFCE maps the desktop, yielding a valid but black PNG.
const desktopReady = String.raw`set -eu
windows=$(LC_ALL=C /usr/bin/xwininfo -root -tree | awk '/[(]"xfdesktop" "Xfdesktop"[)]/ { print $1 }')
for window in $windows; do
    if LC_ALL=C /usr/bin/xprop -id "$window" _NET_WM_WINDOW_TYPE | grep -q '_NET_WM_WINDOW_TYPE_DESKTOP$' &&
       LC_ALL=C /usr/bin/xwininfo -id "$window" | grep -q 'Map State: IsViewable'; then
        exit 0
    fi
done
exit 1
`

export function imageBuildReporter(report) {
  const tails = new Map()
  return (chunk, stream = 'stdout') => {
    const lines = ((tails.get(stream) ?? '') + String(chunk)).split(/[\r\n]/u)
    tails.set(stream, lines.pop().slice(-2048))
    for (const line of lines) {
      const layer = /^(?:STEP (\d{1,3})\/(\d{1,3}):|#\d+ \[.*?\b(\d{1,3})\/(\d{1,3})\])/u.exec(line.trim())
      if (layer) {
        const step = Number(layer[1] ?? layer[3])
        const total = Number(layer[2] ?? layer[4])
        if (step > 0 && step <= total) report?.('building-image', { step, total })
      } else if (/^(?:Copying (?:blob|config)|Getting image source signatures|#\d+ .*?(?:pulling|downloading))/iu.test(line.trim())) {
        report?.('downloading-image')
      }
    }
  }
}

function validSecurity(options, version, podmanProfile) {
  if (!Array.isArray(options) || !options.includes('no-new-privileges')) return false
  if (version === '2' || version === '3') return options.length === 1
  if (options.length !== 2) return false
  const profile = options.find(option => typeof option === 'string' && option.startsWith('seccomp='))
  if (!profile) return false
  if (podmanProfile) return profile === `seccomp=${podmanProfile}`
  try { return isDeepStrictEqual(JSON.parse(profile.slice('seccomp='.length)), seccomp) } catch { return false }
}

const canonicalImageId = id => typeof id === 'string' && containerIdPattern.test(id) ? `sha256:${id}` : id

export function verifyContainer(info, imageId, instance, id, version = imageVersion, scope, podmanProfile) {
  const { name, mounts } = resources(instance, scope)
  const h = info?.HostConfig
  const c = info?.Config
  const podman = !!podmanProfile
  const binds = mounts.map(mount => `${mount.name}:${mount.path}:rprivate,nosuid,nodev,rbind`)
  if (!(podman ? podmanImageVersions : imageVersions).includes(version) || info?.Name !== (podman ? name : `/${name}`) || !containerIdPattern.test(info.Id) || (id !== undefined && info.Id !== id) || (podman ? canonicalImageId(info.Image) : info.Image) !== imageId || c?.Labels?.[label] !== instance
    || c.User !== '1000:1000' || !same(c.Entrypoint, ['/usr/local/bin/ds-bot-desktop']) || !noValues(c.Cmd)
    || h?.NetworkMode !== 'none' || h.Privileged !== false || h.PublishAllPorts !== false || h.AutoRemove !== false
    || !inspectDesktopLimits(h, podman) || h.PidsLimit !== 384 || h.Init !== true
    || (podman ? !noValues(info.EffectiveCaps) || !noValues(info.BoundingCaps) : !same(h.CapDrop, ['ALL']))
    || !validSecurity(h.SecurityOpt, version, podmanProfile) || h.RestartPolicy?.Name !== 'no'
    || (podman ? !same(h.Binds, binds) : !noValues(h.Binds))
    || [h.CapAdd, h.Devices, h.DeviceRequests, h.DeviceCgroupRules, h.PortBindings, h.VolumesFrom].some(value => !noValues(value))
    || (version === '2' ? !noValues(h.Tmpfs) : !same(Object.keys(h.Tmpfs ?? {}), ['/tmp']) || h.Tmpfs['/tmp'] !== (podman ? `${temporaryFiles},rprivate` : temporaryFiles))
    || h.IpcMode !== 'private' || !['', 'private'].includes(h.PidMode) || h.UTSMode !== (podman ? 'private' : '')
    || (podman && (h.CgroupMode !== 'private' || h.Cgroups !== 'default' || h.UsernsMode !== ''
      || Object.keys(info.NetworkSettings?.Networks ?? {}).some(network => network !== 'none')))
    || Object.values(info.NetworkSettings?.Ports ?? {}).some(value => !noValues(value))
    || info.Mounts?.length !== mounts.length
    || !mounts.every(expected => info.Mounts.some(mount => mount.Type === 'volume' && mount.Driver === 'local'
      && mount.Name === expected.name && mount.Destination === expected.path && mount.RW === true
      && (!podman || (mount.Propagation === 'rprivate' && same(mount.Options, ['nosuid', 'nodev', 'rbind'])))))) throw unsafe()
  return info
}

function resources(instance, scope) {
  if (!/^[a-f0-9-]{36}$/u.test(instance) || (scope !== undefined && !scopePattern.test(scope))) throw unsafe()
  const name = `ds-bot-cua-${instance}${scope === undefined ? '' : `-bot-${scope}`}`
  return { name, mounts: [
    { name: `${name}-workspace`, path: '/home/cua/workspace' },
    { name: `${name}-chromium`, path: '/home/cua/.config/chromium' },
  ] }
}

export function dockerBackend(instance, { imageDir, imageFile, runtime = desktopRuntime('docker'), idleMinutes = () => 480, maxInstances = () => 2, desktopLimits = () => defaultDesktopLimits }) {
  const { name: sharedName } = resources(instance)
  const podman = runtime.name === 'podman'
  const seccompPath = join(dirname(imageDir), 'seccomp.json')
  const stableSeccompPath = join(dirname(imageFile), 'computer-seccomp.json')
  const podmanProfile = podman ? podmanProfilePath(stableSeccompPath) : undefined
  const command = async (...args) => (await runtime.command(args)).stdout.trim()
  const inspect = async (kind, id) => JSON.parse(await command(kind, 'inspect', id))[0]
  let daemon
  const desktops = new Map()
  let starting = Promise.resolve()
  let building
  let checking
  let closed = false

  async function verifyDaemon() {
    const id = await runtime.verify()
    if (!id || (daemon && daemon !== id)) throw unsafe()
    if (podman && !isDeepStrictEqual(JSON.parse(await readFile(seccompPath, 'utf8')), seccomp)) throw unsafe()
    daemon = id
  }

  async function verifyVolumes(scope, create) {
    const { mounts } = resources(instance, scope)
    if (create) {
      const existing = (await command('volume', 'ls', '--format', '{{.Name}}')).split(/\r?\n/u)
      for (const { name } of mounts) {
        if (!existing.includes(name)) await command('volume', 'create', '--label', `${label}=${instance}`, name)
      }
    }
    const volumes = JSON.parse(await command('volume', 'inspect', ...mounts.map(mount => mount.name)))
    if (!Array.isArray(volumes) || volumes.length !== mounts.length || !mounts.every(({ name }) => volumes.some(info =>
      info.Name === name && info.Driver === 'local' && info.Scope === 'local' && noValues(info.Options) && info.Labels?.[label] === instance))) throw unsafe()
  }

  async function verify({ id, imageId, version, scope }, replacing = false) {
    await verifyDaemon()
    await verifyVolumes(scope, false)
    const info = await inspect('container', id)
    const profile = replacing && podman ? previousProfile(info) ?? podmanProfile : podmanProfile
    return verifyContainer(info, imageId, instance, id, version, scope, profile)
  }

  // Podman records the old install path in inspect. Only replacement or status may accept it.
  function previousProfile(info) {
    const options = info?.HostConfig?.SecurityOpt
    if (!Array.isArray(options)) return undefined
    const path = options.find(option => typeof option === 'string' && option.startsWith('seccomp='))?.slice('seccomp='.length)
    return bundledPodmanProfile.test(path ?? '') ? path : undefined
  }

  async function preparePodmanProfile() {
    await writeFile(stableSeccompPath, JSON.stringify(seccomp), { flag: 'wx' }).catch(error => {
      if (error.code !== 'EEXIST') throw error
    })
    if (!isDeepStrictEqual(JSON.parse(await readFile(stableSeccompPath, 'utf8')), seccomp)) throw unsafe()
  }

  async function containers(running = false) {
    const list = await command('container', 'ls', ...(running ? [] : ['-a']), '--no-trunc', '--format', '{{.Names}}|{{.ID}}')
    return list.split(/\r?\n/u).filter(Boolean).flatMap(line => {
      const [name, id] = line.split('|')
      if (name !== sharedName && !name.startsWith(`${sharedName}-bot-`)) return []
      const scope = name === sharedName ? undefined : name.slice(`${sharedName}-bot-`.length)
      if (!containerIdPattern.test(id) || (scope !== undefined && !scopePattern.test(scope))) throw unsafe()
      return [{ id, scope }]
    })
  }

  async function imageRecord() {
    const text = await readFile(imageFile, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    if (text === undefined) return undefined
    const record = JSON.parse(text)
    if ((record?.runtime ?? 'docker') !== runtime.name || record?.daemon !== daemon || !imageVersions.includes(record.version) || !imageIdPattern.test(record?.id ?? '')) throw unsafe()
    return record
  }

  async function currentImage() {
    const record = await imageRecord()
    if (!record || record.version !== imageVersion) throw missingImage()
    const image = await inspect('image', record.id).catch(() => { throw missingImage() })
    const id = podman ? canonicalImageId(image?.Id) : image?.Id
    if (id !== record.id || image.Config?.Labels?.[imageLabel] !== imageVersion || image.Os !== 'linux' || image.Architecture !== 'amd64') throw unsafe()
    return id
  }

  async function build(rebuild, signal, report) {
    report?.('checking-runtime')
    await verifyDaemon()
    const old = await imageRecord()
    const existing = await containers()
    if (existing.length && !old) throw unsafe()
    if (!rebuild && old?.version === imageVersion && await currentImage().then(() => true, () => false)) return
    if (existing.length && !rebuild) throw new Error('Rebuild the private desktop to replace its existing container.')
    const selected = existing.map(entry => ({ ...entry, imageId: old.id, version: old.version }))
    const checked = await Promise.all(selected.map(desktop => verify(desktop, true)))
    for (const info of checked) {
      signal.throwIfAborted()
      if (info.State.Running) await command('container', 'stop', '--time', '3', info.Id)
    }
    const iidFile = `${imageFile}.${randomUUID()}`
    try {
      const progress = podman ? ['--format', 'docker'] : ['--progress', 'plain']
      report?.('building-image')
      const onOutput = imageBuildReporter(report)
      await runtime.command(['build', '--platform', 'linux/amd64', ...progress, '--iidfile', iidFile, imageDir],
        { signal, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024, onOutput }).catch(error => {
        if (signal.aborted) throw signal.reason
        if (error.killed) throw new Error('Preparing the private desktop timed out.')
        throw new Error('Could not build the private desktop image. Check the desktop runtime and its network connection.')
      })
      signal.throwIfAborted()
      report?.('checking-image')
      await verifyDaemon()
      const result = (await readFile(iidFile, 'utf8')).trim()
      const built = podman ? canonicalImageId(result) : result
      if (!imageIdPattern.test(built)) throw unsafe()
      const image = await inspect('image', built)
      const id = podman ? canonicalImageId(image?.Id) : image?.Id
      if (id !== built || image.Config?.Labels?.[imageLabel] !== imageVersion
        || image.Os !== 'linux' || image.Architecture !== 'amd64') throw unsafe()
      for (const desktop of selected) {
        const info = await verify(desktop, true)
        signal.throwIfAborted()
        if (info.State.Running !== false) throw unsafe()
        await command('container', 'rm', desktop.id)
      }
      await writeFile(iidFile, JSON.stringify({ daemon, id, version: imageVersion, runtime: runtime.name }))
      await rename(iidFile, imageFile)
    } finally {
      await rm(iidFile, { force: true })
    }
  }

  async function start(state, signal, runningOnly, report, expectedId) {
    report?.('checking-container')
    const { scope } = state
    const { name, mounts } = resources(instance, scope)
    await verifyDaemon()
    const imageId = await currentImage()
    const existing = (await containers()).find(entry => entry.scope === scope)?.id
    if (expectedId && existing !== expectedId) throw desktopChanged()
    const info = existing && verifyContainer(await inspect('container', existing), imageId, instance, existing, imageVersion, scope, podmanProfile)
    if (runningOnly && !info?.State.Running) throw new Error('The private desktop is stopped.')
    if (scope !== undefined && !info?.State.Running && (await containers(true)).filter(entry => entry.scope !== undefined).length >= maxInstances()) {
      throw new Error('All private desktops are in use. Stop an idle desktop or increase the instance limit in Settings.')
    }
    signal.throwIfAborted()
    const desired = desktopLimits()
    if (!validDesktopLimits(desired)) throw unsafe()
    if (!existing) report?.('creating-container')
    await verifyVolumes(scope, !existing)
    if (!isDeepStrictEqual(JSON.parse(await readFile(seccompPath, 'utf8')), seccomp)) throw unsafe()
    if (podman) await preparePodmanProfile()
    const id = existing ?? await command('container', 'create', '--name', name, '--label', `${label}=${instance}`,
      '--network', 'none', '--ipc', 'private', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--security-opt', `seccomp=${podman ? stableSeccompPath : seccompPath}`,
      '--tmpfs', `/tmp:${temporaryFiles}${podman ? ',notmpcopyup' : ''}`, ...resourceArgs(desired), '--pids-limit', '384', '--init', '--restart', 'no',
      ...mounts.flatMap(volume => ['--mount', `type=volume,source=${volume.name},target=${volume.path}`]), imageId)
    const selected = { id, imageId, scope }
    let checked = await verify(selected)
    signal.throwIfAborted()
    if (!checked.State.Running) {
      if (runningOnly) throw new Error('The private desktop is stopped.')
      const matches = config => isDeepStrictEqual(inspectDesktopLimits(config, podman), { ...desired, noSwap: true })
      const updating = existing && !matches(checked.HostConfig)
      if (updating) {
        report?.('updating-resources')
        await command('update', ...resourceArgs(desired), id).catch(cause => {
          throw new Error('Could not apply the desktop resource limits. Check the available CPU and memory in the desktop runtime.', { cause })
        })
        checked = await verify(selected)
        if (checked.State.Running) throw unsafe()
      }
      // Podman reports the previous limits for an exited container until it starts again.
      if (!(podman && updating) && !matches(checked.HostConfig)) throw unsafe()
      signal.throwIfAborted()
      state.desktop = selected
      report?.('starting-container')
      await command('container', 'start', id)
      try {
        const started = await verify(selected)
        if (!started.State.Running || !matches(started.HostConfig)) {
          throw new Error('The desktop runtime did not apply the requested resource limits.')
        }
      } catch (error) {
        await command('container', 'stop', '--time', '3', id)
        state.desktop = undefined
        throw error
      }
    }
    state.desktop = selected
    return selected
  }

  function stop(state) {
    clearTimeout(state.idleTimer)
    if (state.stopping) return state.stopping
    if (!state.desktop) return Promise.resolve()
    state.stopping = (async () => {
      const info = await verify(state.desktop)
      if (info.State.Running) await command('container', 'stop', '--time', '3', state.desktop.id)
      state.desktop = undefined
    })().finally(() => { state.stopping = undefined })
    return state.stopping
  }

  function scheduleIdle(state) {
    clearTimeout(state.idleTimer)
    if (closed || building || state.active || state.stopping || !state.desktop) return
    const delay = idleMinutes() * 60_000
    if (!delay) return
    state.idleTimer = setTimeout(() => {
      void stop(state).catch(error => { console.error(error.message) })
    }, delay)
    state.idleTimer.unref()
  }

  async function stopAll() {
    const results = await Promise.allSettled([...desktops.values()].map(stop))
    const failed = results.find(result => result.status === 'rejected')
    if (failed) throw failed.reason
  }

  async function managedDesktops(running) {
    try { await verifyDaemon() } catch (error) {
      if (error.code === 'CUA_RUNTIME_STOPPED' && ![...desktops.values()].some(state => state.desktop)) return []
      throw error
    }
    const entries = await containers(running)
    if (!entries.length) return []
    const record = await imageRecord()
    if (!record) throw unsafe()
    return Promise.all(entries.map(async entry => {
      const selected = { ...entry, imageId: record.id, version: record.version }
      const info = await verify(selected)
      return { ...selected, running: info.State.Running === true }
    }))
  }

  async function stopManaged() {
    await stopAll()
    for (const selected of await managedDesktops(true)) await stopVerified(selected)
  }

  async function stopVerified(selected) {
    if ((await verify(selected)).State.Running) await command('container', 'stop', '--time', '3', selected.id)
  }

  async function stopInstance(scope) {
    const key = scope ?? undefined
    const state = desktops.get(key)
    if (state?.active) throw new Error('This computer is already in use.')
    if (state?.desktop || state?.stopping) return stop(state)
    const selected = (await managedDesktops(true)).find(entry => entry.scope === key)
    if (selected) await stopVerified(selected)
  }

  async function deleteInstance(scope, id) {
    const key = scope ?? undefined
    const selected = (await managedDesktops(false)).find(entry => entry.scope === key && entry.id === id)
    if (!selected) throw desktopChanged()
    const state = desktops.get(key)
    if (state?.active || (state?.desktop && state.desktop.id !== id)) throw unsafe()
    if (state?.desktop || state?.stopping) await stop(state)
    else await stopVerified(selected)
    if ((await verify(selected)).State.Running) throw unsafe()
    // Keep named volumes so the next desktop can reopen the workspace and browser profile.
    await command('container', 'rm', selected.id)
    desktops.delete(key)
  }

  async function open(_selection, signal, operator, runningOnly = false, report, expectedId) {
    const scope = privateDesktopScope(operator) ?? undefined
    if (!desktops.has(scope)) desktops.set(scope, { scope })
    const state = desktops.get(scope)
    if (closed || building || state.active) throw new Error('The private desktop is unavailable while it is being prepared.')
    clearTimeout(state.idleTimer)
    state.active = true
    try {
      await state.stopping
      const initializing = starting.then(() => start(state, signal, runningOnly, report, expectedId))
      starting = initializing.catch(() => {})
      const selected = await initializing
      const { id } = selected
      report?.('waiting-desktop')
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted()
        if (await command('exec', id, '/bin/sh', '-c', desktopReady).then(() => true, () => false)) break
        if (attempt >= 30) throw new Error('The private desktop did not finish loading. Try refreshing the desktop.')
        await sleep(300, undefined, { signal })
      }
      report?.('connecting-driver')
      const { binary, prefix } = await runtime.connect()
      signal.throwIfAborted()
      const connection = openMcp(binary, [...prefix, 'exec', '-i', '--env', 'CUA_DRIVER_RS_TELEMETRY_ENABLED=0', id,
        '/opt/venv/bin/cua-driver', 'mcp', '--direct', '--embedded'], { env: runtime.env })
      const driver = await createDriver(connection, { signal, guard: async () => {
        if (!(await verify(selected)).State.Running) throw new Error('The private desktop is stopped.')
      } })
      let live
      return {
        run: driver.run,
        async openLive(port) {
          if (live || !(await verify(selected)).State.Running) throw new Error('The private desktop is unavailable.')
          signal.throwIfAborted()
          live = openLiveDesktop({ binary, prefix, id, env: runtime.env, port, signal })
          return live.done
        },
        async close() {
          try { await Promise.all([driver.close(), live?.close()]) } finally { state.active = false; scheduleIdle(state) }
        },
      }
    } catch (error) {
      try {
        // A view can close while its driver is opening. Its lease ends, but the desktop keeps running.
        if (!signal.aborted && !runningOnly) await stop(state)
      } catch { throw new AggregateError([error], 'The private desktop could not be stopped.') }
      finally { state.active = false; scheduleIdle(state) }
      throw error
    }
  }

  async function watchFrame(operator, id, signal) {
    if (closed || building || !containerIdPattern.test(id)) throw desktopChanged()
    signal.throwIfAborted()
    await verifyDaemon()
    const record = await imageRecord()
    if (!record) throw desktopChanged()
    const selected = { id, scope: privateDesktopScope(operator) ?? undefined, imageId: record.id, version: record.version }
    if (!(await verify(selected)).State.Running) throw desktopChanged()
    signal.throwIfAborted()
    // The capture process has no input channel and does not compete with the Bot's driver lease.
    const { stdout } = await runtime.command(['exec', id, '/usr/bin/ffmpeg', '-v', 'error', '-nostdin', '-f', 'x11grab',
      '-video_size', '1280x900', '-i', ':1', '-frames:v', '1', '-c:v', 'png', '-threads', '1', '-f', 'image2pipe', 'pipe:1'], {
      signal, encoding: 'buffer', maxBuffer: 6 * 1024 * 1024, timeout: 8000,
    }).catch(() => {
      signal.throwIfAborted()
      throw new Error('The desktop screen could not be captured. Try again in a moment.')
    })
    signal.throwIfAborted()
    return pngFrame(stdout.toString('base64'))
  }

  async function startAndObserve(operator, { checkOnly = false, runningOnly = false, report } = {}) {
    if (closed || checking || building) throw new Error('The private desktop is unavailable while it is being prepared.')
    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(65_000)])
    const done = (async () => {
      const scope = privateDesktopScope(operator) ?? undefined
      const wasRunning = checkOnly && (await managedDesktops(true)).some(entry => entry.scope === scope)
      signal.throwIfAborted()
      const driver = await open(undefined, signal, operator, runningOnly || wasRunning, report)
      try {
        report?.('capturing-frame')
        return await driver.run({ kind: 'observe' })
      } finally {
        try { await driver.close() } finally {
          if (checkOnly && !wasRunning) await stop(desktops.get(scope))
        }
      }
    })()
    checking = { abort, done }
    try { return await done } finally { checking = undefined }
  }

  return {
    open, stopManaged, stopInstance, deleteInstance, watchFrame,
    inventory: async () => (await managedDesktops(false)).map(({ scope, running, id }) => ({ scope: scope ?? null, running, id })),
    scheduleIdle: () => { for (const state of desktops.values()) scheduleIdle(state) },
    async readiness() {
      if (!await runtime.installed()) return 'install'
      try { await verifyDaemon() } catch (error) {
        if (['CUA_RUNTIME_STOPPED', 'CUA_CGROUP_UNAVAILABLE'].includes(error.code)) return 'start'
        throw error
      }
      let imageId
      try { imageId = await currentImage() } catch (error) {
        if (error.code === 'CUA_IMAGE_MISSING') return (await containers()).length ? 'rebuild' : 'prepare'
        throw error
      }
      if (podman) {
        let movedProfile = false
        for (const { id, scope } of await containers()) {
          const info = await inspect('container', id)
          const legacy = previousProfile(info)
          if (legacy) {
            await verifyVolumes(scope, false)
            verifyContainer(info, imageId, instance, id, imageVersion, scope, legacy)
            movedProfile = true
          }
        }
        if (movedProfile) return 'rebuild'
      }
      return 'prepared'
    },
    checkStartup: operator => startAndObserve(operator, { checkOnly: true }),
    previewInstance: operator => startAndObserve(operator, { runningOnly: true }),
    startInstance: (operator, report) => startAndObserve(operator, { report }),
    async setup(rebuild, report) {
      if (closed || building || checking || [...desktops.values()].some(state => state.active)) throw new Error('The private desktop is unavailable while it is being prepared.')
      for (const state of desktops.values()) clearTimeout(state.idleTimer)
      const abort = new AbortController()
      const pending = { abort, done: undefined }
      building = pending
      pending.done = (async () => {
        if (rebuild) await stopAll()
        await build(rebuild, abort.signal, report)
      })()
      try { await pending.done } finally { building = undefined; for (const state of desktops.values()) scheduleIdle(state) }
    },
    async close() {
      closed = true
      const cancelled = new Error('Desktop preparation was cancelled.')
      building?.abort.abort(cancelled)
      checking?.abort.abort(cancelled)
      await Promise.allSettled([building?.done, checking?.done, starting])
      await stopAll()
    },
  }
}

export const newComputerInstance = () => randomUUID()

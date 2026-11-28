import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, win32 } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const machineName = 'ds-bot-cua'
const podmanSocket = '/run/user/1000/podman/podman.sock'
const machineDistro = `podman-${machineName}`
const wsl = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
const apiProbeTimeout = 3_000
const apiProbeAttempts = 6
const runtimeConflict = () => new Error('Stop the other Podman machine before starting the private desktop.')
const apiNotReady = () => new Error('The Podman machine is running, but its desktop service did not become ready. Restart the Podman machine and try again.')
const dockerPipe = 'npipe:////./pipe/dockerDesktopLinuxEngine'
const cgroupUnavailable = 'The Podman machine could not enable resource limits for the private desktop.'
// The rootless API service can start in app.slice without delegated controllers after WSL boots.
// This override is scoped to the dedicated guest and expires when that guest shuts down.
const enableDelegation = String.raw`set -eu
test "$XDG_RUNTIME_DIR" = /run/user/1000
config="$XDG_RUNTIME_DIR/systemd/user/podman.service.d"
install -d -m 700 "$config"
printf '[Service]\nSlice=user.slice\n' > "$config/90-ds-bot-cgroup.conf"
systemctl --user daemon-reload
systemctl --user restart podman.service`
const isFile = file => stat(file).then(info => info.isFile(), error => {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
  throw error
})

export async function findDockerDesktop(env = process.env) {
  const roots = [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'DockerDesktop'),
    ...[env.ProgramW6432, env.ProgramFiles].filter(Boolean).map(root => join(root, 'Docker', 'Docker')),
  ]
  for (const root of new Set(roots.filter(root => root && isAbsolute(root)))) {
    const desktop = join(root, 'Docker Desktop.exe')
    const binary = join(root, 'resources', 'bin', 'docker.exe')
    if (await isFile(desktop) && await isFile(binary)) return { desktop, binary }
  }
}

export async function findPodman(env = process.env) {
  const roots = [env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'), env.ProgramW6432, env.ProgramFiles]
  for (const root of new Set(roots.filter(root => root && isAbsolute(root)))) {
    const binary = join(root, 'Podman', 'podman.exe')
    if (await isFile(binary)) return binary
  }
}

const stopped = (runtime, message) => Object.assign(new Error(message ?? (runtime === 'podman'
  ? 'Start the Podman machine to use the private desktop.'
  : 'Start Docker Desktop with the Linux engine to use the private desktop.')), { code: 'CUA_RUNTIME_STOPPED' })
const invalidMachine = () => new Error('The private desktop needs a rootless Podman machine using WSL 2.')
const missingControllers = () => Object.assign(new Error(cgroupUnavailable), { code: 'CUA_CGROUP_UNAVAILABLE' })

export function podmanProfilePath(file) {
  const path = win32.resolve(file).replaceAll('\\', '/')
  if (!/^[A-Za-z]:\//u.test(path)) throw new Error('The private desktop needs an app installed on a local drive.')
  return `/mnt/${path[0].toLowerCase()}${path.slice(2)}`
}

export function desktopRuntime(name, { run = exec, locatePodman = findPodman, pause = sleep } = {}) {
  const podman = name === 'podman'
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:DOCKER_|BUILDKIT_|CONTAINER_|CONTAINERS_|PODMAN_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$)/iu.test(key)))
  if (podman) env.CONTAINERS_MACHINE_PROVIDER = 'wsl'
  const options = { env, windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }
  const find = podman ? locatePodman : async () => (await findDockerDesktop())?.binary
  let activeMachine
  let starting
  let inspecting

  async function inspectMachine(binary) {
    let stdout
    try {
      ({ stdout } = await run(binary, ['machine', 'inspect', machineName], options))
    } catch (error) {
      if (error.code === 125 && /\bds-bot-cua: VM does not exist\b/u.test(error.stderr ?? '')) return
      if (error.killed) throw new Error('The private desktop runtime did not respond. Try again in a moment.', { cause: error })
      throw new Error('Could not check the Podman machine. Check Podman Desktop and try again.', { cause: error })
    }
    const info = JSON.parse(stdout)[0]
    const ssh = info?.SSHConfig
    if (info?.Name !== machineName || win32.basename(info.ConfigDir?.Path ?? '') !== 'wsl'
      || !Number.isFinite(Date.parse(info.Created)) || info.Rootful !== false || !/^[a-z_][a-z0-9_-]*$/iu.test(ssh?.RemoteUsername ?? '')
      || !Number.isSafeInteger(ssh.Port) || ssh.Port < 1 || ssh.Port > 65535 || !isAbsolute(ssh.IdentityPath ?? '')) throw invalidMachine()
    return { id: info.Created, running: info.State === 'running', ssh }
  }

  function machine(binary) {
    if (inspecting?.binary === binary) return inspecting.result
    const request = { binary, result: inspectMachine(binary) }
    request.result = request.result.finally(() => { if (inspecting === request) inspecting = undefined })
    inspecting = request
    return request.result
  }

  async function connect() {
    const binary = await find()
    if (!binary) throw stopped(name)
    if (!podman) return { binary, prefix: ['--host', dockerPipe] }
    const current = await machine(binary)
    if (!current?.running) throw stopped(name)
    if (activeMachine && activeMachine !== current.id) throw invalidMachine()
    const { RemoteUsername, Port, IdentityPath } = current.ssh
    return { binary, prefix: ['--url', `ssh://${RemoteUsername}@127.0.0.1:${Port}${podmanSocket}`, '--identity', IdentityPath], id: current.id }
  }

  async function command(args, overrides = {}) {
    const { binary, prefix } = await connect()
    const { onOutput, ...settings } = overrides
    const task = run(binary, [...prefix, ...args], { ...options, ...settings })
    if (onOutput) {
      task.child?.stdout?.on('data', data => onOutput(data, 'stdout'))
      task.child?.stderr?.on('data', data => onOutput(data, 'stderr'))
    }
    return task
  }

  async function otherPodmanRunning() {
    const { stdout } = await run(wsl, ['--list', '--running', '--quiet'], { ...options, encoding: 'utf16le' })
      .catch(() => ({ stdout: '' }))
    return stdout.split(/\r?\n/u).map(line => line.trim().toLowerCase())
      .some(distro => distro.startsWith('podman-') && distro !== machineDistro)
  }

  async function podmanHost({ binary, prefix }, timeout = options.timeout) {
    const { stdout } = await run(binary, [...prefix, 'info', '--format', 'json'], { ...options, timeout })
      .catch(() => { throw stopped(name) })
    const host = JSON.parse(stdout).host
    if (host?.os !== 'linux' || host.arch !== 'amd64' || host.security?.rootless !== true || host.security?.seccompEnabled !== true
      || host.cgroupVersion !== 'v2' || host.remoteSocket?.path !== `unix://${podmanSocket}`) throw invalidMachine()
    return host
  }

  async function waitForPodman(connection) {
    for (let tries = 0; tries < apiProbeAttempts; tries++) {
      try {
        return await podmanHost(connection, apiProbeTimeout)
      } catch (error) {
        if (error.code !== 'CUA_RUNTIME_STOPPED') throw error
      }
      if (tries === 0 && await otherPodmanRunning()) throw runtimeConflict()
      if (tries + 1 < apiProbeAttempts) await pause(1_000)
    }
    throw apiNotReady()
  }

  const hasResourceLimits = host => ['cpu', 'memory', 'pids'].every(item => host.cgroupControllers?.includes(item))

  return {
    name, env, connect, command, installed: find,
    async verify() {
      const connection = await connect()
      const { binary, prefix, id } = connection
      if (!podman) {
        const { stdout } = await run(binary, [...prefix, 'info', '--format', '{{.ID}}|{{.OSType}}|{{.Architecture}}|{{.OperatingSystem}}'], options)
          .catch(() => { throw stopped(name) })
        const [daemon, os, arch, product] = stdout.trim().split('|')
        return os === 'linux' && arch === 'x86_64' && product === 'Docker Desktop' ? daemon : undefined
      }
      if (!hasResourceLimits(await podmanHost(connection))) throw missingControllers()
      activeMachine = id
      return id
    },
    async start(open, progress = () => {}) {
      if (!podman) {
        const installation = await findDockerDesktop()
        if (!installation || await open(installation.desktop)) throw new Error('Could not open Docker Desktop. Check its installation.')
        return
      }
      if (starting) return starting
      starting = (async () => {
        progress('checking-runtime')
        const binary = await find()
        if (!binary) throw stopped(name)
        const current = await machine(binary)
        if (activeMachine && activeMachine !== current?.id) throw invalidMachine()
        if (!current?.running && await otherPodmanRunning()) throw runtimeConflict()
        const machineOptions = { ...options, timeout: 10 * 60_000 }
        try {
          if (!current) {
            progress('initializing-runtime')
            await run(binary, ['machine', 'init', '--provider=wsl', '--rootful=false', '--update-connection=false', machineName], machineOptions)
          }
          if (!current?.running) {
            progress('starting-runtime')
            await run(binary, ['machine', 'start', '--update-connection=false', machineName], machineOptions)
          }
        } catch (error) {
          if (error.killed) throw new Error('Starting the Podman machine timed out. Refresh status before trying again.')
          const details = error.stderr ?? ''
          if (/WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED|WSL_E_WSL2_KERNEL_FILE_NOT_FOUND|WSL_E_DISTRO_NOT_FOUND|0x80370102|0x800701bc/iu.test(details)) {
            throw new Error('Enable or update WSL 2 and restart this PC before starting the Podman machine.')
          }
          if (/already running|another.*running/iu.test(details)) throw runtimeConflict()
          throw new Error('Could not start the Podman machine. Check WSL 2 and Podman Desktop.')
        }
        progress('waiting-runtime')
        const connection = await connect()
        if (hasResourceLimits(await waitForPodman(connection))) return
        progress('enabling-runtime-limits')
        const script = Buffer.from(enableDelegation).toString('base64')
        try {
          await run(binary, ['machine', 'ssh', machineName, `printf %s ${script} | base64 -d | /bin/sh`], options)
          if (hasResourceLimits(await podmanHost(connection))) return
        } catch {
          // A failed repair cannot authorize a container without verified limits.
        }
        throw missingControllers()
      })()
      try { await starting } finally { starting = undefined }
    },
  }
}

export async function privateDesktopRuntime(imageFile) {
  try {
    const record = JSON.parse(await readFile(imageFile, 'utf8'))
    return record?.runtime === 'podman' ? 'podman' : 'docker'
  } catch (error) {
    // An unreadable record could belong to an existing Docker desktop.
    return error.code === 'ENOENT' ? 'podman' : 'docker'
  }
}

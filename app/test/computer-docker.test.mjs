import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { desktopRuntime, findDockerDesktop } from '../src/computer/docker-installation.mjs'
import { dockerBackend, verifyContainer } from '../src/computer/docker.mjs'
import seccomp from '../src/computer/seccomp.json' with { type: 'json' }

const instance = '12345678-1234-1234-1234-123456789abc'
const name = `ds-bot-cua-${instance}`
const image = `sha256:${'1'.repeat(64)}`
const id = '2'.repeat(64)
const volume = (suffix, Destination) => ({ Type: 'volume', Driver: 'local', Name: `${name}-${suffix}`, Destination, RW: true })
const config = () => ({
  Id: id, Name: `/${name}`, Image: image,
  Config: { Labels: { 'io.github.qingj01.dsbot.cua-instance': instance }, User: '1000:1000', Entrypoint: ['/usr/local/bin/ds-bot-desktop'] },
  HostConfig: {
    NetworkMode: 'none', Privileged: false, PublishAllPorts: false, AutoRemove: false, Memory: 2 * 1024 ** 3,
    NanoCpus: 2 * 10 ** 9, PidsLimit: 384, Init: true, CapDrop: ['ALL'], RestartPolicy: { Name: 'no' },
    SecurityOpt: ['no-new-privileges', `seccomp=${JSON.stringify(seccomp)}`],
    Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=256m,mode=1777' }, IpcMode: 'private', PidMode: '', UTSMode: '',
  },
  Mounts: [volume('workspace', '/home/cua/workspace'), volume('chromium', '/home/cua/.config/chromium')],
})

test('a managed desktop must have its recorded image and container IDs', () => {
  const container = config()
  assert.equal(verifyContainer(container, image, instance, id), container)
  assert.throws(() => verifyContainer(container, `sha256:${'3'.repeat(64)}`, instance, id), /configuration changed/u)
  assert.throws(() => verifyContainer(container, image, instance, '3'.repeat(64)), /configuration changed/u)
})

test('a foreign container cannot be used just because its name matches', () => {
  const container = config()
  container.Config.Labels = {}
  assert.throws(() => verifyContainer(container, image, instance), /configuration changed/u)
})

test('unapproved mounts, ports and networks invalidate a managed desktop', () => {
  for (const change of [
    container => container.Mounts.push({ Type: 'bind', Source: '/host', Destination: '/extra' }),
    container => { container.Mounts[0].Driver = 'other' },
    container => { container.HostConfig.PortBindings = { '5900/tcp': [{ HostIp: '127.0.0.1', HostPort: '5900' }] } },
    container => { container.HostConfig.NetworkMode = 'bridge' },
    container => { container.HostConfig.SecurityOpt = ['no-new-privileges', 'seccomp=unconfined'] },
  ]) {
    const container = config()
    change(container)
    assert.throws(() => verifyContainer(container, image, instance, id), /configuration changed/u)
  }
})


test('per-Bot desktop verification binds the container and both volumes to its scope', () => {
  const scope = 'a'.repeat(32)
  const scopedName = `${name}-bot-${scope}`
  const container = config()
  container.Name = `/${scopedName}`
  for (const mount of container.Mounts) mount.Name = mount.Name.replace(name, scopedName)
  assert.equal(verifyContainer(container, image, instance, id, '5', scope), container)
  assert.throws(() => verifyContainer(container, image, instance, id), /configuration changed/u)
  assert.throws(() => verifyContainer(container, image, instance, id, '5', 'b'.repeat(32)), /configuration changed/u)
  container.Mounts[1].Name = `${name}-chromium`
  assert.throws(() => verifyContainer(container, image, instance, id, '5', scope), /configuration changed/u)
})

test('Docker Desktop is detected after first install for either Windows installation mode', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsbot-docker-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = { LOCALAPPDATA: join(root, 'local'), ProgramFiles: join(root, 'programs') }
  const perUser = join(env.LOCALAPPDATA, 'Programs', 'DockerDesktop')
  const allUsers = join(env.ProgramFiles, 'Docker', 'Docker')
  async function install(location, complete = true) {
    const desktop = join(location, 'Docker Desktop.exe')
    const binary = join(location, 'resources', 'bin', 'docker.exe')
    await mkdir(dirname(binary), { recursive: true })
    await writeFile(desktop, '')
    if (complete) await writeFile(binary, '')
    return { desktop, binary }
  }
  assert.equal(await findDockerDesktop(env), undefined)
  await install(perUser, false)
  assert.equal(await findDockerDesktop(env), undefined)
  const machine = await install(allUsers)
  assert.deepEqual(await findDockerDesktop(env), machine)
  const user = await install(perUser)
  assert.deepEqual(await findDockerDesktop(env), user)
})


test('deleting a desktop requires its current container ID and keeps its volumes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsbot-cua-delete-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const imageFile = join(root, 'image.json')
  await writeFile(imageFile, JSON.stringify({ id: image, version: '5', daemon: 'test-daemon' }))
  const container = { ...config(), State: { Running: true } }
  const volumes = container.Mounts.map(({ Name }) => ({
    Name, Driver: 'local', Scope: 'local', Labels: container.Config.Labels,
  }))
  const changes = []
  let exists = true
  const backend = dockerBackend(instance, {
    imageDir: root, imageFile, runtime: {
      name: 'docker', verify: async () => 'test-daemon',
      async command(args) {
        const [kind, op, ...rest] = args
        let stdout = ''
        if (kind === 'container' && op === 'ls') stdout = exists ? `${name}|${id}` : ''
        else if (kind === 'volume' && op === 'inspect') stdout = JSON.stringify(volumes)
        else if (kind === 'container' && op === 'inspect' && rest[0] === id) stdout = JSON.stringify([container])
        else if (kind === 'container' && op === 'stop' && rest.at(-1) === id) {
          changes.push(args)
          container.State.Running = false
        } else if (kind === 'container' && op === 'rm' && rest.length === 1 && rest[0] === id) {
          changes.push(args)
          assert.equal(container.State.Running, false)
          exists = false
        } else assert.fail(`Unexpected command: ${args.join(' ')}`)
        return { stdout }
      },
    },
  })
  assert.deepEqual(await backend.inventory(), [{ scope: null, running: true, id }])
  await assert.rejects(backend.deleteInstance(null, '4'.repeat(64)), /Refresh the desktop list/u)
  assert.deepEqual(changes, [])
  await backend.deleteInstance(null, id)
  assert.deepEqual(await backend.inventory(), [])
  assert.deepEqual(changes, [['container', 'stop', '--time', '3', id], ['container', 'rm', id]])
})

const podmanInfo = (overrides = {}) => ({
  Name: 'ds-bot-cua', Created: '2026-11-26T01:40:38+08:00', State: 'running', Rootful: false,
  ConfigDir: { Path: String.raw`C:\podman\machine\wsl` },
  SSHConfig: { RemoteUsername: 'user', Port: 54321, IdentityPath: join(tmpdir(), 'podman-key') },
  ...overrides,
})

function podmanRuntime(run) {
  return desktopRuntime('podman', { locatePodman: async () => 'podman.exe', run })
}

test('Podman probes only the named machine and shares an in-flight inspection', async () => {
  const calls = []
  const runtime = podmanRuntime(async (_binary, args, options) => {
    calls.push(args)
    assert.equal(options.env.CONTAINERS_MACHINE_PROVIDER, 'wsl')
    return { stdout: JSON.stringify([podmanInfo()]) }
  })
  const [first, second] = await Promise.all([runtime.connect(), runtime.connect()])
  assert.deepEqual(first, second)
  assert.equal(first.id, podmanInfo().Created)
  assert.deepEqual(calls, [['machine', 'inspect', 'ds-bot-cua']])
  await runtime.connect()
  assert.equal(calls.length, 2, 'a later command revalidates the machine')
})

test('Podman preserves isolation checks and lets a timed-out probe be retried', async () => {
  let result
  const runtime = podmanRuntime(async () => {
    if (result instanceof Error) throw result
    return { stdout: JSON.stringify([result]) }
  })
  result = Object.assign(new Error('command timed out'), { killed: true })
  await assert.rejects(runtime.connect(), /runtime did not respond\. Try again/u)
  result = Object.assign(new Error('machine missing'), { code: 125, stderr: 'Error: ds-bot-cua: VM does not exist\n' })
  await assert.rejects(runtime.connect(), { code: 'CUA_RUNTIME_STOPPED' })
  result = Object.assign(new Error('different problem'), { code: 125 })
  await assert.rejects(runtime.connect(), /Could not check the Podman machine/u)
  result = podmanInfo({ State: 'stopped' })
  await assert.rejects(runtime.connect(), { code: 'CUA_RUNTIME_STOPPED' })
  for (const invalid of [{ Rootful: true }, { ConfigDir: { Path: 'C:/podman/hyperv' } }, { Created: null }]) {
    result = podmanInfo(invalid)
    await assert.rejects(runtime.connect(), /rootless Podman machine using WSL 2/u)
  }
  result = podmanInfo()
  assert.equal((await runtime.connect()).id, result.Created)
})

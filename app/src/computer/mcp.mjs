import { spawn } from 'node:child_process'

const LIMIT = 16 * 1024 * 1024
const DEADLINE = 12_000

export function openMcp(command, args, { env } = {}) {
  const child = spawn(command, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
  let ended = false
  let nextId = 0
  let buffer = ''
  const pending = new Map()
  const closed = new Promise(resolve => child.once('close', resolve))

  function close() {
    if (!ended) {
      ended = true
      for (const waiter of pending.values()) waiter.reject(new Error('The computer driver disconnected.'))
      child.stdin.destroy()
      child.kill()
    }
    return closed
  }

  child.once('error', close)
  child.once('exit', close)
  child.stdin.on('error', close)
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    if (ended) return
    buffer += chunk
    if (buffer.length > LIMIT) { void close(); return }
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim()
      buffer = buffer.slice(i + 1)
      if (line === '') continue
      let message
      try { message = JSON.parse(line) } catch { void close(); return }
      if (message?.jsonrpc !== '2.0') { void close(); return }
      const waiter = pending.get(message.id)
      if (!waiter) continue
      if (message.error || !Object.hasOwn(message, 'result')) waiter.reject(new Error('The computer driver rejected the request.'))
      else waiter.resolve(message.result)
    }
  })

  const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

  function request(method, params) {
    if (ended) return Promise.reject(new Error('The computer driver is disconnected.'))
    const id = ++nextId
    const result = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send({ id, method, params })
    })
    const timer = setTimeout(() => { void close() }, DEADLINE)
    return result.finally(() => { clearTimeout(timer); pending.delete(id) })
  }

  async function initialize() {
    const result = await request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'DS Bot App', version: '1' },
    })
    if (!['2024-11-05', '2025-03-26', '2025-06-18'].includes(result?.protocolVersion) || !result.capabilities?.tools) {
      throw new Error('The computer driver uses an unsupported protocol.')
    }
    send({ method: 'notifications/initialized' })
    const catalog = await request('tools/list', {})
    if (!Array.isArray(catalog?.tools) || catalog.nextCursor) throw new Error('The computer driver returned an unsupported tool list.')
    return catalog.tools
  }

  return { initialize, call: (name, args) => request('tools/call', { name, arguments: args }), close }
}

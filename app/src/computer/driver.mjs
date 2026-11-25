import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { openMcp } from './mcp.mjs'

const FRAME_LIFETIME = 30_000
const POINT = { x: 'number', y: 'number' }
const TOOLS = {
  click: ['click', POINT],
  type: ['type_text', { text: 'string' }],
  key: ['press_key', { key: 'string' }],
  scroll: ['scroll', { ...POINT, direction: 'string', amount: 'integer' }],
}
const INPUT_FIELDS = { target: 'target', delivery_mode: 'string' }
const WINDOWS_DRIVER_SHA = 'f87066ca41e6f8437923a372a2d3556c6131463f19d51a4be510f7e7c13eb4c5'
const WINDOWS_UIA_SHA = '955abd8d60daeffbf5cb7dd268f2532c7e5058abeb34aa09c1f598d0032dc156'
const KEY = /^(?:[a-z0-9]|return|tab|escape|up|down|left|right|space|backspace|delete|home|end|pageup|pagedown)$/u


function targetShape(schema) {
  if (!schema || typeof schema !== 'object') return false
  if (schema.oneOf || schema.anyOf) return (schema.oneOf ?? schema.anyOf).some(targetShape)
  const p = schema.properties
  if (schema.type !== 'object' || p?.kind?.type !== 'string' || !(p.kind.const === 'desktop' || p.kind.enum?.includes('desktop'))) return false
  return p.display_id?.type === 'string'
}

function verifySchema(catalog, name, fields) {
  const schema = catalog.find(tool => tool.name === name)?.inputSchema
  if (schema?.type !== 'object' || !schema.properties || schema.required?.some(key => !(key in fields))) throw new Error('The computer driver tool schema changed.')
  for (const [key, type] of Object.entries(fields)) {
    const property = schema.properties[key]
    if (type === 'target' ? !targetShape(property) : property?.type !== type) throw new Error('The computer driver tool schema changed.')
    if (key === 'delivery_mode' && !property.enum?.includes('foreground')) throw new Error('Targeted input is unavailable.')
  }
}

export function checkedAction(action) {
  const kind = action?.kind
  if (kind === 'observe') return { kind }
  if (kind === 'click' && [action.x, action.y].every(n => Number.isInteger(n) && n >= 0 && n < 16_384)) return { kind, x: action.x, y: action.y }
  if (kind === 'type' && typeof action.text === 'string' && action.text.length > 0 && action.text.length <= 2000 && !/[\p{Cc}]/u.test(action.text)) return { kind, text: action.text }
  if (kind === 'key' && typeof action.key === 'string' && KEY.test(action.key)) return { kind, key: action.key }
  if (kind === 'scroll' && [action.x, action.y].every(n => Number.isInteger(n) && n >= 0 && n < 16_384)
    && ['up', 'down'].includes(action.direction) && Number.isInteger(action.amount) && action.amount >= 1 && action.amount <= 8) {
    return { kind, x: action.x, y: action.y, direction: action.direction, amount: action.amount }
  }
  throw new Error('Invalid computer action.')
}

function imageFrom(result) {
  const image = result.content?.find(item => item?.type === 'image')
  const { data, mimeType } = image ?? {}
  if (mimeType !== 'image/png' || typeof data !== 'string' || data.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) throw new Error('The computer driver returned no usable PNG screenshot.')
  const header = Buffer.from(data.slice(0, 32), 'base64')
  if (header.length !== 24 || header.subarray(0, 16).toString('hex') !== '89504e470d0a1a0a0000000d49484452') throw new Error('The computer driver returned an invalid screenshot.')
  const width = header.readUInt32BE(16)
  const height = header.readUInt32BE(20)
  if (width === 0 || height === 0 || width > 8192 || height > 8192) throw new Error('The computer screenshot has an unsupported size.')
  return { data, mediaType: mimeType, width, height }
}

export async function createDriver(connection, { signal, guard, bindCapture = false }) {
  const target = { kind: 'desktop', display_id: 'primary' }
  let frame
  const abort = () => { void connection.close() }
  signal.addEventListener('abort', abort, { once: true })
  const close = async () => {
    signal.removeEventListener('abort', abort)
    await connection.close()
  }
  const request = async (name, args) => {
    signal.throwIfAborted()
    const result = await connection.call(name, args)
    signal.throwIfAborted()
    return result
  }
  function checked(result) {
    if (!result || result.isError === true || result.structuredContent?.success === false || result.structuredContent?.ok === false || !Array.isArray(result.content)) throw new Error('The computer driver could not complete this action.')
    return result
  }
  try {
    signal.throwIfAborted()
    const catalog = await connection.initialize()
    verifySchema(catalog, 'get_desktop_state', {})
    for (const [action, [name, fields]] of Object.entries(TOOLS)) {
      const capture = bindCapture && action === 'click' ? { capture_id: 'string' } : {}
      verifySchema(catalog, name, { ...INPUT_FIELDS, ...fields, ...capture })
    }
    return {
      close,
      async run(value) {
        const { kind: action, ...args } = checkedAction(value)
        await guard?.()
        if (action === 'observe') {
          frame = undefined
          const result = checked(await request('get_desktop_state', {}))
          const image = imageFrom(result)
          const captureId = result.structuredContent?.capture_id
          if (bindCapture && (typeof captureId !== 'string' || !captureId)) throw new Error('The computer driver returned no capture ID.')
          frame = { ...image, captureId, until: Date.now() + FRAME_LIFETIME }
          return image
        }
        const input = { ...args, target, delivery_mode: 'foreground' }
        if (action === 'click' || action === 'scroll') {
          if (!frame || frame.until <= Date.now() || args.x >= frame.width || args.y >= frame.height) throw new Error('Click inside the latest computer screenshot.')
          if (bindCapture && action === 'click') {
            input.capture_id = frame.captureId
            frame = undefined
          }
        }
        const [name] = TOOLS[action]
        checked(await request(name, input))
        return { done: true }
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}

export function windowsBackend(binary) {
  async function connect() {
    const digestOf = file => readFile(file).then(data => createHash('sha256').update(data).digest('hex')).catch(() => '')
    const [driver, uia] = await Promise.all([digestOf(binary), digestOf(join(dirname(binary), 'cua-driver-uia.exe'))])
    if (driver !== WINDOWS_DRIVER_SHA || uia !== WINDOWS_UIA_SHA) throw new Error('The verified local desktop driver is unavailable.')
    return openMcp(binary, ['mcp', '--direct', '--embedded'], { env: { ...process.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' } })
  }
  return {
    async open(_selection, signal) {
      signal.throwIfAborted()
      return createDriver(await connect(), { signal, bindCapture: true })
    },
  }
}

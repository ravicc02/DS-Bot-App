import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { browserOutput } from '../browser/mount.js'
import { computerImageName } from './images.js'

const unavailable = () => new Error('Computer control is unavailable on this host.')
const ended = () => new Error('Computer control ended. Select a target again in the conversation.')
const field = type => ({ type, required: true })
const specs = [
  ['observe', 'See the computer selected in this conversation. Use this before clicking.', {}],
  ['click', 'Click coordinates in the most recent computer screenshot.', { x: field('integer'), y: field('integer') }],
  ['type', 'Type text into the selected computer target.', { text: field('string') }],
  ['key', 'Press a single key on the selected computer. Use lowercase key names, such as return or tab.', { key: field('string') }],
  ['scroll', 'Scroll up or down on the selected computer.', { x: field('integer'), y: field('integer'), direction: { ...field('string'), enum: ['up', 'down'] }, amount: field('integer') }],
]

export function desktopRelay(child = process) {
  const pending = new Map()
  let onReset
  const receive = message => {
    if (message?.type === 'ds-bot:computer-result') pending.get(message.id)?.(message)
    if (message?.type === 'ds-bot:computer-reset') onReset?.()
  }
  function close() {
    child.off('message', receive)
    child.off('disconnect', close)
    for (const settle of pending.values()) settle({ error: unavailable().message })
  }
  child.on('message', receive)
  child.once('disconnect', close)
  return {
    close,
    onReset(listener) { onReset = listener },
    call(request) {
      if (!child.connected || pending.size >= 64) return Promise.reject(unavailable())
      const id = randomUUID()
      return new Promise((resolve, reject) => {
        const settle = ({ result, error }) => {
          if (!pending.delete(id)) return
          clearTimeout(timer)
          if (typeof error === 'string') reject(new Error(error))
          else resolve(result)
        }
        const timer = setTimeout(() => settle({ error: 'The desktop did not respond in time.' }), 75_000)
        pending.set(id, settle)
        try {
          child.send({ type: 'ds-bot:computer', id, request }, error => {
            if (error) settle({ error: unavailable().message })
          })
        } catch { settle({ error: unavailable().message }) }
      })
    },
  }
}

export function install(rt) {
  if (process.env.DS_BOT_APP !== '1' || process.env.DS_BOT_COMPUTER !== '1' || typeof process.send !== 'function') return
  installComputer(rt, desktopRelay())
}

export function installComputer(rt, relay) {
  const { ctx } = rt
  const grants = new Map()
  const turns = new Map()
  const choosing = new Map()
  const stopping = new Map()
  const call = request => relay.call(request)
  rt.computerImageForRequest = ({ sessionId, provider, model, purpose }) => {
    const turn = turns.get(sessionId)
    const grant = grants.get(turn?.conversation)
    if (purpose !== undefined || !turn?.observed || turn.grant !== grant || grant?.abort.signal.aborted
      || conversationOf(sessionId) !== turn.conversation || rt.readOnly() !== undefined) return undefined
    return computerImageName(sessionId, turn.id, { provider, model })
  }
  const botOf = session => rt.chatOwners.get(session) ?? rt.groupOwners.get(session)?.botId

  function conversationOf(session) {
    const botId = botOf(session)
    if (!rt.botOf(botId)) return undefined
    const group = rt.groupOwners.get(session)
    if (!group) return rt.chatOf(botId) === session ? 'bot-' + botId : undefined
    const room = rt.roomOf(group.roomId)
    return room?.members?.includes(botId) && room.sessions?.[botId] === session ? 'room-' + room.id : undefined
  }

  function contextOf(id) {
    const bot = rt.botOf(id)
    if (bot) return { conversation: 'bot-' + bot.id }
    const room = rt.roomOf(id)
    if (room) return { conversation: 'room-' + room.id, room }
    throw new Error('This conversation is no longer available.')
  }

  function finish(session, release = true) {
    const turn = turns.get(session)
    if (!turn) return
    turns.delete(session)
    turn.abort.abort()
    if (release && turn.claim) void call({ ...turn.claim, op: 'release' }).catch(() => {})
  }

  function stop(conversation) {
    const pending = stopping.get(conversation)
    if (pending) return pending
    const task = (async () => {
      const grant = grants.get(conversation)
      if (grant) grant.abort.abort()
      grants.delete(conversation)
      for (const [session, turn] of turns) {
        if (turn.conversation === conversation) finish(session)
      }
      choosing.delete(conversation)
      await call({ op: 'stop', conversation })
    })()
    stopping.set(conversation, task)
    return task.finally(() => {
      if (stopping.get(conversation) === task) stopping.delete(conversation)
    })
  }

  relay.onReset?.(() => {
    for (const grant of grants.values()) grant.abort.abort()
    for (const session of turns.keys()) finish(session, false)
    grants.clear()
    choosing.clear()
  })

  rt.checkComputerOwners = () => {
    for (const [session, turn] of turns) {
      if (conversationOf(session) !== turn.conversation) finish(session)
    }
    for (const [conversation, grant] of grants) {
      if (!grantMatches(grant)) {
        void stop(conversation).catch(() => {})
      }
    }
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/start' && event.type !== 'turn/end') return
    finish(session.id)
    const conversation = conversationOf(session.id)
    if (event.type === 'turn/start' && conversation) turns.set(session.id, { id: randomUUID(), conversation, abort: new AbortController() })
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle' && agent?.session?.id) finish(agent.session.id)
  })
  ctx.effect(() => () => {
    for (const session of turns.keys()) finish(session)
    for (const conversation of grants.keys()) void stop(conversation).catch(() => {})
    relay.close()
  }, 'DS Bot computer control')

  function grantMatches({ subject, conversation, operator }) {
    try {
      const current = contextOf(subject)
      return current.conversation === conversation && (current.room ? operator === undefined : operator === subject && !!rt.botOf(operator))
    } catch { return false }
  }

  rt.computerChannel = async (op, body) => {
    const subject = String(body.subject ?? '')
    const { conversation, room } = contextOf(subject)
    if (op === 'status') return call({ op, conversation })
    if (op === 'stop') return stop(conversation)
    if (op === 'select') {
      if (room && body.operator !== undefined) throw ended()
      const operator = room ? undefined : subject
      const binding = { subject, conversation, operator }
      if (choosing.has(conversation) || !grantMatches(binding)) throw ended()
      const selection = Symbol()
      choosing.set(conversation, selection)
      try {
        const token = typeof body.token === 'string' ? body.token : undefined
        const view = await call({ op, conversation, token, operator })
        if (choosing.get(conversation) !== selection) throw ended()
        if (!grantMatches(binding)) { await stop(conversation); throw ended() }
        grants.get(conversation)?.abort.abort()
        grants.set(conversation, { ...binding, token, abort: new AbortController() })
        return view
      } finally { if (choosing.get(conversation) === selection) choosing.delete(conversation) }
    }
    throw unavailable()
  }

  async function assertVision(exec) {
    const config = exec.agent?.session?.requestHeader?.()?.config
    const provider = config?.provider
    const model = config?.model
    if (!provider || !model || (rt.config.textOnlyModels ?? []).includes(provider + '/' + model)) {
      throw new Error('Choose an image-capable model for computer control.')
    }
    const info = await ctx.llm.resolveModelInfo(provider, model)
    if (!info?.inputModalities?.includes('image')) throw new Error('Choose an image-capable model for computer control.')
    return { provider, model }
  }

  for (const [kind, description, parameters] of specs) rt.teamTools.push(defineTool({
    name: 'computer_' + kind, description, parameters, output: browserOutput,
    async execute(args, exec) {
      if (exec.parent !== undefined || exec.rootCallId !== exec.callId) throw new Error('Call computer tools directly from the model.')
      const session = exec.agent?.session?.id
      const turn = turns.get(session)
      const conversation = conversationOf(session)
      const grant = grants.get(conversation)
      const approval = ctx.get('approval')
      if (!grant || (grant.operator !== undefined && grant.operator !== botOf(session)) || !turn || turn.conversation !== conversation || !exec.signal || !approval?.request || rt.readOnly() !== undefined) throw ended()
      const current = () => {
        if (turns.get(session) !== turn || grants.get(conversation) !== grant || conversationOf(session) !== conversation
          || !grantMatches(grant) || exec.signal.aborted || grant.abort.signal.aborted || rt.readOnly() !== undefined) throw ended()
      }
      current()
      if (turn.claim && turn.claim.token !== grant.token) throw ended()
      if (kind !== 'observe' && !turn.observed) throw new Error('Observe the selected computer before sending input.')
      const route = kind === 'observe' ? await assertVision(exec) : undefined
      current()
      if (turn.authorizing) throw new Error('A computer approval is already pending.')
      if (!turn.claim) {
        if (turn.attempted) throw ended()
        turn.attempted = true
        turn.authorizing = true
        try {
          const outcome = await approval.request({
            agent: exec.agent, toolName: exec.name, callId: exec.callId,
            reason: 'Allow this Bot to use the selected computer for this turn?',
            displayReason: { en: 'Allow this Bot to use the selected computer for this turn?', zh: '允许此 Bot 在本回合操控已选电脑吗？' },
            signal: AbortSignal.any([exec.signal, grant.abort.signal, turn.abort.signal]),
          })
          current()
          if (outcome !== 'allowed-once') throw new Error('Computer control was not approved for this turn.')
          turn.grant = grant
          turn.claim = { conversation, token: grant.token, owner: { session, turn: turn.id } }
        } finally { turn.authorizing = false }
      }
      current()
      const request = { ...turn.claim, op: 'action', action: { ...args, kind } }
      const signal = AbortSignal.any([exec.signal, grant.abort.signal, turn.abort.signal])
      let result
      try {
        for (;;) {
          current()
          result = await call(request)
          current()
          if (result?.waiting !== true) break
          await sleep(600, undefined, { signal })
        }
      } catch (error) {
        void call({ ...turn.claim, op: 'release' }).catch(() => {})
        turn.observed = false
        throw error
      }
      current()
      if (!route) return 'Computer action completed. Observe the screen to verify its result.'
      const attachment = await ctx.get('attachments').saveImage({
        mediaType: result.mediaType, data: Buffer.from(result.data, 'base64'),
        name: computerImageName(session, turn.id, route),
      })
      current()
      turn.observed = true
      return { text: 'Computer screenshot (' + result.width + ' × ' + result.height + '). Coordinates start at the upper-left corner.', attachment }
    },
  }))
}

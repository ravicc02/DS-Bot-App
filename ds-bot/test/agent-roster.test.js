import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computerConversation, EMPTY_ROSTER, indexRoster, isAgentSession, trackDesktopConversation } from '../src/client/sources.js'
import { groupsFor } from '../src/client/surface.js'

const ROSTER_VALUE = {
  revision: 3,
  mainBotId: 'm1',
  mainBotIds: ['m1'],
  bots: [{ id: 'm1', sessionId: 'm1', name: 'Chief', parts: [] }],
  rooms: [{ id: 'g1', name: 'Group', members: ['m1'] }],
  agents: [{ id: 'a1', name: 'DSH Agent', sessions: ['s1', 's2'], createdAt: 5 }],
  exchangeTurns: {},
  questions: {},
}

test('indexRoster indexes agents by id and by Session', () => {
  const roster = indexRoster(ROSTER_VALUE)
  assert.deepEqual(roster.agents.map(agent => agent.id), ['a1'])
  assert.equal(roster.agentsById.a1.name, 'DSH Agent')
  assert.equal(roster.agentOf.s1, 'a1')
  assert.equal(roster.agentOf.s2, 'a1')
  assert.equal(roster.agentOf.m1, undefined)
  // The Agent never enters the Bot index.
  assert.equal(roster.byId.s1, undefined)
  assert.equal(roster.byId.a1, undefined)
})

test('a roster without agents still answers the index reads', () => {
  const roster = indexRoster({ ...ROSTER_VALUE, agents: undefined })
  assert.deepEqual(roster.agents, [])
  assert.deepEqual(roster.agentOf, {})
})

// The plain flag decides which groups mount: an Agent Session keeps the shell and
// withdraws only the conversation replacements.
test('isAgentSession follows the roster first, the cache before it is ready', () => {
  const roster = indexRoster(ROSTER_VALUE)
  assert.equal(isAgentSession(roster, new Set(), 's1'), true)
  assert.equal(isAgentSession(roster, new Set(), 'm1'), false)
  assert.equal(isAgentSession(roster, new Set(), 'g1'), false)
  // Not ready: the cached ids from the last pull answer.
  assert.equal(isAgentSession(EMPTY_ROSTER, new Set(['s1']), 's1'), true)
  // A ready roster wins over a stale cache.
  assert.equal(isAgentSession(roster, new Set(['m1']), 'm1'), false)
  assert.equal(isAgentSession(EMPTY_ROSTER, new Set(), ''), false)
  assert.equal(isAgentSession(EMPTY_ROSTER, new Set(), undefined), false)
})

test('the plain flag maps to the mounted groups', () => {
  assert.deepEqual(groupsFor({ mode: 'bot', plain: isAgentSession(indexRoster(ROSTER_VALUE), new Set(), 's1') }), { shell: true, conversation: false })
  assert.deepEqual(groupsFor({ mode: 'bot', plain: isAgentSession(indexRoster(ROSTER_VALUE), new Set(), 'm1') }), { shell: true, conversation: true })
})


test('desktop ownership follows Bot and group chat parts across a rollover', () => {
  const roster = indexRoster({
    bots: [{ id: 'bot-a', sessionId: 'bot-fresh', parts: ['bot-old'] }, { id: 'bot-b' }],
    rooms: [{ id: 'room-a', sessionId: 'room-fresh', ownParts: ['room-old'], parts: ['member-session'] }],
  })
  assert.equal(computerConversation(roster, 'bot-old'), computerConversation(roster, 'bot-fresh'))
  assert.equal(computerConversation(roster, 'room-old'), computerConversation(roster, 'room-fresh'))
  assert.notEqual(computerConversation(roster, 'bot-fresh'), computerConversation(roster, 'bot-b'))
  assert.notEqual(computerConversation(roster, 'bot-fresh'), computerConversation(roster, 'room-fresh'))
  assert.equal(computerConversation(roster, 'member-session'), undefined)
})

test('the desktop stays bound during a part rollover but revokes on navigation', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let resets = 0
  const desktop = trackDesktopConversation(() => { resets++ })
  const roster = indexRoster({ bots: [{ id: 'chief', sessionId: 'fresh', parts: ['old'] }], rooms: [{ id: 'room' }] })
  desktop.sync(roster, 'old')
  desktop.sync(roster, undefined)
  assert.equal(desktop.source.getSnapshot(), 'bot-chief')
  t.mock.timers.tick(1000)
  desktop.sync(roster, 'fresh')
  t.mock.timers.tick(5000)
  assert.equal(resets, 0)
  desktop.sync(roster, 'room')
  assert.equal(resets, 1)
  assert.equal(desktop.source.getSnapshot(), 'room-room')
  desktop.sync(roster, undefined)
  desktop.sync(roster, 'outside-session')
  assert.equal(resets, 2)
  assert.equal(desktop.source.getSnapshot(), null)
})

test('a main view that stays empty drops desktop access when the rollover wait expires', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let resets = 0
  const desktop = trackDesktopConversation(() => { resets++ })
  const roster = indexRoster(ROSTER_VALUE)
  desktop.sync(roster, 'm1')
  desktop.sync(roster, undefined)
  t.mock.timers.tick(4000)
  desktop.sync(roster, undefined)
  t.mock.timers.tick(1000)
  assert.equal(desktop.source.getSnapshot(), null)
  assert.equal(resets, 1)
})

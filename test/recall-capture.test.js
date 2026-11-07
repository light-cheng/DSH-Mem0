import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRecallBlock, latestUserText, MemoryLifecycle } from '../lib/memory-lifecycle.js'
import { estimateTokens } from '../lib/memory-maintenance.js'

function config(overrides = {}) {
  return {
    userId: 'dsh-user',
    agentId: 'dsh',
    recallTopK: 5,
    captureMaxChars: 450,
    autoRecall: true,
    autoCapture: true,
    includeSubagents: false,
    ...overrides,
  }
}

function assembly() {
  return { sections: [], contexts: [], tools: [], variables: {} }
}

function fakeSession({ messages = [], origin, cwd = '/tmp/project' } = {}) {
  return {
    id: 'session-1',
    header: { cwd, origin },
    deriveMessages() {
      return messages
    },
  }
}

function userMessage(text) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function fakeClient(overrides = {}) {
  const calls = []
  return {
    calls,
    async search(...args) {
      calls.push(['search', ...args])
      return { results: [{ id: 'm1', memory: 'Likes tea', score: 0.8 }] }
    },
    async add(...args) {
      calls.push(['add', ...args])
      return { results: [] }
    },
    async get() {
      return { user_id: 'dsh-user' }
    },
    ...overrides,
  }
}

function lifecycle(
  client,
  overrides = {},
  activity = { recall: null, capture: null },
  maintenance = undefined,
) {
  return new MemoryLifecycle({
    client,
    config: config(overrides),
    logger: { debug() {}, warn() {} },
    breaker: { isOpen: () => false, recordSuccess() {}, recordFailure() {} },
    activity,
    maintenance,
  })
}

test('latestUserText picks the latest genuine user message', () => {
  assert.equal(
    latestUserText([
      userMessage('older'),
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      userMessage('newer'),
      { role: 'user', content: [{ type: 'text', text: 'injected' }], source: { kind: 'mem0' } },
    ]),
    'newer',
  )
})

test('buildRecallBlock dedupes IDs and bounds the output', () => {
  const seen = new Set()
  const block = buildRecallBlock(
    [
      { id: 'm1', memory: 'Likes tea' },
      { id: 'm1', memory: 'Likes tea again' },
      { id: 'm2', memory: 'Lives in Shanghai' },
    ],
    seen,
    500,
  )
  assert.match(block, /\[mem0:m1\]/)
  assert.match(block, /\[mem0:m2\]/)
  assert.doesNotMatch(block, /Likes tea again/)
  assert.deepEqual([...seen], ['m1', 'm2'])
})

test('buildRecallBlock enforces the token budget for CJK text', () => {
  const block = buildRecallBlock(
    [{ id: 'm1', memory: '这是一个很长的中文记忆'.repeat(200) }],
    new Set(),
    10_000,
    100,
  )
  assert.ok(block.length > 0)
  assert.ok(estimateTokens(block) <= 100)
})

test('auto recall injects a context block and caches the same query', async () => {
  const client = fakeClient()
  const engine = lifecycle(client)
  const session = fakeSession({ messages: [userMessage('What do I drink?')] })
  const context = { agent: { session }, signal: undefined }
  const first = await engine.onSystemPromptAssemble(assembly(), context, async () => assembly())
  assert.match(first.contexts[0].text, /Likes tea/)
  assert.equal(first.contexts[0].name, 'mem0:recall')
  const second = await engine.onSystemPromptAssemble(assembly(), context, async () => assembly())
  assert.match(second.contexts[0].text, /Likes tea/)
  assert.equal(client.calls.filter((call) => call[0] === 'search').length, 1)
})

test('auto recall fails open when the backend throws', async () => {
  const client = fakeClient({
    async search() {
      throw new Error('down')
    },
  })
  const engine = lifecycle(client)
  const session = fakeSession({ messages: [userMessage('hello')] })
  const base = assembly()
  const result = await engine.onSystemPromptAssemble(
    base,
    { agent: { session } },
    async () => base,
  )
  assert.deepEqual(result, base)
})

test('auto recall skips subagent sessions by default', async () => {
  const client = fakeClient()
  const engine = lifecycle(client)
  const session = fakeSession({ messages: [userMessage('hello')], origin: 'subagent' })
  const base = assembly()
  const result = await engine.onSystemPromptAssemble(
    base,
    { agent: { session } },
    async () => base,
  )
  assert.deepEqual(result, base)
  assert.equal(client.calls.length, 0)
})

test('auto capture stores only completed turns with genuine user and assistant text', async () => {
  const client = fakeClient()
  const engine = lifecycle(client)
  const session = fakeSession({ messages: [] })
  engine.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  engine.onSessionEvent(session, {
    type: 'user/message',
    data: { ...userMessage('Remember my api_key=secret and that I like tea') },
  })
  engine.onSessionEvent(session, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] } },
  })
  engine.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const addCall = client.calls.find((call) => call[0] === 'add')
  assert.ok(addCall)
  assert.equal(addCall[1][0].content, 'Remember my api_key=[REDACTED] and that I like tea')
  assert.equal(addCall[1][1].content, 'Noted.')
  assert.equal(addCall[2].infer, true)
  assert.equal(addCall[2].userId, 'dsh-user')
  assert.equal(addCall[2].metadata.session_id, 'session-1')
  assert.equal('cwd' in addCall[2].metadata, false)
})

test('auto capture ignores aborted turns and injected context', async () => {
  const client = fakeClient()
  const engine = lifecycle(client)
  const session = fakeSession()
  engine.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  engine.onSessionEvent(session, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: 'injected' }], source: { kind: 'mem0' } },
  })
  engine.onSessionEvent(session, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
  })
  engine.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(client.calls.length, 0)
})


test('activity records automatic recall results', async () => {
  const activity = { recall: null, capture: null }
  const engine = lifecycle(fakeClient(), {}, activity)
  const session = fakeSession({ messages: [userMessage('What do I drink?')] })
  await engine.onSystemPromptAssemble(assembly(), { agent: { session } }, async () => assembly())
  assert.equal(activity.recall.status, 'ok')
  assert.equal(activity.recall.count, 1)
  assert.equal(activity.recall.query, 'What do I drink?')
  assert.equal(typeof activity.recall.latencyMs, 'number')
  assert.deepEqual(activity.recall.preview, [{ id: 'm1', memory: 'Likes tea' }])
})

test('activity records automatic capture completion', async () => {
  const activity = { recall: null, capture: null }
  const engine = lifecycle(fakeClient(), {}, activity)
  const session = fakeSession()
  engine.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  engine.onSessionEvent(session, { type: 'user/message', data: { ...userMessage('remember tea') } })
  engine.onSessionEvent(session, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: 'noted' }] } },
  })
  engine.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(activity.capture.status, 'saved')
  assert.equal(activity.capture.messages, 2)
  assert.equal(activity.capture.count, 0)
})


test('memory summary goes to a system-prompt section, not the recall context', async () => {
  const client = fakeClient()
  const maintenance = { profileBlock: () => '- Works on DSH plugins' }
  const engine = lifecycle(client, {}, { recall: null, capture: null }, maintenance)
  const session = fakeSession({ messages: [userMessage('What do I work on?')] })
  const result = await engine.onSystemPromptAssemble(
    assembly(),
    { agent: { session } },
    async () => assembly(),
  )
  assert.equal(result.contexts.length, 1)
  assert.equal(result.contexts[0].name, 'mem0:recall')
  assert.doesNotMatch(result.contexts[0].text, /mem0-user-profile|Works on DSH plugins/)
  assert.match(result.contexts[0].text, /Likes tea/)
  const section = engine.profileSectionText({ agent: { session } })
  assert.match(section, /^<mem0-user-profile>\n/)
  assert.match(section, /Works on DSH plugins/)
  assert.ok(section.endsWith('</mem0-user-profile>'))
})

test('memory summary is byte-identical across turns while only recall changes', async () => {
  let turnNumber = 0
  const client = fakeClient({
    async search() {
      return { results: [{ id: `m${turnNumber}`, memory: `Fact for turn ${turnNumber}` }] }
    },
  })
  const maintenance = { profileBlock: () => '## Work and projects\n- Works on DSH plugins' }
  const engine = lifecycle(client, {}, { recall: null, capture: null }, maintenance)
  const messages = []
  const session = fakeSession({ messages })
  const context = { agent: { session } }
  const sections = []
  const recalls = []
  for (turnNumber = 1; turnNumber <= 3; turnNumber += 1) {
    engine.onSessionEvent(session, { type: 'turn/start', data: { turn: turnNumber } })
    messages.push(userMessage(`question ${turnNumber}`))
    sections.push(engine.profileSectionText(context))
    const result = await engine.onSystemPromptAssemble(assembly(), context, async () => assembly())
    recalls.push(result.contexts.find((entry) => entry.name === 'mem0:recall')?.text)
  }
  assert.ok(sections[0].length > 0)
  assert.equal(new Set(sections).size, 1, 'summary text must not change between turns')
  assert.equal(new Set(recalls).size, 3, 'recall block changes with each turn')
  for (const [index, text] of recalls.entries()) {
    assert.match(text, new RegExp(`Fact for turn ${index + 1}`))
    assert.match(text, /^<mem0-relevant-memories>\n/)
  }
})

test('failed recall keeps the mem0:recall name and leaves the summary section intact', async () => {
  let fail = false
  const client = fakeClient({
    async search() {
      if (fail) throw new Error('down')
      return { results: [{ id: 'm1', memory: 'Likes tea' }] }
    },
  })
  const maintenance = { profileBlock: () => '- Works on DSH plugins' }
  const engine = lifecycle(client, {}, { recall: null, capture: null }, maintenance)
  const messages = [userMessage('first question')]
  const session = fakeSession({ messages })
  const context = { agent: { session } }
  const before = engine.profileSectionText(context)
  const ok = await engine.onSystemPromptAssemble(assembly(), context, async () => assembly())
  fail = true
  messages.push(userMessage('second question'))
  const failed = await engine.onSystemPromptAssemble(assembly(), context, async () => assembly())
  assert.deepEqual(failed.contexts.map((entry) => entry.name), ['mem0:recall'])
  assert.equal(failed.contexts[0].text, ok.contexts[0].text)
  assert.equal(engine.profileSectionText(context), before)

  // A failed search with nothing shown yet adds no context at all.
  engine.onSessionEvent(session, { type: 'turn/start', data: { turn: 2 } })
  const empty = await engine.onSystemPromptAssemble(assembly(), context, async () => assembly())
  assert.deepEqual(empty.contexts, [])
})

test('summary section is empty for skipped subagents and when auto recall is off', () => {
  const maintenance = { profileBlock: () => '- Works on DSH plugins' }
  const engine = lifecycle(fakeClient(), {}, { recall: null, capture: null }, maintenance)
  const subagent = fakeSession({ origin: 'subagent' })
  assert.equal(engine.profileSectionText({ agent: { session: subagent } }), '')
  const off = lifecycle(fakeClient(), { autoRecall: false }, { recall: null, capture: null }, maintenance)
  assert.equal(off.profileSectionText({ agent: { session: fakeSession() } }), '')
  const blank = lifecycle(fakeClient(), {}, { recall: null, capture: null }, { profileBlock: () => '  ' })
  assert.equal(blank.profileSectionText({ agent: { session: fakeSession() } }), '')
})

test('a mid-turn user message merges new recall with memories already shown this turn', async () => {
  const hits = {
    'What do I drink?': [{ id: 'm1', memory: 'Likes oolong tea' }],
    'And where do I live?': [
      { id: 'm1', memory: 'Likes oolong tea' },
      { id: 'm2', memory: 'Lives in Shanghai' },
    ],
  }
  const client = fakeClient({
    async search(query) {
      return { results: hits[query] ?? [] }
    },
  })
  const engine = lifecycle(client)
  const messages = [userMessage('What do I drink?')]
  const session = fakeSession({ messages })
  const context = { agent: { session } }
  engine.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  const first = await engine.onSystemPromptAssemble(assembly(), context, async () => assembly())
  assert.match(first.contexts[0].text, /Likes oolong tea/)

  messages.push(userMessage('And where do I live?'))
  const second = await engine.onSystemPromptAssemble(assembly(), context, async () => assembly())
  assert.equal(second.contexts.length, 1)
  const text = second.contexts[0].text
  assert.match(text, /Lives in Shanghai/)
  assert.match(text, /Likes oolong tea/, 'memory recalled earlier this turn must stay')
  assert.equal(text.match(/\[mem0:m1\]/g).length, 1, 'no duplicate lines')
  assert.ok(text.indexOf('Lives in Shanghai') < text.indexOf('Likes oolong tea'), 'new hits lead')

  // The merge respects the recall budget: with room for one line only, the
  // newest hit wins and the block stays within budget.
  const tight = lifecycle(client, { memoryBudgetTokens: 128 })
  const tightMessages = [userMessage('What do I drink?')]
  const tightSession = fakeSession({ messages: tightMessages })
  const tightContext = { agent: { session: tightSession } }
  await tight.onSystemPromptAssemble(assembly(), tightContext, async () => assembly())
  tightMessages.push(userMessage('And where do I live?'))
  const bounded = await tight.onSystemPromptAssemble(assembly(), tightContext, async () => assembly())
  assert.ok(estimateTokens(bounded.contexts[0].text) <= 128)
  assert.ok(bounded.contexts[0].text.length <= 512)
})

test('capture filter skips low-value turns before enqueueing', async () => {
  const client = fakeClient()
  const activity = { recall: null, capture: null }
  const engine = lifecycle(client, {}, activity)
  const session = fakeSession()
  engine.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  engine.onSessionEvent(session, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: 'ok' }], source: { kind: 'user' } },
  })
  engine.onSessionEvent(session, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  })
  engine.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(client.calls.filter((call) => call[0] === 'add').length, 0)
  assert.equal(activity.capture.status, 'skipped')
  assert.equal(activity.capture.reason, 'low-value')
})

test('recall state resets each turn when only autoRecall is enabled', async () => {
  const client = fakeClient()
  const engine = lifecycle(client, { autoCapture: false })
  const session = fakeSession({ messages: [userMessage('What do I drink?')] })
  const context = { agent: { session }, signal: undefined }
  for (let turn = 1; turn <= 3; turn += 1) {
    engine.onSessionEvent(session, { type: 'turn/start', data: { turn } })
    const result = await engine.onSystemPromptAssemble(assembly(), context, async () => assembly())
    assert.equal(result.contexts.length, 1, `turn ${turn} should still recall`)
    assert.match(result.contexts[0].text, /Likes tea/)
    engine.onSessionEvent(session, {
      type: 'user/message',
      data: { ...userMessage('I prefer green tea over coffee every single morning, please remember it') },
    })
    engine.onSessionEvent(session, {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] } },
    })
    engine.onSessionEvent(session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(client.calls.filter((call) => call[0] === 'search').length, 3)
  assert.equal(client.calls.filter((call) => call[0] === 'add').length, 0)
})

test('long turns are still captured with the user message and final reply only', async () => {
  const client = fakeClient()
  const engine = lifecycle(client)
  const session = fakeSession()
  engine.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  engine.onSessionEvent(session, {
    type: 'user/message',
    data: { ...userMessage('Refactor the build so it always uses pnpm; I decided we are dropping npm for this repo') },
  })
  for (let step = 0; step < 30; step += 1) {
    engine.onSessionEvent(session, {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: `Running tool step ${step}` }] } },
    })
  }
  engine.onSessionEvent(session, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Done: the build now uses pnpm.' }] } },
  })
  engine.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const addCall = client.calls.find((call) => call[0] === 'add')
  assert.ok(addCall, 'long turn should be captured')
  assert.deepEqual(
    addCall[1].map((message) => message.role),
    ['user', 'assistant'],
  )
  assert.match(addCall[1][0].content, /pnpm/)
  assert.equal(addCall[1][1].content, 'Done: the build now uses pnpm.')
})

test('auto recall never waits for sidecar startup and uses recallTimeoutMs (I4, G2)', async () => {
  const client = fakeClient()
  const engine = lifecycle(client, { recallTimeoutMs: 1_234 })
  const session = fakeSession({ messages: [userMessage('What do I drink?')] })
  await engine.onSystemPromptAssemble(assembly(), { agent: { session } }, async () => assembly())
  const [, , , options] = client.calls.find((call) => call[0] === 'search')
  assert.equal(options.waitForStart, false)
  assert.equal(options.timeoutMs, 1_234)
})

test('a starting sidecar skips recall without counting as a breaker failure (I4)', async () => {
  let failures = 0
  const activity = { recall: null, capture: null }
  const engine = new MemoryLifecycle({
    client: fakeClient({
      async search() {
        throw Object.assign(new Error('sidecar is starting'), { code: 'STARTING' })
      },
    }),
    config: config(),
    logger: { debug() {}, warn() {} },
    breaker: { isOpen: () => false, recordSuccess() {}, recordFailure() { failures += 1 } },
    activity,
  })
  const session = fakeSession({ messages: [userMessage('What do I drink?')] })
  const result = await engine.onSystemPromptAssemble(assembly(), { agent: { session } }, async () => assembly())
  assert.deepEqual(result.contexts, [])
  assert.equal(failures, 0)
  assert.equal(activity.recall.status, 'starting')
})

test('memoryBudgetTokens, not a fixed character cap, limits the recall block (G1)', async () => {
  const memories = Array.from({ length: 20 }, (_, index) => ({
    id: `m${index}`,
    memory: `Project note ${index}: ${'the deployment pipeline uses blue green releases '.repeat(5)}`,
  }))
  const client = fakeClient({
    async search() {
      return { results: memories }
    },
  })
  const big = lifecycle(client, { memoryBudgetTokens: 4_000, recallTopK: 20 })
  const session = fakeSession({ messages: [userMessage('How do we deploy?')] })
  const result = await big.onSystemPromptAssemble(assembly(), { agent: { session } }, async () => assembly())
  const text = result.contexts[0].text
  assert.ok(text.length > 3_000, `block is ${text.length} chars`)
  assert.ok(estimateTokens(text) <= 4_000)

  const small = lifecycle(client, { memoryBudgetTokens: 300, recallTopK: 20 })
  const other = fakeSession({ messages: [userMessage('How do we deploy?')] })
  const smallResult = await small.onSystemPromptAssemble(assembly(), { agent: { session: other } }, async () => assembly())
  assert.ok(estimateTokens(smallResult.contexts[0].text) <= 300)
})

// DSH 0.2.1-rc.5 order per turn (dsh-agent-loop lib/index.js): turn/start is
// appended (:945), preStep claims the inbox and emits agent/inbox/claimed
// (:906, :103-110), system-prompt/assemble runs (:907), and only step()
// appends the claimed user message to the session (:1066). So during the
// assemble, deriveMessages() does not hold the current turn's message yet.
async function hostTurn(engine, session, messages, turn, text) {
  const message = userMessage(text)
  engine.onSessionEvent(session, { type: 'turn/start', data: { turn } })
  engine.onInboxClaimed?.({ agent: { session }, message, turn })
  const base = assembly()
  const result = await engine.onSystemPromptAssemble(base, { agent: { session } }, async () => base)
  messages.push(message)
  engine.onSessionEvent(session, { type: 'user/message', data: message })
  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] })
  return result
}

test('turn 1 recall: the first request carries a mem0:recall block (host order)', async () => {
  const client = fakeClient()
  const engine = lifecycle(client)
  const messages = []
  const session = fakeSession({ messages })
  const result = await hostTurn(engine, session, messages, 1, 'What do I drink?')
  const recall = result.contexts.find((entry) => entry.name === 'mem0:recall')
  assert.ok(recall, 'turn 1 has no mem0:recall context')
  assert.match(recall.text, /<mem0-relevant-memories>[\s\S]*Likes tea/)
  assert.equal(result.contexts.at(-1).name, 'mem0:recall')
  const searches = client.calls.filter((call) => call[0] === 'search')
  assert.equal(searches.length, 1)
  assert.equal(searches[0][1], 'What do I drink?')
})

test('later turns search with the current question, not the previous one (host order)', async () => {
  const client = fakeClient()
  const engine = lifecycle(client)
  const messages = []
  const session = fakeSession({ messages })
  await hostTurn(engine, session, messages, 1, 'What do I drink?')
  await hostTurn(engine, session, messages, 2, 'Where do I live?')
  const queries = client.calls.filter((call) => call[0] === 'search').map((call) => call[1])
  assert.deepEqual(queries, ['What do I drink?', 'Where do I live?'])
})

test('a later step in the same turn reuses the claimed question without a new search', async () => {
  const client = fakeClient()
  const engine = lifecycle(client)
  const messages = []
  const session = fakeSession({ messages })
  await hostTurn(engine, session, messages, 1, 'What do I drink?')
  // Step 2: nothing new is claimed; the message is now in the session.
  const base = assembly()
  const step2 = await engine.onSystemPromptAssemble(base, { agent: { session } }, async () => base)
  assert.match(step2.contexts.at(-1).text, /Likes tea/)
  assert.equal(client.calls.filter((call) => call[0] === 'search').length, 1)
})

test('claimed non-user input does not become the recall query', async () => {
  const client = fakeClient()
  const engine = lifecycle(client)
  const session = fakeSession({ messages: [] })
  engine.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  engine.onInboxClaimed({
    agent: { session },
    message: { role: 'user', content: [{ type: 'text', text: 'job finished' }], source: { kind: 'tool-job' } },
    turn: 1,
  })
  const base = assembly()
  const result = await engine.onSystemPromptAssemble(base, { agent: { session } }, async () => base)
  assert.deepEqual(result, base)
  assert.equal(client.calls.length, 0)
})

// ---- Activity replaces instead of merging; skip reasons; retry; /add counts ----

import { CircuitBreaker } from '../lib/http.js'
import { FailureHistory } from '../lib/failure-history.js'
import { captureRetryReason, summarizeAddResult } from '../lib/memory-lifecycle.js'

const DURABLE_TURN = [
  'Please remember: I always write release notes in English and Chinese, every single time.',
  'Noted. I will write release notes in both English and Chinese from now on.',
]

function completeTurn(engine, session, [user, assistant] = DURABLE_TURN) {
  engine.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  engine.onSessionEvent(session, { type: 'user/message', data: { ...userMessage(user) } })
  engine.onSessionEvent(session, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: assistant } ] } },
  })
  engine.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

function engineWith(client, { breaker, failures, activity = { recall: null, capture: null }, overrides = {} } = {}) {
  return new MemoryLifecycle({
    client,
    config: config({ captureFilter: 'heuristic', ...overrides }),
    logger: { debug() {}, warn() {} },
    breaker: breaker ?? new CircuitBreaker(),
    activity,
    failures,
  })
}

function refused() {
  return Object.assign(new Error('dsh-mem0: POST /add failed: fetch failed'), { code: 'NETWORK_ERROR', delivered: false })
}

test('a later skipped capture does not carry the previous error (records replace, not merge)', async () => {
  const activity = { recall: null, capture: null }
  const engine = engineWith(fakeClient({ async add() { throw new Error('dsh-mem0: POST /add failed: fetch failed') } }), { activity })
  const session = fakeSession()
  completeTurn(engine, session)
  await settle()
  assert.equal(activity.capture.status, 'error')
  assert.match(activity.capture.error, /fetch failed/)
  completeTurn(engine, session, ['ok', 'thanks'])
  await settle()
  assert.equal(activity.capture.status, 'skipped')
  assert.equal(activity.capture.reason, 'low-value')
  assert.equal('error' in activity.capture, false)
})

test('a later successful recall does not carry the previous error', async () => {
  const activity = { recall: null, capture: null }
  let fail = true
  const engine = engineWith(fakeClient({
    async search() {
      if (fail) throw new Error('dsh-mem0: POST /search aborted')
      return { results: [] }
    },
  }), { activity })
  await engine.onSystemPromptAssemble(assembly(), { agent: { session: fakeSession({ messages: [userMessage('first?')] }) } }, async () => assembly())
  assert.equal(activity.recall.status, 'error')
  fail = false
  await engine.onSystemPromptAssemble(assembly(), { agent: { session: fakeSession({ messages: [userMessage('second?')] }) } }, async () => assembly())
  assert.equal(activity.recall.status, 'ok')
  assert.equal('error' in activity.recall, false)
})

test('circuit-open skips say when the breaker closes and which failure opened it', async () => {
  let now = 1_000_000
  const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 120_000, now: () => now })
  const failures = new FailureHistory({ backend: 'oss' })
  const activity = { recall: null, capture: null }
  const engine = engineWith(fakeClient({
    async add() {
      throw Object.assign(new Error('dsh-mem0: POST /add failed: Error code: 502'), { status: 500, component: 'embedder', step: 'embed' })
    },
  }), { breaker, failures, activity })
  const session = fakeSession()
  completeTurn(engine, session)
  await settle()
  assert.equal(breaker.isOpen(), true)
  completeTurn(engine, session)
  await settle()
  assert.equal(activity.capture.status, 'skipped')
  assert.equal(activity.capture.reason, 'circuit-open')
  assert.equal(activity.capture.circuitUntil, new Date(1_000_000 + 120_000).toISOString())
  assert.equal(activity.capture.trippedBy.kind, 'capture')
  assert.equal(activity.capture.trippedBy.component, 'embedder')
  assert.match(activity.capture.trippedBy.message, /502/)
  assert.equal('error' in activity.capture, false)
  // Recall is skipped too, with the same explanation.
  await engine.onSystemPromptAssemble(assembly(), { agent: { session: fakeSession({ messages: [userMessage('q?')] }) } }, async () => assembly())
  assert.equal(activity.recall.status, 'skipped')
  assert.equal(activity.recall.reason, 'circuit-open')
  assert.equal(activity.recall.trippedBy.component, 'embedder')
})

test('an undelivered capture (connection refused) is retried once and saved', async () => {
  const failures = new FailureHistory({ backend: 'oss' })
  const activity = { recall: null, capture: null }
  let calls = 0
  const breaker = new CircuitBreaker({ threshold: 2 })
  const engine = engineWith(fakeClient({
    async add() {
      calls += 1
      if (calls === 1) throw refused()
      return { results: [{ id: 'n1', memory: 'x', event: 'ADD' }], summary: { facts: 1, add: 1, update: 0, delete: 0, none: 0 } }
    },
  }), { failures, activity, breaker })
  completeTurn(engine, fakeSession())
  await settle()
  assert.equal(calls, 2)
  assert.equal(activity.capture.status, 'saved')
  assert.equal(activity.capture.retry, 'saved')
  assert.equal(activity.capture.facts, 1)
  assert.equal(activity.capture.add, 1)
  // The first failure is kept (it explains the restart), and the breaker
  // does not count a capture that was saved in the end.
  assert.equal(failures.list().length, 1)
  assert.equal(breaker.failures, 0)
})

test('a capture whose retry fails too is reported as "retry failed"', async () => {
  const failures = new FailureHistory({ backend: 'oss' })
  const activity = { recall: null, capture: null }
  let calls = 0
  const engine = engineWith(fakeClient({
    async add() {
      calls += 1
      throw refused()
    },
  }), { failures, activity })
  completeTurn(engine, fakeSession())
  await settle()
  assert.equal(calls, 2)
  assert.equal(activity.capture.status, 'error')
  assert.equal(activity.capture.retry, 'failed')
  assert.equal(failures.latest().retry, 'failed')
})

test('a capture that may have been delivered (reset, abort, timeout) is never retried', async () => {
  for (const error of [
    Object.assign(new Error('dsh-mem0: POST /add failed: fetch failed'), { code: 'NETWORK_ERROR' }), // reset: delivery unknown
    Object.assign(new Error('dsh-mem0: POST /add aborted'), { code: 'ABORTED' }),
    Object.assign(new Error('dsh-mem0: POST /add failed: boom'), { code: 'BACKEND_ERROR', status: 500 }),
  ]) {
    const activity = { recall: null, capture: null }
    let calls = 0
    const engine = engineWith(fakeClient({
      async add() {
        calls += 1
        throw error
      },
    }), { activity })
    completeTurn(engine, fakeSession())
    await settle()
    assert.equal(calls, 1, error.message)
    assert.equal(activity.capture.status, 'error')
    assert.equal('retry' in activity.capture, false)
  }
})

function unusableAnswer(reason) {
  return Object.assign(new Error(`dsh-mem0: POST /add failed: the LLM's fact-extraction answer (${reason}); nothing was stored`), {
    code: 'LLM_EXTRACT_FAILED',
    status: 502,
    component: 'llm',
    step: 'llm_extract',
    extractReason: reason,
  })
}

test('captureRetryReason: refused connection or an unusable (not refused) extraction answer only', () => {
  assert.equal(captureRetryReason(refused()), 'not-delivered')
  for (const reason of ['not_json', 'empty', 'truncated']) assert.equal(captureRetryReason(unusableAnswer(reason)), 'extraction')
  assert.equal(captureRetryReason(unusableAnswer('refusal')), undefined)
  assert.equal(captureRetryReason(Object.assign(new Error('boom'), { code: 'BACKEND_ERROR', status: 500, component: 'llm' })), undefined)
  assert.equal(captureRetryReason(undefined), undefined)
})

test('an unusable extraction answer is retried once; saved on the retry, the breaker never counts it', async () => {
  for (const reason of ['not_json', 'empty', 'truncated']) {
    const failures = new FailureHistory({ backend: 'oss' })
    const activity = { recall: null, capture: null }
    const breaker = new CircuitBreaker({ threshold: 1 })
    let calls = 0
    let pending
    const engine = engineWith(fakeClient({
      async add() {
        calls += 1
        if (calls === 1) throw unusableAnswer(reason)
        pending = { ...activity.capture }
        return { results: [{ id: 'n1', memory: 'x', event: 'ADD' }], summary: { facts: 1, add: 1, update: 0, delete: 0, none: 0 } }
      },
    }), { failures, activity, breaker })
    completeTurn(engine, fakeSession())
    await settle()
    assert.equal(calls, 2, reason)
    assert.equal(pending.retry, 'pending')
    assert.equal(pending.retryReason, 'extraction')
    assert.equal(pending.extractReason, reason)
    assert.equal(activity.capture.status, 'saved')
    assert.equal(activity.capture.retry, 'saved')
    assert.equal(activity.capture.add, 1)
    // The first failure stays in the history; the breaker is untouched.
    assert.equal(failures.list().length, 1)
    assert.equal(failures.latest().cause, 'extraction')
    assert.equal(failures.latest().reason, reason)
    assert.equal(breaker.failures, 0)
    assert.equal(breaker.isOpen(), false)
  }
})

test('an extraction retry that fails too: two history entries, one breaker failure, "retry failed"', async () => {
  const failures = new FailureHistory({ backend: 'oss' })
  const activity = { recall: null, capture: null }
  const breaker = new CircuitBreaker({ threshold: 5 })
  let calls = 0
  const engine = engineWith(fakeClient({
    async add() {
      calls += 1
      throw unusableAnswer('truncated')
    },
  }), { failures, activity, breaker })
  completeTurn(engine, fakeSession())
  await settle()
  assert.equal(calls, 2)
  assert.equal(activity.capture.status, 'error')
  assert.equal(activity.capture.retry, 'failed')
  assert.equal(activity.capture.extractReason, 'truncated')
  assert.equal(failures.list().length, 2)
  assert.equal(failures.latest().retry, 'failed')
  assert.equal(failures.latest().cause, 'extraction')
  assert.equal(breaker.failures, 1)
})

test('a refusal is not retried', async () => {
  const failures = new FailureHistory({ backend: 'oss' })
  const activity = { recall: null, capture: null }
  let calls = 0
  const engine = engineWith(fakeClient({
    async add() {
      calls += 1
      throw unusableAnswer('refusal')
    },
  }), { failures, activity })
  completeTurn(engine, fakeSession())
  await settle()
  assert.equal(calls, 1)
  assert.equal(activity.capture.status, 'error')
  assert.equal(activity.capture.extractReason, 'refusal')
  assert.equal('retry' in activity.capture, false)
  assert.equal(failures.latest().reason, 'refusal')
})

test('saved captures tell "already known" from "nothing extracted"', async () => {
  for (const [summary, expected] of [
    [{ facts: 1, add: 0, update: 0, delete: 0, none: 1 }, { facts: 1, none: 1, add: 0 }],
    [{ facts: 0, add: 0, update: 0, delete: 0, none: 0 }, { facts: 0 }],
  ]) {
    const activity = { recall: null, capture: null }
    const engine = engineWith(fakeClient({ async add() { return { results: [], summary } } }), { activity })
    completeTurn(engine, fakeSession())
    await settle()
    assert.equal(activity.capture.status, 'saved')
    for (const [key, value] of Object.entries(expected)) assert.equal(activity.capture[key], value, key)
  }
})

test('summarizeAddResult: sidecar summary, Platform/server events, nothing known', () => {
  assert.deepEqual(summarizeAddResult({ results: [], summary: { facts: 2, add: 1, update: 0, delete: 0, none: 1 } }), { facts: 2, add: 1, update: 0, delete: 0, none: 1 })
  assert.deepEqual(summarizeAddResult({ results: [{ event: 'ADD' }, { event: 'UPDATE' }] }), { add: 1, update: 1, delete: 0 })
  assert.deepEqual(summarizeAddResult({ results: [{ id: 'x' }] }), {})
  assert.deepEqual(summarizeAddResult({ queued: true }), {})
})

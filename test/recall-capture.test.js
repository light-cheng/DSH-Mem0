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
    '',
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


test('auto recall prepends a compact profile when maintenance provides one', async () => {
  const client = fakeClient()
  const maintenance = {
    profileBlock: () => '- Works on DSH plugins',
    profileVersion: () => 'v1',
  }
  const engine = lifecycle(client, {}, { recall: null, capture: null }, maintenance)
  const session = fakeSession({ messages: [userMessage('What do I work on?')] })
  const result = await engine.onSystemPromptAssemble(
    assembly(),
    { agent: { session } },
    async () => assembly(),
  )
  assert.match(result.contexts[0].text, /^<mem0-user-profile>/)
  assert.match(result.contexts[0].text, /Works on DSH plugins/)
  assert.match(result.contexts[0].text, /Likes tea/)
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

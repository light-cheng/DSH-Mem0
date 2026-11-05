// dsh-strata interop contract v2: §2 shared recall budget and §4 fold capture.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MemoryLifecycle,
  RECALL_CONTEXT_NAME,
  describeRecallBudget,
  resolveRecallBudget,
} from '../lib/memory-lifecycle.js'
import { estimateTokens } from '../lib/memory-maintenance.js'
import { resolveConfig } from '../lib/config.js'

const BUDGET = 2200

function config(overrides = {}) {
  return {
    userId: 'dsh-user',
    agentId: 'dsh',
    recallTopK: 40,
    captureMaxChars: 450,
    autoRecall: true,
    autoCapture: true,
    includeSubagents: false,
    memoryBudgetTokens: BUDGET,
    captureStrataFolds: false,
    ...overrides,
  }
}

// ~55 tokens each, 40 of them: well over the default 2200-token budget.
const MEMORIES = Array.from({ length: 40 }, (_, index) => ({
  id: `m${index}`,
  memory: `Memory number ${index}: the user prefers detailed explanations about topic ${index} and keeps notes in a plain text file ${'x'.repeat(120)}`,
}))

function fakeClient() {
  const calls = []
  return {
    calls,
    async search(...args) {
      calls.push(['search', ...args])
      return { results: MEMORIES }
    },
    async add(...args) {
      calls.push(['add', ...args])
      return { results: [{ id: 'new-1' }] }
    },
  }
}

function fakeSession({ id = 'session-1', origin, text = 'Tell me about my preferences' } = {}) {
  return {
    id,
    header: { cwd: '/Users/someone/project', origin },
    deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
  }
}

/** Same rules as dsh-strata lib/budget.js, with a settable stage. */
function fakeStrata(stage = 'normal', extra = {}) {
  const service = {
    stage,
    calls: [],
    pressure() {
      return { totalTokens: 1, window: 2, ratio: 0.5, stage: service.stage }
    },
    allowance(session, name, wanted) {
      service.calls.push([session?.id, name, wanted])
      if (service.stage === 'critical') return Math.min(wanted, 512)
      if (service.stage === 'tight' && !String(name).endsWith(':profile')) return Math.floor(wanted / 2)
      return wanted
    },
    ...extra,
  }
  return service
}

function lifecycle({ client = fakeClient(), budget, overrides = {}, activity = { recall: null, capture: null }, maintenance } = {}) {
  return {
    client,
    activity,
    engine: new MemoryLifecycle({
      client,
      config: config(overrides),
      logger: { debug() {}, warn() {} },
      breaker: { isOpen: () => false, recordSuccess() {}, recordFailure() {} },
      activity,
      maintenance,
      budget,
    }),
  }
}

async function recall(engine, session = fakeSession()) {
  const base = { sections: [], contexts: [], tools: [], variables: {} }
  const result = await engine.onSystemPromptAssemble(base, { agent: { session } }, async () => base)
  return result.contexts.find((context) => context.name === RECALL_CONTEXT_NAME)?.text ?? ''
}

// ---- §2 budget ---------------------------------------------------------------

test('§2 no strataBudget service: recall uses memoryBudgetTokens exactly as before', async () => {
  const withoutGetter = lifecycle()
  const withEmptyGetter = lifecycle({ budget: () => undefined })
  const a = await recall(withoutGetter.engine)
  const b = await recall(withEmptyGetter.engine)
  assert.ok(a.length > 0)
  assert.equal(a, b)
  assert.ok(estimateTokens(a) <= BUDGET)
  assert.ok(estimateTokens(a) > BUDGET / 2, 'the full budget is used')
  assert.equal(withoutGetter.activity.recall.budget, undefined)
})

test('§2 normal stage: full budget, and the service is asked with the recall name', async () => {
  const strata = fakeStrata('normal')
  const plain = await recall(lifecycle().engine)
  const { engine, activity } = lifecycle({ budget: () => strata })
  const block = await recall(engine)
  assert.equal(block, plain)
  assert.deepEqual(strata.calls[0], ['session-1', 'mem0:recall', BUDGET])
  assert.deepEqual(activity.recall.budget, { allowance: BUDGET, wanted: BUDGET, stage: 'normal' })
})

test('§2 tight stage: recall block fits half the budget', async () => {
  const { engine, activity } = lifecycle({ budget: () => fakeStrata('tight') })
  const block = await recall(engine)
  assert.ok(block.length > 0)
  assert.ok(estimateTokens(block) <= BUDGET / 2)
  assert.equal(describeRecallBudget(activity.recall.budget), 'recall budget 1100 / 2200 (strata: tight)')
})

test('§2 critical stage: recall block fits 512 tokens', async () => {
  const { engine } = lifecycle({ budget: () => fakeStrata('critical') })
  const block = await recall(engine)
  assert.ok(block.length > 0)
  assert.ok(estimateTokens(block) <= 512)
})

test('§2 allowance 0: no recall block and no search', async () => {
  const strata = fakeStrata('normal', { allowance: () => 0 })
  const { engine, client, activity } = lifecycle({ budget: () => strata })
  assert.equal(await recall(engine), '')
  assert.equal(client.calls.length, 0)
  assert.equal(activity.recall.status, 'skipped')
  assert.equal(activity.recall.reason, 'budget')
})

test('§2 a throwing service falls back to memoryBudgetTokens', async () => {
  const plain = await recall(lifecycle().engine)
  const broken = {
    allowance() {
      throw new Error('boom')
    },
    pressure() {
      throw new Error('boom')
    },
    countTokens() {
      throw new Error('boom')
    },
  }
  assert.equal(await recall(lifecycle({ budget: () => broken }).engine), plain)
  const throwingGetter = () => {
    throw new Error('no such service')
  }
  assert.equal(await recall(lifecycle({ budget: throwingGetter }).engine), plain)
})

test('§2 non-number or out-of-range answers are rejected or clamped', () => {
  const session = fakeSession()
  for (const bad of ['500', NaN, Infinity, null, undefined, {}, -Infinity]) {
    const service = { allowance: () => bad }
    assert.equal(resolveRecallBudget(service, session, BUDGET).allowance, BUDGET, String(bad))
  }
  assert.equal(resolveRecallBudget({ allowance: () => 99_999 }, session, BUDGET).allowance, BUDGET)
  assert.equal(resolveRecallBudget({ allowance: () => -5 }, session, BUDGET).allowance, 0)
  assert.equal(resolveRecallBudget({ allowance: () => 700.9 }, session, BUDGET).allowance, 700)
  assert.equal(resolveRecallBudget(undefined, session, BUDGET).info, undefined)
})

test('§2 the service countTokens is used for the fit check when present', async () => {
  // A counter that reports 4x the estimate makes the block much smaller.
  const counted = []
  const strata = fakeStrata('normal', {
    countTokens(text) {
      counted.push(text.length)
      return estimateTokens(text) * 4
    },
  })
  const block = await recall(lifecycle({ budget: () => strata }).engine)
  assert.ok(counted.length > 0)
  assert.ok(block.length > 0)
  assert.ok(estimateTokens(block) * 4 <= BUDGET)
  // A non-number from countTokens falls back to the local estimate.
  const odd = fakeStrata('normal', { countTokens: () => 'many' })
  assert.equal(await recall(lifecycle({ budget: () => odd }).engine), await recall(lifecycle().engine))
})

test('§2 the service is looked up on every recall (Strata may load later)', async () => {
  let service
  const { engine } = lifecycle({ budget: () => service })
  const before = await recall(engine, fakeSession({ text: 'first question' }))
  service = fakeStrata('critical')
  const after = await recall(engine, fakeSession({ text: 'second question' }))
  assert.ok(estimateTokens(before) > 512)
  assert.ok(estimateTokens(after) <= 512)
})

test('§2 a stage change mid-turn re-fits the shown memories without a new search', async () => {
  const strata = fakeStrata('normal')
  const { engine, client } = lifecycle({ budget: () => strata })
  const session = fakeSession()
  const full = await recall(engine, session)
  strata.stage = 'critical'
  const shrunk = await recall(engine, session)
  assert.equal(client.calls.filter((call) => call[0] === 'search').length, 1)
  assert.ok(estimateTokens(full) > 512)
  assert.ok(estimateTokens(shrunk) <= 512)
  assert.ok(shrunk.length > 0)
  // Unchanged stage: identical text, so DSH appends no new snapshot.
  assert.equal(await recall(engine, session), shrunk)
})

test('§2 the summary section is unchanged under tight and critical pressure', async () => {
  const maintenance = { profileBlock: () => '## Work\n- Uses pnpm\n- Prefers concise answers' }
  const strata = fakeStrata('normal')
  const { engine } = lifecycle({ budget: () => strata, maintenance })
  const session = fakeSession()
  const context = { agent: { session } }
  const normal = engine.profileSectionText(context)
  assert.ok(normal.includes('Uses pnpm'))
  for (const stage of ['tight', 'critical']) {
    strata.stage = stage
    await recall(engine, fakeSession({ text: `question while ${stage}` }))
    assert.equal(engine.profileSectionText(context), normal, stage)
  }
  assert.ok(strata.calls.every(([, name]) => name === 'mem0:recall'), 'allowance is never asked for the summary')
})

// ---- §4 fold capture -----------------------------------------------------------

const FOLD_SUMMARY =
  'The user decided to migrate the build from webpack to Vite, keeps the API token in api_key=sk-live-abcdef123456 for now, and prefers pnpm workspaces for the monorepo layout going forward.'

function fold(overrides = {}) {
  return {
    sessionId: 'session-1',
    foldId: 'f1',
    tier: 1,
    topic: 'build migration',
    summary: FOLD_SUMMARY,
    range: { start: 3, end: 9, seqs: [3, 4, 5, 6, 7, 8, 9] },
    ...overrides,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

function knownSession(engine, session = fakeSession()) {
  engine.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  return session
}

test('§4 captureStrataFolds is off by default', () => {
  assert.equal(resolveConfig({}).captureStrataFolds, false)
  assert.equal(resolveConfig({ captureStrataFolds: true }).captureStrataFolds, true)
})

test('§4 fold events are ignored when the option is off', async () => {
  const { engine, client } = lifecycle()
  knownSession(engine)
  engine.onStrataFold(fold())
  await settle()
  assert.equal(client.calls.length, 0)
})

test('§4 fold events are ignored when automatic capture is off', async () => {
  const { engine, client } = lifecycle({ overrides: { captureStrataFolds: true, autoCapture: false } })
  knownSession(engine)
  engine.onStrataFold(fold())
  await settle()
  assert.equal(client.calls.length, 0)
})

test('§4 tier 2 and tier 3 folds are ignored', async () => {
  const { engine, client } = lifecycle({ overrides: { captureStrataFolds: true } })
  knownSession(engine)
  engine.onStrataFold(fold({ tier: 2, foldId: 'f2' }))
  engine.onStrataFold(fold({ tier: 3, foldId: 'f3' }))
  await settle()
  assert.equal(client.calls.length, 0)
})

test('§4 folds of unknown or subagent sessions are ignored', async () => {
  const { engine, client } = lifecycle({ overrides: { captureStrataFolds: true } })
  knownSession(engine, fakeSession({ id: 'sub-1', origin: 'subagent' }))
  engine.onStrataFold(fold({ sessionId: 'sub-1' }))
  engine.onStrataFold(fold({ sessionId: 'never-seen' }))
  await settle()
  assert.equal(client.calls.length, 0)
})

test('§4 a tier 1 fold is redacted and stored with the contract metadata', async () => {
  const { engine, client, activity } = lifecycle({ overrides: { captureStrataFolds: true } })
  knownSession(engine)
  engine.onStrataFold(fold())
  engine.onStrataFold(fold()) // the same fold twice is stored once
  await settle()
  const adds = client.calls.filter((call) => call[0] === 'add')
  assert.equal(adds.length, 1)
  const [, messages, options] = adds[0]
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
  assert.match(messages[0].content, /build migration/)
  assert.match(messages[0].content, /migrate the build from webpack to Vite/)
  assert.doesNotMatch(messages[0].content, /sk-live-abcdef123456/)
  assert.match(messages[0].content, /\[REDACTED\]/)
  assert.equal(options.infer, true)
  assert.deepEqual(options.metadata, {
    source: 'dsh',
    channel: 'dsh',
    via: 'dsh-strata',
    fold: 'f1',
    tier: 1,
    session_id: 'session-1',
  })
  assert.doesNotMatch(JSON.stringify(options.metadata), /\/Users\//)
  assert.equal(activity.capture.via, 'dsh-strata')
  assert.equal(activity.capture.status, 'saved')
})

test('§4 empty and low-value fold summaries are skipped', async () => {
  const { engine, client, activity } = lifecycle({ overrides: { captureStrataFolds: true } })
  knownSession(engine)
  engine.onStrataFold(fold({ summary: '   ', foldId: 'e' }))
  assert.equal(activity.capture.reason, 'empty')
  engine.onStrataFold(fold({ summary: 'ok', foldId: 'tiny' }))
  assert.equal(activity.capture.reason, 'low-value')
  await settle()
  assert.equal(client.calls.length, 0)
})

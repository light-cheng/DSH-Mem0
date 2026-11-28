// The time budget of a local-backend write (lib/add-budget.js) against a
// fake embedder and a fake OpenAI-compatible LLM on random 127.0.0.1 ports,
// with budgets in milliseconds instead of 120 s. Test user ids only; the
// SQLite file lives in a temporary folder.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Mem0NativeClient } from '../lib/native-client.js'
import { AddBudget, cleanTimings, describePrior, seconds } from '../lib/add-budget.js'
import { FailureHistory } from '../lib/failure-history.js'
import { CircuitBreaker } from '../lib/http.js'
import { MemoryLifecycle } from '../lib/memory-lifecycle.js'

const USER = 'dsh-mem0-budget-test-user'
const AGENT = 'dsh-test'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A JSON server on a random port; `handler(body, count)` → { delay, json }. */
async function fakeServer(t, handler) {
  let count = 0
  const sockets = new Set()
  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', async () => {
      count += 1
      const { delay = 0, json } = await handler(JSON.parse(raw || '{}'), count)
      if (delay) await sleep(delay)
      if (response.destroyed) return
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(json))
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    for (const socket of sockets) socket.destroy()
    server.close()
  })
  return { url: `http://127.0.0.1:${server.address().port}`, calls: () => count }
}

function vectors(body) {
  const input = Array.isArray(body.input) ? body.input : [body.input]
  return { data: input.map((_, index) => ({ index, embedding: [1, 0.5, 0.25] })) }
}

const FACTS = { choices: [{ message: { content: '{"memory": [{"id": "0", "text": "User likes green tea", "attributed_to": "user"}]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }

/**
 * A native client whose embedder answers after `embedDelay(count)` ms and
 * whose LLM after `llmDelay` ms (real HTTP on 127.0.0.1).
 */
async function setup(t, { embedDelay = () => 0, llmDelay = 0, requestTimeoutMs, addTimeoutMs } = {}) {
  const embedder = await fakeServer(t, (body, count) => ({ delay: embedDelay(count), json: vectors(body) }))
  const llm = await fakeServer(t, () => ({ delay: llmDelay, json: FACTS }))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-budget-'))
  const settings = {
    storePath: path.join(dir, 'memory.sqlite'),
    embedder: { provider: 'openai', baseUrl: `${embedder.url}/v1`, model: 'test-embed', dims: undefined, apiKeyRef: '', apiKey: '' },
    llm: { provider: 'openai', baseUrl: `${llm.url}/v1`, model: 'test-llm', apiKeyRef: '', apiKey: '', maxTokens: 8000, temperature: 0, topP: 0.1, reasoningEffort: '' },
    problems: [],
  }
  const client = new Mem0NativeClient({
    config: { backend: 'oss', userId: USER, agentId: AGENT },
    loadSettings: () => settings,
    resolveSecret: async () => undefined,
    requestTimeoutMs,
    addTimeoutMs,
    warmUpOnStart: false,
  })
  t.after(async () => {
    await client.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { client, embedder, llm, dir }
}

const turn = [{ role: 'user', content: 'I like green tea' }, { role: 'assistant', content: 'Noted.' }]

test('seconds, describePrior and cleanTimings', () => {
  assert.equal(seconds(120000), '120')
  assert.equal(seconds(11051), '11.1')
  assert.equal(seconds(30000), '30')
  assert.equal(describePrior({ embedMs: 108200, llmKeyMs: 2 }, ['embedMs', 'llmKeyMs']), 'embedding took 108.2 s')
  assert.equal(
    describePrior({ projectMs: 5, queueMs: 25000, storeMs: 1, embedMs: 30000, llmMs: 400 }, ['projectMs', 'queueMs', 'storeMs', 'embedMs', 'llmMs']),
    'waiting for an earlier write took 25 s and embedding took 30 s',
    'the two longest, in run order',
  )
  assert.equal(describePrior({ storeMs: 3, embedMs: 40 }, ['storeMs', 'embedMs']), 'earlier steps took 0.0 s')
  assert.deepEqual(cleanTimings({ embedMs: 12.6, evil: 5, llmMs: 'x', queueMs: -1, storeMs: null }), { embedMs: 13 })
  assert.equal(cleanTimings({ evil: 1 }), undefined)
})

test('the full-size case: a 108 s embedding leaves the LLM 11 s, and the message says so', async () => {
  // An injected clock: no real waiting.
  let now = 1_000_000
  const budget = new AddBudget({ budgetMs: 120_000, budgetSetting: 'addTimeoutMs', startedAt: now, stepCapMs: undefined, timings: { queueMs: 0 }, now: () => now })
  await budget.run('embedMs', { capped: true }, async () => {
    now += 108_949
  })
  const error = await budget
    .run('llmMs', { component: 'llm' }, async (limitMs) => {
      assert.equal(limitMs, 11_051)
      now += limitMs
      throw Object.assign(new Error(`LLM OpenAI-compatible server at 127.0.0.1:1: request timed out after ${limitMs} ms`), { code: 'ETIMEDOUT' })
    })
    .catch((caught) => caught)
  assert.equal(
    error.message,
    'LLM OpenAI-compatible server at 127.0.0.1:1: request timed out after 11051 ms — only 11.1 s of the 120 s write timeout (addTimeoutMs) were left; embedding took 108.9 s before it',
  )
  assert.equal(error.limitMs, 11_051)
  assert.equal(error.budgetMs, 120_000)
  assert.equal(error.limitSetting, 'addTimeoutMs')
  assert.deepEqual(error.timings, { queueMs: 0, embedMs: 108_949 })
  // With the 30 s cap (4a) the same embedding stops at 30 s instead.
  now = 2_000_000
  const capped = new AddBudget({ budgetMs: 120_000, budgetSetting: 'addTimeoutMs', startedAt: now, stepCapMs: 30_000, now: () => now })
  const embedError = await capped
    .run('embedMs', { capped: true }, async (limitMs) => {
      now += limitMs
      throw Object.assign(new Error(`Embedder Ollama at 127.0.0.1:1: request timed out after ${limitMs} ms`), { code: 'ETIMEDOUT' })
    })
    .catch((caught) => caught)
  assert.equal(embedError.message, 'Embedder Ollama at 127.0.0.1:1: request timed out after 30000 ms — embedding exceeded the 30 s request timeout (timeoutMs)')
  assert.equal(embedError.limitSetting, 'timeoutMs')
  assert.equal(capped.remaining(), 90_000, 'the LLM keeps 90 s')
})

test('an embedding that uses most of the budget leaves the LLM the rest, and its timeout says how much was left and why', async (t) => {
  const { client } = await setup(t, { embedDelay: () => 1_200, llmDelay: 5_000, requestTimeoutMs: 2_000, addTimeoutMs: 2_000 })
  const started = Date.now()
  const error = await client.add(turn, { userId: USER }).catch((caught) => caught)
  const took = Date.now() - started
  assert.equal(error.code, 'ETIMEDOUT')
  assert.equal(error.component, 'llm')
  assert.equal(error.step, 'llm_extract')
  assert.equal(error.limitSetting, 'addTimeoutMs')
  assert.equal(error.budgetMs, 2_000)
  // A slow first SQLite read (Windows CI) takes up to a few tenths too.
  assert.ok(error.limitMs > 0 && error.limitMs < 800, JSON.stringify(error.limitMs))
  assert.ok(error.timings.embedMs >= 1_150, JSON.stringify(error.timings))
  assert.match(error.message, /request timed out after \d+ ms — only 0\.\d s of the 2 s write timeout \(addTimeoutMs\) were left; (?:reading the store took 0\.\d s and )?embedding took 1\.\d s before it$/)
  assert.ok(took < 2_800, `${took} ms`)
  // The failure history keeps the new fields, and reads them back.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-budget-history-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'failures.json')
  const history = new FailureHistory({ filePath, backend: 'oss' })
  const entry = history.record({ kind: 'capture', error, durationMs: took })
  assert.equal(entry.cause, 'timeout')
  assert.equal(entry.component, 'llm')
  assert.equal(entry.limitMs, error.limitMs)
  assert.equal(entry.budgetMs, 2_000)
  assert.equal(entry.limitSetting, 'addTimeoutMs')
  assert.equal(entry.timings.embedMs, error.timings.embedMs)
  assert.ok(Number.isInteger(entry.stepElapsedMs))
  const reloaded = new FailureHistory({ filePath, backend: 'oss' }).latest()
  assert.deepEqual(reloaded, entry)
})

test('the full budget used by one step is said so (write timeout shorter than the request timeout)', async (t) => {
  const { client } = await setup(t, { embedDelay: () => 2_000, requestTimeoutMs: 5_000, addTimeoutMs: 300 })
  const error = await client.add(turn, { userId: USER }).catch((caught) => caught)
  assert.equal(error.component, 'embedder')
  assert.equal(error.limitSetting, 'addTimeoutMs')
  // A slow first SQLite read (Windows CI) is an earlier step of its own; the
  // whole-budget wording is for when earlier steps took under 100 ms.
  if ((error.timings?.storeMs ?? 0) < 100) assert.match(error.message, /— embedding used the whole 0\.3 s write timeout \(addTimeoutMs\)$/)
  else assert.match(error.message, /— only 0\.\d s of the 0\.3 s write timeout \(addTimeoutMs\) were left; reading the store took 0\.\d s before it$/)
})

test('a write that waited behind an earlier one still gets its whole budget; its timeout says how long it waited', async (t) => {
  // The first embedding (an explicit mem0_add of the same scope) takes
  // 600 ms; the capture's own LLM call hangs.
  const { client } = await setup(t, { embedDelay: (count) => (count === 1 ? 600 : 0), llmDelay: 5_000, requestTimeoutMs: 5_000, addTimeoutMs: 1_000 })
  const explicit = client.add([{ role: 'user', content: 'tea' }], { infer: false, userId: USER, timeoutMs: 5_000 })
  const started = Date.now()
  const error = await client.add(turn, { userId: USER, timings: { projectMs: 200 } }).catch((caught) => caught)
  const total = Date.now() - started
  await explicit
  assert.equal(error.code, 'ETIMEDOUT')
  assert.equal(error.component, 'llm')
  assert.ok(total >= 1_500, `the 1 s budget started after the 0.6 s wait (${total} ms)`)
  assert.ok(error.limitMs > 400, `most of the budget was left for the LLM (${error.limitMs} ms)`)
  assert.equal(error.timings.projectMs, 200)
  assert.ok(error.timings.queueMs >= 550, JSON.stringify(error.timings))
  assert.match(error.message, /; before this write started, the save waited 0\.\d s \(not counted in the write timeout\)$/)
  assert.doesNotMatch(error.message, /waiting for an earlier write took/)
  // The failure record keeps the wait.
  const entry = new FailureHistory({ backend: 'oss' }).record({ kind: 'capture', error, durationMs: total })
  assert.equal(entry.timings.queueMs, error.timings.queueMs)
  assert.equal(entry.timings.projectMs, 200)
})

test('a write whose budget ran out before a step does not start it, and says what took the time', async () => {
  let now = 5_000_000
  const budget = new AddBudget({ budgetMs: 1_000, budgetSetting: 'addTimeoutMs', startedAt: now, stepCapMs: 30_000, timings: { projectMs: 0, queueMs: 0 }, now: () => now })
  await budget.run('embedMs', { capped: true }, async () => {
    now += 1_500
  })
  let started = false
  const error = await budget
    .run('llmMs', { component: 'llm', step: 'llm_extract' }, async () => {
      started = true
    })
    .catch((caught) => caught)
  assert.equal(started, false)
  assert.equal(error.code, 'ETIMEDOUT')
  assert.equal(error.component, 'llm')
  assert.equal(error.step, 'llm_extract')
  assert.equal(error.limitMs, 0)
  assert.equal(error.message, 'dsh-mem0: the 1 s write timeout (addTimeoutMs) ran out before fact extraction started; embedding took 1.5 s')
})

// ---- full-size budgets on a mocked clock (no real waiting) ---------------

/**
 * A native client whose fetch answers after `delay(kind, count)` ms of the
 * mocked clock (Infinity: never, until aborted). `kind` is 'embed' or 'llm'.
 */
function clockedClient(t, delay) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-budget-clock-'))
  const settings = {
    storePath: path.join(dir, 'memory.sqlite'),
    embedder: { provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'test-embed', dims: undefined, apiKeyRef: '', apiKey: '' },
    llm: { provider: 'openai', baseUrl: 'http://127.0.0.1:2/v1', model: 'test-llm', apiKeyRef: '', apiKey: '', maxTokens: 8000, temperature: 0, topP: 0.1, reasoningEffort: '' },
    problems: [],
  }
  const counts = { embed: 0, llm: 0 }
  const fetchImpl = (url, init) => {
    const kind = url.endsWith('/api/embed') ? 'embed' : 'llm'
    counts[kind] += 1
    const ms = delay(kind, counts[kind])
    const body = JSON.parse(init.body)
    const answer = () =>
      kind === 'embed'
        ? new Response(JSON.stringify({ embeddings: (Array.isArray(body.input) ? body.input : [body.input]).map(() => [1, 0.5, 0.25]) }), { status: 200 })
        : new Response(JSON.stringify(FACTS), { status: 200 })
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')), { once: true })
      if (Number.isFinite(ms)) setTimeout(() => resolve(answer()), ms)
    })
  }
  const client = new Mem0NativeClient({
    config: { backend: 'oss', userId: USER, agentId: AGENT },
    loadSettings: () => settings,
    resolveSecret: async () => undefined,
    fetchImpl,
    requestTimeoutMs: 30_000,
    addTimeoutMs: 120_000,
    warmUpOnStart: false,
  })
  t.after(async () => {
    await client.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { client, counts }
}

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** Advance the mocked clock until every promise settled (at most `maxMs`). */
async function settleOnClock(t, promises, { stepMs = 250, maxMs = 400_000 } = {}) {
  const states = promises.map((promise) => {
    const state = { done: false }
    promise.then((value) => Object.assign(state, { done: true, value }), (error) => Object.assign(state, { done: true, error }))
    return state
  })
  for (let elapsed = 0; elapsed <= maxMs; elapsed += stepMs) {
    await flush()
    if (states.every((state) => state.done)) return states
    t.mock.timers.tick(stepMs)
  }
  throw new Error('promises did not settle on the mocked clock')
}

test('cold start: a first embedding of 35 s still succeeds (the first embedding gets at least 60 s)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 })
  const { client, counts } = clockedClient(t, (kind, count) => (kind === 'embed' && count === 1 ? 35_000 : 0))
  const [state] = await settleOnClock(t, [client.add(turn, { userId: USER })])
  assert.equal(state.error, undefined, String(state.error?.message))
  assert.equal(state.value.summary.add, 1)
  assert.equal(counts.llm, 1)
})

test('cold start: a stuck first embedding fails at 60 s, and the message names that limit; the LLM keeps 60 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 })
  const { client, counts } = clockedClient(t, (kind) => (kind === 'embed' ? Infinity : 0))
  const started = Date.now()
  const [state] = await settleOnClock(t, [client.add(turn, { userId: USER })])
  const error = state.error
  assert.equal(error.code, 'ETIMEDOUT')
  assert.equal(error.component, 'embedder')
  assert.equal(error.limitMs, 60_000)
  assert.equal(error.limitSetting, 'timeoutMs')
  assert.ok(Date.now() - started >= 60_000 && Date.now() - started < 61_000)
  assert.match(error.message, /— embedding exceeded its 60 s limit \(the first embedding of a write gets the request timeout, timeoutMs, but at least 60 s\)$/)
  assert.equal(counts.llm, 0)
  // Without the stuck embedding the LLM would have had 120 − 60 = 60 s at least.
  const budget = new AddBudget({ budgetMs: 120_000, budgetSetting: 'addTimeoutMs', startedAt: 0, stepCapMs: 30_000, now: () => 60_000 })
  assert.equal(budget.limit().limitMs, 60_000)
})

test('the facts embedding (after the LLM, model loaded) keeps the 30 s request timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 })
  const { client } = clockedClient(t, (kind, count) => (kind === 'embed' && count === 2 ? Infinity : 0))
  const [state] = await settleOnClock(t, [client.add(turn, { userId: USER })])
  const error = state.error
  assert.equal(error.code, 'ETIMEDOUT')
  assert.equal(error.limitMs, 30_000)
  assert.equal(error.limitSetting, 'timeoutMs')
  assert.match(error.message, /— embedding the facts exceeded the 30 s request timeout \(timeoutMs\)$/)
})

test('queue: a capture that waited 125 s behind an earlier write is still saved; when it times out, the wait is in the message and the record', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 })
  // The earlier write of the same scope (with a longer budget of its own)
  // holds the queue for 125 s: a 50 s embedding and a 75 s LLM call.
  const slowEarlier = (kind, count) => (kind === 'embed' && count === 1 ? 50_000 : kind === 'llm' && count === 1 ? 75_000 : 0)
  const { client } = clockedClient(t, slowEarlier)
  const earlier = client.add(turn, { userId: USER, timeoutMs: 200_000 })
  const capture = client.add(turn, { userId: USER, timings: { projectMs: 5 } })
  const [first, second] = await settleOnClock(t, [earlier, capture])
  assert.equal(first.error, undefined, String(first.error?.message))
  assert.equal(second.error, undefined, String(second.error?.message))
  assert.equal(second.value.summary.facts, 1, 'ran to the end after a 125 s wait, as before')

  // The same wait, then the LLM hangs: the whole 120 s budget from when the
  // capture ran (less the clock steps of this test), and the message says
  // the save waited 125 s before.
  const hung = clockedClient(t, (kind, count) => (kind === 'llm' && count === 2 ? Infinity : slowEarlier(kind, count)))
  const earlier2 = hung.client.add(turn, { userId: USER, timeoutMs: 200_000 })
  const capture2 = hung.client.add(turn, { userId: USER, timings: { projectMs: 5 } })
  const [, failed] = await settleOnClock(t, [earlier2, capture2])
  const error = failed.error
  assert.equal(error.component, 'llm')
  assert.equal(error.limitSetting, 'addTimeoutMs')
  assert.ok(error.limitMs > 119_000, `the LLM had nearly the whole budget (${error.limitMs} ms)`)
  assert.ok(error.timings.queueMs >= 125_000, JSON.stringify(error.timings))
  assert.match(error.message, /— (?:fact extraction used the whole 120 s write timeout \(addTimeoutMs\)|only 119\.\d s of the 120 s write timeout \(addTimeoutMs\) were left; embedding took 0\.\d s before it); before this write started, the save waited 125(?:\.\d)? s \(not counted in the write timeout\)$/)
  const entry = new FailureHistory({ backend: 'oss' }).record({ kind: 'capture', error, durationMs: 245_000 })
  assert.ok(entry.timings.queueMs >= 125_000)
  assert.equal(entry.timings.projectMs, 5)
})

test('the capture passes its project lookup time to the add, never a start time; a retry passes nothing', async () => {
  const calls = []
  let first = true
  const client = {
    async search() {
      return { results: [] }
    },
    async add(_messages, options) {
      calls.push({ startedAt: options.startedAt, timings: options.timings, at: Date.now() })
      if (first) {
        first = false
        throw Object.assign(new Error('dsh-mem0: refused'), { code: 'NETWORK_ERROR', delivered: false })
      }
      return { results: [] }
    },
  }
  const failures = new FailureHistory({ backend: 'oss' })
  const engine = new MemoryLifecycle({
    client,
    config: { userId: 'dsh-user', agentId: 'dsh', recallTopK: 5, captureMaxChars: 450, autoRecall: true, autoCapture: true, includeSubagents: false, captureFilter: 'heuristic' },
    logger: { debug() {}, warn() {} },
    breaker: new CircuitBreaker(),
    activity: { recall: null, capture: null },
    failures,
    projects: {
      async resolve() {
        await sleep(120)
        return null
      },
    },
  })
  const session = { id: 'session-1', header: { cwd: '/tmp/project' }, deriveMessages: () => [] }
  const text = (value) => [{ type: 'text', text: value }]
  engine.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  engine.onSessionEvent(session, { type: 'user/message', data: { role: 'user', content: text('Please remember: I always write release notes in English and Chinese, every single time.'), source: { kind: 'user' } } })
  engine.onSessionEvent(session, { type: 'assistant/message', data: { message: { role: 'assistant', content: text('Noted. I will write release notes in both English and Chinese from now on.') } } })
  engine.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  for (let index = 0; index < 50 && calls.length < 2; index += 1) await sleep(20)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].startedAt, undefined, 'the budget starts when the add runs')
  assert.ok(calls[0].timings.projectMs >= 110, JSON.stringify(calls[0].timings))
  assert.equal(calls[1].startedAt, undefined)
  assert.equal(calls[1].timings, undefined, 'the retry is a new request of its own')
  engine.dispose()
})

test('failures.json: old entries read as before; bad budget fields are dropped', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-budget-old-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'failures.json')
  const old = { at: '2026-11-20T00:00:00.000Z', kind: 'capture', backend: 'oss', cause: 'timeout', component: 'llm', message: 'LLM OpenAI-compatible server at 127.0.0.1:1: request timed out after 11051 ms', durationMs: 120087, count: 1, code: 'ETIMEDOUT', step: 'llm_extract' }
  const bad = { ...old, at: '2026-11-21T00:00:00.000Z', limitMs: 'x', budgetMs: -5, limitSetting: 'rm -rf', timings: { embedMs: 'slow', password: 1 } }
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, entries: [bad, old] }))
  const [first, second] = new FailureHistory({ filePath, backend: 'oss' }).list()
  assert.deepEqual(second, { ...old, recovered: false })
  assert.equal(first.limitMs, undefined)
  assert.equal(first.budgetMs, undefined)
  assert.equal(first.limitSetting, undefined)
  assert.equal(first.timings, undefined)
})

// ---- the settings page's timeout advice and the diagnosis facts ----------

import vm from 'node:vm'
import { budgetExtra } from '../lib/add-budget.js'
import { buildDiagnosisPrompt, DIAGNOSIS_FIELDS, diagnosisFacts } from '../lib/diagnose-report.js'
import { failureLines } from '../lib/diagnose-tools.js'

function loadClient() {
  let registered
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window, setTimeout, clearTimeout })
  const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useCallback: (fn) => fn, useEffect() {}, useLayoutEffect() {}, useMemo: (fn) => fn(), useRef: () => ({}), useState: (v) => [v, () => {}] }
  return registered.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require ${name}`)
  }).__test__
}
const plain = (value) => JSON.parse(JSON.stringify(value))

const BUDGET_FAILURE = {
  at: '2026-11-27T06:27:38.649Z', kind: 'capture', backend: 'oss', cause: 'timeout', component: 'llm', step: 'llm_extract', code: 'ETIMEDOUT', count: 1,
  message: 'LLM OpenAI-compatible server at 127.0.0.1:1: request timed out after 11051 ms — only 11.1 s of the 120 s write timeout (addTimeoutMs) were left; embedding took 108.9 s before it',
  durationMs: 120087, stepElapsedMs: 11051, limitMs: 11051, budgetMs: 120000, limitSetting: 'addTimeoutMs', timings: { projectMs: 3, queueMs: 0, storeMs: 2, embedMs: 108940, llmKeyMs: 1 },
}
const CAP_FAILURE = {
  ...BUDGET_FAILURE, component: 'embedder', step: 'embed', stepElapsedMs: 30004, limitMs: 30000, limitSetting: 'timeoutMs', timings: { projectMs: 3, queueMs: 0, storeMs: 2 },
  message: 'Embedder Ollama at 127.0.0.1:1: request timed out after 30000 ms — embedding exceeded the 30 s request timeout (timeoutMs)',
}

test('timeout advice: earlier steps used the write timeout (points at the embedder), a step hit its own limit, an old entry', () => {
  const { en, zh, diagnoseAdvice, adviceText } = loadClient()
  const tEn = (key) => en[key]
  const tZh = (key) => zh[key]
  const budget = diagnoseAdvice(BUDGET_FAILURE)
  assert.equal(budget.hint, 'adviceTimeoutBudget')
  assert.equal(budget.action, 'wizard', 'a slow embedding: the embedder setup, not the timeout')
  assert.equal(
    adviceText(tEn, budget),
    'A save gets 120 s in all (Write timeout, addTimeoutMs). Earlier steps used 108.9 s (embedding took 108.9 s), leaving fact extraction only 11.1 s, and it was cut off when that ran out. Find out why the earlier step was slow; raising the timeout only hides it.',
  )
  assert.equal(
    adviceText(tZh, budget),
    '这次保存总共只能用 120 秒（设置里的「写入超时」addTimeoutMs）。前面的步骤已经用了 108.9 秒（最慢的是向量化，108.9 秒），留给事实抽取的只有 11.1 秒，到点就被中断了。应该先查前面那步为什么慢，调高超时只能掩盖问题。',
  )
  // A slow step other than an embedding points at the settings.
  assert.equal(diagnoseAdvice({ ...BUDGET_FAILURE, timings: { storeMs: 90000, embedMs: 1000 } }).action, 'settings')
  // The wait before the write started is not an earlier step of its budget.
  assert.equal(diagnoseAdvice({ ...BUDGET_FAILURE, limitMs: 120000, timings: { queueMs: 100000 } }).hint, 'adviceTimeoutLimit')
  const cap = diagnoseAdvice(CAP_FAILURE)
  assert.equal(cap.hint, 'adviceTimeoutLimit')
  assert.equal(cap.action, 'settings')
  assert.equal(adviceText(tEn, cap), 'embedding ran for 30.0 s and hit its 30 s limit (Request timeout, timeoutMs). If the service is just slow, raise that setting.')
  assert.equal(adviceText(tZh, cap), '向量化用了 30.0 秒，达到上限 30 秒（设置里的「请求超时」timeoutMs）。如果只是服务慢，可以调高这一项。')
  // One step used the whole write timeout.
  const whole = diagnoseAdvice({ ...CAP_FAILURE, limitMs: 120000, stepElapsedMs: 120001, limitSetting: 'addTimeoutMs' })
  assert.equal(adviceText(tZh, whole), '向量化用了 120.0 秒，达到上限 120 秒（设置里的「写入超时」addTimeoutMs）。如果只是服务慢，可以调高这一项。')
  // An entry without the new fields (older versions, recall): the general advice, unchanged shape.
  const old = { at: BUDGET_FAILURE.at, kind: 'capture', backend: 'oss', cause: 'timeout', component: 'llm', step: 'llm_extract', message: 'LLM …: request timed out after 11051 ms', count: 1 }
  assert.deepEqual(plain(diagnoseAdvice(old)), { hint: 'adviceTimeout', action: 'settings', diagnose: false })
  assert.match(adviceText(tZh, diagnoseAdvice(old)), /^调用超时了。保存受「写入超时」控制/)
  assert.match(adviceText(tEn, diagnoseAdvice(old)), /^The call timed out\. Saves are limited by Write timeout/)
  // Nonsense fields never break the advice.
  assert.equal(diagnoseAdvice({ ...old, limitMs: 'x', budgetMs: 120000 }).hint, 'adviceTimeout')
  assert.equal(diagnoseAdvice({ ...old, limitMs: 5, budgetMs: 0 }).hint, 'adviceTimeout')
  // Every new key exists in both languages.
  for (const key of ['adviceTimeoutBudget', 'adviceTimeoutLimit', 'timeoutSetting_addTimeoutMs', 'timeoutSetting_timeoutMs', 'timeoutSetting_recallTimeoutMs', 'writeStep_embedMs', 'writeStep_llmMs']) {
    assert.ok(en[key] && zh[key], key)
  }
})

test('diagnosis: the budget fields go out as x. fields; the standard fields (format 1) are unchanged', () => {
  assert.deepEqual(budgetExtra(BUDGET_FAILURE), [
    ['x.limit_ms', 11051], ['x.budget_ms', 120000], ['x.limit_setting', 'addTimeoutMs'],
    ['x.project_ms', 3], ['x.queue_ms', 0], ['x.store_ms', 2], ['x.embed_ms', 108940], ['x.llm_key_ms', 1],
  ])
  assert.deepEqual(budgetExtra({ cause: 'timeout' }), [])
  assert.deepEqual(budgetExtra({ limitMs: -1, limitSetting: 'evil', timings: { evil: 2 } }), [])
  assert.ok(diagnosisFacts(BUDGET_FAILURE).every(([key]) => DIAGNOSIS_FIELDS.includes(key)))
  const { text } = buildDiagnosisPrompt(BUDGET_FAILURE, { plugin: 'dsh-mem0', extra: budgetExtra(BUDGET_FAILURE) })
  assert.match(text, /\nx\.limit_ms: 11051\nx\.budget_ms: 120000\nx\.limit_setting: addTimeoutMs\n/)
  assert.match(text, /\nx\.embed_ms: 108940\n/)
  const [, line] = failureLines([BUDGET_FAILURE])
  assert.match(line, / x\.limit_ms=11051 x\.budget_ms=120000 x\.limit_setting=addTimeoutMs .*x\.embed_ms=108940/)
  const [, oldLine] = failureLines([{ ...BUDGET_FAILURE, limitMs: undefined, budgetMs: undefined, limitSetting: undefined, timings: undefined }])
  assert.doesNotMatch(oldLine, /x\./)
})

// ---- the main path is unchanged -----------------------------------------

test('main path: a normal capture (fast embedder and LLM) is saved as before, with no failure and no time limit in the way', async (t) => {
  const { client, embedder, llm } = await setup(t, { requestTimeoutMs: 30_000, addTimeoutMs: 120_000 })
  const failures = new FailureHistory({ backend: 'oss' })
  const activity = { recall: null, capture: null }
  const engine = new MemoryLifecycle({
    client,
    config: { userId: USER, agentId: AGENT, recallTopK: 5, captureMaxChars: 450, autoRecall: true, autoCapture: true, includeSubagents: false, captureFilter: 'heuristic' },
    logger: { debug() {}, warn() {} },
    breaker: new CircuitBreaker(),
    activity,
    failures,
  })
  t.after(() => engine.dispose())
  const session = { id: 'session-1', header: { cwd: '/tmp/project' }, deriveMessages: () => [] }
  const text = (value) => [{ type: 'text', text: value }]
  const started = Date.now()
  engine.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  engine.onSessionEvent(session, { type: 'user/message', data: { role: 'user', content: text('Please remember: I always drink green tea in the morning, every single day.'), source: { kind: 'user' } } })
  engine.onSessionEvent(session, { type: 'assistant/message', data: { message: { role: 'assistant', content: text('Noted. You drink green tea every morning.') } } })
  engine.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  for (let index = 0; index < 100 && activity.capture?.status !== 'saved'; index += 1) await sleep(20)
  assert.equal(activity.capture.status, 'saved')
  assert.equal(activity.capture.count, 1)
  assert.equal(failures.list().length, 0)
  assert.equal(embedder.calls(), 2, 'one query embedding, one for the new fact')
  assert.equal(llm.calls(), 1)
  assert.ok(Date.now() - started < 1_500)
  const stored = await client.list({ user_id: USER })
  assert.deepEqual(stored.results.map((row) => row.memory), ['User likes green tea'])
})

test('main path: a capture that waited behind an earlier write but fits the budget is saved', async (t) => {
  const { client } = await setup(t, { embedDelay: (count) => (count === 1 ? 300 : 100), requestTimeoutMs: 5_000, addTimeoutMs: 1_500 })
  const explicit = client.add([{ role: 'user', content: 'tea' }], { infer: false, userId: USER })
  const result = await client.add(turn, { userId: USER, timings: { projectMs: 0 } })
  await explicit
  assert.equal(result.summary.add, 1, 'wait 0.3 s + embeddings 0.2 s fit the 1.5 s budget')
})

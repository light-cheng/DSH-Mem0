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
  assert.deepEqual(error.timings, { embedMs: 108_949 })
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

test('a slow embedder stops at the request timeout and is reported as the embedder (requestTimeoutMs cap)', async (t) => {
  const { client, llm } = await setup(t, { embedDelay: () => 2_000, requestTimeoutMs: 200, addTimeoutMs: 1_500 })
  const started = Date.now()
  const error = await client.add(turn, { userId: USER }).catch((caught) => caught)
  const took = Date.now() - started
  assert.equal(error.code, 'ETIMEDOUT')
  assert.equal(error.component, 'embedder')
  assert.equal(error.step, 'embed')
  assert.equal(error.limitMs, 200)
  assert.equal(error.budgetMs, 1_500)
  assert.equal(error.limitSetting, 'timeoutMs')
  assert.match(error.message, /request timed out after 200 ms — embedding exceeded the 0\.2 s request timeout \(timeoutMs\)$/)
  assert.ok(took < 1_000, `stopped at the cap, not the budget (${took} ms)`)
  assert.equal(llm.calls(), 0)
})

test('an embedding that uses most of the budget leaves the LLM the rest, and its timeout says how much was left and why', async (t) => {
  const { client } = await setup(t, { embedDelay: () => 700, llmDelay: 3_000, requestTimeoutMs: 1_000, addTimeoutMs: 1_000 })
  const started = Date.now()
  const error = await client.add(turn, { userId: USER }).catch((caught) => caught)
  const took = Date.now() - started
  assert.equal(error.code, 'ETIMEDOUT')
  assert.equal(error.component, 'llm')
  assert.equal(error.step, 'llm_extract')
  assert.equal(error.limitSetting, 'addTimeoutMs')
  assert.equal(error.budgetMs, 1_000)
  assert.ok(error.limitMs > 0 && error.limitMs < 400, JSON.stringify(error.limitMs))
  assert.ok(error.timings.embedMs >= 650, JSON.stringify(error.timings))
  assert.match(error.message, /request timed out after \d+ ms — only 0\.\d s of the 1 s write timeout \(addTimeoutMs\) were left; embedding took 0\.[78] s before it$/)
  assert.ok(took < 1_300, `${took} ms`)
  // The failure history keeps the new fields, and reads them back.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-budget-history-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'failures.json')
  const history = new FailureHistory({ filePath, backend: 'oss' })
  const entry = history.record({ kind: 'capture', error, durationMs: took })
  assert.equal(entry.cause, 'timeout')
  assert.equal(entry.component, 'llm')
  assert.equal(entry.limitMs, error.limitMs)
  assert.equal(entry.budgetMs, 1_000)
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
  assert.match(error.message, /— embedding used the whole 0\.3 s write timeout \(addTimeoutMs\)$/)
})

test('a capture counts its project lookup and its wait behind an earlier write: the total stays within addTimeoutMs', async (t) => {
  // The first embedding (an explicit mem0_add of the same scope) takes
  // 400 ms; the capture's own embedding hangs.
  const { client } = await setup(t, { embedDelay: (count) => (count === 1 ? 400 : 5_000), requestTimeoutMs: 5_000, addTimeoutMs: 1_000 })
  const explicit = client.add([{ role: 'user', content: 'tea' }], { infer: false, userId: USER })
  const startedAt = Date.now() - 200
  const error = await client.add(turn, { userId: USER, startedAt, timings: { projectMs: 200 } }).catch((caught) => caught)
  const total = Date.now() - startedAt
  await explicit
  assert.equal(error.code, 'ETIMEDOUT')
  assert.equal(error.component, 'embedder')
  assert.ok(total < 1_150, `the whole capture took ${total} ms of a 1000 ms budget`)
  assert.equal(error.timings.projectMs, 200)
  assert.ok(error.timings.queueMs >= 350, JSON.stringify(error.timings))
  assert.match(error.message, /— only 0\.\d s of the 1 s write timeout \(addTimeoutMs\) were left; finding the project took 0\.2 s and waiting for an earlier write took 0\.\d s before it$/)
})

test('without startedAt the wait behind an earlier write is recorded but not counted', async (t) => {
  const { client } = await setup(t, { embedDelay: (count) => (count === 1 ? 200 : 5_000), requestTimeoutMs: 5_000, addTimeoutMs: 300 })
  const explicit = client.add([{ role: 'user', content: 'tea' }], { infer: false, userId: USER })
  const error = await client.add(turn, { userId: USER }).catch((caught) => caught)
  await explicit
  assert.ok(error.limitMs >= 290, 'the full 300 ms from when it ran')
  assert.match(error.message, /embedding used the whole 0\.3 s write timeout/)
  assert.equal(error.timings?.queueMs, undefined, 'the uncounted wait is no earlier step of this budget')
})

test('a write whose budget ran out before a step does not start it, and says what took the time', async (t) => {
  const { client, embedder } = await setup(t, { addTimeoutMs: 1_000 })
  const error = await client.add(turn, { userId: USER, startedAt: Date.now() - 1_500, timings: { projectMs: 1_500 } }).catch((caught) => caught)
  assert.equal(error.code, 'ETIMEDOUT')
  assert.equal(error.component, 'embedder')
  assert.equal(error.step, 'embed')
  assert.equal(error.limitMs, 0)
  assert.equal(error.message, 'dsh-mem0: the 1 s write timeout (addTimeoutMs) ran out before embedding started; finding the project took 1.5 s')
  assert.equal(embedder.calls(), 0)
})

test('the capture passes its start and project lookup to the add; a retry gets a fresh budget', async () => {
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
  assert.ok(Number.isFinite(calls[0].startedAt))
  assert.ok(calls[0].at - calls[0].startedAt >= 110, 'the budget started before the project lookup')
  assert.ok(calls[0].timings.projectMs >= 110, JSON.stringify(calls[0].timings))
  assert.equal(calls[1].startedAt, undefined, 'the retry is a new request with a budget of its own')
  assert.equal(calls[1].timings, undefined)
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

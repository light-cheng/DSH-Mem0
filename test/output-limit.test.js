// A gateway that answers "cut at its output budget" with an HTTP error
// (magpie: HTTP 502 "… — cut at its length, the whole output spent on
// reasoning (the request's limit was 2000 tokens: …)") is an extraction
// cut off at finish_reason=length: retried once with twice max_tokens, not
// counted by the breaker, stored as extraction/truncated with the gateway's
// words. An ordinary 502 and a 200 with finish_reason=length are unchanged.
//
// A mock OpenAI-compatible server on a random 127.0.0.1 port, a SQLite file
// in a temporary folder, test user ids only; no real gateway, store or key.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chatCompletion, matchOutputLimit, OUTPUT_LIMIT_PATTERNS } from '../lib/providers.js'
import { Mem0NativeClient } from '../lib/native-client.js'
import { captureRetryReason, countsTowardBreaker, MemoryLifecycle, retryMaxTokens } from '../lib/memory-lifecycle.js'
import { classifyFailure, FailureHistory, FAILURE_MESSAGE_MAX_CHARS } from '../lib/failure-history.js'
import { CircuitBreaker } from '../lib/http.js'
import { testLlm } from '../lib/setup-wizard.js'
import { describeLastExtraction, describeMaxTokens, diagnosticLines } from '../lib/diagnostics.js'
import { resolveNativeSettings } from '../lib/oss-config.js'

const USER = 'dsh-mem0-output-limit-test-user'
const AGENT = 'dsh-test'

const MAGPIE = 'WorkBuddy: an empty reply (the model answered nothing; try again) — cut at its length, the whole output spent on reasoning ' +
  "(the request's limit was 2000 tokens: raise max_tokens in the agent, or ask for less reasoning)"
const ADVICE_TAIL = 'raise max_tokens in the agent, or ask for less reasoning)'

/**
 * A mock server: /embeddings answers 4-dim vectors; /chat/completions asks
 * `llm(body, index)` for `{ status, json }`. Listens on port 0 (random).
 */
async function mockServer(t, llm) {
  const requests = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      if (req.url.endsWith('/embeddings')) {
        const data = body.input.map((text, index) => ({ index, embedding: [1, String(text).length % 7, 0.5, 0.25] }))
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }))
        return
      }
      requests.push(body)
      const { status = 200, json } = llm(body, requests.length)
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests }
}

const gateway502 = { status: 502, json: { error: { message: MAGPIE, type: 'upstream_error' } } }
const plain502 = { status: 502, json: { error: { message: 'Bad gateway: upstream unavailable' } } }
const facts = (...texts) => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify({ memory: texts.map((text) => ({ id: '0', text, attributed_to: 'user' })) }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } } })
const cutOff200 = { status: 200, json: { choices: [{ message: { content: '{"memory": [{"text": "User li' }, finish_reason: 'length' }], usage: { prompt_tokens: 100, completion_tokens: 2000 } } }

function llmSettings(baseUrl, maxTokens = 2000) {
  return { baseUrl, model: 'test-llm', apiKeyRef: '', apiKey: '', maxTokens, temperature: 0, topP: 0.1, reasoningEffort: '' }
}

function nativeClient(t, baseUrl, { maxTokens = 2000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-output-limit-'))
  const settings = {
    storePath: path.join(dir, 'memory.sqlite'),
    embedder: { provider: 'openai', baseUrl, model: 'test-embed', dims: undefined, apiKeyRef: '', apiKey: '' },
    llm: llmSettings(baseUrl, maxTokens),
    problems: [],
  }
  const warnings = []
  const client = new Mem0NativeClient({
    config: { backend: 'oss', userId: USER, agentId: AGENT },
    loadSettings: () => settings,
    resolveSecret: async () => undefined,
    logger: { debug() {}, info() {}, warn: (line) => warnings.push(line) },
  })
  t.after(async () => {
    await client.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { client, warnings }
}

test('matchOutputLimit: the narrow gateway phrases only', () => {
  assert.ok(OUTPUT_LIMIT_PATTERNS.length >= 4)
  assert.deepEqual(matchOutputLimit(MAGPIE), { limit: 2000 })
  assert.deepEqual(matchOutputLimit('upstream stopped: finish_reason=length'), {})
  assert.deepEqual(matchOutputLimit('{"finish_reason": "length"}'), {})
  assert.deepEqual(matchOutputLimit('the whole output spent on reasoning'), {})
  assert.deepEqual(matchOutputLimit("the request's limit was 4096 tokens"), { limit: 4096 })
  assert.deepEqual(matchOutputLimit('cut at its length'), {})
  for (const text of [
    '',
    undefined,
    'Bad gateway: upstream unavailable',
    'an empty reply (the model answered nothing; try again)',
    'context length exceeded: the prompt is too long',
    'max_tokens must be at most 4096',
    'finish_reason=stop',
    'rate limit was 20 requests',
    'the length of the input is invalid',
  ]) assert.equal(matchOutputLimit(text), null, String(text))
})

test('chatCompletion: a gateway 502 that says the budget ran out carries outputLimit; an ordinary 502 does not', async (t) => {
  const { baseUrl } = await mockServer(t, (_body, index) => (index === 1 ? gateway502 : plain502))
  const cut = await chatCompletion(llmSettings(baseUrl), [{ role: 'user', content: 'x' }]).catch((error) => error)
  assert.equal(cut.code, 'BACKEND_ERROR')
  assert.equal(cut.status, 502)
  assert.deepEqual(cut.outputLimit, { maxTokens: 2000 })
  assert.equal(cut.detail, MAGPIE)
  const plain = await chatCompletion(llmSettings(baseUrl), [{ role: 'user', content: 'x' }]).catch((error) => error)
  assert.equal(plain.outputLimit, undefined)
  assert.match(plain.message, /^LLM OpenAI-compatible server at 127\.0\.0\.1:\d+ answered HTTP 502: Bad gateway: upstream unavailable$/)
})

test('native client: the gateway 502 is an extraction cut off at max_tokens; nothing stored; the retry sends 4000', async (t) => {
  const { baseUrl, requests } = await mockServer(t, (_body, index) => (index === 1 ? gateway502 : facts('User likes green tea')))
  const { client, warnings } = nativeClient(t, baseUrl)
  const error = await client.add([{ role: 'user', content: 'I like green tea' }]).catch((value) => value)
  assert.equal(error.code, 'LLM_EXTRACT_FAILED')
  assert.equal(error.extractReason, 'truncated')
  assert.equal(error.retryable, true)
  assert.equal(error.component, 'llm')
  assert.equal(error.step, 'llm_extract')
  assert.deepEqual(error.extractStats, { finishReason: 'length', maxTokens: 2000 })
  assert.equal(error.detail, MAGPIE)
  assert.match(error.message, /max_tokens 2000, HTTP 502/)
  assert.match(warnings.join('\n'), /raise max_tokens in the agent/)
  assert.equal(requests[0].max_tokens, 2000)
  // Nothing written by the failed attempt: no memory, no remembered turn.
  assert.equal((await client.list({ user_id: USER })).results.length, 0)

  assert.equal(captureRetryReason(error), 'extraction')
  assert.equal(retryMaxTokens(error), 4000)
  assert.equal(countsTowardBreaker(error), false)
  assert.equal(classifyFailure(error), 'extraction')

  const last = client.status().lastExtraction
  assert.equal(last.ok, false)
  assert.equal(last.reason, 'truncated')
  assert.equal(last.status, 502)
  assert.equal(last.maxTokens, 2000)
  const line = describeLastExtraction(last)
  assert.match(line, /failed \(HTTP 502, truncated\)/)
  assert.match(line, /cut off at the output budget \(max_tokens 2000\)/)
  assert.match(line, /llmMaxTokens \(8000 or more\)/)
  assert.match(line, /llmReasoningEffort to low/)
  assert.ok(line.includes(ADVICE_TAIL), line)

  const retried = await client.add([{ role: 'user', content: 'I like green tea' }], { llmMaxTokens: retryMaxTokens(error) })
  assert.equal(requests[1].max_tokens, 4000)
  assert.equal(retried.summary.add, 1)
  assert.equal((await client.list({ user_id: USER })).results.length, 1, 'one memory, no duplicate')
  // The failed attempt left no trace in the retry's prompt.
  assert.match(requests[1].messages[1].content, /## Last k Messages\n\n/)
})

test('failure history: extraction/truncated with stats, and the gateway advice kept whole', async (t) => {
  const { baseUrl } = await mockServer(t, () => gateway502)
  const { client } = nativeClient(t, baseUrl)
  const error = await client.add([{ role: 'user', content: 'I like green tea' }]).catch((value) => value)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-output-limit-failures-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'failures.json')
  new FailureHistory({ filePath, backend: 'oss' }).record({ kind: 'capture', error })
  const entry = new FailureHistory({ filePath, backend: 'oss' }).latest()
  assert.equal(entry.cause, 'extraction')
  assert.equal(entry.reason, 'truncated')
  assert.equal(entry.component, 'llm')
  assert.equal(entry.status, 502)
  assert.deepEqual(entry.extract, { finishReason: 'length', maxTokens: 2000 })
  assert.equal(entry.detail, MAGPIE)
  assert.ok(entry.detail.endsWith(ADVICE_TAIL))
  assert.ok(entry.message.length <= FAILURE_MESSAGE_MAX_CHARS)
  assert.doesNotMatch(entry.message, /…$/, 'Mem0\'s own message is short enough to keep whole')
})

test('an ordinary 502 is unchanged: not retried, counted, cause other, no detail stored', async (t) => {
  const { baseUrl, requests } = await mockServer(t, () => plain502)
  const { client } = nativeClient(t, baseUrl)
  const error = await client.add([{ role: 'user', content: 'I like green tea' }]).catch((value) => value)
  assert.equal(error.code, 'BACKEND_ERROR')
  assert.equal(error.status, 502)
  assert.equal(error.extractReason, undefined)
  assert.equal(error.extractStats, undefined)
  assert.equal(error.outputLimit, undefined)
  assert.equal(captureRetryReason(error), undefined)
  assert.equal(retryMaxTokens(error), undefined)
  assert.equal(countsTowardBreaker(error), true)
  assert.equal(classifyFailure(error), 'other')
  assert.equal(requests.length, 1)
  const entry = new FailureHistory({ backend: 'oss' }).record({ kind: 'capture', error })
  assert.equal(entry.cause, 'other')
  assert.equal(entry.detail, undefined)
  assert.equal(entry.reason, undefined)
  // The status line now says the last extraction failed (it said nothing).
  assert.match(describeLastExtraction(client.status().lastExtraction), /failed \(HTTP 502, BACKEND_ERROR\)$/)
})

test('a 200 with finish_reason=length is unchanged', async (t) => {
  const { baseUrl } = await mockServer(t, () => cutOff200)
  const { client } = nativeClient(t, baseUrl)
  const error = await client.add([{ role: 'user', content: 'I like green tea' }]).catch((value) => value)
  assert.equal(error.code, 'LLM_EXTRACT_FAILED')
  assert.equal(error.extractReason, 'truncated')
  assert.deepEqual(error.extractStats, { maxTokens: 2000, finishReason: 'length', promptTokens: 100, completionTokens: 2000 })
  assert.equal(error.detail, undefined)
  assert.match(error.message, /cut off \(truncated JSON\); nothing was stored$/)
  assert.equal(retryMaxTokens(error), 4000)
  assert.equal(countsTowardBreaker(error), false)
  assert.equal(new FailureHistory({ backend: 'oss' }).record({ kind: 'capture', error }).detail, undefined)
})

test('auto capture: the gateway 502 is retried once with max_tokens 4000; the breaker stays closed', async (t) => {
  const { baseUrl, requests } = await mockServer(t, (_body, index) => (index === 1 ? gateway502 : facts('User writes release notes in English and Chinese')))
  const { client } = nativeClient(t, baseUrl)
  const failures = new FailureHistory({ backend: 'oss' })
  const activity = { recall: null, capture: null }
  const breaker = new CircuitBreaker({ threshold: 1 })
  const engine = new MemoryLifecycle({
    client,
    config: { userId: USER, agentId: AGENT, recallTopK: 5, captureMaxChars: 450, autoRecall: true, autoCapture: true, includeSubagents: false, captureFilter: 'heuristic' },
    logger: { debug() {}, warn() {} },
    breaker,
    activity,
    failures,
  })
  t.after(() => engine.dispose())
  const session = { id: 'session-1', header: { cwd: os.tmpdir() }, deriveMessages: () => [] }
  const say = (role, text) => ({ role, content: [{ type: 'text', text }], ...(role === 'user' ? { source: { kind: 'user' } } : {}) })
  engine.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  engine.onSessionEvent(session, { type: 'user/message', data: say('user', 'Please remember: I always write release notes in English and Chinese, every single time.') })
  engine.onSessionEvent(session, { type: 'assistant/message', data: { message: say('assistant', 'Noted. I will write release notes in both English and Chinese from now on.') } })
  engine.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  for (let i = 0; i < 200 && activity.capture?.status !== 'saved' && activity.capture?.status !== 'error'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.deepEqual(requests.map((body) => body.max_tokens), [2000, 4000])
  assert.equal(activity.capture.status, 'saved')
  assert.equal(activity.capture.retry, 'saved')
  assert.equal(breaker.isOpen(), false)
  const entry = failures.latest()
  assert.equal(entry.cause, 'extraction')
  assert.equal(entry.reason, 'truncated')
  assert.equal(entry.detail, MAGPIE)
})

test('setup wizard testLlm: the gateway 502 gives raise-max-tokens and lower-effort; an ordinary 502 no advice', async (t) => {
  const { baseUrl } = await mockServer(t, (_body, index) => (index === 1 ? gateway502 : plain502))
  const cut = await testLlm(llmSettings(baseUrl), { platform: 'linux' })
  assert.equal(cut.ok, false)
  assert.equal(cut.reason, 'truncated')
  assert.deepEqual(cut.advice, ['raise-max-tokens', 'lower-effort'])
  assert.equal(cut.stats.maxTokens, 2000)
  assert.equal(cut.stats.finishReason, 'length')
  assert.equal(cut.detail, MAGPIE)
  assert.equal(cut.status, 502)
  const plain = await testLlm(llmSettings(baseUrl), { platform: 'linux' })
  assert.equal(plain.ok, false)
  assert.deepEqual(plain.advice, [])
  assert.equal(plain.reason, undefined)
  assert.equal(plain.failure.reason, 'http')
})

test('mem0_status: the extraction LLM line shows max_tokens and where it came from', () => {
  const llm = { provider: 'openai', baseUrl: 'http://127.0.0.1:64451/v1', model: 'm' }
  const oss = { oss: { llm: { provider: 'openai', config: { openai_base_url: 'http://127.0.0.1:64451/v1', model: 'm', max_tokens: 2000 } } } }
  const fromPlugin = resolveNativeSettings({ llmBaseUrl: llm.baseUrl, llmModel: 'm', llmMaxTokens: 12000 }, oss).llm
  const fromFile = resolveNativeSettings({}, oss).llm
  const byDefault = resolveNativeSettings({ llmBaseUrl: llm.baseUrl, llmModel: 'm' }, undefined).llm
  assert.equal(fromPlugin.maxTokensSource, 'plugin')
  assert.equal(fromFile.maxTokensSource, 'oss.json')
  assert.equal(fromFile.maxTokens, 2000)
  assert.equal(byDefault.maxTokensSource, 'default')
  assert.equal(resolveNativeSettings({ llmProvider: 'dsh', llmMaxTokens: 3000 }, undefined).llm.maxTokensSource, 'plugin')
  assert.equal(describeMaxTokens(fromPlugin), ', max_tokens 12000 (plugin setting llmMaxTokens)')
  assert.equal(describeMaxTokens(fromFile), ', max_tokens 2000 (oss.json llm.config.max_tokens)')
  assert.equal(describeMaxTokens(byDefault), ', max_tokens 8000 (default)')
  assert.equal(describeMaxTokens({}), '')
  const lines = diagnosticLines({ config: { backend: 'oss', native: { storePath: path.join(os.tmpdir(), 'x.sqlite'), embedder: { provider: 'openai' }, llm: fromFile, problems: [] } } })
  const line = lines.find((text) => text.startsWith('extraction LLM:'))
  assert.equal(line, 'extraction LLM: m at 127.0.0.1:64451, max_tokens 2000 (oss.json llm.config.max_tokens)')
})

// client.js the way the host loads it (as test/client.test.js does).
function clientExports() {
  let registered
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window })
  const react = { createElement: () => null, useCallback: (fn) => fn, useEffect() {}, useLayoutEffect() {}, useMemo: (fn) => fn(), useRef: () => ({}), useState: (v) => [v, () => {}] }
  return registered.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require ${name}`)
  }).__test__
}

test('memory page: the stored gateway cut-off shows the advice (zh and en) and the gateway words whole', () => {
  const { failureSummary, zh, en } = clientExports()
  const t = (dict) => (key) => dict[key] ?? key
  const failure = {
    kind: 'capture', component: 'llm', provider: 'openai', endpoint: '127.0.0.1:64451', step: 'llm_extract', cause: 'extraction', reason: 'truncated', status: 502,
    extract: { finishReason: 'length', maxTokens: 2000 }, message: 'dsh-mem0: the LLM answer hit its output limit (max_tokens 2000, HTTP 502): …', detail: MAGPIE,
  }
  const zhLine = failureSummary(t(zh), failure)
  assert.match(zhLine, /LLM 回复达到输出上限（max_tokens 2000），推理把输出用完了。请调高 Mem0 的 llmMaxTokens（建议 ≥ 8000），或把 llmReasoningEffort 设成 low；这不是 DSH 的模型设置。/)
  assert.ok(zhLine.endsWith(ADVICE_TAIL), zhLine)
  const enLine = failureSummary(t(en), failure)
  assert.match(enLine, /reached its output limit \(max_tokens 2000\)/)
  assert.match(enLine, /not DSH's model setting/)
  assert.ok(enLine.endsWith(ADVICE_TAIL), enLine)
  // Other extraction failures still show Mem0's message.
  const plain = { ...failure, detail: undefined, message: 'm' }
  assert.ok(failureSummary(t(en), plain).endsWith(' · m'))
})

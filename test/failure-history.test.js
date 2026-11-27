import test from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawn } from 'node:child_process'
import { localServerTest } from './fixtures/local-listen.js'
import http from 'node:http'
import {
  attributeFailure,
  classifyFailure,
  FailureHistory,
  sanitizeFailureMessage,
  FAILURE_MESSAGE_MAX_CHARS,
} from '../lib/failure-history.js'
import { CircuitBreaker } from '../lib/http.js'
import { MemoryLifecycle } from '../lib/memory-lifecycle.js'
import { MemoryMaintenance } from '../lib/memory-maintenance.js'
import { Mem0RestClient, Mem0RestError } from '../lib/rest-client.js'
import { ProviderError, postJson } from '../lib/providers.js'
import { storeError } from '../lib/store-sqlite.js'
import { failureAttribution } from '../lib/http.js'
import { handleFailuresAcknowledged } from '../lib/settings-routes.js'

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-failures-'))
  return path.join(dir, 'dsh-mem0', 'failures.json')
}

function withCode(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

// --- classification ---------------------------------------------------------

test('classifyFailure: timeout, connection, auth/quota, circuit, other', () => {
  const timeout = new Mem0RestError('Mem0 POST /search aborted', {
    code: 'ABORTED',
    cause: new Error('request timed out after 3000ms'),
  })
  assert.equal(classifyFailure(timeout), 'timeout')
  assert.equal(classifyFailure(withCode('connect ETIMEDOUT 10.0.0.1:443', 'ETIMEDOUT')), 'timeout')
  assert.equal(classifyFailure(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), 'timeout')
  assert.equal(classifyFailure(withCode('dsh-mem0: sidecar did not start within 60s', 'STARTUP_TIMEOUT')), 'timeout')
  assert.equal(classifyFailure(new Mem0RestError('Mem0 POST /search failed: gateway', { code: 'BACKEND_ERROR', status: 504 })), 'timeout')

  const refused = new Mem0RestError('Mem0 POST /search failed: fetch failed', {
    code: 'NETWORK_ERROR',
    cause: Object.assign(new TypeError('fetch failed'), { cause: withCode('connect ECONNREFUSED 127.0.0.1:1', 'ECONNREFUSED') }),
  })
  assert.equal(classifyFailure(refused), 'connection')
  assert.equal(classifyFailure(withCode('getaddrinfo ENOTFOUND api.mem0.ai', 'ENOTFOUND')), 'connection')
  assert.equal(classifyFailure(new Error('socket hang up')), 'connection')
  assert.equal(classifyFailure(withCode('read ECONNRESET', 'ECONNRESET')), 'connection')

  for (const status of [401, 403, 429]) {
    assert.equal(classifyFailure(new Mem0RestError(`Mem0 POST /search failed: HTTP ${status}`, { code: 'BACKEND_ERROR', status })), 'auth')
  }
  assert.equal(classifyFailure(new Error('Mem0 POST /memories failed: monthly quota exceeded')), 'auth')
  assert.equal(classifyFailure(new Error('Invalid API key provided')), 'auth')
  assert.equal(classifyFailure(new Error('Rate limit reached, slow down')), 'auth')

  assert.equal(classifyFailure(new Error('anything'), { circuit: true }), 'circuit')
  assert.equal(classifyFailure(withCode('skipped', 'CIRCUIT_OPEN')), 'circuit')

  assert.equal(classifyFailure(new Mem0RestError('Mem0 POST /search failed: internal timeout handler crashed', { code: 'BACKEND_ERROR', status: 500 })), 'other')
  assert.equal(classifyFailure(withCode('Mem0 baseUrl is not configured', 'CONFIG_MISSING')), 'config')
  assert.equal(classifyFailure(new Error('Mem0 POST /search aborted')), 'other')
  assert.equal(classifyFailure(undefined), 'other')
  // A duration that happens to contain 401 is not an HTTP status.
  assert.equal(classifyFailure(new Error('request failed after 4013ms')), 'other')
})

// --- real errors from the mock server ----------------------------------------

async function startMock() {
  const script = new URL('../scripts/mock-mem0-server.mjs', import.meta.url)
  const child = spawn(process.execPath, [fileURLToPath(script)], {
    env: { ...process.env, MOCK_MEM0_PORT: '0', MOCK_MEM0_KEY: '', MOCK_MEM0_USER: 'dsh-mem0-failure-test-user' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const port = await new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
      const match = out.match(/127\.0\.0\.1:(\d+)/)
      if (match) resolve(Number(match[1]))
    })
    child.once('exit', (code) => reject(new Error(`mock exited ${code}`)))
  })
  const baseUrl = `http://127.0.0.1:${port}`
  const fault = (value) =>
    fetch(`${baseUrl}/__fault`, { method: 'POST', body: JSON.stringify(value) }).then((response) => response.json())
  return { baseUrl, fault, stop: () => child.kill() }
}

localServerTest('mock server failure modes classify as timeout / auth / connection / other', async () => {
  const mock = await startMock()
  try {
    const client = new Mem0RestClient({
      mode: 'server',
      baseUrl: mock.baseUrl,
      authType: 'none',
      userId: 'dsh-mem0-failure-test-user',
      agentId: 'dsh',
      timeoutMs: 2_000,
    })
    const failureOf = async (options = {}) => {
      try {
        await client.search('tea', { user_id: 'dsh-mem0-failure-test-user' }, { topK: 3, ...options })
      } catch (error) {
        return error
      }
      assert.fail('search should fail')
    }
    // Healthy first.
    const ok = await client.search('tea', { user_id: 'dsh-mem0-failure-test-user' }, { topK: 3 })
    assert.ok(Array.isArray(ok.results))

    await mock.fault({ mode: 'delay', ms: 1_000 })
    assert.equal(classifyFailure(await failureOf({ timeoutMs: 150 })), 'timeout')

    await mock.fault({ mode: 'status', status: 401, detail: 'invalid api key' })
    const unauthorized = await failureOf()
    assert.equal(unauthorized.status, 401)
    assert.equal(classifyFailure(unauthorized), 'auth')

    await mock.fault({ mode: 'status', status: 429, detail: 'quota exceeded' })
    assert.equal(classifyFailure(await failureOf()), 'auth')

    await mock.fault({ mode: 'status', status: 500, detail: 'boom' })
    assert.equal(classifyFailure(await failureOf()), 'other')

    await mock.fault({ mode: 'drop' })
    assert.equal(classifyFailure(await failureOf()), 'connection')

    await mock.fault({ mode: 'none' })
    assert.ok(Array.isArray((await client.search('tea', { user_id: 'dsh-mem0-failure-test-user' }, { topK: 3 })).results))
  } finally {
    mock.stop()
  }
  // Nothing listening any more: connection refused.
  const closed = new Mem0RestClient({ mode: 'server', baseUrl: mock.baseUrl, authType: 'none', userId: 'u', agentId: 'dsh', timeoutMs: 2_000 })
  await new Promise((resolve) => setTimeout(resolve, 100))
  const refused = await closed.search('tea', { user_id: 'u' }).catch((error) => error)
  assert.equal(classifyFailure(refused), 'connection')
})

// --- ring buffer, persistence, corruption, redaction -------------------------

test('history keeps only the newest N failures, newest first', () => {
  const history = new FailureHistory({ filePath: tempFile(), limit: 20, backend: 'server' })
  for (let index = 0; index < 25; index += 1) {
    history.record({ kind: 'capture', error: new Error(`failure ${index}`), durationMs: index })
  }
  const list = history.list()
  assert.equal(list.length, 20)
  assert.equal(list[0].message, 'failure 24')
  assert.equal(list[19].message, 'failure 5')
  assert.equal(list[0].backend, 'server')
  assert.equal(list[0].kind, 'capture')
  assert.equal(list[0].durationMs, 24)
})

test('default limit is 20', () => {
  const history = new FailureHistory({ filePath: tempFile() })
  for (let index = 0; index < 30; index += 1) history.record({ kind: 'recall', error: new Error(`f${index}`) })
  assert.equal(history.list().length, 20)
})

test('consecutive identical failures fold into one entry with a count', () => {
  let clock = Date.parse('2026-11-06T00:00:00Z')
  const history = new FailureHistory({ now: () => new Date((clock += 1000)) })
  history.record({ kind: 'capture', error: new Error('older, different') })
  for (let index = 0; index < 50; index += 1) {
    history.record({ kind: 'recall', circuit: true, message: 'skipped: circuit open' })
  }
  const list = history.list()
  assert.equal(list.length, 2)
  assert.equal(list[0].cause, 'circuit')
  assert.equal(list[0].count, 50)
  assert.ok(Date.parse(list[0].firstAt) < Date.parse(list[0].at))
  assert.equal(list[1].message, 'older, different')
})

test('history survives a reload and is written atomically', () => {
  const file = tempFile()
  const first = new FailureHistory({ filePath: file, backend: 'platform' })
  first.record({
    kind: 'recall',
    error: new Mem0RestError('Mem0 POST /v3/memories/search/ failed: HTTP 429', { code: 'BACKEND_ERROR', status: 429 }),
    durationMs: 812,
  })
  first.record({ kind: 'maintenance', error: withCode('connect ECONNREFUSED 127.0.0.1:8000', 'ECONNREFUSED') })
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')),
    [],
  )
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(stored.version, 1)
  assert.equal(stored.entries.length, 2)

  const reloaded = new FailureHistory({ filePath: file, backend: 'platform' })
  const list = reloaded.list()
  assert.equal(list.length, 2)
  assert.deepEqual(
    list.map(({ kind, cause, status }) => ({ kind, cause, status })),
    [
      { kind: 'maintenance', cause: 'connection', status: undefined },
      { kind: 'recall', cause: 'auth', status: 429 },
    ],
  )
  assert.equal(list[1].durationMs, 812)
  assert.equal(list[1].code, 'BACKEND_ERROR')
})

test('a corrupt or foreign file is ignored and replaced on the next write', () => {
  const file = tempFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const warnings = []
  const logger = { warn: (message) => warnings.push(message), debug() {} }

  fs.writeFileSync(file, '{"version":1,"entries":[{"at":')
  const corrupt = new FailureHistory({ filePath: file, logger })
  assert.deepEqual(corrupt.list(), [])
  assert.equal(warnings.length, 1)
  corrupt.record({ kind: 'capture', error: new Error('after corruption') })
  assert.equal(new FailureHistory({ filePath: file }).list()[0].message, 'after corruption')

  // Valid JSON with junk entries: only well-formed ones survive.
  fs.writeFileSync(
    file,
    JSON.stringify({
      entries: [
        { at: 'not a date', kind: 'capture' },
        { at: '2026-11-06T00:00:00Z', kind: 'unknown' },
        null,
        { at: '2026-11-06T00:00:00Z', kind: 'recall', cause: 'weird', message: 'kept' },
      ],
    }),
  )
  const filtered = new FailureHistory({ filePath: file }).list()
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].cause, 'other')
  assert.equal(filtered[0].message, 'kept')
})

test('messages are redacted before they are stored', () => {
  const file = tempFile()
  const history = new FailureHistory({ filePath: file })
  const memoryText = 'The user said: '.concat('my private diary entry '.repeat(40))
  history.record({
    kind: 'capture',
    error: new Error(
      `Mem0 POST /memories failed: api_key=sk-abcdef1234567890XYZ Authorization: Bearer ghp_abcdefghijklmnop1234 ` +
        `at /Users/alice/.dsh/profiles/web/dsh-mem0 and C:\\Users\\bob\\AppData ${memoryText}`,
    ),
  })
  const raw = fs.readFileSync(file, 'utf8')
  assert.doesNotMatch(raw, /sk-abcdef1234567890XYZ/)
  assert.doesNotMatch(raw, /ghp_abcdefghijklmnop1234/)
  assert.doesNotMatch(raw, /alice|bob/)
  assert.match(raw, /\[REDACTED\]/)
  assert.match(raw, /~\/\.dsh\/profiles/)
  const [entry] = history.list()
  assert.ok(entry.message.length <= FAILURE_MESSAGE_MAX_CHARS)
  assert.doesNotMatch(raw, /(my private diary entry ){10}/)

  assert.equal(sanitizeFailureMessage('read /home/carol/x', { home: '' }), 'read ~/x')
  assert.equal(sanitizeFailureMessage(`open ${os.homedir()}/a`), 'open ~/a')
})

// --- wiring: recall, capture, breaker, maintenance ---------------------------

function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function session(messages) {
  return { id: 's1', header: {}, deriveMessages: () => messages }
}

function lifecycleWith(client, failures, { breaker } = {}) {
  const activity = { recall: null, capture: null }
  const lifecycle = new MemoryLifecycle({
    client,
    config: { userId: 'dsh-mem0-failure-test-user', agentId: 'dsh', recallTopK: 5, captureMaxChars: 450, autoRecall: true, autoCapture: true, captureFilter: 'all' },
    logger: { debug() {}, warn() {} },
    breaker: breaker ?? { isOpen: () => false, recordSuccess() {}, recordFailure() {} },
    activity,
    failures,
  })
  return { lifecycle, activity }
}

const assembly = () => ({ sections: [], contexts: [], tools: [], variables: {} })

test('a later success does not erase the failure history', async () => {
  const failures = new FailureHistory({ filePath: tempFile(), backend: 'server' })
  let fail = true
  const client = {
    async search() {
      if (fail) throw new Mem0RestError('Mem0 POST /search failed: HTTP 401', { code: 'BACKEND_ERROR', status: 401 })
      return { results: [{ id: 'm1', memory: 'Likes tea' }] }
    },
  }
  const { lifecycle, activity } = lifecycleWith(client, failures)
  await lifecycle.onSystemPromptAssemble(assembly(), { agent: { session: session([userMessage('tea?')]) } }, async () => assembly())
  assert.equal(activity.recall.status, 'error')
  fail = false
  await lifecycle.onSystemPromptAssemble(assembly(), { agent: { session: session([userMessage('coffee?')]) } }, async () => assembly())
  assert.equal(activity.recall.status, 'ok')
  const list = failures.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].kind, 'recall')
  assert.equal(list[0].cause, 'auth')
  assert.equal(list[0].status, 401)
  assert.ok(Number.isFinite(list[0].durationMs))
  // Kept, but marked recovered by the later successful recall.
  assert.equal(list[0].recovered, true)
  assert.ok(Date.parse(list[0].recoveredAt) >= Date.parse(list[0].at))
})

test('capture failures and circuit-breaker skips are recorded', async () => {
  const failures = new FailureHistory({ backend: 'oss' })
  const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 60_000 })
  const client = {
    async add() {
      throw withCode('connect ECONNREFUSED 127.0.0.1:8765', 'ECONNREFUSED')
    },
    async search() {
      return { results: [] }
    },
  }
  const { lifecycle } = lifecycleWith(client, failures, { breaker })
  const s = session([])
  const turn = (text) => {
    lifecycle.onSessionEvent(s, { type: 'turn/start' })
    lifecycle.onSessionEvent(s, { type: 'user/message', data: { role: 'user', content: text, source: { kind: 'user' } } })
    lifecycle.onSessionEvent(s, { type: 'assistant/message', data: { message: { content: 'Noted, I will remember that you prefer oolong tea.' } } })
    lifecycle.onSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  }
  turn('Please remember that I prefer oolong tea over coffee.')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(failures.latest().kind, 'capture')
  assert.equal(failures.latest().cause, 'connection')
  assert.equal(breaker.isOpen(), true)

  turn('Also remember that I live in the UTC+8 time zone.')
  await lifecycle.onSystemPromptAssemble(assembly(), { agent: { session: session([userMessage('tea?')]) } }, async () => assembly())
  const list = failures.list()
  assert.deepEqual(
    list.slice(0, 2).map(({ kind, cause }) => `${kind}:${cause}`),
    ['recall:circuit', 'capture:circuit'],
  )
  assert.equal(list[2].cause, 'connection')
})

test('maintenance failures record summary vs maintenance kind', async () => {
  const failures = new FailureHistory({ backend: 'server' })
  const client = {
    async list() {
      throw new Mem0RestError('Mem0 GET /memories aborted', { code: 'ABORTED', cause: new Error('request timed out after 30000ms') })
    },
  }
  const maintenance = new MemoryMaintenance({
    client,
    config: { userId: 'dsh-mem0-failure-test-user', hygieneEnabled: true, profileEnabled: true, profileBudgetTokens: 400 },
    activity: {},
    logger: { warn() {}, debug() {} },
    failures,
  })
  await assert.rejects(maintenance.run('manual'))
  await assert.rejects(maintenance.run('startup', { profileOnly: true }))
  await assert.rejects(maintenance.resetProfile())
  assert.deepEqual(
    failures.list().map(({ kind, cause, count }) => `${kind}:${cause}:${count}`),
    ['summary:timeout:2', 'maintenance:timeout:1'],
  )
})

// --- component attribution ---------------------------------------------------

/** A component-tagged 500 (an older sidecar's body, a server's body). */
function sidecarFailure(body, path = '/search') {
  const error = Object.assign(new Error(`dsh-mem0: POST ${path} failed: ${body.error}`), {
    code: 'BACKEND_ERROR',
    status: 500,
    path,
  })
  return Object.assign(error, failureAttribution(body))
}

test('local backend: an Ollama cold start is an embedder timeout with its endpoint', async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const error = await postJson('http://127.0.0.1:11434/api/embed', { model: 'bge-m3', input: ['x'] }, {
    timeoutMs: 30, component: 'embedder', step: 'embed', provider: 'ollama', fetchImpl,
  }).catch((value) => value)
  assert.ok(error instanceof ProviderError)
  assert.equal(error.code, 'ETIMEDOUT')
  assert.equal(classifyFailure(error), 'timeout')
  assert.deepEqual(attributeFailure(error, { backend: 'oss' }), {
    component: 'embedder',
    step: 'embed',
    provider: 'ollama',
    endpoint: '127.0.0.1:11434',
  })
  const entry = new FailureHistory({ backend: 'oss' }).record({ kind: 'recall', error, durationMs: 31 })
  assert.equal(entry.component, 'embedder')
  assert.equal(entry.cause, 'timeout')
  assert.equal(entry.endpoint, '127.0.0.1:11434')
})

test('local backend: SQLite errors are vector_store failures with a short code', () => {
  for (const [errcode, code] of [[5, 'busy'], [11, 'corrupt'], [8, 'readonly'], [13, 'disk_full']]) {
    const raw = Object.assign(new Error('database error'), { code: 'ERR_SQLITE_ERROR', errcode })
    const error = storeError(raw, { step: 'search', file: path.join(os.tmpdir(), 'memory.sqlite') })
    assert.equal(error.code, code)
    const attribution = attributeFailure(error, { backend: 'oss' })
    assert.equal(attribution.component, 'vector_store')
    assert.equal(attribution.step, 'search')
    assert.equal(attribution.provider, 'sqlite')
    const entry = new FailureHistory({ backend: 'oss' }).record({ kind: 'capture', error })
    assert.equal(entry.component, 'vector_store')
    assert.equal(entry.code, code)
  }
})

test('OSS hybrid: cloud LLM latency, 429 and 5xx are llm failures', () => {
  const rateLimited = sidecarFailure(
    { error: "Error code: 429 - {'error': {'message': 'Rate limit reached'}}", component: 'llm', step: 'llm_extract', provider: 'openai', endpoint: '127.0.0.1:3425' },
    '/add',
  )
  assert.equal(classifyFailure(rateLimited), 'auth')
  assert.equal(attributeFailure(rateLimited, { backend: 'oss' }).component, 'llm')

  const upstream = sidecarFailure({ error: 'Error code: 503 - upstream unavailable', component: 'llm', step: 'llm_extract' }, '/add')
  assert.equal(classifyFailure(upstream), 'other')
  assert.equal(attributeFailure(upstream, { backend: 'oss' }).step, 'llm_extract')

  const slow = sidecarFailure({ error: 'Request timed out.', component: 'llm', step: 'llm_extract' }, '/add')
  assert.equal(classifyFailure(slow), 'timeout')

  // Our own timeout during extraction.
  const aborted = new ProviderError('LLM at 127.0.0.1:3425: request timed out after 120000 ms', {
    component: 'llm', step: 'llm_extract', provider: 'openai', endpoint: '127.0.0.1:3425', code: 'ETIMEDOUT',
  })
  assert.equal(classifyFailure(aborted), 'timeout')
  assert.equal(attributeFailure(aborted, { backend: 'oss' }).component, 'llm')
})

test('OSS hybrid: Qdrant refused or a missing collection is a vector_store failure', () => {
  const refused = sidecarFailure({ error: '[Errno 61] Connection refused', component: 'vector_store', step: 'search', provider: 'qdrant', endpoint: '127.0.0.1:6333' })
  assert.equal(classifyFailure(refused), 'connection')
  assert.deepEqual(attributeFailure(refused, { backend: 'oss' }), {
    component: 'vector_store',
    step: 'search',
    provider: 'qdrant',
    endpoint: '127.0.0.1:6333',
  })
  const missing = sidecarFailure({ error: "Collection `dsh_mem0` doesn't exist!", component: 'vector_store', step: 'search' })
  assert.equal(classifyFailure(missing), 'other')
  assert.equal(attributeFailure(missing, { backend: 'oss' }).component, 'vector_store')
})

test('attribution without a component tag: hints, sidecar process, Mem0 API', () => {
  // Older sidecar or a self-hosted server passing its dependency's error through.
  assert.equal(attributeFailure(new Error('Mem0 POST /search failed: Collection mem0 not found'), { backend: 'server' }).component, 'vector_store')
  assert.equal(attributeFailure(new Error('could not connect to qdrant at localhost:6333'), { backend: 'server' }).component, 'vector_store')
  assert.equal(attributeFailure(new Error('dsh-mem0: POST /search failed: HTTPConnectionPool(host=127.0.0.1, port=11434)'), { backend: 'oss' }).component, 'embedder')
  assert.equal(attributeFailure(new Error('openai.RateLimitError: 429'), { backend: 'oss' }).component, 'llm')
  // The sidecar process itself.
  for (const code of ['STARTING', 'START_FAILED', 'SPAWN_FAILED', 'STARTUP_TIMEOUT', 'NETWORK_ERROR']) {
    assert.equal(attributeFailure(withCode('dsh-mem0: x', code), { backend: 'oss' }).component, 'sidecar', code)
  }
  assert.equal(attributeFailure(new Error('dsh-mem0: POST /search aborted'), { backend: 'oss' }).component, 'unknown')
  // Platform and self-hosted server without hints: the Mem0 API.
  const unauthorized = new Mem0RestError('Mem0 POST /v3/memories/search/ failed: HTTP 401', { code: 'BACKEND_ERROR', status: 401 })
  assert.equal(attributeFailure(unauthorized, { backend: 'platform' }).component, 'mem0_api')
  assert.equal(classifyFailure(unauthorized), 'auth')
  assert.equal(attributeFailure(withCode('fetch failed', 'NETWORK_ERROR'), { backend: 'server' }).component, 'mem0_api')
  // A tag that is not a known component is ignored.
  assert.deepEqual(failureAttribution({ component: 'rm -rf', step: 'x', endpoint: 'a/b?c' }), {})
})

test('a circuit-breaker skip inherits the component of the failure that opened it', () => {
  const history = new FailureHistory({ backend: 'oss' })
  history.record({ kind: 'capture', error: sidecarFailure({ error: 'Connection refused', component: 'vector_store', step: 'store' }, '/add') })
  const skip = history.record({ kind: 'recall', circuit: true, message: 'skipped: circuit open' })
  assert.equal(skip.cause, 'circuit')
  assert.equal(skip.component, 'vector_store')
  assert.equal(skip.step, 'store')
})

test('stored entries keep the component across a reload; old entries read as unknown', () => {
  const file = tempFile()
  new FailureHistory({ filePath: file, backend: 'oss' }).record({
    kind: 'recall',
    error: sidecarFailure({ error: 'refused', component: 'embedder', step: 'embed', provider: 'ollama', endpoint: '127.0.0.1:11434' }),
  })
  const [entry] = new FailureHistory({ filePath: file }).list()
  assert.equal(entry.component, 'embedder')
  assert.equal(entry.endpoint, '127.0.0.1:11434')
  fs.writeFileSync(file, JSON.stringify({ entries: [{ at: '2026-11-06T00:00:00Z', kind: 'capture', cause: 'timeout', message: 'old' }] }))
  assert.equal(new FailureHistory({ filePath: file }).list()[0].component, 'unknown')
})

// --- status bar --------------------------------------------------------------

function loadClient() {
  let registered
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window })
  const react = { createElement: () => null, useCallback: (fn) => fn, useEffect() {}, useLayoutEffect() {}, useMemo: (fn) => fn(), useRef: () => ({}), useState: (v) => [v, () => {}] }
  return registered.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require ${name}`)
  }).__test__
}

test('status bar: a failed status read and a failed memory operation are different states', () => {
  const { dockView, en, zh } = loadClient()
  for (const dict of [en, zh]) {
    const t = (key) => dict[key] ?? key
    const unavailable = dockView(t, { data: null, failed: true, fetchError: 'HTTP 502', failedAt: '2026-11-06T01:02:03Z' })
    assert.equal(unavailable.state, 'error')
    assert.equal(unavailable.kind, 'status')
    assert.equal(unavailable.label, dict.dockStatusUnavailable)
    assert.ok(unavailable.details.some((line) => line.includes('HTTP 502')))

    const data = {
      enabled: true,
      activity: { capture: { status: 'error', error: 'raw', at: '2026-11-06T01:00:00Z' }, recall: null },
      failures: [
        { at: '2026-11-06T01:00:00Z', kind: 'capture', cause: 'timeout', backend: 'oss', component: 'embedder', step: 'embed', provider: 'ollama', endpoint: '127.0.0.1:11434', message: 'Mem0 POST /memories aborted', count: 1 },
      ],
    }
    const memory = dockView(t, { data })
    assert.equal(memory.state, 'error')
    assert.equal(memory.kind, 'memory')
    assert.equal(memory.label, dict.dockError)
    assert.notEqual(memory.label, unavailable.label)
    const detail = memory.details.join('\n')
    assert.ok(detail.includes(dict.failureKind_capture))
    assert.ok(detail.includes(dict.failureCause_timeout))
    assert.ok(detail.includes(dict.failureComponent_embedder))
    assert.ok(detail.includes('ollama @ 127.0.0.1:11434'))
    assert.ok(detail.includes('Mem0 POST /memories aborted'))

    const healthy = dockView(t, { data: { enabled: true, activity: { capture: null, recall: null }, failures: data.failures } })
    assert.equal(healthy.state, 'idle')
    assert.equal(healthy.details, null)
  }
  assert.equal(zh.dockError, '记忆失败')
  assert.equal(zh.dockStatusUnavailable, '状态读取失败')
  assert.equal(en.dockError, 'Memory failed')
  assert.equal(en.dockStatusUnavailable, 'Status unavailable')
})

test('sidecar exits are stored with code/signal/uptime and never folded together', () => {
  const history = new FailureHistory({ backend: 'oss' })
  const died = (uptimeMs) => Object.assign(new Error('dsh-mem0: POST /add failed: fetch failed'), { code: 'NETWORK_ERROR', component: 'sidecar', signal: 'SIGKILL', uptimeMs })
  history.record({ kind: 'capture', error: died(10_355) })
  history.record({ kind: 'capture', error: died(306) })
  const [newest, older] = history.list()
  assert.equal(history.list().length, 2)
  assert.equal(newest.uptimeMs, 306)
  assert.equal(older.uptimeMs, 10_355)
  assert.equal(newest.signal, 'SIGKILL')
  assert.equal(newest.component, 'sidecar')
  // Junk exit fields are dropped.
  const bad = history.record({ kind: 'capture', error: Object.assign(new Error('x'), { exitCode: 1.5, signal: 'rm -rf', uptimeMs: -1 }) })
  assert.equal('exitCode' in bad, false)
  assert.equal('signal' in bad, false)
  assert.equal('uptimeMs' in bad, false)
})

// --- LLM extraction failures (sidecar 502 LLM_EXTRACT_FAILED) ----------------

test('an unusable extraction answer is cause "extraction" with a readable reason', () => {
  for (const reason of ['not_json', 'empty', 'truncated', 'refusal']) {
    const body = {
      error: 'the LLM\'s fact-extraction answer was cut off (truncated JSON); nothing was stored',
      code: 'LLM_EXTRACT_FAILED',
      reason,
      retryable: reason !== 'refusal',
      component: 'llm',
      step: 'llm_extract',
      provider: 'openai',
      endpoint: '127.0.0.1:64451',
    }
    const error = Object.assign(sidecarFailure(body, '/add'), { status: 502, code: 'LLM_EXTRACT_FAILED' })
    assert.equal(error.extractReason, reason)
    assert.equal(classifyFailure(error), 'extraction')
    const entry = new FailureHistory({ backend: 'oss' }).record({ kind: 'capture', error, durationMs: 27_102 })
    assert.equal(entry.cause, 'extraction')
    assert.equal(entry.reason, reason)
    assert.equal(entry.component, 'llm')
    assert.equal(entry.step, 'llm_extract')
    assert.equal(entry.code, 'LLM_EXTRACT_FAILED')
    assert.equal(entry.status, 502)
  }
  // An unknown reason from a newer sidecar still reads as an extraction failure.
  assert.equal(failureAttribution({ code: 'LLM_EXTRACT_FAILED', reason: 'weird' }).extractReason, 'not_json')
  // Other sidecar errors carry no reason.
  assert.equal('extractReason' in failureAttribution({ error: 'boom', component: 'llm' }), false)
  // A stored reason is kept only for extraction entries.
  const file = tempFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ entries: [
    { at: '2026-11-07T00:00:00Z', kind: 'capture', cause: 'extraction', reason: 'empty', message: 'a' },
    { at: '2026-11-07T00:00:00Z', kind: 'capture', cause: 'other', reason: 'empty', message: 'b' },
    { at: '2026-11-07T00:00:00Z', kind: 'capture', cause: 'extraction', reason: '<script>', message: 'c' },
  ] }))
  const [first, second, third] = new FailureHistory({ filePath: file }).list()
  assert.equal(first.reason, 'empty')
  assert.equal('reason' in second, false)
  assert.equal('reason' in third, false)
})

test('extraction stats (finish_reason, token counts) reach the error and the stored failure, numbers only', () => {
  const body = {
    error: 'the LLM\'s fact-extraction answer was cut off (truncated JSON); nothing was stored',
    code: 'LLM_EXTRACT_FAILED',
    reason: 'truncated',
    component: 'llm',
    step: 'llm_extract',
    finishReason: 'length',
    maxTokens: 2000,
    promptTokens: 9191,
    completionTokens: 2000,
    reasoningTokens: 1697,
    reasoningEffort: 'none',
  }
  const attribution = failureAttribution(body)
  assert.deepEqual(attribution.extractStats, { finishReason: 'length', reasoningEffort: 'none', maxTokens: 2000, promptTokens: 9191, completionTokens: 2000, reasoningTokens: 1697 })
  const error = Object.assign(sidecarFailure(body, '/add'), { status: 502, code: 'LLM_EXTRACT_FAILED' })
  const entry = new FailureHistory({ backend: 'oss' }).record({ kind: 'capture', error })
  assert.equal(entry.extract.finishReason, 'length')
  assert.equal(entry.extract.reasoningTokens, 1697)
  // Junk is dropped; other errors carry no stats.
  assert.equal(failureAttribution({ ...body, finishReason: 'x'.repeat(40), maxTokens: -1, promptTokens: 1.5, completionTokens: '2000', reasoningTokens: undefined, reasoningEffort: 'NONE!' }).extractStats, undefined)
  assert.equal('extractStats' in failureAttribution({ error: 'boom', component: 'llm', finishReason: 'length' }), false)
  // A stored entry keeps stats only for extraction failures.
  const file = tempFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ entries: [
    { at: '2026-11-07T00:00:00Z', kind: 'capture', cause: 'extraction', reason: 'truncated', message: 'a', extract: { finishReason: 'length', maxTokens: 2000, text: 'secret' } },
    { at: '2026-11-07T00:00:00Z', kind: 'capture', cause: 'other', message: 'b', extract: { finishReason: 'length' } },
  ] }))
  const [first, second] = new FailureHistory({ filePath: file }).list()
  assert.deepEqual(first.extract, { finishReason: 'length', maxTokens: 2000 })
  assert.equal('extract' in second, false)
})

// --- recovery: a later success of the same kind -----------------------------

function clockedHistory(options = {}) {
  let clock = Date.parse('2026-11-25T05:00:00Z')
  const tick = (ms = 1000) => (clock += ms)
  const history = new FailureHistory({ now: () => new Date(clock), ...options })
  return { history, tick }
}

test('recovery: a later success of the same kind recovers the failure; another kind does not', () => {
  const { history, tick } = clockedHistory()
  history.record({ kind: 'recall', error: withCode('connect ECONNREFUSED 127.0.0.1:8000', 'ECONNREFUSED') })
  assert.equal(history.list()[0].recovered, false)
  assert.equal('recoveredAt' in history.list()[0], false)
  tick()
  assert.equal(history.recordSuccess('capture'), false, 'another kind recovers nothing')
  assert.equal(history.list()[0].recovered, false)
  tick()
  assert.equal(history.recordSuccess('recall'), true)
  const [entry] = history.list()
  assert.equal(entry.recovered, true)
  assert.equal(entry.recoveredAt, '2026-11-25T05:00:02.000Z')
  assert.equal(history.recordSuccess('skipped'), false, 'unknown kinds are ignored')
})

test('recovery: a failure after the success has not recovered', () => {
  const { history, tick } = clockedHistory()
  history.recordSuccess('capture')
  tick()
  history.record({ kind: 'capture', error: new Error('HTTP 500 boom') })
  assert.equal(history.list()[0].recovered, false)
  tick()
  history.recordSuccess('capture')
  assert.equal(history.list()[0].recovered, true)
})

test('recovery: a process exit recovers on any later success; circuit and config entries by their kind', () => {
  const { history, tick } = clockedHistory({ backend: 'oss' })
  history.record({ kind: 'capture', error: Object.assign(new Error('fetch failed'), { code: 'NETWORK_ERROR', signal: 'SIGKILL', uptimeMs: 300 }) })
  tick()
  history.record({ kind: 'recall', circuit: true, message: 'skipped: circuit breaker open', durationMs: 0 })
  tick()
  history.record({ kind: 'maintenance', error: Object.assign(new Error('no embedder configured'), { configError: true }) })
  tick()
  history.recordSuccess('summary')
  const byCause = (list) => Object.fromEntries(list.map((entry) => [entry.cause, entry.recovered]))
  const before = history.list()
  assert.equal(before.find((entry) => entry.signal === 'SIGKILL').recovered, true, 'any success after an exit')
  assert.equal(byCause(before).circuit, false)
  assert.equal(byCause(before).config, false)
  tick()
  history.recordSuccess('recall')
  assert.equal(byCause(history.list()).circuit, true)
  assert.equal(byCause(history.list()).config, false)
  tick()
  history.recordSuccess('maintenance')
  assert.equal(byCause(history.list()).config, true)
})

test('recovery: stored on disk and kept across a restart', () => {
  const file = tempFile()
  let clock = Date.parse('2026-11-25T05:00:00Z')
  const now = () => new Date(clock)
  const first = new FailureHistory({ filePath: file, now })
  first.record({ kind: 'recall', error: new Error('HTTP 500 boom') })
  clock += 1000
  first.recordSuccess('recall')
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(stored.version, 1)
  assert.deepEqual(stored.lastOk, { recall: '2026-11-25T05:00:01.000Z' })
  const reloaded = new FailureHistory({ filePath: file, now })
  assert.equal(reloaded.list()[0].recovered, true)
  assert.equal(reloaded.list()[0].recoveredAt, '2026-11-25T05:00:01.000Z')
})

test('recovery: a file without lastOk (earlier versions) reads as no success', () => {
  const file = tempFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [{ at: '2026-11-25T05:00:00Z', kind: 'capture', cause: 'timeout', message: 'old' }] }))
  const history = new FailureHistory({ filePath: file })
  assert.deepEqual(history.lastOk, {})
  assert.equal(history.acknowledgedAt, null)
  assert.equal(history.list()[0].recovered, false)
  // Junk in lastOk is dropped.
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [], lastOk: { recall: 'nope', capture: '2026-11-25T06:00:00Z', other: '2026-11-25T06:00:00Z' } }))
  assert.deepEqual(new FailureHistory({ filePath: file }).lastOk, { capture: '2026-11-25T06:00:00.000Z' })
})

test('recovery: a success that recovers nothing is not written to disk', () => {
  const file = tempFile()
  let clock = Date.parse('2026-11-25T05:00:00Z')
  const history = new FailureHistory({ filePath: file, now: () => new Date(clock) })
  history.recordSuccess('recall')
  assert.equal(fs.existsSync(file), false, 'no entries: nothing to write')
  clock += 1000
  history.record({ kind: 'capture', error: new Error('HTTP 500 boom') })
  const written = fs.readFileSync(file, 'utf8')
  clock += 1000
  history.recordSuccess('recall')
  assert.equal(fs.readFileSync(file, 'utf8'), written, 'another kind: the file is unchanged')
  clock += 1000
  history.recordSuccess('capture')
  assert.notEqual(fs.readFileSync(file, 'utf8'), written)
  const again = fs.readFileSync(file, 'utf8')
  clock += 1000
  history.recordSuccess('capture')
  assert.equal(fs.readFileSync(file, 'utf8'), again, 'already recovered: no second write')
  // The in-memory time still moves on.
  assert.equal(history.lastOk.capture, '2026-11-25T05:00:04.000Z')
})

test('acknowledge: stored as acknowledgedAt and kept across a restart', () => {
  const file = tempFile()
  const history = new FailureHistory({ filePath: file })
  history.record({ kind: 'recall', error: new Error('HTTP 500 boom') })
  const at = history.list()[0].at
  assert.equal(history.acknowledge('not a time'), null)
  assert.equal(history.acknowledge(at), at)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).acknowledgedAt, at)
  assert.equal(new FailureHistory({ filePath: file }).acknowledgedAt, at)
})

test('successful capture, maintenance and summary calls recover their failures; skips do not', async () => {
  const failures = new FailureHistory({ backend: 'server' })
  let fail = true
  const client = {
    async add() {
      if (fail) throw new Mem0RestError('Mem0 POST /add failed: HTTP 500', { code: 'BACKEND_ERROR', status: 500 })
      return { results: [{ id: 'm1', memory: 'Prefers oolong tea', event: 'ADD' }] }
    },
    async search() {
      return { results: [] }
    },
    async list() {
      if (fail) throw new Mem0RestError('Mem0 GET /memories aborted', { code: 'ABORTED', cause: new Error('request timed out after 30000ms') })
      return { results: [] }
    },
  }
  const { lifecycle } = lifecycleWith(client, failures)
  const s = session([])
  const turn = (text) => {
    lifecycle.onSessionEvent(s, { type: 'turn/start' })
    lifecycle.onSessionEvent(s, { type: 'user/message', data: { role: 'user', content: text, source: { kind: 'user' } } })
    lifecycle.onSessionEvent(s, { type: 'assistant/message', data: { message: { content: 'Noted, I will remember that you prefer oolong tea.' } } })
    lifecycle.onSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  }
  const maintenance = new MemoryMaintenance({
    client,
    config: { userId: 'dsh-mem0-failure-test-user', hygieneEnabled: true, profileEnabled: true, profileBudgetTokens: 400 },
    activity: {},
    logger: { warn() {}, debug() {} },
    failures,
  })
  turn('Please remember that I prefer oolong tea over coffee.')
  await new Promise((resolve) => setTimeout(resolve, 20))
  await assert.rejects(maintenance.run('manual'))
  await assert.rejects(maintenance.run('startup', { profileOnly: true }))
  const recovered = () => Object.fromEntries(failures.list().map((entry) => [entry.kind, entry.recovered]))
  assert.deepEqual(recovered(), { summary: false, maintenance: false, capture: false })
  await new Promise((resolve) => setTimeout(resolve, 5))
  fail = false
  // A too-short turn is skipped, not a success.
  turn('ok')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(recovered().capture, false)
  turn('Also remember that I live in the UTC+8 time zone, please.')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(recovered().capture, true)
  await maintenance.run('manual')
  assert.deepEqual(recovered(), { summary: false, maintenance: true, capture: true })
  await maintenance.run('startup', { profileOnly: true })
  assert.deepEqual(recovered(), { summary: true, maintenance: true, capture: true })
})

test('the acknowledge route stores the time the page sent, and refuses a bad one', () => {
  const failures = new FailureHistory({})
  assert.equal(handleFailuresAcknowledged({}, { at: '2026-11-25T05:00:00Z' }).status, 404)
  assert.equal(handleFailuresAcknowledged({ failures }, { at: 'soon' }).status, 400)
  const outcome = handleFailuresAcknowledged({ failures }, { action: 'acknowledge', at: '2026-11-25T05:00:00Z' })
  assert.deepEqual(outcome, { status: 200, body: { ok: true, acknowledgedAt: '2026-11-25T05:00:00.000Z' } })
  assert.equal(failures.acknowledgedAt, '2026-11-25T05:00:00.000Z')
})

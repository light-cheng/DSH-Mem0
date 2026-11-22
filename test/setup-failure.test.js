// Setup wizard failures on the local-model path: every failure carries a
// structured reason (lib/setup-wizard.js failureOf) and the page turns it
// into a sentence that says why and what to do next (client.js
// failureText). A mock OpenAI-compatible server listens on a random port
// of 127.0.0.1 (never 8000: that may be the user's own oMLX); calls meant
// for 8000 or 11434 go through an injected fetch that sends them to the
// mock. No real key, no real service, no real memories.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { failureOf, listModels, probeLocalServices, testEmbedder, testLlm } from '../lib/setup-wizard.js'
import { handleSetupAction } from '../lib/setup-routes.js'
import { resolveNativeSettings } from '../lib/oss-config.js'
import { Mem0NativeClient } from '../lib/native-client.js'

const TEST_KEY = 'test-local-key-0123456789'
const DIMS = 6
const SPEC_AUTH_ZH = 'oMLX 在运行，但开启了 API key 验证。可以在下面填入 key，或者在 oMLX 设置里关掉 API key 验证（服务只监听本机时，关掉影响不大）。'

// ---- the page's pure helpers (client.js evaluated as the host does) ---------

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
const page = loadClient()
const template = (text, values) => String(text).replace(/\{(\w+)\}/g, (_, key) => String(values?.[key] ?? ''))
const tr = (dict) => (key) => (key in dict ? dict[key] : key)
const zh = tr(page.zh)
const en = tr(page.en)

// ---- the mock server ----------------------------------------------------------

const seen = []
let server
let port
const hanging = new Set()

before(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      seen.push({ url: req.url, authorization: req.headers.authorization })
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(typeof body === 'string' ? body : JSON.stringify(body))
      }
      if (req.url.startsWith('/hang')) {
        hanging.add(res)
        return
      }
      if (req.url.startsWith('/broken/')) {
        return send(500, { error: { message: `model crashed: CUDA out of memory, key sk-live1234567890abcdef leaked ${'x'.repeat(400)}\nTraceback (most recent call last):\n  secret internals` } })
      }
      if (!req.url.startsWith('/v1/')) return send(404, { detail: 'Not Found' })
      if (req.headers.authorization !== `Bearer ${TEST_KEY}`) return send(401, { error: { message: 'API key required' } })
      if (req.url === '/v1/models') return send(200, { data: [{ id: 'bge-m3-mlx' }, { id: 'qwen3-8b' }] })
      const body = raw ? JSON.parse(raw) : {}
      if (req.url === '/v1/embeddings') return send(200, { data: body.input.map((_, index) => ({ index, embedding: Array.from({ length: DIMS }, (_, i) => i + index + 1) })) })
      if (req.url === '/v1/chat/completions') return send(200, { choices: [{ message: { content: '{"memory":[{"text":"Lives in Lisbon"}]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 10 } })
      return send(404, { error: { message: `no route ${req.url}` } })
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  port = server.address().port
  assert.notEqual(port, 8000)
})

after(async () => {
  for (const res of hanging) res.destroy()
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
})

/** fetch that sends 127.0.0.1:<from> to the mock (the address keeps its port for naming). */
const redirect = (from) => (url, init) => fetch(String(url).replace(`127.0.0.1:${from}`, `127.0.0.1:${port}`), init)

async function closedPort() {
  const probe = http.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const free = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return free
}

const tempDirs = []
after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }) })
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-failure-'))
  tempDirs.push(dir)
  return dir
}

function credentialsCtx(initial = {}) {
  const values = new Map(Object.entries(initial))
  const logs = []
  const log = (line) => logs.push(String(line))
  return {
    values,
    logs,
    ctx: {
      logger: { info: log, warn: log, debug: log },
      get(name) {
        if (name !== 'credentials') return undefined
        return {
          resolve: async (ref) => (values.has(ref) ? { value: values.get(ref), source: 'file' } : undefined),
          describe: async (ref) => ({ configured: values.has(ref), source: values.has(ref) ? 'file' : undefined, writable: true }),
          set: async (ref, value) => { values.set(ref, value) },
        }
      },
    },
  }
}

// ---- probe ----------------------------------------------------------------------

for (const status of [401, 403]) {
  test(`probe: oMLX answering ${status} is running and needs a key; the page fills it in and says so`, async () => {
    const fetchImpl = async (url) => {
      if (String(url).startsWith('http://127.0.0.1:8000/')) return new Response('{"error":{"message":"Invalid API key"}}', { status })
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
    }
    const services = await probeLocalServices({ platform: 'darwin', fetchImpl })
    const omlx = services.find((item) => item.id === 'omlx')
    assert.equal(omlx.ok, false)
    assert.equal(omlx.running, true)
    assert.equal(omlx.needsKey, true)
    assert.equal(omlx.failure.reason, 'auth')
    assert.equal(omlx.failure.status, status)
    assert.equal(omlx.failure.service, 'oMLX')
    assert.equal(omlx.failure.keySent, false)
    const ollama = services.find((item) => item.id === 'ollama')
    assert.equal(ollama.running, false)
    assert.equal(ollama.failure.reason, 'refused')
    assert.equal(ollama.error, 'not running', 'the Windows summary still finds refused services')

    // The page: oMLX is picked (address empty), as OpenAI-compatible, with the hint.
    const pick = page.probeAutofill(services, { baseUrl: '' })
    assert.equal(pick.id, 'omlx')
    assert.equal(pick.baseUrl, 'http://127.0.0.1:8000/v1')
    assert.equal(pick.provider, 'openai')
    assert.equal(page.failureText(zh, omlx.failure), SPEC_AUTH_ZH)
    assert.equal(page.probeLineText(zh, omlx), `oMLX（端口 8000）：${SPEC_AUTH_ZH}`)
    assert.match(page.failureText(en, omlx.failure), /^oMLX is running but has API key verification on\. Enter the key below, or turn off API key verification in oMLX's settings/)
    assert.equal(page.probeLineText(zh, ollama), 'Ollama（端口 11434）：没有运行。要用它，先启动 Ollama。')
    // A typed custom address is kept.
    assert.equal(page.probeAutofill(services, { baseUrl: 'http://127.0.0.1:9999/v1' }), null)
  })
}

test('probe: a service listing models wins over one that needs a key; timeouts say no answer', async () => {
  const fetchImpl = async (url) => {
    if (String(url).startsWith('http://127.0.0.1:8000/')) return new Response('{}', { status: 401 })
    if (String(url).startsWith('http://127.0.0.1:1234/')) return new Response(JSON.stringify({ data: [{ id: 'text-embedding-nomic-embed-text-v1.5' }] }), { status: 200 })
    const error = new Error('The operation was aborted due to timeout')
    error.name = 'TimeoutError'
    throw error
  }
  const services = await probeLocalServices({ platform: 'darwin', fetchImpl, timeoutMs: 1500 })
  assert.equal(page.probeAutofill(services, { baseUrl: '' }).id, 'lmstudio')
  const ollama = services.find((item) => item.id === 'ollama')
  assert.equal(ollama.failure.reason, 'timeout')
  assert.equal(ollama.error, 'no answer')
  assert.equal(page.probeLineText(zh, ollama), 'Ollama（端口 11434）：没有回应：端口上可能没有服务，或者 Ollama 卡住了。重启 Ollama 后再探测一次。')
})

test('probe: oMLX is probed on macOS only; Windows keeps the reserved-port hint', async () => {
  const refused = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }) }
  for (const platform of ['win32', 'linux']) {
    const services = await probeLocalServices({ platform, fetchImpl: refused })
    assert.ok(!services.some((item) => item.port === 8000), platform)
    assert.ok(services.every((item) => item.failure.reason === 'refused' && item.failure.platform === platform))
    // Starters named for the platform: no oMLX off macOS.
    assert.equal(page.failureText(zh, failureOf({ error: (await refused().catch((e) => e)), baseUrl: 'http://127.0.0.1:5555/v1', platform })), '127.0.0.1:5555 端口上没有服务在跑（连接被拒）。先启动 Ollama 或 LM Studio，再试一次。')
  }
  const reserved = await probeLocalServices({ platform: 'win32', fetchImpl: async () => { throw new TypeError('fetch failed', { cause: new Error('connect EACCES (os error 10013)') }) } })
  assert.ok(reserved.every((item) => item.hint?.command === 'netsh int ipv4 show excludedportrange protocol=tcp'))
})

// ---- list models / test against the mock ----------------------------------------

test('list models at /v1 without a key: 401, auth reason, the oMLX sentence', async () => {
  const result = await listModels({ provider: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', fetchImpl: redirect(8000), platform: 'darwin' })
  assert.equal(result.ok, false)
  assert.equal(result.failure.reason, 'auth')
  assert.equal(result.failure.status, 401)
  assert.equal(result.failure.keySent, false)
  assert.equal(page.wizardError(zh, result), SPEC_AUTH_ZH)
  // An address on another port: the general wording.
  const other = await listModels({ provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, platform: 'darwin' })
  assert.equal(page.failureText(zh, other.failure), '服务在运行，但开启了 API key 验证。可以在下面填入 key，或者在服务的设置里关掉 API key 验证（服务只监听本机时，关掉影响不大）。')
})

test('list models with the key: 200 and the models; a wrong key says the key was refused', async () => {
  const result = await listModels({ provider: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', apiKey: TEST_KEY, fetchImpl: redirect(8000), platform: 'darwin' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.models, ['bge-m3-mlx', 'qwen3-8b'])
  assert.deepEqual(result.embeddingModels, ['bge-m3-mlx'])
  assert.equal(seen.at(-1).authorization, `Bearer ${TEST_KEY}`)
  const wrong = await listModels({ provider: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', apiKey: 'wrong-key-000000', fetchImpl: redirect(8000), platform: 'darwin' })
  assert.equal(wrong.failure.keySent, true)
  assert.equal(page.failureText(zh, wrong.failure), 'oMLX 拒绝了这个 API key（HTTP 401）。请核对 key，或者在 oMLX 设置里关掉 API key 验证（服务只监听本机时，关掉影响不大）。')
})

test('an address without /v1: 404 with a suggested address (the page offers "change to"); paths kept as typed', async () => {
  const result = await listModels({ provider: 'openai', baseUrl: 'http://127.0.0.1:8000', apiKey: TEST_KEY, fetchImpl: redirect(8000), platform: 'darwin' })
  assert.equal(result.failure.reason, 'not_found')
  assert.equal(result.failure.status, 404)
  assert.equal(result.failure.suggestedBaseUrl, 'http://127.0.0.1:8000/v1')
  assert.equal(page.failureText(zh, result.failure), '地址路径不对（HTTP 404）。OpenAI 兼容的地址通常以 /v1 结尾，比如 http://127.0.0.1:8000/v1。')
  assert.equal(page.failureText(en, result.failure), 'Wrong address path (HTTP 404). An OpenAI-compatible address usually ends with /v1, for example http://127.0.0.1:8000/v1.')
  assert.equal(template(page.zh.wzUseSuggested, { url: result.failure.suggestedBaseUrl }), '改成 http://127.0.0.1:8000/v1')
  // The suggestion, when used, works.
  const fixed = await listModels({ provider: 'openai', baseUrl: result.failure.suggestedBaseUrl, apiKey: TEST_KEY, fetchImpl: redirect(8000), platform: 'darwin' })
  assert.equal(fixed.ok, true)
  // An address with a path (custom, LM Studio's /v1) is never rewritten.
  const custom = await listModels({ provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1/other`, apiKey: TEST_KEY, platform: 'darwin' })
  assert.equal(custom.failure.reason, 'not_found')
  assert.equal(custom.failure.suggestedBaseUrl, undefined)
  assert.match(page.failureText(zh, custom.failure), /^服务返回 HTTP 404：no route \/v1\/other\/models。请核对地址路径和模型名/)
  assert.equal(failureOf({ status: 404, baseUrl: 'http://127.0.0.1:1234/v1', platform: 'linux' }).suggestedBaseUrl, undefined)
  // Ollama's 404 is about the model, not /v1.
  const ollama = failureOf({ status: 404, body: { error: 'model "bge-m3" not found, try pulling it first' }, baseUrl: 'http://127.0.0.1:11434', provider: 'ollama', platform: 'linux' })
  assert.equal(ollama.suggestedBaseUrl, undefined)
  assert.equal(page.failureText(zh, ollama), 'Ollama 返回 HTTP 404：model "bge-m3" not found, try pulling it first。请核对模型名（先用 ollama pull 下载）；Ollama 的地址不带路径，比如 http://127.0.0.1:11434。')
})

test('connection refused: nothing runs on the port, start the service', async () => {
  const free = await closedPort()
  const result = await listModels({ provider: 'openai', baseUrl: `http://127.0.0.1:${free}/v1`, platform: 'darwin' })
  assert.equal(result.failure.reason, 'refused')
  assert.equal(page.failureText(zh, result.failure), `127.0.0.1:${free} 端口上没有服务在跑（连接被拒）。先启动 oMLX、Ollama 或 LM Studio，再试一次。`)
  // A known port names its service (the embedder test goes through providers.js).
  const embed = await testEmbedder({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'bge-m3' }, { fetchImpl: (url, init) => fetch(String(url).replace('127.0.0.1:11434', `127.0.0.1:${free}`), init), platform: 'linux' })
  assert.equal(embed.failure.reason, 'refused')
  assert.equal(embed.failure.service, 'Ollama')
  assert.equal(page.failureText(zh, embed.failure), '127.0.0.1:11434 端口上没有服务在跑（连接被拒）。先启动 Ollama，再试一次。')
  assert.equal(page.failureText(en, embed.failure), 'Nothing is running on 127.0.0.1:11434 (connection refused). Start Ollama first, then try again.')
})

test('timeout: the service did not answer in time', async () => {
  const result = await listModels({ provider: 'openai', baseUrl: `http://127.0.0.1:${port}/hang`, timeoutMs: 300, platform: 'darwin' })
  assert.equal(result.failure.reason, 'timeout')
  assert.equal(result.failure.timeoutMs, 300)
  assert.equal(page.failureText(zh, result.failure), `127.0.0.1:${port} 没有在 0.3 秒内回应：端口上可能没有服务在跑，或者还在加载模型。先启动 oMLX、Ollama 或 LM Studio，再试一次。`)
  const llm = await testLlm({ baseUrl: 'http://127.0.0.1:8000/hang', model: 'm' }, { fetchImpl: redirect(8000), timeoutMs: 300, platform: 'darwin' })
  assert.equal(llm.failure.reason, 'timeout')
  assert.equal(page.failureText(zh, llm.failure), 'oMLX（127.0.0.1:8000）没有在 0.3 秒内回应：端口上可能没有服务在跑，或者还在加载模型。确认 oMLX 已启动，再试一次。')
})

test('HTTP 500: the status and the first line of the server error, redacted and cut short', async () => {
  for (const run of [
    () => listModels({ provider: 'openai', baseUrl: 'http://127.0.0.1:8000/broken', fetchImpl: redirect(8000), platform: 'darwin' }),
    () => testEmbedder({ provider: 'openai', baseUrl: 'http://127.0.0.1:8000/broken', model: 'm' }, { fetchImpl: redirect(8000), platform: 'darwin' }),
    () => testLlm({ baseUrl: 'http://127.0.0.1:8000/broken', model: 'm' }, { fetchImpl: redirect(8000), platform: 'darwin' }),
  ]) {
    const result = await run()
    assert.equal(result.failure.reason, 'http')
    assert.equal(result.failure.status, 500)
    const detail = result.failure.detail
    assert.ok(detail.startsWith('model crashed: CUDA out of memory, key [REDACTED] leaked'), detail)
    assert.ok(!detail.includes('sk-live'), detail)
    assert.ok(!detail.includes('Traceback'), 'first line only')
    assert.ok(detail.length <= 200, String(detail.length))
    const text = page.failureText(zh, result.failure)
    assert.ok(text.startsWith('oMLX 返回 HTTP 500：model crashed: CUDA out of memory'), text)
    assert.ok(!text.includes('sk-live'))
  }
  // The typed key is never echoed back, even when the server repeats it.
  const echoed = failureOf({ status: 500, body: { error: `bad key ${TEST_KEY}` }, baseUrl: 'http://127.0.0.1:8000/v1', apiKey: TEST_KEY, platform: 'darwin' })
  assert.equal(echoed.detail, 'bad key [REDACTED]')
})

// ---- the routes: a local key goes everywhere it must, and is stored as a secret ----

const localDraft = (dir, base) => ({
  embedder: { provider: 'openai', baseUrl: base, model: 'bge-m3-mlx', apiKeyRef: 'DSH_MEM0_EMBEDDER_API_KEY' },
  llm: { baseUrl: base, model: 'qwen3-8b', apiKeyRef: 'DSH_MEM0_LLM_API_KEY', maxTokens: 8000 },
  storePath: path.join(dir, 'memory.sqlite'),
})

test('routes: list models, test embedder and test LLM send the typed key of a local server', async () => {
  const dir = tempDir()
  const { ctx } = credentialsCtx()
  const runtime = { config: { backend: 'platform', ossConfigPath: path.join(dir, 'oss.json'), profileFields: [] } }
  const draft = localDraft(dir, `http://127.0.0.1:${port}/v1`)
  const keys = { embedder: TEST_KEY, llm: TEST_KEY }
  for (const [action, extra, check] of [
    ['listModels', { component: 'embedder' }, (r) => assert.deepEqual(r.models, ['bge-m3-mlx', 'qwen3-8b'])],
    ['listModels', { component: 'llm' }, (r) => assert.equal(r.ok, true)],
    ['testEmbedder', {}, (r) => assert.equal(r.dims, DIMS)],
    ['testLlm', {}, (r) => assert.equal(r.facts, 1)],
  ]) {
    const before = seen.length
    const result = await handleSetupAction(ctx, runtime, { action, draft, keys, ...extra })
    assert.equal(result.ok, true, `${action}: ${JSON.stringify(result)}`)
    check(result)
    assert.ok(seen.length > before)
    assert.ok(seen.slice(before).every((request) => request.authorization === `Bearer ${TEST_KEY}`), action)
  }
  // Without the key: structured auth failures (generic wording, the mock's port is no known service).
  const embed = await handleSetupAction(ctx, runtime, { action: 'testEmbedder', draft })
  assert.equal(embed.failure.reason, 'auth')
  assert.equal(page.wizardError(zh, embed), '服务在运行，但开启了 API key 验证。可以在下面填入 key，或者在服务的设置里关掉 API key 验证（服务只监听本机时，关掉影响不大）。')
  const llm = await handleSetupAction(ctx, runtime, { action: 'testLlm', draft })
  assert.equal(llm.failure.reason, 'auth')
  const view = page.llmTestView(zh, llm)
  assert.equal(view.reason, template(page.zh.wzLlmReason, { reason: page.failureText(zh, llm.failure) }))
  assert.deepEqual(view.advice, [], 'the failure text carries the next step')
  // The self-test explains an embedder failure the same way.
  const self = await handleSetupAction(ctx, runtime, { action: 'selfTest', draft })
  assert.equal(self.ok, false)
  assert.equal(self.failure.reason, 'auth')
  assert.equal(self.component, 'embedder')
})

test('save: a local key goes to DSH credentials only; the running client then sends it to the embedder and the LLM', async () => {
  const dir = tempDir()
  const { ctx, values, logs } = credentialsCtx()
  const ossConfigPath = path.join(dir, 'oss.json')
  const runtime = { config: { backend: 'platform', ossConfigPath, profileFields: [] } }
  const draft = localDraft(dir, `http://127.0.0.1:${port}/v1`)
  const saved = await handleSetupAction(ctx, runtime, { action: 'save', draft, keys: { embedder: TEST_KEY, llm: TEST_KEY } })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.equal(values.get('DSH_MEM0_EMBEDDER_API_KEY'), TEST_KEY)
  assert.equal(values.get('DSH_MEM0_LLM_API_KEY'), TEST_KEY)
  const file = fs.readFileSync(ossConfigPath, 'utf8')
  assert.ok(!file.includes(TEST_KEY), 'no key in oss.json')
  const block = JSON.parse(file).dsh_mem0
  assert.equal(block.embedderApiKeyRef, 'DSH_MEM0_EMBEDDER_API_KEY')
  assert.equal(block.llmApiKeyRef, 'DSH_MEM0_LLM_API_KEY')
  assert.ok(logs.every((line) => !line.includes(TEST_KEY)), 'no key in the log')

  // The real calls after saving: settings from oss.json, keys from DSH credentials.
  const settings = resolveNativeSettings(block, undefined)
  const client = new Mem0NativeClient({
    config: { userId: 'dsh-mem0-test-user', agentId: 'dsh-mem0-test' },
    loadSettings: () => ({ ...settings, storePath: path.join(dir, 'runtime.sqlite') }),
    resolveSecret: async (ref) => values.get(ref),
    logger: { info() {}, warn() {}, debug() {} },
  })
  try {
    const before = seen.length
    await client.add([{ role: 'user', content: 'I moved to Lisbon last spring.' }], { userId: 'dsh-mem0-test-user', agentId: 'dsh-mem0-test' })
    const calls = seen.slice(before)
    assert.ok(calls.some((request) => request.url === '/v1/embeddings'), JSON.stringify(calls))
    assert.ok(calls.some((request) => request.url === '/v1/chat/completions'), JSON.stringify(calls))
    assert.ok(calls.every((request) => request.authorization === `Bearer ${TEST_KEY}`))
  } finally {
    await client.dispose()
  }
})

// ---- the page's draft ----------------------------------------------------------

test('page draft: a local OpenAI-compatible server keeps its credential name when a key is typed or stored; Ollama never', () => {
  const base = { mode: 'local', provider: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', model: 'bge-m3', dims: '', apiKeyRef: 'DSH_MEM0_EMBEDDER_API_KEY' }
  const payload = (embedder) => page.wizardPayload({ embedder, llm: { maxTokens: 8000 }, storePath: '', useLiteralKey: {} }).embedder
  assert.equal(payload({ ...base, keyTyped: true }).apiKeyRef, 'DSH_MEM0_EMBEDDER_API_KEY')
  assert.equal(payload({ ...base, keyTyped: false }).apiKeyRef, '')
  assert.equal(payload({ ...base, provider: 'ollama', keyTyped: true }).apiKeyRef, '')
  assert.equal('keyTyped' in payload({ ...base, keyTyped: true }), false)
  // A saved local setup with a key: the name is kept on the next visit.
  const state = { current: { embedder: { provider: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', model: 'bge-m3', apiKeyRef: 'DSH_MEM0_EMBEDDER_API_KEY' }, llm: {} }, refs: { embedder: 'DSH_MEM0_EMBEDDER_API_KEY', llm: 'DSH_MEM0_LLM_API_KEY' } }
  const draft = page.emptyWizardDraft(state)
  assert.equal(draft.embedder.mode, 'local')
  assert.equal(payload(draft.embedder).apiKeyRef, 'DSH_MEM0_EMBEDDER_API_KEY')
})

test('every failure text exists in both languages with the same placeholders', () => {
  const keys = Object.keys(page.en).filter((key) => key.startsWith('wzFail') || ['wzStarters', 'wzStartersMac', 'wzUseSuggested', 'wzProbeRefused', 'wzProbeTimeout', 'wzLocalKeyHint'].includes(key))
  assert.ok(keys.length >= 20)
  const holes = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',')
  for (const key of keys) {
    assert.ok(key in page.zh, key)
    assert.equal(holes(page.zh[key]), holes(page.en[key]), key)
  }
})

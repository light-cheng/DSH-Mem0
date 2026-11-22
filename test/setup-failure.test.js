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
import { failureOf, listModels, omlxSettingsPath, probeLocalServices, readOmlxApiKey, revealOmlxSettings, testEmbedder, testLlm } from '../lib/setup-wizard.js'
import { handleSetupAction, resetReadKeys } from '../lib/setup-routes.js'
import { resolveNativeSettings } from '../lib/oss-config.js'
import { Mem0NativeClient } from '../lib/native-client.js'

const TEST_KEY = 'test-local-key-0123456789'
const DIMS = 6
// The test home's ~/.omlx (isolate-home.mjs sets OMLX_BASE_PATH there).
const FIXTURE_OMLX = path.join('~', '.omlx', 'settings.json')
const OMLX_AUTH_ZH = (status) => `oMLX 开启了 API key 验证（HTTP ${status}）。你可以：① 把 ${FIXTURE_OMLX} 里 auth.api_key 的值填到下面的 API key 栏，或者点「从 oMLX 读取 key」；② 或者停掉 oMLX，把这个文件里的 auth.skip_api_key_verification 改成 true，再重启（只在 oMLX 只监听本机时有效）。`
const ANY_AUTH_ZH = (status) => `服务需要 API key（HTTP ${status}）。请填到下面的 API key 栏。`

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
    assert.equal(omlx.failure.serviceId, 'omlx')
    assert.equal(omlx.failure.keyFile, FIXTURE_OMLX)
    assert.equal(page.failureText(zh, omlx.failure), OMLX_AUTH_ZH(status))
    assert.equal(page.probeLineText(zh, omlx), `oMLX（端口 8000）：${OMLX_AUTH_ZH(status)}`)
    assert.ok(page.failureText(en, omlx.failure).startsWith(`oMLX has API key verification on (HTTP ${status}). Either: (1) put the value of auth.api_key in ${FIXTURE_OMLX} into the API key field below`))
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
  assert.equal(page.wizardError(zh, result), OMLX_AUTH_ZH(401))
  // An address on another port: the general wording.
  const other = await listModels({ provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, platform: 'darwin' })
  assert.equal(page.failureText(zh, other.failure), ANY_AUTH_ZH(401))
  assert.equal(page.failureText(en, other.failure), 'The service needs an API key (HTTP 401). Put it into the API key field below.')
  // Port 8000 off macOS is not oMLX: the general wording, no oMLX file.
  const linux = await listModels({ provider: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', fetchImpl: redirect(8000), platform: 'linux' })
  assert.equal(linux.failure.serviceId, undefined)
  assert.equal(linux.failure.keyFile, undefined)
  assert.equal(page.failureText(zh, linux.failure), ANY_AUTH_ZH(401))
  // LM Studio and Ollama: where their key lives.
  const lm = failureOf({ status: 401, baseUrl: 'http://127.0.0.1:1234/v1', platform: 'win32' })
  assert.equal(page.failureText(zh, lm), 'LM Studio 开启了 Require Authentication（HTTP 401）。你可以：① 在 LM Studio 的 Developer → Server Settings 里新建一个 API token，填到下面的 API key 栏；② 或者在同一处关掉 Require Authentication。')
  assert.equal(page.failureText(zh, { ...lm, keySent: true }), 'LM Studio 拒绝了这个 API token（HTTP 401）。token 只在创建时显示一次：请在 LM Studio 的 Developer → Server Settings 里新建一个，填到下面的 API key 栏。')
  const ollama = failureOf({ status: 403, baseUrl: 'http://127.0.0.1:11434', provider: 'ollama', platform: 'linux' })
  assert.equal(page.failureText(zh, ollama), 'Ollama 本身不需要 API key，这个 HTTP 403 来自它前面的反向代理或其他程序。请把那一层要求的 key 填到下面的 API key 栏，或者直接连 Ollama 自己的端口。')
  assert.match(page.failureText(en, ollama), /^Ollama itself needs no API key/)
})

test('list models with the key: 200 and the models; a wrong key says the key was refused', async () => {
  const result = await listModels({ provider: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', apiKey: TEST_KEY, fetchImpl: redirect(8000), platform: 'darwin' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.models, ['bge-m3-mlx', 'qwen3-8b'])
  assert.deepEqual(result.embeddingModels, ['bge-m3-mlx'])
  assert.equal(seen.at(-1).authorization, `Bearer ${TEST_KEY}`)
  const wrong = await listModels({ provider: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', apiKey: 'wrong-key-000000', fetchImpl: redirect(8000), platform: 'darwin' })
  assert.equal(wrong.failure.keySent, true)
  assert.equal(page.failureText(zh, wrong.failure), `oMLX 拒绝了这个 API key（HTTP 401）。请核对它和 ${FIXTURE_OMLX} 里 auth.api_key 的值是否一致（oMLX 用 --api-key 或 OMLX_API_KEY 启动时，以启动时给的 key 为准）；或者停掉 oMLX，把 auth.skip_api_key_verification 改成 true，再重启。`)
  assert.equal(page.failureText(zh, { ...wrong.failure, serviceId: undefined, service: undefined }), '服务拒绝了这个 API key（HTTP 401）。请核对 key 和凭据名。')
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
  assert.equal(page.wizardError(zh, embed), ANY_AUTH_ZH(401))
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

test('page draft: a local server keeps its credential name only when a key is typed or stored', () => {
  const base = { mode: 'local', provider: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', model: 'bge-m3', dims: '', apiKeyRef: 'DSH_MEM0_EMBEDDER_API_KEY' }
  const payload = (embedder) => page.wizardPayload({ embedder, llm: { maxTokens: 8000 }, storePath: '', useLiteralKey: {} }).embedder
  assert.equal(payload({ ...base, keyTyped: true }).apiKeyRef, 'DSH_MEM0_EMBEDDER_API_KEY')
  assert.equal(payload({ ...base, keyTyped: false }).apiKeyRef, '')
  assert.equal(payload({ ...base, provider: 'ollama', keyTyped: false }).apiKeyRef, '')
  assert.equal('keyTyped' in payload({ ...base, keyTyped: true }), false)
  // A saved local setup with a key: the name is kept on the next visit.
  const state = { current: { embedder: { provider: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', model: 'bge-m3', apiKeyRef: 'DSH_MEM0_EMBEDDER_API_KEY' }, llm: {} }, refs: { embedder: 'DSH_MEM0_EMBEDDER_API_KEY', llm: 'DSH_MEM0_LLM_API_KEY' } }
  const draft = page.emptyWizardDraft(state)
  assert.equal(draft.embedder.mode, 'local')
  assert.equal(payload(draft.embedder).apiKeyRef, 'DSH_MEM0_EMBEDDER_API_KEY')
})

test('every failure text exists in both languages with the same placeholders', () => {
  const keys = Object.keys(page.en).filter((key) => key.startsWith('wzFail') || key.startsWith('wzOmlx') || ['wzStarters', 'wzStartersMac', 'wzUseSuggested', 'wzProbeRefused', 'wzProbeTimeout', 'wzLocalKeyHint'].includes(key))
  assert.ok(keys.length >= 20)
  const holes = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',')
  for (const key of keys) {
    assert.ok(key in page.zh, key)
    assert.equal(holes(page.zh[key]), holes(page.en[key]), key)
  }
})

// ---- reading oMLX's key (only on a click; never to the page, logs or errors) ----


const FAKE_OMLX_KEY = 'omlx-fake-key-9f8e7d6c5b4a'
// How the page shows the test file (displayPath: ~ for the home, the platform's separator).
const SHOWN = path.join('~', 'omlx-base', 'settings.json')

function omlxHome(content) {
  const home = tempDir()
  const base = path.join(home, 'omlx-base')
  fs.mkdirSync(base, { recursive: true })
  if (content !== undefined) fs.writeFileSync(path.join(base, 'settings.json'), content)
  return { home, base, env: { OMLX_BASE_PATH: base } }
}
const noKeyIn = (value, label) => assert.ok(!JSON.stringify(value ?? null).includes(FAKE_OMLX_KEY), `${label}: ${JSON.stringify(value)}`)

test('oMLX settings path: OMLX_BASE_PATH (with ~), the macOS app bootstrap file, else ~/.omlx', () => {
  const home = tempDir()
  const none = () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) }
  assert.deepEqual(omlxSettingsPath({ env: {}, home, platform: 'darwin', readText: none }), { file: path.join(home, '.omlx', 'settings.json'), source: 'default' })
  assert.deepEqual(omlxSettingsPath({ env: { OMLX_BASE_PATH: '~/models/omlx' }, home, platform: 'darwin', readText: none }), { file: path.join(home, 'models', 'omlx', 'settings.json'), source: 'env' })
  const bootstrap = (file) => {
    assert.equal(file, path.join(home, 'Library', 'Application Support', 'oMLX', 'base-path'))
    return '/Volumes/fast/omlx\n'
  }
  assert.deepEqual(omlxSettingsPath({ env: {}, home, platform: 'darwin', readText: bootstrap }), { file: path.join(path.resolve('/Volumes/fast/omlx'), 'settings.json'), source: 'app' })
  assert.equal(omlxSettingsPath({ env: {}, home, platform: 'linux', readText: bootstrap }).source, 'default', 'the app file is macOS only')
})

test('read oMLX key: success, missing file, no field, bad JSON, no permission; the key never in an error', () => {
  const ok = omlxHome(JSON.stringify({ server: { port: 8000 }, auth: { api_key: FAKE_OMLX_KEY, skip_api_key_verification: false } }))
  const read = readOmlxApiKey({ env: ok.env, home: ok.home, platform: 'darwin' })
  assert.equal(read.ok, true)
  assert.equal(read.key, FAKE_OMLX_KEY)
  assert.equal(read.file, SHOWN)
  assert.equal(read.source, 'env')
  assert.deepEqual(Object.keys(read).sort(), ['file', 'key', 'ok', 'source'], 'nothing else of the file is kept')

  const cases = [
    ['missing_file', omlxHome(undefined), undefined],
    ['no_field', omlxHome(JSON.stringify({ auth: { skip_api_key_verification: true } })), undefined],
    ['no_field', omlxHome(JSON.stringify({ auth: { api_key: null } })), undefined],
    // A JSON error message can quote the text around the error: never passed on.
    ['bad_json', omlxHome(`{"auth": {"api_key": "${FAKE_OMLX_KEY}",}}`), undefined],
    ['no_permission', omlxHome('{}'), () => { throw Object.assign(new Error(`EACCES: permission denied, open ${FAKE_OMLX_KEY}`), { code: 'EACCES' }) }],
  ]
  for (const [reason, where, readText] of cases) {
    const result = readOmlxApiKey({ env: where.env, home: where.home, platform: 'darwin', ...(readText ? { readText } : {}) })
    assert.equal(result.ok, false, reason)
    assert.equal(result.reason, reason)
    assert.equal(result.file, SHOWN)
    noKeyIn(result, reason)
    const text = page.omlxActionText(zh, { action: 'read', ...result })
    assert.ok(text.includes(SHOWN) && text.includes('API key 栏'), text)
    noKeyIn(text, `${reason} text`)
  }
  assert.equal(page.omlxActionText(zh, { action: 'read', ok: false, reason: 'missing_file', file: '~/.omlx/settings.json' }), '没有找到 ~/.omlx/settings.json。如果改过 oMLX 的 Base Path（或者设了 OMLX_BASE_PATH），配置文件在别处。请手动把 auth.api_key 的值填到下面的 API key 栏。')
  assert.equal(page.omlxActionText(zh, { action: 'read', ok: false, reason: 'bad_json', file: '~/.omlx/settings.json' }), '~/.omlx/settings.json 不是有效的 JSON，读不出 key。请手动把 auth.api_key 的值填到下面的 API key 栏。')
  assert.equal(page.omlxActionText(zh, { action: 'read', ok: false, reason: 'no_field', file: '~/.omlx/settings.json' }), '~/.omlx/settings.json 里没有 auth.api_key。oMLX 可能是用 --api-key 或 OMLX_API_KEY 启动的，请手动把那个 key 填到下面的 API key 栏。')
  assert.equal(page.omlxActionText(zh, { action: 'read', ok: true, file: '~/.omlx/settings.json' }), '已从 ~/.omlx/settings.json 读取 key（不显示），只在这次设置里使用；保存时存进 DSH 凭据库。')
})

test('routes: the oMLX key is read on a click, used server side, never sent back or logged, and saved to credentials', async (t) => {
  resetReadKeys()
  t.after(resetReadKeys)
  const where = omlxHome(JSON.stringify({ auth: { api_key: TEST_KEY } }))
  const omlx = { env: where.env, home: where.home, platform: 'darwin' }
  const dir = tempDir()
  const { ctx, values, logs } = credentialsCtx()
  const ossConfigPath = path.join(dir, 'oss.json')
  const runtime = { config: { backend: 'platform', ossConfigPath, profileFields: [] } }
  const draft = localDraft(dir, 'http://127.0.0.1:8000/v1')
  const options = { fetchImpl: redirect(8000), omlx }
  const responses = []
  const call = async (body) => {
    const result = await handleSetupAction(ctx, runtime, body, options)
    responses.push(result)
    return result
  }

  // Before the click: 401, and nothing was read.
  const before = await call({ action: 'listModels', component: 'embedder', draft })
  assert.equal(before.failure.reason, 'auth')
  // Not oMLX: refused without reading.
  const other = await call({ action: 'readOmlxKey', component: 'embedder', draft: localDraft(dir, `http://127.0.0.1:${port}/v1`) })
  assert.equal(other.reason, 'not_omlx')
  assert.equal(page.omlxActionText(zh, { action: 'read', ...other }), '只有 oMLX 的地址（本机 8000 端口）才能读取它的 key。')

  const read = await call({ action: 'readOmlxKey', component: 'embedder', draft })
  assert.deepEqual(read, { ok: true, component: 'embedder', file: SHOWN, source: 'env' })
  const readLlm = await call({ action: 'readOmlxKey', component: 'llm', draft })
  assert.equal(readLlm.ok, true)

  // Retried without a typed key: the read key goes along.
  const start = seen.length
  const listed = await call({ action: 'listModels', component: 'embedder', draft })
  assert.equal(listed.ok, true, JSON.stringify(listed))
  const tested = await call({ action: 'testEmbedder', draft })
  assert.equal(tested.ok, true)
  const llm = await call({ action: 'testLlm', draft })
  assert.equal(llm.ok, true)
  assert.ok(seen.slice(start).every((request) => request.authorization === `Bearer ${TEST_KEY}`))
  // Another server never gets it.
  const elsewhere = await call({ action: 'listModels', component: 'embedder', draft: localDraft(dir, `http://127.0.0.1:${port}/v1`) })
  assert.equal(elsewhere.failure.keySent, false)

  // Saved: into DSH credentials only, then forgotten here.
  const saved = await call({ action: 'save', draft })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.equal(values.get('DSH_MEM0_EMBEDDER_API_KEY'), TEST_KEY)
  assert.equal(values.get('DSH_MEM0_LLM_API_KEY'), TEST_KEY)
  assert.ok(!fs.readFileSync(ossConfigPath, 'utf8').includes(TEST_KEY))
  const after = await call({ action: 'listModels', component: 'embedder', draft: { ...draft, embedder: { ...draft.embedder, apiKeyRef: '' } } })
  assert.equal(after.failure.reason, 'auth', 'the read key is dropped after saving')

  for (const [index, response] of responses.entries()) assert.ok(!JSON.stringify(response).includes(TEST_KEY), `response ${index}: ${JSON.stringify(response)}`)
  assert.ok(logs.every((line) => !line.includes(TEST_KEY)), 'no key in the log')
})

test('routes: reading a broken oMLX file says why, and the key is in no response', async () => {
  resetReadKeys()
  const dir = tempDir()
  const { ctx, logs } = credentialsCtx()
  const runtime = { config: { backend: 'platform', ossConfigPath: path.join(dir, 'oss.json'), profileFields: [] } }
  for (const [reason, content] of [['missing_file', undefined], ['no_field', '{"auth":{}}'], ['bad_json', `{"auth":{"api_key":"${FAKE_OMLX_KEY}"`]]) {
    const where = omlxHome(content)
    const result = await handleSetupAction(ctx, runtime, { action: 'readOmlxKey', component: 'embedder', draft: localDraft(dir, 'http://127.0.0.1:8000/v1') }, { omlx: { env: where.env, home: where.home, platform: 'darwin' } })
    assert.equal(result.ok, false)
    assert.equal(result.reason, reason)
    noKeyIn(result, reason)
  }
  assert.ok(logs.every((line) => !line.includes(FAKE_OMLX_KEY)))
  resetReadKeys()
})

test('reveal oMLX settings: open -R on macOS only (never opens the file); elsewhere the path; a missing file says so', async () => {
  const where = omlxHome('{}')
  const revealed = []
  const mac = await revealOmlxSettings({ env: where.env, home: where.home, platform: 'darwin', reveal: async (file) => revealed.push(file) })
  assert.deepEqual(mac, { ok: true, file: SHOWN, revealed: true })
  assert.deepEqual(revealed, [path.join(where.base, 'settings.json')])
  for (const platform of ['win32', 'linux']) {
    const result = await revealOmlxSettings({ env: where.env, home: where.home, platform, reveal: async () => assert.fail('no reveal off macOS') })
    assert.deepEqual(result, { ok: true, file: SHOWN, revealed: false })
    assert.equal(page.omlxActionText(zh, { action: 'reveal', ...result }), `配置文件位置：${SHOWN}`)
  }
  assert.equal(page.omlxActionText(zh, { action: 'reveal', ...mac }), `已在 Finder 中显示 ${SHOWN}。`)
  const gone = omlxHome(undefined)
  const missing = await revealOmlxSettings({ env: gone.env, home: gone.home, platform: 'darwin', reveal: async () => assert.fail('nothing to reveal') })
  assert.equal(missing.reason, 'missing_file')
  assert.equal(page.omlxActionText(zh, { action: 'reveal', ...missing }), `没有找到 ${SHOWN}。`)
})

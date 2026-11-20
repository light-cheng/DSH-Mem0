// The local setup wizard (lib/setup-wizard.js, lib/setup-routes.js) with
// mocked embedder/LLM endpoints (fetchImpl, no network), a mocked DSH
// credential service, and files in a temporary folder.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SELFTEST_USER_ID,
  checkStoreLocation,
  classifyStorePath,
  draftFields,
  isReservedPortError,
  localServiceCandidates,
  probeLocalServices,
  reservedPortHint,
  runSelfTest,
  testEmbedder,
  testLlm,
  writeOssSettings,
} from '../lib/setup-wizard.js'
import { handleSetupAction, jobStatus, setupState } from '../lib/setup-routes.js'
import { describeCredential, storeCredential } from '../lib/credentials.js'
import { resolveNativeSettings } from '../lib/oss-config.js'
import { md5 } from '../lib/native-client.js'
import { SqliteStore } from '../lib/store-sqlite.js'

const DIMS = 6
const vector = (text) => Array.from({ length: DIMS }, (_, index) => ((String(text).charCodeAt(index % String(text).length) || 1) % 17) + index + 1)

// Removed once every test in this file is done: per-test after hooks run in
// the order they were added, so a store closed in a later hook would still
// hold its file open on Windows when the directory is removed.
const tempDirs = []
after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }) })

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-wizard-'))
  tempDirs.push(dir)
  return dir
}

/** OpenAI-compatible embedder + LLM mock. */
function providerFetch({ llmAnswer = '{"memory":[{"text":"Lives in Lisbon"}]}', finish = 'stop', usage = { prompt_tokens: 50, completion_tokens: 20 }, status = 200, seen = [] } = {}) {
  return async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined })
    if (status !== 200) return new Response('{"error":{"message":"nope"}}', { status })
    if (String(url).endsWith('/embeddings')) {
      const body = JSON.parse(init.body)
      return new Response(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vector(text) })) }), { status: 200 })
    }
    if (String(url).endsWith('/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: llmAnswer }, finish_reason: finish }], usage }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
}

function credentialsCtx({ writable = true, initial = {} } = {}) {
  const values = new Map(Object.entries(initial))
  const calls = []
  return {
    values,
    calls,
    ctx: {
      logger: { info() {}, warn() {}, debug() {} },
      get(name) {
        if (name !== 'credentials') return undefined
        return {
          resolve: async (ref) => (values.has(ref) ? { value: values.get(ref), source: 'file' } : undefined),
          describe: async (ref) => ({ configured: values.has(ref), source: values.has(ref) ? 'file' : undefined, writable }),
          set: async (ref, value) => {
            calls.push(ref)
            values.set(ref, value)
          },
        }
      },
    },
  }
}

const DRAFT = (dir, extra = {}) => ({
  embedder: { provider: 'openai', baseUrl: 'https://embed.example.test/v1', model: 'test-embed', apiKeyRef: 'DSH_MEM0_EMBEDDER_API_KEY' },
  llm: { baseUrl: 'https://llm.example.test/v1', model: 'test-llm', apiKeyRef: 'DSH_MEM0_LLM_API_KEY', maxTokens: 8000 },
  storePath: path.join(dir, 'memory.sqlite'),
  ...extra,
})

test('local services per platform: oMLX (8000) only on macOS; Ollama 11434/15434 and LM Studio 1234 everywhere', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const ports = localServiceCandidates(platform).map((item) => item.port)
    assert.deepEqual(ports.filter((port) => port !== 8000), [11434, 15434, 1234], platform)
    assert.equal(ports.includes(8000), platform === 'darwin', platform)
    assert.ok(localServiceCandidates(platform).every((item) => item.baseUrl.startsWith('http://127.0.0.1:')))
  }
})

test('probe lists models, marks embedding models, and gives the 10013 hint on Windows', async () => {
  const fetchImpl = async (url) => {
    if (String(url).startsWith('http://127.0.0.1:11434/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'bge-m3:latest' }, { name: 'qwen3:8b' }] }), { status: 200 })
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
  }
  const results = await probeLocalServices({ platform: 'win32', fetchImpl })
  const ollama = results.find((item) => item.port === 11434)
  assert.equal(ollama.ok, true)
  assert.deepEqual(ollama.embeddingModels, ['bge-m3:latest'])
  const lmstudio = results.find((item) => item.port === 1234)
  assert.equal(lmstudio.error, 'not running')
  assert.equal(lmstudio.hint.command, 'netsh int ipv4 show excludedportrange protocol=tcp')
  const mac = await probeLocalServices({ platform: 'darwin', fetchImpl })
  assert.ok(mac.some((item) => item.port === 8000))
  assert.ok(mac.every((item) => !item.hint), 'no Windows hint elsewhere')
  assert.equal(reservedPortHint('linux'), undefined)
  assert.ok(isReservedPortError(new Error('bind: An attempt was made to access a socket in a way forbidden by its access permissions. (os error 10013)')))
})

test('store location from the path: network and sync drives (path.win32 and path.posix)', () => {
  const win = (file, env = {}) => classifyStorePath(file, { platform: 'win32', env, home: 'C:\\Users\\u' })
  assert.equal(win('\\\\nas\\share\\memory.sqlite').kind, 'network')
  assert.equal(win('\\\\?\\UNC\\nas\\share\\m.sqlite').kind, 'network')
  assert.equal(win('C:\\Users\\u\\.dsh\\mem0\\memory.sqlite').kind, 'local')
  assert.equal(win('\\\\?\\C:\\Users\\u\\m.sqlite').kind, 'local')
  assert.deepEqual(win('C:\\Users\\u\\OneDrive - Contoso\\m.sqlite', { OneDriveCommercial: 'C:\\Users\\u\\OneDrive - Contoso' }).provider, 'OneDrive')
  assert.equal(win('D:\\Dropbox\\m.sqlite').provider, 'Dropbox')
  assert.equal(win('C:\\Users\\u\\iCloudDrive\\m.sqlite').provider, 'iCloud Drive')
  const mac = (file) => classifyStorePath(file, { platform: 'darwin', env: {}, home: '/Users/u' })
  assert.equal(mac('/Users/u/.dsh/mem0/memory.sqlite').kind, 'local')
  assert.equal(mac('/Users/u/Library/Mobile Documents/com~apple~CloudDocs/m.sqlite').provider, 'iCloud Drive')
  assert.equal(mac('/Users/u/Library/CloudStorage/GoogleDrive-a@b.c/My Drive/m.sqlite').kind, 'sync')
  assert.equal(mac('/Volumes/USB/m.sqlite').kind, 'external')
  assert.equal(mac('/Network/Servers/x/m.sqlite').kind, 'network')
  const linux = (file) => classifyStorePath(file, { platform: 'linux', env: {}, home: '/home/u' })
  assert.equal(linux('/home/u/.dsh/mem0/memory.sqlite').kind, 'local')
  assert.equal(linux('/home/u/Dropbox/m.sqlite').kind, 'sync')
  assert.equal(linux('/mnt/data/m.sqlite').kind, 'external')
})

test('store check on this computer: writable, nothing left behind', (t) => {
  const dir = tempDir()
  const file = path.join(dir, 'sub', 'memory.sqlite')
  const result = checkStoreLocation(file)
  assert.equal(result.writable, true)
  assert.equal(result.ok, true)
  assert.equal(result.exists, false)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sub')), [], 'the write test file is removed')
})

test('draft fields: no keys, wizard fields only, dimensions sent only on request', () => {
  const fields = draftFields({ embedder: { provider: 'Ollama', baseUrl: 'http://127.0.0.1:11434/', model: 'bge-m3', dims: 1024, apiKey: 'sk-secret' }, llm: { baseUrl: 'x', model: 'm', maxTokens: '9000', reasoningEffort: 'LOW' } })
  assert.equal(fields.embedderProvider, 'ollama')
  assert.equal(fields.embedderBaseUrl, 'http://127.0.0.1:11434')
  assert.equal(fields.embedderDims, undefined)
  assert.equal(fields.llmMaxTokens, 9000)
  assert.equal(fields.llmReasoningEffort, 'low')
  assert.ok(!JSON.stringify(fields).includes('sk-secret'))
  assert.equal(draftFields({ embedder: { dims: 512, sendDims: true } }).embedderDims, 512)
})

test('embedder test: dimension, a different dimension, refused key', async () => {
  const embedder = { provider: 'openai', baseUrl: 'https://e.test/v1', model: 'm' }
  const ok = await testEmbedder(embedder, { fetchImpl: providerFetch(), expectedDims: 1024 })
  assert.equal(ok.ok, true)
  assert.equal(ok.dims, DIMS)
  assert.deepEqual(ok.dimsDiffer, { expected: 1024, actual: DIMS })
  const refused = await testEmbedder(embedder, { fetchImpl: providerFetch({ status: 401 }), apiKey: 'sk-bad-key-123456' })
  assert.equal(refused.ok, false)
  assert.equal(refused.authFailed, true)
  assert.ok(!refused.error.includes('sk-bad-key-123456'))
})

test('LLM test: facts, and budget advice for cut-off and reasoning answers', async () => {
  const llm = { baseUrl: 'https://l.test/v1', model: 'm', maxTokens: 2000 }
  const ok = await testLlm(llm, { fetchImpl: providerFetch() })
  assert.equal(ok.ok, true)
  assert.equal(ok.facts, 1)
  assert.deepEqual(ok.advice, [])
  const cut = await testLlm(llm, { fetchImpl: providerFetch({ llmAnswer: '{"memory":[{"te', finish: 'length', usage: { completion_tokens: 2000, completion_tokens_details: { reasoning_tokens: 1900 } } }) })
  assert.equal(cut.ok, false)
  assert.equal(cut.reason, 'truncated')
  assert.deepEqual(cut.advice.sort(), ['lower-effort', 'raise-max-tokens'])
  const prose = await testLlm(llm, { fetchImpl: providerFetch({ llmAnswer: 'Sure! Here are the facts.' }) })
  assert.ok(prose.advice.includes('json-mode'))
})

test('self-test writes, finds and deletes one probe of the test user; other memories untouched', async (t) => {
  const dir = tempDir()
  const storePath = path.join(dir, 'memory.sqlite')
  const store = new SqliteStore({ filePath: storePath })
  store.insert([{ id: 'real', text: 'a real memory', hash: md5('a real memory'), vector: vector('a real memory'), payload: { user_id: 'dsh-user' }, embedModel: 'test-embed' }])
  // A leftover of an earlier, interrupted self-test.
  store.insert([{ id: 'left', text: 'old probe', hash: md5('old probe'), vector: vector('old probe'), payload: { user_id: SELFTEST_USER_ID }, embedModel: 'test-embed' }])
  store.setEmbedderInfo({ model: 'test-embed', dims: DIMS })
  store.close()
  const settings = resolveNativeSettings({ embedderBaseUrl: 'https://e.test/v1', embedderModel: 'test-embed', llmBaseUrl: 'https://l.test/v1', llmModel: 'm', storePath }, undefined)
  const result = await runSelfTest({ settings, fetchImpl: providerFetch() })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.steps.map((item) => item.step), ['write', 'search', 'delete', 'leftover'])
  assert.equal(result.steps[3].removed, 1)
  const after = new SqliteStore({ filePath: storePath })
  t.after(() => after.close())
  assert.equal(after.count({ user_id: SELFTEST_USER_ID }), 0)
  assert.equal(after.count({}), 1)
  assert.equal(after.get('real').memory, 'a real memory')
})

test('self-test: a broken embedder fails at "write" and stores nothing', async (t) => {
  const dir = tempDir()
  const settings = resolveNativeSettings({ embedderBaseUrl: 'https://e.test/v1', embedderModel: 'x', llmBaseUrl: 'https://l.test/v1', llmModel: 'm', storePath: path.join(dir, 'm.sqlite') }, undefined)
  const result = await runSelfTest({ settings, fetchImpl: providerFetch({ status: 500 }) })
  assert.equal(result.ok, false)
  assert.equal(result.steps[0].step, 'write')
  const store = new SqliteStore({ filePath: settings.storePath })
  t.after(() => store.close())
  assert.equal(store.count({}), 0)
})

test('oss.json: dsh_mem0 written, oss block kept, backup made, mode 600, no key', (t) => {
  const dir = tempDir()
  const file = path.join(dir, 'oss.json')
  fs.writeFileSync(file, JSON.stringify({ oss: { vector_store: { provider: 'qdrant', config: { url: 'http://127.0.0.1:6333' } } }, dsh_mem0: { userId: 'me', embedderModel: 'old', embedderDims: 99 } }))
  const out = writeOssSettings({ embedderModel: 'new', embedderApiKeyRef: 'GOOD_REF', llmApiKeyRef: 'bad ref!' }, { file, now: new Date('2026-11-20T01:02:03Z') })
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.oss.vector_store.config.url, 'http://127.0.0.1:6333')
  assert.deepEqual(saved.dsh_mem0, { userId: 'me', embedderModel: 'new', embedderApiKeyRef: 'GOOD_REF' })
  assert.ok(out.backup.endsWith('oss.json.bak-20261120T010203Z'))
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak-20261120T010203Z`, 'utf8')).dsh_mem0.embedderModel, 'old')
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')), [])
  fs.writeFileSync(file, '{ broken')
  assert.throws(() => writeOssSettings({ embedderModel: 'x' }, { file }), (error) => error.code === 'CONFIG_INVALID')
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken', 'an unreadable file is not overwritten')
})

test('credentials: stored through the DSH service only; read-only or missing service is reported', async () => {
  const { ctx, values } = credentialsCtx()
  assert.deepEqual(await storeCredential(ctx, 'DSH_MEM0_LLM_API_KEY', ' sk-1 '), { ok: true })
  assert.equal(values.get('DSH_MEM0_LLM_API_KEY'), 'sk-1')
  assert.deepEqual(await describeCredential(ctx, 'DSH_MEM0_LLM_API_KEY'), { configured: true, source: 'file', writable: true })
  assert.equal((await storeCredential(ctx, 'bad ref', 'x')).reason, 'invalid-ref')
  assert.equal((await storeCredential(ctx, 'OK', '  ')).reason, 'empty')
  assert.equal((await storeCredential(credentialsCtx({ writable: false }).ctx, 'OK', 'x')).reason, 'read-only')
  assert.equal((await storeCredential({ get: () => undefined }, 'OK', 'x')).reason, 'no-service')
})

test('save: self-test first, keys into DSH credentials, refs only in oss.json', async (t) => {
  const dir = tempDir()
  const ossConfigPath = path.join(dir, 'oss.json')
  const { ctx, values } = credentialsCtx()
  const seen = []
  const runtime = { config: { backend: 'platform', ossConfigPath, userId: 'dsh-user', collectionName: 'dsh_mem0', profileFields: [] } }
  const result = await handleSetupAction(ctx, runtime, { action: 'save', draft: DRAFT(dir), keys: { embedder: 'sk-embed-secret-1', llm: 'sk-llm-secret-2' } }, { fetchImpl: providerFetch({ seen }) })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.restarting, false)
  assert.deepEqual(result.storedCredentials.sort(), ['DSH_MEM0_EMBEDDER_API_KEY', 'DSH_MEM0_LLM_API_KEY'])
  assert.equal(values.get('DSH_MEM0_EMBEDDER_API_KEY'), 'sk-embed-secret-1')
  const text = fs.readFileSync(ossConfigPath, 'utf8')
  assert.ok(!text.includes('sk-embed-secret-1') && !text.includes('sk-llm-secret-2'), 'no key in oss.json')
  assert.equal(JSON.parse(text).dsh_mem0.llmApiKeyRef, 'DSH_MEM0_LLM_API_KEY')
  assert.ok(!JSON.stringify(result).includes('sk-embed-secret-1'), 'no key in the answer')
  assert.ok(seen.some((call) => call.headers.authorization === 'Bearer sk-embed-secret-1'), 'the typed key was used for the self-test')
  const store = new SqliteStore({ filePath: path.join(dir, 'memory.sqlite') })
  t.after(() => store.close())
  assert.equal(store.count({}), 0, 'the self-test left nothing')
})

test('save: a failing self-test writes nothing and stores no key', async (t) => {
  const dir = tempDir()
  const ossConfigPath = path.join(dir, 'oss.json')
  fs.writeFileSync(ossConfigPath, '{"dsh_mem0":{"userId":"me"}}')
  const { ctx, calls } = credentialsCtx()
  const runtime = { config: { backend: 'oss', ossConfigPath, userId: 'dsh-user', profileFields: [] } }
  let restarted = false
  const result = await handleSetupAction(ctx, runtime, { action: 'save', draft: DRAFT(dir), keys: { embedder: 'sk-x' } }, { fetchImpl: providerFetch({ status: 401 }), restart: () => { restarted = true } })
  assert.equal(result.ok, false)
  assert.equal(result.steps[0].step, 'write')
  assert.deepEqual(calls, [])
  assert.equal(fs.readFileSync(ossConfigPath, 'utf8'), '{"dsh_mem0":{"userId":"me"}}')
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.bak-')), [])
  assert.equal(restarted, false)
})

test('save on a sync folder is refused before anything runs', async (t) => {
  const dir = tempDir()
  const { ctx } = credentialsCtx()
  const runtime = { config: { backend: 'oss', ossConfigPath: path.join(dir, 'oss.json'), profileFields: [] } }
  const result = await handleSetupAction(ctx, runtime, { action: 'save', draft: DRAFT(dir, { storePath: path.join(dir, 'Dropbox', 'm.sqlite') }) }, { fetchImpl: providerFetch() })
  assert.equal(result.ok, false)
  assert.equal(result.step, 'store')
  assert.equal(result.location.kind, 'sync')
  assert.equal(fs.existsSync(path.join(dir, 'oss.json')), false)
})

test('wizard state: no keys, credential status, legacy Qdrant detected', async (t) => {
  const dir = tempDir()
  const ossConfigPath = path.join(dir, 'oss.json')
  fs.writeFileSync(ossConfigPath, JSON.stringify({ oss: { vector_store: { provider: 'qdrant', config: { url: 'http://127.0.0.1:15333', collection_name: 'dsh_mem0' } }, embedder: { provider: 'openai', config: { model: 'bge-m3', api_key: 'sk-literal-key-999' } } } }))
  const { ctx } = credentialsCtx({ initial: { DSH_MEM0_LLM_API_KEY: 'sk-stored' } })
  const native = resolveNativeSettings({}, JSON.parse(fs.readFileSync(ossConfigPath, 'utf8')))
  const runtime = { config: { backend: 'oss', ossConfigPath, userId: 'dsh-user', collectionName: 'dsh_mem0', profileFields: ['embedderModel', 'userId'], native: { ...native, embedder: { ...native.embedder, apiKey: undefined, literalKey: true }, llm: { ...native.llm, apiKey: undefined } }, storePath: path.join(dir, 'memory.sqlite') } }
  const state = await setupState(ctx, runtime)
  assert.equal(state.legacy.detected, true)
  assert.equal(state.legacy.endpoint, '127.0.0.1:15333')
  assert.equal(state.legacy.oldModel, 'bge-m3')
  assert.equal(state.credentials.llm.configured, true)
  assert.equal(state.credentials.embedder.configured, false)
  assert.deepEqual(state.shadowed, ['embedderModel'])
  assert.ok(!JSON.stringify(state).includes('sk-literal-key-999'))
  assert.ok(!JSON.stringify(state).includes('sk-stored'))
  assert.ok(!/hermes|python/i.test(JSON.stringify(state)))
})

test('migration actions need the local backend; reembed runs as a job', async (t) => {
  const dir = tempDir()
  const { ctx } = credentialsCtx()
  const off = await handleSetupAction(ctx, { config: { backend: 'platform' } }, { action: 'migrate' })
  assert.equal(off.ok, false)
  assert.equal(off.step, 'preflight')
  const storePath = path.join(dir, 'memory.sqlite')
  const store = new SqliteStore({ filePath: storePath })
  store.insert([{ id: 'a', text: 'one', hash: md5('one'), vector: [1, 0], payload: { user_id: 'u' }, embedModel: 'old' }])
  store.setEmbedderInfo({ model: 'old', dims: 2 })
  store.close()
  const runtime = { config: { backend: 'oss', ossConfigPath: path.join(dir, 'oss.json'), profileFields: [] } }
  const draft = DRAFT(dir)
  const tested = await handleSetupAction(ctx, runtime, { action: 'testEmbedder', draft }, { fetchImpl: providerFetch() })
  assert.deepEqual(tested.storeMismatch, { model: 'old', dims: 2, memories: 1 })
  const started = await handleSetupAction(ctx, runtime, { action: 'reembed', draft }, { fetchImpl: providerFetch() })
  assert.equal(started.ok, true)
  let job
  for (let i = 0; i < 100; i += 1) {
    job = jobStatus(started.job.id)
    if (job.state !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(job.state, 'done', JSON.stringify(job))
  assert.equal(job.result.updated, 1)
  const after = new SqliteStore({ filePath: storePath })
  t.after(() => after.close())
  assert.deepEqual(after.embedderInfo(), { model: 'test-embed', dims: DIMS })
})

test('reembed writes nothing when the memories change meanwhile (one transaction with the meta)', (t) => {
  const dir = tempDir()
  const store = new SqliteStore({ filePath: path.join(dir, 'm.sqlite') })
  t.after(() => store.close())
  store.insert([{ id: 'a', text: 'one', hash: md5('one'), vector: [1, 0], payload: {}, embedModel: 'old' }])
  store.setEmbedderInfo({ model: 'old', dims: 2 })
  const rows = store.allTexts()
  store.insert([{ id: 'b', text: 'two', hash: md5('two'), vector: [0, 1], payload: {}, embedModel: 'old' }])
  assert.equal(store.replaceVectors([{ id: 'a', vector: new Float32Array([1, 2, 3]) }], { model: 'new', dims: 3, expected: rows }), false)
  assert.deepEqual(store.embedderInfo(), { model: 'old', dims: 2 })
  assert.equal(store.replaceVectors([{ id: 'a', vector: new Float32Array([1, 2, 3]) }, { id: 'b', vector: new Float32Array([3, 2, 1]) }], { model: 'new', dims: 3, expected: store.allTexts() }), true)
  assert.deepEqual(store.embedderInfo(), { model: 'new', dims: 3 })
  // An edit in the meantime (same ids, new text) also starts over.
  const before = store.allTexts()
  store.update('a', { text: 'one, edited', hash: md5('one, edited'), vector: [1, 2, 3], embedModel: 'new' })
  assert.equal(store.replaceVectors([{ id: 'a', vector: new Float32Array([9, 9, 9]) }], { model: 'new', dims: 3, expected: before }), false)
})

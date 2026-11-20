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
  macMountType,
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
import { setupPostRefusal } from '../lib/gui-routes.js'
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
  assert.equal(lmstudio.hint, undefined, 'refused alone: the page sums it up once')
  const reserved = await probeLocalServices({ platform: 'win32', fetchImpl: async () => { throw new TypeError('fetch failed', { cause: new Error('connect EACCES (os error 10013)') }) } })
  assert.ok(reserved.every((item) => item.hint?.command === 'netsh int ipv4 show excludedportrange protocol=tcp'))
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

test('store check: SMB shares under /Volumes and mapped Windows drives are network drives', () => {
  const dir = tempDir()
  const mounts = `/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n//me@nas._smb._tcp.local/share on /Volumes/share (smbfs, nodev, nosuid, mounted by me)\n/dev/disk5s1 on /Volumes/USB (exfat, local, nodev, nosuid, noowners)`
  assert.deepEqual(macMountType('/Volumes/share/mem0', mounts), { point: '/Volumes/share', type: 'smbfs' })
  assert.deepEqual(macMountType('/Volumes/USB', mounts), { point: '/Volumes/USB', type: 'exfat' })
  assert.equal(macMountType('/Users/me', mounts).type, 'apfs')
  // On the real file system the folder is a temp dir; the mount table decides.
  const smb = checkStoreLocation(path.join(dir, 'm.sqlite'), { platform: 'darwin', mountTable: () => mounts.replace('/Volumes/share', dir) })
  assert.equal(smb.kind, 'local', 'only /Volumes paths ask the mount table')
  const fake = (point, type) => () => `x on / (apfs, local)\nnas on ${point} (${type}, nodev)`
  const classify = (type) => {
    const volume = '/Volumes/Data'
    const out = checkStoreLocation(`${volume}/mem0/m.sqlite`, { platform: 'darwin', mountTable: fake(volume, type) })
    return out
  }
  if (process.platform === 'darwin') {
    assert.equal(classify('smbfs').kind, 'network')
    assert.equal(classify('smbfs').ok, false)
    assert.equal(classify('weirdfs').kind, 'unverified')
    assert.equal(classify('weirdfs').needsConfirm, true)
  }
  const unc = checkStoreLocation(path.join(dir, 'z', 'm.sqlite'), { platform: 'win32', realpath: () => '\\\\fileserver\\share\\mem0' })
  assert.equal(unc.kind, 'network')
  assert.equal(unc.ok, false)
  const local = checkStoreLocation(path.join(dir, 'c', 'm.sqlite'), { platform: 'win32', realpath: () => 'C:\\Users\\u\\.dsh' })
  assert.equal(local.kind, 'local')
})

test('setup POST: JSON from the same origin only', () => {
  const ok = { headers: { host: '127.0.0.1:4096', 'content-type': 'application/json; charset=utf-8', origin: 'http://127.0.0.1:4096', 'sec-fetch-site': 'same-origin' } }
  assert.equal(setupPostRefusal(ok), null)
  assert.equal(setupPostRefusal({ headers: { host: '127.0.0.1:4096', 'content-type': 'application/json' } }), null)
  assert.equal(setupPostRefusal({ headers: { ...ok.headers, 'content-type': 'text/plain' } }).status, 415)
  assert.equal(setupPostRefusal({ headers: { ...ok.headers, origin: 'https://evil.example' } }).status, 403)
  assert.equal(setupPostRefusal({ headers: { ...ok.headers, 'sec-fetch-site': 'cross-site' } }).status, 403)
  assert.equal(setupPostRefusal({ headers: { ...ok.headers, origin: 'http://127.0.0.1:5000', 'sec-fetch-site': 'same-site' } }).status, 403)
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
  assert.equal(result.step, 'embedder')
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
  const runtime = { config: { backend: 'oss', ossConfigPath, userId: 'dsh-user', collectionName: 'dsh_mem0', profileFields: ['embedderModel', 'userId'], native, storePath: path.join(dir, 'memory.sqlite') } }
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

async function waitJob(id) {
  let job
  for (let i = 0; i < 300; i += 1) {
    job = jobStatus(id)
    if (job.state !== 'running') return job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return job
}

test('a store of another embedder: the self-test runs in a temporary store, vectors are recomputed on save', async (t) => {
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
  const ossConfigPath = path.join(dir, 'oss.json')
  const runtime = { config: { backend: 'oss', ossConfigPath, profileFields: [] } }
  const draft = DRAFT(dir)
  const tested = await handleSetupAction(ctx, runtime, { action: 'testEmbedder', draft }, { fetchImpl: providerFetch() })
  assert.deepEqual(tested.storeMismatch, { model: 'old', dims: 2, memories: 1 })
  assert.equal((await handleSetupAction(ctx, runtime, { action: 'reembed', draft })).ok, false, 'no re-embedding outside save')
  const checked = await handleSetupAction(ctx, runtime, { action: 'selfTest', draft, keys: { embedder: 'sk', llm: 'sk' } }, { fetchImpl: providerFetch() })
  assert.equal(checked.ok, true, JSON.stringify(checked))
  assert.equal(checked.scratchStore, true)
  assert.equal(checked.reembed, 1)
  const untouched = new SqliteStore({ filePath: storePath })
  assert.deepEqual(untouched.embedderInfo(), { model: 'old', dims: 2 }, 'the self-test leaves the store alone')
  untouched.close()
  assert.equal(fs.existsSync(ossConfigPath), false)
  let restarted = 0
  const saved = await handleSetupAction(ctx, runtime, { action: 'save', draft, keys: { embedder: 'sk', llm: 'sk' } }, { fetchImpl: providerFetch(), restart: () => { restarted += 1 } })
  assert.equal(saved.ok, true)
  assert.equal(saved.reembed, 1)
  const job = await waitJob(saved.job.id)
  assert.equal(job.state, 'done', JSON.stringify(job))
  assert.equal(job.result.reembedded, 1)
  assert.ok(fs.existsSync(ossConfigPath), 'oss.json written after the vectors')
  const after = new SqliteStore({ filePath: storePath })
  t.after(() => after.close())
  assert.deepEqual(after.embedderInfo(), { model: 'test-embed', dims: DIMS })
  assert.equal(after.count({}), 1)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(restarted, 1)
})

test('a stored key goes only to the server it was saved for (no Authorization after a change)', async () => {
  const dir = tempDir()
  const { ctx } = credentialsCtx({ initial: { DSH_MEM0_EMBEDDER_API_KEY: 'sk-openai', DSH_MEM0_LLM_API_KEY: 'sk-llm' } })
  const saved = resolveNativeSettings({ embedderProvider: 'openai', embedderBaseUrl: 'https://api.openai.com/v1', embedderModel: 'text-embedding-3-small', embedderApiKeyRef: 'DSH_MEM0_EMBEDDER_API_KEY', llmBaseUrl: 'https://llm.example.test/v1', llmModel: 'm', llmApiKeyRef: 'DSH_MEM0_LLM_API_KEY' })
  const runtime = { config: { backend: 'oss', ossConfigPath: path.join(dir, 'oss.json'), profileFields: [], native: saved } }
  const sameServer = []
  await handleSetupAction(ctx, runtime, { action: 'testEmbedder', draft: { embedder: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-large', apiKeyRef: 'DSH_MEM0_EMBEDDER_API_KEY' } } }, { fetchImpl: providerFetch({ seen: sameServer }) })
  assert.equal(sameServer[0].headers.authorization, 'Bearer sk-openai')
  for (const action of ['testEmbedder', 'listModels']) {
    const seen = []
    await handleSetupAction(ctx, runtime, { action, draft: { embedder: { provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3', apiKeyRef: 'DSH_MEM0_EMBEDDER_API_KEY' } } }, { fetchImpl: providerFetch({ seen }) })
    assert.ok(seen.length > 0)
    assert.ok(seen.every((request) => !request.headers.authorization && !request.headers.Authorization), `${action}: ${JSON.stringify(seen[0].headers)}`)
  }
  const llmSeen = []
  await handleSetupAction(ctx, runtime, { action: 'testLlm', draft: { llm: { baseUrl: 'https://elsewhere.test/v1', model: 'm', apiKeyRef: 'DSH_MEM0_LLM_API_KEY' } } }, { fetchImpl: providerFetch({ seen: llmSeen }) })
  assert.ok(llmSeen.every((request) => !request.headers.authorization))
})

test('credential names: only the wizard defaults or the one in use; another existing key needs a confirmation', async () => {
  const dir = tempDir()
  const { ctx, calls } = credentialsCtx({ initial: { DEEPSEEK_API_KEY: 'sk-dsh', MY_EMBED: 'sk-old' } })
  const runtime = { config: { backend: 'platform', ossConfigPath: path.join(dir, 'oss.json'), profileFields: [], native: resolveNativeSettings({ embedderBaseUrl: 'https://embed.example.test/v1', embedderModel: 'test-embed', embedderApiKeyRef: 'MY_EMBED' }) } }
  const refused = await handleSetupAction(ctx, runtime, { action: 'testEmbedder', draft: { embedder: { provider: 'openai', baseUrl: 'https://x.test/v1', model: 'm', apiKeyRef: 'DEEPSEEK_API_KEY' } } }, { fetchImpl: providerFetch() })
  assert.equal(refused.code, 'REF_NOT_ALLOWED')
  const draft = DRAFT(dir, { embedder: { ...DRAFT(dir).embedder, apiKeyRef: 'MY_EMBED' } })
  const asked = await handleSetupAction(ctx, runtime, { action: 'save', draft, keys: { embedder: 'sk-new', llm: 'sk-llm' } }, { fetchImpl: providerFetch() })
  assert.equal(asked.code, 'REF_EXISTS')
  assert.equal(asked.ref, 'MY_EMBED')
  assert.deepEqual(calls, [])
  const done = await handleSetupAction(ctx, runtime, { action: 'save', draft, keys: { embedder: 'sk-new', llm: 'sk-llm' }, overwriteRefs: ['MY_EMBED'] }, { fetchImpl: providerFetch() })
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.deepEqual(calls.sort(), ['DSH_MEM0_LLM_API_KEY', 'MY_EMBED'])
})

test('save moves a literal key: stored in DSH credentials, removed from the oss block, the backup flagged', async () => {
  const dir = tempDir()
  const ossConfigPath = path.join(dir, 'oss.json')
  fs.writeFileSync(ossConfigPath, JSON.stringify({ oss: { vector_store: { provider: 'qdrant', config: { url: 'http://127.0.0.1:6333' } }, embedder: { provider: 'openai', config: { model: 'test-embed', api_key: 'sk-literal', openai_base_url: 'https://embed.example.test/v1' } } } }))
  const { ctx, values } = credentialsCtx()
  const runtime = { config: { backend: 'platform', ossConfigPath, profileFields: [] } }
  const result = await handleSetupAction(ctx, runtime, { action: 'save', draft: { ...DRAFT(dir), useLiteralKey: { embedder: true } }, keys: { llm: 'sk-llm' } }, { fetchImpl: providerFetch() })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(values.get('DSH_MEM0_EMBEDDER_API_KEY'), 'sk-literal')
  const written = JSON.parse(fs.readFileSync(ossConfigPath, 'utf8'))
  assert.equal(written.oss.embedder.config.api_key, undefined)
  assert.equal(written.oss.embedder.config.model, 'test-embed')
  assert.deepEqual(written.oss.vector_store, { provider: 'qdrant', config: { url: 'http://127.0.0.1:6333' } })
  assert.deepEqual(result.written.droppedLiteralKeys, ['embedder'])
  assert.equal(result.written.backupHasKeys, true)
})

test('migration route: allowed collections only, a second run needs a confirmation, running jobs listed', async (t) => {
  const dir = tempDir()
  const ossConfigPath = path.join(dir, 'oss.json')
  fs.writeFileSync(ossConfigPath, JSON.stringify({ oss: { vector_store: { provider: 'qdrant', config: { url: 'http://127.0.0.1:6333', collection_name: 'dsh_mem0', api_key: 'qd-key' } } } }))
  const storePath = path.join(dir, 'memory.sqlite')
  const store = new SqliteStore({ filePath: storePath })
  store.insert([{ id: 'a', text: 'one', hash: md5('one'), vector: vector('one'), payload: { user_id: 'u' }, embedModel: 'test-embed' }])
  store.setEmbedderInfo({ model: 'test-embed', dims: DIMS })
  store.setMeta('qdrant_migration', JSON.stringify({ at: '2026-11-01T00:00:00.000Z', imported: 1 }))
  store.close()
  const settings = { storePath, embedder: { provider: 'openai', baseUrl: 'https://embed.example.test/v1', model: 'test-embed', apiKey: 'sk' } }
  const runtime = { config: { backend: 'oss', ossConfigPath, userId: 'u', collectionName: 'dsh_mem0', profileFields: [] }, client: { settings: () => settings } }
  const seen = []
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers ?? {} })
    if (String(url).endsWith('/embeddings')) return providerFetch()(url, init)
    return new Response(JSON.stringify({ result: { count: 0, config: { params: { vectors: { size: DIMS, distance: 'Cosine' } } } }, status: 'ok' }), { status: 200 })
  }
  const other = await handleSetupAction({ logger: {} }, runtime, { action: 'migratePreflight', collection: 'mem0migrations' }, { fetchImpl })
  assert.equal(other.code, 'FORBIDDEN_COLLECTION')
  const foreign = await handleSetupAction({ logger: {} }, runtime, { action: 'migratePreflight', collection: 'someone_else' }, { fetchImpl })
  assert.equal(foreign.code, 'COLLECTION_NOT_ALLOWED')
  assert.equal(seen.length, 0, 'nothing contacted for a refused collection')
  const pre = await handleSetupAction({ logger: {} }, runtime, { action: 'migratePreflight' }, { fetchImpl })
  assert.equal(pre.ok, true, JSON.stringify(pre))
  assert.equal(pre.alreadyMigrated.imported, 1)
  assert.equal(seen.find((request) => request.url.includes(':6333')).headers['api-key'], 'qd-key')
  seen.length = 0
  await handleSetupAction({ logger: {} }, runtime, { action: 'migratePreflight', url: 'http://10.0.0.9:6333' }, { fetchImpl })
  assert.ok(seen.filter((request) => request.url.includes('10.0.0.9')).every((request) => !request.headers['api-key']), 'the Qdrant key stays with its own server')
  const again = await handleSetupAction({ logger: {} }, runtime, { action: 'migrate' }, { fetchImpl })
  assert.equal(again.code, 'ALREADY_MIGRATED')
  const state = await setupState({ get: () => undefined }, runtime)
  assert.deepEqual(state.jobs, [])
  assert.deepEqual(state.legacy.collections, ['dsh_mem0'])
})

test('wizard state: a local backend chosen before counts as a possible earlier Qdrant setup', async () => {
  const dir = tempDir()
  const ossConfigPath = path.join(dir, 'oss.json')
  const state = await setupState({ get: () => undefined }, { config: { backend: 'oss', backendSource: 'configured', ossConfigPath, collectionName: 'dsh_mem0', profileFields: ['backend'], ignoredSettings: [] } })
  assert.equal(state.legacy.detected, false)
  assert.equal(state.legacy.possible, true)
  assert.equal(state.legacy.reason, 'local-backend')
  assert.match(state.legacy.endpoint, /^127\.0\.0\.1:(6333|15333)$/)
  const fresh = await setupState({ get: () => undefined }, { config: { backend: 'platform', backendSource: 'auto-default', ossConfigPath, profileFields: [], ignoredSettings: [] } })
  assert.equal(fresh.legacy.possible, false)
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

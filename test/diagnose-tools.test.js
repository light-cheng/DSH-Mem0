// mem0_check and mem0_setting_set (lib/diagnose-tools.js): redaction, the
// allow-list, no key or credential change, diagnosis sessions only, and the
// check after a change. Model servers are mocked (fetchImpl, no network),
// DSH's credential and settings services are fakes, files live in a
// temporary folder.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import {
  applySetting,
  CHECK_TARGETS,
  createDiagnoseTools,
  currentDraft,
  diagnoseToolOptions,
  failureLines,
  runCheck,
  scrubResult,
  scrubText,
  SETTING_FIELDS,
  SETTING_NAMES,
  settingConfirmText,
  validateSetting,
} from '../lib/diagnose-tools.js'
import { createDiagnoseGate, DiagnoseSessions } from '../lib/diagnose-sessions.js'
import { resolveNativeSettings } from '../lib/oss-config.js'

const KEY = 'sk-stored-embed-key-0123456789'
const DIMS = 6
const vector = (text) => Array.from({ length: DIMS }, (_, index) => ((String(text).charCodeAt(index % String(text).length) || 1) % 17) + index + 1)

const tempDirs = []
after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }) })
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-diagtools-'))
  tempDirs.push(dir)
  return dir
}

/** An OpenAI-compatible embedder that knows one model, `test-embed`, at embed.example.test only. */
function embedFetch(seen = []) {
  return async (url, init = {}) => {
    const target = new URL(String(url))
    seen.push({ host: target.host, path: target.pathname, auth: init.headers?.authorization ?? init.headers?.Authorization })
    if (target.host !== 'embed.example.test') throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) })
    if ((init.headers?.authorization ?? '') !== `Bearer ${KEY}`) return new Response('{"error":{"message":"bad key"}}', { status: 401 })
    if (target.pathname.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'test-embed' }, { id: 'other-embed' }] }), { status: 200 })
    if (target.pathname.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"memory":[{"text":"probe"}]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } }), { status: 200 })
    }
    if (target.pathname.endsWith('/embeddings')) {
      const body = JSON.parse(init.body)
      if (body.model !== 'test-embed') return new Response(JSON.stringify({ error: { message: `model ${body.model} not found` } }), { status: 404 })
      return new Response(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vector(text) })) }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
}

function credentialsCtx(extra = {}) {
  const values = new Map([['DSH_MEM0_EMBEDDER_API_KEY', KEY], ['DSH_MEM0_LLM_API_KEY', KEY]])
  const writes = []
  return {
    writes,
    ctx: {
      logger: { info() {}, warn() {}, debug() {} },
      get(name) {
        if (name === 'credentials') {
          return {
            resolve: async (ref) => (values.has(ref) ? { value: values.get(ref), source: 'file' } : undefined),
            describe: async (ref) => ({ configured: values.has(ref), source: values.has(ref) ? 'file' : undefined, writable: true }),
            set: async (ref, value) => {
              writes.push(ref)
              values.set(ref, value)
            },
          }
        }
        return extra[name]
      },
    },
  }
}

/** A local-backend runtime reading `oss.json` in `dir`, as apply() builds it. */
function localRuntime(dir, block) {
  const ossConfigPath = path.join(dir, 'oss.json')
  if (block) fs.writeFileSync(ossConfigPath, JSON.stringify({ dsh_mem0: block }))
  const raw = JSON.parse(fs.readFileSync(ossConfigPath, 'utf8'))
  const native = resolveNativeSettings(raw.dsh_mem0, raw)
  return {
    config: { backend: 'oss', enabled: true, ossConfigPath, userId: 'dsh-diag-test', profileFields: [], native, storePath: native.storePath, autoRecall: true, autoCapture: true, recallTopK: 5, memoryBudgetTokens: 2200, timeoutMs: 30000, recallTimeoutMs: 5000, addTimeoutMs: 120000 },
    failures: { list: () => [] },
  }
}

const BLOCK = (dir, model = 'wrong-embed', llm = { llmBaseUrl: 'https://embed.example.test/v1', llmModel: 'test-llm', llmApiKeyRef: 'DSH_MEM0_LLM_API_KEY' }) => ({
  embedderProvider: 'openai',
  embedderBaseUrl: 'https://embed.example.test/v1',
  embedderModel: model,
  embedderApiKeyRef: 'DSH_MEM0_EMBEDDER_API_KEY',
  ...llm,
  storePath: path.join(dir, 'memory.sqlite'),
})

// ---- redaction --------------------------------------------------------------

test('redaction: URLs become host:port, keys and memory text never pass, home paths shortened', () => {
  const text = scrubText(`POST https://user:pw@api.example.test:8443/v1/embeddings?key=${KEY} failed at ${os.homedir()}/x`)
  assert.equal(text.includes(KEY), false)
  assert.equal(text.includes('/v1/embeddings'), false)
  assert.match(text, /api\.example\.test:8443/)
  assert.equal(text.includes(os.homedir()), false)
  const result = scrubResult({ ok: false, apiKey: KEY, keyTyped: true, text: 'Lives in Lisbon', memories: [{ memory: 'secret fact' }], memoryCount: 3, baseUrl: 'http://127.0.0.1:11434/v1/x', failure: { reason: 'auth', detail: `Bearer ${KEY}` }, models: Array.from({ length: 20 }, (_, i) => `m${i}`) })
  const json = JSON.stringify(result)
  assert.equal(json.includes(KEY), false)
  assert.equal(json.includes('Lisbon'), false)
  assert.equal(json.includes('secret fact'), false)
  assert.equal(result.memoryCount, 3, 'counts are kept')
  assert.equal(result.baseUrl, '127.0.0.1:11434')
  assert.equal(result.models.length, 13, 'lists are capped')
})

test('failures: open ones only, as allowed facts with host:port endpoints and redacted messages', () => {
  const lines = failureLines([
    { cause: 'connection', component: 'embedder', endpoint: 'http://127.0.0.1:11434/api/embed', message: `connect refused api_key=${KEY}`, at: '2026-11-27T10:00:00Z', count: 2 },
    { cause: 'timeout', recovered: true, at: '2026-11-27T09:00:00Z' },
  ])
  assert.equal(lines[0], 'open failures: 1')
  assert.match(lines[1], /type=connection component=embedder endpoint=127\.0\.0\.1:11434 .*count=2/)
  assert.equal(lines.join('\n').includes(KEY), false)
  assert.equal(lines.join('\n').includes('/api/embed'), false)
  assert.deepEqual(failureLines([]), ['open failures: none'])
})

// ---- the allow-list ---------------------------------------------------------

test('allow-list: no key, credential, backend, store or identity field; values are validated', () => {
  for (const field of ['apiKey', 'apiKeyEnv', 'embedderApiKeyRef', 'llmApiKeyRef', 'backend', 'storePath', 'userId', 'agentId', 'collectionName', 'enabled', 'authType', 'embedderProvider', 'llmProvider']) {
    assert.equal(SETTING_NAMES.includes(field), false, field)
    assert.match(validateSetting(field, 'x').error, /is not a setting mem0_setting_set may change/, field)
  }
  assert.ok(SETTING_NAMES.every((name) => !/api_?key|keyref|secret|credential|password/i.test(name)))
  assert.equal(validateSetting('autoRecall', 'false').value, false)
  assert.match(validateSetting('autoRecall', 'maybe').error, /true or false/)
  assert.equal(validateSetting('recallTimeoutMs', '8000').value, 8000)
  assert.match(validateSetting('recallTimeoutMs', 50).error, /recallTimeoutMs/, 'the profile schema range applies')
  assert.match(validateSetting('embedderBaseUrl', 'http://user:pw@host:1/v1').error, /user name or password/)
  assert.match(validateSetting('embedderBaseUrl', 'file:///etc/passwd').error, /http\(s\) address/)
  assert.equal(validateSetting('embedderBaseUrl', 'http://127.0.0.1:11434/v1/').value, 'http://127.0.0.1:11434/v1')
  assert.match(validateSetting('embedderModel', 'a b; rm -rf').error, /model name/)
  assert.equal(validateSetting('embedderKeepAlive', '2h').value, '2h')
  assert.equal(validateSetting('captureFilter', 'OFF').value, 'off')
  for (const spec of Object.values(SETTING_FIELDS)) assert.ok(['profile', 'wizard'].includes(spec.via))
})

// ---- mem0_check -------------------------------------------------------------

test('mem0_check on the local backend: a wrong model name is found, the model list names the right one, the key never shows', async () => {
  const dir = tempDir()
  const runtime = localRuntime(dir, BLOCK(dir))
  const { ctx, writes } = credentialsCtx()
  const seen = []
  const embedder = await runCheck(ctx, runtime, { target: 'embedder' }, { fetchImpl: embedFetch(seen) })
  assert.match(embedder, /^mem0_check embedder: /)
  assert.match(embedder, /"ok":false/)
  assert.match(embedder, /wrong-embed/)
  assert.match(embedder, /embed\.example\.test/)
  const models = await runCheck(ctx, runtime, { target: 'models', component: 'embedder' }, { fetchImpl: embedFetch(seen) })
  assert.match(models, /"configured":"wrong-embed","configuredListed":false/)
  assert.match(models, /"models":\["test-embed","other-embed"\]/)
  for (const text of [embedder, models]) {
    assert.equal(text.includes(KEY), false)
    assert.equal(text.includes('/v1'), false, 'host:port only')
  }
  assert.ok(seen.every((call) => call.auth === `Bearer ${KEY}`), 'the stored key was used inside the plugin')
  assert.deepEqual(writes, [], 'a check stores nothing')
  // The llm target names the LLM's server and model, not the embedder's.
  const llm = await runCheck(ctx, runtime, { target: 'llm' }, { fetchImpl: embedFetch() })
  assert.match(llm, /^mem0_check llm: \{"component":"llm","at":"embed\.example\.test","model":"test-llm"/)
  const status = await runCheck(ctx, runtime, { target: 'status' })
  assert.match(status, /backend: oss/)
  assert.match(status, /embedder: openai wrong-embed at embed\.example\.test/)
  assert.equal(status.includes(KEY), false)
})

test('mem0_check: unknown targets fall back to status; local-only targets say so on a cloud backend', async () => {
  const runtime = { config: { backend: 'platform', baseUrl: '', apiKeySource: 'credentials', recallTopK: 5 }, failures: { list: () => [] } }
  assert.match(await runCheck({}, runtime, { target: 'nonsense' }), /^mem0_check status:\nbackend: platform/)
  assert.match(await runCheck({}, runtime, { target: 'embedder' }), /only for the local backend; this one is platform/)
  assert.match(await runCheck({}, runtime, { target: 'status' }), /endpoint: api\.mem0\.ai/)
  assert.match(await runCheck({}, null, { target: 'status' }), /not running/)
  assert.ok(CHECK_TARGETS.includes('selftest'))
})

// ---- mem0_setting_set: the setup wizard's save ------------------------------

test('mem0_setting_set fixes the model name through the wizard: self-test, oss.json, reload, check; no credential written', async () => {
  const dir = tempDir()
  let latest = localRuntime(dir, BLOCK(dir))
  const before = latest
  const { ctx, writes } = credentialsCtx()
  let restarts = 0
  const restart = () => {
    restarts += 1
    latest = localRuntime(dir)
  }
  const text = await applySetting({ field: 'embedderModel', value: 'test-embed' }, { ctx, getRuntime: () => latest, fetchImpl: embedFetch(), restart, reloadTimeoutMs: 2000 })
  assert.match(text, /^mem0_setting_set embedderModel: saved through the setup wizard \("wrong-embed" → "test-embed", self-test passed: write, search and delete of a test memory\); the plugin reloaded with it\./, text)
  assert.match(text, /mem0_check embedder: .*"ok":true/)
  assert.match(text, /without further checks unless they ask\.$/)
  assert.notEqual(latest, before)
  assert.equal(restarts, 1)
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'oss.json'), 'utf8')).dsh_mem0
  assert.equal(saved.embedderModel, 'test-embed')
  assert.equal(saved.embedderApiKeyRef, 'DSH_MEM0_EMBEDDER_API_KEY', 'the credential name stays')
  assert.equal(JSON.stringify(saved).includes(KEY), false)
  assert.deepEqual(writes, [], 'no credential was written')
  assert.equal(text.includes(KEY), false)
})

test('mem0_setting_set: a new address keeps the key at home, so the self-test fails and nothing is saved', async () => {
  const dir = tempDir()
  const runtime = localRuntime(dir, BLOCK(dir, 'test-embed'))
  const original = fs.readFileSync(path.join(dir, 'oss.json'), 'utf8')
  const { ctx, writes } = credentialsCtx()
  const seen = []
  let restarted = false
  const text = await applySetting({ field: 'embedderBaseUrl', value: 'https://elsewhere.example.test/v1' }, { ctx, getRuntime: () => runtime, fetchImpl: embedFetch(seen), restart: () => { restarted = true } })
  assert.match(text, /not saved: the self-test with the new value failed, the old setting stays/)
  assert.equal(fs.readFileSync(path.join(dir, 'oss.json'), 'utf8'), original)
  assert.equal(restarted, false)
  assert.deepEqual(writes, [])
  assert.ok(seen.filter((call) => call.host === 'elsewhere.example.test').every((call) => !call.auth), 'the stored key never went to the new host')
})

test('mem0_setting_set refuses what it may not change, and wizard fields on a cloud backend', async () => {
  const dir = tempDir()
  const runtime = localRuntime(dir, BLOCK(dir))
  const { ctx } = credentialsCtx()
  for (const [field, value] of [['apiKey', KEY], ['embedderApiKeyRef', 'OTHER_REF'], ['backend', 'platform'], ['storePath', '/tmp/x.sqlite']]) {
    assert.match(await applySetting({ field, value }, { ctx, getRuntime: () => runtime }), /refused: .* is not a setting/, field)
  }
  const cloud = { config: { backend: 'platform' } }
  assert.match(await applySetting({ field: 'embedderModel', value: 'x' }, { ctx, getRuntime: () => cloud }), /refused: the local backend's model servers/)
  assert.match(await applySetting({ field: 'baseUrl', value: 'http://127.0.0.1:8888' }, { ctx, getRuntime: () => cloud }), /refused: only for the server backend/)
  const followsDsh = localRuntime(dir, BLOCK(dir, 'test-embed', { llmProvider: 'dsh' }))
  assert.match(await applySetting({ field: 'llmModel', value: 'x' }, { ctx, getRuntime: () => followsDsh }), /follows DSH's current model/)
})

// ---- mem0_setting_set: DSH's settings service --------------------------------

test('mem0_setting_set saves profile fields through DSH\'s settings service, waits for the reload, then checks', async () => {
  const dir = tempDir()
  let latest = localRuntime(dir, BLOCK(dir, 'test-embed'))
  const calls = []
  const settings = {
    describe: () => [{ ns: 'dsh-mem0', revision: 7 }],
    async mutate(ns, ops, revision) {
      calls.push({ ns, ops, revision })
      const next = localRuntime(dir)
      next.config = { ...latest.config, [ops[0].path[0]]: ops[0].value }
      setTimeout(() => { latest = next }, 20)
    },
  }
  const { ctx } = credentialsCtx({ settings })
  const text = await applySetting({ field: 'recallTimeoutMs', value: '8000' }, { ctx, getRuntime: () => latest, reloadTimeoutMs: 2000 })
  assert.deepEqual(calls, [{ ns: 'dsh-mem0', ops: [{ op: 'set', path: ['recallTimeoutMs'], value: 8000 }], revision: 7 }])
  assert.match(text, /saved through DSH's settings \(5000 → 8000\); the plugin reloaded with it\./)
  assert.match(text, /mem0_check status:[\s\S]*recallTimeoutMs: 8000/)
  // Unchanged: no write.
  calls.length = 0
  assert.match(await applySetting({ field: 'autoRecall', value: true }, { ctx, getRuntime: () => latest }), /already true; nothing changed/)
  assert.deepEqual(calls, [])
  // A refusal of DSH's is reported, redacted.
  const refusing = credentialsCtx({ settings: { describe: () => [], mutate: async () => { throw new Error(`Config field "x" is not volatile api_key=${KEY}`) } } })
  const refused = await applySetting({ field: 'autoCapture', value: false }, { ctx: refusing.ctx, getRuntime: () => latest })
  assert.match(refused, /DSH refused the change/)
  assert.equal(refused.includes(KEY), false)
  // No settings service: the user changes it on the page.
  assert.match(await applySetting({ field: 'autoCapture', value: false }, { ctx: credentialsCtx().ctx, getRuntime: () => latest }), /tell the user to change autoCapture on the plugin's settings page/)
})

// ---- diagnosis sessions only ------------------------------------------------

test('both tools exist only in diagnosis sessions: the `when` condition, and execute refuses elsewhere', async () => {
  const store = new DiagnoseSessions()
  store.register({ sessionId: 'diag-1', fingerprint: 'dsh-mem0:a' })
  const inDiagnosis = (session) => store.has(session?.id)
  const runtime = { config: { backend: 'platform', recallTopK: 5 }, failures: { list: () => [] } }
  const tools = createDiagnoseTools({ ctx: {}, getRuntime: () => runtime, inDiagnosis })
  assert.deepEqual(tools.map((tool) => tool.name), ['mem0_check', 'mem0_setting_set'])
  const options = diagnoseToolOptions(inDiagnosis)
  assert.equal(options.when({ agent: { session: { id: 'diag-1' } } }), true)
  assert.equal(options.when({ agent: { session: { id: 'user-1' } } }), false)
  assert.equal(options.when({}), false)
  const [check, set] = tools
  assert.match(await check.execute({ target: 'status' }, { agent: { session: { id: 'diag-1' } } }), /^mem0_check status:/)
  assert.equal(await check.execute({ target: 'status' }, { agent: { session: { id: 'user-1' } } }), 'mem0_check is only available in a Mem0 diagnosis session.')
  assert.equal(await set.execute({ field: 'autoRecall', value: 'false' }, { agent: { session: { id: 'user-1' } } }), 'mem0_setting_set is only available in a Mem0 diagnosis session.')
  assert.equal(set.parameters.properties.field.enum.includes('apiKey'), false)
})

test('apply registers both tools with the diagnosis-only condition', async (t) => {
  const dir = tempDir()
  const registered = []
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    get: (key) => (key === 'profileContext' ? { dir } : undefined),
    inject() {},
    on() {},
    effect(fn) { fn() },
    fiber: { restart: async () => {} },
    systemPrompt: { section: () => () => {} },
    tools: { register(tool, options) { registered.push({ name: tool.name, options }); return () => {} } },
  }
  await apply(ctx, { backend: 'platform', apiKey: 'm0-test-placeholder', userId: 'dsh-diag-test' })
  const own = registered.filter((item) => item.name === 'mem0_check' || item.name === 'mem0_setting_set')
  assert.equal(own.length, 2)
  for (const item of own) {
    assert.equal(typeof item.options?.when, 'function', item.name)
    assert.equal(item.options.when({ agent: { session: { id: 'not-a-diagnosis' } } }), false)
  }
  assert.ok(registered.filter((item) => item.name === 'mem0_search').every((item) => item.options === undefined), 'the other tools stay everywhere')
})

// ---- the confirmation -------------------------------------------------------

test('mem0_setting_set always asks in a diagnosis session, naming the field and the new value', async () => {
  const store = new DiagnoseSessions()
  store.register({ sessionId: 'diag-skip', fingerprint: 'dsh-mem0:b', skipConfirm: true })
  const gate = createDiagnoseGate(store, { lang: () => 'zh' })
  const allow = async () => ({ kind: 'allow' })
  const decision = await gate({ name: 'mem0_setting_set', arguments: { field: 'embedderBaseUrl', value: 'http://127.0.0.1:11434/v1/x?k=1' }, agent: { session: { id: 'diag-skip', header: {} } } }, allow)
  assert.equal(decision.kind, 'ask', '"skip confirmation" does not cover it')
  assert.equal(decision.reason, 'dsh-mem0：mem0_setting_set 要把设置 embedderBaseUrl 改成 127.0.0.1:11434（诊断会话；改设置总会确认）。')
  assert.equal((await gate({ name: 'mem0_check', arguments: { target: 'status' }, agent: { session: { id: 'diag-skip', header: {} } } }, allow)).kind, 'allow')
  // Arguments as JSON text read the same.
  const text = await gate({ name: 'mem0_setting_set', arguments: '{"field":"recallTimeoutMs","value":"8000"}', agent: { session: { id: 'diag-skip', header: {} } } }, allow)
  assert.match(text.reason, /recallTimeoutMs 改成 8000/)
  assert.match(settingConfirmText({ field: 'autoRecall', value: false }), /changes the setting autoRecall to false/)
})

test('the wizard draft of the settings in use keeps credential names and never a literal key', () => {
  const draft = currentDraft({ current: { embedder: { provider: 'openai', baseUrl: 'https://e.test/v1', model: 'm', apiKeyRef: 'REF', literalKey: true }, llm: { provider: 'dsh' }, storePath: '~/.dsh/mem0/memory.sqlite' } }, { embedder: { model: 'n' } })
  assert.equal(draft.embedder.apiKeyRef, 'REF')
  assert.equal(draft.embedder.model, 'n')
  assert.deepEqual(draft.useLiteralKey, { embedder: false, llm: false })
  assert.equal(draft.llm.provider, 'dsh')
  assert.equal(draft.storePath, '')
})

test('checklists: a diagnosis session checks with mem0_check, copied text keeps the plain checks', async () => {
  const { checklistFor, diagnoseSkillContent, diagnoseToolRules } = await import('../lib/diagnose-kb.js')
  const skill = diagnoseSkillContent({ lang: 'en' })
  assert.doesNotMatch(skill, /mem0_status|lsof|failures\.json once/)
  assert.match(skill, /mem0_check target models/)
  assert.match(skill, /Configuration \(provider address[\s\S]*Data \(wrong[\s\S]*External \(a service down/)
  for (const cause of ['timeout', 'connection', 'config', 'circuit']) {
    const session = checklistFor({ cause }, { lang: 'zh', tools: true }).join('\n')
    const copied = checklistFor({ cause }, { lang: 'zh', tools: false }).join('\n')
    assert.doesNotMatch(session, /mem0_status|lsof|failures\.json/, cause)
    assert.match(session, /mem0_check/, cause)
    assert.doesNotMatch(copied, /mem0_check|mem0_setting_set/, cause)
  }
  assert.equal(diagnoseToolRules({ lang: 'zh' }).length, 4)
})

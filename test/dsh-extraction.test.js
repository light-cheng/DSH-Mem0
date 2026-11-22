// Extraction with DSH's current model (llmProvider 'dsh'): fake `llm` and
// `agentDefaultModel` services stand in for DSH, a fake fetch for the
// embedder. No real model, key or DSH config; test user ids only; the
// stores live in temporary folders.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { Mem0NativeClient } from '../lib/native-client.js'
import { resolveNativeSettings } from '../lib/oss-config.js'
import { draftFields, testLlm, runSelfTest } from '../lib/setup-wizard.js'
import { handleSetupAction } from '../lib/setup-routes.js'
import { captureRetryReason, retryMaxTokens } from '../lib/memory-lifecycle.js'
import { classifyFailure } from '../lib/failure-history.js'
import { describeLastExtraction, diagnosticLines } from '../lib/diagnostics.js'
import { EXTRACT_PURPOSE } from '../lib/dsh-extraction.js'

const USER = 'dsh-mem0-dsh-model-test-user'
const AGENT = 'dsh-mem0-test'
const FLASH = { provider: 'deepseek-official', model: 'deepseek-flash' }
const PRO = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
const DSH_KEY = 'sk-dshprovidersecret0123456789'
const facts = (...texts) => JSON.stringify({ memory: texts.map((text) => ({ id: '0', text, attributed_to: 'user' })) })

// ---- fakes ----------------------------------------------------------------------

/**
 * DSH's model services. `answer(options, n)` returns the stream's chunks
 * (a finish chunk is added when missing); `select()` changes the model as
 * the user would in DSH. The fake "provider" holds a key the plugin must
 * never see: it is not reachable through the services.
 */
function fakeDsh({ selection = FLASH, answer } = {}) {
  let current = selection
  const calls = []
  const reply = answer ?? (() => [{ type: 'text-delta', text: '{"memory": []}' }])
  const services = {
    agentDefaultModel: { currentSelection: () => (current ? { ...current } : undefined) },
    llm: {
      listProviders: () => (current ? [{ id: current.provider }] : []),
      prepareCall: async (config, signal, choose) => {
        const prepared = choose(config, { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } })
        return { config: prepared, stream: (options) => services.llm.stream(options) }
      },
      async *stream(options) {
        calls.push(options)
        const chunks = await reply(options, calls.length)
        let finished = false
        for (const chunk of chunks) {
          if (chunk.type === 'finish') finished = true
          yield chunk
        }
        if (!finished) yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  return { services, calls, select: (next) => { current = next }, providerKey: DSH_KEY }
}

const usage = (inputTokens, outputTokens, extra = {}) => ({ type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, ...extra } })
const failWith = (code) => () => [{ type: 'finish', reason: { kind: 'error', failure: { code, message: `upstream detail ${DSH_KEY}` } } }]

const VOCAB = ['tea', 'coffee', 'lisbon', 'english', 'green']
function embed(text) {
  const lower = String(text).toLowerCase()
  return [...VOCAB.map((word) => (lower.includes(word) ? 1 : 0)), 0.05]
}
const embedFetch = async (url, init) => {
  const body = JSON.parse(init.body)
  if (!url.endsWith('/embeddings')) throw new Error(`unexpected url ${url}`)
  return new Response(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: embed(text) })) }), { status: 200 })
}

const tempDirs = []
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-dsh-model-'))
  tempDirs.push(dir)
  return dir
}

const FIELDS = { llmProvider: 'dsh', embedderBaseUrl: 'http://127.0.0.1:18000/v1', embedderModel: 'test-embed' }

function setup(t, dsh, values = FIELDS) {
  const dir = tempDir()
  const settings = { ...resolveNativeSettings(values, undefined), storePath: path.join(dir, 'memory.sqlite') }
  const secretsAsked = []
  const client = new Mem0NativeClient({
    config: { backend: 'oss', userId: USER, agentId: AGENT },
    loadSettings: () => settings,
    resolveSecret: async (ref) => {
      secretsAsked.push(ref)
      return undefined
    },
    fetchImpl: embedFetch,
    llmServices: () => dsh.services,
    logger: { info() {}, warn() {}, debug() {} },
  })
  t.after(() => client.dispose())
  return { client, settings, secretsAsked }
}

// ---- the page's helpers (client.js evaluated as the host does) -----------------

function loadPage() {
  let registered
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window })
  const react = { createElement: () => null, useCallback: (fn) => fn, useEffect() {}, useLayoutEffect() {}, useMemo: (fn) => fn(), useRef: () => ({}), useState: (v) => [v, () => {}] }
  return registered.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require ${name}`)
  }).__test__
}
const page = loadPage()
const tr = (dict) => (key) => (key in dict ? dict[key] : key)
const zh = tr(page.zh)
const en = tr(page.en)

// ---- settings ---------------------------------------------------------------------

test('llmProvider dsh: no address, model or key needed or kept; anything else is still checked', () => {
  const settings = resolveNativeSettings({ ...FIELDS, llmBaseUrl: 'http://ignored/v1', llmModel: 'ignored', llmApiKeyRef: 'DSH_MEM0_LLM_API_KEY' }, undefined)
  assert.equal(settings.llm.provider, 'dsh')
  assert.equal(settings.llm.baseUrl, '')
  assert.equal(settings.llm.model, '')
  assert.equal(settings.llm.apiKeyRef, '')
  assert.deepEqual(settings.problems, [])
  const bad = resolveNativeSettings({ ...FIELDS, llmProvider: 'gemini' }, undefined)
  assert.ok(bad.problems.some((problem) => problem.component === 'llm' && problem.code === 'CONFIG_INVALID'))
  // The wizard stores the choice only: no model name, address or key name.
  assert.deepEqual(draftFields({ llm: { provider: 'dsh', baseUrl: 'http://x/v1', model: 'm', apiKeyRef: 'DSH_MEM0_LLM_API_KEY', reasoningEffort: 'low', maxTokens: 8000 } }), { llmProvider: 'dsh', llmMaxTokens: 8000 })
})

// ---- extraction -------------------------------------------------------------------

test('extraction uses the current model: purpose, lowest effort, redacted text, no key through the plugin', async (t) => {
  const dsh = fakeDsh({ answer: () => [usage(1834, 96), { type: 'text-delta', text: facts('User likes green tea') }] })
  const { client, secretsAsked } = setup(t, dsh)
  const result = await client.add([{ role: 'user', content: `I like green tea. My api_key=${DSH_KEY}` }], { userId: USER, agentId: AGENT })
  assert.equal(result.summary.add, 1)
  assert.equal(dsh.calls.length, 1)
  const call = dsh.calls[0]
  assert.equal(call.provider, FLASH.provider)
  assert.equal(call.model, FLASH.model)
  assert.equal(call.purpose, EXTRACT_PURPOSE)
  assert.equal(call.reasoningEffort, 'low')
  assert.equal(call.maxTokens, 8000)
  assert.match(call.system, /Personal Information Organizer|memory/i)
  const sent = JSON.stringify(call.messages)
  assert.match(sent, /green tea/)
  assert.ok(!sent.includes(DSH_KEY), 'secrets are removed before the llm/stream hooks see the text')
  // The plugin never resolves or sends a key for DSH's model.
  assert.deepEqual(secretsAsked, [])
  for (const key of ['apiKey', 'headers', 'baseURL', 'baseUrl']) assert.equal(key in call, false, key)
  const last = client.status().lastExtraction
  assert.equal(last.via, 'dsh')
  assert.equal(last.model, 'deepseek-official/deepseek-flash')
  assert.equal(last.promptTokens, 1834)
  assert.equal(last.completionTokens, 96)
  assert.equal(last.facts, 1)
  assert.equal(last.ok, true)
})

test('thinking is not part of the answer', async (t) => {
  const dsh = fakeDsh({
    answer: () => [
      { type: 'reasoning-delta', text: facts('WRONG: thought, not answered') },
      { type: 'text-delta', text: facts('User lives in Lisbon') },
      usage(500, 300, { reasoningTokens: 200 }),
    ],
  })
  const { client } = setup(t, dsh)
  await client.add([{ role: 'user', content: 'I live in Lisbon' }], { userId: USER, agentId: AGENT })
  const listed = await client.list({ user_id: USER }, { topK: 10 })
  assert.deepEqual(listed.results.map((item) => item.memory), ['User lives in Lisbon'])
  assert.equal(client.status().lastExtraction.reasoningTokens, 200)
})

test('an answer cut off at max tokens is truncated; the retry asks for twice the budget', async (t) => {
  const dsh = fakeDsh({
    answer: (options) => (options.maxTokens === 8000
      ? [{ type: 'text-delta', text: '{"memory": [{"text": "User likes' }, usage(900, 8000), { type: 'finish', reason: { kind: 'max-tokens' } }]
      : [{ type: 'text-delta', text: facts('User likes coffee') }]),
  })
  const { client } = setup(t, dsh)
  const error = await client.add([{ role: 'user', content: 'I like coffee' }], { userId: USER, agentId: AGENT }).catch((value) => value)
  assert.equal(error.extractReason, 'truncated')
  assert.equal(error.provider, 'dsh')
  assert.equal(captureRetryReason(error), 'extraction')
  assert.equal(error.extractStats.finishReason, 'length')
  const doubled = retryMaxTokens(error)
  assert.equal(doubled, 16000)
  const retried = await client.add([{ role: 'user', content: 'I like coffee' }], { userId: USER, agentId: AGENT, llmMaxTokens: doubled })
  assert.equal(dsh.calls[1].maxTokens, 16000)
  assert.equal(retried.summary.add, 1)
})

test('a model changed in DSH during an extraction applies to the next one', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const dsh = fakeDsh({
    answer: async (options, n) => {
      if (n === 1) await gate
      return [{ type: 'text-delta', text: facts(n === 1 ? 'User likes tea' : 'User speaks English') }]
    },
  })
  const { client } = setup(t, dsh)
  const first = client.add([{ role: 'user', content: 'I like tea' }], { userId: USER, agentId: AGENT })
  while (dsh.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
  dsh.select(PRO)
  // The status shows the new model at once; the running call keeps its own.
  assert.equal(client.status().dshModel, 'deepseek-official/deepseek-v4-pro')
  release()
  await first
  assert.equal(dsh.calls[0].model, FLASH.model)
  assert.equal(client.status().lastExtraction.model, 'deepseek-official/deepseek-flash')
  await client.add([{ role: 'user', content: 'Please answer in English' }], { userId: 'dsh-mem0-dsh-model-test-user-2', agentId: AGENT })
  assert.equal(dsh.calls[1].model, PRO.model)
  assert.equal(client.status().lastExtraction.model, 'deepseek-official/deepseek-v4-pro')
})

test('no model selected, or no model service: nothing sent, retried later, said plainly', async (t) => {
  const dsh = fakeDsh({ selection: null })
  const { client } = setup(t, dsh)
  const error = await client.add([{ role: 'user', content: 'I like tea' }], { userId: USER, agentId: AGENT }).catch((value) => value)
  assert.equal(error.code, 'NO_MODEL')
  assert.equal(error.component, 'llm')
  assert.equal(captureRetryReason(error), 'not-delivered')
  assert.equal(dsh.calls.length, 0)
  const health = await client.health()
  assert.equal(health.llm.followsDsh, true)
  assert.equal(health.llm.configured, false)
  const none = await testLlm({ provider: 'dsh', maxTokens: 8000 }, { llmServices: dsh.services })
  assert.equal(none.failure.code, 'NO_MODEL')
  assert.equal(page.failureText(zh, none.failure), 'DSH 里还没有选中模型。请在 DSH 里选一个模型，再测试。')
  const noService = await testLlm({ provider: 'dsh' }, { llmServices: null })
  assert.equal(noService.failure.code, 'NO_SERVICE')
  assert.equal(page.failureText(en, noService.failure), "DSH's model service is not available yet. Wait a few seconds and test again; if this stays, restart DSH.")
})

// ---- failure texts ---------------------------------------------------------------

test('each DSH failure code has its own text in both languages, naming the model, never the upstream detail', async () => {
  const expected = {
    MISSING_CREDENTIAL: ['deepseek-official/deepseek-flash 在 DSH 里没有填 API key。请在 DSH 的模型设置里填上，再测试。', 'auth'],
    AUTH: ['deepseek-official/deepseek-flash 拒绝了 DSH 发送的 API key。请在 DSH 的模型设置里更新 key，再测试。', 'auth'],
    INVALID_CREDENTIAL: ['deepseek-official/deepseek-flash 在 DSH 里的 API key 格式不对。请在 DSH 的模型设置里改正，再测试。', 'auth'],
    RATE_LIMIT: ['deepseek-official/deepseek-flash 现在被限流了。请稍等一会儿再测。', 'auth'],
    QUOTA: ['deepseek-official/deepseek-flash 的额度用完了。请到它的服务商那里充值，或者在 DSH 里换一个模型。', 'auth'],
    NO_ADAPTER: ['DSH 没有加载 deepseek-official/deepseek-flash 的 provider。请检查 DSH 的模型设置，或者换一个模型。', 'other'],
    CONTEXT_WINDOW_EXCEEDED: ['抽取用的提示词超出了 deepseek-official/deepseek-flash 的上下文长度。请在 DSH 里换一个上下文更长的模型。', 'other'],
    TRANSPORT: ['deepseek-official/deepseek-flash 调用失败（TRANSPORT）。请检查 DSH 里的这个模型，再测试。', 'other'],
  }
  for (const [code, [text, cause]] of Object.entries(expected)) {
    const dsh = fakeDsh({ answer: failWith(code) })
    const result = await testLlm({ provider: 'dsh', maxTokens: 8000 }, { llmServices: dsh.services })
    assert.equal(result.ok, false, code)
    assert.deepEqual(result.failure, { reason: 'dsh', code, model: 'deepseek-official/deepseek-flash' })
    assert.equal(page.failureText(zh, result.failure), text, code)
    assert.match(page.failureText(en, result.failure), /deepseek-official\/deepseek-flash/, code)
    assert.ok(!JSON.stringify(result).includes(DSH_KEY), `${code}: no upstream detail`)
    const view = page.llmTestView(zh, result)
    assert.equal(view.ok, false)
    assert.match(view.reason, /deepseek-flash/)
    // The capture path: the same code, classified for the failure history.
    const t = { after() {} }
    const { client } = setup(t, dsh)
    const error = await client.add([{ role: 'user', content: 'I like tea' }], { userId: USER, agentId: AGENT }).catch((value) => value)
    assert.equal(error.dshCode, code)
    assert.equal(classifyFailure(error), cause, `${code} cause`)
    assert.ok(!error.message.includes(DSH_KEY))
    await client.dispose()
  }
  // A timeout of our own.
  const slow = fakeDsh({ answer: (options) => new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => resolve([{ type: 'finish', reason: { kind: 'aborted' } }]), { once: true })) })
  const timedOut = await testLlm({ provider: 'dsh' }, { llmServices: slow.services, timeoutMs: 50 })
  assert.equal(timedOut.failure.code, 'TIMEOUT')
  assert.equal(page.failureText(zh, timedOut.failure), 'deepseek-official/deepseek-flash 没有及时回答。请再测一次，或者在 DSH 里换一个更快的模型。')
})

test('DSH texts exist in both languages with the same placeholders', () => {
  const keys = Object.keys(page.en).filter((key) => key.startsWith('wzFailDsh_') || key.startsWith('wzLlmDsh') || key.startsWith('wzLlmVia') || key.startsWith('statusLlmDsh') || key === 'wzAdviceOtherModel' || key === 'wzCheckModel')
  assert.ok(keys.length >= 20)
  const holes = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',')
  for (const key of keys) {
    assert.ok(key in page.zh, key)
    assert.equal(holes(page.zh[key]), holes(page.en[key]), key)
  }
  assert.match(page.zh.wzLlmDshBilling, /不计入 DSH 的用量统计/)
})

// ---- the wizard -------------------------------------------------------------------

function credentialsCtx() {
  const values = new Map()
  const logs = []
  const sets = []
  const log = (line) => logs.push(String(line))
  return {
    values,
    logs,
    sets,
    ctx: {
      logger: { info: log, warn: log, debug: log },
      get(name) {
        if (name !== 'credentials') return undefined
        return {
          resolve: async (ref) => (values.has(ref) ? { value: values.get(ref), source: 'file' } : undefined),
          describe: async (ref) => ({ configured: values.has(ref), source: values.has(ref) ? 'file' : undefined, writable: true }),
          set: async (ref, value) => { sets.push(ref); values.set(ref, value) },
        }
      },
    },
  }
}

function wizardDraft(dir) {
  return {
    embedder: { provider: 'openai', baseUrl: 'http://127.0.0.1:18000/v1', model: 'test-embed', dims: '', apiKeyRef: '' },
    llm: { provider: 'dsh', maxTokens: 8000 },
    storePath: path.join(dir, 'memory.sqlite'),
    storeConfirmed: true,
    useLiteralKey: {},
  }
}

test('wizard: the live model name, the test and the self-test use the current model; save keeps no key and no model in oss.json', async () => {
  const dir = tempDir()
  const dsh = fakeDsh({ answer: () => [usage(700, 40), { type: 'text-delta', text: facts('User lives in Lisbon', 'User prefers green tea') }] })
  const { ctx, values, logs, sets } = credentialsCtx()
  const ossConfigPath = path.join(dir, 'oss.json')
  const runtime = { config: { backend: 'platform', ossConfigPath, profileFields: [] }, llmServices: { current: dsh.services } }
  const call = (body) => handleSetupAction(ctx, runtime, body, { fetchImpl: embedFetch })

  const live = await call({ action: 'dshModel' })
  assert.deepEqual(live.dshModel, { available: true, provider: 'deepseek-official', model: 'deepseek-flash', name: 'deepseek-official/deepseek-flash' })
  dsh.select(PRO)
  assert.equal((await call({ action: 'dshModel' })).dshModel.name, 'deepseek-official/deepseek-v4-pro')

  const draft = wizardDraft(dir)
  // A key typed into the (hidden) LLM key field is ignored: DSH holds it.
  const keys = { llm: 'typed-llm-key-should-not-be-stored' }
  const tested = await call({ action: 'testLlm', draft, keys })
  assert.equal(tested.ok, true, JSON.stringify(tested))
  assert.equal(tested.model, 'deepseek-official/deepseek-v4-pro')
  assert.equal(tested.facts, 2)
  assert.equal(dsh.calls.at(-1).model, PRO.model)
  const view = page.llmTestView(zh, tested)
  assert.ok(view.details.includes('模型 deepseek-official/deepseek-v4-pro'))

  const self = await call({ action: 'selfTest', draft, keys })
  assert.equal(self.ok, true, JSON.stringify(self))
  assert.deepEqual(self.steps[0], { step: 'model', ok: true, model: 'deepseek-official/deepseek-v4-pro' })

  const saved = await call({ action: 'save', draft, keys })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const file = fs.readFileSync(ossConfigPath, 'utf8')
  const block = JSON.parse(file).dsh_mem0
  assert.equal(block.llmProvider, 'dsh')
  for (const key of ['llmModel', 'llmBaseUrl', 'llmApiKeyRef', 'llmReasoningEffort']) assert.equal(key in block, false, key)
  assert.ok(!file.includes('deepseek'), 'no model name in oss.json')
  assert.ok(!file.includes(keys.llm) && !file.includes(DSH_KEY), 'no key in oss.json')
  assert.ok(!sets.includes('DSH_MEM0_LLM_API_KEY'), 'no LLM key stored in credentials')
  assert.equal(values.has('DSH_MEM0_LLM_API_KEY'), false)
  assert.ok(logs.every((line) => !line.includes(keys.llm) && !line.includes(DSH_KEY)))

  // The self-test stops at the model when it fails, with the model's failure.
  const broken = fakeDsh({ answer: failWith('MISSING_CREDENTIAL') })
  const failed = await runSelfTest({ settings: { ...resolveNativeSettings(FIELDS, undefined), storePath: path.join(dir, 'other.sqlite') }, fetchImpl: embedFetch, llmServices: broken.services })
  assert.equal(failed.ok, false)
  assert.equal(failed.component, 'llm')
  assert.equal(failed.failure.code, 'MISSING_CREDENTIAL')
  assert.equal(failed.steps[0].step, 'model')
  assert.equal(fs.existsSync(path.join(dir, 'other.sqlite')), false, 'nothing written before the model works')
})

test('page: DSH\'s model is the default for a new setup; its payload carries the choice only', () => {
  const fresh = page.emptyWizardDraft({ current: null, refs: { embedder: 'DSH_MEM0_EMBEDDER_API_KEY', llm: 'DSH_MEM0_LLM_API_KEY' } })
  assert.equal(fresh.llm.provider, 'dsh')
  const manual = page.emptyWizardDraft({ current: { embedder: {}, llm: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKeyRef: 'DSH_MEM0_LLM_API_KEY' } }, refs: {} })
  assert.equal(manual.llm.provider, 'openai')
  const saved = page.emptyWizardDraft({ current: { embedder: {}, llm: { provider: 'dsh' } }, refs: {} })
  assert.equal(saved.llm.provider, 'dsh')
  const payload = page.wizardPayload({ ...fresh, embedder: { ...fresh.embedder }, llm: { ...fresh.llm, baseUrl: 'x', model: 'y', apiKeyRef: 'DSH_MEM0_LLM_API_KEY' } })
  assert.deepEqual(JSON.parse(JSON.stringify(payload.llm)), { provider: 'dsh', maxTokens: 8000 })
})

// ---- status and diagnostics -------------------------------------------------------

test('mem0_status lines: the configuration and the last extraction, with tokens', async (t) => {
  const dsh = fakeDsh({ answer: () => [usage(1834, 96, { reasoningTokens: 40 }), { type: 'text-delta', text: facts('User likes tea') }] })
  const { client, settings } = setup(t, dsh)
  const config = { backend: 'oss', native: settings }
  const before = diagnosticLines({ client, config })
  assert.ok(before.includes("extraction LLM (configured): follows DSH's current model, now deepseek-official/deepseek-flash"), before.join('\n'))
  assert.ok(!before.some((line) => line.startsWith('last extraction')))
  await client.add([{ role: 'user', content: 'I like tea' }], { userId: USER, agentId: AGENT })
  dsh.select(PRO)
  const lines = diagnosticLines({ client, config })
  assert.ok(lines.includes("extraction LLM (configured): follows DSH's current model, now deepseek-official/deepseek-v4-pro"), lines.join('\n'))
  const last = lines.find((line) => line.startsWith('last extraction: '))
  assert.match(last, /DSH model deepseek-official\/deepseek-flash, 1 facts, 1834 prompt \+ 96 output tokens \(40 reasoning\)$/)
  assert.equal(describeLastExtraction({ at: 'x', via: 'dsh', model: 'p/m', ok: false, code: 'AUTH' }), 'last extraction: x, DSH model p/m, failed (AUTH)')
  assert.equal(describeLastExtraction(null), '')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  Config,
  DEFAULT_MEM0_CONFIG,
  DEFAULT_STORE_PATH,
  RETIRED_KEY_FIELDS,
  describeBackendChoice,
  resolveConfig,
} from '../lib/config.js'

function tempOss(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-config-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'oss.json')
  if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  return file
}

test('config defaults use automatic backend detection and an independent DSH collection', () => {
  const config = resolveConfig({})
  assert.equal(config.collectionName, 'dsh_mem0')
  assert.equal(config.userId, 'dsh-user')
  assert.equal(config.agentId, 'dsh')
  assert.equal(config.autoRecall, true)
  assert.equal(config.autoCapture, true)
  assert.equal(config.captureMaxChars, 450)
  assert.equal(config.captureFilter, 'heuristic')
  assert.equal(config.profileEnabled, true)
  assert.equal(config.profileBudgetTokens, 1375)
  assert.equal(config.memoryBudgetTokens, 2200)
  assert.equal(config.storeMaxMemories, 500)
  assert.equal(config.storeMaxTokens, 20000)
  assert.equal(config.hygieneEnabled, true)
  assert.equal(config.hygieneIntervalDays, 7)
  assert.equal(config.ossConfigPath, DEFAULT_MEM0_CONFIG)
  assert.equal(config.storePath, DEFAULT_STORE_PATH)
  assert.equal(DEFAULT_STORE_PATH, path.join(os.homedir(), '.dsh', 'mem0', 'memory.sqlite'))
  assert.equal('pythonPath' in config, false)
  assert.equal('mem0ConfigPath' in config, false)
  assert.ok(['platform', 'server', 'oss'].includes(config.backend))
})

test('config expands home and resolves relative paths', () => {
  const config = resolveConfig({
    backend: 'oss',
    storePath: '~/custom/memory.sqlite',
    collectionName: 'custom-mem0',
    userId: 'alice',
    agentId: 'codex',
    autoRecall: false,
    autoCapture: false,
    announceToAgent: false,
    includeSubagents: true,
    captureMaxChars: 800,
    recallTopK: 3,
  })
  assert.equal(config.backend, 'oss')
  assert.equal(config.storePath, path.join(os.homedir(), 'custom', 'memory.sqlite'))
  assert.equal(config.collectionName, 'custom-mem0')
  assert.equal(config.userId, 'alice')
  assert.equal(config.agentId, 'codex')
  assert.equal(config.autoRecall, false)
  assert.equal(config.autoCapture, false)
  assert.equal(config.announceToAgent, false)
  assert.equal(config.includeSubagents, true)
  assert.equal(config.captureMaxChars, 800)
  assert.equal(config.recallTopK, 3)
})

test('config chooses platform or server explicitly and validates baseUrl defaults', () => {
  const platform = resolveConfig({ backend: 'platform', apiKey: 'x', apiKeyEnv: '' })
  assert.equal(platform.backend, 'platform')
  assert.equal(platform.baseUrl, 'https://api.mem0.ai')
  assert.equal(platform.authType, 'token')

  const server = resolveConfig({ backend: 'server', baseUrl: 'http://127.0.0.1:8888', authType: 'apiKey' })
  assert.equal(server.backend, 'server')
  assert.equal(server.baseUrl, 'http://127.0.0.1:8888')
  assert.equal(server.authType, 'apiKey')
})

test('config rejects an invalid collection and out-of-range values', () => {
  assert.throws(() => resolveConfig({ collectionName: 'bad/name' }), /collectionName/)
  assert.throws(() => resolveConfig({ captureMaxChars: 10 }), /captureMaxChars/)
  assert.throws(() => resolveConfig({ recallTopK: 100 }), /recallTopK/)
  assert.throws(() => resolveConfig({ timeoutMs: 0 }), /timeoutMs/)
  assert.throws(() => resolveConfig({ profileBudgetTokens: 10 }), /profileBudgetTokens/)
  assert.throws(() => resolveConfig({ storeMaxMemories: 1 }), /storeMaxMemories/)
  assert.throws(() => resolveConfig({ hygieneIntervalDays: 0 }), /hygieneIntervalDays/)
})

test('enabled=false is preserved', () => {
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
})

test('Config is volatile so the settings page can edit it live', () => {
  const parsed = Config({ backend: 'platform', apiKey: 'x' })
  assert.equal(typeof parsed.get, 'function')
  assert.equal(parsed.get().backend, 'platform')
  assert.equal(resolveConfig(parsed).backend, 'platform')
})

test('auto backend records that an inherited API key chose the Platform', () => {
  const saved = process.env.DSH_MEM0_TEST_KEY
  process.env.DSH_MEM0_TEST_KEY = 'm0sk_fromenvironment'
  try {
    const config = resolveConfig({ apiKeyEnv: 'DSH_MEM0_TEST_KEY' })
    assert.equal(config.backend, 'platform')
    assert.equal(config.backendSource, 'auto-api-key-env')
    assert.equal(config.apiKeySource, 'env')
    const text = describeBackendChoice(config)
    assert.match(text, /DSH_MEM0_TEST_KEY is set in the environment/)
    assert.match(text, /api\.mem0\.ai/)
    const explicit = resolveConfig({ backend: 'oss', apiKeyEnv: 'DSH_MEM0_TEST_KEY' })
    assert.equal(explicit.backend, 'oss')
    assert.equal(explicit.backendSource, 'configured')
    const fromSettings = resolveConfig({ apiKey: 'm0sk_x', apiKeyEnv: 'DSH_MEM0_TEST_KEY' })
    assert.equal(fromSettings.apiKeySource, 'config')
    assert.equal(fromSettings.backendSource, 'auto-api-key')
  } finally {
    if (saved === undefined) delete process.env.DSH_MEM0_TEST_KEY
    else process.env.DSH_MEM0_TEST_KEY = saved
  }
})

test('memory translation is off unless enabled', () => {
  assert.equal(resolveConfig({}).translateMemories, false)
  assert.equal(resolveConfig({ translateMemories: true }).translateMemories, true)
})

test('timeouts have defaults and are validated (G2)', () => {
  const defaults = resolveConfig({})
  assert.equal(defaults.timeoutMs, 30000)
  assert.equal(defaults.recallTimeoutMs, 5000)
  assert.equal(defaults.addTimeoutMs, 120000)
  const custom = resolveConfig({ recallTimeoutMs: 1500, addTimeoutMs: 60000 })
  assert.equal(custom.recallTimeoutMs, 1500)
  assert.equal(custom.addTimeoutMs, 60000)
  assert.throws(() => resolveConfig({ recallTimeoutMs: 10 }), /recallTimeoutMs/)
  assert.throws(() => resolveConfig({ addTimeoutMs: 10 }), /addTimeoutMs/)
  const parsed = Config({ recallTimeoutMs: 2000 })
  assert.equal(resolveConfig(parsed).recallTimeoutMs, 2000)
})

test('settings of the Python sidecar era are ignored, never an error', (t) => {
  const ossPath = tempOss(t, { dsh_mem0: { pythonPath: '/old/venv/bin/python', historyDbPath: '/old/history.db', userId: 'from-oss' } })
  const config = resolveConfig({
    backend: 'oss',
    pythonPath: 'C:\\Users\\me\\venv\\Scripts\\python.exe',
    mem0ConfigPath: '~/.hermes/mem0.json',
    sidecarEnv: ['OPENAI_API_KEY'],
  }, { ossConfigPath: ossPath })
  assert.deepEqual(config.ignoredSettings, ['pythonPath', 'mem0ConfigPath', 'sidecarEnv', 'dsh_mem0.pythonPath', 'dsh_mem0.historyDbPath'])
  assert.equal(config.userId, 'from-oss')
  assert.equal('pythonPath' in config, false)
  assert.equal('sidecarEnv' in config, false)
  // The schema keeps unknown keys without complaint, so a saved profile with
  // the old fields still loads.
  assert.equal(Config({ pythonPath: '/x/python', backend: 'oss' }).get().backend, 'oss')
  assert.deepEqual(RETIRED_KEY_FIELDS, ['pythonPath', 'mem0ConfigPath', 'historyDbPath'])
  assert.equal(config.profileFields.includes('pythonPath'), false)
})

test('the dsh_mem0 block of oss.json configures the local embedder, LLM and store', (t) => {
  const ossPath = tempOss(t, {
    dsh_mem0: {
      storePath: '~/mem/memory.sqlite',
      embedderProvider: 'openai',
      embedderBaseUrl: 'http://127.0.0.1:8000/v1/',
      embedderModel: 'bge-m3',
      embedderDims: 1024,
      embedderApiKeyRef: 'OMLX_API_KEY',
      llmBaseUrl: 'https://api.deepseek.com/v1',
      llmModel: 'deepseek-chat',
      llmApiKeyRef: 'DEEPSEEK_API_KEY',
      llmMaxTokens: 4000,
      llmReasoningEffort: 'low',
    },
  })
  const config = resolveConfig({ backend: 'auto' }, { ossConfigPath: ossPath })
  assert.equal(config.backend, 'oss')
  assert.equal(config.backendSource, 'auto-oss-config')
  assert.equal(config.storePath, path.join(os.homedir(), 'mem', 'memory.sqlite'))
  assert.deepEqual(config.native.embedder, {
    provider: 'openai',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'bge-m3',
    dims: 1024,
    apiKeyRef: 'OMLX_API_KEY',
    source: 'dsh_mem0',
    literalKey: false,
  })
  assert.equal(config.native.llm.model, 'deepseek-chat')
  assert.equal(config.native.llm.maxTokens, 4000)
  assert.equal(config.native.llm.temperature, 0)
  assert.equal(config.native.llm.topP, 0.1)
  assert.equal(config.native.llm.reasoningEffort, 'low')
  assert.equal(config.native.llm.apiKeyRef, 'DEEPSEEK_API_KEY')
  assert.deepEqual(config.native.problems, [])
  assert.ok(config.settingsFromOss.includes('embedderModel'))
  // The profile wins over the block.
  const profile = resolveConfig({ backend: 'oss', embedderModel: 'nomic-embed-text' }, { ossConfigPath: ossPath })
  assert.equal(profile.native.embedder.model, 'nomic-embed-text')
})

test('a mem0-format oss.json (embedder/llm blocks with literal keys) keeps working', (t) => {
  const ossPath = tempOss(t, { oss: {
    embedder: { provider: 'ollama', config: { model: 'bge-m3', ollama_base_url: 'http://localhost:11434', embedding_dims: 1024 } },
    llm: { provider: 'openai', config: { model: 'gpt-4.1-mini', api_key: 'sk-test-literal', openai_base_url: 'https://api.openai.com/v1' } },
    vector_store: { provider: 'qdrant', config: { host: 'localhost', port: 6333, collection_name: 'dsh_mem0' } },
  } })
  const config = resolveConfig({ backend: 'oss' }, { ossConfigPath: ossPath })
  assert.equal(config.native.embedder.provider, 'ollama')
  assert.equal(config.native.embedder.model, 'bge-m3')
  assert.equal(config.native.embedder.dims, 1024)
  assert.equal(config.native.llm.model, 'gpt-4.1-mini')
  assert.equal(config.native.llm.literalKey, true)
  // Literal keys never reach config or status.
  assert.equal(JSON.stringify(config).includes('sk-test-literal'), false)
})

test('a missing embedder is reported as a config problem, not thrown', (t) => {
  const ossPath = tempOss(t, { dsh_mem0: { userId: 'x' } })
  const config = resolveConfig({ backend: 'oss' }, { ossConfigPath: ossPath })
  const codes = config.native.problems.map((problem) => `${problem.component}:${problem.code}`)
  assert.ok(codes.includes('embedder:CONFIG_MISSING'))
  assert.ok(codes.includes('llm:CONFIG_MISSING'))
  const bad = resolveConfig({ backend: 'oss', embedderProvider: 'huggingface' }, { ossConfigPath: ossPath })
  assert.ok(bad.native.problems.some((problem) => problem.code === 'CONFIG_INVALID'))
})

test('store paths resolve on Windows and POSIX layouts alike', () => {
  assert.equal(path.win32.join('C:\\Users\\me', '.dsh', 'mem0', 'memory.sqlite'), 'C:\\Users\\me\\.dsh\\mem0\\memory.sqlite')
  assert.equal(path.posix.join('/home/me', '.dsh', 'mem0', 'memory.sqlite'), '/home/me/.dsh/mem0/memory.sqlite')
  // The real default is built with the platform's own path module.
  assert.equal(path.basename(DEFAULT_STORE_PATH), 'memory.sqlite')
  assert.equal(path.basename(path.dirname(DEFAULT_STORE_PATH)), 'mem0')
  assert.equal(path.isAbsolute(DEFAULT_STORE_PATH), true)
})

// ---- PR #26 review: keys, schema defaults, broken oss.json, upgrade notices ----

import { resolveNativeSettings } from '../lib/oss-config.js'
import { diagnosticLines, upgradeNotices } from '../lib/diagnostics.js'

const MEM0_FORMAT = {
  oss: {
    embedder: { provider: 'openai', config: { model: 'text-embedding-3-small', api_key: 'sk-oss-embedder-literal-1234', openai_base_url: 'https://api.openai.com/v1' } },
    llm: { provider: 'openai', config: { model: 'gpt-4.1-mini', api_key: 'sk-oss-llm-literal-5678', max_tokens: 16000, temperature: 0.2 } },
  },
}

test('the literal key of oss.json never goes to a baseUrl set in dsh_mem0 or the profile', () => {
  const moved = resolveNativeSettings({ embedderBaseUrl: 'https://third-party.example/v1', embedderModel: 'other', llmBaseUrl: 'https://llm.example/v1', llmModel: 'm' }, MEM0_FORMAT)
  assert.equal(moved.embedder.apiKey, '')
  assert.equal(moved.llm.apiKey, '')
  // A credential ref also replaces the literal key.
  const withRef = resolveNativeSettings({ embedderApiKeyRef: 'MEM0_EMBEDDER_API_KEY', llmApiKeyRef: 'MEM0_LLM_API_KEY' }, MEM0_FORMAT)
  assert.equal(withRef.embedder.apiKey, '')
  assert.equal(withRef.llm.apiKey, '')
  // Only a model override: the URL is still oss.json's, so its key stays.
  const sameHost = resolveNativeSettings({ embedderModel: 'text-embedding-3-large' }, MEM0_FORMAT)
  assert.equal(sameHost.embedder.baseUrl, 'https://api.openai.com/v1')
  assert.equal(sameHost.embedder.apiKey, 'sk-oss-embedder-literal-1234')
  assert.equal(resolveNativeSettings({}, MEM0_FORMAT).llm.apiKey, 'sk-oss-llm-literal-5678')
  // Another provider than oss.json's: its key is not reused either.
  assert.equal(resolveNativeSettings({ embedderProvider: 'ollama' }, MEM0_FORMAT).embedder.apiKey, '')
})

test('schema-filled llmMaxTokens and llmTemperature do not hide max_tokens and temperature of a Mem0-format oss.json', (t) => {
  const ossPath = tempOss(t, MEM0_FORMAT)
  // What DSH hands the plugin: every field filled with its schema default.
  const filled = { backend: 'oss', storePath: '', embedderProvider: '', embedderBaseUrl: '', embedderModel: '', embedderDims: 0, embedderApiKeyRef: '', llmBaseUrl: '', llmModel: '', llmApiKeyRef: '', llmMaxTokens: 8000, llmTemperature: 0, llmReasoningEffort: '' }
  const config = resolveConfig(filled, { ossConfigPath: ossPath })
  assert.equal(config.native.llm.maxTokens, 16000)
  assert.equal(config.native.llm.temperature, 0.2)
  assert.equal('llmMaxTokens' in config.nativeValues, false)
  assert.equal(resolveNativeSettings(config.nativeValues, MEM0_FORMAT).llm.maxTokens, 16000)
  // A value the user did set still wins.
  const set = resolveConfig({ ...filled, llmMaxTokens: 12000, llmTemperature: 0.5 }, { ossConfigPath: ossPath })
  assert.equal(set.native.llm.maxTokens, 12000)
  assert.equal(set.native.llm.temperature, 0.5)
  // Without oss.json values the defaults apply.
  const plain = resolveConfig(filled, { ossConfigPath: tempOss(t, { dsh_mem0: { embedderBaseUrl: 'http://127.0.0.1:1/v1', embedderModel: 'e' } }) })
  assert.equal(plain.native.llm.maxTokens, 8000)
  assert.equal(plain.native.llm.temperature, 0)
})

test('an oss.json that is not valid JSON is CONFIG_INVALID with line and column, and no text of the file', (t) => {
  const ossPath = tempOss(t, '{\n  "dsh_mem0": {\n    "embedderModel": "e",\n    "llmApiKey": "sk-secret-in-broken-file-999"\n  \n')
  const config = resolveConfig({ backend: 'oss' }, { ossConfigPath: ossPath })
  const problems = config.native.problems
  assert.equal(problems[0].code, 'CONFIG_INVALID')
  assert.match(problems[0].message, /oss\.json is not valid JSON \(line \d+, column \d+\)/)
  assert.equal(problems.some((problem) => problem.code === 'CONFIG_MISSING'), false, 'no misleading "not configured"')
  assert.equal(JSON.stringify(problems).includes('sk-secret'), false)
  // A missing file is not "invalid".
  const missing = resolveConfig({ backend: 'oss' }, { ossConfigPath: path.join(path.dirname(ossPath), 'none.json') })
  assert.equal(missing.native.problems[0].code, 'CONFIG_MISSING')
  // A UTF-8 BOM (Windows Notepad) is fine.
  const bom = resolveConfig({ backend: 'oss' }, { ossConfigPath: tempOss(t, '﻿{"dsh_mem0":{"embedderBaseUrl":"http://127.0.0.1:1/v1","embedderModel":"e"}}') })
  assert.equal(bom.native.embedder.model, 'e')
})

test('upgrade notices: old memories still in Qdrant (config only), and no local settings found', (t) => {
  const ossPath = tempOss(t, {
    oss: { vector_store: { provider: 'qdrant', config: { host: '127.0.0.1', port: 6333, collection_name: 'dsh_mem0' } } },
    dsh_mem0: { embedderBaseUrl: 'http://127.0.0.1:1/v1', embedderModel: 'e' },
  })
  const config = resolveConfig({ backend: 'oss' }, { ossConfigPath: ossPath })
  assert.deepEqual(config.legacyQdrant, { endpoint: '127.0.0.1:6333', collection: 'dsh_mem0' })
  assert.deepEqual(upgradeNotices(config, { memoryCount: 0 }).map((notice) => notice.code), ['legacyQdrant'])
  assert.deepEqual(upgradeNotices(config, { memoryCount: 3 }), [], 'not once the store has memories')
  const lines = diagnosticLines({ config, memoryCount: 0 })
  assert.ok(lines.some((line) => /still in Qdrant \(127\.0\.0\.1:6333, collection dsh_mem0\).*does not read them/.test(line)), lines.join('\n'))

  // No oss.json at all: auto falls back to the Platform; say why.
  const nothing = resolveConfig({}, { ossConfigPath: path.join(path.dirname(ossPath), 'absent.json') })
  assert.equal(nothing.backendSource, 'auto-default')
  assert.deepEqual(upgradeNotices(nothing).map((notice) => notice.code), ['noLocalConfig'])
  // backend oss without an embedder: the same notice.
  const empty = resolveConfig({ backend: 'oss' }, { ossConfigPath: tempOss(t, {}) })
  assert.deepEqual(upgradeNotices(empty, { memoryCount: 0 }).map((notice) => notice.code), ['noLocalConfig'])
  assert.ok(diagnosticLines({ config: empty }).some((line) => /no local backend settings were found.*Hermes/.test(line)))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  Config,
  DEFAULT_MEM0_CONFIG,
  LEGACY_HERMES_CONFIG,
  describeBackendChoice,
  resolveConfig,
} from '../lib/config.js'

const expectedDefaultConfig = fs.existsSync(DEFAULT_MEM0_CONFIG)
  ? DEFAULT_MEM0_CONFIG
  : fs.existsSync(LEGACY_HERMES_CONFIG)
    ? LEGACY_HERMES_CONFIG
    : DEFAULT_MEM0_CONFIG

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
  assert.equal(config.mem0ConfigPath, expectedDefaultConfig)
  assert.ok(['platform', 'server', 'oss'].includes(config.backend))
})

test('config expands home and resolves relative paths', () => {
  const config = resolveConfig({
    backend: 'oss',
    pythonPath: '~/venv/bin/python',
    mem0ConfigPath: '~/custom-mem0.json',
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
  assert.equal(config.pythonPath, path.join(os.homedir(), 'venv', 'bin', 'python'))
  assert.equal(config.mem0ConfigPath, path.join(os.homedir(), 'custom-mem0.json'))
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

test('timeouts and sidecar env have defaults and are validated (G2, G3)', () => {
  const defaults = resolveConfig({})
  assert.equal(defaults.timeoutMs, 30000)
  assert.equal(defaults.recallTimeoutMs, 5000)
  assert.equal(defaults.addTimeoutMs, 120000)
  assert.deepEqual(defaults.sidecarEnv, [])
  const custom = resolveConfig({ recallTimeoutMs: 1500, addTimeoutMs: 60000, sidecarEnv: [' MY_KEY ', 'MY_KEY', 'OTHER'] })
  assert.equal(custom.recallTimeoutMs, 1500)
  assert.equal(custom.addTimeoutMs, 60000)
  assert.deepEqual(custom.sidecarEnv, ['MY_KEY', 'OTHER'])
  assert.throws(() => resolveConfig({ recallTimeoutMs: 10 }), /recallTimeoutMs/)
  assert.throws(() => resolveConfig({ addTimeoutMs: 10 }), /addTimeoutMs/)
  assert.throws(() => resolveConfig({ sidecarEnv: ['bad name'] }), /sidecarEnv/)
  const parsed = Config({ recallTimeoutMs: 2000, sidecarEnv: ['A_B'] })
  assert.equal(resolveConfig(parsed).recallTimeoutMs, 2000)
  assert.deepEqual(resolveConfig(parsed).sidecarEnv, ['A_B'])
})

// Startup diagnostics of the local backend, from the 2026-11 Windows
// incidents: the real reason behind a store that cannot open, the Windows
// port hint on a refused embedder, embedded-Qdrant detection kept for the
// migration, settings the profile lost (DSH desktop's crash recovery), and settings of the
// Python sidecar era that must not raise a warning after the upgrade.
// Mocks and temp folders only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isFieldSet, resolveConfig, RETIRED_KEY_FIELDS } from '../lib/config.js'
import { Mem0NativeClient } from '../lib/native-client.js'
import { FailureHistory, attributeFailure, classifyFailure } from '../lib/failure-history.js'
import { CONFIG_ERROR_CODES, hostPort, isConfigError, ossFallbacks, qdrantMode } from '../lib/oss-config.js'
import { postJson } from '../lib/providers.js'
import { ConfigGuard, describeConfigWarning } from '../lib/config-guard.js'
import { diagnosticLines } from '../lib/diagnostics.js'
import { MemoryLifecycle } from '../lib/memory-lifecycle.js'
import { CircuitBreaker } from '../lib/http.js'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-winstart-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function nativeSettings(storePath) {
  return {
    storePath,
    embedder: { provider: 'openai', baseUrl: 'http://127.0.0.1:15434/v1', model: 'test-embed', apiKey: '', apiKeyRef: '' },
    llm: { baseUrl: 'http://127.0.0.1:15435/v1', model: 'test-llm', apiKey: '', apiKeyRef: '', maxTokens: 8000, temperature: 0, topP: 0.1 },
    problems: [],
  }
}

// ---- 1. A store that cannot open ----

test('a store path that is a folder: the failure is kept, named in status and mem0_status', async (t) => {
  const dir = tempDir(t)
  const storePath = path.join(dir, 'memory.sqlite')
  fs.mkdirSync(storePath)
  const client = new Mem0NativeClient({
    config: { backend: 'oss', userId: 'dsh-winstart-test-user', agentId: 'dsh-test' },
    loadSettings: () => nativeSettings(storePath),
    fetchImpl: async () => { throw new Error('no network in this test') },
  })
  t.after(() => client.dispose())
  const error = await client.list().catch((value) => value)
  assert.equal(error.component, 'vector_store')
  assert.equal(error.provider, 'sqlite')
  const status = client.status()
  assert.equal(status.running, false)
  assert.equal(status.lastStartFailure.component, 'vector_store')
  assert.match(status.lastStartFailure.reason, /memory\.sqlite/)
  const health = await client.health()
  assert.equal(health.ok, false)
  assert.equal(health.store.ok, false)
  assert.equal(health.qdrant.ok, false, 'the old qdrant field mirrors the store')
  const lines = diagnosticLines({ client, config: { backend: 'oss', native: nativeSettings(storePath) } })
  assert.ok(lines.some((line) => /^last store failure .*vector_store/.test(line)), lines.join('\n'))
  assert.ok(lines.some((line) => /^store: .*memory\.sqlite \(SQLite\)$/.test(line)), lines.join('\n'))
})

test('the breaker skip names the last store failure', async () => {
  const breaker = new CircuitBreaker({ threshold: 1 })
  breaker.recordFailure()
  const recorded = []
  const lifecycle = new MemoryLifecycle({
    client: { lastStartFailure: { reason: 'dsh-mem0: memory store is read-only' } },
    config: { userId: 'u', agentId: 'dsh', recallTopK: 5, autoRecall: true, autoCapture: true, includeSubagents: false },
    breaker,
    activity: {},
    failures: { record: (entry) => recorded.push(entry) },
  })
  const session = { id: 's1', header: { cwd: '/tmp/p' }, deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'What do I drink?' }], source: { kind: 'user' } }] }
  const assembly = () => ({ sections: [], contexts: [], tools: [], variables: {} })
  await lifecycle.onSystemPromptAssemble(assembly(), { agent: { session } }, async () => assembly())
  const skip = recorded.find((entry) => entry.circuit)
  assert.ok(skip, 'a circuit skip was recorded')
  assert.match(skip.message, /circuit breaker open.*last store failure: dsh-mem0: memory store is read-only/)
})

// ---- 2. host:port and the Windows hint ----

test('a refused embedder names host:port, the Windows reserved-port hint, and is a connection failure', async () => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:15434'), { code: 'ECONNREFUSED' }) })
  const error = await postJson('http://127.0.0.1:15434/v1/embeddings', {}, {
    component: 'embedder', step: 'embed', provider: 'openai', fetchImpl: async () => { throw refused },
  }).catch((value) => value)
  assert.equal(error.code, 'NETWORK_ERROR')
  assert.match(error.message, /unreachable at 127\.0\.0\.1:15434 \(connection refused\)/)
  assert.match(error.message, /10013/)
  assert.equal(classifyFailure(error), 'connection')
  assert.deepEqual(attributeFailure(error, { backend: 'oss' }), { component: 'embedder', step: 'embed', provider: 'openai', endpoint: '127.0.0.1:15434' })
  const entry = new FailureHistory({ backend: 'oss' }).record({ kind: 'capture', error })
  assert.equal(entry.cause, 'connection')
})

test('host:port is taken without scheme, path or credentials', () => {
  assert.equal(hostPort('http://user:secret@127.0.0.1:15333/collections?api_key=x'), '127.0.0.1:15333')
  assert.equal(hostPort('127.0.0.1:15434'), '127.0.0.1:15434')
  assert.equal(hostPort('http://localhost'), 'localhost')
  assert.equal(hostPort(''), undefined)
})

// ---- 3. Config errors are not retried until something changes ----

test('config errors (missing embedder, embedder mismatch, newer schema) are config failures', () => {
  for (const code of ['CONFIG_MISSING', 'CONFIG_INVALID', 'EMBEDDER_MISMATCH', 'schema_newer']) {
    assert.ok(CONFIG_ERROR_CODES.includes(code), code)
    const error = Object.assign(new Error(code), { code })
    assert.equal(isConfigError(error), true)
    assert.equal(classifyFailure(error), 'config')
  }
})

// ---- 4. Embedded Qdrant detection (kept for the migration, issue #23) ----

test('qdrantMode: path only or nothing is embedded; url or host+port is a server', () => {
  const mode = (config, provider = 'qdrant') => qdrantMode({ oss: { vector_store: { provider, config } } }).mode
  assert.equal(mode({ path: '/data/qdrant' }), 'embedded')
  assert.equal(mode({}), 'embedded')
  assert.equal(mode({ host: '127.0.0.1' }), 'embedded')
  assert.equal(mode({ host: '127.0.0.1', port: 15333 }), 'server')
  assert.equal(mode({ url: 'http://127.0.0.1:15333' }), 'server')
  assert.equal(qdrantMode({ oss: { vector_store: { config: { path: '/q', url: 'http://h:1' } } } }).pathIgnored, true)
  assert.equal(mode({}, 'chroma'), 'other')
  assert.equal(qdrantMode({}).mode, 'unknown')
})

test('an oss.json with embedded Qdrant no longer stops the local backend', (t) => {
  const dir = tempDir(t)
  const ossPath = path.join(dir, 'oss.json')
  fs.writeFileSync(ossPath, JSON.stringify({ oss: { vector_store: { provider: 'qdrant', config: { path: path.join(dir, 'qdrant') } } }, dsh_mem0: { embedderBaseUrl: 'http://127.0.0.1:15434/v1', embedderModel: 'm' } }))
  const config = resolveConfig({ backend: 'oss' }, { ossConfigPath: ossPath })
  assert.equal(config.native.problems.some((problem) => problem.component === 'embedder'), false)
})

// ---- 5. Settings the profile lost (DSH desktop's crash recovery) ----

test('settings the profile sets are told apart from schema defaults', () => {
  assert.equal(isFieldSet({ collectionName: 'dsh_mem0' }, 'collectionName'), false)
  assert.equal(isFieldSet({ collectionName: 'mine' }, 'collectionName'), true)
  assert.equal(isFieldSet({ translateMemories: false }, 'translateMemories'), false)
  assert.equal(isFieldSet({ translateMemories: true }, 'translateMemories'), true)
  assert.equal(isFieldSet({ backend: 'auto' }, 'backend'), false)
  assert.equal(isFieldSet({ embedderModel: '  ' }, 'embedderModel'), false)
  assert.equal(isFieldSet({ embedderDims: 0 }, 'embedderDims'), false)
  assert.equal(isFieldSet({ embedderDims: 1024 }, 'embedderDims'), true)
  assert.equal(isFieldSet({ llmMaxTokens: 8000 }, 'llmMaxTokens'), false)
})

test('the config guard reports settings that went missing since the last good run', (t) => {
  const file = path.join(tempDir(t), 'config-fingerprint.json')
  const full = ['backend', 'embedderModel', 'embedderBaseUrl', 'collectionName', 'userId', 'translateMemories']
  const first = new ConfigGuard({ filePath: file, profileFields: full, retiredFields: RETIRED_KEY_FIELDS })
  assert.equal(first.status(), null)
  first.markWorking()
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(stored.fields, [...full].sort())
  assert.ok(!JSON.stringify(stored).includes('/'), 'field names only, no values')

  // DSH cut the block down to backend.
  const rewritten = new ConfigGuard({ filePath: file, profileFields: ['backend'], retiredFields: RETIRED_KEY_FIELDS })
  assert.deepEqual(rewritten.status().missing, ['collectionName', 'embedderBaseUrl', 'embedderModel', 'translateMemories', 'userId'])
  rewritten.markWorking()
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).fields, [...full].sort(), 'a rewrite never becomes the baseline')
  assert.match(describeConfigWarning(rewritten.status()), /^dsh-mem0 settings are missing from the profile: collectionName, embedderBaseUrl, embedderModel, translateMemories, userId \(all set on [^)]+\)\. Fill them in on the plugin settings page and save\.$/)
  assert.doesNotMatch(describeConfigWarning(rewritten.status()), /oss\.json|config-fingerprint/)
  assert.doesNotMatch(describeConfigWarning(rewritten.status()), /settings sync/)

  // Kept in oss.json's dsh_mem0 block: not missing.
  const covered = new ConfigGuard({ filePath: file, profileFields: ['backend', 'userId'], fallbackFields: ['embedderModel', 'embedderBaseUrl', 'collectionName', 'translateMemories'], retiredFields: RETIRED_KEY_FIELDS })
  assert.equal(covered.status(), null)
  assert.ok(diagnosticLines({ config: { backend: 'platform' }, configGuard: rewritten }).some((line) => line.startsWith('warning: dsh-mem0 settings are missing from the profile')))
})

test('upgrade: an old fingerprint with pythonPath, mem0ConfigPath and historyDbPath raises no warning', (t) => {
  const file = path.join(tempDir(t), 'config-fingerprint.json')
  // Written by 0.3.x, when the profile set the Python sidecar's settings.
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    savedAt: '2026-11-01T00:00:00.000Z',
    fields: ['backend', 'collectionName', 'historyDbPath', 'mem0ConfigPath', 'pythonPath', 'userId'],
  }))
  // The upgraded profile still has the old fields; DSH keeps unknown keys.
  const profile = { backend: 'oss', collectionName: 'mine', userId: 'u', pythonPath: '/venv/bin/python', mem0ConfigPath: '~/.dsh/mem0/oss.json', historyDbPath: '/x/history.db' }
  const config = resolveConfig(profile, { ossConfigPath: path.join(path.dirname(file), 'missing-oss.json') })
  assert.deepEqual(config.profileFields.sort(), ['backend', 'collectionName', 'userId'])
  const guard = new ConfigGuard({ filePath: file, profileFields: config.profileFields, retiredFields: RETIRED_KEY_FIELDS })
  assert.equal(guard.status(), null)
  guard.markWorking()
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).fields, ['backend', 'collectionName', 'userId'], 'retired names are dropped on the next good run')
  // A profile where DSH also dropped the old fields: still no warning.
  const trimmed = new ConfigGuard({ filePath: file, profileFields: ['backend', 'collectionName', 'userId'], retiredFields: RETIRED_KEY_FIELDS })
  assert.equal(trimmed.status(), null)
  assert.ok(!diagnosticLines({ config, configGuard: guard }).some((line) => line.startsWith('warning:')))
})

test('settings in the dsh_mem0 block of oss.json fill in what the profile does not set', (t) => {
  const dir = tempDir(t)
  const configPath = path.join(dir, 'oss.json')
  fs.writeFileSync(configPath, JSON.stringify({
    dsh_mem0: { pythonPath: path.join(dir, 'venv', 'python'), embedderModel: 'bge-m3', collectionName: 'from_oss', userId: 'oss-user', translateMemories: true, apiKey: 'ignored' },
  }))
  const config = resolveConfig({ backend: 'oss', collectionName: 'dsh_mem0', userId: 'profile-user' }, { ossConfigPath: configPath })
  assert.equal(config.collectionName, 'from_oss', 'the schema default counts as not set')
  assert.equal(config.userId, 'profile-user', 'the profile wins when it sets one')
  assert.equal(config.translateMemories, true)
  assert.equal(config.native.embedder.model, 'bge-m3')
  assert.deepEqual(config.settingsFromOss.sort(), ['collectionName', 'embedderModel', 'translateMemories'])
  assert.deepEqual(config.ignoredSettings, ['dsh_mem0.pythonPath'])
  assert.deepEqual(ossFallbacks({ dsh_mem0: { apiKey: 'x', userId: 5 } }), {})
})

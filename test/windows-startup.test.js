// Startup diagnostics from the 2026-11 Windows incidents: platform-aware
// interpreter discovery, the real reason behind "sidecar failed to start
// recently", embedded Qdrant rejected before Python starts (issue #23),
// SIGKILL after an ignored SIGTERM, and settings dropped by DSH's settings
// sync. Mocks and temp folders only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defaultPythonCandidates,
  findDefaultPythonDetailed,
  isFieldSet,
  pathPythonName,
  resolveConfig,
} from '../lib/config.js'
import { Mem0SidecarClient, lastExceptionLine } from '../lib/sidecar-client.js'
import { FailureHistory, attributeFailure, classifyFailure } from '../lib/failure-history.js'
import { EMBEDDED_QDRANT_CODE, hostPort, ossFallbacks, qdrantMode } from '../lib/oss-config.js'
import { ConfigGuard, describeConfigWarning } from '../lib/config-guard.js'
import { diagnosticLines } from '../lib/diagnostics.js'
import { MemoryLifecycle, countsTowardBreaker } from '../lib/memory-lifecycle.js'
import { CircuitBreaker } from '../lib/http.js'

const FAKE_SIDECAR = fileURLToPath(new URL('./fixtures/fake-sidecar.mjs', import.meta.url))
const SERVER_OSS = { oss: { vector_store: { provider: 'qdrant', config: { url: 'http://127.0.0.1:15333' } } } }

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-winstart-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function fakeSidecar(t, { mode = 'ready', oss = {}, ...options } = {}) {
  const dir = tempDir(t)
  const record = path.join(dir, 'spawns.jsonl')
  const configPath = path.join(dir, 'oss.json')
  fs.writeFileSync(configPath, JSON.stringify(oss))
  const client = new Mem0SidecarClient({
    pythonPath: process.execPath,
    sidecarPath: FAKE_SIDECAR,
    mem0ConfigPath: configPath,
    historyDbPath: path.join(dir, 'history.db'),
    collectionName: 'dsh_mem0_winstart_test',
    userId: 'dsh-winstart-test-user',
    agentId: 'dsh-test',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_SIDECAR_MODE: mode, FAKE_SIDECAR_RECORD: record },
    extraEnv: ['FAKE_SIDECAR_MODE', 'FAKE_SIDECAR_RECORD'],
    stopGraceMs: 300,
    exitWaitMs: 1_000,
    ...options,
  })
  t.after(() => client.dispose())
  const lines = () =>
    fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
  const spawns = () => lines().filter((line) => line.argv)
  return { client, spawns, lines, configPath }
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// ---- 1. Interpreter discovery ----

test('Windows looks for venv\\Scripts\\python.exe first, then the bin copies', () => {
  const candidates = defaultPythonCandidates({ platform: 'win32', home: 'C:\\Users\\tester' })
  assert.deepEqual(candidates.map((item) => item.path), [
    'C:\\Users\\tester\\.dsh\\mem0\\venv\\Scripts\\python.exe',
    'C:\\Users\\tester\\.dsh\\mem0\\venv\\bin\\python.exe',
    'C:\\Users\\tester\\.dsh\\mem0\\venv\\bin\\python',
  ])
  assert.equal(pathPythonName('win32'), 'python')
})

test('POSIX looks for venv/bin/python3, then venv/bin/python, then legacy', () => {
  const candidates = defaultPythonCandidates({ platform: 'darwin', home: '/home/tester' })
  assert.deepEqual(candidates.slice(0, 2).map((item) => item.path), [
    '/home/tester/.dsh/mem0/venv/bin/python3',
    '/home/tester/.dsh/mem0/venv/bin/python',
  ])
  assert.ok(candidates.slice(2).every((item) => item.source === 'legacy'))
  assert.equal(pathPythonName('linux'), 'python3')
})

test('the first existing candidate wins; none found falls back to PATH', () => {
  const home = 'C:\\Users\\tester'
  const onlyBinCopy = new Set(['C:\\Users\\tester\\.dsh\\mem0\\venv\\bin\\python.exe'])
  assert.deepEqual(findDefaultPythonDetailed({ platform: 'win32', home, exists: (file) => onlyBinCopy.has(file) }), {
    path: 'C:\\Users\\tester\\.dsh\\mem0\\venv\\bin\\python.exe',
    source: 'default',
  })
  const both = new Set([...onlyBinCopy, 'C:\\Users\\tester\\.dsh\\mem0\\venv\\Scripts\\python.exe'])
  assert.equal(findDefaultPythonDetailed({ platform: 'win32', home, exists: (file) => both.has(file) }).path, 'C:\\Users\\tester\\.dsh\\mem0\\venv\\Scripts\\python.exe')
  assert.deepEqual(findDefaultPythonDetailed({ platform: 'win32', home, exists: () => false }), { path: 'python', source: 'path' })
  assert.deepEqual(findDefaultPythonDetailed({ platform: 'linux', home: '/h', exists: () => false }), { path: 'python3', source: 'path' })
})

test('an explicit pythonPath always wins', () => {
  const config = resolveConfig({ backend: 'oss', pythonPath: '/opt/venv/bin/python', mem0ConfigPath: '/nonexistent/oss.json' })
  assert.equal(config.pythonPath, '/opt/venv/bin/python')
  assert.equal(config.pythonSource, 'configured')
})

// ---- 2. The real start failure behind the breaker ----

test('a sidecar that dies with ModuleNotFoundError: the skip, the failure card and status name it', async (t) => {
  const { client, spawns } = fakeSidecar(t, { mode: 'nomem0', oss: SERVER_OSS, pythonSource: 'path' })
  await assert.rejects(() => client.ensureStarted(), (error) => {
    assert.equal(error.code, 'START_FAILED')
    assert.equal(error.component, 'sidecar')
    assert.match(error.message, /has no mem0 \(no ~\/\.dsh\/mem0\/venv was found, so the python on PATH was used\)/)
    assert.match(error.message, /ModuleNotFoundError: No module named 'mem0'/)
    return true
  })
  assert.equal(spawns().length, 1)
  const failure = client.status().lastStartFailure
  assert.equal(failure.exitCode, 1)
  assert.equal(failure.component, 'sidecar')
  assert.match(failure.reason, /ModuleNotFoundError: No module named 'mem0'/)
  assert.ok(Date.parse(failure.at))

  // Within the restart backoff, fail-open callers skip with that reason.
  let skip
  await assert.rejects(() => client.search('tea', {}, { waitForStart: false }), (error) => {
    skip = error
    return error.code === 'START_FAILED'
  })
  assert.match(skip.message, /failed to start recently: .*ModuleNotFoundError: No module named 'mem0'/)
  assert.equal(spawns().length, 1, 'no respawn during the backoff')

  const history = new FailureHistory({ backend: 'oss' })
  const entry = history.record({ kind: 'recall', error: skip })
  assert.equal(entry.cause, 'startup', 'not "other"')
  assert.equal(entry.component, 'sidecar')
  assert.match(entry.message, /ModuleNotFoundError: No module named 'mem0'/)
  // Repeated skips fold into one entry.
  history.record({ kind: 'recall', error: skip })
  assert.equal(history.list().length, 1)
  assert.equal(history.list()[0].count, 2)

  const lines = diagnosticLines({ client, config: { backend: 'oss', pythonPath: process.execPath, pythonSource: 'path' } })
  assert.ok(lines.some((line) => /PATH fallback/.test(line)))
  assert.ok(lines.some((line) => /last sidecar start failure .*exit code 1.*ModuleNotFoundError/.test(line)), lines.join('\n'))
})

test('the breaker skip names the last sidecar start failure', async () => {
  const breaker = new CircuitBreaker({ threshold: 1 })
  breaker.recordFailure()
  const recorded = []
  const lifecycle = new MemoryLifecycle({
    client: { lastStartFailure: { reason: "ModuleNotFoundError: No module named 'mem0'" } },
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
  assert.match(skip.message, /circuit breaker open.*last sidecar start failure: ModuleNotFoundError/)
})

test('the last exception line is found in a Python traceback', () => {
  assert.equal(lastExceptionLine(['Traceback (most recent call last):', '  File "x.py"', "ModuleNotFoundError: No module named 'mem0'"]), "ModuleNotFoundError: No module named 'mem0'")
  assert.equal(lastExceptionLine(['qdrant_client.http.exceptions.ResponseHandlingException: [Errno 61] Connection refused']), 'ResponseHandlingException: [Errno 61] Connection refused')
  assert.equal(lastExceptionLine(['just a warning line']), '')
})

// ---- 4. host:port and the Windows hint ----

test('a refused Qdrant start names host:port and counts as a connection failure', () => {
  const error = Object.assign(new Error('dsh-mem0 sidecar failed: Qdrant unreachable at 127.0.0.1:15333 (connection refused). Check …'), {
    code: 'START_FAILED',
    component: 'vector_store',
    provider: 'qdrant',
    endpoint: '127.0.0.1:15333',
  })
  assert.equal(classifyFailure(error), 'connection')
  assert.deepEqual(attributeFailure(error, { backend: 'oss' }), { component: 'vector_store', provider: 'qdrant', endpoint: '127.0.0.1:15333' })
})

test('host:port is taken from oss.json without scheme, path or credentials', () => {
  assert.equal(hostPort('http://user:secret@127.0.0.1:15333/collections?api_key=x'), '127.0.0.1:15333')
  assert.equal(hostPort('127.0.0.1:15434'), '127.0.0.1:15434')
  assert.equal(hostPort('http://localhost'), 'localhost')
  assert.equal(hostPort(''), undefined)
})

// ---- 6. SIGTERM, then SIGKILL ----

test('dispose escalates to SIGKILL when the sidecar ignores SIGTERM, and waits for the exit', async (t) => {
  const { client, lines } = fakeSidecar(t, { mode: 'stubborn', oss: SERVER_OSS })
  await client.ensureStarted()
  const child = client.child
  await client.dispose()
  assert.ok(lines().some((line) => line.ignoredTerm), 'SIGTERM was sent and ignored')
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'the process has exited')
  assert.equal(child.signalCode, 'SIGKILL')
})

// ---- 7. Embedded Qdrant (issue #23) ----

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

test('path only: a clear config error at once, Python never starts, no retry until oss.json changes', async (t) => {
  const { client, spawns, configPath } = fakeSidecar(t, {
    oss: { oss: { vector_store: { provider: 'qdrant', config: { path: '/data/qdrant' } } } },
  })
  const check = (error) => {
    assert.equal(error.code, EMBEDDED_QDRANT_CODE)
    assert.equal(error.component, 'vector_store')
    assert.match(error.message, /Embedded Qdrant .* is not supported/)
    assert.match(error.message, /不支持嵌入式 Qdrant，请启动 Qdrant 服务端并在 oss\.json 里用 url/)
    assert.match(error.message, /#qdrant-server-only/)
    return true
  }
  await assert.rejects(() => client.ensureStarted(), check)
  await assert.rejects(() => client.ensureStarted(), check)
  await assert.rejects(() => client.search('tea', {}, { waitForStart: false }), check)
  assert.equal(spawns().length, 0, 'Python was never started')
  assert.equal(client.status().lastStartFailure.configError, true)

  const history = new FailureHistory({ backend: 'oss' })
  for (const kind of ['recall', 'maintenance', 'recall', 'capture']) {
    await client.ensureStarted().catch((error) => {
      assert.equal(countsTowardBreaker(error), false, 'config errors do not open the breaker')
      history.record({ kind, error })
    })
  }
  assert.equal(history.list().length, 1, 'one entry, whatever kind of call hit it')
  assert.equal(history.list()[0].cause, 'config')
  assert.equal(history.list()[0].component, 'vector_store')
  assert.equal(history.list()[0].count, 4)

  // Fixing the file is noticed without a plugin restart.
  fs.writeFileSync(configPath, JSON.stringify(SERVER_OSS))
  await client.ensureStarted()
  assert.equal(spawns().length, 1)
})

test('path and url: runs on url, with a warning that path is ignored', async (t) => {
  const warnings = []
  const { client, spawns } = fakeSidecar(t, {
    oss: { oss: { vector_store: { provider: 'qdrant', config: { path: '/data/q', url: 'http://127.0.0.1:15333' } } } },
    logger: { warn: (message) => warnings.push(message), info() {}, debug() {} },
  })
  await client.ensureStarted()
  assert.equal(spawns().length, 1)
  assert.ok(warnings.some((message) => /path is ignored/.test(message)))
})

test('url only: unaffected', async (t) => {
  const warnings = []
  const { client } = fakeSidecar(t, { oss: SERVER_OSS, logger: { warn: (message) => warnings.push(message), info() {}, debug() {} } })
  await client.ensureStarted()
  assert.equal(client.running, true)
  assert.deepEqual(warnings, [])
})

// ---- 3. Settings dropped by DSH's settings sync ----

test('settings the profile sets are told apart from schema defaults', () => {
  assert.equal(isFieldSet({ collectionName: 'dsh_mem0' }, 'collectionName'), false)
  assert.equal(isFieldSet({ collectionName: 'mine' }, 'collectionName'), true)
  assert.equal(isFieldSet({ translateMemories: false }, 'translateMemories'), false)
  assert.equal(isFieldSet({ translateMemories: true }, 'translateMemories'), true)
  assert.equal(isFieldSet({ backend: 'auto' }, 'backend'), false)
  assert.equal(isFieldSet({ pythonPath: '  ' }, 'pythonPath'), false)
})

test('the config guard reports settings that went missing since the last good run', (t) => {
  const file = path.join(tempDir(t), 'config-fingerprint.json')
  const full = ['backend', 'pythonPath', 'mem0ConfigPath', 'collectionName', 'userId', 'translateMemories']
  const first = new ConfigGuard({ filePath: file, profileFields: full })
  assert.equal(first.status(), null)
  first.markWorking()
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(stored.fields, [...full].sort())
  assert.ok(!JSON.stringify(stored).includes('/'), 'field names only, no values')

  // DSH cut the block down to backend.
  const rewritten = new ConfigGuard({ filePath: file, profileFields: ['backend'] })
  assert.deepEqual(rewritten.status().missing, ['collectionName', 'mem0ConfigPath', 'pythonPath', 'translateMemories', 'userId'])
  rewritten.markWorking()
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).fields, [...full].sort(), 'a rewrite never becomes the baseline')
  assert.match(describeConfigWarning(rewritten.status()), /missing: collectionName, mem0ConfigPath, pythonPath/)

  // Kept in oss.json's dsh_mem0 block: not missing.
  const covered = new ConfigGuard({ filePath: file, profileFields: ['backend', 'mem0ConfigPath'], fallbackFields: ['pythonPath', 'collectionName', 'userId', 'translateMemories'] })
  assert.equal(covered.status(), null)
  assert.ok(diagnosticLines({ config: { backend: 'platform' }, configGuard: rewritten }).some((line) => line.startsWith('warning: dsh-mem0 settings look rewritten')))
})

test('settings in the dsh_mem0 block of oss.json fill in what the profile does not set', (t) => {
  const dir = tempDir(t)
  const configPath = path.join(dir, 'oss.json')
  fs.writeFileSync(configPath, JSON.stringify({
    ...SERVER_OSS,
    dsh_mem0: { pythonPath: path.join(dir, 'venv', 'python'), collectionName: 'from_oss', userId: 'oss-user', translateMemories: true, apiKey: 'ignored' },
  }))
  const config = resolveConfig({ backend: 'oss', mem0ConfigPath: configPath, collectionName: 'dsh_mem0', userId: 'profile-user' })
  assert.equal(config.pythonPath, path.join(dir, 'venv', 'python'))
  assert.equal(config.pythonSource, 'oss-config')
  assert.equal(config.collectionName, 'from_oss', 'the schema default counts as not set')
  assert.equal(config.userId, 'profile-user', 'the profile wins when it sets one')
  assert.equal(config.translateMemories, true)
  assert.deepEqual(config.settingsFromOss.sort(), ['collectionName', 'pythonPath', 'translateMemories'])
  assert.deepEqual(ossFallbacks({ dsh_mem0: { apiKey: 'x', userId: 5 } }), {})
})

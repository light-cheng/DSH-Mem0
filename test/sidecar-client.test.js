import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { localServerTest } from './fixtures/local-listen.js'
import { CircuitBreaker, Mem0SidecarClient } from '../lib/sidecar-client.js'

async function withServer(handler, fn) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    return await fn(port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

localServerTest('sidecar client sends the per-process token and parses JSON', async () => {
  const client = new Mem0SidecarClient({
    pythonPath: '/usr/bin/false',
    mem0ConfigPath: '/not-used',
    historyDbPath: '/not-used',
    collectionName: 'dsh_mem0',
    userId: 'dsh-user',
    agentId: 'dsh',
    requestTimeoutMs: 2_000,
  })
  await withServer(
    (req, res) => {
      assert.equal(req.headers['x-dsh-mem0-token'], client.token)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    },
    async (port) => {
      client.port = port
      client.ready = true
      client.child = {}
      const result = await client.request('GET', '/health')
      assert.deepEqual(result, { ok: true })
    },
  )
})

localServerTest('sidecar client maps HTTP errors into Mem0SidecarError', async () => {
  const client = new Mem0SidecarClient({
    pythonPath: '/usr/bin/false',
    mem0ConfigPath: '/not-used',
    historyDbPath: '/not-used',
    collectionName: 'dsh_mem0',
    userId: 'dsh-user',
    agentId: 'dsh',
    requestTimeoutMs: 2_000,
  })
  await withServer(
    (_req, res) => {
      res.statusCode = 503
      res.end(JSON.stringify({ error: 'Qdrant unavailable' }))
    },
    async (port) => {
      client.port = port
      client.ready = true
      client.child = {}
      await assert.rejects(
        () => client.request('GET', '/health'),
        /Qdrant unavailable/,
      )
    },
  )
})

test('circuit breaker opens after the threshold and closes after cooldown', () => {
  let now = 1_000
  const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 500, now: () => now })
  assert.equal(breaker.isOpen(), false)
  breaker.recordFailure()
  assert.equal(breaker.isOpen(), false)
  breaker.recordFailure()
  assert.equal(breaker.isOpen(), true)
  now += 499
  assert.equal(breaker.isOpen(), true)
  now += 2
  assert.equal(breaker.isOpen(), false)
  assert.equal(breaker.failures, 0)
})

// ---- Startup behaviour with a fake sidecar process (I4, G3) ----

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSidecarEnv, pythonNoProxy } from '../lib/sidecar-client.js'

const FAKE_SIDECAR = fileURLToPath(new URL('./fixtures/fake-sidecar.mjs', import.meta.url))

function fakeSidecar(t, { mode = 'ready', delayMs = 0, env = {}, extraEnv = [], ...options } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-fake-sidecar-'))
  const record = path.join(dir, 'spawns.jsonl')
  const configPath = path.join(dir, 'oss.json')
  fs.writeFileSync(configPath, '{}')
  const client = new Mem0SidecarClient({
    pythonPath: process.execPath,
    sidecarPath: FAKE_SIDECAR,
    mem0ConfigPath: configPath,
    historyDbPath: path.join(dir, 'history.db'),
    collectionName: 'dsh_mem0_test',
    userId: 'dsh-test-user',
    agentId: 'dsh-test',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      FAKE_SIDECAR_MODE: mode,
      FAKE_SIDECAR_DELAY_MS: String(delayMs),
      FAKE_SIDECAR_RECORD: record,
      ...env,
    },
    extraEnv: ['FAKE_SIDECAR_MODE', 'FAKE_SIDECAR_DELAY_MS', 'FAKE_SIDECAR_RECORD', ...extraEnv],
    stopGraceMs: 500,
    ...options,
  })
  t.after(async () => {
    await client.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const spawns = () =>
    fs.existsSync(record)
      ? fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : []
  return { client, spawns }
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('recall-style requests skip at once while a slow sidecar starts in the background', async (t) => {
  const { client, spawns } = fakeSidecar(t, { delayMs: 1_500 })
  const started = Date.now()
  await assert.rejects(
    () => client.search('tea', { user_id: 'dsh-test-user' }, { waitForStart: false, timeoutMs: 3_000 }),
    (error) => error.code === 'STARTING',
  )
  assert.ok(Date.now() - started < 500, 'did not wait for startup')
  // A second recall during the same startup also skips and does not respawn.
  await assert.rejects(
    () => client.search('tea', {}, { waitForStart: false }),
    (error) => error.code === 'STARTING',
  )
  await waitFor(() => client.running)
  assert.equal(client.port, 9)
  assert.equal(spawns().length, 1)
})

test('concurrent callers share one sidecar startup', async (t) => {
  const { client, spawns } = fakeSidecar(t, { delayMs: 300 })
  await Promise.all([client.ensureStarted(), client.ensureStarted(), client.ensureStarted()])
  assert.equal(client.running, true)
  assert.equal(spawns().length, 1)
})

test('a waiting caller stops waiting when its signal aborts; startup continues', async (t) => {
  const { client, spawns } = fakeSidecar(t, { delayMs: 800 })
  const started = Date.now()
  await assert.rejects(
    () => client.list({ user_id: 'dsh-test-user' }, { signal: AbortSignal.timeout(100) }),
    (error) => error.code === 'ABORTED',
  )
  assert.ok(Date.now() - started < 600, 'abort ended the wait early')
  await waitFor(() => client.running)
  assert.equal(spawns().length, 1)
})

test('after a crash on startup, recall fails fast without respawning until the backoff ends', async (t) => {
  let now = 1_000_000
  const { client, spawns } = fakeSidecar(t, { mode: 'crash', restartBackoffMs: 30_000, now: () => now })
  await assert.rejects(
    () => client.search('tea', {}, { waitForStart: false }),
    (error) => error.code === 'STARTING',
  )
  await waitFor(() => client.lastStartFailureAt > 0 && !client.startPromise)
  const started = Date.now()
  await assert.rejects(
    () => client.search('tea', {}, { waitForStart: false }),
    (error) => error.code === 'START_FAILED',
  )
  assert.ok(Date.now() - started < 100)
  assert.equal(spawns().length, 1)
  // Callers that may wait still get a fresh attempt and its real error.
  await assert.rejects(() => client.ensureStarted(), /exited before ready/)
  assert.equal(spawns().length, 2)
  now += 31_000
  await assert.rejects(
    () => client.search('tea', {}, { waitForStart: false }),
    (error) => error.code === 'STARTING',
  )
  await waitFor(() => spawns().length === 3)
})

test('a sidecar that never reports ready is bounded by the startup timeout', async (t) => {
  const { client } = fakeSidecar(t, { mode: 'silent', startupTimeoutMs: 300 })
  const started = Date.now()
  await assert.rejects(() => client.ensureStarted(), (error) => error.code === 'STARTUP_TIMEOUT')
  assert.ok(Date.now() - started < 2_000)
})

test('the token goes over stdin and the child gets an allowlisted environment', async (t) => {
  const { client, spawns } = fakeSidecar(t, {
    env: {
      OPENAI_API_KEY: 'sk-provider',
      OPENROUTER_API_KEY: 'sk-openrouter',
      MEM0_API_KEY: 'm0-platform',
      GITHUB_TOKEN: 'ghp-unrelated',
      MY_GATEWAY_KEY: 'configured',
      VIRTUAL_ENV: '/venv',
    },
    extraEnv: ['MY_GATEWAY_KEY'],
  })
  await client.ensureStarted()
  const [spawn] = spawns()
  assert.equal(spawn.token, client.token)
  assert.ok(!spawn.argv.includes(client.token), 'token is not on the command line')
  assert.ok(spawn.argv.includes('--token-stdin'))
  assert.ok(!spawn.argv.includes('--token'))
  assert.equal(spawn.env.OPENAI_API_KEY, 'sk-provider')
  assert.equal(spawn.env.MY_GATEWAY_KEY, 'configured')
  assert.equal(spawn.env.VIRTUAL_ENV, '/venv')
  assert.equal(spawn.env.MEM0_TELEMETRY, 'false')
  assert.equal(spawn.env.GITHUB_TOKEN, undefined)
  assert.equal(spawn.env.MEM0_API_KEY, undefined)
  assert.equal(spawn.env.OPENROUTER_API_KEY, undefined)
})

test('stderr is still read after ready, so a chatty sidecar never blocks on a full pipe', async (t) => {
  const { client, spawns } = fakeSidecar(t, { mode: 'chatty' })
  await client.ensureStarted()
  await waitFor(() => spawns().some((row) => row.stderrDone), 5_000)
})

test('pythonNoProxy unbrackets IPv6 entries that Python httpx rejects', () => {
  assert.equal(pythonNoProxy('localhost,127.0.0.1,::1,[::1]'), 'localhost,127.0.0.1,::1')
  assert.equal(pythonNoProxy('[::1]:8080, example.com'), '::1,example.com')
  assert.equal(pythonNoProxy('*'), '*')
  const env = buildSidecarEnv({ NO_PROXY: 'localhost,[::1]', no_proxy: '[::1]', HTTPS_PROXY: 'http://127.0.0.1:1082' })
  assert.equal(env.NO_PROXY, 'localhost,::1')
  assert.equal(env.no_proxy, '::1')
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:1082')
})

test('buildSidecarEnv keeps basics, Python and provider variables only', () => {
  const env = buildSidecarEnv(
    {
      PATH: '/bin',
      HOME: '/home/u',
      LC_ALL: 'C',
      PYTHONPATH: '/p',
      HF_HOME: '/hf',
      OLLAMA_HOST: 'http://127.0.0.1:11434',
      AWS_REGION: 'us-east-1',
      SSH_AUTH_SOCK: '/tmp/ssh',
      NPM_TOKEN: 'npm',
      'BAD-NAME': 'x',
    },
    ['NPM_TOKEN', 'not valid'],
  )
  assert.deepEqual(Object.keys(env).sort(), [
    'AWS_REGION', 'HF_HOME', 'HOME', 'LC_ALL', 'MEM0_TELEMETRY', 'NPM_TOKEN', 'OLLAMA_HOST', 'PATH', 'PYTHONPATH', 'PYTHONUNBUFFERED',
  ])
})

test('CircuitBreaker lives in lib/http.js and is still exported from sidecar-client (G7)', async () => {
  const http = await import('../lib/http.js')
  assert.equal(CircuitBreaker, http.CircuitBreaker)
})

// ---- Exit information, sidecar.log and delivery (observability fixes) ----

import { SidecarLog } from '../lib/sidecar-log.js'
import { provesNotDelivered } from '../lib/sidecar-client.js'
import { FailureHistory } from '../lib/failure-history.js'

function tempLog(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-sidecar-log-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return new SidecarLog({ filePath: path.join(dir, 'sidecar.log') })
}

test('a sidecar that exits during startup: the error and status carry the exit; stderr lands redacted in sidecar.log', async (t) => {
  const log = tempLog(t)
  const { client } = fakeSidecar(t, { mode: 'crash', log })
  const error = await client.ensureStarted().then(() => null, (caught) => caught)
  assert.equal(error?.code, 'START_FAILED')
  assert.equal(error.exitCode, 3)
  assert.equal(error.component, 'sidecar')
  assert.ok(Number.isFinite(error.uptimeMs))
  const status = client.status()
  assert.equal(status.running, false)
  assert.equal(status.lastExit.code, 3)
  assert.equal(status.lastExit.phase, 'startup')
  const text = fs.readFileSync(log.filePath, 'utf8')
  assert.match(text, /stderr Traceback: ValueError: bad config/)
  assert.doesNotMatch(text, /sk-fakefake/)
  assert.doesNotMatch(text, /\/Users\/alice/)
  assert.match(text, /event sidecar exited \(code 3\)/)
  // The failure history keeps the exit with component sidecar.
  const history = new FailureHistory({ backend: 'oss' })
  const entry = history.record({ kind: 'capture', error })
  assert.equal(entry.component, 'sidecar')
  assert.equal(entry.exitCode, 3)
  assert.ok(Number.isFinite(entry.uptimeMs))
})

test('status() reports the interpreter PID, start time and restarts; an external kill is recorded', async (t) => {
  const log = tempLog(t)
  const { client } = fakeSidecar(t, { log })
  await client.ensureStarted()
  const first = client.status()
  assert.equal(first.running, true)
  assert.equal(first.pid, client.child.pid) // the fake reports its own pid
  assert.equal(first.restarts, 0)
  assert.ok(Date.parse(first.startedAt) > 0)
  const exited = new Promise((resolve) => client.child.once('exit', resolve))
  process.kill(first.pid, 'SIGKILL')
  await exited
  const after = client.status()
  assert.equal(after.running, false)
  assert.equal(after.lastExit.signal, 'SIGKILL')
  assert.equal(after.lastExit.phase, 'running')
  assert.equal(after.lastExit.pid, first.pid)
  assert.equal(after.lastExit.stoppedBy, undefined)
  await client.ensureStarted()
  assert.equal(client.status().restarts, 1)
  assert.match(fs.readFileSync(log.filePath, 'utf8'), /sidecar exited \(signal SIGKILL\) after \d+ ms while running; pid \d+/)
})

test('dispose marks the exit as stopped by the plugin', async (t) => {
  const { client } = fakeSidecar(t)
  await client.ensureStarted()
  await client.dispose()
  assert.equal(client.status().lastExit.stoppedBy, 'dispose')
})

test('only a refused connection proves a request was not delivered', () => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }) })
  assert.equal(provesNotDelivered(refused), true)
  const aggregate = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new AggregateError([Object.assign(new Error('x'), { code: 'ECONNREFUSED' })]), {}) })
  assert.equal(provesNotDelivered(aggregate), true)
  for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE', 'ETIMEDOUT']) {
    assert.equal(provesNotDelivered(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })), false, code)
  }
  assert.equal(provesNotDelivered(new Error('aborted')), false)
})

localServerTest('a request to a port nobody serves fails as not delivered', async (t) => {
  // The fake sidecar reports port 59 without listening on it.
  const { client } = fakeSidecar(t, { env: { FAKE_SIDECAR_PORT: '59' }, extraEnv: ['FAKE_SIDECAR_PORT'], requestTimeoutMs: 2_000, exitWaitMs: 50 })
  await client.ensureStarted()
  const error = await client.add([{ role: 'user', content: 'x' }]).then(() => null, (caught) => caught)
  assert.equal(error?.code, 'NETWORK_ERROR')
  assert.equal(error.delivered, false)
  // The sidecar is still alive: no exit to attach.
  assert.equal(error.exitCode, undefined)
  assert.equal(error.signal, undefined)
})

localServerTest('a sidecar killed during /add: fetch failed carries the exit signal and is not "not delivered"', async (t) => {
  const log = tempLog(t)
  const { client } = fakeSidecar(t, { mode: 'serve', env: { FAKE_SIDECAR_ADD: 'die' }, extraEnv: ['FAKE_SIDECAR_ADD'], log, requestTimeoutMs: 5_000 })
  await client.ensureStarted()
  const error = await client.add([{ role: 'user', content: 'x' }]).then(() => null, (caught) => caught)
  assert.ok(['NETWORK_ERROR', 'ABORTED'].includes(error?.code), error?.code)
  assert.equal(error.delivered, undefined)
  assert.equal(error.signal, 'SIGKILL')
  assert.equal(error.component, 'sidecar')
  assert.ok(error.uptimeMs >= 0)
  const entry = new FailureHistory({ backend: 'oss' }).record({ kind: 'capture', error })
  assert.equal(entry.signal, 'SIGKILL')
  assert.equal(entry.component, 'sidecar')
  assert.match(fs.readFileSync(log.filePath, 'utf8'), /stderr about to die mid-request/)
})

test('sidecar.log rotates at its cap and tail() reads across the rotated copy', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-sidecar-log-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'sidecar.log')
  const log = new SidecarLog({ filePath: file, maxBytes: 8192 })
  for (let index = 0; index < 100; index += 1) log.write(`line ${index} ${'y'.repeat(80)}`)
  assert.ok(fs.statSync(file).size <= 8192)
  assert.ok(fs.existsSync(`${file}.1`))
  assert.ok(fs.statSync(`${file}.1`).size <= 8192)
  const tail = log.tail(50)
  assert.equal(tail.length, 50)
  assert.match(tail.at(-1), /line 99 /)
  assert.match(tail[0], /line 50 /)
})

test('sidecar.log redacts keys and home paths; without a file it keeps lines in memory', () => {
  const log = new SidecarLog({ home: '/home/bob' })
  log.write('openai.AuthenticationError: Incorrect API key provided: sk-abcdefghijklmnop at /home/bob/.dsh/mem0/venv')
  log.write('Authorization: Bearer abcdefghijklmnop1234')
  const lines = log.tail(10)
  assert.equal(lines.length, 2)
  assert.doesNotMatch(lines.join('\n'), /sk-abcdefgh|abcdefghijklmnop1234|\/home\/bob/)
  assert.match(lines[0], /~\/\.dsh\/mem0\/venv/)
})

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

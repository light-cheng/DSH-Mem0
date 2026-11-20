// Slow recall (Windows test, 2026-11-20: 10 results in 7019 ms): step times
// in recall activity and mem0_status, Ollama keep_alive, and the warm-up of
// a local embedder at start. Mocked embedder (no network), temporary SQLite
// file, test user only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describeRecallTimings, MemoryLifecycle, recallTimings } from '../lib/memory-lifecycle.js'
import { DEFAULT_KEEP_ALIVE, isLocalUrl, Mem0NativeClient } from '../lib/native-client.js'
import { ollamaKeepAlive } from '../lib/providers.js'
import { resolveConfig } from '../lib/config.js'
import { createMem0Tools } from '../lib/tools.js'

const USER = 'dsh-mem0-timing-test-user'

function setup(t, { provider = 'ollama', baseUrl = 'http://127.0.0.1:11434', config = {}, embedDelayMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-timing-'))
  const settings = {
    storePath: path.join(dir, 'memory.sqlite'),
    embedder: { provider, baseUrl, model: 'bge-m3', apiKeyRef: '', apiKey: '' },
    llm: { baseUrl: '', model: '', apiKeyRef: '', apiKey: '' },
    problems: [],
  }
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body })
    if (embedDelayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, embedDelayMs)
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(init.signal.reason ?? new Error('aborted'))
        }, { once: true })
      })
    }
    const vectors = body.input.map((text) => [String(text).length % 7, 1, 0.5])
    const payload = url.endsWith('/api/embed') ? { embeddings: vectors } : { data: vectors.map((embedding, index) => ({ index, embedding })) }
    return new Response(JSON.stringify(payload), { status: 200 })
  }
  const fullConfig = { backend: 'oss', userId: USER, agentId: 'dsh', ...config }
  const client = new Mem0NativeClient({ config: fullConfig, loadSettings: () => settings, fetchImpl, warmUpOnStart: false })
  t.after(async () => {
    await client.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { client, calls, config: fullConfig }
}

test('search reports its step times; the lifecycle records them with inject and other', async (t) => {
  const { client, config } = setup(t, { embedDelayMs: 30 })
  await client.add([{ role: 'user', content: 'User drinks green tea' }], { infer: false })
  const direct = await client.search('tea', { user_id: USER })
  for (const key of ['openMs', 'credentialMs', 'embedMs', 'searchMs']) assert.ok(Number.isInteger(direct.timings[key]), key)
  assert.ok(direct.timings.embedMs >= 25)

  const activity = { recall: null, capture: null }
  const lifecycle = new MemoryLifecycle({
    client,
    config: { ...config, autoRecall: true, autoCapture: false, recallTopK: 5 },
    logger: { debug() {}, warn() {} },
    breaker: { isOpen: () => false, recordSuccess() {}, recordFailure() {} },
    activity,
  })
  t.after(() => lifecycle.dispose())
  const session = { id: 'timing-session', header: {}, deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'what tea do I drink' }], source: { kind: 'user' } }] }
  await lifecycle.onSystemPromptAssemble({ sections: [], contexts: [] }, { agent: { session } }, async () => ({ sections: [], contexts: [] }))
  const timings = activity.recall.timings
  assert.equal(activity.recall.status, 'ok')
  assert.ok(timings.embedMs >= 25)
  assert.ok(Number.isInteger(timings.injectMs))
  assert.equal(timings.totalMs, activity.recall.latencyMs)
  assert.equal(timings.totalMs, timings.openMs + timings.credentialMs + timings.embedMs + timings.searchMs + timings.injectMs + timings.otherMs)

  // mem0_status names the slow step.
  const tools = new Map(createMem0Tools(client, { ...config, native: { embedder: { provider: 'ollama' } }, embedderKeepAlive: '30m' }, { activity }).map((tool) => [tool.name, tool]))
  const status = await tools.get('mem0_status').execute({}, {})
  assert.match(status, /last recall: 1 results, \d+ ms \(store open \d+ ms · credential \d+ ms · embedding \d+ ms · search \d+ ms · inject \d+ ms · other \d+ ms\)/)
  assert.match(status, /embedder keep_alive: 30m/)
})

test('a recall that times out keeps the steps that finished and how long it ran', async (t) => {
  const { client, config } = setup(t, { embedDelayMs: 300 })
  const activity = { recall: null, capture: null }
  const lifecycle = new MemoryLifecycle({
    client,
    config: { ...config, autoRecall: true, autoCapture: false, recallTimeoutMs: 100 },
    logger: { debug() {}, warn() {} },
    breaker: { isOpen: () => false, recordSuccess() {}, recordFailure() {} },
    activity,
  })
  t.after(() => lifecycle.dispose())
  const session = { id: 'timing-session-2', header: {}, deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'anything' }], source: { kind: 'user' } }] }
  await lifecycle.onSystemPromptAssemble({ sections: [], contexts: [] }, { agent: { session } }, async () => ({ sections: [], contexts: [] }))
  assert.equal(activity.recall.status, 'error')
  assert.match(activity.recall.error, /timed out after/)
  assert.ok(activity.recall.timings.embedMs >= 90, 'the embedding step is the one that hung')
  assert.equal(activity.recall.timings.searchMs, undefined)
})

test('recallTimings and describeRecallTimings', () => {
  assert.equal(recallTimings({}, {}), undefined)
  assert.deepEqual(recallTimings({ credentialMs: 0, embedMs: 6990.4, searchMs: 12 }, { total: 7019, inject: 1 }), { credentialMs: 0, embedMs: 6990, searchMs: 12, injectMs: 1, totalMs: 7019, otherMs: 16 })
  assert.equal(describeRecallTimings({ embedMs: 6990, searchMs: 12, totalMs: 7019, otherMs: 17 }), '7019 ms (embedding 6990 ms · search 12 ms · other 17 ms)')
  assert.equal(describeRecallTimings(undefined), '')
})

test('Ollama embeddings carry keep_alive (default 30m, configurable, empty = Ollama default); others never', async (t) => {
  const ollama = setup(t)
  await ollama.client.search('tea', { user_id: USER })
  assert.equal(ollama.calls[0].body.keep_alive, DEFAULT_KEEP_ALIVE)
  assert.equal(DEFAULT_KEEP_ALIVE, '30m')
  const custom = setup(t, { config: { embedderKeepAlive: '-1' } })
  await custom.client.search('tea', { user_id: USER })
  assert.equal(custom.calls[0].body.keep_alive, -1)
  const unset = setup(t, { config: { embedderKeepAlive: '' } })
  await unset.client.search('tea', { user_id: USER })
  assert.equal('keep_alive' in unset.calls[0].body, false)
  const openai = setup(t, { provider: 'openai', baseUrl: 'http://127.0.0.1:8010/v1' })
  await openai.client.search('tea', { user_id: USER })
  assert.equal('keep_alive' in openai.calls[0].body, false)
  assert.equal(ollamaKeepAlive('300'), 300)
  assert.equal(ollamaKeepAlive('1h30m'), '1h30m')
  assert.equal(ollamaKeepAlive(''), undefined)
})

test('config: captureDedupThreshold and embedderKeepAlive are validated', () => {
  const file = path.join(os.tmpdir(), 'dsh-mem0-timing-missing-oss.json')
  const base = { backend: 'oss' }
  assert.equal(resolveConfig(base, { ossConfigPath: file }).captureDedupThreshold, 0.95)
  assert.equal(resolveConfig(base, { ossConfigPath: file }).embedderKeepAlive, '30m')
  assert.equal(resolveConfig({ ...base, captureDedupThreshold: 0 }, { ossConfigPath: file }).captureDedupThreshold, 0)
  assert.throws(() => resolveConfig({ ...base, captureDedupThreshold: 0.3 }, { ossConfigPath: file }), /captureDedupThreshold/)
  assert.equal(resolveConfig({ ...base, embedderKeepAlive: '2h' }, { ossConfigPath: file }).embedderKeepAlive, '2h')
  assert.equal(resolveConfig({ ...base, embedderKeepAlive: '' }, { ossConfigPath: file }).embedderKeepAlive, '')
  assert.throws(() => resolveConfig({ ...base, embedderKeepAlive: 'forever' }, { ossConfigPath: file }), /embedderKeepAlive/)
})

test('warm-up loads a local embedder once; a cloud embedder is never called', async (t) => {
  const local = setup(t)
  const result = await local.client.warmUp()
  assert.equal(result.warmed, true)
  assert.equal(local.calls.length, 1)
  assert.equal(local.client.status().lastWarmUp.ok, true)
  const cloud = setup(t, { provider: 'openai', baseUrl: 'https://api.openai.com/v1' })
  assert.deepEqual(await cloud.client.warmUp(), { warmed: false, reason: 'cloud' })
  assert.equal(cloud.calls.length, 0)
  for (const url of ['http://127.0.0.1:11434', 'http://localhost:1234/v1', 'http://[::1]:8010/v1']) assert.equal(isLocalUrl(url), true, url)
  for (const url of ['https://api.openai.com/v1', 'http://127.0.0.1.example.com/v1', 'http://192.168.1.5:11434']) assert.equal(isLocalUrl(url), false, url)
})

// The capture card's list (settings page IA, PR2): `activity.capture.preview`
// rows `{ id, memory, event, previous?, partition? }` and `pending` for
// Platform's asynchronous add. Real lifecycle with each backend's real
// client: the local one over a temporary SQLite file (embedder and LLM
// mocked), the REST one over a stubbed fetch (no network). Test user only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryLifecycle, toCapturePreview } from '../lib/memory-lifecycle.js'
import { Mem0NativeClient } from '../lib/native-client.js'
import { Mem0RestClient } from '../lib/rest-client.js'
import { GUI_ACTIVITY_PATH, GUI_STATUS_PATH, registerGuiRoutes } from '../lib/gui-routes.js'

const USER = 'dsh-mem0-capture-preview-test-user'
const AGENT = 'dsh-test'
// A fake key: must never reach the activity record or the status JSON.
const FAKE_KEY = 'sk-capturePreviewFAKE0123456789'
const session = { id: 'capture-preview-session', header: { origin: 'user' } }

function baseConfig(overrides = {}) {
  return { userId: USER, agentId: AGENT, autoRecall: false, autoCapture: true, captureMaxChars: 450, captureFilter: 'heuristic', ...overrides }
}

function engine(client, config, projects) {
  const activity = { recall: null, capture: null }
  const lifecycle = new MemoryLifecycle({
    client,
    config,
    logger: { debug() {}, warn() {} },
    breaker: { isOpen: () => false, recordSuccess() {}, recordFailure() {} },
    activity,
    projects,
  })
  return { lifecycle, activity }
}

function text(value) {
  return [{ type: 'text', text: value }]
}

async function turn(ctx, user, reply = '好的，祝顺利！') {
  ctx.lifecycle.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  ctx.lifecycle.onSessionEvent(session, { type: 'user/message', data: { role: 'user', content: text(user), source: { kind: 'user' } } })
  ctx.lifecycle.onSessionEvent(session, { type: 'assistant/message', data: { message: { role: 'assistant', content: text(reply) } } })
  ctx.lifecycle.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (['saved', 'extracting', 'error', 'skipped'].includes(ctx.activity.capture?.status)) break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return ctx.activity.capture
}

// --- local OSS backend ---------------------------------------------------

const VOCAB = ['上海', '北京', '出差', 'tea', '杭州']
function embed(value) {
  const lower = String(value).toLowerCase()
  return [...VOCAB.map((word) => (lower.includes(word) ? 1 : 0)), 0.01]
}

function ossSetup(t, facts, projects) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-capture-preview-'))
  const settings = {
    storePath: path.join(dir, 'memory.sqlite'),
    embedder: { provider: 'openai', baseUrl: 'http://127.0.0.1:18000/v1', model: 'test-embed', apiKeyRef: '', apiKey: '' },
    llm: { baseUrl: 'http://127.0.0.1:13425/v1', model: 'test-llm', apiKeyRef: '', apiKey: '', maxTokens: 8000, temperature: 0, topP: 0.1, reasoningEffort: '' },
    problems: [],
  }
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    if (url.endsWith('/embeddings')) {
      return new Response(JSON.stringify({ data: body.input.map((value, index) => ({ index, embedding: embed(value) })) }), { status: 200 })
    }
    const memory = facts.map((fact, index) => ({ id: String(index), text: fact, attributed_to: 'user' }))
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ memory }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 })
  }
  const config = baseConfig({ backend: 'oss' })
  const client = new Mem0NativeClient({ config, loadSettings: () => settings, fetchImpl, warmUpOnStart: false })
  const ctx = { client, ...engine(client, config, projects) }
  t.after(async () => {
    ctx.lifecycle.dispose()
    await client.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return ctx
}

test('local backend: the capture lists its ADD rows with the partition', async (t) => {
  const projects = { resolve: async () => ({ projectId: 'pabc123', name: 'demo', aliases: [] }) }
  const ctx = ossSetup(t, ['用户下周去上海出差', '用户喜欢 tea'], projects)
  const capture = await turn(ctx, '记住：我下周去上海出差，另外我喜欢 tea')
  assert.equal(capture.status, 'saved')
  assert.equal(capture.add, 2)
  assert.equal(capture.preview.length, 2)
  assert.deepEqual(capture.preview.map((row) => row.event), ['ADD', 'ADD'])
  assert.deepEqual(capture.preview.map((row) => row.memory).sort(), ['用户下周去上海出差', '用户喜欢 tea'].sort())
  assert.deepEqual(capture.preview.map((row) => row.id), capture.memoryIds)
  for (const row of capture.preview) {
    assert.equal(row.partition, 'project:pabc123')
    assert.equal('previous' in row, false)
  }
  assert.equal('pending' in capture, false)
})

test('local backend: a round whose facts were all duplicates has no preview, only the counts', async (t) => {
  const ctx = ossSetup(t, ['用户下周去上海出差'])
  await ctx.client.add([{ role: 'user', content: '用户下周去上海出差' }], { userId: USER, agentId: AGENT, infer: false })
  const capture = await turn(ctx, '记住：我下周去上海出差')
  assert.equal(capture.status, 'saved')
  assert.equal(capture.add, 0)
  assert.equal(capture.facts, 1)
  assert.equal('preview' in capture, false)
  assert.equal(capture.preview, undefined)
})

// --- self-hosted server and Platform (REST) ------------------------------

function stubFetch(t, answer) {
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined })
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  t.after(() => {
    globalThis.fetch = original
  })
  return seen
}

function restSetup(t, mode, answer) {
  const seen = stubFetch(t, answer)
  const config = baseConfig({ backend: mode })
  const client = new Mem0RestClient({ mode, baseUrl: 'http://mem0.invalid', apiKey: 'x', authType: 'none', userId: USER, agentId: AGENT })
  const ctx = { client, seen, ...engine(client, config) }
  t.after(() => ctx.lifecycle.dispose())
  return ctx
}

test('server backend: ADD, UPDATE with and without the old text, and DELETE', async (t) => {
  const ctx = restSetup(t, 'server', {
    results: [
      { id: 'a1', memory: '用户喜欢绿茶', event: 'ADD' },
      { id: 'u1', memory: '用户住在杭州', event: 'UPDATE', previous_memory: '用户住在上海' },
      { id: 'u2', memory: '用户每天早上跑步', event: 'UPDATE' },
      { id: 'd1', memory: '用户不喝咖啡', event: 'DELETE' },
      { id: 'n1', memory: 'unchanged', event: 'NONE' },
    ],
  })
  const capture = await turn(ctx, '记住：我搬到杭州了，喜欢绿茶')
  assert.equal(ctx.seen[0].url, 'http://mem0.invalid/memories')
  assert.equal(capture.status, 'saved')
  assert.deepEqual(capture.preview, [
    { id: 'a1', memory: '用户喜欢绿茶', event: 'ADD', partition: 'global' },
    { id: 'u1', memory: '用户住在杭州', event: 'UPDATE', previous: '用户住在上海' },
    { id: 'u2', memory: '用户每天早上跑步', event: 'UPDATE' },
    { id: 'd1', memory: '用户不喝咖啡', event: 'DELETE' },
  ])
  assert.equal(capture.add, 1)
  assert.equal(capture.update, 2)
  assert.equal(capture.delete, 1)
})

test('platform backend: an asynchronous add reports pending with its event id', async (t) => {
  const ctx = restSetup(t, 'platform', { status: 'PENDING', event_id: 'evt-123' })
  const capture = await turn(ctx, '记住：我下周去北京出差')
  assert.equal(ctx.seen[0].url, 'http://mem0.invalid/v3/memories/add/')
  assert.equal(capture.status, 'extracting')
  assert.deepEqual(capture.pending, { eventId: 'evt-123' })
  assert.equal(capture.eventId, 'evt-123')
  assert.equal('preview' in capture, false)
})

test('platform backend: a synchronous answer nests the text in data.memory', () => {
  assert.deepEqual(toCapturePreview([{ id: 'p1', event: 'ADD', data: { memory: 'Likes tea' } }], { scope: 'global' }), [
    { id: 'p1', memory: 'Likes tea', event: 'ADD', partition: 'global' },
  ])
})

test('more than 5 rows: the preview keeps the first 5, the counts keep all', async (t) => {
  const results = Array.from({ length: 8 }, (_, index) => ({ id: `m${index}`, memory: `fact ${index}`, event: 'ADD' }))
  const ctx = restSetup(t, 'server', { results })
  const capture = await turn(ctx, '记住这些事情：一二三四五六七八')
  assert.equal(capture.preview.length, 5)
  assert.deepEqual(capture.preview.map((row) => row.id), ['m0', 'm1', 'm2', 'm3', 'm4'])
  assert.equal(capture.add, 8)
  assert.equal(capture.memoryIds.length, 8)
})

test('a long memory is cut at 240 characters', () => {
  const [row] = toCapturePreview([{ id: 'x', memory: 'a'.repeat(500), event: 'UPDATE', previous_memory: 'b'.repeat(500) }])
  assert.equal(row.memory.length, 240)
  assert.equal(row.previous.length, 240)
})

// --- gui routes: sanitizing, translation, old format ---------------------

function harness(runtime) {
  const routes = new Map()
  registerGuiRoutes(
    {
      inject(names, register) {
        register({
          get: (name) => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
          webServer: { register: (route) => (routes.set(route.path, route.handler), () => {}) },
          effect: (fn) => fn(),
        })
      },
    },
    () => runtime,
  )
  return routes
}

async function get(handler, url) {
  const res = { statusCode: 200, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value }, end(body = '') { this.body = body } }
  await handler({ method: 'GET', url }, res)
  return JSON.parse(res.body)
}

const guiConfig = { backend: 'server', baseUrl: 'http://mem0.invalid', userId: USER, agentId: AGENT }
const guiClient = {
  async health() {
    return { ok: true, backend: 'server' }
  },
  async list() {
    return { results: [] }
  },
}

test('a key in a stored memory never reaches the activity record or the status JSON', async (t) => {
  const ctx = restSetup(t, 'server', {
    results: [
      { id: 'u1', memory: `api_key=${FAKE_KEY} is the new key`, event: 'UPDATE', previous_memory: `old key ${FAKE_KEY}` },
    ],
  })
  const capture = await turn(ctx, '记住：新的配置已经生效')
  assert.equal(JSON.stringify(ctx.activity).includes(FAKE_KEY), false)
  assert.match(capture.preview[0].memory, /\[REDACTED\]/)
  assert.match(capture.preview[0].previous, /\[REDACTED\]/)
  // Rows that bypassed the lifecycle are redacted by the routes too.
  const raw = {
    capture: {
      status: 'saved',
      preview: [{ id: 'r1', memory: `token ${FAKE_KEY}`, event: 'UPDATE', previous: `${FAKE_KEY} ${'x'.repeat(400)}`, partition: 'global', extra: FAKE_KEY }],
      pending: { eventId: FAKE_KEY, other: 'dropped' },
    },
    recall: null,
  }
  const routes = harness({ config: guiConfig, activity: raw, client: guiClient })
  for (const route of [GUI_STATUS_PATH, GUI_ACTIVITY_PATH]) {
    const body = await get(routes.get(route), '/?translate=0')
    assert.equal(JSON.stringify(body).includes(FAKE_KEY), false, route)
    const [row] = body.activity.capture.preview
    assert.deepEqual(Object.keys(row).sort(), ['event', 'id', 'memory', 'partition', 'previous'])
    assert.equal(row.previous.length, 240)
    assert.deepEqual(Object.keys(body.activity.capture.pending), ['eventId'])
  }
})

test('the routes drop rows with an unknown event and a malformed partition', async () => {
  const routes = harness({
    config: guiConfig,
    client: guiClient,
    activity: {
      capture: {
        status: 'saved',
        preview: [
          { id: 'a', memory: 'kept', event: 'ADD', partition: '../../etc' },
          { id: 'b', memory: 'dropped', event: 'NONE' },
          { id: 'c', memory: 'add has no previous', event: 'ADD', previous: 'nope' },
        ],
      },
    },
  })
  const body = await get(routes.get(GUI_ACTIVITY_PATH), '/?translate=0')
  assert.deepEqual(body.activity.capture.preview, [
    { id: 'a', memory: 'kept', event: 'ADD' },
    { id: 'c', memory: 'add has no previous', event: 'ADD' },
  ])
})

test('with translation on, capture memory and previous are translated with the recall rows', async () => {
  const calls = []
  const routes = harness({
    config: guiConfig,
    client: guiClient,
    localizer: {
      async translate(texts, lang) {
        calls.push(texts)
        return texts.map((value) => `[${lang}] ${value}`)
      },
    },
    activity: {
      recall: { status: 'ok', preview: [{ id: 'r1', memory: 'Likes tea' }] },
      capture: {
        status: 'saved',
        preview: [
          { id: 'u1', memory: 'Lives in Hangzhou', event: 'UPDATE', previous: 'Lives in Shanghai' },
          { id: 'a1', memory: 'Runs daily', event: 'ADD', partition: 'global' },
        ],
      },
    },
  })
  for (const route of [GUI_STATUS_PATH, GUI_ACTIVITY_PATH]) {
    const body = await get(routes.get(route), '/?lang=zh')
    assert.deepEqual(body.activity.recall.preview, [{ id: 'r1', memory: '[zh] Likes tea' }])
    assert.deepEqual(body.activity.capture.preview, [
      { id: 'u1', memory: '[zh] Lives in Hangzhou', event: 'UPDATE', previous: '[zh] Lives in Shanghai' },
      { id: 'a1', memory: '[zh] Runs daily', event: 'ADD', partition: 'global' },
    ])
  }
  assert.ok(calls.some((texts) => texts.includes('Lives in Shanghai')))
  // translate=0 leaves them as they are.
  const plain = await get(routes.get(GUI_ACTIVITY_PATH), '/?lang=zh&translate=0')
  assert.equal(plain.activity.capture.preview[0].memory, 'Lives in Hangzhou')
})

test('translation of capture rows alone, without a recall preview', async () => {
  const routes = harness({
    config: guiConfig,
    client: guiClient,
    localizer: { translate: async (texts) => texts.map((value) => `T:${value}`) },
    activity: { recall: null, capture: { status: 'saved', preview: [{ id: 'a1', memory: 'Runs daily', event: 'ADD' }] } },
  })
  const body = await get(routes.get(GUI_ACTIVITY_PATH), '/?lang=zh')
  assert.equal(body.activity.recall, null)
  assert.equal(body.activity.capture.preview[0].memory, 'T:Runs daily')
})

test('old format: a capture record without preview or pending is returned as before', async () => {
  const capture = { status: 'saved', at: '2026-11-23T00:00:00.000Z', messages: 2, count: 1, add: 1, memoryIds: ['m1'], scope: 'global' }
  const routes = harness({
    config: guiConfig,
    client: guiClient,
    localizer: { translate: async (texts) => texts.map((value) => `T:${value}`) },
    activity: { recall: null, capture: { ...capture } },
  })
  for (const url of ['/?translate=0', '/?lang=zh']) {
    const body = await get(routes.get(GUI_ACTIVITY_PATH), url)
    assert.deepEqual(body.activity.capture, capture)
  }
})

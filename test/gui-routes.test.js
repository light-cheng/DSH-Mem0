import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GUI_ACTIVITY_PATH,
  GUI_HYGIENE_PATH,
  GUI_MEMORIES_PATH,
  GUI_PROFILE_PATH,
  GUI_SETUP_PATH,
  GUI_STATUS_PATH,
  GUI_TEST_PATH,
  registerGuiRoutes,
} from '../lib/gui-routes.js'

function harness(runtime, { connection = { requestRejection: () => undefined } } = {}) {
  const routes = new Map()
  const ctx = {
    inject(names, register) {
      assert.deepEqual(names, ['webServer', 'connection'])
      register({
        get(name) {
          if (name === 'connection') return connection
          return undefined
        },
        webServer: {
          register(route) {
            routes.set(route.path, route.handler)
            return () => {}
          },
        },
        effect(fn) {
          fn()
        },
      })
    },
  }
  registerGuiRoutes(ctx, () => runtime)
  return routes
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(body = '') {
      this.body = body
    },
  }
}

async function invoke(handler, method, url = '/', body) {
  const res = response()
  const req = { method, url }
  if (body !== undefined) {
    req[Symbol.asyncIterator] = async function* () {
      yield Buffer.from(JSON.stringify(body))
    }
  }
  await handler(req, res)
  return {
    status: res.statusCode,
    headers: res.headers,
    body: res.body === '' ? undefined : JSON.parse(res.body),
  }
}

const config = {
  backend: 'oss',
  baseUrl: '',
  collectionName: 'dsh_mem0',
  userId: 'dsh-user',
  agentId: 'dsh',
  apiKey: 'must-not-leak',
}

test('status route reports healthy backend details without the API key', async () => {
  const routes = harness({
    config,
    activity: {
      capture: { status: 'saved', messages: 2, count: 1, memoryIds: ['m1'] },
      recall: { status: 'ok', count: 1, latencyMs: 12 },
    },
    client: {
      async health() {
        return {
          ok: true,
          backend: 'oss',
          mem0Reference: '2.2.1',
          store: { ok: true, kind: 'sqlite', path: '~/.dsh/mem0/memory.sqlite', schemaVersion: 1, sqliteVersion: '3.50.0' },
          qdrant: { ok: true },
          embedder: { ok: true, dimensions: 1024, model: 'bge-m3', provider: 'openai' },
          llm: { configured: true, model: 'deepseek-chat', error: null },
        }
      },
      async list() {
        return { results: [{ id: 'm1', memory: 'Likes tea', created_at: '2026-11-02T00:00:00Z' }] }
      },
    },
  })
  const result = await invoke(routes.get(GUI_STATUS_PATH), 'GET')
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.backend, 'oss')
  assert.equal(result.body.collection, '~/.dsh/mem0/memory.sqlite')
  assert.equal(result.body.store.kind, 'sqlite')
  assert.equal(result.body.store.ok, true)
  assert.equal(result.body.llm.model, 'deepseek-chat')
  assert.equal(result.body.embedder.model, 'bge-m3')
  assert.equal(result.body.apiKeyConfigured, true)
  assert.equal(result.body.backendSource, 'configured')
  assert.equal(result.body.backendChoice, 'configured explicitly')
  assert.equal(JSON.stringify(result.body).includes('must-not-leak'), false)
  assert.equal(result.body.mem0Reference, '2.2.1')
  assert.equal('pythonVersion' in result.body, false)
  assert.equal(result.body.activity.capture.status, 'saved')
  assert.equal(result.body.activity.recall.count, 1)
  assert.equal(result.body.recentMemories[0].id, 'm1')
  assert.equal(result.body.recentMemories[0].memory, 'Likes tea')
  assert.equal(JSON.stringify(result.body).includes('must-not-leak'), false)
})

test('status route localizes the profile and recent memories', async () => {
  const routes = harness({
    config,
    localizer: {
      async translate(texts, lang) {
        return texts.map((text) => `[${lang}] ${text}`)
      },
    },
    maintenance: {
      profileBlock() {
        return '- Likes tea'
      },
      status() {
        return { profile: { enabled: true, items: 1, tokens: 8 } }
      },
    },
    client: {
      async health() {
        return { ok: true }
      },
      async list() {
        return { results: [{ id: 'm1', memory: 'Likes tea' }] }
      },
    },
  })
  const result = await invoke(routes.get(GUI_STATUS_PATH), 'GET', '/?lang=zh-CN')
  assert.equal(result.status, 200)
  assert.equal(result.body.profileText, '[zh] - Likes tea')
  assert.equal(result.body.recentMemories[0].memory, '[zh] Likes tea')
})

test('status route skips translation for the fast initial render', async () => {
  let calls = 0
  const routes = harness({
    config,
    localizer: {
      async translate(texts) {
        calls += 1
        return texts.map((text) => `[zh] ${text}`)
      },
    },
    maintenance: {
      profileBlock() {
        return '- Likes tea'
      },
      status() {
        return { profile: { enabled: true, items: 1, tokens: 8 } }
      },
    },
    activity: {
      recall: { status: 'ok', count: 1, preview: [{ id: 'm1', memory: 'Likes tea' }] },
    },
    client: {
      async health() {
        return { ok: true }
      },
      async list() {
        return { results: [{ id: 'm1', memory: 'Likes tea' }] }
      },
    },
  })
  const result = await invoke(routes.get(GUI_STATUS_PATH), 'GET', '/?lang=zh&translate=0')
  assert.equal(result.status, 200)
  assert.equal(calls, 0)
  assert.equal(result.body.profileText, '- Likes tea')
  assert.equal(result.body.activity.recall.preview[0].memory, 'Likes tea')
  assert.equal(result.body.recentMemories[0].memory, 'Likes tea')
})

test('status route exposes the compact profile for the overview card', async () => {
  const routes = harness({
    config,
    maintenance: {
      profileBlock() {
        return '- Likes tea\n- Uses Node 22'
      },
      status() {
        return {
          profile: { enabled: true, items: 2, tokens: 18, updatedAt: '2026-11-02T00:00:00Z' },
        }
      },
    },
    client: {
      async health() {
        return { ok: true }
      },
      async list() {
        return { results: [] }
      },
    },
  })
  const result = await invoke(routes.get(GUI_STATUS_PATH), 'GET')
  assert.equal(result.status, 200)
  assert.equal(result.body.profileText, '- Likes tea\n- Uses Node 22')
  assert.equal(result.body.maintenance.profile.items, 2)
})

test('status route passes the last hygiene report through to the UI', async () => {
  const report = {
    reason: 'startup',
    finishedAt: '2026-11-02T00:05:39.822Z',
    scanned: 14,
    duplicates: 0,
    pruned: 0,
    deleted: 0,
    failed: 0,
  }
  const routes = harness({
    config,
    maintenance: {
      profileBlock() {
        return ''
      },
      status() {
        return { lastRunAt: report.finishedAt, lastReport: report }
      },
    },
    client: {
      async health() {
        return { ok: true }
      },
      async list() {
        return { results: [] }
      },
    },
  })
  const result = await invoke(routes.get(GUI_STATUS_PATH), 'GET')
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.maintenance.lastReport, report)
})

test('status route turns backend failures into a safe error payload', async () => {
  const routes = harness({
    config,
    client: {
      async health() {
        throw new Error('connection refused')
      },
    },
  })
  const result = await invoke(routes.get(GUI_STATUS_PATH), 'GET')
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, false)
  assert.match(result.body.error, /connection refused/)
})

test('test route accepts POST and rejects other methods', async () => {
  const routes = harness({ config, client: { async health() { return { ok: true } } } })
  const ok = await invoke(routes.get(GUI_TEST_PATH), 'POST')
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  const rejected = await invoke(routes.get(GUI_TEST_PATH), 'GET')
  assert.equal(rejected.status, 405)
  assert.equal(rejected.headers.allow, 'POST')
})


test('activity route returns the in-process activity without backend I/O', async () => {
  const activity = {
    capture: { status: 'saved', messages: 2, count: 1 },
    recall: { status: 'ok', count: 3, latencyMs: 20 },
  }
  const routes = harness({ config, activity, client: {} })
  const result = await invoke(routes.get(GUI_ACTIVITY_PATH), 'GET')
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.activity.capture.status, 'saved')
  assert.equal(result.body.activity.recall.count, 3)
  assert.equal(result.body.backend, 'oss')
})


test('activity route can skip translation for the dock poller', async () => {
  let calls = 0
  const routes = harness({
    config,
    localizer: {
      async translate(texts) {
        calls += 1
        return texts.map((text) => `[zh] ${text}`)
      },
    },
    activity: {
      recall: { status: 'ok', count: 1, preview: [{ id: 'm1', memory: 'Likes tea' }] },
    },
    client: {},
  })
  const result = await invoke(routes.get(GUI_ACTIVITY_PATH), 'GET', '/?lang=zh&translate=0')
  assert.equal(result.status, 200)
  assert.equal(calls, 0)
  assert.equal(result.body.activity.recall.preview[0].memory, 'Likes tea')
})

test('hygiene route previews a plan and confirms only with its planId and an idempotency key', async () => {
  const calls = []
  const maintenance = {
    async run(reason, options = {}) {
      calls.push(['run', reason, options.dryRun])
      return { dryRun: true, scanned: 3, duplicates: 1, pruned: 0, deleted: 0, planned: 1, failed: 0, planId: 'p1' }
    },
    async runPlan(request) {
      calls.push(['plan', request.planId, request.idempotencyKey])
      if (!request.planId || !request.idempotencyKey) {
        throw Object.assign(new Error('needs plan'), { code: 'plan-required' })
      }
      if (request.planId !== 'p1') throw Object.assign(new Error('unknown'), { code: 'plan-unknown' })
      return { scanned: 3, duplicates: 1, pruned: 0, deleted: 1, failed: 0, planId: 'p1' }
    },
    status() {
      return { enabled: true, running: false, profile: { items: 2, tokens: 20 } }
    },
  }
  const routes = harness({ config, client: {}, maintenance })
  // No body, or no planId: never a fresh, unconfirmed deletion pass.
  const bare = await invoke(routes.get(GUI_HYGIENE_PATH), 'POST')
  assert.equal(bare.status, 409)
  assert.equal(bare.body.ok, false)
  assert.equal(bare.body.reason, 'plan-required')
  const preview = await invoke(routes.get(GUI_HYGIENE_PATH), 'POST', '/', { dryRun: true })
  assert.equal(preview.body.ok, true)
  assert.equal(preview.body.report.dryRun, true)
  assert.equal(preview.body.report.planId, 'p1')
  const confirmed = await invoke(routes.get(GUI_HYGIENE_PATH), 'POST', '/', { dryRun: false, planId: 'p1', idempotencyKey: 'k1' })
  assert.equal(confirmed.body.ok, true)
  assert.equal(confirmed.body.report.deleted, 1)
  assert.equal(confirmed.body.maintenance.profile.items, 2)
  const unknown = await invoke(routes.get(GUI_HYGIENE_PATH), 'POST', '/', { dryRun: false, planId: 'zz', idempotencyKey: 'k2' })
  assert.equal(unknown.status, 409)
  assert.equal(unknown.body.reason, 'plan-unknown')
  assert.deepEqual(calls, [
    ['plan', undefined, undefined],
    ['run', 'manual', true],
    ['plan', 'p1', 'k1'],
    ['plan', 'zz', 'k2'],
  ])
  const rejected = await invoke(routes.get(GUI_HYGIENE_PATH), 'GET')
  assert.equal(rejected.status, 405)
  assert.equal(rejected.headers.allow, 'POST')
})

test('memories route lists, filters and sanitizes the memory library', async () => {
  const routes = harness({
    config,
    activity: {
      recall: {
        status: 'ok',
        count: 1,
        preview: [{ id: 'm1', memory: 'Likes tea' }],
      },
    },
    client: {
      async list(filter, options) {
        assert.equal(filter.user_id, 'dsh-user')
        assert.equal(options.topK, 1000)
        return {
          results: [
            { id: 'm1', memory: 'Likes tea', created_at: '2026-11-02T00:00:00Z', score: 0.9 },
            { id: 'm2', memory: 'Works on DSH plugins', created_at: '2026-11-01T00:00:00Z' },
          ],
        }
      },
    },
    localizer: {
      async translate(texts) {
        return texts.map((text) => (text === 'Likes tea' ? '喜欢茶' : text))
      },
    },
  })
  const all = await invoke(routes.get(GUI_MEMORIES_PATH), 'GET', `${GUI_MEMORIES_PATH}?limit=500`)
  assert.equal(all.status, 200)
  assert.equal(all.body.ok, true)
  assert.equal(all.body.total, 2)
  assert.equal(all.body.memories.length, 2)
  const filtered = await invoke(routes.get(GUI_MEMORIES_PATH), 'GET', `${GUI_MEMORIES_PATH}?q=tea&lang=zh`)
  assert.equal(filtered.body.total, 1)
  assert.equal(filtered.body.memories[0].id, 'm1')
  assert.equal(filtered.body.memories[0].memory, '喜欢茶')
  const translatedQuery = await invoke(routes.get(GUI_MEMORIES_PATH), 'GET', `${GUI_MEMORIES_PATH}?q=%E8%8C%B6&lang=zh`)
  assert.equal(translatedQuery.body.total, 1)
  assert.equal(translatedQuery.body.memories[0].id, 'm1')
  const activity = await invoke(routes.get(GUI_ACTIVITY_PATH), 'GET')
  assert.deepEqual(activity.body.activity.recall.preview, [{ id: 'm1', memory: 'Likes tea' }])
  const rejected = await invoke(routes.get(GUI_MEMORIES_PATH), 'POST')
  assert.equal(rejected.status, 405)
  assert.equal(rejected.headers.allow, 'GET, DELETE')
})

test('profile route saves and resets editable long-term memory', async () => {
  let text = '- Likes tea'
  const maintenance = {
    profileBlock: () => text,
    setProfileText(value) {
      text = String(value)
      return { profile: { items: 1, tokens: 12, manual: true } }
    },
    async resetProfile() {
      text = '- Rebuilt from memories'
      return { profile: { items: 1, tokens: 20, manual: false } }
    },
    status() {
      return { profile: { items: 1, tokens: 12, manual: true } }
    },
  }
  const routes = harness({ config, maintenance })
  const saved = await invoke(routes.get(GUI_PROFILE_PATH), 'POST', GUI_PROFILE_PATH, {
    text: '- Likes coffee',
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.ok, true)
  assert.equal(saved.body.profileText, '- Likes coffee')
  assert.equal(saved.body.maintenance.profile.manual, true)
  const reset = await invoke(routes.get(GUI_PROFILE_PATH), 'POST', GUI_PROFILE_PATH, { reset: true })
  assert.equal(reset.body.profileText, '- Rebuilt from memories')
  assert.equal(reset.body.maintenance.profile.manual, false)
  const rejected = await invoke(routes.get(GUI_PROFILE_PATH), 'GET')
  assert.equal(rejected.status, 405)
  assert.equal(rejected.headers.allow, 'POST')
})

// ---- Local store status ----

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('activity route reports the local store and its last failure (home shortened, redacted)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), 'dsh-mem0-route-store-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const status = {
    running: false,
    store: { kind: 'sqlite', path: path.join(dir, 'memory.sqlite') },
    lastStartFailure: { at: '2026-11-06T06:03:31.989Z', code: 'readonly', component: 'vector_store', reason: `cannot write ${path.join(dir, 'memory.sqlite')} api_key=sk-handwritten12345` },
  }
  const routes = harness({ config, activity: {}, client: { status: () => status } })
  const result = await invoke(routes.get(GUI_ACTIVITY_PATH), 'GET', '/?translate=0')
  assert.equal(result.body.store.running, false)
  assert.equal(result.body.store.kind, 'sqlite')
  assert.equal(result.body.store.path, ['~', path.basename(dir), 'memory.sqlite'].join(path.sep))
  assert.equal(result.body.store.lastStartFailure.code, 'readonly')
  assert.equal(result.body.store.lastStartFailure.reason.includes('sk-handwritten12345'), false)
  assert.equal('sidecar' in result.body, false)
  // REST backends have no local store.
  const rest = harness({ config: { ...config, backend: 'platform' }, activity: {}, client: {} })
  assert.equal((await invoke(rest.get(GUI_ACTIVITY_PATH), 'GET', '/?translate=0')).body.store, null)
})

test('setup route: refused without a trust fence (503), and for a POST that is not JSON', async () => {
  const fenceless = harness({ config: { backend: 'platform' } }, { connection: {} })
  const refused = await invoke(fenceless.get(GUI_SETUP_PATH), 'GET', GUI_SETUP_PATH)
  assert.equal(refused.status, 503)
  const routes = harness({ config: { backend: 'platform' } })
  const res = response()
  const req = { method: 'POST', url: GUI_SETUP_PATH, headers: { host: '127.0.0.1:4096', 'content-type': 'text/plain' } }
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from('{"action":"probe"}')
  }
  await routes.get(GUI_SETUP_PATH)(req, res)
  assert.equal(res.statusCode, 415)
})

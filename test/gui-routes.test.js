import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GUI_ACTIVITY_PATH,
  GUI_HYGIENE_PATH,
  GUI_MEMORIES_PATH,
  GUI_STATUS_PATH,
  GUI_TEST_PATH,
  registerGuiRoutes,
} from '../lib/gui-routes.js'

function harness(runtime) {
  const routes = new Map()
  const ctx = {
    inject(names, register) {
      assert.deepEqual(names, ['webServer', 'connection'])
      register({
        get(name) {
          if (name === 'connection') return { requestRejection: () => undefined }
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

async function invoke(handler, method, url = '/') {
  const res = response()
  await handler({ method, url }, res)
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
          pythonVersion: '3.11.16',
          mem0Version: '2.0.10',
          qdrant: { ok: true },
          embedder: { ok: true, dimensions: 1024 },
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
  assert.equal(result.body.collection, 'dsh_mem0')
  assert.equal(result.body.apiKeyConfigured, true)
  assert.equal(result.body.pythonVersion, '3.11.16')
  assert.equal(result.body.activity.capture.status, 'saved')
  assert.equal(result.body.activity.recall.count, 1)
  assert.equal(result.body.recentMemories[0].id, 'm1')
  assert.equal(result.body.recentMemories[0].memory, 'Likes tea')
  assert.equal(JSON.stringify(result.body).includes('must-not-leak'), false)
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


test('hygiene route runs maintenance and returns its status', async () => {
  const calls = []
  const maintenance = {
    async run(reason) {
      calls.push(reason)
      return { scanned: 3, duplicates: 1, pruned: 0, deleted: 1, failed: 0 }
    },
    status() {
      return { enabled: true, running: false, profile: { items: 2, tokens: 20 } }
    },
  }
  const routes = harness({ config, client: {}, maintenance })
  const result = await invoke(routes.get(GUI_HYGIENE_PATH), 'POST')
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.report.deleted, 1)
  assert.equal(result.body.maintenance.profile.items, 2)
  assert.deepEqual(calls, ['manual'])
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
  })
  const all = await invoke(routes.get(GUI_MEMORIES_PATH), 'GET', `${GUI_MEMORIES_PATH}?limit=500`)
  assert.equal(all.status, 200)
  assert.equal(all.body.ok, true)
  assert.equal(all.body.total, 2)
  assert.equal(all.body.memories.length, 2)
  const filtered = await invoke(routes.get(GUI_MEMORIES_PATH), 'GET', `${GUI_MEMORIES_PATH}?q=tea`)
  assert.equal(filtered.body.total, 1)
  assert.equal(filtered.body.memories[0].id, 'm1')
  const activity = await invoke(routes.get(GUI_ACTIVITY_PATH), 'GET')
  assert.deepEqual(activity.body.activity.recall.preview, [{ id: 'm1', memory: 'Likes tea' }])
  const rejected = await invoke(routes.get(GUI_MEMORIES_PATH), 'POST')
  assert.equal(rejected.status, 405)
  assert.equal(rejected.headers.allow, 'GET')
})

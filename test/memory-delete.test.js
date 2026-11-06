// Deleting one memory from the settings page's memory library: the GUI
// route against the mock Mem0 server (real REST client), driven through the
// page's own delete flow from client.js.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { spawn } from 'node:child_process'
import { GUI_MEMORIES_PATH, registerGuiRoutes, deleteOneMemory } from '../lib/gui-routes.js'
import { Mem0RestClient } from '../lib/rest-client.js'
import { localServerTest } from './fixtures/local-listen.js'

const USER = 'dsh-mem0-delete-test-user'

function loadClientTest() {
  let registered
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window })
  const react = { createElement: () => null, useCallback: (fn) => fn, useEffect() {}, useLayoutEffect() {}, useMemo: (fn) => fn(), useRef: () => ({}), useState: (v) => [v, () => {}] }
  return registered.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require ${name}`)
  }).__test__
}

function routesFor(runtime) {
  const routes = new Map()
  registerGuiRoutes({
    inject(_names, register) {
      register({
        get: (name) => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
        webServer: { register: (route) => (routes.set(route.path, route.handler), () => {}) },
        effect: (fn) => fn(),
      })
    },
  }, () => runtime)
  return routes.get(GUI_MEMORIES_PATH)
}

async function call(handler, method, url) {
  let body = ''
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(b = '') { body = b } }
  await handler({ method, url }, res)
  return { status: res.statusCode, headers: res.headers, body: body ? JSON.parse(body) : undefined }
}

/** fetchJson stand-in for the page: same paths, served by the route handler. */
function pageRequest(handler, calls) {
  return async (path, options = {}) => {
    const method = options.method ?? 'GET'
    calls.push(`${method} ${path}`)
    const result = await call(handler, method, `/${path}`)
    if (result.status >= 400) {
      const error = new Error(result.body?.error ?? `HTTP ${result.status}`)
      error.status = result.status
      error.reason = result.body?.reason
      throw error
    }
    return result.body
  }
}

async function startMock() {
  const script = new URL('../scripts/mock-mem0-server.mjs', import.meta.url)
  const child = spawn(process.execPath, [script.pathname], {
    env: { ...process.env, MOCK_MEM0_PORT: '0', MOCK_MEM0_KEY: '', MOCK_MEM0_USER: USER },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const port = await new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
      const match = out.match(/127\.0\.0\.1:(\d+)/)
      if (match) resolve(Number(match[1]))
    })
    child.once('exit', (code) => reject(new Error(`mock exited ${code}`)))
  })
  const baseUrl = `http://127.0.0.1:${port}`
  const post = (path, value) =>
    fetch(`${baseUrl}${path}`, { method: 'POST', body: JSON.stringify(value) }).then((r) => r.json())
  const ids = async () => {
    const response = await fetch(`${baseUrl}/memories?user_id=${USER}`)
    return (await response.json()).results.map((memory) => memory.id)
  }
  const all = async () => {
    const response = await fetch(`${baseUrl}/memories`)
    return (await response.json()).results.map((memory) => memory.id)
  }
  return { baseUrl, post, ids, all, stop: () => child.kill() }
}

async function setup() {
  const mock = await startMock()
  const own = await mock.post('/__seed', { id: 'own-1', memory: 'Likes oolong tea (written by dsh)', metadata: { source: 'dsh' } })
  const foreign = await mock.post('/__seed', { id: 'foreign-1', memory: 'Written by another app', metadata: { source: 'other-app' } })
  const untagged = await mock.post('/__seed', { id: 'untagged-1', memory: 'No metadata at all' })
  const otherUser = await mock.post('/__seed', { id: 'other-user-1', memory: 'Someone else', user_id: 'someone-else', metadata: { source: 'dsh' } })
  const forgotten = []
  const runtime = {
    config: { backend: 'server', userId: USER, collectionName: 'dsh_mem0' },
    client: new Mem0RestClient({ mode: 'server', baseUrl: mock.baseUrl, authType: 'none', userId: USER, agentId: 'dsh', timeoutMs: 5_000 }),
    localizer: { async translate(texts) { return texts }, async forget(texts) { forgotten.push(...texts) } },
  }
  return { mock, runtime, forgotten, handler: routesFor(runtime), ids: { own: own.id, foreign: foreign.id, untagged: untagged.id, otherUser: otherUser.id } }
}

localServerTest('library lists which memories may be deleted (source dsh only)', async () => {
  const { mock, handler, ids } = await setup()
  try {
    const list = await call(handler, 'GET', `${GUI_MEMORIES_PATH}?limit=500`)
    const byId = Object.fromEntries(list.body.memories.map((memory) => [memory.id, memory]))
    assert.equal(byId[ids.own].deletable, true)
    assert.equal(byId[ids.own].source, 'dsh')
    assert.equal(byId[ids.foreign].deletable, false)
    assert.equal(byId[ids.foreign].source, 'other-app')
    assert.equal(byId[ids.untagged].deletable, false)
    assert.equal(byId[ids.otherUser], undefined, 'other users are not listed')
  } finally {
    mock.stop()
  }
})

localServerTest('an owned dsh memory is deleted, its translation forgotten, and the list refreshed', async () => {
  const { mock, handler, ids, forgotten } = await setup()
  try {
    const { deleteMemoryFlow, zh } = loadClientTest()
    const t = (key) => zh[key] ?? key
    const calls = []
    const prompts = []
    let reloaded = null
    const result = await deleteMemoryFlow({
      t,
      id: ids.own,
      request: pageRequest(handler, calls),
      confirm: (text) => (prompts.push(text), true),
      reload: async () => {
        reloaded = await call(handler, 'GET', `${GUI_MEMORIES_PATH}?limit=500`)
      },
    })
    assert.equal(result.outcome, 'deleted')
    assert.equal(result.message, '已删除')
    // The confirmation shows the full text and the id.
    assert.equal(prompts.length, 1)
    assert.match(prompts[0], /own-1/)
    assert.match(prompts[0], /Likes oolong tea \(written by dsh\)/)
    assert.deepEqual(calls, [`GET dsh-mem0/gui/memories?id=${ids.own}`, `DELETE dsh-mem0/gui/memories?id=${ids.own}`])
    assert.equal((await mock.ids()).includes(ids.own), false)
    assert.deepEqual(forgotten, ['Likes oolong tea (written by dsh)'])
    // Reloaded list no longer has it; the others are untouched.
    assert.equal(reloaded.body.memories.some((memory) => memory.id === ids.own), false)
    assert.equal(reloaded.body.memories.some((memory) => memory.id === ids.foreign), true)
  } finally {
    mock.stop()
  }
})

localServerTest('nothing is deleted when the confirmation is declined', async () => {
  const { mock, handler, ids } = await setup()
  try {
    const { deleteMemoryFlow, en } = loadClientTest()
    const calls = []
    let reloads = 0
    const result = await deleteMemoryFlow({
      t: (key) => en[key] ?? key,
      id: ids.own,
      request: pageRequest(handler, calls),
      confirm: () => false,
      reload: async () => { reloads += 1 },
    })
    assert.equal(result.outcome, 'cancelled')
    assert.deepEqual(calls, [`GET dsh-mem0/gui/memories?id=${ids.own}`])
    assert.equal(reloads, 0)
    assert.equal((await mock.ids()).includes(ids.own), true)
  } finally {
    mock.stop()
  }
})

localServerTest('another app\'s memory is refused with 403 and a reason, before and at delete', async () => {
  const { mock, handler, ids, runtime } = await setup()
  try {
    for (const id of [ids.foreign, ids.untagged]) {
      const direct = await call(handler, 'DELETE', `${GUI_MEMORIES_PATH}?id=${id}`)
      assert.equal(direct.status, 403)
      assert.equal(direct.body.ok, false)
      assert.equal(direct.body.reason, 'foreign-source')
      assert.match(direct.body.error, /metadata\.source = "dsh"/)
    }
    const { deleteMemoryFlow, zh } = loadClientTest()
    let asked = false
    const result = await deleteMemoryFlow({
      t: (key) => zh[key] ?? key,
      id: ids.foreign,
      request: pageRequest(handler, []),
      confirm: () => (asked = true),
    })
    assert.equal(result.outcome, 'error')
    assert.equal(asked, false, 'no confirmation for a memory that cannot be deleted')
    assert.match(result.message, /删除记忆失败：?.*其他应用写入/)
    const still = await mock.all()
    assert.ok(still.includes(ids.foreign) && still.includes(ids.untagged))
    // The exported helper applies the same rule.
    assert.equal((await deleteOneMemory(runtime, ids.foreign)).status, 403)
  } finally {
    mock.stop()
  }
})

localServerTest('a memory of another user id is refused with 403', async () => {
  const { mock, handler, ids } = await setup()
  try {
    const result = await call(handler, 'DELETE', `${GUI_MEMORIES_PATH}?id=${ids.otherUser}`)
    assert.equal(result.status, 403)
    assert.equal(result.body.reason, 'other-user')
    assert.equal((await mock.all()).includes(ids.otherUser), true)
  } finally {
    mock.stop()
  }
})

localServerTest('unknown id is 404, missing id is 400, and there is no bulk form', async () => {
  const { mock, handler } = await setup()
  try {
    const before = (await mock.all()).length
    assert.equal((await call(handler, 'DELETE', `${GUI_MEMORIES_PATH}?id=nope`)).status, 404)
    const bare = await call(handler, 'DELETE', GUI_MEMORIES_PATH)
    assert.equal(bare.status, 400)
    assert.equal(bare.body.reason, 'missing-id')
    assert.equal((await call(handler, 'DELETE', `${GUI_MEMORIES_PATH}?q=tea`)).status, 400)
    assert.equal((await mock.all()).length, before)
  } finally {
    mock.stop()
  }
})

test('backend errors during delete are reported, not swallowed', async () => {
  const handler = routesFor({
    config: { userId: USER },
    client: {
      async get(id) { return { id, user_id: USER, memory: 'x', metadata: { source: 'dsh' } } },
      async remove() { throw new Error('POST failed: connection reset') },
    },
  })
  const result = await call(handler, 'DELETE', `${GUI_MEMORIES_PATH}?id=m1`)
  assert.equal(result.status, 502)
  assert.equal(result.body.ok, false)
  assert.match(result.body.error, /connection reset/)
})

test('delete is refused when Mem0 is disabled', async () => {
  const result = await call(routesFor({ config: { userId: USER } }), 'DELETE', `${GUI_MEMORIES_PATH}?id=m1`)
  assert.equal(result.status, 503)
  assert.equal(result.body.reason, 'disabled')
})

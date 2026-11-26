// GET gui/memories paging (PR3): offset, order and locate for the local
// backend (SQL pages), the Platform (page / page_size, semantic search) and
// a self-hosted server (one read cached 30 s). Fake clients, test user only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GUI_MEMORIES_PATH, LIBRARY_CACHE_MS, libraryPartitions, registerGuiRoutes } from '../lib/gui-routes.js'
import { SqliteStore } from '../lib/store-sqlite.js'
import { Mem0RestClient } from '../lib/rest-client.js'

const USER = 'dsh-mem0-paging-route-user'

function harness(runtime) {
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
  return async (method, url) => {
    const req = { method, url, headers: { host: '127.0.0.1' }, async *[Symbol.asyncIterator]() {} }
    const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v }, writeHead(s, h = {}) { this.statusCode = s; for (const [k, v] of Object.entries(h)) this.setHeader(k, v) }, end(b = '') { this.body = String(b) } }
    await routes.get(GUI_MEMORIES_PATH)(req, res)
    return JSON.parse(res.body)
  }
}

const at = (index) => new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString()
const memories = (count, extra = () => ({})) =>
  Array.from({ length: count }, (_, index) => ({ id: `m${String(index).padStart(4, '0')}`, memory: `Fact ${index}${index === 7 ? ' 100% tea' : ''}`, user_id: USER, created_at: at(index), metadata: { source: 'dsh' }, ...extra(index) }))

function localStore(t, count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-paging-route-'))
  const store = new SqliteStore({ filePath: path.join(dir, 'memory.sqlite') }).open()
  t.after(() => {
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  store.insert(memories(count, (index) => (index % 3 === 0 ? { scope: 'project', projectId: 'pA' } : index % 3 === 1 ? { scope: 'session', projectId: 'pA', sessionId: 's1' } : {})).map((item, index) => ({
    id: item.id, text: item.memory, hash: `h${index}`, vector: [1, 0, 0], payload: { user_id: USER, created_at: item.created_at, source: 'dsh' }, embedModel: 'e', scope: item.scope ?? null, projectId: item.projectId ?? null, sessionId: item.sessionId ?? null,
  })))
  // The native client's paging calls, straight to the store.
  return {
    listPage: async (filters, options) => store.listPage(filters, options),
    libraryIndexOf: async (id, filters, options) => store.libraryIndexOf(id, filters, options),
    list: async () => assert.fail('the local backend pages in SQL, it never lists everything'),
  }
}

test('libraryPartitions: tree:<project> and projects; the older keys unchanged', () => {
  assert.equal(libraryPartitions(''), undefined)
  assert.deepEqual(libraryPartitions('global'), [{ scope: 'global' }])
  assert.deepEqual(libraryPartitions('project:pA'), [{ scope: 'project', project_id: 'pA' }])
  assert.deepEqual(libraryPartitions('tree:pA'), [{ scope: 'project', project_id: 'pA' }, { scope: 'session', project_id: 'pA' }])
  assert.deepEqual(libraryPartitions('projects'), [{ scope: 'project', project_id: '*' }, { scope: 'session', project_id: '*' }])
  assert.deepEqual(libraryPartitions('tree:../x'), [])
})

test('local backend: offset, order, search and partition reach SQL; only the page is translated', async (t) => {
  const translated = []
  const get = harness({
    config: { backend: 'oss', userId: USER },
    client: localStore(t, 300),
    localizer: { translate: async (texts) => (translated.push(texts.length), texts.map((text) => `译:${text}`)) },
  })
  const first = await get('GET', `${GUI_MEMORIES_PATH}?offset=0&limit=20&lang=zh`)
  assert.equal(first.ok, true)
  assert.equal(first.mode, 'sql')
  assert.equal(first.total, 300)
  assert.equal(first.totalKnown, true)
  assert.equal(first.hasMore, true)
  assert.equal(first.memories.length, 20)
  assert.equal(first.memories[0].id, 'm0299')
  assert.equal(first.memories[0].memory, '译:Fact 299')
  assert.deepEqual(translated, [20], 'one page translated, not the library')
  const oldestPage3 = await get('GET', `${GUI_MEMORIES_PATH}?offset=40&limit=20&order=oldest`)
  assert.equal(oldestPage3.memories[0].id, 'm0040')
  assert.equal(oldestPage3.order, 'oldest')
  assert.equal(oldestPage3.offset, 40)
  const last = await get('GET', `${GUI_MEMORIES_PATH}?offset=280&limit=20`)
  assert.equal(last.memories.length, 20)
  assert.equal(last.hasMore, false)
  const searched = await get('GET', `${GUI_MEMORIES_PATH}?q=${encodeURIComponent('100%')}&limit=20`)
  assert.deepEqual(searched.memories.map((m) => m.id), ['m0007'])
  const tree = await get('GET', `${GUI_MEMORIES_PATH}?partition=tree:pA&limit=20`)
  assert.equal(tree.total, 200, 'the project and its sessions')
  assert.ok(tree.memories.every((m) => m.projectId === 'pA'))
  const global = await get('GET', `${GUI_MEMORIES_PATH}?partition=global&limit=20`)
  assert.equal(global.total, 100)
  // Locate: the page holding the memory, flagged.
  const located = await get('GET', `${GUI_MEMORIES_PATH}?locate=m0100&limit=20`)
  assert.equal(located.located, true)
  assert.equal(located.offset, 180)
  assert.ok(located.memories.some((m) => m.id === 'm0100'))
  const notThere = await get('GET', `${GUI_MEMORIES_PATH}?locate=nope&limit=20`)
  assert.equal(notThere.located, false)
  assert.equal(notThere.offset, 0)
  // Old callers: no offset, limit up to 500.
  const old = await get('GET', `${GUI_MEMORIES_PATH}?limit=500`)
  assert.equal(old.memories.length, 300)
  assert.equal(old.total, 300)
  // Bad values are clamped.
  const odd = await get('GET', `${GUI_MEMORIES_PATH}?offset=-3&limit=9999&order=sideways`)
  assert.equal(odd.offset, 0)
  assert.equal(odd.limit, 500)
  assert.equal(odd.order, 'newest')
})

test('self-hosted server: one read of 1,000 cached 30 s, searched and paged in memory; delete drops the copy', async () => {
  let reads = 0
  const all = memories(1000)
  const removed = new Set()
  const client = {
    async list(filters, options) {
      reads += 1
      assert.equal(filters.user_id, USER)
      assert.equal(options.topK, 1000)
      return { results: all.filter((m) => !removed.has(m.id)) }
    },
    async get(id) {
      return all.find((m) => m.id === id) ?? null
    },
    async remove(id) {
      removed.add(id)
      return { message: 'deleted' }
    },
  }
  const get = harness({ config: { backend: 'server', userId: USER }, client })
  const first = await get('GET', `${GUI_MEMORIES_PATH}?offset=0&limit=20`)
  assert.equal(first.mode, 'cached')
  assert.equal(first.capped, true)
  assert.equal(first.total, 1000)
  assert.equal(first.memories[0].id, 'm0999')
  const second = await get('GET', `${GUI_MEMORIES_PATH}?offset=20&limit=20&order=oldest`)
  assert.equal(second.memories[0].id, 'm0020')
  const searched = await get('GET', `${GUI_MEMORIES_PATH}?q=tea&limit=20`)
  assert.deepEqual(searched.memories.map((m) => m.id), ['m0007'])
  const located = await get('GET', `${GUI_MEMORIES_PATH}?locate=m0500&limit=20`)
  assert.equal(located.offset, 480)
  assert.equal(located.located, true)
  assert.equal(reads, 1, 'one read for all of these')
  assert.ok(LIBRARY_CACHE_MS === 30_000)
  await get('DELETE', `${GUI_MEMORIES_PATH}?id=m0999`)
  const after = await get('GET', `${GUI_MEMORIES_PATH}?offset=0&limit=20`)
  assert.equal(reads, 2, 'a delete reads the server again')
  assert.equal(after.memories[0].id, 'm0998')
})

function platformClient(t, pages) {
  const seen = []
  const client = new Mem0RestClient({ mode: 'platform', baseUrl: 'https://platform.invalid', apiKey: 'test-key-not-real', userId: USER })
  client.request = async (method, url, body) => {
    seen.push({ method, url, body })
    if (url.startsWith('/v3/memories/search/')) return { results: memories(5).map((m, i) => ({ ...m, score: 1 - i / 10 })) }
    if (url.startsWith('/v1/memories/')) return memories(30).find((m) => url.includes(m.id)) ?? null
    const page = Number(new URL(url, 'https://x').searchParams.get('page'))
    return pages(page)
  }
  return { client, seen }
}

test('Platform with count: page / page_size from offset, the total from count', async (t) => {
  const all = memories(45).reverse()
  const { client, seen } = platformClient(t, (page) => ({ count: 45, next: page < 3 ? 'n' : null, previous: null, results: all.slice((page - 1) * 20, page * 20) }))
  const get = harness({ config: { backend: 'platform', userId: USER }, client })
  const second = await get('GET', `${GUI_MEMORIES_PATH}?offset=20&limit=20`)
  assert.equal(second.mode, 'pages')
  assert.equal(second.total, 45)
  assert.equal(second.totalKnown, true)
  assert.equal(second.hasMore, true)
  assert.equal(second.offset, 20)
  assert.equal(second.memories[0].id, all[20].id)
  assert.equal(seen.at(-1).url, '/v3/memories/?page=2&page_size=20')
  assert.deepEqual(seen.at(-1).body.filters, { user_id: USER })
  const third = await get('GET', `${GUI_MEMORIES_PATH}?offset=40&limit=20`)
  assert.equal(third.memories.length, 5)
  assert.equal(third.hasMore, false)
})

test('Platform without count: next only, total unknown', async (t) => {
  const { client } = platformClient(t, (page) => ({ results: memories(20).map((m) => ({ ...m, id: `p${page}-${m.id}` })), next: page < 2 ? 'n' : null }))
  const get = harness({ config: { backend: 'platform', userId: USER }, client })
  const first = await get('GET', `${GUI_MEMORIES_PATH}?offset=0&limit=20`)
  assert.equal(first.totalKnown, false)
  assert.equal(first.total, null)
  assert.equal(first.hasMore, true)
  const second = await get('GET', `${GUI_MEMORIES_PATH}?offset=20&limit=20`)
  assert.equal(second.hasMore, false)
})

test('Platform search is semantic (by relevance); an id or locate reads that memory', async (t) => {
  const { client, seen } = platformClient(t, () => ({ count: 0, results: [] }))
  const get = harness({ config: { backend: 'platform', userId: USER }, client })
  const searched = await get('GET', `${GUI_MEMORIES_PATH}?q=tea&limit=20`)
  assert.equal(searched.mode, 'semantic')
  assert.equal(searched.total, 5)
  assert.equal(seen.at(-1).url, '/v3/memories/search/')
  assert.equal(seen.at(-1).body.top_k, 20)
  const located = await get('GET', `${GUI_MEMORIES_PATH}?locate=m0012&limit=20`)
  assert.equal(located.mode, 'id')
  assert.equal(located.located, true)
  assert.deepEqual(located.memories.map((m) => m.id), ['m0012'])
  const missing = await get('GET', `${GUI_MEMORIES_PATH}?locate=m9999&limit=20`)
  assert.equal(missing.located, false)
  assert.equal(missing.total, 0)
})

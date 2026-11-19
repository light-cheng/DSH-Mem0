// The one-time Qdrant → SQLite migration against a mocked Qdrant (fetchImpl,
// no network) and SQLite files in a temporary folder. Test users and test
// collections only; no real Qdrant is contacted.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  FORBIDDEN_COLLECTIONS,
  MigrationError,
  canCopyVectors,
  checkCollection,
  mapPoint,
  migrate,
  normalizeTimestamp,
  pointVector,
  preflight,
  qdrantUrl,
} from '../lib/qdrant-migration.js'
import { md5 } from '../lib/native-client.js'
import { MIGRATION_META_KEY, SqliteStore } from '../lib/store-sqlite.js'
import { MemoryMaintenance, scopeKey } from '../lib/memory-maintenance.js'
import { MaintenanceState } from '../lib/maintenance-state.js'

const USER = 'dsh-mem0-migration-test-user'
const OTHER = 'someone-else'
const COLLECTION = 'dsh_mem0_migration_test'
const DIMS = 8

function vec(seed) {
  const out = []
  for (let index = 0; index < DIMS; index += 1) out.push(Math.sin(seed * 7.3 + index * 1.1) + (index === seed % DIMS ? 2 : 0))
  return out
}

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / Math.sqrt(na * nb)
}

/** A Qdrant point the way mem0ai 2.x writes it. */
function point(index, { user = USER, text = `memory number ${index}`, created = '2026-05-01T10:00:00.123456+00:00', extra = {} } = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    vector: vec(index),
    payload: { data: text, hash: md5(text), created_at: created, updated_at: created, user_id: user, agent_id: 'dsh', text_lemmatized: text, source: 'dsh', ...extra },
  }
}

/** A mocked Qdrant: one collection, read-only routes; records every request. */
function mockQdrant(points, { name = COLLECTION, size = DIMS, down = false } = {}) {
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url)
    const body = init.body ? JSON.parse(init.body) : undefined
    requests.push({ method: init.method, path: parsed.pathname, body })
    if (down) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6333'), { code: 'ECONNREFUSED' }) })
    const json = (result, status = 200) => new Response(JSON.stringify(status === 200 ? { result, status: 'ok' } : { status: { error: result } }), { status })
    const base = `/collections/${name}`
    const userOf = (filter) => filter?.must?.[0]?.match?.value
    if (init.method === 'GET' && parsed.pathname === base) return json({ points_count: points.length, config: { params: { vectors: { size, distance: 'Cosine' } } } })
    if (parsed.pathname.startsWith('/collections/') && !parsed.pathname.startsWith(base)) return json('Not found: Collection', 404)
    const mine = points.filter((item) => item.payload.user_id === userOf(body?.filter))
    if (parsed.pathname === `${base}/points/count`) return json({ count: mine.length })
    if (parsed.pathname === `${base}/points/scroll`) {
      const start = body.offset ? Number(body.offset) : 0
      const page = mine.slice(start, start + body.limit)
      return json({ points: page, next_page_offset: start + body.limit < mine.length ? start + body.limit : null })
    }
    if (parsed.pathname === `${base}/points/search`) {
      const query = Array.isArray(body.vector) ? body.vector : body.vector.vector
      return json(mine.map((item) => ({ id: item.id, score: cosine(item.vector, query) })).sort((a, b) => b.score - a.score).slice(0, body.limit))
    }
    return json('unexpected', 500)
  }
  return { fetchImpl, requests }
}

/** Embedder mock: a deterministic vector per text. */
function embedderFetch(qdrant, { failAfter } = {}) {
  let calls = 0
  return async (url, init) => {
    if (String(url).endsWith('/embeddings')) {
      calls += 1
      if (failAfter && calls > failAfter) return new Response('{"error":"boom"}', { status: 500 })
      const body = JSON.parse(init.body)
      return new Response(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vec(text.length * 13 + text.charCodeAt(text.length - 1)) })) }), { status: 200 })
    }
    return qdrant.fetchImpl(url, init)
  }
}

const EMBEDDER = { provider: 'openai', baseUrl: 'http://127.0.0.1:18000/v1', model: 'test-embed', dims: undefined }

// Removed once every test in this file is done: per-test after hooks run in
// the order they were added, so a store closed in a later hook would still
// hold its file open on Windows when the directory is removed.
const tempDirs = []
after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }) })

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-migrate-'))
  tempDirs.push(dir)
  return dir
}

const RAW = { oss: { vector_store: { provider: 'qdrant', config: { url: 'http://127.0.0.1:6333', collection_name: COLLECTION } }, embedder: { provider: 'openai', config: { model: 'test-embed' } } } }

test('timestamps: offsets become UTC Python isoformat, naive ones stay and are flagged', () => {
  assert.deepEqual(normalizeTimestamp('2026-05-01T10:00:00.123456+00:00'), { value: '2026-05-01T10:00:00.123456+00:00', changed: false, naive: false })
  assert.deepEqual(normalizeTimestamp('2026-05-01T03:00:00.5-07:00'), { value: '2026-05-01T10:00:00.500000+00:00', changed: true, naive: false })
  assert.equal(normalizeTimestamp('2026-05-01T10:00:00Z').value, '2026-05-01T10:00:00.000000+00:00')
  assert.equal(normalizeTimestamp('2026-05-01T18:00:00.000001+0800').value, '2026-05-01T10:00:00.000001+00:00')
  assert.deepEqual(normalizeTimestamp('2026-05-01T10:00:00.123'), { value: '2026-05-01T10:00:00.123', changed: false, naive: true })
  assert.deepEqual(normalizeTimestamp('yesterday'), { value: 'yesterday', changed: false, naive: false })
  assert.equal(normalizeTimestamp(undefined).value, null)
})

test('a point maps to a record: md5 hash, metadata, original values kept', () => {
  const mapped = mapPoint(point(1, { created: '2026-05-01T03:00:00-07:00', extra: { hash: 'stale', nested: { a: [1] } } }))
  assert.equal(mapped.text, 'memory number 1')
  assert.equal(mapped.hash, md5('memory number 1'))
  assert.equal(mapped.payload.original_hash, 'stale')
  assert.equal(mapped.payload.created_at, '2026-05-01T10:00:00.000000+00:00')
  assert.equal(mapped.payload.original_created_at, '2026-05-01T03:00:00-07:00')
  assert.deepEqual(mapped.payload.nested, { a: [1] })
  assert.equal(mapped.payload.text_lemmatized, undefined)
  assert.equal(mapped.payload.data, undefined)
  assert.deepEqual(mapPoint({ id: 'x', payload: { data: '  ' } }), { skip: 'empty', id: 'x' })
  assert.equal(mapPoint(point(2, { created: '2026-05-01T10:00:00' })).payload.naive_timestamps, true)
})

test('collection guard: mem0 and odd names are refused, whatever the case', () => {
  assert.ok(FORBIDDEN_COLLECTIONS.includes('mem0'))
  for (const name of ['mem0', 'MEM0', ' mem0 ']) assert.throws(() => checkCollection(name), (error) => error.code === 'FORBIDDEN_COLLECTION')
  assert.throws(() => checkCollection('a/b'), MigrationError)
  assert.equal(checkCollection('dsh_mem0'), 'dsh_mem0')
})

test('Qdrant address: typed, then oss.json, then the platform default', () => {
  assert.equal(qdrantUrl('', { platform: 'linux' }), 'http://127.0.0.1:6333')
  assert.equal(qdrantUrl('', { platform: 'win32' }), 'http://127.0.0.1:15333')
  assert.equal(qdrantUrl('', { raw: RAW, platform: 'win32' }), 'http://127.0.0.1:6333')
  assert.equal(qdrantUrl('127.0.0.1:15333/dashboard', {}), 'http://127.0.0.1:15333')
  assert.throws(() => qdrantUrl('ftp://x', {}), MigrationError)
})

test('vectors: named and unnamed; copying only for the same model, dims and cosine', () => {
  assert.deepEqual(pointVector({ vector: [1, 2] }), [1, 2])
  assert.deepEqual(pointVector({ vector: { '': [3], bm25: { indices: [1], values: [1] } } }), [3])
  assert.deepEqual(pointVector({ vector: { dense: [4] } }, 'dense'), [4])
  assert.equal(canCopyVectors({ oldModel: 'bge-m3', oldDims: 1024, distance: 'Cosine', embedderModel: 'bge-m3', embedderDims: 1024 }), true)
  assert.equal(canCopyVectors({ oldModel: 'bge-m3', oldDims: 1024, embedderModel: 'bge-m3', embedderDims: 768 }), false)
  assert.equal(canCopyVectors({ oldModel: null, oldDims: 1024, embedderModel: 'bge-m3', embedderDims: 1024 }), false)
  assert.equal(canCopyVectors({ oldModel: 'a', oldDims: 8, distance: 'Dot', embedderModel: 'a', embedderDims: 8 }), false)
})

test('preflight counts only this user, never lists collections, refuses mem0 and embedded mode', async () => {
  const qdrant = mockQdrant([point(1), point(2), point(3, { user: OTHER })])
  const pre = await preflight({ collection: COLLECTION, userId: USER, raw: RAW, fetchImpl: qdrant.fetchImpl })
  assert.equal(pre.points, 2)
  assert.equal(pre.dims, DIMS)
  assert.equal(pre.oldModel, 'test-embed')
  assert.ok(qdrant.requests.every((request) => request.path.startsWith(`/collections/${COLLECTION}`)), 'only the one collection')
  await assert.rejects(preflight({ collection: 'mem0', userId: USER, raw: RAW, fetchImpl: qdrant.fetchImpl }), (error) => error.code === 'FORBIDDEN_COLLECTION')
  assert.ok(!qdrant.requests.some((request) => request.path.includes('/collections/mem0')), 'mem0 is never contacted')
  await assert.rejects(preflight({ userId: USER, raw: { oss: { vector_store: { provider: 'qdrant', config: { path: '/x' } } } }, fetchImpl: qdrant.fetchImpl }), (error) => error.code === 'QDRANT_EMBEDDED_UNSUPPORTED')
  const down = mockQdrant([], { down: true })
  await assert.rejects(preflight({ collection: COLLECTION, userId: USER, raw: RAW, fetchImpl: down.fetchImpl }), (error) => error.code === 'QDRANT_UNREACHABLE' && /10013/.test(error.message))
  await assert.rejects(preflight({ collection: 'dsh_mem0_absent', userId: USER, raw: RAW, fetchImpl: qdrant.fetchImpl }), (error) => error.code === 'COLLECTION_NOT_FOUND')
})

test('migrate into a new store: recomputed vectors, checks, marker, no .importing left', async (t) => {
  const dir = tempDir()
  const storePath = path.join(dir, 'memory.sqlite')
  const points = Array.from({ length: 300 }, (_, index) => point(index + 1))
  points.push(point(999, { user: OTHER }), { id: 'empty-1', vector: vec(1), payload: { data: '', user_id: USER } })
  const qdrant = mockQdrant(points)
  const progress = []
  const report = await migrate({ storePath, collection: COLLECTION, userId: USER, raw: RAW, embedder: EMBEDDER, dims: DIMS, fetchImpl: embedderFetch(qdrant), onProgress: (item) => progress.push(item.phase) })
  assert.equal(report.mode, 'created')
  assert.equal(report.vectors, 'recomputed')
  assert.equal(report.imported, 300)
  assert.equal(report.skippedEmpty, 1)
  assert.equal(report.checks.count.stored, 300)
  assert.ok(report.checks.hashes > 0 && report.checks.queries > 0)
  assert.ok(progress.includes('read') && progress.includes('embed'))
  assert.equal(fs.existsSync(`${storePath}.importing`), false)
  // Only reads, and every read filtered by this user.
  for (const request of qdrant.requests) {
    assert.ok(request.method === 'GET' || /\/points\/(scroll|count|search)$/.test(request.path), request.path)
    if (request.body) assert.equal(request.body.filter.must[0].match.value, USER)
  }
  const store = new SqliteStore({ filePath: storePath })
  t.after(() => store.close())
  assert.equal(store.count({ user_id: USER }), 300)
  assert.equal(store.count({ user_id: OTHER }), 0)
  assert.deepEqual(store.embedderInfo(), { model: 'test-embed', dims: DIMS })
  const marker = JSON.parse(store.getMeta(MIGRATION_META_KEY))
  assert.equal(marker.collection, COLLECTION)
  assert.equal(marker.imported, 300)
  const item = store.get(points[0].id)
  assert.equal(item.memory, 'memory number 1')
  assert.equal(item.metadata.source, 'dsh')
  assert.equal(item.created_at, '2026-05-01T10:00:00.123456+00:00')
  if (process.platform !== 'win32') assert.equal(fs.statSync(storePath).mode & 0o777, 0o600)
})

test('migrate with copied vectors compares top-5 with Qdrant', async (t) => {
  const dir = tempDir()
  const storePath = path.join(dir, 'memory.sqlite')
  const qdrant = mockQdrant(Array.from({ length: 40 }, (_, index) => point(index + 1)))
  let embedCalls = 0
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/embeddings')) embedCalls += 1
    return qdrant.fetchImpl(url, init)
  }
  const report = await migrate({ storePath, collection: COLLECTION, userId: USER, raw: RAW, embedder: EMBEDDER, dims: DIMS, copyVectors: true, fetchImpl })
  assert.equal(report.vectors, 'copied')
  assert.equal(embedCalls, 0, 'nothing re-embedded')
  assert.ok(qdrant.requests.some((request) => request.path.endsWith('/points/search')))
  const store = new SqliteStore({ filePath: storePath })
  t.after(() => store.close())
  const hit = store.searchVectors(vec(5), { user_id: USER }, 1)[0]
  assert.equal(hit.row.text, 'memory number 5')
  // copyVectors is ignored when the model differs.
  const other = path.join(dir, 'other.sqlite')
  const recomputed = await migrate({ storePath: other, collection: COLLECTION, userId: USER, raw: RAW, embedder: { ...EMBEDDER, model: 'another' }, dims: DIMS, copyVectors: true, fetchImpl: embedderFetch(qdrant) })
  assert.equal(recomputed.vectors, 'recomputed')
})

test('migrate into an existing store merges in one transaction, skips ids and duplicates, and is repeatable', async (t) => {
  const dir = tempDir()
  const storePath = path.join(dir, 'memory.sqlite')
  const store = new SqliteStore({ filePath: storePath })
  t.after(() => store.close())
  store.open()
  store.insert([{ id: 'already-here', text: 'memory number 2', hash: md5('memory number 2'), vector: vec(2), payload: { user_id: USER, agent_id: 'dsh' }, embedModel: 'test-embed' }])
  store.setEmbedderInfo({ model: 'test-embed', dims: DIMS })
  const qdrant = mockQdrant([point(1), point(2), point(3)])
  const report = await migrate({ storePath, collection: COLLECTION, userId: USER, raw: RAW, embedder: EMBEDDER, dims: DIMS, fetchImpl: embedderFetch(qdrant) })
  assert.equal(report.mode, 'merged')
  assert.equal(report.imported, 2)
  assert.equal(report.skippedExisting, 1)
  assert.equal(store.count({ user_id: USER }), 3, 'the open connection sees the merge (data_version)')
  const again = await migrate({ storePath, collection: COLLECTION, userId: USER, raw: RAW, embedder: EMBEDDER, dims: DIMS, fetchImpl: embedderFetch(qdrant) })
  assert.equal(again.imported, 0)
  assert.equal(store.count({}), 3)
  assert.equal(fs.existsSync(`${storePath}.importing`), false)
})

test('a store of another embedder refuses the merge and stays unchanged', async (t) => {
  const dir = tempDir()
  const storePath = path.join(dir, 'memory.sqlite')
  const store = new SqliteStore({ filePath: storePath })
  t.after(() => store.close())
  store.insert([{ id: 'x', text: 'kept', hash: md5('kept'), vector: [1, 0, 0], payload: { user_id: USER }, embedModel: 'old' }])
  store.setEmbedderInfo({ model: 'old', dims: 3 })
  const qdrant = mockQdrant([point(1)])
  await assert.rejects(
    migrate({ storePath, collection: COLLECTION, userId: USER, raw: RAW, embedder: EMBEDDER, dims: DIMS, fetchImpl: embedderFetch(qdrant) }),
    (error) => error.step === 'merge' && error.code === 'EMBEDDER_MISMATCH',
  )
  assert.equal(store.count({}), 1)
  assert.equal(fs.existsSync(`${storePath}.importing`), false)
})

test('a failure while embedding leaves no store and no .importing file', async (t) => {
  const dir = tempDir()
  const storePath = path.join(dir, 'memory.sqlite')
  const qdrant = mockQdrant(Array.from({ length: 100 }, (_, index) => point(index + 1)))
  await assert.rejects(
    migrate({ storePath, collection: COLLECTION, userId: USER, raw: RAW, embedder: EMBEDDER, dims: DIMS, fetchImpl: embedderFetch(qdrant, { failAfter: 1 }) }),
    (error) => error instanceof MigrationError && error.step === 'embed',
  )
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('the manual summary of the old Qdrant store moves to the SQLite store', (t) => {
  const dir = tempDir()
  const state = new MaintenanceState(path.join(dir, 'maintenance.json'))
  const oldConfig = { backend: 'oss', userId: USER, agentId: 'dsh' }
  // The key earlier versions used: oss.json path + collection.
  const oldScope = { backend: 'oss', endpoint: '/home/u/.dsh/mem0/oss.json', collection: COLLECTION, userId: USER, agentId: 'dsh' }
  state.write({
    version: 2,
    userId: '',
    profile: null,
    hygiene: null,
    scopes: { oldkey: { scope: oldScope, profile: { manual: true, source: 'manual', text: '- likes tea', items: 1, updatedAt: '2026-05-01T00:00:00.000Z' }, hygiene: { lastRunAt: '2026-05-01' }, updatedAt: '2026-05-01T00:00:00.000Z' } },
  })
  const config = { ...oldConfig, storePath: path.join(dir, 'memory.sqlite'), profileEnabled: true, profileBudgetTokens: 1000 }
  const maintenance = new MemoryMaintenance({ client: {}, config, state })
  t.after(() => maintenance.dispose())
  assert.equal(maintenance.profileBlock(), '')
  assert.deepEqual(maintenance.adoptManualProfile({ collection: 'other' }), { adopted: false, reason: 'none' })
  assert.deepEqual(maintenance.adoptManualProfile({ collection: COLLECTION }), { adopted: true })
  assert.match(maintenance.profileBlock(), /likes tea/)
  const saved = state.read()
  assert.equal(saved.scopes[scopeKey(config)].hygiene, null, 'the deletion authorisation is not carried over')
  assert.deepEqual(maintenance.adoptManualProfile({ collection: COLLECTION }), { adopted: false, reason: 'has-manual' })
})

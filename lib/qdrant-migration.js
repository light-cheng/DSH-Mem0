/**
 * One-time move of the memories earlier versions kept in Qdrant into the
 * SQLite store.
 *
 * - Reads one collection (default `dsh_mem0`) of a Qdrant *server*, and in
 *   it only the points of the configured user (a `user_id` filter on every
 *   request). It never lists collections, never reads `mem0` (refused by
 *   name), and never writes or deletes anything in Qdrant. No backup is
 *   made: the Qdrant data stays where it is, unused from then on.
 * - Payloads map like Mem0 reads them (mem0ai 2.0.10 and 2.2.1 write the
 *   same shape): `data` is the text, `hash` is md5 of it (computed when
 *   missing), timestamps with an offset become UTC Python isoformat (the
 *   original kept in metadata), naive ones stay as they are and are
 *   flagged, the other keys go to metadata; `scope` stays empty (global).
 * - Vectors are copied when the user confirmed it and the collection's
 *   model and dimension equal the configured embedder's; otherwise they
 *   are recomputed with the configured embedder.
 * - Everything goes into `<store>.importing` first, in one transaction, and
 *   is checked there (count, a hash sample, top-5 of fixed queries). Only
 *   then does it replace a store that does not exist yet (link + unlink,
 *   never over an existing file), or get merged into an existing store
 *   with ATTACH in one transaction (ids and same-user duplicates skipped).
 *   On any failure the `.importing` files are removed and the error names
 *   the step.
 */
import fs from 'node:fs'
import path from 'node:path'
import { COLLECTION_RE } from './config.js'
import { md5 } from './native-client.js'
import { EMBEDDED_QDRANT_CODE, WINDOWS_DOCS_URL, hostPort, qdrantMode } from './oss-config.js'
import { embedTexts } from './providers.js'
import { redactSecrets } from './redact.js'
import { BUSY_TIMEOUT_MS, MIGRATION_META_KEY, SqliteStore, displayPath, loadSqlite } from './store-sqlite.js'

export { MIGRATION_META_KEY }

/** Collections the migration refuses to read, whatever the user types. */
export const FORBIDDEN_COLLECTIONS = Object.freeze(['mem0'])
export const DEFAULT_QDRANT_URL = 'http://127.0.0.1:6333'
/** The port Windows users usually moved Qdrant to (outside reserved ranges). */
export const WINDOWS_QDRANT_URL = 'http://127.0.0.1:15333'
const SCROLL_LIMIT = 256
const HASH_SAMPLE = 20
const QUERY_SAMPLE = 3

export class MigrationError extends Error {
  constructor(message, { step, code = 'MIGRATION_FAILED', cause, hint } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'MigrationError'
    this.step = step
    this.code = code
    if (hint) this.hint = hint
  }
}

/** `http://host:port` of what the user typed, or of oss.json, or the default. */
export function qdrantUrl(input, { raw, platform = process.platform } = {}) {
  const typed = typeof input === 'string' ? input.trim() : ''
  const source = typed || qdrantMode(raw).endpoint || ''
  if (!source) return platform === 'win32' ? WINDOWS_QDRANT_URL : DEFAULT_QDRANT_URL
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) && !/^https?:\/\//i.test(source)) {
    throw new MigrationError('the Qdrant address must use http or https', { step: 'preflight', code: 'CONFIG_INVALID' })
  }
  const withScheme = /^https?:\/\//i.test(source) ? source : `http://${source}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    throw new MigrationError(`not a Qdrant address: ${JSON.stringify(source.slice(0, 80))}`, { step: 'preflight', code: 'CONFIG_INVALID' })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new MigrationError('the Qdrant address must use http or https', { step: 'preflight', code: 'CONFIG_INVALID' })
  // Ignore any path: the REST API lives at the root.
  return `${url.protocol}//${url.host}`
}

/** Refuse anything but a plain collection name, and `mem0` always. */
export function checkCollection(name) {
  const value = typeof name === 'string' ? name.trim() : ''
  if (!COLLECTION_RE.test(value)) throw new MigrationError('the collection name must match ^[A-Za-z0-9_-]{1,64}$', { step: 'preflight', code: 'CONFIG_INVALID' })
  if (FORBIDDEN_COLLECTIONS.includes(value.toLowerCase())) {
    throw new MigrationError(`collection ${JSON.stringify(value)} belongs to another app and is never read`, { step: 'preflight', code: 'FORBIDDEN_COLLECTION' })
  }
  return value
}

function userFilter(userId) {
  return { must: [{ key: 'user_id', match: { value: String(userId) } }] }
}

async function qdrantRequest(base, method, route, body, { apiKey, fetchImpl = fetch, timeoutMs = 30_000, step = 'read' } = {}) {
  let response
  try {
    response = await fetchImpl(`${base}${route}`, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(apiKey ? { 'api-key': apiKey } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const chain = []
    for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) chain.push(String(current.code ?? ''), String(current.message ?? ''))
    const refused = chain.some((part) => /ECONNREFUSED|10061/.test(part))
    const reserved = chain.some((part) => /10013|forbidden by its access permissions/i.test(part))
    const where = hostPort(base)
    const message = refused || reserved
      ? `Qdrant is not reachable at ${where} (connection refused). Start it the way you ran it before; on Windows a port in a reserved range cannot be used (os error 10013). See ${WINDOWS_DOCS_URL}`
      : `Qdrant at ${where}: ${redactSecrets(chain.filter(Boolean).slice(-1)[0] ?? 'request failed')}`
    throw new MigrationError(message, { step, code: refused || reserved ? 'QDRANT_UNREACHABLE' : 'NETWORK_ERROR', cause: error, ...(process.platform === 'win32' || reserved ? { hint: { command: 'netsh int ipv4 show excludedportrange protocol=tcp', docs: WINDOWS_DOCS_URL } } : {}) })
  }
  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const detail = typeof payload?.status?.error === 'string' ? payload.status.error : ''
    const error = new MigrationError(`Qdrant answered HTTP ${response.status}${detail ? `: ${redactSecrets(detail).slice(0, 200)}` : ''}`, { step, code: response.status === 404 ? 'COLLECTION_NOT_FOUND' : response.status === 401 || response.status === 403 ? 'QDRANT_AUTH' : 'QDRANT_ERROR' })
    error.status = response.status
    throw error
  }
  if (payload === undefined) throw new MigrationError('Qdrant answered something that is not JSON', { step, code: 'QDRANT_ERROR' })
  return payload?.result
}

/** `{ name, size, distance }` of the dense vector a collection uses. */
export function denseVectorConfig(collectionInfo) {
  const vectors = collectionInfo?.config?.params?.vectors
  if (vectors && Number.isInteger(vectors.size)) return { name: '', size: vectors.size, distance: vectors.distance ?? null }
  if (vectors && typeof vectors === 'object') {
    for (const [name, value] of Object.entries(vectors)) {
      if (value && Number.isInteger(value.size)) return { name, size: value.size, distance: value.distance ?? null }
    }
  }
  return { name: '', size: null, distance: null }
}

/** The dense vector of a point (unnamed, or the configured name, or the first dense one). */
export function pointVector(point, name = '') {
  const vector = point?.vector
  if (Array.isArray(vector)) return vector
  if (vector && typeof vector === 'object') {
    if (name && Array.isArray(vector[name])) return vector[name]
    if (Array.isArray(vector[''])) return vector['']
    for (const value of Object.values(vector)) if (Array.isArray(value)) return value
  }
  return null
}

const ISO_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(\.\d{1,9})?(Z|[+-]\d{2}(?::?\d{2})?)?$/

/**
 * A Mem0 timestamp as UTC Python isoformat (`…T01:50:55.980821+00:00`).
 * `{ value, changed, naive }`: an offset is converted (microseconds kept),
 * a naive value is returned unchanged with `naive: true` (Mem0 2.x leaves
 * those alone too), anything unparseable unchanged.
 */
export function normalizeTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return { value: null, changed: false, naive: false }
  const text = value.trim()
  const match = ISO_RE.exec(text)
  if (!match) return { value: text, changed: false, naive: false }
  const [, date, clock, fraction = '', zone] = match
  if (!zone) return { value: text, changed: false, naive: true }
  const time = clock.length === 5 ? `${clock}:00` : clock
  const offset = zone === 'Z' ? 'Z' : zone.length === 3 ? `${zone}:00` : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`
  const ms = Date.parse(`${date}T${time}${offset}`)
  if (!Number.isFinite(ms)) return { value: text, changed: false, naive: false }
  const micro = (fraction.slice(1) + '000000').slice(0, 6)
  const out = `${new Date(ms).toISOString().slice(0, 19)}.${micro}+00:00`
  return { value: out, changed: out !== text, naive: false }
}

const SKIP_KEYS = new Set(['data', 'hash', 'text_lemmatized', 'created_at', 'updated_at'])

/**
 * One Qdrant point as a store record (`{ id, text, hash, payload }`), or
 * `{ skip: 'empty' }` when it has no text.
 */
export function mapPoint(point) {
  const payload = point?.payload && typeof point.payload === 'object' ? point.payload : {}
  const text = typeof payload.data === 'string' ? payload.data : typeof payload.memory === 'string' ? payload.memory : ''
  if (!text.trim()) return { skip: 'empty', id: String(point?.id ?? '') }
  const out = {}
  for (const [key, value] of Object.entries(payload)) {
    if (SKIP_KEYS.has(key) || key === 'memory') continue
    out[key] = value
  }
  const hash = md5(text)
  if (typeof payload.hash === 'string' && payload.hash && payload.hash !== hash) out.original_hash = payload.hash
  const created = normalizeTimestamp(payload.created_at)
  const updated = normalizeTimestamp(payload.updated_at)
  if (created.changed) out.original_created_at = payload.created_at
  if (updated.changed) out.original_updated_at = payload.updated_at
  if (created.naive || updated.naive) out.naive_timestamps = true
  if (created.value) out.created_at = created.value
  if (updated.value) out.updated_at = updated.value
  else if (created.value) out.updated_at = created.value
  return { id: String(point.id), text, hash, payload: out }
}

/**
 * Read-only look at the old store: whether Qdrant answers, the
 * collection's vector size, and how many points the user has there.
 * @returns {Promise<{ url, endpoint, collection, userId, points, dims, distance, oldModel }>}
 */
export async function preflight({ url, collection, userId, raw, apiKey, fetchImpl, platform = process.platform } = {}) {
  const mode = qdrantMode(raw)
  if (mode.mode === 'embedded' && !url) {
    throw new MigrationError('oss.json names an embedded Qdrant folder, which cannot be read without the Python version; the migration needs a Qdrant server. Start one on that data or skip the migration.', { step: 'preflight', code: EMBEDDED_QDRANT_CODE })
  }
  const base = qdrantUrl(url, { raw, platform })
  const name = checkCollection(collection || mode.collection || 'dsh_mem0')
  if (!userId || typeof userId !== 'string') throw new MigrationError('no user id to migrate', { step: 'preflight', code: 'CONFIG_INVALID' })
  const info = await qdrantRequest(base, 'GET', `/collections/${encodeURIComponent(name)}`, undefined, { apiKey, fetchImpl, step: 'preflight' })
  const vector = denseVectorConfig(info)
  const counted = await qdrantRequest(base, 'POST', `/collections/${encodeURIComponent(name)}/points/count`, { filter: userFilter(userId), exact: true }, { apiKey, fetchImpl, step: 'preflight' })
  const oldModel = typeof raw?.oss?.embedder?.config?.model === 'string' ? raw.oss.embedder.config.model.trim() || null : null
  return {
    url: base,
    endpoint: hostPort(base),
    collection: name,
    userId,
    points: Number(counted?.count ?? 0),
    dims: vector.size,
    distance: vector.distance,
    vectorName: vector.name,
    oldModel,
  }
}

/** Whether the old vectors may be copied as they are. */
export function canCopyVectors({ oldModel, oldDims, distance, embedderModel, embedderDims }) {
  return Boolean(oldModel && embedderModel && oldModel === embedderModel && Number.isInteger(oldDims) && oldDims === embedderDims && (!distance || /^cosine$/i.test(distance)))
}

async function readAllPoints(base, name, userId, { apiKey, fetchImpl, signal, onProgress, total }) {
  const points = []
  let offset
  for (let page = 0; page < 100_000; page += 1) {
    if (signal?.aborted) throw new MigrationError('the migration was cancelled', { step: 'read', code: 'ABORTED' })
    const result = await qdrantRequest(base, 'POST', `/collections/${encodeURIComponent(name)}/points/scroll`, {
      filter: userFilter(userId),
      limit: SCROLL_LIMIT,
      with_payload: true,
      with_vector: true,
      ...(offset !== undefined && offset !== null ? { offset } : {}),
    }, { apiKey, fetchImpl, step: 'read' })
    const batch = Array.isArray(result?.points) ? result.points : []
    // Belt and braces: Qdrant filtered already; drop anything of another user.
    for (const point of batch) if (point?.payload?.user_id === userId) points.push(point)
    onProgress?.({ phase: 'read', done: points.length, total })
    offset = result?.next_page_offset
    if (offset === undefined || offset === null || batch.length === 0) return points
  }
  throw new MigrationError('Qdrant kept returning pages', { step: 'read' })
}

function removeDbFiles(file) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${file}${suffix}`, { force: true })
}

function sampleOf(list, size) {
  if (list.length <= size) return [...list]
  const step = list.length / size
  return Array.from({ length: size }, (_, index) => list[Math.floor(index * step)])
}

function overlap(left, right) {
  const set = new Set(right)
  return left.filter((item) => set.has(item)).length
}

/** Close a store and fold its WAL back into the file, so it can be moved. */
function settle(file) {
  const { DatabaseSync } = loadSqlite()
  const db = new DatabaseSync(file)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true })
}

/**
 * Merge a checked `.importing` store into an existing store in one
 * transaction. Skips ids the store has and texts the same user already
 * has (same hash, user and agent).
 */
function mergeInto(target, importing, { marker, embedder }) {
  const { DatabaseSync } = loadSqlite()
  const db = new DatabaseSync(target)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    db.prepare('ATTACH DATABASE ? AS imp').run(importing)
    db.exec('BEGIN IMMEDIATE')
    try {
      const meta = (key, schema = 'main') => db.prepare(`SELECT value FROM ${schema}.meta WHERE key = ?`).get(key)?.value
      const existing = Number(db.prepare('SELECT COUNT(*) AS n FROM main.memories').get().n)
      const storeModel = meta('embed_model')
      const storeDims = Number(meta('embed_dims'))
      if (existing > 0 && ((storeModel && storeModel !== embedder.model) || (Number.isInteger(storeDims) && storeDims > 0 && storeDims !== embedder.dims))) {
        throw new MigrationError(`the memory store holds vectors of embedder ${storeModel ?? '?'} (${storeDims || '?'} dims), not ${embedder.model} (${embedder.dims}); recompute them first`, { step: 'merge', code: 'EMBEDDER_MISMATCH' })
      }
      const before = Number(db.prepare('SELECT COUNT(*) AS n FROM main.memories').get().n)
      const candidates = Number(db.prepare('SELECT COUNT(*) AS n FROM imp.memories').get().n)
      const inserted = Number(db.prepare(`INSERT INTO main.memories SELECT * FROM imp.memories AS i
        WHERE NOT EXISTS (SELECT 1 FROM main.memories AS m WHERE m.id = i.id)
          AND NOT EXISTS (SELECT 1 FROM main.memories AS m WHERE m.hash = i.hash AND m.user_id IS i.user_id AND m.agent_id IS i.agent_id)`).run().changes)
      const after = Number(db.prepare('SELECT COUNT(*) AS n FROM main.memories').get().n)
      if (after !== before + inserted) throw new MigrationError(`count check failed while merging (${before} + ${inserted} ≠ ${after})`, { step: 'merge', code: 'VERIFY_FAILED' })
      const put = db.prepare('INSERT INTO main.meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      if (existing === 0 || !storeModel) {
        put.run('embed_model', String(embedder.model))
        put.run('embed_dims', String(embedder.dims))
      }
      put.run(MIGRATION_META_KEY, JSON.stringify({ ...marker, imported: inserted, skippedExisting: candidates - inserted }))
      db.exec('COMMIT')
      return { inserted, skippedExisting: candidates - inserted }
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // nothing to roll back
      }
      throw error
    } finally {
      try {
        db.exec('DETACH DATABASE imp')
      } catch {
        // not attached
      }
    }
  } finally {
    db.close()
  }
}

/**
 * Run the migration. `embedder` is the configured embedder settings
 * (`{ provider, baseUrl, model, dims }`), `embedderKey` its key; `dims` is
 * the dimension a test embedding returned.
 * @returns {Promise<object>} report: counts, mode (`created` | `merged`),
 *   vectors (`copied` | `recomputed`), checks.
 */
export async function migrate({
  storePath, url, collection, userId, raw, qdrantApiKey, embedder, embedderKey, dims, copyVectors = false,
  fetchImpl, signal, onProgress, now = () => new Date(), platform = process.platform, logger,
} = {}) {
  const pre = await preflight({ url, collection, userId, raw, apiKey: qdrantApiKey, fetchImpl, platform })
  if (!Number.isInteger(dims) || dims <= 0) throw new MigrationError('test the embedder first: its dimension is unknown', { step: 'preflight', code: 'CONFIG_INVALID' })
  const copy = copyVectors === true && canCopyVectors({ oldModel: pre.oldModel, oldDims: pre.dims, distance: pre.distance, embedderModel: embedder.model, embedderDims: dims })
  const target = path.resolve(storePath)
  const importing = `${target}.importing`
  const started = Date.now()
  let step = 'read'
  removeDbFiles(importing)
  try {
    const points = await readAllPoints(pre.url, pre.collection, userId, { apiKey: qdrantApiKey, fetchImpl, signal, onProgress, total: pre.points })
    step = 'map'
    const records = []
    let skippedEmpty = 0
    const vectorsById = new Map()
    for (const point of points) {
      const mapped = mapPoint(point)
      if (mapped.skip) {
        skippedEmpty += 1
        continue
      }
      records.push(mapped)
      if (copy) {
        const vector = pointVector(point, pre.vectorName)
        if (!vector || vector.length !== dims) throw new MigrationError(`point ${mapped.id} has no ${dims}-dimension vector`, { step: 'map', code: 'BAD_VECTOR' })
        vectorsById.set(mapped.id, Float32Array.from(vector))
      }
    }
    step = 'embed'
    if (!copy) {
      for (let start = 0; start < records.length; start += 32) {
        if (signal?.aborted) throw new MigrationError('the migration was cancelled', { step, code: 'ABORTED' })
        const batch = records.slice(start, start + 32)
        const vectors = await embedTexts(embedder, batch.map((record) => record.text), { apiKey: embedderKey, signal, timeoutMs: 60_000, fetchImpl })
        batch.forEach((record, index) => {
          if (vectors[index].length !== dims) throw new MigrationError(`the embedder returned ${vectors[index].length} dimensions, not ${dims}`, { step, code: 'EMBEDDER_MISMATCH' })
          vectorsById.set(record.id, Float32Array.from(vectors[index]))
        })
        onProgress?.({ phase: 'embed', done: Math.min(records.length, start + batch.length), total: records.length })
      }
    }
    step = 'write'
    const marker = {
      at: now().toISOString(),
      endpoint: pre.endpoint,
      collection: pre.collection,
      userId,
      points: points.length,
      skippedEmpty,
      vectors: copy ? 'copied' : 'recomputed',
      model: embedder.model,
      dims,
    }
    const store = new SqliteStore({ filePath: importing, logger, now })
    try {
      store.open()
      store.insert(records.map((record) => ({ ...record, vector: vectorsById.get(record.id), embedModel: embedder.model })))
      store.setEmbedderInfo({ model: embedder.model, dims })
      store.setMeta(MIGRATION_META_KEY, JSON.stringify({ ...marker, imported: records.length }))

      step = 'verify'
      const checks = {}
      const stored = store.count({ user_id: userId })
      checks.count = { qdrant: pre.points, read: points.length, stored, skippedEmpty }
      if (stored !== records.length || records.length + skippedEmpty !== points.length) {
        throw new MigrationError(`count check failed: read ${points.length}, stored ${stored}, without text ${skippedEmpty}`, { step, code: 'VERIFY_FAILED' })
      }
      const hashSample = sampleOf(records, HASH_SAMPLE)
      for (const record of hashSample) {
        const item = store.get(record.id)
        if (!item || item.memory !== record.text || item.hash !== md5(record.text)) {
          throw new MigrationError(`hash check failed for memory ${record.id}`, { step, code: 'VERIFY_FAILED' })
        }
      }
      checks.hashes = hashSample.length
      const querySample = sampleOf(records, QUERY_SAMPLE)
      let queries = 0
      for (const record of querySample) {
        const vector = vectorsById.get(record.id)
        const hits = store.searchVectors(vector, { user_id: userId }, 5)
        const local = hits.map(({ row }) => String(row.id))
        if (copy) {
          // Same vectors: Qdrant's top 5 for this vector must come back.
          const remote = await qdrantRequest(pre.url, 'POST', `/collections/${encodeURIComponent(pre.collection)}/points/search`, {
            vector: pre.vectorName ? { name: pre.vectorName, vector: Array.from(vector) } : Array.from(vector),
            filter: userFilter(userId),
            limit: 5,
            with_payload: false,
          }, { apiKey: qdrantApiKey, fetchImpl, step })
          const remoteIds = (Array.isArray(remote) ? remote : []).map((hit) => String(hit.id))
          const emptyIds = new Set(points.filter((point) => mapPoint(point).skip).map((point) => String(point.id)))
          const wanted = remoteIds.filter((id) => !emptyIds.has(id))
          // Ties may swap places; four of five in common is a match.
          if (overlap(local, wanted) < Math.min(4, wanted.length)) throw new MigrationError(`top-5 check failed for memory ${record.id}`, { step, code: 'VERIFY_FAILED' })
        } else {
          // Recomputed vectors: a memory's own vector finds that memory (or,
          // for two texts with the same vector, one scoring just as high).
          const found = local.includes(record.id) || (hits[0] && hits[0].score > 0.9999)
          if (!found) throw new MigrationError(`top-5 check failed for memory ${record.id}`, { step, code: 'VERIFY_FAILED' })
        }
        queries += 1
      }
      checks.queries = queries
      store.close()
      settle(importing)

      step = 'switch'
      let mode
      let inserted = records.length
      let skippedExisting = 0
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(`${target}${suffix}`, { force: true })
        try {
          // A hard link never replaces a file that appeared meanwhile.
          fs.linkSync(importing, target)
          mode = 'created'
        } catch (error) {
          if (error?.code !== 'EEXIST' && !fs.existsSync(target)) {
            fs.renameSync(importing, target)
            mode = 'created'
          } else if (error?.code !== 'EEXIST') {
            throw error
          }
        }
      }
      if (!mode) {
        const merged = mergeInto(target, importing, { marker, embedder: { model: embedder.model, dims } })
        inserted = merged.inserted
        skippedExisting = merged.skippedExisting
        mode = 'merged'
      }
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(target, 0o600)
        } catch {
          // best effort
        }
      }
      removeDbFiles(importing)
      return {
        ok: true,
        mode,
        store: displayPath(target),
        endpoint: pre.endpoint,
        collection: pre.collection,
        points: points.length,
        imported: inserted,
        skippedExisting,
        skippedEmpty,
        vectors: copy ? 'copied' : 'recomputed',
        checks,
        ms: Date.now() - started,
      }
    } finally {
      store.close()
    }
  } catch (error) {
    removeDbFiles(importing)
    if (error instanceof MigrationError) throw error
    throw new MigrationError(`${step} failed: ${redactSecrets(String(error?.message ?? error)).slice(0, 300)}`, { step, code: error?.code === 'ABORTED' ? 'ABORTED' : 'MIGRATION_FAILED', cause: error })
  }
}

/** The migration marker of a store, or null. */
export function migrationMarker(store) {
  try {
    const value = store.getMeta(MIGRATION_META_KEY)
    return value ? JSON.parse(value) : null
  } catch {
    return null
  }
}

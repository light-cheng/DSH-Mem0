/**
 * The local memory store: one SQLite file (`node:sqlite`, built into the
 * Node that DSH ships), by default `~/.dsh/mem0/memory.sqlite`.
 *
 * - WAL journal and a busy timeout, so several DSH processes (profiles,
 *   CLI + desktop) can share the file: writes queue instead of failing.
 * - Vectors live in the `memories` table as float32 BLOBs and in an
 *   in-memory cache (normalised) for brute-force cosine search; a few
 *   thousand memories search in a few milliseconds.
 * - Another process's commit is noticed through `PRAGMA data_version`
 *   (which our own writes do not change), and the cache is reloaded then.
 *   Our own writes update the cache directly.
 * - The schema carries the columns later stages use (importance, pinned,
 *   scope, project_id, session_id), so they need no migration.
 *
 * Rows come back in the Mem0 item shape (`id`, `memory`, `hash`,
 * `metadata`, `created_at`, `updated_at`, promoted `user_id`, `agent_id`,
 * `run_id`, `actor_id`, `role`, `attributed_to`, `expiration_date`).
 *
 * Errors are StoreError with `component: 'vector_store'`, `step` (`search`
 * for reads, `store` for writes), `endpoint` (the file, home as `~`) and
 * `code`: `busy`, `corrupt`, `readonly`, `disk_full`, `cantopen`, `ioerr`,
 * `schema_newer` or `sqlite`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { inPartitions } from './project-scope.js'

const require = createRequire(import.meta.url)

/** Default store file; lib/oss-config.js re-exports it. */
export const DEFAULT_STORE_PATH = path.join(os.homedir(), '.dsh', 'mem0', 'memory.sqlite')

export const SCHEMA_VERSION = 1
/** meta key of the one-time Qdrant migration's record (lib/qdrant-migration.js). */
export const MIGRATION_META_KEY = 'qdrant_migration'
export const BUSY_TIMEOUT_MS = 5_000
/** mem0 keeps the last 10 messages per session scope. */
export const RECENT_MESSAGES_LIMIT = 10
/** Columns returned at the top level of an item when set (mem0's promoted keys). */
export const PROMOTED_KEYS = Object.freeze(['user_id', 'agent_id', 'run_id', 'actor_id', 'role', 'attributed_to', 'expiration_date'])
const ENTITY_KEYS = ['user_id', 'agent_id', 'run_id']
// Payload keys that are columns, never metadata.
const CORE_KEYS = new Set(['id', 'data', 'text', 'memory', 'hash', 'created_at', 'updated_at', 'text_lemmatized', ...PROMOTED_KEYS])

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  hash TEXT NOT NULL,
  user_id TEXT,
  agent_id TEXT,
  run_id TEXT,
  actor_id TEXT,
  role TEXT,
  attributed_to TEXT,
  expiration_date TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  embedding BLOB,
  embed_model TEXT,
  embed_dims INTEGER,
  importance INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0,
  scope TEXT,
  project_id TEXT,
  session_id TEXT,
  kind TEXT
);
CREATE INDEX IF NOT EXISTS memories_user ON memories(user_id, agent_id);
CREATE INDEX IF NOT EXISTS memories_hash ON memories(hash);
CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope, project_id);
CREATE TABLE IF NOT EXISTS recent_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_scope TEXT NOT NULL,
  role TEXT,
  content TEXT,
  name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recent_messages_scope ON recent_messages(session_scope, seq);
`

/** `~` for the home directory, for messages and status. */
export function displayPath(file, home = os.homedir()) {
  const text = String(file ?? '')
  if (home && home.length > 1 && (text === home || text.startsWith(`${home}/`) || text.startsWith(`${home}\\`))) {
    return `~${text.slice(home.length)}`
  }
  return text
}

/**
 * Python `datetime.now(timezone.utc).isoformat()`:
 * `2026-11-13T01:50:55.980821+00:00` (6-digit microseconds, `+00:00`).
 * JavaScript has milliseconds only; the last three digits come from a
 * per-process counter so two stamps in one millisecond still differ.
 */
let microCounter = 0
export function pyUtcNow(now = new Date()) {
  microCounter = (microCounter + 1) % 1000
  const micro = String(now.getUTCMilliseconds() * 1000 + microCounter).padStart(6, '0')
  return now.toISOString().replace(/\.\d{3}Z$/, `.${micro}+00:00`)
}

/** Whether `expiration_date` (YYYY-MM-DD) lies before today (UTC), as mem0. */
export function isExpired(expiration, now = new Date()) {
  if (!expiration) return false
  const value = String(expiration)
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return false
  return value.slice(0, 10) < now.toISOString().slice(0, 10)
}

export class StoreError extends Error {
  constructor(message, { code = 'sqlite', step = 'store', endpoint, cause, configError } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'StoreError'
    this.code = code
    this.component = 'vector_store'
    this.provider = 'sqlite'
    this.step = step
    if (endpoint) this.endpoint = endpoint
    if (configError) this.configError = true
  }
}

const SQLITE_CODES = {
  3: 'readonly', // SQLITE_PERM
  5: 'busy',
  6: 'busy', // SQLITE_LOCKED
  8: 'readonly',
  10: 'ioerr',
  11: 'corrupt',
  13: 'disk_full',
  14: 'cantopen',
  26: 'corrupt', // SQLITE_NOTADB
}

const HINTS = {
  busy: 'another DSH process held the memory database for too long; it is retried with the next memory call',
  corrupt: 'the memory database file is damaged',
  readonly: 'the memory database file or its folder is not writable',
  disk_full: 'the disk holding the memory database is full',
  cantopen: 'the memory database file cannot be opened (missing folder, permissions, or a network/sync drive)',
  ioerr: 'the disk reported an I/O error for the memory database',
}

/** StoreError for a node:sqlite (or file system) error. */
export function storeError(error, { step = 'store', file } = {}) {
  if (error instanceof StoreError) return error
  const errcode = Number(error?.errcode)
  let code = Number.isInteger(errcode) ? SQLITE_CODES[errcode & 0xff] : undefined
  if (!code) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EROFS') code = 'readonly'
    else if (error?.code === 'ENOSPC') code = 'disk_full'
    else if (/database is locked|SQLITE_BUSY/i.test(String(error?.message))) code = 'busy'
    else code = 'sqlite'
  }
  const where = file ? displayPath(file) : 'memory.sqlite'
  const detail = String(error?.errstr || error?.message || error)
  const hint = HINTS[code] ? `: ${HINTS[code]}` : ''
  return new StoreError(`SQLite store ${where} failed (${code}${hint}): ${detail}`, { code, step, endpoint: where, cause: error })
}

let sqliteModule
/** `node:sqlite`, loaded once; a StoreError when this Node has none. */
export function loadSqlite() {
  if (sqliteModule) return sqliteModule
  try {
    sqliteModule = require('node:sqlite')
    return sqliteModule
  } catch (error) {
    throw new StoreError(
      `node:sqlite is not available in Node ${process.versions.node}; DSH-Mem0 needs Node >= 24.9 (DSH ships 24.21)`,
      { code: 'cantopen', step: 'store', cause: error, configError: true },
    )
  }
}

function toBlob(vector) {
  const array = vector instanceof Float32Array ? vector : Float32Array.from(vector)
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
}

function fromBlob(blob) {
  if (!blob) return null
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob)
  if (bytes.byteLength % 4 !== 0) return null
  // Copy: the buffer node:sqlite returns may not be 4-byte aligned.
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Float32Array(copy.buffer)
}

function normalized(vector) {
  let sum = 0
  for (let index = 0; index < vector.length; index += 1) sum += vector[index] * vector[index]
  const norm = Math.sqrt(sum)
  const out = new Float32Array(vector.length)
  if (!(norm > 0)) return out
  for (let index = 0; index < vector.length; index += 1) out[index] = vector[index] / norm
  return out
}

function dot(left, right) {
  let sum = 0
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index]
  return sum
}

function parseMetadata(text) {
  try {
    const value = JSON.parse(text || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/** A row in the Mem0 item shape. */
export function rowToItem(row, score) {
  const item = {
    id: String(row.id),
    memory: row.text ?? '',
    hash: row.hash ?? null,
    metadata: null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  }
  if (score !== undefined) item.score = score
  for (const key of PROMOTED_KEYS) {
    if (row[key] !== null && row[key] !== undefined) item[key] = row[key]
  }
  const metadata = parseMetadata(row.metadata_json)
  if (Object.keys(metadata).length > 0) item.metadata = metadata
  // Columns of the hygiene pass and the user's pin (not metadata: setting
  // them changes neither the text, the vector nor updated_at).
  if (Number.isInteger(row.importance) || (typeof row.importance === 'number' && Number.isFinite(row.importance))) item.importance = Number(row.importance)
  if (Number(row.pinned) === 1) item.pinned = true
  // Partition (lib/project-scope.js); absent means global.
  if (row.scope === 'project' || row.scope === 'session' || row.scope === 'global') item.scope = row.scope
  if (row.project_id) item.project_id = String(row.project_id)
  if (row.session_id) item.session_id = String(row.session_id)
  return item
}

/** Partition columns of a row (null scope reads as global). */
function partitionOf(row) {
  return { scope: row.scope ?? null, project_id: row.project_id ?? null, session_id: row.session_id ?? null }
}

const PROJECT_META_PREFIX = 'project:'

/**
 * Split a mem0-style payload (flat: system fields plus user metadata) into
 * column values and the metadata object kept in `metadata_json`.
 */
export function splitPayload(payload = {}) {
  const columns = {}
  const metadata = {}
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (PROMOTED_KEYS.includes(key)) {
      if (value !== undefined && value !== null && value !== '') columns[key] = String(value)
    } else if (!CORE_KEYS.has(key) && value !== undefined) {
      metadata[key] = value
    }
  }
  return { columns, metadata }
}

function matchesFilters(entry, filters) {
  for (const key of ENTITY_KEYS) {
    const wanted = filters?.[key]
    if (wanted === undefined || wanted === null || wanted === '' || wanted === '*') continue
    if (entry[key] !== String(wanted)) return false
  }
  return true
}

function extraFilters(filters) {
  return Object.entries(filters ?? {}).filter(
    ([key, value]) => !ENTITY_KEYS.includes(key) && value !== undefined && value !== null && value !== '' && value !== '*',
  )
}

function matchesExtra(row, extras) {
  if (extras.length === 0) return true
  const metadata = parseMetadata(row.metadata_json)
  for (const [key, value] of extras) {
    const actual = PROMOTED_KEYS.includes(key) ? row[key] : metadata[key]
    if (actual !== value && String(actual) !== String(value)) return false
  }
  return true
}

export class SqliteStore {
  /**
   * @param {object} [options]
   * @param {string} [options.filePath] default `~/.dsh/mem0/memory.sqlite`.
   * @param {number} [options.busyTimeoutMs]
   * @param {object} [options.logger]
   */
  constructor({ filePath = DEFAULT_STORE_PATH, busyTimeoutMs = BUSY_TIMEOUT_MS, logger, now = () => new Date() } = {}) {
    this.filePath = path.resolve(filePath)
    this.busyTimeoutMs = busyTimeoutMs
    this.logger = logger
    this.now = now
    this.db = undefined
    this.closed = false
    this.cache = undefined
    this.dataVersion = undefined
    this.statements = new Map()
  }

  get displayPath() {
    return displayPath(this.filePath)
  }

  /** Open (create) the file and the schema. Idempotent. */
  open() {
    if (this.db) return this
    this.closed = false
    const { DatabaseSync } = loadSqlite()
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    } catch (error) {
      throw storeError(error, { step: 'store', file: this.filePath })
    }
    let db
    try {
      db = new DatabaseSync(this.filePath)
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(this.busyTimeoutMs))}`)
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
      const version = this.#schemaVersion(db)
      if (version > SCHEMA_VERSION) {
        throw new StoreError(
          `SQLite store ${displayPath(this.filePath)} has schema version ${version}, newer than this plugin (${SCHEMA_VERSION}); update DSH-Mem0`,
          { code: 'schema_newer', step: 'store', endpoint: displayPath(this.filePath), configError: true },
        )
      }
      if (version < SCHEMA_VERSION) {
        db.exec('BEGIN IMMEDIATE')
        try {
          db.exec(SCHEMA_SQL)
          db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('schema_version', String(SCHEMA_VERSION))
          if (version === 0) {
            db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run('created_at', pyUtcNow(this.now()))
          }
          db.exec('COMMIT')
        } catch (error) {
          try {
            db.exec('ROLLBACK')
          } catch {
            // no transaction left
          }
          throw error
        }
      }
    } catch (error) {
      try {
        db?.close()
      } catch {
        // already closed
      }
      throw storeError(error, { step: 'store', file: this.filePath })
    }
    this.db = db
    this.#restrictPermissions()
    return this
  }

  #schemaVersion(db) {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()
    if (!table) return 0
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    const version = Number(row?.value ?? 0)
    return Number.isInteger(version) && version >= 0 ? version : 0
  }

  /** chmod 600 on Unix (the file holds memories and recent messages). */
  #restrictPermissions() {
    if (process.platform === 'win32') return
    for (const file of [this.filePath, `${this.filePath}-wal`, `${this.filePath}-shm`]) {
      try {
        if (fs.existsSync(file)) fs.chmodSync(file, 0o600)
      } catch (error) {
        this.logger?.debug?.(`dsh-mem0: could not restrict ${displayPath(file)}: ${error.message}`)
      }
    }
  }

  /**
   * Close the file. A later call does not reopen it on its own (StoreError
   * `closed`): a call that was waiting on the network when the client was
   * disposed must not leave a new connection behind, which on Windows keeps
   * the file locked. `open()` reopens explicitly.
   */
  close() {
    this.closed = true
    this.statements.clear()
    this.cache = undefined
    this.dataVersion = undefined
    if (!this.db) return
    try {
      this.db.close()
    } catch {
      // already closed
    }
    this.db = undefined
  }

  #prepare(sql) {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  /** Run `fn` with the store open, mapping errors to StoreError. */
  #run(step, fn) {
    if (this.closed) {
      throw new StoreError(`SQLite store ${displayPath(this.filePath)} was closed`, { code: 'closed', step, endpoint: displayPath(this.filePath) })
    }
    try {
      this.open()
      return fn()
    } catch (error) {
      throw storeError(error, { step, file: this.filePath })
    }
  }

  #write(fn) {
    return this.#run('store', () => {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const result = fn()
        this.db.exec('COMMIT')
        return result
      } catch (error) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          // no transaction left
        }
        throw error
      }
    })
  }

  // ---- vector cache -------------------------------------------------------

  /** Reload the cache when another connection committed since we last looked. */
  #freshCache() {
    const version = Number(this.db.prepare('PRAGMA data_version').get()?.data_version)
    if (this.cache && version === this.dataVersion) return this.cache
    const cache = new Map()
    for (const row of this.#prepare('SELECT id, user_id, agent_id, run_id, scope, project_id, session_id, embedding FROM memories').iterate()) {
      const vector = fromBlob(row.embedding)
      if (!vector) continue
      cache.set(String(row.id), { user_id: row.user_id, agent_id: row.agent_id, run_id: row.run_id, ...partitionOf(row), vector: normalized(vector) })
    }
    this.cache = cache
    this.dataVersion = version
    return cache
  }

  #cachePut(row, vector) {
    if (!this.cache) return
    if (!vector) {
      this.cache.delete(String(row.id))
      return
    }
    this.cache.set(String(row.id), { user_id: row.user_id ?? null, agent_id: row.agent_id ?? null, run_id: row.run_id ?? null, ...partitionOf(row), vector: normalized(vector) })
  }

  // ---- meta ---------------------------------------------------------------

  getMeta(key) {
    return this.#run('search', () => this.#prepare('SELECT value FROM meta WHERE key = ?').get(String(key))?.value)
  }

  setMeta(key, value) {
    this.#write(() => {
      this.#prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(String(key), String(value))
    })
  }

  /** `{ model, dims }` of the vectors in this store, or undefined. */
  embedderInfo() {
    const model = this.getMeta('embed_model')
    const dims = Number(this.getMeta('embed_dims'))
    if (!model && !Number.isInteger(dims)) return undefined
    return { model: model ?? null, dims: Number.isInteger(dims) && dims > 0 ? dims : null }
  }

  setEmbedderInfo({ model, dims }) {
    this.#write(() => {
      const put = this.#prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      put.run('embed_model', String(model ?? ''))
      put.run('embed_dims', String(dims ?? ''))
    })
  }

  // ---- memories -----------------------------------------------------------

  /** Number of memories matching entity filters (expired ones included). */
  count(filters = {}) {
    return this.#run('search', () => {
      const where = []
      const params = []
      for (const key of ENTITY_KEYS) {
        const value = filters?.[key]
        if (value === undefined || value === null || value === '' || value === '*') continue
        where.push(`${key} = ?`)
        params.push(String(value))
      }
      const sql = `SELECT COUNT(*) AS n FROM memories${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`
      return Number(this.db.prepare(sql).get(...params)?.n ?? 0)
    })
  }

  #row(id) {
    return this.#prepare('SELECT * FROM memories WHERE id = ?').get(String(id))
  }

  /** One memory in the Mem0 item shape, or null. */
  get(id) {
    return this.#run('search', () => {
      const row = this.#row(id)
      return row ? rowToItem(row) : null
    })
  }

  /** The stored payload of one memory (columns + metadata), or null. */
  getRaw(id) {
    return this.#run('search', () => this.#row(id) ?? null)
  }

  /**
   * Memories matching `filters`, newest first, expired ones left out unless
   * `showExpired` (mem0 get_all).
   */
  list(filters = {}, { limit = 100, showExpired = false, partitions } = {}) {
    return this.#run('search', () => {
      const where = []
      const params = []
      for (const key of ENTITY_KEYS) {
        const value = filters?.[key]
        if (value === undefined || value === null || value === '' || value === '*') continue
        where.push(`${key} = ?`)
        params.push(String(value))
      }
      const sql = `SELECT * FROM memories${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id`
      const extras = extraFilters(filters)
      const now = this.now()
      const out = []
      const max = Math.max(1, Math.floor(limit))
      for (const row of this.db.prepare(sql).iterate(...params)) {
        if (!showExpired && isExpired(row.expiration_date, now)) continue
        if (!matchesExtra(row, extras)) continue
        if (partitions && !inPartitions(partitionOf(row), partitions)) continue
        out.push(rowToItem(row))
        if (out.length >= max) break
      }
      return out
    })
  }

  /**
   * Raw vector search (Qdrant's `search`): the `limit` best cosine scores
   * among memories matching the entity filters, no threshold. Rows with
   * their score, best first. Vectors of another dimension are skipped.
   */
  searchVectors(vector, filters = {}, limit = 10, { partitions } = {}) {
    return this.#run('search', () => {
      const query = normalized(vector instanceof Float32Array ? vector : Float32Array.from(vector))
      const cache = this.#freshCache()
      const scored = []
      for (const [id, entry] of cache) {
        if (entry.vector.length !== query.length || !matchesFilters(entry, filters)) continue
        if (partitions && !inPartitions(entry, partitions)) continue
        scored.push({ id, score: dot(entry.vector, query) })
      }
      scored.sort((left, right) => right.score - left.score)
      const extras = extraFilters(filters)
      const out = []
      for (const candidate of scored) {
        if (out.length >= limit) break
        const row = this.#row(candidate.id)
        if (!row || !matchesExtra(row, extras)) continue
        out.push({ row, score: candidate.score })
      }
      return out
    })
  }

  /**
   * Cosine of `vector` with each stored memory of `ids` (no filters: the
   * caller names the memories). Unknown ids and vectors of another
   * dimension are left out. `[{ id, score }]` in the order of `ids`.
   */
  scoreIds(ids, vector) {
    return this.#run('search', () => {
      const query = normalized(vector instanceof Float32Array ? vector : Float32Array.from(vector))
      const cache = this.#freshCache()
      const out = []
      for (const id of Array.isArray(ids) ? ids : []) {
        const entry = cache.get(String(id))
        if (!entry || entry.vector.length !== query.length) continue
        out.push({ id: String(id), score: dot(entry.vector, query) })
      }
      return out
    })
  }

  /**
   * mem0 `search` without BM25 or entity boosts: fetch max(topK*4, 60)
   * candidates, drop scores below `threshold`, expired and empty memories,
   * return the best `topK` items with `score`.
   */
  search(vector, filters = {}, { topK = 5, threshold = 0.1, partitions } = {}) {
    const candidates = this.searchVectors(vector, filters, Math.max(topK * 4, 60), { partitions })
    const now = this.now()
    const minimum = Number.isFinite(threshold) ? threshold : 0.1
    return candidates
      .filter(({ row, score }) => score >= minimum && row.text && !isExpired(row.expiration_date, now))
      .slice(0, topK)
      .map(({ row, score }) => rowToItem(row, Math.min(score, 1)))
  }

  /** Whether a memory with this hash exists for these entity filters. */
  hasHash(hash, filters = {}) {
    return this.#run('search', () => {
      const where = ['hash = ?']
      const params = [String(hash)]
      for (const key of ENTITY_KEYS) {
        const value = filters?.[key]
        if (!value) continue
        where.push(`${key} = ?`)
        params.push(String(value))
      }
      return Boolean(this.db.prepare(`SELECT 1 AS hit FROM memories WHERE ${where.join(' AND ')} LIMIT 1`).get(...params))
    })
  }

  /**
   * Insert memories in one transaction. Each record: `{ id, text, hash,
   * vector, payload, embedModel }` where payload is mem0-style (flat:
   * promoted keys plus user metadata) and may carry created_at/updated_at.
   */
  insert(records) {
    if (!Array.isArray(records) || records.length === 0) return []
    const now = pyUtcNow(this.now())
    const rows = records.map((record) => {
      const { columns, metadata } = splitPayload(record.payload)
      const createdAt = typeof record.payload?.created_at === 'string' && record.payload.created_at ? record.payload.created_at : now
      const updatedAt = typeof record.payload?.updated_at === 'string' && record.payload.updated_at ? record.payload.updated_at : createdAt
      const vector = record.vector ? Float32Array.from(record.vector) : null
      return {
        id: String(record.id),
        text: String(record.text ?? ''),
        hash: String(record.hash ?? ''),
        user_id: columns.user_id ?? null,
        agent_id: columns.agent_id ?? null,
        run_id: columns.run_id ?? null,
        actor_id: columns.actor_id ?? null,
        role: columns.role ?? null,
        attributed_to: columns.attributed_to ?? null,
        expiration_date: columns.expiration_date ?? null,
        metadata_json: JSON.stringify(metadata),
        created_at: createdAt,
        updated_at: updatedAt,
        vector,
        embed_model: record.embedModel ?? null,
        scope: record.scope ?? null,
        project_id: record.projectId ?? null,
        session_id: record.sessionId ?? null,
      }
    })
    this.#write(() => {
      const statement = this.#prepare(`INSERT INTO memories
        (id, text, hash, user_id, agent_id, run_id, actor_id, role, attributed_to, expiration_date, metadata_json,
         created_at, updated_at, embedding, embed_model, embed_dims, scope, project_id, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const row of rows) {
        statement.run(
          row.id, row.text, row.hash, row.user_id, row.agent_id, row.run_id, row.actor_id, row.role, row.attributed_to,
          row.expiration_date, row.metadata_json, row.created_at, row.updated_at,
          row.vector ? toBlob(row.vector) : null, row.embed_model, row.vector ? row.vector.length : null,
          row.scope, row.project_id, row.session_id,
        )
      }
    })
    for (const row of rows) this.#cachePut(row, row.vector)
    return rows.map((row) => row.id)
  }

  /**
   * Replace one memory's text, hash, metadata, expiration and vector
   * (mem0 `_update_memory`; created_at is kept). Returns false when the
   * id does not exist.
   */
  update(id, { text, hash, metadata, expirationDate, vector, embedModel, updatedAt }) {
    const changed = this.#write(() => {
      const row = this.#row(id)
      if (!row) return null
      const merged = { ...parseMetadata(row.metadata_json), ...splitPayload(metadata ?? {}).metadata }
      const next = {
        text: text ?? row.text,
        hash: hash ?? row.hash,
        metadata_json: JSON.stringify(merged),
        expiration_date: expirationDate === undefined ? row.expiration_date : expirationDate,
        updated_at: updatedAt ?? pyUtcNow(this.now()),
      }
      const blob = vector ? toBlob(Float32Array.from(vector)) : row.embedding
      this.#prepare(`UPDATE memories SET text = ?, hash = ?, metadata_json = ?, expiration_date = ?, updated_at = ?,
        embedding = ?, embed_model = ?, embed_dims = ? WHERE id = ?`).run(
        next.text, next.hash, next.metadata_json, next.expiration_date, next.updated_at,
        blob, vector ? embedModel ?? row.embed_model : row.embed_model, vector ? vector.length : row.embed_dims, String(id),
      )
      return { ...row, ...next }
    })
    if (!changed) return false
    if (vector) this.#cachePut(changed, Float32Array.from(vector))
    return true
  }

  /**
   * Set the hygiene importance (1–5, null clears) and/or the user's pin of
   * one memory. Text, vector, metadata and updated_at stay as they are, so
   * a pin or a rating never looks like an edit to the next hygiene pass.
   * Returns false when the id does not exist.
   */
  setAttributes(id, { importance, pinned } = {}) {
    const sets = []
    const params = []
    if (importance !== undefined) {
      const level = importance === null ? null : Math.round(Number(importance))
      if (level !== null && !(level >= 1 && level <= 5)) throw new StoreError('importance must be 1–5', { code: 'sqlite', step: 'store' })
      sets.push('importance = ?')
      params.push(level)
    }
    if (pinned !== undefined) {
      sets.push('pinned = ?')
      params.push(pinned ? 1 : 0)
    }
    if (sets.length === 0) return Boolean(this.#run('search', () => this.#row(id)))
    return this.#write(() => Number(this.#prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params, String(id)).changes) > 0)
  }

  /**
   * Memories closest to a stored one by its own vector (no embedding call):
   * `[{ id, score }]`, best first, the memory itself left out. Empty when it
   * has no vector.
   */
  neighbors(id, filters = {}, { limit = 8, threshold = 0.8, samePartition = false } = {}) {
    return this.#run('search', () => {
      const cache = this.#freshCache()
      const own = cache.get(String(id))
      if (!own) return []
      const scored = []
      for (const [other, entry] of cache) {
        if (other === String(id) || entry.vector.length !== own.vector.length || !matchesFilters(entry, filters)) continue
        if (samePartition && !inPartitions(entry, [{ scope: own.scope === 'project' || own.scope === 'session' ? own.scope : 'global', project_id: own.project_id, session_id: own.session_id }])) continue
        const score = dot(entry.vector, own.vector)
        if (score >= threshold) scored.push({ id: other, score })
      }
      scored.sort((left, right) => right.score - left.score)
      return scored.slice(0, Math.max(1, Math.floor(limit)))
    })
  }

  /**
   * Move one memory to another partition (the settings page's "make global").
   * Text, vector, metadata and updated_at stay. Returns false when the id
   * does not exist.
   */
  setScope(id, { scope, projectId = null, sessionId = null } = {}) {
    if (!['global', 'project', 'session'].includes(scope)) throw new StoreError('scope must be global, project or session', { code: 'sqlite', step: 'store' })
    if (scope === 'project' && !projectId) throw new StoreError('a project scope needs a project id', { code: 'sqlite', step: 'store' })
    if (scope === 'session' && !sessionId) throw new StoreError('a session scope needs a session id', { code: 'sqlite', step: 'store' })
    const values = { scope, project_id: scope === 'project' ? String(projectId) : null, session_id: scope === 'session' ? String(sessionId) : null }
    const changed = this.#write(() => Number(this.#prepare('UPDATE memories SET scope = ?, project_id = ?, session_id = ? WHERE id = ?').run(values.scope, values.project_id, values.session_id, String(id)).changes) > 0)
    if (changed) {
      const entry = this.cache?.get(String(id))
      if (entry) Object.assign(entry, values)
    }
    return changed
  }

  /**
   * Memory counts per partition for entity filters (expired included):
   * `[{ scope: 'global'|'project'|'session', project_id, session_id, count }]`.
   */
  partitionCounts(filters = {}) {
    return this.#run('search', () => {
      const where = []
      const params = []
      for (const key of ENTITY_KEYS) {
        const value = filters?.[key]
        if (value === undefined || value === null || value === '' || value === '*') continue
        where.push(`${key} = ?`)
        params.push(String(value))
      }
      // Expired memories are left out, as `list` leaves them out.
      const sql = `SELECT scope, project_id, session_id, expiration_date, COUNT(*) AS n, MAX(COALESCE(updated_at, created_at)) AS newest FROM memories${where.length ? ` WHERE ${where.join(' AND ')}` : ''} GROUP BY scope, project_id, session_id, expiration_date`
      const totals = new Map()
      const now = new Date()
      for (const row of this.db.prepare(sql).iterate(...params)) {
        if (isExpired(row.expiration_date, now)) continue
        const scope = row.scope === 'project' && row.project_id ? 'project' : row.scope === 'session' && row.session_id ? 'session' : 'global'
        const key = scope === 'project' ? `project:${row.project_id}` : scope === 'session' ? `session:${row.session_id}` : 'global'
        // A session memory keeps the project it was written in, for the tree.
        const current = totals.get(key) ?? { scope, project_id: scope !== 'global' && row.project_id ? String(row.project_id) : null, session_id: scope === 'session' ? String(row.session_id) : null, count: 0 }
        current.count += Number(row.n ?? 0)
        // The latest write, so the page can label a session by its time.
        if (row.newest && (!current.newest || String(row.newest) > current.newest)) current.newest = String(row.newest)
        totals.set(key, current)
      }
      return [...totals.values()]
    })
  }

  /** Remember a project's display name (no path, no remote URL). */
  setProject(projectId, { name, kind, aliases } = {}) {
    if (!projectId) return
    const key = `${PROJECT_META_PREFIX}${projectId}`
    let known = []
    try {
      known = JSON.parse(this.getMeta(key) ?? 'null')?.aliases ?? []
    } catch {
      known = []
    }
    // Aliases (the project's repository and folder hashes) only grow: an id
    // seen once keeps being read with the project.
    const merged = [...new Set([...(Array.isArray(known) ? known : []), ...(Array.isArray(aliases) ? aliases : [])].map(String).filter((id) => /^p[0-9a-f]{16}$/.test(id) && id !== String(projectId)))].slice(0, 32)
    const value = JSON.stringify({ name: String(name ?? '').slice(0, 80), kind: kind ?? null, ...(merged.length ? { aliases: merged } : {}) })
    const current = this.getMeta(key)
    if (current === value) return
    this.setMeta(key, value)
  }

  /** Known projects: `{ [projectId]: { name, kind, aliases? } }`. */
  projects() {
    return this.#run('search', () => {
      const out = {}
      for (const row of this.#prepare('SELECT key, value FROM meta WHERE key LIKE ?').iterate(`${PROJECT_META_PREFIX}%`)) {
        try {
          const value = JSON.parse(row.value)
          out[String(row.key).slice(PROJECT_META_PREFIX.length)] = { name: String(value?.name ?? ''), kind: value?.kind ?? null, ...(Array.isArray(value?.aliases) ? { aliases: value.aliases.map(String) } : {}) }
        } catch {
          // ignore a damaged entry
        }
      }
      return out
    })
  }

  /** Delete one memory. Returns false when the id does not exist. */
  delete(id) {
    const removed = this.#write(() => Number(this.#prepare('DELETE FROM memories WHERE id = ?').run(String(id)).changes) > 0)
    if (removed) this.cache?.delete(String(id))
    return removed
  }

  /**
   * Replace every vector (re-embedding after an embedder change) and record
   * the embedder in the same transaction. With `expected` (the rows
   * `allTexts` returned), nothing is written and false comes back when the
   * memories changed meanwhile (another process added, deleted or edited
   * one), so the caller can start over.
   */
  replaceVectors(entries, { model, dims, expected } = {}) {
    const done = this.#write(() => {
      if (Array.isArray(expected)) {
        const now = this.#prepare('SELECT id, text FROM memories').all()
        if (now.length !== expected.length) return false
        const wanted = new Map(expected.map((row) => [String(row.id), String(row.text ?? '')]))
        if (!now.every((row) => wanted.get(String(row.id)) === String(row.text ?? ''))) return false
      }
      const statement = this.#prepare('UPDATE memories SET embedding = ?, embed_model = ?, embed_dims = ? WHERE id = ?')
      for (const { id, vector } of entries) {
        const array = vector instanceof Float32Array ? vector : Float32Array.from(vector)
        statement.run(toBlob(array), model ?? null, array.length, String(id))
      }
      if (model !== undefined || dims !== undefined) {
        const put = this.#prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        put.run('embed_model', String(model ?? ''))
        put.run('embed_dims', String(dims ?? ''))
      }
      return true
    })
    this.cache = undefined
    this.dataVersion = undefined
    return done
  }

  /** id and text of every memory, for re-embedding. */
  allTexts() {
    return this.#run('search', () => this.#prepare('SELECT id, text FROM memories ORDER BY created_at').all().map((row) => ({ id: String(row.id), text: String(row.text ?? '') })))
  }

  // ---- recent messages (mem0 `messages` table) ----------------------------

  /** The last `limit` messages of a session scope, oldest first. */
  lastMessages(sessionScope, limit = RECENT_MESSAGES_LIMIT) {
    return this.#run('search', () =>
      this.#prepare(`SELECT role, content, name, created_at FROM (
          SELECT seq, role, content, name, created_at FROM recent_messages WHERE session_scope = ? ORDER BY seq DESC LIMIT ?
        ) ORDER BY seq ASC`)
        .all(String(sessionScope), Math.max(1, Math.floor(limit)))
        .map((row) => ({ role: row.role, content: row.content, name: row.name ?? null, created_at: row.created_at })),
    )
  }

  /** Append messages to a scope and keep only the newest `limit`. */
  saveMessages(sessionScope, messages, limit = RECENT_MESSAGES_LIMIT) {
    if (!Array.isArray(messages) || messages.length === 0) return
    const now = pyUtcNow(this.now())
    this.#write(() => {
      const insert = this.#prepare('INSERT INTO recent_messages (session_scope, role, content, name, created_at) VALUES (?, ?, ?, ?, ?)')
      for (const message of messages) {
        insert.run(
          String(sessionScope),
          message?.role == null ? null : String(message.role),
          message?.content == null ? null : String(message.content),
          message?.name == null ? null : String(message.name),
          now,
        )
      }
      this.#prepare(`DELETE FROM recent_messages WHERE session_scope = ? AND seq NOT IN (
          SELECT seq FROM recent_messages WHERE session_scope = ? ORDER BY seq DESC LIMIT ?
        )`).run(String(sessionScope), String(sessionScope), Math.max(1, Math.floor(limit)))
    })
  }

  /** SQLite library version (for status). */
  sqliteVersion() {
    return this.#run('search', () => String(this.db.prepare('SELECT sqlite_version() AS v').get()?.v ?? ''))
  }
}

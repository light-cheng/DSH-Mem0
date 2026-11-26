/**
 * The local (OSS) backend, in Node: Mem0 2.2.1's write and read paths over
 * the SQLite store (lib/store-sqlite.js), with your own embedder and
 * extraction LLM (lib/providers.js). No Python, no Qdrant, no telemetry,
 * nothing written to `~/.mem0`.
 *
 * Same interface as the REST client (lib/rest-client.js): `health`,
 * `search`, `add`, `list`, `get`, `update`, `remove`, `startInBackground`,
 * `dispose`, plus `status()` for diagnostics and `reembed()` for an
 * embedder change. Results use the Mem0 item shape, and `add` answers
 * `{ results, summary: { facts, add, update, delete, none, skippedDuplicate } }`.
 *
 * add (infer: true) is Mem0's V3 additive pipeline:
 *   1. the scope's last 10 messages and the 10 most similar memories;
 *   2. one LLM call with the 2.2.1 prompt (lib/extraction.js);
 *   3. the answer parsed like Mem0; an unusable one fails with
 *      `code: LLM_EXTRACT_FAILED` and `extractReason` (lib/memory-lifecycle.js
 *      retries once, with twice the output budget after finish_reason=length);
 *   4. embed the new facts, drop md5 duplicates (of the similar memories
 *      and within the batch), insert; only ADD, never update or delete;
 *   5. remember this turn's messages for the next extraction.
 * Adds to the same scope (user, agent, run) run one after another.
 *
 * Deviations from 2.2.1 in step 1 and 4 (README "Near-duplicate check"):
 *   - `knownIds` (memories `mem0_add` stored this turn) join the similar
 *     memories the LLM sees as existing, even when they are not among the
 *     10 closest;
 *   - a new fact that repeats a `knownIds` memory or an earlier fact of
 *     the same batch is not stored (`summary.skippedSimilar`): cosine at
 *     least `captureTurnDedupThreshold` (default 0.93; 0 = off, md5 only
 *     like upstream), or cosine at least 0.75 with every content token of
 *     the fact in that memory (lib/turn-dedup.js). Upstream only drops
 *     exact md5 duplicates, so a reworded copy of the same fact (the
 *     explicit add, then the capture of the same turn, with the date
 *     written out) was stored twice.
 *   The window is this turn: older memories, however similar, get md5 only.
 *   V3 additive never updates, so a correction ("the trip moved to the week
 *   after") is a new fact close to the old one; compared with older
 *   memories it would be dropped and the new information lost. Reworded
 *   repeats across turns are left to memory hygiene, which merges them.
 *
 * Errors keep the attribution fields FailureHistory reads: `component`
 * (`embedder`, `llm`, `vector_store`), `step`, `provider`, `endpoint`,
 * `code`, `status`, and for extraction `extractReason` / `extractStats`.
 */
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { buildExtractionMessages, describeAnswer, describeStats, extractionMessage, inspectExtraction, outputLimitMessage, parseMessages, RETRYABLE_EXTRACT_REASONS } from './extraction.js'
import { EXTRACT_FAILED_CODE } from './http.js'
import { MEM0_REFERENCE_VERSION } from './mem0-prompts.js'
import { EMBEDDER_MISMATCH_CODE, OssConfigError, readOssConfig, resolveNativeSettings } from './oss-config.js'
import { chatCompletion, embedTexts } from './providers.js'
import { dshExtraction, selectionName, currentDshModel } from './dsh-extraction.js'
import { recallPartitions } from './project-scope.js'
import { repeatsTurnWrite } from './turn-dedup.js'
import { MIGRATION_META_KEY, SCHEMA_VERSION, SqliteStore, StoreError, displayPath, pyUtcNow, storeError } from './store-sqlite.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_ADD_TIMEOUT_MS = 120_000
const DEFAULT_LIST_LIMIT = 100
// Upper bound of one credential lookup (lib/credentials.js uses the same).
const CREDENTIAL_TIMEOUT_MS = 3_000
const PROBE_TEXT = 'dsh-mem0 health probe'
// Ollama unloads a model 5 minutes after its last request by default; a
// recall after a longer pause then waits for the model to load again (2.5 s
// and more on a CPU). Sent as `keep_alive` with every Ollama embedding.
export const DEFAULT_KEEP_ALIVE = '30m'
// Default of `captureTurnDedupThreshold` (this turn's writes only). Measured
// with bge-m3: different facts on one topic said in one turn reach 0.92
// ("uses pnpm" / "uses npm" 0.89, "dark theme" / "light theme" 0.92), so the
// plain cosine rule stays above them; rewordings below it (0.84–0.92, date
// written out, sentence split) are left to the coverage rule. See
// lib/turn-dedup.js.
export const DEFAULT_DEDUP_THRESHOLD = 0.93
const IDENTITY_KEYS = new Set(['user_id', 'agent_id', 'run_id', 'actor_id'])
const ROLES = new Set(['user', 'assistant', 'system'])

export class NativeClientError extends Error {
  constructor(message, { code = 'DSH_MEM0_ERROR', status, component, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'NativeClientError'
    this.code = code
    if (Number.isInteger(status)) this.status = status
    if (component) this.component = component
  }
}

export const md5 = (text) => createHash('md5').update(String(text), 'utf8').digest('hex')

/** Whether a base URL names this computer (a local model server). */
export function isLocalUrl(url) {
  return /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:[/?#]|$)/i.test(String(url ?? '').trim())
}

function cosine(left, right) {
  let product = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    product += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  return leftNorm > 0 && rightNorm > 0 ? product / Math.sqrt(leftNorm * rightNorm) : 0
}

/** The configured near-duplicate threshold: 0 (off) or a cosine in (0, 1]. */
export function dedupThreshold(config) {
  const value = Number(config?.captureTurnDedupThreshold ?? DEFAULT_DEDUP_THRESHOLD)
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0
}

/**
 * The partition columns of an add: `scope` global (default), project (needs
 * `projectId`) or session (needs `sessionId`). A project or session add
 * without its id is stored as global.
 */
function partitionFor(options) {
  if (options.scope === 'project' && options.projectId) return { scope: 'project', projectId: String(options.projectId) }
  if (options.scope === 'session' && options.sessionId) {
    return { scope: 'session', sessionId: String(options.sessionId), ...(options.projectId ? { projectId: String(options.projectId) } : {}) }
  }
  return { scope: 'global' }
}

/** The partitions an add of `partition` is recalled with (global + its own). */
function readPartitionsFor(partition) {
  return recallPartitions({ projectId: partition.projectId, sessionId: partition.scope === 'session' ? partition.sessionId : undefined })
}

/** mem0 `_build_session_scope`: sorted entity ids, `%`, `&`, `=` escaped. */
export function sessionScope(filters) {
  const escape = (value) => String(value).replace(/%/g, '%25').replace(/&/g, '%26').replace(/=/g, '%3D')
  return ['agent_id', 'run_id', 'user_id']
    .filter((key) => filters?.[key])
    .map((key) => `${key}=${escape(filters[key])}`)
    .join('&')
}

function entityFilters({ userId, agentId, runId }) {
  const out = {}
  if (userId) out.user_id = String(userId).trim()
  if (agentId) out.agent_id = String(agentId).trim()
  if (runId) out.run_id = String(runId).trim()
  return out
}

function withoutIdentity(metadata) {
  const out = {}
  for (const [key, value] of Object.entries(metadata ?? {})) if (!IDENTITY_KEYS.has(key)) out[key] = value
  return out
}

function normalizeMessages(messages) {
  const list = typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages
  if (!Array.isArray(list) || list.length === 0) {
    throw new NativeClientError('messages must be a non-empty list or string', { code: 'INVALID_REQUEST', status: 400 })
  }
  for (const message of list) {
    if (!message || typeof message !== 'object' || typeof message.content !== 'string') {
      throw new NativeClientError('each message must be an object with a string content field', { code: 'INVALID_REQUEST', status: 400 })
    }
    if (!ROLES.has(message.role)) {
      throw new NativeClientError('each message role must be user, assistant or system', { code: 'INVALID_REQUEST', status: 400 })
    }
  }
  return list
}

function abortedError(signal) {
  return new NativeClientError('dsh-mem0: request aborted', { code: 'ABORTED', cause: signal?.reason })
}

function parseJson(text) {
  if (!text) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function settingsKey(file) {
  try {
    const stat = fs.statSync(file)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

export class Mem0NativeClient {
  /**
   * @param {object} options
   * @param {object} options.config resolved config (lib/config.js).
   * @param {(ref: string) => Promise<string|undefined>} [options.resolveSecret] DSH credential lookup.
   * @param {() => object} [options.loadSettings] full local settings (default: oss.json + config.nativeValues).
   * @param {SqliteStore} [options.store] tests.
   */
  constructor(options = {}) {
    const config = options.config ?? {}
    this.config = config
    this.userId = options.userId ?? config.userId
    this.agentId = options.agentId ?? config.agentId
    this.logger = options.logger
    this.requestTimeoutMs = options.requestTimeoutMs ?? config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.addTimeoutMs = options.addTimeoutMs ?? config.addTimeoutMs ?? DEFAULT_ADD_TIMEOUT_MS
    this.resolveSecretFn = options.resolveSecret ?? (async (ref) => process.env[ref])
    this.fetchImpl = options.fetchImpl
    // DSH's model services `{ llm, agentDefaultModel }` (or a getter for
    // them: DSH injects them after startup), for llmProvider 'dsh'.
    this.llmServicesFn = typeof options.llmServices === 'function' ? options.llmServices : () => options.llmServices ?? null
    this.now = options.now ?? (() => new Date())
    this.ossConfigPath = config.ossConfigPath
    this.loadSettingsFn = options.loadSettings ?? (() => resolveNativeSettings(config.nativeValues ?? {}, this.ossConfigPath ? readOssConfig(this.ossConfigPath) : undefined))
    this.fixedStore = options.store
    this.store = options.store
    this.settingsCache = undefined
    this.onReady = options.onReady
    this.readyNotified = false
    this.disposed = false
    this.queues = new Map()
    this.startTimer = undefined
    this.lastStartFailure = null
    this.lastExtraction = null
    this.lastWarmUp = null
    this.warmUpOnStart = options.warmUpOnStart ?? true
  }

  // ---- settings and store -------------------------------------------------

  /** Current settings; re-read when oss.json changes. */
  settings() {
    const key = this.ossConfigPath ? settingsKey(this.ossConfigPath) : 'fixed'
    if (this.settingsCache && this.settingsCache.key === key) return this.settingsCache.value
    const value = this.loadSettingsFn()
    this.settingsCache = { key, value }
    return value
  }

  #store() {
    if (this.disposed) throw new NativeClientError('dsh-mem0: client has been disposed', { code: 'DISPOSED' })
    if (this.fixedStore) {
      this.fixedStore.open()
      return this.fixedStore
    }
    const { storePath } = this.settings()
    if (this.store && this.store.filePath !== storePath) {
      this.store.close()
      this.store = undefined
    }
    if (!this.store) this.store = new SqliteStore({ filePath: storePath, logger: this.logger, now: this.now })
    try {
      this.store.open()
    } catch (error) {
      this.#recordStartFailure(error)
      throw error
    }
    if (this.lastStartFailure) this.lastStartFailure = null
    this.#notifyReady()
    return this.store
  }

  #recordStartFailure(error) {
    this.lastStartFailure = {
      at: this.now().toISOString(),
      code: typeof error?.code === 'string' ? error.code : 'sqlite',
      component: error?.component ?? 'vector_store',
      reason: String(error?.message ?? error),
      ...(error?.endpoint ? { endpoint: error.endpoint } : {}),
      ...(error?.configError ? { configError: true } : {}),
    }
  }

  #notifyReady() {
    if (this.readyNotified) return
    this.readyNotified = true
    try {
      this.onReady?.()
    } catch (error) {
      this.logger?.debug?.(`dsh-mem0: onReady failed: ${error?.message}`)
    }
  }

  /** A config problem of `component` as an error, or undefined. */
  #problem(component) {
    const problem = this.settings().problems?.find((item) => item.component === component)
    if (!problem) return undefined
    return new OssConfigError(`dsh-mem0: ${problem.message}`, { code: problem.code, component })
  }

  async #secret(ref, literal, { timeoutMs } = {}) {
    if (ref) {
      try {
        const value = await this.resolveSecretFn(ref, Number.isFinite(timeoutMs) ? { timeoutMs: Math.max(1, Math.min(CREDENTIAL_TIMEOUT_MS, timeoutMs)) } : {})
        if (typeof value === 'string' && value.trim()) return value.trim()
      } catch (error) {
        this.logger?.debug?.(`dsh-mem0: credential lookup for ${ref} failed: ${error?.message ?? error}`)
      }
    }
    return literal || undefined
  }

  /**
   * The store's vectors come from another embedder: a config error (the
   * vectors must be recomputed, or the embedder switched back).
   */
  #checkEmbedder(store, embedder, dims) {
    const info = store.embedderInfo()
    if (!info) return
    const modelDiffers = info.model && embedder.model && info.model !== embedder.model
    const dimsDiffer = info.dims && Number.isInteger(dims) && info.dims !== dims
    if (!modelDiffers && !dimsDiffer) return
    // Nothing is stored any more: the new embedder simply takes over.
    if (store.count({}) === 0) {
      store.setEmbedderInfo({ model: embedder.model, dims: Number.isInteger(dims) ? dims : info.dims })
      return
    }
    const error = new OssConfigError(
      `dsh-mem0: the memory store holds vectors of embedder ${info.model ?? '?'} (${info.dims ?? '?'} dims), ` +
        `but the configured embedder is ${embedder.model}${Number.isInteger(dims) ? ` (${dims} dims)` : ''}. ` +
        'Switch back to that embedder, or recompute the vectors (settings page).',
      { code: EMBEDDER_MISMATCH_CODE, component: 'embedder' },
    )
    error.storedEmbedder = { ...info }
    throw error
  }

  /**
   * Embed `texts`. With `store`, the store's embedder meta is compared with
   * the configured model (and dims, when set) first, so a mismatch costs no
   * embedding call. The credential lookup counts against `timeoutMs`.
   */
  async #embed(texts, { signal, timeoutMs, store, timings } = {}) {
    const problem = this.#problem('embedder')
    if (problem) throw problem
    const { embedder } = this.settings()
    if (store) this.#checkEmbedder(store, embedder, embedder.dims)
    const started = Date.now()
    const apiKey = await this.#secret(embedder.apiKeyRef, embedder.apiKey, { timeoutMs })
    const looked = Date.now()
    if (timings) timings.credentialMs = looked - started
    if (signal?.aborted) throw abortedError(signal)
    const left = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs - (looked - started)) : timeoutMs
    try {
      return await embedTexts(this.#embedderSettings(embedder), texts, { apiKey, signal, timeoutMs: left, fetchImpl: this.fetchImpl })
    } finally {
      if (timings) timings.embedMs = Date.now() - looked
    }
  }

  /** The embedder settings as sent: Ollama also gets `keep_alive`. */
  #embedderSettings(embedder) {
    if (embedder.provider !== 'ollama') return embedder
    const keepAlive = typeof this.config.embedderKeepAlive === 'string' ? this.config.embedderKeepAlive : DEFAULT_KEEP_ALIVE
    return keepAlive ? { ...embedder, keepAlive } : embedder
  }

  /**
   * Load the embedding model of a local server (Ollama, LM Studio, omlx on
   * this computer) with one probe, so the first recall does not wait for
   * a cold start. Cloud APIs are never called. Never throws.
   */
  async warmUp({ timeoutMs = 60_000 } = {}) {
    if (this.disposed) return { warmed: false, reason: 'disposed' }
    let embedder
    try {
      if (this.#problem('embedder')) return { warmed: false, reason: 'not-configured' }
      embedder = this.settings().embedder
    } catch {
      return { warmed: false, reason: 'not-configured' }
    }
    if (!isLocalUrl(embedder.baseUrl)) return { warmed: false, reason: 'cloud' }
    const timings = {}
    const started = Date.now()
    try {
      await this.#embed([PROBE_TEXT], { timeoutMs, timings })
      this.lastWarmUp = { at: this.now().toISOString(), ok: true, ms: Date.now() - started }
    } catch (error) {
      this.lastWarmUp = { at: this.now().toISOString(), ok: false, ms: Date.now() - started, error: String(error?.message ?? error).slice(0, 240) }
      this.logger?.debug?.(`dsh-mem0: embedder warm-up failed: ${error?.message ?? error}`)
    }
    return { warmed: this.lastWarmUp.ok, ms: this.lastWarmUp.ms }
  }

  /** After an await outside the add queue: stop when the client was disposed meanwhile. */
  #alive() {
    if (this.disposed) throw new NativeClientError('dsh-mem0: client has been disposed', { code: 'DISPOSED' })
  }

  /** Record the embedder of the first vectors of a store. */
  #rememberEmbedder(store, dims) {
    const { embedder } = this.settings()
    if (store.embedderInfo()) return
    store.setEmbedderInfo({ model: embedder.model, dims })
  }

  // ---- lifecycle ----------------------------------------------------------

  /** Open the store (and warm its vector cache) without blocking the caller. */
  startInBackground() {
    if (this.disposed || this.startTimer) return
    const timer = setTimeout(() => {
      this.startTimer = undefined
      if (this.disposed) return
      try {
        const store = this.#store()
        store.searchVectors(new Float32Array(1), {}, 0)
      } catch (error) {
        this.logger?.warn?.(`dsh-mem0: local memory store could not be opened: ${error.message}`)
      }
      // Load a local embedding model now, not on the first recall.
      if (this.warmUpOnStart) void this.warmUp()
    }, 0)
    timer.unref?.()
    this.startTimer = timer
  }

  status() {
    const settings = (() => {
      try {
        return this.settings()
      } catch {
        return undefined
      }
    })()
    return {
      running: Boolean(this.store?.db),
      store: settings ? { kind: 'sqlite', path: displayPath(settings.storePath) } : null,
      lastStartFailure: this.lastStartFailure ? { ...this.lastStartFailure } : null,
      lastExtraction: this.lastExtraction ? { ...this.lastExtraction } : null,
      // llmProvider 'dsh': the model the next extraction would use, now.
      ...(settings?.llm?.provider === 'dsh' ? { dshModel: currentDshModel(this.llmServicesFn())?.name ?? null } : {}),
      lastWarmUp: this.lastWarmUp ? { ...this.lastWarmUp } : null,
    }
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = undefined
    // Wait for adds in flight so a write is not cut between LLM and insert.
    // With none, the store closes before dispose() returns (no await), so
    // the caller can delete or move the file right away: Windows refuses to
    // remove a file that is still open (EPERM).
    const pending = [...this.queues.values()]
    if (pending.length > 0) await Promise.allSettled(pending)
    if (!this.fixedStore) this.store?.close()
    this.store = undefined
  }

  // ---- reads --------------------------------------------------------------

  async health({ signal, timeoutMs } = {}) {
    const settings = this.settings()
    const out = {
      ok: false,
      backend: 'oss',
      engine: 'native',
      mem0Reference: MEM0_REFERENCE_VERSION,
      nodeVersion: process.versions.node,
      userId: this.userId,
      agentId: this.agentId,
      memoryCount: 0,
      store: { ok: false, kind: 'sqlite', path: displayPath(settings.storePath), error: null },
      embedder: { ok: false, dimensions: null, model: settings.embedder.model || null, provider: settings.embedder.provider, error: null },
      llm: settings.llm.provider === 'dsh'
        ? (() => {
            const current = currentDshModel(this.llmServicesFn())
            return { configured: Boolean(current), provider: 'dsh', followsDsh: true, model: current?.name ?? null, error: this.#problem('llm')?.message ?? (current ? null : 'no model is selected in DSH') }
          })()
        : {
            configured: Boolean(settings.llm.model && settings.llm.baseUrl),
            model: settings.llm.model || null,
            error: this.#problem('llm')?.message ?? null,
          },
    }
    let store
    try {
      store = this.#store()
      out.memoryCount = store.count({ user_id: this.userId })
      out.store.ok = true
      out.store.sqliteVersion = store.sqliteVersion()
      out.store.schemaVersion = SCHEMA_VERSION
      const info = store.embedderInfo()
      if (info) out.store.embedder = info
      const migration = parseJson(store.getMeta(MIGRATION_META_KEY))
      if (migration) out.store.migration = { at: migration.at ?? null, endpoint: migration.endpoint ?? null, collection: migration.collection ?? null, imported: Number(migration.imported ?? 0) }
    } catch (error) {
      out.store.error = String(error?.message ?? error)
    }
    try {
      const [vector] = await this.#embed([PROBE_TEXT], { signal, timeoutMs: timeoutMs ?? 5_000, store })
      out.embedder.dimensions = vector.length
      this.#alive()
      if (store) this.#checkEmbedder(store, settings.embedder, vector.length)
      out.embedder.ok = true
    } catch (error) {
      out.embedder.error = String(error?.message ?? error)
    }
    // Earlier settings pages read `qdrant` for the store row.
    out.qdrant = { ok: out.store.ok, error: out.store.error }
    out.ok = out.store.ok && out.embedder.ok
    return out
  }

  async search(query, filters, options = {}) {
    if (typeof query !== 'string' || !query.trim()) {
      throw new NativeClientError('query is required', { code: 'INVALID_REQUEST', status: 400 })
    }
    const scope = filters && typeof filters === 'object' ? filters : { user_id: this.userId }
    // Where the time goes, filled as each step ends (also when one fails):
    // `openMs` store, `credentialMs` key lookup, `embedMs` embedding call,
    // `searchMs` SQLite vector scan and scoring. A caller's `timings`
    // object is filled in place, so a timeout still says which step hung.
    const timings = options.timings && typeof options.timings === 'object' ? options.timings : {}
    let started = Date.now()
    const store = this.#store()
    timings.openMs = Date.now() - started
    const [vector] = await this.#embed([query], { signal: options.signal, timeoutMs: options.timeoutMs ?? this.requestTimeoutMs, store, timings })
    this.#alive()
    this.#checkEmbedder(store, this.settings().embedder, vector.length)
    if (options.signal?.aborted) throw abortedError(options.signal)
    const topK = Number.isInteger(options.topK) && options.topK > 0 ? options.topK : 5
    const threshold = Number.isFinite(options.threshold) ? options.threshold : 0.1
    started = Date.now()
    const results = store.search(vector, scope, { topK, threshold, partitions: options.partitions })
    timings.searchMs = Date.now() - started
    return { results, timings: { ...timings } }
  }

  async list(filters, options = {}) {
    const scope = filters && Object.values(filters).some((value) => value) ? filters : { user_id: this.userId }
    const limit = Number.isInteger(options.topK) && options.topK > 0 ? options.topK : DEFAULT_LIST_LIMIT
    return { results: this.#store().list(scope, { limit, partitions: options.partitions }) }
  }

  async get(memoryId) {
    return this.#store().get(String(memoryId))
  }

  // ---- writes -------------------------------------------------------------

  /** Run `task` after every earlier add of the same scope. */
  #serial(scopeKey, task) {
    const previous = this.queues.get(scopeKey) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(task)
    const tail = run.catch(() => {})
    this.queues.set(scopeKey, tail)
    void tail.then(() => {
      if (this.queues.get(scopeKey) === tail) this.queues.delete(scopeKey)
    })
    return run
  }

  async add(messages, options = {}) {
    if (this.disposed) throw new NativeClientError('dsh-mem0: client has been disposed', { code: 'DISPOSED' })
    const list = normalizeMessages(messages)
    const filters = entityFilters({ userId: options.userId ?? this.userId, agentId: options.agentId ?? this.agentId, runId: options.runId })
    const metadata = { ...withoutIdentity(options.metadata && typeof options.metadata === 'object' ? options.metadata : {}), ...filters }
    const infer = options.infer !== false
    const partition = partitionFor(options)
    const budget = options.timeoutMs ?? this.addTimeoutMs
    return this.#serial(sessionScope(filters), () => {
      // The budget starts when this add runs, not while it waits behind an
      // earlier add of the same scope.
      const deadline = Date.now() + budget
      const remaining = () => Math.max(1, deadline - Date.now())
      return infer
        ? this.#addInferred(list, filters, metadata, { ...options, partition, remaining })
        : this.#addRaw(list, metadata, { ...options, partition, remaining })
    })
  }

  /** infer: false — each message stored verbatim (mem0 `_add_to_vector_store`). */
  async #addRaw(messages, metadata, { signal, remaining, partition }) {
    const kept = messages.filter((message) => message.role !== 'system')
    if (kept.length === 0) return { results: [] }
    const store = this.#store()
    const vectors = await this.#embed(kept.map((message) => message.content), { signal, timeoutMs: remaining(), store })
    this.#checkEmbedder(store, this.settings().embedder, vectors[0].length)
    if (signal?.aborted) throw abortedError(signal)
    const records = kept.map((message, index) => {
      const payload = { ...metadata, role: message.role }
      if (message.name) payload.actor_id = message.name
      return { id: randomUUID(), text: message.content, hash: md5(message.content), vector: vectors[index], payload, embedModel: this.settings().embedder.model, ...partition }
    })
    store.insert(records)
    this.#rememberEmbedder(store, vectors[0].length)
    return {
      results: records.map((record, index) => ({
        id: record.id,
        memory: record.text,
        event: 'ADD',
        actor_id: kept[index].name ?? null,
        role: kept[index].role,
      })),
    }
  }

  /**
   * A gateway's non-2xx "cut at its output budget" answer (lib/providers.js
   * matchOutputLimit) as the extraction failure it is: reason `truncated`,
   * finish_reason=length with the max_tokens sent, so the capture retries
   * once with twice the budget and the breaker does not count it. Nothing
   * was written yet (the store is only read before the LLM call), so the
   * retry cannot duplicate a memory. The gateway's words stay in `detail`.
   */
  #outputLimitError(cause) {
    const stats = { finishReason: 'length', ...(Number.isInteger(cause.outputLimit.maxTokens) ? { maxTokens: cause.outputLimit.maxTokens } : {}) }
    const detail = typeof cause.detail === 'string' ? cause.detail : ''
    this.lastExtraction = { at: this.now().toISOString(), ...stats, ok: false, reason: 'truncated', status: cause.status, ...(detail ? { detail } : {}) }
    this.logger?.warn?.(`dsh-mem0: LLM extraction failed (truncated; HTTP ${cause.status}: ${detail || 'no detail'}; ${describeStats(stats)}); nothing was stored`)
    const error = new NativeClientError(`dsh-mem0: ${outputLimitMessage(stats.maxTokens, cause.status)}`, { code: EXTRACT_FAILED_CODE, status: 502, component: 'llm', cause })
    error.step = 'llm_extract'
    error.provider = 'openai'
    if (cause.endpoint) error.endpoint = cause.endpoint
    error.extractReason = 'truncated'
    error.retryable = true
    error.extractStats = stats
    if (detail) error.detail = detail
    return error
  }

  /** infer: true — the V3 additive pipeline. */
  async #addInferred(messages, filters, metadata, { signal, remaining, llmMaxTokens, partition, readPartitions, knownIds }) {
    const llmProblem = this.#problem('llm')
    if (llmProblem) throw llmProblem
    const store = this.#store()
    const settings = this.settings()
    const scope = sessionScope(filters)
    const lastMessages = store.lastMessages(scope)
    const parsed = parseMessages(messages)
    const [queryVector] = await this.#embed([parsed], { signal, timeoutMs: remaining(), store })
    this.#checkEmbedder(store, settings.embedder, queryVector.length)
    // Similar memories (the LLM's context and the duplicate check) come from
    // the partitions this memory will be recalled with: a project fact that
    // repeats a global one is not stored again.
    const partitions = readPartitions ?? readPartitionsFor(partition)
    const similar = store.searchVectors(queryVector, filters, 10, { partitions })
    // Deviation: what mem0_add stored this turn is existing memory too.
    const knownRows = (Array.isArray(knownIds) ? knownIds : [])
      .map((id) => String(id))
      .filter((id, index, list) => id && list.indexOf(id) === index)
      .map((id) => store.getRaw(id))
      .filter((row) => row && row.text)
    const known = knownRows.filter((row) => !similar.some((hit) => String(hit.row.id) === String(row.id)))
    const existingMemories = [...similar.map(({ row }) => row), ...known].map((row, index) => ({ id: String(index), text: row.text ?? '' }))
    const prompt = buildExtractionMessages({
      newMessages: parsed,
      existingMemories,
      lastMessages,
      agentScoped: Boolean(filters.agent_id) && !filters.user_id,
      now: this.now(),
    })
    let content
    let stats
    if (settings.llm.provider === 'dsh') {
      // DSH's current model, read now: a model changed in DSH applies from
      // the next call on. DSH holds the address and the key.
      if (signal?.aborted) throw abortedError(signal)
      let answer
      try {
        answer = await dshExtraction(this.llmServicesFn(), prompt, { maxTokens: llmMaxTokens ?? settings.llm.maxTokens, signal, timeoutMs: remaining() })
      } catch (error) {
        if (signal?.aborted) throw abortedError(signal)
        this.lastExtraction = { at: this.now().toISOString(), via: 'dsh', ...(error.model ? { model: error.model } : {}), ok: false, code: error.dshCode ?? error.code }
        throw error
      }
      ;({ content, stats } = answer)
      this.lastExtraction = { at: this.now().toISOString(), via: 'dsh', model: selectionName(answer.selection), ...stats }
    } else {
      const apiKey = await this.#secret(settings.llm.apiKeyRef, settings.llm.apiKey, { timeoutMs: remaining() })
      if (signal?.aborted) throw abortedError(signal)
      try {
        ;({ content, stats } = await chatCompletion(settings.llm, prompt, {
          apiKey,
          maxTokens: llmMaxTokens,
          signal,
          timeoutMs: remaining(),
          fetchImpl: this.fetchImpl,
        }))
      } catch (error) {
        if (signal?.aborted) throw abortedError(signal)
        if (error?.outputLimit) throw this.#outputLimitError(error)
        // The server answered with an error: the status line says so.
        if (Number.isInteger(error?.status)) {
          this.lastExtraction = { at: this.now().toISOString(), ok: false, code: error.code, status: error.status }
        }
        throw error
      }
      this.lastExtraction = { at: this.now().toISOString(), ...stats }
    }
    const { facts, reason } = inspectExtraction(content, stats)
    if (settings.llm.provider === 'dsh') this.lastExtraction = { ...this.lastExtraction, ok: facts !== null && !reason, facts: Array.isArray(facts) ? facts.length : 0, ...(reason ? { reason } : {}) }
    if (facts === null || reason) {
      // Mem0 stores nothing then. The turn is remembered only when the
      // failure will not be retried, so a retry does not repeat it.
      if (!RETRYABLE_EXTRACT_REASONS.includes(reason)) store.saveMessages(scope, messages)
      this.logger?.warn?.(`dsh-mem0: LLM extraction failed (${reason}; answer ${describeAnswer(content)}; ${describeStats(stats)}); nothing was stored`)
      const error = new NativeClientError(`dsh-mem0: ${extractionMessage(reason)}`, { code: EXTRACT_FAILED_CODE, status: 502, component: 'llm' })
      error.step = 'llm_extract'
      error.provider = settings.llm.provider === 'dsh' ? 'dsh' : 'openai'
      error.extractReason = reason
      error.retryable = RETRYABLE_EXTRACT_REASONS.includes(reason)
      if (Object.keys(stats).length > 0) error.extractStats = { ...stats }
      throw error
    }
    if (stats.finishReason === 'length') {
      this.logger?.warn?.(`dsh-mem0: LLM extraction hit its output budget (${describeStats(stats)}) but the answer was usable`)
    }
    const summary = { facts: facts.length, add: 0, update: 0, delete: 0, none: 0, skippedDuplicate: 0, skippedSimilar: 0 }
    const texts = [...new Set(facts.map((item) => (item && typeof item === 'object' ? item.text : undefined)).filter((text) => typeof text === 'string' && text))]
    let vectorMap = new Map()
    if (texts.length > 0) {
      const vectors = await this.#embed(texts, { signal, timeoutMs: remaining() })
      vectorMap = new Map(texts.map((text, index) => [text, vectors[index]]))
    }
    // As mem0 2.2.1 (mem0/memory/main.py 1008-1026): duplicates are only
    // looked for among the 10 similar memories retrieved above (same
    // user_id/agent_id/run_id) and within this batch, not the whole scope.
    const existingHashes = new Set([...similar.map(({ row }) => row), ...knownRows].map((row) => row.hash).filter(Boolean))
    const threshold = dedupThreshold(this.config)
    const knownIdList = knownRows.map((row) => String(row.id))
    const knownText = new Map(knownRows.map((row) => [String(row.id), row.text]))
    // Deviation: compared with this turn's writes only (its explicit adds and
    // the facts kept before it in this batch); never with older memories,
    // so a correction of an older fact is still stored.
    const nearDuplicate = (text, vector, kept) => {
      if (!threshold) return false
      const candidates = [
        ...store.scoreIds(knownIdList, vector).map(({ id, score }) => ({ text: knownText.get(id), score })),
        ...kept.map((record) => ({ text: record.text, score: cosine(record.vector, vector) })),
      ]
      return repeatsTurnWrite(text, candidates, threshold)
    }
    const seen = new Set()
    const records = []
    const createdAt = typeof metadata.created_at === 'string' && metadata.created_at ? metadata.created_at : pyUtcNow(this.now())
    for (const item of facts) {
      const text = item && typeof item === 'object' ? item.text : undefined
      if (typeof text !== 'string' || !text || !vectorMap.has(text)) continue
      const hash = md5(text)
      if (existingHashes.has(hash) || seen.has(hash)) {
        summary.skippedDuplicate += 1
        continue
      }
      if (nearDuplicate(text, vectorMap.get(text), records)) {
        summary.skippedSimilar += 1
        continue
      }
      seen.add(hash)
      const payload = { ...metadata, created_at: createdAt, updated_at: createdAt }
      if (typeof item.attributed_to === 'string' && item.attributed_to) payload.attributed_to = item.attributed_to
      records.push({ id: randomUUID(), text, hash, vector: vectorMap.get(text), payload, embedModel: settings.embedder.model, ...partition })
    }
    if (signal?.aborted) throw abortedError(signal)
    if (records.length > 0) {
      store.insert(records)
      this.#rememberEmbedder(store, records[0].vector.length)
    }
    store.saveMessages(scope, messages)
    summary.add = records.length
    summary.none = Math.max(0, summary.facts - summary.add)
    return { results: records.map((record) => ({ id: record.id, memory: record.text, event: 'ADD' })), summary }
  }

  /** mem0 `update`: text and/or metadata; identity keys ignored; re-embeds. */
  async update(memoryId, update = {}, options = {}) {
    const hasText = typeof update.text === 'string'
    const hasMetadata = update.metadata && typeof update.metadata === 'object'
    const hasExpiration = Object.hasOwn(update, 'expiration_date')
    if (!hasText && !hasMetadata && !hasExpiration) {
      throw new NativeClientError('update requires at least one of text, metadata, expiration_date', { code: 'INVALID_REQUEST', status: 400 })
    }
    const store = this.#store()
    const row = store.getRaw(memoryId)
    if (!row) throw new NativeClientError(`dsh-mem0: memory not found: ${memoryId}`, { code: 'NOT_FOUND', status: 404 })
    const text = hasText ? update.text : row.text
    // mem0 re-embeds on every update, metadata-only included.
    const [vector] = await this.#embed([text], { signal: options.signal, timeoutMs: options.timeoutMs ?? this.requestTimeoutMs, store })
    this.#alive()
    this.#checkEmbedder(store, this.settings().embedder, vector.length)
    if (options.signal?.aborted) throw abortedError(options.signal)
    const metadata = hasMetadata ? withoutIdentity(update.metadata) : undefined
    const expirationDate = hasExpiration
      ? (update.expiration_date === null || update.expiration_date === '' ? null : String(update.expiration_date).slice(0, 10))
      : undefined
    if (metadata) {
      for (const key of ['role', 'attributed_to', 'expiration_date']) delete metadata[key]
    }
    const ok = store.update(memoryId, {
      text,
      hash: md5(text),
      metadata,
      expirationDate,
      vector,
      embedModel: this.settings().embedder.model,
      updatedAt: pyUtcNow(this.now()),
    })
    if (!ok) throw new NativeClientError(`dsh-mem0: memory not found: ${memoryId}`, { code: 'NOT_FOUND', status: 404 })
    return { message: 'Memory updated successfully!' }
  }

  /**
   * Pin or unpin a memory, or set its hygiene importance (1–5). Neither
   * re-embeds nor changes updated_at (lib/store-sqlite.js setAttributes).
   */
  async setAttributes(memoryId, attributes = {}) {
    const changed = this.#store().setAttributes(String(memoryId), attributes)
    if (!changed) throw new NativeClientError(`dsh-mem0: memory not found: ${memoryId}`, { code: 'NOT_FOUND', status: 404 })
    return { message: 'Memory updated successfully!' }
  }

  /** Move a memory to another partition (text, vector and updated_at unchanged). */
  async setScope(memoryId, { scope, projectId, sessionId } = {}) {
    const changed = this.#store().setScope(String(memoryId), { scope, projectId, sessionId })
    if (!changed) throw new NativeClientError(`dsh-mem0: memory not found: ${memoryId}`, { code: 'NOT_FOUND', status: 404 })
    return { message: 'Memory updated successfully!' }
  }

  /** Memory counts per partition (lib/store-sqlite.js partitionCounts). */
  async partitionCounts(filters) {
    const scope = filters && Object.values(filters).some((value) => value) ? filters : { user_id: this.userId }
    return this.#store().partitionCounts(scope)
  }

  /** Remember a project's display name; known projects. */
  setProject(projectId, info) {
    try {
      this.#store().setProject(projectId, info)
    } catch (error) {
      this.logger?.debug?.(`dsh-mem0: could not record the project name: ${error.message}`)
    }
  }

  async projects() {
    return this.#store().projects()
  }

  /** Memories close to a stored one by its stored vector (no embedding call). */
  async neighbors(memoryId, filters, options = {}) {
    const scope = filters && typeof filters === 'object' ? filters : { user_id: this.userId }
    return this.#store().neighbors(String(memoryId), scope, options)
  }

  async remove(memoryId) {
    const removed = this.#store().delete(String(memoryId))
    if (!removed) throw new NativeClientError(`dsh-mem0: memory not found: ${memoryId}`, { code: 'NOT_FOUND', status: 404 })
    return { message: 'Memory deleted successfully!' }
  }

  /**
   * Recompute every vector with the configured embedder (after switching
   * embedder model or dimension). Text is not touched. For the settings
   * page; `onProgress(done, total)`.
   */
  async reembed({ signal, batchSize = 32, onProgress, attempts = 3 } = {}) {
    const store = this.#store()
    const { embedder } = this.settings()
    // Vectors computed in an earlier attempt, by id: a retry recomputes only
    // memories that are new or whose text changed meanwhile.
    const computed = new Map()
    this.lastReembed = { computed: 0, reused: 0 }
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const rows = store.allTexts()
      const entries = []
      const pending = []
      for (const row of rows) {
        const earlier = computed.get(row.id)
        if (earlier && earlier.text === row.text) {
          entries.push({ id: row.id, vector: earlier.vector })
          this.lastReembed.reused += 1
        } else pending.push(row)
      }
      if (entries.length > 0) onProgress?.(entries.length, rows.length)
      for (let start = 0; start < pending.length; start += batchSize) {
        if (signal?.aborted) throw abortedError(signal)
        const batch = pending.slice(start, start + batchSize)
        const vectors = await this.#embed(batch.map((row) => row.text || ' '), { signal, timeoutMs: this.requestTimeoutMs })
        this.#alive()
        // Float32Array per vector: 20 000 memories × 1024 dims stay ~80 MB.
        batch.forEach((row, index) => {
          const vector = Float32Array.from(vectors[index])
          computed.set(row.id, { text: row.text, vector })
          entries.push({ id: row.id, vector })
        })
        this.lastReembed.computed += batch.length
        onProgress?.(entries.length, rows.length)
      }
      if (signal?.aborted) throw abortedError(signal)
      let dims = entries[0]?.vector.length
      if (!dims) dims = (await this.#embed([PROBE_TEXT], { signal, timeoutMs: this.requestTimeoutMs }))[0].length
      this.#alive()
      // Vectors and embedder meta in one transaction, and only when no
      // memory was added, deleted or edited while we embedded; otherwise again.
      const written = store.replaceVectors(entries, { model: embedder.model, dims, expected: rows })
      if (written) return { updated: entries.length, model: embedder.model, dims: dims ?? null }
      this.logger?.debug?.(`dsh-mem0: memories changed while re-embedding (attempt ${attempt}); starting over`)
    }
    throw new NativeClientError('dsh-mem0: memories kept changing while the vectors were recomputed; try again when DSH is idle', { code: 'REEMBED_CONFLICT', component: 'vector_store' })
  }
}

export { StoreError, storeError }

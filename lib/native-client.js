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
 * Errors keep the attribution fields FailureHistory reads: `component`
 * (`embedder`, `llm`, `vector_store`), `step`, `provider`, `endpoint`,
 * `code`, `status`, and for extraction `extractReason` / `extractStats`.
 */
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { buildExtractionMessages, describeAnswer, describeStats, extractionMessage, inspectExtraction, parseMessages, RETRYABLE_EXTRACT_REASONS } from './extraction.js'
import { EXTRACT_FAILED_CODE } from './http.js'
import { MEM0_REFERENCE_VERSION } from './mem0-prompts.js'
import { EMBEDDER_MISMATCH_CODE, OssConfigError, readOssConfig, resolveNativeSettings } from './oss-config.js'
import { chatCompletion, embedTexts } from './providers.js'
import { SCHEMA_VERSION, SqliteStore, StoreError, displayPath, pyUtcNow, storeError } from './store-sqlite.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_ADD_TIMEOUT_MS = 120_000
const DEFAULT_LIST_LIMIT = 100
const PROBE_TEXT = 'dsh-mem0 health probe'
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
    this.lastStartFailure = null
    this.lastExtraction = null
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

  async #secret(ref, literal) {
    if (ref) {
      try {
        const value = await this.resolveSecretFn(ref)
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

  async #embed(texts, { signal, timeoutMs } = {}) {
    const problem = this.#problem('embedder')
    if (problem) throw problem
    const { embedder } = this.settings()
    const apiKey = await this.#secret(embedder.apiKeyRef, embedder.apiKey)
    if (signal?.aborted) throw abortedError(signal)
    return embedTexts(embedder, texts, { apiKey, signal, timeoutMs, fetchImpl: this.fetchImpl })
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
    const timer = setTimeout(() => {
      try {
        const store = this.#store()
        store.searchVectors(new Float32Array(1), {}, 0)
      } catch (error) {
        this.logger?.warn?.(`dsh-mem0: local memory store could not be opened: ${error.message}`)
      }
    }, 0)
    timer.unref?.()
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
    }
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    // Wait for adds in flight so a write is not cut between LLM and insert.
    await Promise.allSettled([...this.queues.values()])
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
      llm: {
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
    } catch (error) {
      out.store.error = String(error?.message ?? error)
    }
    try {
      const [vector] = await this.#embed([PROBE_TEXT], { signal, timeoutMs: timeoutMs ?? 5_000 })
      out.embedder.dimensions = vector.length
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
    const store = this.#store()
    const [vector] = await this.#embed([query], { signal: options.signal, timeoutMs: options.timeoutMs ?? this.requestTimeoutMs })
    this.#checkEmbedder(store, this.settings().embedder, vector.length)
    if (options.signal?.aborted) throw abortedError(options.signal)
    const topK = Number.isInteger(options.topK) && options.topK > 0 ? options.topK : 5
    const threshold = Number.isFinite(options.threshold) ? options.threshold : 0.1
    return { results: store.search(vector, scope, { topK, threshold }) }
  }

  async list(filters, options = {}) {
    const scope = filters && Object.values(filters).some((value) => value) ? filters : { user_id: this.userId }
    const limit = Number.isInteger(options.topK) && options.topK > 0 ? options.topK : DEFAULT_LIST_LIMIT
    return { results: this.#store().list(scope, { limit }) }
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
    const deadline = Date.now() + (options.timeoutMs ?? this.addTimeoutMs)
    const remaining = () => Math.max(1, deadline - Date.now())
    return this.#serial(sessionScope(filters), () =>
      infer
        ? this.#addInferred(list, filters, metadata, { ...options, remaining })
        : this.#addRaw(list, metadata, { ...options, remaining }),
    )
  }

  /** infer: false — each message stored verbatim (mem0 `_add_to_vector_store`). */
  async #addRaw(messages, metadata, { signal, remaining }) {
    const kept = messages.filter((message) => message.role !== 'system')
    if (kept.length === 0) return { results: [] }
    const store = this.#store()
    const vectors = await this.#embed(kept.map((message) => message.content), { signal, timeoutMs: remaining() })
    this.#checkEmbedder(store, this.settings().embedder, vectors[0].length)
    if (signal?.aborted) throw abortedError(signal)
    const records = kept.map((message, index) => {
      const payload = { ...metadata, role: message.role }
      if (message.name) payload.actor_id = message.name
      return { id: randomUUID(), text: message.content, hash: md5(message.content), vector: vectors[index], payload, embedModel: this.settings().embedder.model }
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

  /** infer: true — the V3 additive pipeline. */
  async #addInferred(messages, filters, metadata, { signal, remaining, llmMaxTokens }) {
    const llmProblem = this.#problem('llm')
    if (llmProblem) throw llmProblem
    const store = this.#store()
    const settings = this.settings()
    const scope = sessionScope(filters)
    const lastMessages = store.lastMessages(scope)
    const parsed = parseMessages(messages)
    const [queryVector] = await this.#embed([parsed], { signal, timeoutMs: remaining() })
    this.#checkEmbedder(store, settings.embedder, queryVector.length)
    const similar = store.searchVectors(queryVector, filters, 10)
    const existingMemories = similar.map(({ row }, index) => ({ id: String(index), text: row.text ?? '' }))
    const prompt = buildExtractionMessages({
      newMessages: parsed,
      existingMemories,
      lastMessages,
      agentScoped: Boolean(filters.agent_id) && !filters.user_id,
      now: this.now(),
    })
    const apiKey = await this.#secret(settings.llm.apiKeyRef, settings.llm.apiKey)
    if (signal?.aborted) throw abortedError(signal)
    const { content, stats } = await chatCompletion(settings.llm, prompt, {
      apiKey,
      maxTokens: llmMaxTokens,
      signal,
      timeoutMs: remaining(),
      fetchImpl: this.fetchImpl,
    })
    this.lastExtraction = { at: this.now().toISOString(), ...stats }
    const { facts, reason } = inspectExtraction(content, stats)
    if (facts === null || reason) {
      // Mem0 stores nothing then. The turn is remembered only when the
      // failure will not be retried, so a retry does not repeat it.
      if (!RETRYABLE_EXTRACT_REASONS.includes(reason)) store.saveMessages(scope, messages)
      this.logger?.warn?.(`dsh-mem0: LLM extraction failed (${reason}; answer ${describeAnswer(content)}; ${describeStats(stats)}); nothing was stored`)
      const error = new NativeClientError(`dsh-mem0: ${extractionMessage(reason)}`, { code: EXTRACT_FAILED_CODE, status: 502, component: 'llm' })
      error.step = 'llm_extract'
      error.provider = 'openai'
      error.extractReason = reason
      error.retryable = RETRYABLE_EXTRACT_REASONS.includes(reason)
      if (Object.keys(stats).length > 0) error.extractStats = { ...stats }
      throw error
    }
    if (stats.finishReason === 'length') {
      this.logger?.warn?.(`dsh-mem0: LLM extraction hit its output budget (${describeStats(stats)}) but the answer was usable`)
    }
    const summary = { facts: facts.length, add: 0, update: 0, delete: 0, none: 0, skippedDuplicate: 0 }
    const texts = [...new Set(facts.map((item) => (item && typeof item === 'object' ? item.text : undefined)).filter((text) => typeof text === 'string' && text))]
    let vectorMap = new Map()
    if (texts.length > 0) {
      const vectors = await this.#embed(texts, { signal, timeoutMs: remaining() })
      vectorMap = new Map(texts.map((text, index) => [text, vectors[index]]))
    }
    const existingHashes = new Set(similar.map(({ row }) => row.hash).filter(Boolean))
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
      seen.add(hash)
      const payload = { ...metadata, created_at: createdAt, updated_at: createdAt }
      if (typeof item.attributed_to === 'string' && item.attributed_to) payload.attributed_to = item.attributed_to
      records.push({ id: randomUUID(), text, hash, vector: vectorMap.get(text), payload, embedModel: settings.embedder.model })
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
    const [vector] = await this.#embed([text], { signal: options.signal, timeoutMs: options.timeoutMs ?? this.requestTimeoutMs })
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
  async reembed({ signal, batchSize = 32, onProgress } = {}) {
    const store = this.#store()
    const { embedder } = this.settings()
    const rows = store.allTexts()
    const entries = []
    for (let start = 0; start < rows.length; start += batchSize) {
      if (signal?.aborted) throw abortedError(signal)
      const batch = rows.slice(start, start + batchSize)
      const vectors = await this.#embed(batch.map((row) => row.text || ' '), { signal, timeoutMs: this.requestTimeoutMs })
      batch.forEach((row, index) => entries.push({ id: row.id, vector: vectors[index] }))
      onProgress?.(entries.length, rows.length)
    }
    if (signal?.aborted) throw abortedError(signal)
    let dims = entries[0]?.vector.length
    if (!dims) dims = (await this.#embed([PROBE_TEXT], { signal, timeoutMs: this.requestTimeoutMs }))[0].length
    if (entries.length > 0) store.replaceVectors(entries, { model: embedder.model })
    if (dims) store.setEmbedderInfo({ model: embedder.model, dims })
    return { updated: entries.length, model: embedder.model, dims: dims ?? null }
  }
}

export { StoreError, storeError }

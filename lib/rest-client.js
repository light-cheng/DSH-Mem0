/**
 * Mem0 REST client for the managed Platform and self-hosted server backends.
 *
 * This deliberately has no npm runtime dependency: the plugin is installed
 * through the DSH profile and should not carry the large Mem0 SDK or native
 * modules into another package tree.
 */
import { requestJson } from './http.js'

const DEFAULT_ADD_TIMEOUT_MS = 120_000

export class Mem0RestError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'Mem0RestError'
    this.code = options.code ?? 'DSH_MEM0_REST_ERROR'
    this.status = options.status
    this.path = options.path
  }
}

function normaliseResults(payload) {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object' && Array.isArray(payload.results)) return payload.results
  return []
}

function normaliseAdd(payload) {
  if (Array.isArray(payload)) return { results: payload }
  if (!payload || typeof payload !== 'object') return { results: [] }
  if (Array.isArray(payload.results)) return { ...payload, results: payload.results }
  if (payload.event_id || payload.eventId || payload.status === 'PENDING') {
    return {
      queued: true,
      eventId: payload.event_id ?? payload.eventId,
      status: payload.status,
      results: [],
    }
  }
  return { ...payload, results: [] }
}

export class Mem0RestClient {
  constructor(options) {
    this.mode = options.mode === 'server' ? 'server' : 'platform'
    this.baseUrl = String(options.baseUrl ?? '').replace(/\/+$/, '')
    this.apiKey = options.apiKey ?? ''
    // Optional async lookup (DSH credentials) run before each request, so a
    // rotated key applies to the next request; `apiKey` is the fallback.
    this.resolveApiKey = options.resolveApiKey
    this.authType = options.authType ?? (this.mode === 'platform' ? 'token' : 'apiKey')
    this.userId = options.userId
    this.agentId = options.agentId
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.addTimeoutMs = options.addTimeoutMs ?? DEFAULT_ADD_TIMEOUT_MS
    this.logger = options.logger
  }

  startInBackground() {}

  async #currentApiKey() {
    if (typeof this.resolveApiKey !== 'function') return this.apiKey
    try {
      const resolved = await this.resolveApiKey()
      if (typeof resolved === 'string' && resolved.trim()) return resolved.trim()
    } catch {
      // Fall back to the key resolved at startup.
    }
    return this.apiKey
  }

  #authHeaders(apiKey) {
    if (this.mode === 'platform') {
      return apiKey ? { authorization: `Token ${apiKey}` } : {}
    }
    if (this.authType === 'none') return {}
    if (this.authType === 'bearer') {
      return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
    }
    if (this.authType === 'token') {
      return apiKey ? { authorization: `Token ${apiKey}` } : {}
    }
    return apiKey ? { 'x-api-key': apiKey } : {}
  }

  #configurationError(apiKey) {
    if (this.mode === 'platform' && !apiKey) {
      return new Mem0RestError(
        'Mem0 Platform API key is not configured; store MEM0_API_KEY in DSH credentials, set apiKey, or set the MEM0_API_KEY environment variable',
        { code: 'CONFIG_MISSING' },
      )
    }
    if (this.mode === 'server' && this.authType !== 'none' && !apiKey) {
      return new Mem0RestError(
        'Mem0 server API key is not configured; set apiKey, set authType to none for AUTH_DISABLED servers, or use MEM0_API_KEY',
        { code: 'CONFIG_MISSING' },
      )
    }
    if (!this.baseUrl) {
      return new Mem0RestError('Mem0 baseUrl is not configured', { code: 'CONFIG_MISSING' })
    }
    return undefined
  }

  async request(method, path, body, options = {}) {
    const apiKey = await this.#currentApiKey()
    const configError = this.#configurationError(apiKey)
    if (configError) throw configError
    return requestJson({
      url: `${this.baseUrl}${path}`,
      method,
      path,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...this.#authHeaders(apiKey),
      },
      body,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      ErrorClass: Mem0RestError,
      label: 'Mem0',
      detailKeys: ['detail', 'error'],
    })
  }

  async search(query, filters, options = {}) {
    const body = {
      query,
      filters,
      ...(options.topK !== undefined ? { top_k: options.topK } : {}),
      ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
    }
    const path = this.mode === 'platform' ? '/v3/memories/search/' : '/search'
    const payload = await this.request('POST', path, body, options)
    return { results: normaliseResults(payload) }
  }

  async add(messages, options = {}) {
    const body = {
      messages,
      user_id: options.userId,
      agent_id: options.agentId,
      ...(options.runId ? { run_id: options.runId } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
      infer: options.infer === true,
    }
    const path = this.mode === 'platform' ? '/v3/memories/add/' : '/memories'
    const payload = await this.request('POST', path, body, {
      ...options,
      timeoutMs: options.timeoutMs ?? this.addTimeoutMs,
    })
    return normaliseAdd(payload)
  }

  async list(filters, options = {}) {
    if (this.mode === 'platform') {
      const body = {
        filters,
        ...(options.topK !== undefined ? { page: 1, page_size: options.topK } : {}),
      }
      const payload = await this.request('POST', '/v3/memories/', body, options)
      return { results: normaliseResults(payload) }
    }
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(filters ?? {})) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
    }
    if (options.topK !== undefined) query.set('top_k', String(options.topK))
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    const payload = await this.request('GET', `/memories${suffix}`, undefined, options)
    return { results: normaliseResults(payload) }
  }

  async get(memoryId, options = {}) {
    const path =
      this.mode === 'platform'
        ? `/v1/memories/${encodeURIComponent(memoryId)}/`
        : `/memories/${encodeURIComponent(memoryId)}`
    return this.request('GET', path, undefined, options)
  }

  async update(memoryId, update, options = {}) {
    const path =
      this.mode === 'platform'
        ? `/v1/memories/${encodeURIComponent(memoryId)}/`
        : `/memories/${encodeURIComponent(memoryId)}`
    return this.request('PUT', path, update, options)
  }

  async remove(memoryId, options = {}) {
    const path =
      this.mode === 'platform'
        ? `/v1/memories/${encodeURIComponent(memoryId)}/`
        : `/memories/${encodeURIComponent(memoryId)}`
    return this.request('DELETE', path, undefined, options)
  }

  async health(options = {}) {
    const filters = { user_id: this.userId }
    if (this.mode === 'platform') {
      const query = new URLSearchParams({ user_id: this.userId, page: '1', page_size: '1' })
      const payload = await this.request('GET', `/v1/memories/?${query.toString()}`, undefined, {
        ...options,
        timeoutMs: options.timeoutMs ?? 8_000,
      })
      return {
        ok: true,
        backend: 'platform',
        baseUrl: this.baseUrl,
        userId: this.userId,
        agentId: this.agentId,
        memoryCount: normaliseResults(payload).length,
      }
    }
    const payload = await this.request(
      'GET',
      `/memories?${new URLSearchParams({ user_id: filters.user_id, top_k: '1' }).toString()}`,
      undefined,
      { ...options, timeoutMs: options.timeoutMs ?? 8_000 },
    )
    return {
      ok: true,
      backend: 'server',
      baseUrl: this.baseUrl,
      userId: this.userId,
      agentId: this.agentId,
      memoryCount: normaliseResults(payload).length,
    }
  }
}

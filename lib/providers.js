/**
 * HTTP adapters of the local (OSS) backend: the embedder and the LLM that
 * extracts facts. Both are plain `fetch` calls, no SDK:
 *
 * - embedder `openai` (any OpenAI-compatible server: OpenAI, oMLX, LM
 *   Studio, vLLM, …): `POST {baseUrl}/embeddings {model, input}`; newlines
 *   become spaces first and `dimensions` is sent only when configured
 *   (mem0 2.2.1 OpenAIEmbedding);
 * - embedder `ollama`: `POST {baseUrl}/api/embed {model, input}`;
 * - LLM: OpenAI-compatible `POST {baseUrl}/chat/completions` with mem0's
 *   parameters (temperature 0, top_p 0.1, max_tokens 8000, JSON mode,
 *   optional reasoning_effort); the answer comes back with finish_reason
 *   and token counts (numbers only).
 *
 * Errors carry `component` (`embedder` / `llm`), `step` (`embed` /
 * `llm_extract`), `provider`, `endpoint` (host:port), `code` and, when the
 * server answered, `status` and `detail` (the server's own error text,
 * redacted). Messages never contain the API key or the text that was sent.
 */
import { WINDOWS_DOCS_URL, hostPort } from './oss-config.js'
import { redactSecrets } from './redact.js'

export const DEFAULT_EMBED_TIMEOUT_MS = 30_000
export const DEFAULT_LLM_MAX_TOKENS = 8000
export const MIN_LLM_MAX_TOKENS = 256
export const MAX_LLM_MAX_TOKENS = 65_536

export class ProviderError extends Error {
  constructor(message, { component, step, provider, endpoint, code = 'BACKEND_ERROR', status, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'ProviderError'
    this.component = component
    this.step = step
    if (provider) this.provider = provider
    if (endpoint) this.endpoint = endpoint
    this.code = code
    if (Number.isInteger(status)) this.status = status
  }
}

const NAMES = { embedder: 'Embedder', llm: 'LLM' }
const PROVIDER_NAMES = { ollama: 'Ollama', openai: 'OpenAI-compatible server' }

function refused(error) {
  for (let current = error, depth = 0; current && depth < 6; current = current.cause, depth += 1) {
    if (current.code === 'ECONNREFUSED' || /ECONNREFUSED|connection refused|10061/i.test(String(current.message))) return true
    if (Array.isArray(current.errors) && current.errors.some((item) => item?.code === 'ECONNREFUSED')) return true
  }
  return false
}

function causeText(error) {
  const parts = []
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth += 1) {
    const text = current.code && !String(current.message).includes(current.code) ? `${current.message} (${current.code})` : current.message
    if (text && !parts.includes(text)) parts.push(text)
  }
  return parts.join(': ')
}

/** Clamp an output budget (a retry's doubled max_tokens) to what we send. */
export function clampMaxTokens(value) {
  if (!Number.isInteger(value) || value <= 0) return undefined
  return Math.max(MIN_LLM_MAX_TOKENS, Math.min(MAX_LLM_MAX_TOKENS, value))
}

function joinUrl(base, suffix) {
  return `${String(base).replace(/\/+$/, '')}${suffix}`
}

/**
 * POST JSON, return the parsed body. `signal` (caller) and `timeoutMs` both
 * abort; the timeout says so in the message ("timed out after").
 */
export async function postJson(url, body, { headers = {}, signal, timeoutMs, component, step, provider, fetchImpl = fetch } = {}) {
  const endpoint = hostPort(url)
  const controller = new AbortController()
  let timedOut = false
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true
        controller.abort(new Error(`timed out after ${timeoutMs} ms`))
      }, timeoutMs)
    : undefined
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const fields = { component, step, provider, endpoint }
  const label = `${NAMES[component] ?? component} ${PROVIDER_NAMES[provider] ?? provider ?? ''}`.trim()
  try {
    let response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if (timedOut) {
        throw new ProviderError(`${label} at ${endpoint}: request timed out after ${timeoutMs} ms`, { ...fields, code: 'ETIMEDOUT', cause: error })
      }
      if (controller.signal.aborted) {
        throw new ProviderError(`${label} at ${endpoint}: request aborted`, { ...fields, code: 'ABORTED', cause: error })
      }
      if (refused(error)) {
        throw new ProviderError(
          `${label} unreachable at ${endpoint} (connection refused). Check that it is running and listening on that port; ` +
            'on Windows, a port inside a reserved range makes the service fail to bind (os error 10013, ' +
            `"access a socket in a way forbidden" in its own log). See ${WINDOWS_DOCS_URL}`,
          { ...fields, code: 'NETWORK_ERROR', cause: error },
        )
      }
      throw new ProviderError(`${label} at ${endpoint}: ${redactSecrets(causeText(error))}`, { ...fields, code: 'NETWORK_ERROR', cause: error })
    }
    let text
    try {
      text = await response.text()
    } catch (error) {
      if (timedOut) throw new ProviderError(`${label} at ${endpoint}: request timed out after ${timeoutMs} ms`, { ...fields, code: 'ETIMEDOUT', cause: error })
      throw new ProviderError(`${label} at ${endpoint}: ${redactSecrets(causeText(error))}`, { ...fields, code: 'NETWORK_ERROR', cause: error })
    }
    let payload
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = undefined
    }
    if (!response.ok) {
      const detail = typeof payload?.error === 'string'
        ? payload.error
        : typeof payload?.error?.message === 'string'
          ? payload.error.message
          : typeof payload?.message === 'string'
            ? payload.message
            : ''
      const error = new ProviderError(
        `${label} at ${endpoint} answered HTTP ${response.status}${detail ? `: ${redactSecrets(detail).slice(0, 300)}` : ''}`,
        { ...fields, code: 'BACKEND_ERROR', status: response.status },
      )
      // The server's own words (redacted), for the setup wizard to show;
      // a body that is not JSON gives its first 300 characters.
      error.detail = redactSecrets(detail || (payload === undefined ? String(text ?? '') : '')).slice(0, 300)
      throw error
    }
    if (payload === undefined) {
      throw new ProviderError(`${label} at ${endpoint} answered something that is not JSON`, { ...fields, code: 'BAD_RESPONSE', status: response.status })
    }
    return payload
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/**
 * Ollama's `keep_alive` for a configured value: seconds as a number ("300",
 * "-1"), a duration string as is ("30m"), undefined when unset (Ollama's
 * own default of 5 minutes then applies).
 */
export function ollamaKeepAlive(value) {
  const text = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
  if (!text) return undefined
  return /^-?\d+$/.test(text) ? Number(text) : text
}

/**
 * Embed texts. Returns one number[] per text, in order.
 * @param {object} settings `{ provider: 'openai'|'ollama', baseUrl, model, dims?, keepAlive? }`
 *   (`keepAlive`: Ollama only, sent as `keep_alive`)
 * @param {string[]} texts
 * @param {object} [options] `{ apiKey, signal, timeoutMs, fetchImpl }`
 */
export async function embedTexts(settings, texts, { apiKey, signal, timeoutMs = DEFAULT_EMBED_TIMEOUT_MS, fetchImpl } = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return []
  const provider = settings.provider === 'ollama' ? 'ollama' : 'openai'
  const common = { signal, timeoutMs, component: 'embedder', step: 'embed', provider, fetchImpl }
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {}
  let vectors
  if (provider === 'ollama') {
    const request = { model: settings.model, input: texts }
    const keepAlive = ollamaKeepAlive(settings.keepAlive)
    if (keepAlive !== undefined) request.keep_alive = keepAlive
    const body = await postJson(joinUrl(settings.baseUrl, '/api/embed'), request, { ...common, headers })
    vectors = body?.embeddings
  } else {
    const request = { model: settings.model, input: texts.map((text) => String(text).replace(/\n/g, ' ')) }
    if (Number.isInteger(settings.dims) && settings.dims > 0) request.dimensions = settings.dims
    const body = await postJson(joinUrl(settings.baseUrl, '/embeddings'), request, { ...common, headers })
    const data = Array.isArray(body?.data) ? [...body.data] : undefined
    vectors = data?.sort((left, right) => Number(left?.index ?? 0) - Number(right?.index ?? 0)).map((item) => item?.embedding)
  }
  const endpoint = hostPort(settings.baseUrl)
  if (!Array.isArray(vectors) || vectors.length !== texts.length || !vectors.every((vector) => Array.isArray(vector) && vector.length > 0 && vector.every(Number.isFinite))) {
    throw new ProviderError(
      `Embedder at ${endpoint} returned ${Array.isArray(vectors) ? vectors.length : 'no'} vectors for ${texts.length} texts`,
      { component: 'embedder', step: 'embed', provider, endpoint, code: 'BAD_RESPONSE' },
    )
  }
  return vectors
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

/** finish_reason, output budget, effort and token counts of one completion. */
export function completionStats(body, request) {
  const stats = {}
  const budget = count(request?.max_tokens) ?? count(request?.max_completion_tokens)
  if (budget !== undefined) stats.maxTokens = budget
  if (typeof request?.reasoning_effort === 'string' && /^[a-z]{1,12}$/.test(request.reasoning_effort)) stats.reasoningEffort = request.reasoning_effort
  const finish = body?.choices?.[0]?.finish_reason
  if (typeof finish === 'string' && /^[a-z_]{1,24}$/.test(finish)) stats.finishReason = finish
  const usage = body?.usage
  if (count(usage?.prompt_tokens) !== undefined) stats.promptTokens = usage.prompt_tokens
  if (count(usage?.completion_tokens) !== undefined) stats.completionTokens = usage.completion_tokens
  const reasoning = count(usage?.completion_tokens_details?.reasoning_tokens) ?? count(usage?.reasoning_tokens)
  if (reasoning !== undefined) stats.reasoningTokens = reasoning
  return stats
}

/**
 * A gateway's non-2xx error saying the answer ran into its output budget
 * (the model spent max_tokens and answered nothing). Deliberately narrow:
 * only these phrases count, any other non-2xx stays an ordinary error.
 *
 * Source: magpie, a local OpenAI-compatible gateway (seen 2026-11 with the
 * WorkBuddy upstream), answers HTTP 502 with
 *   "WorkBuddy: an empty reply (the model answered nothing; try again) —
 *    cut at its length, the whole output spent on reasoning (the request's
 *    limit was 2000 tokens: raise max_tokens in the agent, or ask for less
 *    reasoning)"
 * where an upstream that passes the answer through would send HTTP 200 with
 * finish_reason=length. `finish_reason…length` covers gateways that quote
 * the upstream's finish_reason.
 */
export const OUTPUT_LIMIT_PATTERNS = Object.freeze([
  /\bcut at its length\b/i,
  /\bfinish_reason["'\s:=]{0,4}length\b/i,
  /\bspent on reasoning\b/i,
  /\brequest's limit was \d+ tokens\b/i,
])

/**
 * `{ limit }` (the token limit the text names, when it does) when a server's
 * error text says the answer was cut at its output budget, else null.
 */
export function matchOutputLimit(detail) {
  const text = typeof detail === 'string' ? detail : ''
  if (!text || !OUTPUT_LIMIT_PATTERNS.some((pattern) => pattern.test(text))) return null
  const limit = Number(/\blimit was (\d+) tokens\b/i.exec(text)?.[1])
  return Number.isInteger(limit) && limit > 0 ? { limit } : {}
}

/**
 * One extraction call. Returns `{ content, stats }`. A non-2xx answer whose
 * text says the output budget ran out (matchOutputLimit) rejects with
 * `outputLimit: { maxTokens }` on the ProviderError (the max_tokens sent),
 * for callers to treat it as a cut-off answer.
 * @param {object} settings `{ baseUrl, model, maxTokens, temperature, topP, reasoningEffort }`
 */
export async function chatCompletion(settings, messages, { apiKey, maxTokens, signal, timeoutMs, fetchImpl } = {}) {
  const request = {
    model: settings.model,
    messages,
    temperature: Number.isFinite(settings.temperature) ? settings.temperature : 0,
    top_p: Number.isFinite(settings.topP) ? settings.topP : 0.1,
    max_tokens: clampMaxTokens(maxTokens) ?? clampMaxTokens(settings.maxTokens) ?? DEFAULT_LLM_MAX_TOKENS,
    response_format: { type: 'json_object' },
  }
  if (typeof settings.reasoningEffort === 'string' && settings.reasoningEffort) request.reasoning_effort = settings.reasoningEffort
  let body
  try {
    body = await postJson(joinUrl(settings.baseUrl, '/chat/completions'), request, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal,
      timeoutMs,
      component: 'llm',
      step: 'llm_extract',
      provider: 'openai',
      fetchImpl,
    })
  } catch (error) {
    if (error instanceof ProviderError && error.code === 'BACKEND_ERROR' && Number.isInteger(error.status) && matchOutputLimit(error.detail)) {
      error.outputLimit = { maxTokens: request.max_tokens }
    }
    throw error
  }
  const message = body?.choices?.[0]?.message
  let content = message?.content
  if (Array.isArray(content)) content = content.map((part) => (typeof part === 'string' ? part : String(part?.text ?? ''))).join('')
  return { content: typeof content === 'string' ? content : '', stats: completionStats(body, request) }
}

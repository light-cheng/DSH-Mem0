/**
 * HTTP plumbing shared by every Mem0 backend client (Platform/server REST and
 * the local OSS sidecar): timeouts tied to caller signals, JSON request with
 * one error mapping, and the circuit breaker that guards background calls.
 */

/** Small circuit breaker for background memory calls. Used by every backend. */
export class CircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 120_000, now = () => Date.now() } = {}) {
    this.threshold = threshold
    this.cooldownMs = cooldownMs
    this.now = now
    this.failures = 0
    this.openUntil = 0
  }

  isOpen() {
    if (this.failures < this.threshold) return false
    if (this.now() < this.openUntil) return true
    this.failures = 0
    this.openUntil = 0
    return false
  }

  recordSuccess() {
    this.failures = 0
    this.openUntil = 0
  }

  recordFailure() {
    this.failures += 1
    if (this.failures >= this.threshold) this.openUntil = this.now() + this.cooldownMs
    return this.failures >= this.threshold
  }

  reset() {
    this.failures = 0
    this.openUntil = 0
  }
}

/**
 * One signal that aborts when the caller's `signal` aborts or `timeoutMs`
 * elapses. Call `cleanup()` when the request settles.
 */
export function combineSignals(signal, timeoutMs) {
  const controller = new AbortController()
  const timer =
    typeof timeoutMs === 'number' && timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs)
      : undefined
  const abortFromCaller = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) abortFromCaller()
    else signal.addEventListener('abort', abortFromCaller, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup() {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', abortFromCaller)
    },
  }
}

function errorDetail(payload, status, detailKeys) {
  if (payload && typeof payload === 'object') {
    for (const key of detailKeys) {
      if (typeof payload[key] === 'string') return payload[key]
    }
  }
  if (typeof payload === 'string') return payload
  return `HTTP ${status}`
}

const ATTRIBUTION_FIELDS = {
  component: /^(?:llm|embedder|vector_store|sidecar|mem0_api)$/,
  step: /^(?:embed|search|llm_extract|store)$/,
  provider: /^[A-Za-z0-9_.-]{1,40}$/,
  endpoint: /^[A-Za-z0-9_.:\[\] -]{1,80}$/,
}

/**
 * Which component failed, when an error body says so (the OSS sidecar adds
 * `component`, `step`, `provider` and `endpoint` to its 500 bodies). Only
 * known values and short host:port strings are kept.
 */
export function failureAttribution(payload) {
  const out = {}
  if (!payload || typeof payload !== 'object') return out
  for (const [key, pattern] of Object.entries(ATTRIBUTION_FIELDS)) {
    const value = payload[key]
    if (typeof value === 'string' && pattern.test(value)) out[key] = value
  }
  return out
}

/**
 * Send a JSON request and return the parsed body (`null` for an empty body,
 * the raw text when it is not JSON).
 *
 * Errors are instances of `ErrorClass` with `code`:
 * - `BACKEND_ERROR` (non-2xx; `status` set, message uses the first string
 *   field of `detailKeys` in the body),
 * - `ABORTED` (caller signal or timeout),
 * - `NETWORK_ERROR` (anything else from fetch).
 * Messages start with `${label} ${method} ${path}`.
 */
export async function requestJson({
  url,
  method,
  path,
  headers = {},
  body,
  signal,
  timeoutMs,
  ErrorClass,
  label,
  detailKeys = ['error'],
}) {
  const combined = combineSignals(signal, timeoutMs)
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined.signal,
    })
    const text = await response.text()
    let payload
    try {
      payload = text === '' ? null : JSON.parse(text)
    } catch {
      payload = text
    }
    if (!response.ok) {
      const error = new ErrorClass(`${label} ${method} ${path} failed: ${errorDetail(payload, response.status, detailKeys)}`, {
        code: 'BACKEND_ERROR',
        status: response.status,
        path,
      })
      Object.assign(error, failureAttribution(payload))
      throw error
    }
    return payload
  } catch (error) {
    if (error instanceof ErrorClass) throw error
    if (combined.signal.aborted) {
      throw new ErrorClass(`${label} ${method} ${path} aborted`, { code: 'ABORTED', path, cause: error })
    }
    throw new ErrorClass(`${label} ${method} ${path} failed: ${error.message}`, {
      code: 'NETWORK_ERROR',
      path,
      cause: error,
    })
  } finally {
    combined.cleanup()
  }
}

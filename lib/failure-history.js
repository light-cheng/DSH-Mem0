/**
 * Persistent history of recent memory failures.
 *
 * Activity (lib/memory-lifecycle.js) keeps only the latest capture/recall
 * state, so the next success hides why the previous call failed. This keeps
 * the last N failures (a ring buffer, newest first) in
 * `<profile>/dsh-mem0/failures.json` next to maintenance.json, so the
 * settings page and the status bar can still explain a failure after it was
 * overwritten, and after a restart.
 *
 * Entries are redacted before they are stored: credential shapes go through
 * redactSecrets, home-directory paths are shortened to `~`, and the message
 * is capped, so no API key, token, memory text or user path is written.
 *
 * File format (version 1):
 *   { "version": 1, "entries": [ {
 *       "at": ISO time of the latest occurrence,
 *       "firstAt": ISO time of the first occurrence (when count > 1),
 *       "count": consecutive identical failures folded into this entry,
 *       "kind": "capture" | "recall" | "summary" | "maintenance",
 *       "backend": "platform" | "server" | "oss",
 *       "cause": "timeout" | "connection" | "auth" | "circuit" | "extraction" | "other",
 *       "reason": "not_json" | "empty" | "truncated" | "refusal" (cause extraction only),
 *       "component": "llm" | "embedder" | "vector_store" | "sidecar" | "mem0_api" | "unknown",
 *       "step": "embed" | "search" | "llm_extract" | "store" (OSS sidecar only),
 *       "provider", "endpoint": e.g. "ollama", "127.0.0.1:11434" (OSS sidecar only),
 *       "stepElapsedMs": how long that step had run when our timeout fired,
 *       "status": HTTP status when the backend answered,
 *       "code": error code (e.g. NETWORK_ERROR, ABORTED),
 *       "message": short redacted message,
 *       "durationMs": time the failed call took,
 *       "exitCode", "signal", "uptimeMs": how the OSS sidecar exited, when it
 *         died during (or right before) the failed call (component sidecar),
 *       "retry": "failed" when this was the one retry of a capture (undelivered,
 *         or an unusable extraction answer)
 *   } ] }
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EXTRACT_REASONS, extractStats } from './http.js'
import { redactSecrets } from './redact.js'

export const FAILURE_KINDS = Object.freeze(['capture', 'recall', 'summary', 'maintenance'])
export const FAILURE_CAUSES = Object.freeze(['timeout', 'connection', 'auth', 'circuit', 'extraction', 'other'])
export const FAILURE_COMPONENTS = Object.freeze(['llm', 'embedder', 'vector_store', 'sidecar', 'mem0_api', 'unknown'])
export const FAILURE_STEPS = Object.freeze(['embed', 'search', 'llm_extract', 'store'])
export const DEFAULT_FAILURE_LIMIT = 20
export const FAILURE_MESSAGE_MAX_CHARS = 240

const TIMEOUT_PATTERN = /timed?\s*out|ReadTimeout|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT|deadline exceeded/i
const CONNECTION_PATTERN =
  /ECONNREFUSED|Connection refused|Errno 61|Errno 111|Name or service not known|nodename nor servname|ENOTFOUND|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|EPIPE|socket hang up|other side closed|fetch failed|UND_ERR_SOCKET|network error|connection (?:refused|reset|closed)/i
const AUTH_PATTERN =
  /\b(?:401|403|429)\b|unauthori[sz]ed|forbidden|invalid api key|api key (?:is )?(?:invalid|missing|expired)|authentication|permission denied|quota|rate.?limit|too many requests|insufficient (?:credits|balance)/i
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'NETWORK_ERROR'])

/** The error, its `cause` chain (max 5 deep) and their messages/codes. */
function errorChain(error) {
  const chain = []
  let current = error
  for (let depth = 0; current && depth < 5; depth += 1) {
    chain.push(current)
    current = typeof current === 'object' ? current.cause : undefined
  }
  return chain
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error ?? '')
}

/**
 * Classify one failure:
 * - `circuit`    the call was skipped because the circuit breaker is open;
 * - `extraction` the LLM answered, but Mem0 could not use its fact-extraction
 *                answer and stored nothing (`extractReason` on the error);
 * - `auth`       HTTP 401/403/429 or a quota / rate-limit / invalid-key message
 *                (checked before transport causes: the backend did answer);
 * - `timeout`    our own request timeout, ETIMEDOUT, undici timeouts;
 * - `connection` refused, DNS failure, reset, dropped socket, `fetch failed`;
 * - `other`      anything else (HTTP 5xx, config missing, sidecar errors…).
 * HTTP 408 and 504 count as `timeout`.
 * A caller abort that is not a timeout is `other`.
 */
export function classifyFailure(error, { circuit = false } = {}) {
  if (circuit || error?.code === 'CIRCUIT_OPEN') return 'circuit'
  const chain = errorChain(error)
  if (chain.some((item) => EXTRACT_REASONS.includes(item?.extractReason))) return 'extraction'
  // The OSS sidecar wraps a component failure (Qdrant refused, LLM 429, …)
  // in its own HTTP 500; its status says nothing about the cause, the
  // component's message does.
  const wrapped = chain.some((item) => ['llm', 'embedder', 'vector_store'].includes(item?.component))
  const statuses = wrapped ? [] : chain.map((item) => Number(item?.status ?? item?.statusCode)).filter(Number.isFinite)
  if (statuses.some((status) => status === 401 || status === 403 || status === 429)) return 'auth'
  const texts = chain.map((item) => `${item?.code ?? ''} ${item?.name ?? ''} ${messageOf(item)}`)
  // A non-2xx answer is never a transport problem, whatever its text says.
  const answered = statuses.length > 0
  if (texts.some((text) => AUTH_PATTERN.test(text)) && (answered || !texts.some((text) => CONNECTION_PATTERN.test(text)))) {
    return 'auth'
  }
  if (statuses.some((status) => status === 408 || status === 504)) return 'timeout'
  if (answered) return 'other'
  if (chain.some((item) => item?.code === 'ETIMEDOUT' || item?.code === 'STARTUP_TIMEOUT' || item?.name === 'TimeoutError')) return 'timeout'
  if (texts.some((text) => TIMEOUT_PATTERN.test(text))) return 'timeout'
  if (chain.some((item) => CONNECTION_CODES.has(item?.code))) return 'connection'
  if (texts.some((text) => CONNECTION_PATTERN.test(text))) return 'connection'
  return 'other'
}

// Text hints for errors that do not carry a component (a self-hosted Mem0
// server passes its own Qdrant/Ollama/LLM error through; older sidecars).
const COMPONENT_HINTS = [
  ['vector_store', /qdrant|(?::|port=)6333\b|\bcollection\b[^.]{0,80}?(?:not found|does ?n[o']t exist|missing)|vector[ _]store/i],
  ['embedder', /ollama|(?::|port=)11434\b|\bembedd?(?:ing|er)s?\b|bge-m3/i],
  ['llm', /openai|RateLimitError|APIStatusError|APIConnectionError|APITimeoutError|chat\/completions|\bllm\b|litellm|anthropic|(?::|port=)3425\b/i],
]
// Errors about the OSS sidecar process itself (lib/sidecar-client.js codes).
const SIDECAR_CODES = new Set([
  'STARTING',
  'START_FAILED',
  'SIDECAR_START_FAILED',
  'SPAWN_FAILED',
  'STARTUP_TIMEOUT',
  'NOT_READY',
  'DISPOSED',
  'SIDECAR_MISSING',
  'CONFIG_MISSING',
  'NETWORK_ERROR',
])

/**
 * Which component failed:
 * 1. what the error carries: the OSS sidecar's 500 body (`component`,
 *    `step`, `provider`, `endpoint`), or the step still running when our
 *    timeout fired (GET /steps);
 * 2. text hints: Qdrant / port 6333 / missing collection → vector_store;
 *    Ollama / port 11434 / embedding → embedder; OpenAI-style errors,
 *    chat/completions → llm;
 * 3. OSS: errors about the sidecar process (not started, crashed, port
 *    unreachable) → sidecar; else unknown;
 * 4. Platform / self-hosted server: mem0_api (the Mem0 API answered or was
 *    unreachable; it does not say which part of it failed).
 */
export function attributeFailure(error, { backend } = {}) {
  const chain = errorChain(error)
  const tagged = chain.find((item) => FAILURE_COMPONENTS.includes(item?.component))
  if (tagged) {
    const out = { component: tagged.component }
    if (FAILURE_STEPS.includes(tagged.step)) out.step = tagged.step
    if (typeof tagged.provider === 'string') out.provider = tagged.provider.slice(0, 40)
    if (typeof tagged.endpoint === 'string') out.endpoint = tagged.endpoint.slice(0, 80)
    if (Number.isFinite(Number(tagged.stepElapsedMs))) out.stepElapsedMs = Math.round(Number(tagged.stepElapsedMs))
    return out
  }
  const text = chain.map((item) => messageOf(item)).join(' \n ')
  for (const [component, pattern] of COMPONENT_HINTS) {
    if (pattern.test(text)) return { component }
  }
  if (backend === 'oss') {
    if (chain.some((item) => SIDECAR_CODES.has(item?.code)) || /sidecar/i.test(text)) return { component: 'sidecar' }
    return { component: 'unknown' }
  }
  if (backend === 'platform' || backend === 'server') return { component: 'mem0_api' }
  return { component: 'unknown' }
}

const HOME = (() => {
  try {
    return os.homedir()
  } catch {
    return ''
  }
})()

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Credential shapes removed (redactSecrets) and home-directory paths
 * shortened to `~`. Whitespace is kept: also used for sidecar.log lines.
 */
export function redactLogText(value, { home = HOME } = {}) {
  let text = redactSecrets(String(value ?? ''))
  if (home && home.length > 1) text = text.replace(new RegExp(escapeRegExp(home), 'g'), '~')
  return text
    .replace(/\/(?:Users|home)\/[^/\s"'`:]+/g, '~')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"'`:]+/gi, '~')
}

/**
 * Redact and shorten one failure message for storage and display: secrets
 * removed, home-directory paths shortened to `~`, whitespace collapsed,
 * capped at FAILURE_MESSAGE_MAX_CHARS.
 */
export function sanitizeFailureMessage(value, { home = HOME } = {}) {
  let text = redactLogText(value, { home })
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > FAILURE_MESSAGE_MAX_CHARS) text = `${text.slice(0, FAILURE_MESSAGE_MAX_CHARS - 1).trimEnd()}…`
  return text
}

function isoOrNull(value) {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

/** Validate and re-sanitize one stored entry; null when unusable. */
function normaliseEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const at = isoOrNull(raw.at)
  if (!at || !FAILURE_KINDS.includes(raw.kind)) return null
  const entry = {
    at,
    kind: raw.kind,
    backend: typeof raw.backend === 'string' ? raw.backend.slice(0, 16) : 'unknown',
    cause: FAILURE_CAUSES.includes(raw.cause) ? raw.cause : 'other',
    component: FAILURE_COMPONENTS.includes(raw.component) ? raw.component : 'unknown',
    message: sanitizeFailureMessage(raw.message),
    durationMs: Number.isFinite(Number(raw.durationMs)) ? Math.max(0, Math.round(Number(raw.durationMs))) : null,
    count: Math.max(1, Math.floor(Number(raw.count) || 1)),
  }
  const firstAt = isoOrNull(raw.firstAt)
  if (firstAt && entry.count > 1) entry.firstAt = firstAt
  if (Number.isFinite(Number(raw.status))) entry.status = Number(raw.status)
  if (typeof raw.code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(raw.code)) entry.code = raw.code
  if (FAILURE_STEPS.includes(raw.step)) entry.step = raw.step
  if (entry.cause === 'extraction' && EXTRACT_REASONS.includes(raw.reason)) entry.reason = raw.reason
  // finish_reason and token counts of the extraction call (numbers only).
  const stats = entry.cause === 'extraction' ? extractStats(raw.extract) : undefined
  if (stats) entry.extract = stats
  if (typeof raw.provider === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(raw.provider)) entry.provider = raw.provider
  if (typeof raw.endpoint === 'string' && /^[A-Za-z0-9_.:\[\] -]{1,80}$/.test(raw.endpoint)) entry.endpoint = raw.endpoint
  if (Number.isFinite(Number(raw.stepElapsedMs)) && raw.stepElapsedMs !== null) {
    entry.stepElapsedMs = Math.max(0, Math.round(Number(raw.stepElapsedMs)))
  }
  if (Number.isInteger(raw.exitCode)) entry.exitCode = raw.exitCode
  if (typeof raw.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(raw.signal)) entry.signal = raw.signal
  if (Number.isFinite(raw.uptimeMs) && raw.uptimeMs >= 0) entry.uptimeMs = Math.round(raw.uptimeMs)
  if (raw.retry === 'failed') entry.retry = 'failed'
  return entry
}

function isExit(entry) {
  return Number.isInteger(entry?.exitCode) || typeof entry?.signal === 'string'
}

function pickAttribution(entry) {
  if (!entry) return { component: 'unknown' }
  const out = { component: entry.component }
  for (const key of ['step', 'provider', 'endpoint']) if (entry[key]) out[key] = entry[key]
  return out
}

export class FailureHistory {
  /**
   * @param {object} options
   * @param {string} [options.filePath] JSON file; without one the history is in-memory only.
   * @param {number} [options.limit] ring-buffer size (default 20).
   * @param {string} [options.backend] backend recorded on each entry.
   */
  constructor({ filePath, limit = DEFAULT_FAILURE_LIMIT, backend = 'unknown', logger, now = () => new Date() } = {}) {
    this.filePath = filePath
    this.limit = Math.max(1, Math.floor(Number(limit) || DEFAULT_FAILURE_LIMIT))
    this.backend = backend
    this.logger = logger
    this.now = now
    this.lastError = null
    this.entries = this.#load()
  }

  #load() {
    if (!this.filePath) return []
    let text
    try {
      text = fs.readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn?.(`dsh-mem0: could not read failure history: ${error.message}`)
      return []
    }
    try {
      const parsed = JSON.parse(text)
      const list = Array.isArray(parsed?.entries) ? parsed.entries : []
      return list.map(normaliseEntry).filter(Boolean).slice(0, this.limit)
    } catch (error) {
      // A corrupt file is replaced on the next write; never fail startup.
      this.logger?.warn?.(`dsh-mem0: ignoring corrupt failure history: ${error.message}`)
      return []
    }
  }

  #save() {
    if (!this.filePath) return true
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, entries: this.entries }, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(temporary, this.filePath)
      this.lastError = null
      return true
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.logger?.warn?.(`dsh-mem0: could not write failure history: ${this.lastError}`)
      return false
    }
  }

  /**
   * Record one failure. Consecutive failures with the same kind, cause and
   * message fold into the newest entry (count, firstAt) so a breaker skip on
   * every prompt cannot push older, different failures out of the buffer.
   * Never throws. Returns the stored entry.
   */
  record({ kind, error, message, cause, circuit = false, durationMs, backend, retry } = {}) {
    try {
      if (!FAILURE_KINDS.includes(kind)) return null
      const at = this.now().toISOString()
      const chain = errorChain(error)
      const status = chain.map((item) => Number(item?.status)).find(Number.isFinite)
      const code = chain.map((item) => item?.code).find((value) => typeof value === 'string')
      // How the sidecar exited, when lib/sidecar-client.js saw it die.
      const exited = chain.find((item) => item && (Number.isInteger(item.exitCode) || typeof item.signal === 'string'))
      const reason = chain.map((item) => item?.extractReason).find((value) => EXTRACT_REASONS.includes(value))
      const extract = chain.map((item) => item?.extractStats).find((value) => value && typeof value === 'object')
      const effectiveBackend = backend ?? this.backend
      const effectiveCause = cause ?? classifyFailure(error, { circuit })
      // A breaker skip has no error of its own: it inherits the component of
      // the latest real failure (the one that opened the breaker).
      const attribution =
        effectiveCause === 'circuit' && !error
          ? pickAttribution(this.entries.find((item) => item.cause !== 'circuit'))
          : attributeFailure(error, { backend: effectiveBackend })
      const entry = normaliseEntry({
        at,
        kind,
        backend: effectiveBackend,
        cause: effectiveCause,
        message: message ?? messageOf(error),
        durationMs,
        status,
        code,
        ...attribution,
        ...(exited ? { exitCode: exited.exitCode, signal: exited.signal, uptimeMs: exited.uptimeMs } : {}),
        reason,
        extract,
        retry,
      })
      if (!entry) return null
      const newest = this.entries[0]
      if (
        newest &&
        newest.kind === entry.kind &&
        newest.cause === entry.cause &&
        newest.component === entry.component &&
        newest.message === entry.message &&
        newest.reason === entry.reason &&
        newest.backend === entry.backend &&
        newest.retry === entry.retry &&
        // Each sidecar death is its own event (its own uptime): never fold.
        !isExit(newest) &&
        !isExit(entry)
      ) {
        const merged = { ...entry, firstAt: newest.firstAt ?? newest.at, count: newest.count + 1 }
        this.entries[0] = merged
      } else {
        this.entries.unshift(entry)
        if (this.entries.length > this.limit) this.entries.length = this.limit
      }
      this.#save()
      return this.entries[0]
    } catch (error) {
      this.logger?.debug?.(`dsh-mem0: could not record failure: ${error?.message}`)
      return null
    }
  }

  /** Newest first; copies, safe to send to the page. */
  list() {
    return this.entries.map((entry) => ({ ...entry }))
  }

  latest() {
    return this.entries[0] ? { ...this.entries[0] } : null
  }

  clear() {
    this.entries = []
    return this.#save()
  }
}

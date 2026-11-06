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
 *       "cause": "timeout" | "connection" | "auth" | "circuit" | "other",
 *       "status": HTTP status when the backend answered,
 *       "code": error code (e.g. NETWORK_ERROR, ABORTED),
 *       "message": short redacted message,
 *       "durationMs": time the failed call took
 *   } ] }
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redactSecrets } from './redact.js'

export const FAILURE_KINDS = Object.freeze(['capture', 'recall', 'summary', 'maintenance'])
export const FAILURE_CAUSES = Object.freeze(['timeout', 'connection', 'auth', 'circuit', 'other'])
export const DEFAULT_FAILURE_LIMIT = 20
export const FAILURE_MESSAGE_MAX_CHARS = 240

const TIMEOUT_PATTERN = /timed?\s*out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT|deadline exceeded/i
const CONNECTION_PATTERN =
  /ECONNREFUSED|ENOTFOUND|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|EPIPE|socket hang up|other side closed|fetch failed|UND_ERR_SOCKET|network error|connection (?:refused|reset|closed)/i
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
  const statuses = chain.map((item) => Number(item?.status ?? item?.statusCode)).filter(Number.isFinite)
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
 * Redact and shorten one failure message for storage and display: secrets
 * removed, home-directory paths shortened to `~`, whitespace collapsed,
 * capped at FAILURE_MESSAGE_MAX_CHARS.
 */
export function sanitizeFailureMessage(value, { home = HOME } = {}) {
  let text = redactSecrets(String(value ?? ''))
  if (home && home.length > 1) text = text.replace(new RegExp(escapeRegExp(home), 'g'), '~')
  text = text
    .replace(/\/(?:Users|home)\/[^/\s"'`:]+/g, '~')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"'`:]+/gi, '~')
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
    message: sanitizeFailureMessage(raw.message),
    durationMs: Number.isFinite(Number(raw.durationMs)) ? Math.max(0, Math.round(Number(raw.durationMs))) : null,
    count: Math.max(1, Math.floor(Number(raw.count) || 1)),
  }
  const firstAt = isoOrNull(raw.firstAt)
  if (firstAt && entry.count > 1) entry.firstAt = firstAt
  if (Number.isFinite(Number(raw.status))) entry.status = Number(raw.status)
  if (typeof raw.code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(raw.code)) entry.code = raw.code
  return entry
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
  record({ kind, error, message, cause, circuit = false, durationMs, backend } = {}) {
    try {
      if (!FAILURE_KINDS.includes(kind)) return null
      const at = this.now().toISOString()
      const chain = errorChain(error)
      const status = chain.map((item) => Number(item?.status)).find(Number.isFinite)
      const code = chain.map((item) => item?.code).find((value) => typeof value === 'string')
      const entry = normaliseEntry({
        at,
        kind,
        backend: backend ?? this.backend,
        cause: cause ?? classifyFailure(error, { circuit }),
        message: message ?? messageOf(error),
        durationMs,
        status,
        code,
      })
      if (!entry) return null
      const newest = this.entries[0]
      if (newest && newest.kind === entry.kind && newest.cause === entry.cause && newest.message === entry.message && newest.backend === entry.backend) {
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

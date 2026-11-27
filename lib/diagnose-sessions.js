/**
 * Diagnosis sessions: the sessions the settings page opened with "Ask DSH to
 * diagnose" (client.js), and what the plugin does differently in them.
 *
 * DSH's read-only preset only covers its own file sandbox: the plugin's
 * tools, automatic capture and recall, and hygiene all write to the memory
 * store regardless (tested on 0.2.2-rc.5). So the plugin keeps the ids of
 * the sessions it opened for diagnosis and, in those sessions only:
 * - refuses mem0_delete, mem0_update, mem0_pin and mem0_profile_reset, and
 *   asks before mem0_add and mem0_profile_update (`tools/pre-execute`);
 * - skips automatic recall and capture (lib/memory-lifecycle.js);
 * - leaves memories of those sessions out of hygiene
 *   (lib/memory-maintenance.js).
 * The settings page's own delete route is the user acting and stays as is.
 *
 * The record also maps a failure's fingerprint (lib/diagnose-report.js) to
 * its session, so a second click on the same problem returns to it.
 *
 * File: `<profile>/dsh-mem0/diagnose-sessions.json`
 *   { "version": 1, "sessions": [ { "sessionId", "fingerprint", "createdAt" } ] }
 * newest first, at most DIAGNOSE_SESSION_LIMIT entries. Without a profile
 * directory the record stays in memory.
 */
import fs from 'node:fs'
import path from 'node:path'

export const DIAGNOSE_SESSIONS_FILE = 'diagnose-sessions.json'
export const DIAGNOSE_SESSION_LIMIT = 50
/** Write tools refused outright in a diagnosis session. */
export const DIAGNOSE_DENIED_TOOLS = Object.freeze(['mem0_delete', 'mem0_update', 'mem0_pin', 'mem0_profile_reset'])
/** Write tools that need the user's confirmation in a diagnosis session. */
export const DIAGNOSE_ASKED_TOOLS = Object.freeze(['mem0_add', 'mem0_profile_update'])

const SESSION_ID = /^[A-Za-z0-9_.:-]{1,200}$/
const FINGERPRINT = /^[A-Za-z0-9_.:-]{1,120}$/

/** 'deny', 'ask' or null (allowed) for one tool in a diagnosis session. */
export function diagnoseToolDecision(name) {
  if (DIAGNOSE_DENIED_TOOLS.includes(name)) return 'deny'
  if (DIAGNOSE_ASKED_TOOLS.includes(name)) return 'ask'
  return null
}

function normalise(raw) {
  if (!raw || typeof raw !== 'object') return null
  const sessionId = typeof raw.sessionId === 'string' && SESSION_ID.test(raw.sessionId) ? raw.sessionId : null
  if (!sessionId) return null
  const fingerprint = typeof raw.fingerprint === 'string' && FINGERPRINT.test(raw.fingerprint) ? raw.fingerprint : null
  const time = Date.parse(raw.createdAt)
  return { sessionId, fingerprint, createdAt: Number.isFinite(time) ? new Date(time).toISOString() : new Date(0).toISOString() }
}

export class DiagnoseSessions {
  constructor({ filePath, limit = DIAGNOSE_SESSION_LIMIT, logger, now = () => new Date() } = {}) {
    this.filePath = filePath
    this.limit = limit
    this.logger = logger
    this.now = now
    this.entries = this.#load()
  }

  #load() {
    if (!this.filePath) return []
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      return (Array.isArray(parsed?.sessions) ? parsed.sessions : []).map(normalise).filter(Boolean).slice(0, this.limit)
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn?.(`dsh-mem0: ignoring unreadable diagnosis session record: ${error.message}`)
      return []
    }
  }

  #save() {
    if (!this.filePath) return true
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, sessions: this.entries }, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(temporary, this.filePath)
      return true
    } catch (error) {
      this.logger?.warn?.(`dsh-mem0: could not write diagnosis session record: ${error.message}`)
      return false
    }
  }

  /** Whether `sessionId` is a diagnosis session this plugin opened. */
  has(sessionId) {
    if (sessionId === undefined || sessionId === null || sessionId === '') return false
    const id = String(sessionId)
    return this.entries.some((entry) => entry.sessionId === id)
  }

  /** The newest diagnosis session recorded for a fingerprint, or null. */
  sessionFor(fingerprint) {
    if (!fingerprint) return null
    return this.entries.find((entry) => entry.fingerprint === fingerprint)?.sessionId ?? null
  }

  /** Ids of every recorded diagnosis session. */
  ids() {
    return new Set(this.entries.map((entry) => entry.sessionId))
  }

  /**
   * Record a session (before it is opened, so the gate is in place before
   * the first turn). A fingerprint already mapped moves to the new session.
   * @returns whether it was stored (false: bad id, or the file failed to write).
   */
  register({ sessionId, fingerprint } = {}) {
    const entry = normalise({ sessionId, fingerprint, createdAt: this.now().toISOString() })
    if (!entry) return false
    // A previous session for the same problem stays a diagnosis session
    // (the gate still applies there); only the fingerprint moves.
    const kept = this.entries
      .filter((item) => item.sessionId !== entry.sessionId)
      .map((item) => (entry.fingerprint && item.fingerprint === entry.fingerprint ? { ...item, fingerprint: null } : item))
    this.entries = [entry, ...kept].slice(0, this.limit)
    return this.#save()
  }

  /**
   * Drop the fingerprint mapping of a session that is gone or archived, so
   * the next click opens a new one. The id stays recorded: if the user
   * restores the session, the gate still applies.
   */
  unmap(sessionId) {
    const id = String(sessionId ?? '')
    let changed = false
    this.entries = this.entries.map((item) => {
      if (item.sessionId !== id || !item.fingerprint) return item
      changed = true
      return { ...item, fingerprint: null }
    })
    return changed ? this.#save() : true
  }

  /** Forget a session entirely (it was created but never set up). */
  forget(sessionId) {
    const id = String(sessionId ?? '')
    const before = this.entries.length
    this.entries = this.entries.filter((item) => item.sessionId !== id)
    return before === this.entries.length ? true : this.#save()
  }
}

/**
 * Whether a session, or the main session above a subagent, is a diagnosis
 * session. `lookup(id)` returns a session by id (DSH's host `sessions`
 * registry), to follow `header.parentSession` of subagent sessions.
 */
export function isDiagnoseSession(store, session, { lookup } = {}) {
  if (!store || !session) return false
  let current = session
  const seen = new Set()
  for (let depth = 0; current && depth < 6; depth += 1) {
    const id = current.id ?? current.header?.id
    if (store.has(id)) return true
    if (id !== undefined) seen.add(String(id))
    const header = current.header
    if (header?.origin !== 'subagent' || !header.parentSession || seen.has(String(header.parentSession))) return false
    if (store.has(header.parentSession)) return true
    let parent
    try {
      parent = typeof lookup === 'function' ? lookup(header.parentSession) : undefined
    } catch {
      parent = undefined
    }
    current = parent
  }
  return false
}

/**
 * The `tools/pre-execute` listener: in a diagnosis session, refuse or ask
 * for the plugin's write tools; everything else passes on.
 */
export function createDiagnoseGate(store, { lookup } = {}) {
  return async (exec, next) => {
    const decision = diagnoseToolDecision(exec?.name)
    if (!decision) return next()
    if (!isDiagnoseSession(store, exec?.agent?.session, { lookup })) return next()
    if (decision === 'deny') {
      return { kind: 'deny', reason: `dsh-mem0: ${exec.name} is not available in a read-only diagnosis session (memories are not changed while diagnosing).` }
    }
    return { kind: 'ask', reason: `dsh-mem0: ${exec.name} writes to memory; this is a read-only diagnosis session.` }
  }
}

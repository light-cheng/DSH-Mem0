/**
 * Diagnosis sessions: the sessions the settings page opened with "Ask DSH to
 * diagnose" or "AI troubleshoot" (client.js), and what the plugin does
 * differently in them.
 *
 * A diagnosis session may fix what it finds, but DSH's permission presets
 * do not cover the plugin's own tools (tested on 0.2.2-rc.5), so the plugin
 * keeps the ids of the sessions it opened and, in those sessions only:
 * - asks before its memory-writing tools (`tools/pre-execute`): all of them
 *   by default; with "skip confirmation" ticked only mem0_delete and
 *   mem0_profile_reset, which always ask;
 * - refuses, whatever was ticked, a tool call that names a credential file
 *   or the keychain, or that writes DSH's cordis.patch.yml (DSH rewrites it;
 *   settings change through the settings page);
 * - skips automatic recall and capture (lib/memory-lifecycle.js);
 * - leaves memories of those sessions out of hygiene
 *   (lib/memory-maintenance.js).
 * The settings page's own delete route is the user acting and stays as is.
 *
 * The record also maps a fingerprint (lib/diagnose-report.js; a fixed one
 * for the general "AI troubleshoot" entry) to its session, so a second
 * click on the same problem returns to it.
 *
 * File: `<profile>/dsh-mem0/diagnose-sessions.json`
 *   { "version": 2, "sessions": [ { "sessionId", "fingerprint", "skipConfirm", "createdAt" } ] }
 * newest first, at most DIAGNOSE_SESSION_LIMIT entries (version 1 files load
 * with skipConfirm false). Without a profile directory the record stays in
 * memory.
 */
import fs from 'node:fs'
import path from 'node:path'

export const DIAGNOSE_SESSIONS_FILE = 'diagnose-sessions.json'
export const DIAGNOSE_SESSION_LIMIT = 50
/** The plugin's tools that change memories. */
export const DIAGNOSE_WRITE_TOOLS = Object.freeze(['mem0_add', 'mem0_update', 'mem0_pin', 'mem0_profile_update', 'mem0_delete', 'mem0_profile_reset'])
/** Write tools that ask even with "skip confirmation" ticked. */
export const DIAGNOSE_ALWAYS_CONFIRM = Object.freeze(['mem0_delete', 'mem0_profile_reset'])

const SESSION_ID = /^[A-Za-z0-9_.:-]{1,200}$/
const FINGERPRINT = /^[A-Za-z0-9_.:-]{1,120}$/

// Hard limits in a diagnosis session, whatever was ticked. A call is
// matched on its JSON arguments, so a path in any field (file_path,
// command, pattern) counts.
const CREDENTIALS = /\.credentials\.ya?ml|credentials\.json|\.mem0[\\/]config\.json|(?:^|[\s"'=/\\])\.env(?:\.[\w.-]+)?(?=$|[\s"';|&)])|\bsecurity\s+(?:find-[\w-]*password|dump-keychain)/i
const PATCH_FILE = /cordis\.patch\.yml/i
const FILE_WRITERS = new Set(['write', 'edit', 'apply_patch', 'multi_edit'])
const SHELLS = new Set(['bash', 'pwsh', 'shell', 'terminal'])
// Shell forms that change a file named on the same line.
const SHELL_WRITE = /(?:^|[^<>&0-9])>{1,2}(?!&)|\btee\b|\bsed\s+(?:-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|\b(?:mv|cp|rm|ln|truncate|chmod|install|dd|ed|ex)\b|\byq\b[^|;&]*\s-i\b|\bpython3?\b|\bnode\b|\bruby\b/

/** 'ask' or null (allowed) for one plugin tool in a diagnosis session. */
export function diagnoseToolDecision(name, { skipConfirm = false } = {}) {
  if (!DIAGNOSE_WRITE_TOOLS.includes(name)) return null
  if (skipConfirm && !DIAGNOSE_ALWAYS_CONFIRM.includes(name)) return null
  return 'ask'
}

function argumentText(exec) {
  try {
    return JSON.stringify(exec?.arguments ?? exec?.args ?? exec?.input ?? '')
  } catch {
    return ''
  }
}

/**
 * Why a call is refused in a diagnosis session whatever was ticked, or
 * null: 'credentials' (a credential file or the keychain) or 'patch' (a
 * write to cordis.patch.yml).
 */
export function diagnoseHardLimit(exec) {
  const name = String(exec?.name ?? '')
  const text = argumentText(exec)
  if (!text) return null
  if (CREDENTIALS.test(text)) return 'credentials'
  if (PATCH_FILE.test(text)) {
    if (FILE_WRITERS.has(name)) return 'patch'
    if (SHELLS.has(name) && SHELL_WRITE.test(text)) return 'patch'
  }
  return null
}

function normalise(raw) {
  if (!raw || typeof raw !== 'object') return null
  const sessionId = typeof raw.sessionId === 'string' && SESSION_ID.test(raw.sessionId) ? raw.sessionId : null
  if (!sessionId) return null
  const fingerprint = typeof raw.fingerprint === 'string' && FINGERPRINT.test(raw.fingerprint) ? raw.fingerprint : null
  const time = Date.parse(raw.createdAt)
  return {
    sessionId,
    fingerprint,
    skipConfirm: raw.skipConfirm === true,
    createdAt: Number.isFinite(time) ? new Date(time).toISOString() : new Date(0).toISOString(),
  }
}

export class DiagnoseSessions {
  constructor({ filePath, limit = DIAGNOSE_SESSION_LIMIT, logger, now = () => new Date() } = {}) {
    this.filePath = filePath
    this.limit = limit
    this.logger = logger
    this.now = now
    this.listeners = new Set()
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
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A listener (the skill's cache invalidation) never blocks the record.
      }
    }
    if (!this.filePath) return true
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(temporary, `${JSON.stringify({ version: 2, sessions: this.entries }, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(temporary, this.filePath)
      return true
    } catch (error) {
      this.logger?.warn?.(`dsh-mem0: could not write diagnosis session record: ${error.message}`)
      return false
    }
  }

  /** Call `listener` whenever the record changes; returns the disposer. */
  onChange(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The entry of a diagnosis session this plugin opened, or null. */
  entry(sessionId) {
    if (sessionId === undefined || sessionId === null || sessionId === '') return null
    const id = String(sessionId)
    return this.entries.find((item) => item.sessionId === id) ?? null
  }

  /** Whether `sessionId` is a diagnosis session this plugin opened. */
  has(sessionId) {
    return this.entry(sessionId) !== null
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
   * Record a session (before its first prompt, so the gate and the skill
   * are in place for the first turn). A fingerprint already mapped moves to
   * the new session.
   * @returns whether it was stored (false: bad id, or the file failed to write).
   */
  register({ sessionId, fingerprint, skipConfirm = false } = {}) {
    const entry = normalise({ sessionId, fingerprint, skipConfirm: skipConfirm === true, createdAt: this.now().toISOString() })
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
 * The record entry of a session, or of the main session above a subagent;
 * null for any other session. `lookup(id)` returns a session by id (DSH's
 * host `sessions` registry), to follow `header.parentSession` of subagent
 * sessions.
 */
export function diagnoseEntryOf(store, session, { lookup } = {}) {
  if (!store || !session) return null
  let current = session
  const seen = new Set()
  for (let depth = 0; current && depth < 6; depth += 1) {
    const id = current.id ?? current.header?.id
    const own = store.entry(id)
    if (own) return own
    if (id !== undefined) seen.add(String(id))
    const header = current.header
    if (header?.origin !== 'subagent' || !header.parentSession || seen.has(String(header.parentSession))) return null
    const parentEntry = store.entry(header.parentSession)
    if (parentEntry) return parentEntry
    let parent
    try {
      parent = typeof lookup === 'function' ? lookup(header.parentSession) : undefined
    } catch {
      parent = undefined
    }
    current = parent
  }
  return null
}

/** Whether a session, or the main session above a subagent, is a diagnosis session. */
export function isDiagnoseSession(store, session, options) {
  return diagnoseEntryOf(store, session, options) !== null
}

// `ask` is shown to the user on DSH's confirmation card, so it follows the
// language of the latest diagnosis prompt; the refusals go to the model.
const REASONS = {
  ask: (name, lang) => (lang === 'zh' ? `dsh-mem0：${name} 会改动记忆，请确认（诊断会话）。` : `dsh-mem0: ${name} changes memories; confirm it in this diagnosis session.`),
  credentials: (name) => `dsh-mem0: ${name} is refused in a diagnosis session: it names an API key or credential store, which diagnosis never reads.`,
  patch: (name) =>
    `dsh-mem0: ${name} is refused in a diagnosis session: cordis.patch.yml is rewritten by DSH and is never edited directly. Tell the user which setting to change on the plugin's settings page instead.`,
}

/**
 * The `tools/pre-execute` listener: in a diagnosis session, refuse the hard
 * limits and ask for the plugin's write tools as the session's
 * "skip confirmation" choice says; everything else passes on. `lang()` is
 * the language of the confirmation text ('zh' or 'en').
 */
export function createDiagnoseGate(store, { lookup, lang = () => 'en' } = {}) {
  return async (exec, next) => {
    const entry = diagnoseEntryOf(store, exec?.agent?.session, { lookup })
    if (!entry) return next()
    const limit = diagnoseHardLimit(exec)
    if (limit) return { kind: 'deny', reason: REASONS[limit](exec.name) }
    if (diagnoseToolDecision(exec?.name, { skipConfirm: entry.skipConfirm }) === 'ask') {
      let language = 'en'
      try {
        language = lang()
      } catch {
        language = 'en'
      }
      return { kind: 'ask', reason: REASONS.ask(exec.name, language) }
    }
    return next()
  }
}

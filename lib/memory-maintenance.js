/**
 * Derive a compact profile from Mem0 facts and keep the store bounded.
 *
 * Mem0 is the source of truth. The profile and hygiene bookkeeping live in a
 * small local JSON file so a failed rebuild never mutates memory records.
 * Everything here is deterministic: no extra model calls are made.
 */
import { estimateTokens } from './token-budget.js'
import { createHash, randomUUID } from 'node:crypto'
import { redactSecrets, stripRecallDelimiters } from './redact.js'

// Han ideographs mark Chinese; kana or Hangul mean Japanese or Korean, which
// share Han characters but would be wrong with Chinese headings.
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const KANA_HANGUL = /[\u3040-\u30ff\uac00-\ud7af]/
const TRIVIAL = /^(ok|okay|thanks|thank you|thx|yes|no|yep|nope|sure|got it|收到|好的|好|嗯|谢谢|多谢|可以|行|没问题|继续|go on|continue)[.!?。！？]*$/i
const DURABLE = /(记住|以后|默认|偏好|喜欢|不喜欢|不要|必须|项目|决定|规则|习惯|我叫|我是|remember|prefer|always|never|default|project|decision|convention|my name|i am|i'm)/i
const COMMAND = /^\/[a-z][a-z0-9-]*(?:\s|$)/i
const URL_ONLY = /^https?:\/\/\S+$/i

export { estimateTokens }

export function memoryText(memory) {
  return String(memory?.memory ?? memory?.text ?? '').replace(/\s+/g, ' ').trim()
}

export function memoryId(memory) {
  return memory?.id == null ? '' : String(memory.id)
}

const DETAIL_KEYS = ['plannedDetails', 'duplicateDetails', 'suspectedDetails', 'prunedDetails', 'deletedDetails', 'skippedDetails']
export const REPORT_PREVIEW_CHARS = 60

/**
 * Remove memory text from a hygiene report before it is stored or shown as
 * history. Deleted memories must not survive as previews in maintenance.json,
 * so stored detail rows keep only the id and why it was (or would be) removed.
 * Also cleans reports written by older versions, which kept 160-char previews.
 * @param {object|null} report
 * @returns {object|null}
 */
export function stripReportText(report) {
  if (!report || typeof report !== 'object') return report ?? null
  const clean = { ...report }
  for (const key of DETAIL_KEYS) {
    if (!Array.isArray(report[key])) continue
    clean[key] = report[key].map((item) => ({
      id: item?.id ?? '',
      ...(item?.reason ? { reason: item.reason } : {}),
    }))
  }
  if (Array.isArray(report.failedDetails)) {
    clean.failedDetails = report.failedDetails.map((item) => ({
      id: item?.id ?? '',
      error: redactSecrets(String(item?.error ?? '')).slice(0, 200),
    }))
  }
  return clean
}

function timestamp(memory) {
  const value = memory?.updated_at ?? memory?.created_at ?? memory?.createdAt ?? memory?.updatedAt
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

const DAY_MS = 86_400_000
const RECENCY_DECAY_DAYS = 90

/**
 * Rank value of a memory. Pinned and importance (if present in metadata) come
 * first; otherwise freshness decides via exp(-ageDays / 90), scaled to 0–100.
 * Text length is not part of the score; `rankMemories` only uses it to break
 * exact ties (shorter first).
 */
export function memoryScore(memory, now = Date.now()) {
  const metadata = memory?.metadata && typeof memory.metadata === 'object' ? memory.metadata : {}
  const importance = Number.isFinite(Number(metadata.importance)) ? Number(metadata.importance) : 0
  const pinned = metadata.pinned === true ? 1 : 0
  const at = timestamp(memory)
  const ageDays = Math.max(0, (now - at) / DAY_MS)
  const recency = at > 0 ? Math.exp(-ageDays / RECENCY_DECAY_DAYS) : 0
  return pinned * 1e6 + importance * 1e4 + recency * 100
}

/** Only memories this plugin wrote (capture and mem0_add tag them) may be deleted. */
export function isOwnMemory(memory) {
  return memory?.metadata?.source === 'dsh'
}

/**
 * Exact-duplicate key used for deletion: a hash of the full text after only
 * meaning-preserving normalisation (Unicode NFC, case, leading/trailing and
 * repeated whitespace). Punctuation and digits are kept, so `1.5 mg` and
 * `15 mg` differ, and there is no prefix cut-off, so two long facts that
 * differ only at the end differ too. Empty for empty text.
 */
export function dedupeKey(text) {
  const normalized = String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return ''
  return createHash('sha256').update(normalized).digest('hex')
}

/**
 * Loose key (punctuation dropped, first 240 characters) for facts that only
 * look alike. A match is reported as a suspected duplicate and never deleted.
 */
export function similarityKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[。！？.!?；;，,、:：\-—_/\\]+/g, '')
    .trim()
    .slice(0, 240)
}

/**
 * The memory store a summary, a hygiene history and a deletion authorisation
 * belong to: backend, endpoint (no credentials), OSS collection, user and
 * agent. A change to any of them is another store.
 */
export function memoryScope(config) {
  const backend = String(config?.backend ?? '')
  const endpoint =
    backend === 'oss'
      ? String(config?.mem0ConfigPath ?? '')
      : String(config?.baseUrl ?? '')
          .trim()
          .replace(/\/+$/, '')
          .replace(/\/\/[^/@\s]*@/, '//')
          .toLowerCase()
  return {
    backend,
    endpoint,
    collection: backend === 'oss' ? String(config?.collectionName ?? '') : '',
    userId: String(config?.userId ?? ''),
    agentId: String(config?.agentId ?? ''),
  }
}

export function scopeKey(config) {
  return createHash('sha256').update(JSON.stringify(memoryScope(config))).digest('hex').slice(0, 24)
}

function memoryVersion(memory) {
  return String(memory?.updated_at ?? memory?.updatedAt ?? memory?.created_at ?? memory?.createdAt ?? '')
}

export function rankMemories(memories, now = Date.now()) {
  return (Array.isArray(memories) ? memories : [])
    .filter((memory) => memory && memoryId(memory) && memoryText(memory))
    .map((memory) => ({ memory, score: memoryScore(memory, now), length: memoryText(memory).length }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.length - b.length ||
        memoryId(a.memory).localeCompare(memoryId(b.memory)),
    )
    .map((entry) => entry.memory)
}

export function dedupeMemories(memories) {
  const seen = new Set()
  const unique = []
  const duplicates = []
  for (const memory of rankMemories(memories)) {
    const key = dedupeKey(memoryText(memory))
    if (!key) continue
    if (seen.has(key)) {
      duplicates.push(memory)
    } else {
      seen.add(key)
      unique.push(memory)
    }
  }
  return { unique, duplicates }
}

export function selectForBudget(memories, { maxItems = 500, maxTokens = 20_000 } = {}) {
  const keep = []
  const remove = []
  let tokens = 0
  for (const memory of rankMemories(memories)) {
    const cost = estimateTokens(memoryText(memory)) + 8
    if (keep.length >= maxItems || tokens + cost > maxTokens) {
      remove.push(memory)
      continue
    }
    keep.push(memory)
    tokens += cost
  }
  return { keep, remove, tokens }
}

const PROFILE_SECTIONS = [
  {
    titles: { en: 'Work and projects', zh: '工作与项目' },
    pattern:
      /work|project|code|plugin|dsh|mem0|build|develop|job|company|team|api|repo|工作|项目|开发|插件|代码|公司|团队/i,
  },
  {
    titles: { en: 'Preferences and habits', zh: '偏好与习惯' },
    pattern:
      /prefer|like|love|favorite|favourite|habit|style|tone|food|drink|tea|coffee|喜欢|偏好|习惯|口味|风格|饮食|茶|咖啡/i,
  },
  {
    titles: { en: 'Learning and interests', zh: '学习与兴趣' },
    pattern:
      /learn|study|read|book|music|language|course|interest|学习|阅读|音乐|语言|课程|兴趣|书/i,
  },
  {
    titles: { en: 'Life and travel', zh: '生活与旅行' },
    pattern:
      /travel|trip|food|health|family|home|city|life|生活|旅行|健康|家庭|城市|日常/i,
  },
]
const OTHER_TITLES = { en: 'Other', zh: '其他' }

function profileSection(text, language) {
  for (const section of PROFILE_SECTIONS) {
    if (section.pattern.test(text)) return section.titles[language]
  }
  return OTHER_TITLES[language]
}

/**
 * Pick the heading language from the memories themselves: Chinese only when
 * a clear majority of facts are Chinese, English otherwise (including empty
 * or evenly mixed stores, and Japanese or Korean text).
 * @returns {'en'|'zh'}
 */
export function profileLanguage(memories) {
  let chinese = 0
  let total = 0
  for (const memory of Array.isArray(memories) ? memories : []) {
    const text = memoryText(memory)
    if (!text) continue
    total += 1
    if (HAN.test(text) && !KANA_HANGUL.test(text)) chinese += 1
  }
  return total > 0 && chinese * 2 > total ? 'zh' : 'en'
}

export function buildProfile(memories, maxTokens = 1375, { language } = {}) {
  const lang = language === 'zh' || language === 'en' ? language : profileLanguage(memories)
  const buckets = new Map()
  const memoryIds = []
  const memoryVersions = {}
  let tokens = 0
  for (const memory of rankMemories(memories)) {
    // Other apps can write to the same user; their secrets and any forged
    // block delimiters never enter the summary.
    const raw = stripRecallDelimiters(redactSecrets(memoryText(memory))).replace(/\s+/g, ' ').trim()
    if (!raw) continue
    const line = `- ${raw.length > 320 ? `${raw.slice(0, 317).trimEnd()}…` : raw}`
    const title = profileSection(raw, lang)
    const headingCost = buckets.has(title) ? 0 : estimateTokens(`## ${title}`) + 2
    const cost = estimateTokens(line) + 2 + headingCost
    if (tokens + cost > maxTokens) continue
    if (!buckets.has(title)) buckets.set(title, [])
    buckets.get(title).push(line)
    memoryIds.push(memoryId(memory))
    memoryVersions[memoryId(memory)] = memoryVersion(memory)
    tokens += cost
  }
  const lines = []
  for (const [title, items] of buckets) {
    if (lines.length > 0) lines.push('')
    lines.push(`## ${title}`, ...items)
  }
  return {
    text: lines.join('\n'),
    tokens,
    items: memoryIds.length,
    memoryIds,
    memoryVersions,
  }
}

/**
 * Decide whether a completed turn is likely to contain durable facts.
 * `off` keeps the old capture-everything behaviour.
 */
export function shouldCaptureConversation(messages, { filter = 'heuristic' } = {}) {
  if (filter === 'off') return true
  const list = Array.isArray(messages) ? messages : []
  const userTexts = list
    .filter((message) => message?.role === 'user')
    .map((message) => String(message.content ?? '').trim())
    .filter(Boolean)
  if (userTexts.length === 0) return false
  if (userTexts.every((text) => TRIVIAL.test(text))) return false
  if (userTexts.every((text) => URL_ONLY.test(text) || COMMAND.test(text))) return false
  const combined = userTexts.join('\n')
  if (DURABLE.test(combined)) return true
  if (userTexts.some((text) => text.length >= 80)) return true
  const totalChars = list.reduce((total, message) => total + String(message.content ?? '').length, 0)
  return totalChars >= 160
}


// One maintenance pass at a time per state file (or store), across plugin
// instances: a reloaded plugin's first pass waits until the disposed
// instance's pass has stopped, so two instances never delete at once.
const ACTIVE_RUNS = new Map()
const MAX_SCOPES = 16
// A confirmation must arrive soon after its preview, from the same instance.
export const PLAN_TTL_MS = 15 * 60_000
const MAX_PLANS = 8

function maintenanceError(message, code) {
  return Object.assign(new Error(message), { code })
}

function abortError(signal) {
  const reason = signal?.reason
  if (reason instanceof Error && reason.code === 'ABORTED') return reason
  return maintenanceError('dsh-mem0: memory maintenance was stopped (plugin disposed)', 'ABORTED')
}

function usableProfileText(profile) {
  return profile && typeof profile.text === 'string' && profile.text.trim() ? profile.text : ''
}

export class MemoryMaintenance {
  constructor({ client, config, state, logger, activity = {}, localizer, failures } = {}) {
    // Optional FailureHistory (lib/failure-history.js).
    this.failures = failures
    this.client = client
    this.localizer = localizer
    this.config = config
    this.state = state
    this.logger = logger
    this.activity = activity
    this.running = null
    this.lastError = null
    this.disposed = false
    this.controller = new AbortController()
    this.scope = memoryScope(config)
    this.scopeKey = scopeKey(config)
    // Previewed deletion plans, by planId (manual previews only).
    this.plans = new Map()
    // Bumped on every delete/update, so a pass that listed the store before
    // the change does not save a summary that still contains it.
    this.invalidations = 0
    this.rebuildPending = false
  }

  get signal() {
    return this.controller.signal
  }

  #throwIfAborted() {
    if (this.signal.aborted) throw abortError(this.signal)
  }

  /**
   * This store's entry. Version-1 files had one flat entry keyed only by
   * user: it is adopted once, keeping only a manual summary for the same
   * user. A generated summary is rebuilt, and the deletion authorisation
   * (`lastRunAt`) is dropped because it cannot be tied to a store.
   */
  #entry(saved = this.state?.read() ?? {}) {
    const entry = saved.scopes?.[this.scopeKey]
    if (entry) return { profile: entry.profile ?? null, hygiene: entry.hygiene ?? null }
    if (saved.userId && saved.userId === this.config.userId && (saved.profile || saved.hygiene)) {
      const legacy = saved.profile
      const profile =
        legacy?.manual === true && usableProfileText(legacy)
          ? { ...legacy, userId: this.config.userId, migrated: true }
          : null
      const hygiene = saved.hygiene
        ? {
            lastRunAt: null,
            previewAt: saved.hygiene.previewAt ?? null,
            lastReport: saved.hygiene.lastReport ?? null,
          }
        : null
      return { profile, hygiene }
    }
    return { profile: null, hygiene: null }
  }

  /** Save this store's entry; other stores' entries are kept (newest 16). */
  #writeEntry({ profile, hygiene }, saved = this.state?.read() ?? {}) {
    this.#throwIfAborted()
    const now = new Date().toISOString()
    const scopes = { ...(saved.scopes ?? {}) }
    scopes[this.scopeKey] = { scope: this.scope, profile: profile ?? null, hygiene: hygiene ?? null, updatedAt: now }
    const keys = Object.keys(scopes)
    if (keys.length > MAX_SCOPES) {
      keys
        .filter((key) => key !== this.scopeKey)
        .sort((a, b) => String(scopes[a].updatedAt ?? '').localeCompare(String(scopes[b].updatedAt ?? '')))
        .slice(0, keys.length - MAX_SCOPES)
        .forEach((key) => delete scopes[key])
    }
    return this.state?.write({ version: 2, userId: '', profile: null, hygiene: null, scopes }) ?? false
  }

  profileVersion() {
    return this.#entry().profile?.updatedAt ?? ''
  }

  /** The summary to inject for this store, redacted; '' when stale or absent. */
  profileBlock() {
    if (!this.config.profileEnabled) return ''
    const { profile } = this.#entry()
    if (!profile || profile.stale === true) return ''
    return stripRecallDelimiters(redactSecrets(usableProfileText(profile))).trim()
  }

  isManualProfile() {
    const { profile } = this.#entry()
    return Boolean(profile?.manual === true && usableProfileText(profile).trim())
  }

  /**
   * Persist a user-edited memory summary. Empty text clears the manual
   * profile so the next hygiene/profile pass can regenerate it. The edit
   * inherits the source ids of the summary it replaces, so deleting one of
   * those memories later flags the manual summary.
   */
  setProfileText(text) {
    if (!this.config.profileEnabled) throw new Error('profile generation is disabled')
    const value = stripRecallDelimiters(redactSecrets(String(text ?? ''))).trim()
    const maxTokens = Number(this.config.profileBudgetTokens ?? 1375)
    const tokens = estimateTokens(value)
    if (value && tokens > maxTokens) {
      throw new Error(`memory summary is too long: ${tokens} tokens (max ${maxTokens})`)
    }
    const saved = this.state?.read() ?? {}
    const entry = this.#entry(saved)
    const now = new Date().toISOString()
    const previous = entry.profile
    const profile = value
      ? {
          userId: this.config.userId,
          text: value,
          tokens,
          items: value.split('\n').filter((line) => line.trim()).length,
          updatedAt: now,
          manual: true,
          source: 'manual',
          memoryIds: Array.isArray(previous?.memoryIds) ? previous.memoryIds : [],
        }
      : null
    if (!this.#writeEntry({ profile, hygiene: entry.hygiene }, saved)) {
      throw new Error(this.state?.lastError || 'could not save memory summary')
    }
    return this.status()
  }

  #generatedProfile(built, updatedAt) {
    return built.text
      ? {
          userId: this.config.userId,
          text: built.text,
          tokens: built.tokens,
          items: built.items,
          updatedAt,
          manual: false,
          source: 'generated',
          memoryIds: built.memoryIds,
          memoryVersions: built.memoryVersions,
        }
      : null
  }

  /**
   * Rebuild the profile from all memories without deleting or pruning any.
   * Used by the UI reset button and the agent's reset tool.
   */
  async resetProfile() {
    if (!this.config.profileEnabled) throw new Error('profile generation is disabled')
    const startedAt = Date.now()
    const epoch = this.invalidations
    let all
    try {
      all = await this.#listAll()
    } catch (error) {
      if (!this.signal.aborted) this.failures?.record({ kind: 'summary', error, durationMs: Date.now() - startedAt })
      throw error
    }
    const built = buildProfile(all, this.config.profileBudgetTokens)
    const saved = this.state?.read() ?? {}
    const entry = this.#entry(saved)
    const profile = this.#generatedProfile(built, new Date().toISOString())
    if (profile && epoch !== this.invalidations) {
      profile.stale = true
      this.rebuildPending = true
    }
    if (!this.#writeEntry({ profile, hygiene: entry.hygiene }, saved)) {
      throw new Error(this.state?.lastError || 'could not save memory summary')
    }
    this.#scheduleRebuild()
    return this.status()
  }

  /**
   * A memory was deleted or its text replaced (tool, settings page). A
   * generated summary built from it stops being injected at once and is
   * rebuilt in the background; summaries without a source list count as
   * built from it. A manual summary stays (the user owns its text) but is
   * flagged when the memory was among its inherited sources, or when its
   * sources are unknown, so the settings page can say it may be outdated.
   * @param {string[]} ids
   * @param {{ reason?: 'delete'|'update' }} [options]
   */
  invalidateMemories(ids, { reason = 'delete' } = {}) {
    const changed = new Set((Array.isArray(ids) ? ids : [ids]).map((id) => String(id ?? '')).filter(Boolean))
    if (changed.size === 0 || this.disposed) return false
    this.invalidations += 1
    const saved = this.state?.read() ?? {}
    const entry = this.#entry(saved)
    const profile = entry.profile
    if (!profile) return false
    const sources = Array.isArray(profile.memoryIds) ? profile.memoryIds.map(String) : null
    const affected = sources === null || sources.some((id) => changed.has(id))
    if (!affected) return false
    const now = new Date().toISOString()
    const next =
      profile.manual === true
        ? { ...profile, sourcesChanged: true, sourcesChangedAt: now, sourcesChangedReason: reason }
        : { ...profile, stale: true, staleAt: now }
    try {
      this.#writeEntry({ profile: next, hygiene: entry.hygiene }, saved)
    } catch (error) {
      this.logger?.debug?.(`dsh-mem0: could not mark the memory summary stale: ${error.message}`)
      return false
    }
    if (profile.manual !== true) {
      this.rebuildPending = true
      this.#scheduleRebuild()
    }
    return true
  }

  #scheduleRebuild() {
    if (!this.rebuildPending || this.disposed || this.running) return
    this.rebuildPending = false
    const timer = setTimeout(() => {
      void this.maybeRun('summary')
    }, 0)
    timer.unref?.()
  }

  status(now = new Date()) {
    const { profile, hygiene: savedHygiene } = this.#entry()
    const hygiene = savedHygiene ?? {}
    const lastRunAt = hygiene.lastRunAt ?? null
    const last = Date.parse(lastRunAt ?? hygiene.previewAt ?? '')
    const interval = Number(this.config.hygieneIntervalDays ?? 7)
    const next = Number.isFinite(last) ? last + interval * 86_400_000 : null
    return {
      enabled: Boolean(this.config.hygieneEnabled),
      intervalDays: interval,
      running: Boolean(this.running),
      lastRunAt,
      previewAt: hygiene.previewAt ?? null,
      // Until one confirmed run has happened for this store, automatic
      // passes only preview.
      previewOnly: !lastRunAt,
      nextRunAt: next === null ? null : new Date(next).toISOString(),
      due: this.isDue(now),
      lastReport: stripReportText(hygiene.lastReport ?? null),
      lastError: this.lastError ?? this.state?.lastError ?? null,
      stateError: this.state?.lastError ?? null,
      scope: { ...this.scope, key: this.scopeKey },
      profile: {
        enabled: Boolean(this.config.profileEnabled),
        tokens: Number(profile?.tokens ?? 0),
        items: Number(profile?.items ?? 0),
        updatedAt: profile?.updatedAt ?? null,
        manual: profile?.manual === true,
        source: profile?.source ?? (profile?.manual ? 'manual' : 'generated'),
        stale: profile?.stale === true,
        sourcesChanged: profile?.manual === true && profile?.sourcesChanged === true,
      },
    }
  }

  isDue(now = new Date()) {
    if (!this.config.hygieneEnabled) return false
    const hygiene = this.#entry().hygiene ?? {}
    const last = Date.parse(hygiene.lastRunAt ?? hygiene.previewAt ?? '')
    if (!Number.isFinite(last)) return true
    return now.getTime() >= last + Number(this.config.hygieneIntervalDays ?? 7) * 86_400_000
  }

  needsProfileRebuild() {
    const { profile } = this.#entry()
    if (!this.config.profileEnabled || !profile) return false
    if (profile.manual === true) return false
    if (profile.stale === true) return true
    const text = String(profile.text ?? '').trim()
    return Boolean(text) && !/^##\s+/m.test(text)
  }

  async maybeRun(reason = 'schedule') {
    if (this.disposed || this.running) return null
    const needsProfile = Boolean(this.config.profileEnabled) && !this.profileBlock()
    const needsStructure = this.needsProfileRebuild()
    if (!this.isDue() && !needsProfile && !needsStructure) return null
    try {
      // Automatic passes never delete until a confirmed manual run has
      // recorded `lastRunAt` for this store; before that they only preview.
      const dryRun = !this.#entry().hygiene?.lastRunAt
      return await this.run(reason, { profileOnly: !this.isDue(), dryRun })
    } catch (error) {
      if (error?.code !== 'ABORTED') this.logger?.warn?.(`dsh-mem0: memory hygiene failed: ${error.message}`)
      return null
    }
  }

  run(reason = 'manual', options = {}) {
    if (this.disposed) return Promise.reject(abortError(this.signal))
    if (this.running) return this.running
    const key = this.state?.filePath || `store:${this.scopeKey}`
    const previous = ACTIVE_RUNS.get(key)
    const task = (async () => {
      if (previous) await previous.catch(() => {})
      this.#throwIfAborted()
      return this.#run(reason, options)
    })()
    const tracked = task.finally(() => {
      if (this.running === tracked) this.running = null
      if (ACTIVE_RUNS.get(key) === tracked) ACTIVE_RUNS.delete(key)
      this.#scheduleRebuild()
    })
    this.running = tracked
    ACTIVE_RUNS.set(key, tracked)
    return tracked
  }

  #prunePlans(now = Date.now()) {
    for (const [id, plan] of this.plans) {
      if (!plan.promise && !plan.result && now - plan.createdAt > PLAN_TTL_MS) this.plans.delete(id)
    }
    while (this.plans.size > MAX_PLANS) this.plans.delete(this.plans.keys().next().value)
  }

  /**
   * Execute a previewed plan once. Only the plan's ids that still exist,
   * still belong to this plugin and are unchanged since the preview are
   * deleted. The same planId runs at most once: a resend (a lost response,
   * a double click) gets the first result back, never a second pass.
   * @param {{ planId: string, idempotencyKey: string }} request
   */
  async runPlan({ planId, idempotencyKey } = {}) {
    const id = String(planId ?? '')
    const key = String(idempotencyKey ?? '')
    if (!id || !key) {
      throw maintenanceError('a confirmed cleanup needs the planId of its preview and an idempotency key', 'plan-required')
    }
    this.#prunePlans()
    const plan = this.plans.get(id)
    if (!plan) {
      throw maintenanceError('this cleanup preview has expired or is unknown; preview again', 'plan-unknown')
    }
    if (plan.idempotencyKey && plan.idempotencyKey !== key) {
      throw maintenanceError('this cleanup preview was already confirmed by another request; preview again', 'plan-conflict')
    }
    if (plan.result) return { ...plan.result, replayed: true }
    if (plan.promise) return plan.promise
    if (plan.scopeKey !== this.scopeKey) {
      this.plans.delete(id)
      throw maintenanceError('the memory store changed since this preview; preview again', 'plan-scope')
    }
    plan.idempotencyKey = key
    plan.promise = (async () => {
      while (this.running) await this.running.catch(() => {})
      return this.run('manual', { dryRun: false, plan })
    })()
    try {
      plan.result = await plan.promise
      return plan.result
    } finally {
      plan.promise = null
    }
  }

  async #listAll() {
    const result = await this.client.list(
      { user_id: this.config.userId },
      // timeoutMs (the per-request setting) applies, as for every request.
      { topK: 1000, signal: this.signal },
    )
    this.#throwIfAborted()
    return Array.isArray(result?.results) ? result.results : []
  }

  /**
   * One maintenance pass. Only memories tagged `metadata.source === 'dsh'`
   * are eligible for deletion; others (written by other Mem0 apps under the
   * same user_id) feed the summary but are never removed or budgeted.
   *
   * Deletion only removes exact duplicates (full-text hash) and over-budget
   * memories; facts that merely look alike are reported as suspected.
   *
   * `dryRun` computes the same plan without deleting. A manual dry run (the
   * settings page preview) leaves the state file untouched and returns a
   * `planId` that `runPlan` executes; an automatic one records the preview
   * report and `previewAt`. `plan` restricts deletion to that preview's ids.
   */
  async #run(reason, { profileOnly = false, dryRun = false, plan } = {}) {
    const startedAt = new Date().toISOString()
    const epoch = this.invalidations
    this.lastError = null
    this.activity.maintenance = { status: 'running', reason, startedAt }
    try {
      const now = Date.parse(startedAt)
      const all = await this.#listAll()
      const ranked = rankMemories(all, now)
      const own = ranked.filter(isOwnMemory)
      const foreign = ranked.filter((memory) => !isOwnMemory(memory))
      const hygieneEnabled = !profileOnly && Boolean(this.config.hygieneEnabled)
      const duplicates = []
      const suspected = []
      let ownUnique = own
      if (hygieneEnabled) {
        // Foreign copies always win: an own duplicate of a foreign memory is
        // removable, a foreign duplicate is never touched.
        const seen = new Set(foreign.map((memory) => dedupeKey(memoryText(memory))))
        const similar = new Set(foreign.map((memory) => similarityKey(memoryText(memory))))
        ownUnique = []
        for (const memory of own) {
          const text = memoryText(memory)
          const key = dedupeKey(text)
          if (!key) continue
          if (seen.has(key)) {
            duplicates.push(memory)
            continue
          }
          const loose = similarityKey(text)
          if (loose && similar.has(loose)) suspected.push(memory)
          seen.add(key)
          if (loose) similar.add(loose)
          ownUnique.push(memory)
        }
      }
      const costOf = (memories) =>
        memories.reduce((total, memory) => total + estimateTokens(memoryText(memory)) + 8, 0)
      const budget = hygieneEnabled
        ? selectForBudget(ownUnique, {
            maxItems: this.config.storeMaxMemories,
            maxTokens: this.config.storeMaxTokens,
          })
        : { keep: ownUnique, remove: [], tokens: costOf(ownUnique) }
      const duplicateSet = new Set(duplicates)
      const removals = hygieneEnabled ? [...duplicates, ...budget.remove] : []
      // A confirmed preview deletes only its own ids that are still here,
      // still this plugin's and unchanged; everything else is skipped.
      let planned
      const skippedDetails = []
      if (plan) {
        const present = new Map(own.map((memory) => [memoryId(memory), memory]))
        planned = []
        for (const [id, item] of plan.items) {
          const memory = present.get(id)
          if (!memory) skippedDetails.push({ id, reason: 'missing' })
          else if (memoryVersion(memory) !== item.version) skippedDetails.push({ id, reason: 'changed' })
          else planned.push(memory)
        }
      } else {
        planned = removals.slice(0, 100)
      }
      const planReasons = plan ? new Map([...plan.items].map(([id, item]) => [id, item.reason])) : null
      const reasonOf = (memory) =>
        planReasons?.get(memoryId(memory)) ?? (duplicateSet.has(memory) ? 'duplicate' : 'budget')
      // A short, redacted preview is only returned live from a manual dry run
      // (the settings page confirmation); stripReportText removes it before
      // anything is stored.
      const previewOf = (memory) => ({
        id: memoryId(memory),
        reason: reasonOf(memory),
        preview: redactSecrets(memoryText(memory)).slice(0, REPORT_PREVIEW_CHARS),
      })
      const duplicateDetails = duplicates.slice(0, 20).map(previewOf)
      const suspectedDetails = suspected.slice(0, 20).map((memory) => ({ ...previewOf(memory), reason: 'similar' }))
      const prunedDetails = budget.remove.slice(0, 20).map(previewOf)
      const plannedById = new Map(planned.map((memory) => [memoryId(memory), previewOf(memory)]))
      const deleted = []
      const failedDetails = []
      const deletedTexts = []
      if (!dryRun) {
        for (const memory of planned) {
          const id = memoryId(memory)
          if (!id) continue
          // Stop between deletes once the plugin is disposed or reloaded.
          if (this.signal.aborted) break
          try {
            await this.client.remove(id, { signal: this.signal })
            deleted.push(id)
            deletedTexts.push(String(memory?.memory ?? memory?.text ?? ''))
          } catch (error) {
            if (this.signal.aborted) break
            failedDetails.push({
              id,
              error: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200),
            })
            this.logger?.debug?.(`dsh-mem0: could not remove ${id}: ${error.message}`)
          }
        }
      }
      if (deletedTexts.length > 0) {
        // Cached translations of deleted memories must not outlive them.
        try {
          await this.localizer?.forget?.(deletedTexts)
        } catch (error) {
          this.logger?.debug?.(`dsh-mem0: could not prune translation cache: ${error.message}`)
        }
      }
      this.#throwIfAborted()
      // What is really left: the scanned store minus the deletes that
      // succeeded. A dry run projects the planned deletes instead.
      const deletedSet = new Set(deleted)
      const plannedSet = new Set(planned.map(memoryId))
      const remaining = all.filter((memory) => !deletedSet.has(memoryId(memory)))
      const projected = dryRun ? all.filter((memory) => !plannedSet.has(memoryId(memory))) : remaining
      const savedState = this.state?.read() ?? {}
      const entry = this.#entry(savedState)
      const savedProfile = entry.profile
      const keepManual = Boolean(this.config.profileEnabled && savedProfile?.manual === true && usableProfileText(savedProfile).trim())
      const finishedAt = new Date().toISOString()
      let nextProfile = null
      let profileStats = { tokens: 0, items: 0 }
      if (this.config.profileEnabled) {
        if (keepManual) {
          const sources = Array.isArray(savedProfile.memoryIds) ? savedProfile.memoryIds.map(String) : null
          const touched = deleted.length > 0 && (sources === null || sources.some((id) => deletedSet.has(id)))
          nextProfile = touched
            ? { ...savedProfile, sourcesChanged: true, sourcesChangedAt: finishedAt, sourcesChangedReason: 'hygiene' }
            : savedProfile
          profileStats = {
            tokens: Number(savedProfile.tokens ?? estimateTokens(savedProfile.text)),
            items: Number(savedProfile.items ?? savedProfile.text.split('\n').filter(Boolean).length),
          }
        } else {
          // Built from what is still stored, never from the plan: a preview
          // must not drop facts that are still in the store.
          const built = buildProfile(dedupeMemories(remaining).unique, this.config.profileBudgetTokens)
          nextProfile = this.#generatedProfile(built, finishedAt)
          if (nextProfile && epoch !== this.invalidations) {
            // A memory was deleted or edited while this pass ran; its list
            // may predate that, so rebuild once more before injecting.
            nextProfile.stale = true
            this.rebuildPending = true
          }
          profileStats = { tokens: built.tokens, items: built.items }
        }
      }
      const storeTokensBefore = costOf(all)
      const report = {
        reason,
        dryRun: Boolean(dryRun),
        startedAt,
        finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        scanned: all.length,
        storeBefore: all.length,
        storeTokensBefore,
        duplicates: duplicates.length,
        suspected: suspected.length,
        pruned: budget.remove.length,
        deleted: deleted.length,
        failed: failedDetails.length,
        skipped: skippedDetails.length,
        // In a dry run: how many a confirmed run would delete (max 100/run).
        planned: hygieneEnabled || plan ? planned.length : 0,
        plannedDetails: dryRun ? planned.slice(0, 20).map(previewOf) : [],
        own: own.length,
        foreign: foreign.length,
        // After a real run: what is left. In a dry run: what would be left.
        storeCount: projected.length,
        storeTokens: costOf(projected),
        profileItems: profileStats.items,
        profileTokens: profileStats.tokens,
        duplicateDetails,
        suspectedDetails,
        prunedDetails,
        deletedDetails: deleted.map((id) => plannedById.get(id) ?? { id }),
        failedDetails,
        skippedDetails: skippedDetails.slice(0, 20),
        ...(plan ? { planId: plan.planId } : {}),
      }
      const stored = stripReportText(report)
      if (dryRun && reason === 'manual') {
        // The preview becomes a plan the confirmation must name (also an
        // empty one: confirming it records this store's first run).
        {
          const planId = randomUUID()
          this.plans.set(planId, {
            planId,
            scopeKey: this.scopeKey,
            createdAt: Date.now(),
            items: new Map(planned.map((memory) => [memoryId(memory), { version: memoryVersion(memory), reason: reasonOf(memory) }])),
            idempotencyKey: '',
            promise: null,
            result: null,
          })
          this.#prunePlans()
          report.planId = planId
          report.planExpiresAt = new Date(Date.now() + PLAN_TTL_MS).toISOString()
        }
        this.activity.maintenance = { status: 'ok', ...stored }
        return report
      }
      this.#writeEntry(
        {
          profile: nextProfile,
          hygiene: profileOnly
            ? entry.hygiene ?? null
            : dryRun
              ? {
                  lastRunAt: entry.hygiene?.lastRunAt ?? null,
                  previewAt: finishedAt,
                  lastReport: stored,
                }
              : { lastRunAt: finishedAt, lastReport: stored },
        },
        savedState,
      )
      this.activity.maintenance = { status: 'ok', ...stored }
      return stored
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (this.signal.aborted) {
        // Stopped by dispose: not a backend failure, nothing more is written.
        this.activity.maintenance = { status: 'cancelled', reason, startedAt, at: new Date().toISOString() }
        throw abortError(this.signal)
      }
      this.lastError = message
      // A summary-only rebuild is `summary`; a hygiene pass is `maintenance`.
      this.failures?.record({
        kind: profileOnly ? 'summary' : 'maintenance',
        error,
        durationMs: Date.now() - Date.parse(startedAt),
      })
      this.activity.maintenance = {
        status: 'error',
        reason,
        startedAt,
        at: new Date().toISOString(),
        error: message,
      }
      throw error
    }
  }

  /**
   * Stop this instance: aborts the list and delete requests in flight, and
   * the running pass stops before its next delete or state write. Returns a
   * promise that settles once that pass has stopped.
   */
  dispose() {
    this.disposed = true
    if (!this.signal.aborted) {
      this.controller.abort(maintenanceError('dsh-mem0: memory maintenance was stopped (plugin disposed)', 'ABORTED'))
    }
    this.plans.clear()
    return (this.running ?? Promise.resolve()).then(
      () => undefined,
      () => undefined,
    )
  }
}

/**
 * Derive a compact profile from Mem0 facts and keep the store tidy.
 *
 * Mem0 is the source of truth. The profile and hygiene bookkeeping live in a
 * small local JSON file so a failed rebuild never mutates memory records.
 *
 * Hygiene is model-led, script-checked: the script removes exact
 * duplicates, picks what changed since the last review, groups it with
 * similar memories and enforces every limit; DSH's current model judges
 * each group (merge, delete, keep, importance; lib/memory-review.js). When
 * the model is off or unavailable the pass runs the script part only.
 * Nothing is deleted for size: above `storeSafetyLimit` the pass warns.
 */
import { estimateTokens } from './token-budget.js'
import { createHash, randomUUID } from 'node:crypto'
import { redactSecrets, stripRecallDelimiters } from './redact.js'
import { addUsage, defaultModel, providerListed } from './dsh-llm.js'
import { NEIGHBOR_THRESHOLD, UNAVAILABLE_CODES, groupKey, isPinned, pendingFresh, planReview, reviewGroup, timeOf } from './memory-review.js'
import { partitionKey, scopeOf } from './project-scope.js'
import { MAX_SUMMARY_CALLS, sameSources, sourcesKey, summaryInput, writeSummary } from './scope-summary.js'

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

const DETAIL_KEYS = ['plannedDetails', 'duplicateDetails', 'suspectedDetails', 'deletedDetails', 'skippedDetails', 'reviewDetails']
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
      ...(Array.isArray(item?.ids) ? { ids: item.ids.map(String).slice(0, 12) } : {}),
      ...(Number.isInteger(item?.level) ? { level: item.level } : {}),
    }))
  }
  // Merged text is memory content: it lives in the store, not in history.
  if (Array.isArray(report.mergePlan)) {
    clean.mergePlan = report.mergePlan.map((item) => ({ ids: Array.isArray(item?.ids) ? item.ids.map(String).slice(0, 12) : [] }))
  }
  if (Array.isArray(report.mergedDetails)) {
    clean.mergedDetails = report.mergedDetails.map((item) => ({
      ...(item?.id ? { id: item.id } : {}),
      ids: Array.isArray(item?.ids) ? item.ids.map(String).slice(0, 12) : [],
      ...(item?.pending ? { pending: true } : {}),
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

/** Stored importance (1–5), or 0 when the memory was never rated. */
export function memoryImportance(memory) {
  const value = memory?.importance ?? memory?.metadata?.importance
  const number = Number(value)
  return value !== null && value !== undefined && value !== '' && Number.isFinite(number) ? number : 0
}

/**
 * Rank value of a memory. Pinned first; otherwise freshness, exp(-ageDays /
 * 90) scaled to 0–100, weighted by importance within bounds: × 0.5
 * (importance 1) to × 1.5 (5), an unrated memory counting as 3. So a fresh
 * unrated fact still outranks an old one rated 1–2, and ratings (written
 * first for the memories reviewed first) never take the summary over.
 * Text length is not part of the score; `rankMemories` only uses it to
 * break exact ties (shorter first).
 */
export function memoryScore(memory, now = Date.now()) {
  const rated = memoryImportance(memory)
  const level = rated >= 1 ? Math.min(5, rated) : 3
  const pinned = isPinned(memory) ? 1 : 0
  const at = timestamp(memory)
  const ageDays = Math.max(0, (now - at) / DAY_MS)
  const recency = at > 0 ? Math.exp(-ageDays / RECENCY_DECAY_DAYS) : 0
  return pinned * 1e6 + recency * 100 * (1 + 0.5 * ((level - 3) / 2))
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
 * belong to: backend, endpoint (no credentials; the SQLite file of the local
 * backend), user and agent. A change to any of them is another store.
 */
export function memoryScope(config) {
  const backend = String(config?.backend ?? '')
  const endpoint =
    backend === 'oss'
      ? String(config?.storePath ?? config?.native?.storePath ?? '')
      : String(config?.baseUrl ?? '')
          .trim()
          .replace(/\/+$/, '')
          .replace(/\/\/[^/@\s]*@/, '//')
          .toLowerCase()
  return {
    backend,
    endpoint,
    collection: '',
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

/**
 * Exact copies within one partition. Across partitions one rule only: a
 * project or session memory with the same text as a global one is the copy
 * (the global one is recalled in every project); a global memory is never a
 * copy of a project's.
 */
export function dedupeMemories(memories) {
  const ranked = rankMemories(memories)
  const globalKeys = new Set()
  for (const memory of ranked) {
    if (partitionKey(memory) !== 'global') continue
    const key = dedupeKey(memoryText(memory))
    if (key) globalKeys.add(key)
  }
  const seen = new Set()
  const unique = []
  const duplicates = []
  for (const memory of ranked) {
    const key = dedupeKey(memoryText(memory))
    if (!key) continue
    const partition = partitionKey(memory)
    const scoped = `${partition}\u0000${key}`
    if (seen.has(scoped) || (partition !== 'global' && globalKeys.has(key))) {
      duplicates.push(memory)
    } else {
      seen.add(scoped)
      unique.push(memory)
    }
  }
  return { unique, duplicates }
}

/** How long a summary rebuild after a delete or an edit waits for more of them. */
export const REBUILD_DELAY_MS = 45_000
/** A partition whose model summary was unusable this often for the same sources gets the script one until they change. */
export const MAX_SUMMARY_FAILURES = 2

/** Default of `storeSafetyLimit`: above it hygiene warns, it never deletes for size. */
export const DEFAULT_SAFETY_LIMIT = 20_000
/** Deletes per pass (exact duplicates, model deletes and merge sources together). */
export const MAX_DELETES_PER_RUN = 100
/** Model `delete` actions carried out per pass; the rest wait for the next. */
export const MAX_MODEL_DELETES = 20
/** While new or changed memories wait for review, the next pass comes this soon. */
export const CATCH_UP_MS = 86_400_000
/** How long a startup pass waits for DSH's model services to be injected. */
// While a startup pass waits for DSH's model, how often readiness is checked.
export const MODEL_POLL_MS = 250
const MAX_GROUP_FAILURES = 2
const MAX_FAILURE_KEYS = 64
const MAX_DEFERRED = 100
const REST_LIST_LIMIT = 1000

/**
 * Recall weight of a memory's importance: × (1 + weight · (importance − 3) / 2)
 * for a rated memory (1–5; pinned counts as 5), × 1 otherwise. A weight of
 * 0.2 ranges from × 0.8 (importance 1) to × 1.2 (importance 5).
 */
export function recallWeight(memory, weight = 0.2) {
  const w = Number(weight)
  if (!(w > 0)) return 1
  const level = isPinned(memory) ? 5 : memoryImportance(memory)
  if (!(level >= 1)) return 1
  return 1 + w * ((Math.min(5, level) - 3) / 2)
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
  constructor({ client, config, state, logger, activity = {}, localizer, failures, llm, awaitModel = false, rebuildDelayMs = REBUILD_DELAY_MS } = {}) {
    // Optional FailureHistory (lib/failure-history.js).
    this.failures = failures
    // DSH's model services `{ llm, agentDefaultModel }` (ctx.inject), set
    // when they appear; without them hygiene runs the script part only.
    this.llmServices = llm ?? null
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
    // Ids deleted or edited, by invalidation epoch: a pass marks only the
    // summaries built from them stale.
    this.changeLog = []
    // Rebuilds after deletes and edits wait this long, so a run of deletes
    // on the settings page gives one rebuild.
    this.rebuildDelayMs = Number.isFinite(rebuildDelayMs) && rebuildDelayMs >= 0 ? rebuildDelayMs : REBUILD_DELAY_MS
    this.rebuildTimer = null
    // DSH injects its model services after the plugin started (CLI and
    // desktop), and the provider registers a little later still. Until the
    // first hourly check, automatic passes wait for the model instead of
    // degrading, and a manual run is told the model is still starting.
    this.awaitingModel = awaitModel === true
    // The automatic pass waiting for the model (its reason), and its poll.
    this.deferredReason = null
    this.modelTimer = null
  }

  get signal() {
    return this.controller.signal
  }

  /** DSH's `llm` and `agentDefaultModel` services, once injected. */
  setLlmServices({ llm, agentDefaultModel } = {}) {
    this.llmServices = { llm: llm ?? this.llmServices?.llm, agentDefaultModel: agentDefaultModel ?? this.llmServices?.agentDefaultModel }
    this.#checkModel()
  }

  /**
   * Whether the model a review would call is there: the llm service is
   * injected, a background model is selected and its provider registered.
   */
  modelReady() {
    const llm = this.llmServices?.llm
    if (!llm || typeof llm.stream !== 'function') return false
    const selection = defaultModel(this.llmServices?.agentDefaultModel)
    if (!selection) return false
    return providerListed(llm, selection.provider)
  }

  /** Whether passes should still wait for the model rather than degrade. */
  #waitsForModel() {
    if (!this.awaitingModel) return false
    if (!this.modelHygieneEnabled() || this.modelReady()) {
      this.awaitingModel = false
      return false
    }
    return true
  }

  /** Run the deferred pass once the model is ready. */
  #checkModel() {
    if (this.disposed || this.deferredReason === null) return
    if (this.#waitsForModel()) return
    const reason = this.deferredReason
    this.#stopModelWait()
    void this.maybeRun(reason)
  }

  #deferUntilModel(reason) {
    if (this.deferredReason === null) this.logger?.info?.('dsh-mem0: memory hygiene waits for DSH\'s model service to start')
    this.deferredReason = reason
    if (this.modelTimer) return
    this.modelTimer = setInterval(() => this.#checkModel(), MODEL_POLL_MS)
    this.modelTimer.unref?.()
  }

  #stopModelWait() {
    this.deferredReason = null
    if (this.modelTimer) clearInterval(this.modelTimer)
    this.modelTimer = null
  }

  /** Whether model-led hygiene is switched on (default) for this store. */
  modelHygieneEnabled() {
    return this.config.modelHygiene !== false
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
    if (entry) return { profile: entry.profile ?? null, hygiene: entry.hygiene ?? null, profiles: entry.profiles && typeof entry.profiles === 'object' ? entry.profiles : {} }
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
      return { profile, hygiene, profiles: {} }
    }
    return { profile: null, hygiene: null, profiles: {} }
  }

  /**
   * Save this store's entry; other stores' entries are kept (newest 16).
   * `profile` is the global summary, `profiles` the project summaries by
   * partition key (kept as saved when not given).
   */
  #writeEntry({ profile, hygiene, profiles }, saved = this.state?.read() ?? {}) {
    this.#throwIfAborted()
    const now = new Date().toISOString()
    const scopes = { ...(saved.scopes ?? {}) }
    const keptProfiles = profiles ?? scopes[this.scopeKey]?.profiles ?? {}
    scopes[this.scopeKey] = { scope: this.scope, profile: profile ?? null, profiles: keptProfiles, hygiene: hygiene ?? null, updatedAt: now }
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

  /**
   * The summary to inject, redacted; '' when stale or absent. Without a
   * project: the global summary. With `projectId`: the global summary and
   * that project's, under one heading each (either may be missing).
   */
  profileBlock({ projectId, projectName } = {}) {
    if (!this.config.profileEnabled) return ''
    const { profile, profiles } = this.#entry()
    const clean = (value) => (value && value.stale !== true ? stripRecallDelimiters(redactSecrets(usableProfileText(value))).trim() : '')
    const global = clean(profile)
    const project = projectId ? clean(profiles?.[`project:${projectId}`]) : ''
    if (!project) return global
    const name = stripRecallDelimiters(redactSecrets(String(projectName || profiles[`project:${projectId}`]?.name || 'this project'))).replace(/\s+/g, ' ').trim().slice(0, 80)
    return [global ? `# Global\n${global}` : '', `# Project: ${name}\n${project}`].filter(Boolean).join('\n\n')
  }

  /** Project summaries for the settings page: key, name, size, state (no text). */
  #profileList(profiles) {
    return Object.entries(profiles ?? {})
      .filter(([, value]) => value && typeof value === 'object')
      .map(([key, value]) => ({
        key,
        projectId: key.startsWith('project:') ? key.slice('project:'.length) : null,
        name: String(value.name ?? ''),
        tokens: Number(value.tokens ?? 0),
        items: Number(value.items ?? 0),
        updatedAt: value.updatedAt ?? null,
        source: value.source ?? 'generated',
        stale: value.stale === true,
      }))
  }

  isManualProfile() {
    const { profile } = this.#entry()
    return Boolean(profile?.manual === true && usableProfileText(profile).trim())
  }

  /**
   * After the Qdrant migration: earlier versions keyed the local store's
   * summary by oss.json and the Qdrant collection, so this store has none
   * yet. Copy the newest manual summary of the same user and agent kept
   * for that collection (memory ids survive the migration, so its sources
   * stay valid). A generated summary is not copied (it is rebuilt), nor the
   * deletion authorisation. Nothing happens when this store already has a
   * manual summary.
   * @returns {{ adopted: boolean, reason?: string }}
   */
  adoptManualProfile({ collection } = {}) {
    if (!this.state) return { adopted: false, reason: 'no-state' }
    const saved = this.state.read() ?? {}
    const current = this.#entry(saved)
    if (current.profile?.manual === true && usableProfileText(current.profile).trim()) return { adopted: false, reason: 'has-manual' }
    const candidates = Object.entries(saved.scopes ?? {})
      .filter(([key, entry]) =>
        key !== this.scopeKey &&
        entry?.scope?.backend === 'oss' &&
        entry.scope.collection === String(collection ?? '') &&
        entry.scope.userId === this.scope.userId &&
        entry.scope.agentId === this.scope.agentId &&
        entry.profile?.manual === true &&
        usableProfileText(entry.profile).trim(),
      )
      .sort(([, a], [, b]) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    if (candidates.length === 0) return { adopted: false, reason: 'none' }
    const [, entry] = candidates[0]
    this.#writeEntry({ profile: { ...entry.profile, migrated: true }, hygiene: current.hygiene }, saved)
    return { adopted: true }
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

  /** Display names of known projects (the local store records them). */
  async #projectNames() {
    if (typeof this.client?.projects !== 'function') return {}
    try {
      return (await this.client.projects()) ?? {}
    } catch {
      return {}
    }
  }

  /**
   * The partition summaries (L0) after a pass: the global one and one per
   * project with memories (session memories have none). Each is written by
   * the model when allowed and its sources changed (at most
   * MAX_SUMMARY_CALLS per pass), kept when the model wrote it from the same
   * sources, otherwise built by the script. A manual global summary stays
   * (flagged when one of its sources was deleted). With `onlyStale` (a pass
   * that only rebuilds summaries) a saved summary that is not stale is kept
   * as it is. A partition whose model answer was unusable twice for the same
   * sources gets the script summary until they change. An empty global
   * partition is saved as an empty summary (`empty: true`).
   * @returns {Promise<{ global, globalStats, projects, report }>}
   */
  async #buildSummaries(memories, { entry, at, allowModel = false, unavailable = null, deleted = new Set(), ignoreManual = false, onlyStale = false }) {
    const budget = Number(this.config.profileBudgetTokens ?? 1375)
    const groups = new Map([['global', []]])
    for (const memory of memories) {
      if (scopeOf(memory) === 'session') continue
      const key = partitionKey(memory)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(memory)
    }
    const names = groups.size > 1 ? await this.#projectNames() : {}
    const report = { model: 0, script: 0, kept: 0, calls: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, status: 'ok', reason: null }
    const services = this.llmServices
    let modelOn = allowModel && !unavailable && this.modelHygieneEnabled() && Boolean(services?.llm) && typeof services.llm.stream === 'function'
    if (!allowModel || !this.modelHygieneEnabled()) report.status = 'off'
    else if (!modelOn) {
      // No service, or this pass's review found the model unavailable.
      report.status = 'skipped'
      report.reason = unavailable ?? 'NO_SERVICE'
    }
    // Global first, then the projects used most recently.
    const newest = (list) => Math.max(0, ...list.map((memory) => timestamp(memory)))
    const order = [...groups.entries()].sort(([a, left], [b, right]) => (a === 'global' ? -1 : b === 'global' ? 1 : newest(right) - newest(left)))
    let global = null
    let globalStats = { tokens: 0, items: 0 }
    const projects = {}
    for (const [key, list] of order) {
      this.#throwIfAborted()
      const saved = key === 'global' ? entry.profile : entry.profiles?.[key]
      if (key === 'global' && !ignoreManual && saved?.manual === true && usableProfileText(saved).trim()) {
        const sources = Array.isArray(saved.memoryIds) ? saved.memoryIds.map(String) : null
        const touched = deleted.size > 0 && (sources === null || sources.some((id) => deleted.has(id)))
        global = touched ? { ...saved, sourcesChanged: true, sourcesChangedAt: at, sourcesChangedReason: 'hygiene' } : saved
        globalStats = { tokens: Number(saved.tokens ?? estimateTokens(saved.text)), items: Number(saved.items ?? saved.text.split('\n').filter(Boolean).length) }
        continue
      }
      if (list.length === 0) {
        // No global memory (a new user whose memories all went to projects):
        // an empty summary, so the hourly check does not run a pass for it.
        if (key === 'global') global = { userId: this.config.userId, text: '', tokens: 0, items: 0, updatedAt: at, manual: false, source: 'generated', empty: true, memoryIds: [], memoryVersions: {} }
        continue
      }
      const projectId = key.startsWith('project:') ? key.slice('project:'.length) : null
      const name = projectId ? String(names[projectId]?.name || saved?.name || '') : ''
      const ranked = rankMemories(list)
      const input = summaryInput(ranked)
      let next = null
      const hash = sourcesKey(input)
      const failures = saved?.modelFailures?.sources === hash ? Number(saved.modelFailures.count) || 0 : 0
      let failed = failures > 0 ? saved.modelFailures : null
      const keep = (value) => {
        const { stale: _stale, staleAt: _staleAt, ...rest } = value
        return name && rest.name !== name ? { ...rest, name } : rest
      }
      if (saved && saved.source === 'model' && sameSources(saved, input)) {
        // Same sources: nothing to write again. A stale mark (a delete
        // elsewhere touched it, an epoch changed) does not matter then.
        next = keep(saved)
        report.kept += 1
      } else if (onlyStale && saved && saved.stale !== true && !saved.empty) {
        // A rebuild after deletes: only the summaries they touched change.
        next = keep(saved)
        report.kept += 1
      } else if (modelOn && report.calls < MAX_SUMMARY_CALLS && input.records.length > 0 && failures < MAX_SUMMARY_FAILURES) {
        report.calls += 1
        try {
          const written = await writeSummary(services, input.records, {
            label: projectId ? `project "${name || projectId}"` : 'global (applies in every project)',
            maxTokens: budget,
            signal: this.signal,
            onUsage: (usage) => {
              if (usage) report.usage = addUsage(report.usage, usage)
            },
          })
          next = {
            userId: this.config.userId,
            text: written.text,
            tokens: written.tokens,
            items: written.items,
            updatedAt: at,
            manual: false,
            source: 'model',
            memoryIds: input.memoryIds,
            memoryVersions: input.memoryVersions,
          }
          report.model += 1
        } catch (error) {
          this.#throwIfAborted()
          const code = typeof error?.code === 'string' ? error.code : 'LLM_FAILED'
          if (code === 'BAD_SUMMARY') failed = { sources: hash, count: failures + 1 }
          if (code !== 'BAD_SUMMARY') {
            // Unavailable: no more summary calls this pass.
            modelOn = false
            report.status = 'degraded'
            report.reason = UNAVAILABLE_CODES.includes(code) ? code : code.slice(0, 40)
          } else if (!report.reason) report.reason = code
          this.logger?.debug?.(`dsh-mem0: the model could not write the ${projectId ? 'project' : 'global'} summary (${code}); the script summary is used`)
        }
      }
      if (!next) {
        next = this.#generatedProfile(buildProfile(ranked, budget), at)
        if (next) report.script += 1
        // Unusable model answers for these sources, so the next passes do
        // not pay for them again.
        if (next && failed) next.modelFailures = failed
      }
      if (!next) continue
      if (projectId) {
        projects[key] = { ...next, projectId, name }
      } else {
        global = next
        globalStats = { tokens: next.tokens, items: next.items }
      }
    }
    return { global, globalStats, projects, report }
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
    // The script summaries of every partition, the manual global one
    // discarded; the next hygiene pass lets the model rewrite them.
    const built = await this.#buildSummaries(dedupeMemories(all).unique, { entry: this.#entry(), at: new Date().toISOString(), ignoreManual: true })
    const saved = this.state?.read() ?? {}
    const entry = this.#entry(saved)
    const profile = built.global
    let profiles = this.partitionsEnabled() ? built.projects : entry.profiles
    if (epoch !== this.invalidations) {
      if (profile) profile.stale = true
      profiles = Object.fromEntries(Object.entries(profiles).map(([key, value]) => [key, { ...value, stale: true }]))
      this.rebuildPending = true
    }
    if (!this.#writeEntry({ profile, hygiene: entry.hygiene, profiles }, saved)) {
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
    this.changeLog.push({ epoch: this.invalidations, ids: changed })
    if (this.changeLog.length > 200) this.changeLog.shift()
    const saved = this.state?.read() ?? {}
    const entry = this.#entry(saved)
    const now = new Date().toISOString()
    const touches = (value) => {
      const sources = Array.isArray(value?.memoryIds) ? value.memoryIds.map(String) : null
      return sources === null || sources.some((id) => changed.has(id))
    }
    const profile = entry.profile
    const globalAffected = Boolean(profile) && touches(profile)
    // Project summaries are always generated: stale when a source changed.
    const profiles = { ...(entry.profiles ?? {}) }
    let projectAffected = false
    // A summary already stale and waiting for its rebuild: this delete
    // restarts the wait, so a run of deletes gives one rebuild.
    let waiting = profile?.stale === true && touches(profile)
    for (const [key, value] of Object.entries(profiles)) {
      if (!value || !touches(value)) continue
      if (value.stale === true) {
        waiting = true
        continue
      }
      profiles[key] = { ...value, stale: true, staleAt: now }
      projectAffected = true
    }
    if (!globalAffected && !projectAffected) {
      if (waiting && this.rebuildTimer) {
        this.rebuildPending = true
        this.#scheduleRebuild()
      }
      return false
    }
    const next = !globalAffected
      ? profile
      : profile.manual === true
        ? { ...profile, sourcesChanged: true, sourcesChangedAt: now, sourcesChangedReason: reason }
        : { ...profile, stale: true, staleAt: now }
    try {
      this.#writeEntry({ profile: next, hygiene: entry.hygiene, profiles }, saved)
    } catch (error) {
      this.logger?.debug?.(`dsh-mem0: could not mark the memory summary stale: ${error.message}`)
      return false
    }
    if (projectAffected || (globalAffected && profile.manual !== true)) {
      this.rebuildPending = true
      this.#scheduleRebuild()
    }
    return true
  }

  #scheduleRebuild() {
    if (!this.rebuildPending || this.disposed || this.running) return
    this.rebuildPending = false
    // One rebuild for a run of deletes: each new one restarts the wait.
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer)
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null
      void this.maybeRun('summary')
    }, this.rebuildDelayMs)
    this.rebuildTimer.unref?.()
  }

  /** Ids deleted or edited after invalidation epoch `since`. */
  #changedSince(since) {
    const out = new Set()
    for (const entry of this.changeLog) if (entry.epoch > since) for (const id of entry.ids) out.add(id)
    return out
  }

  status(now = new Date()) {
    const { profile, hygiene: savedHygiene, profiles } = this.#entry()
    const hygiene = savedHygiene ?? {}
    const lastRunAt = hygiene.lastRunAt ?? null
    const last = this.#lastPassAt(hygiene)
    const interval = Number(this.config.hygieneIntervalDays ?? 7)
    const next = Number.isFinite(last) ? last + this.#intervalMs(hygiene) : null
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
      // New or changed memories not reviewed yet (beyond one pass's 96);
      // while there are some and the model works, passes come daily.
      pending: Number.isInteger(hygiene.pending) ? hygiene.pending : 0,
      catchUp: hygiene.catchUp === true && this.config.hygieneEnabled === true,
      // An automatic pass waiting for DSH's model service to start.
      waitingForModel: this.deferredReason !== null,
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
      // Summaries of projects (partition L0), without their text.
      projectProfiles: this.#profileList(profiles),
    }
  }

  #lastPassAt(hygiene) {
    // The later of the last real pass and the last automatic preview.
    const times = [hygiene?.lastRunAt, hygiene?.previewAt].map((value) => Date.parse(value ?? '')).filter(Number.isFinite)
    return times.length > 0 ? Math.max(...times) : NaN
  }

  /** The configured interval, or a day while a catch-up is on. */
  #intervalMs(hygiene) {
    const days = Number(this.config.hygieneIntervalDays ?? 7) * DAY_MS
    return hygiene?.catchUp === true ? Math.min(days, CATCH_UP_MS) : days
  }

  isDue(now = new Date()) {
    if (!this.config.hygieneEnabled) return false
    const hygiene = this.#entry().hygiene ?? {}
    const last = this.#lastPassAt(hygiene)
    if (!Number.isFinite(last)) return true
    return now.getTime() >= last + this.#intervalMs(hygiene)
  }

  needsProfileRebuild() {
    const { profile, profiles } = this.#entry()
    if (!this.config.profileEnabled) return false
    if (this.partitionsEnabled() && Object.values(profiles ?? {}).some((value) => value?.stale === true)) return true
    if (!profile) return false
    if (profile.manual === true) return false
    if (profile.stale === true) return true
    const text = String(profile.text ?? '').trim()
    return Boolean(text) && !/^##\s+/m.test(text)
  }

  async maybeRun(reason = 'schedule') {
    if (this.disposed || this.running) return null
    if (reason === 'schedule') {
      // The first hourly check ends the startup wait: a model still missing
      // now is unavailable, and the pass degrades to the script part.
      this.awaitingModel = false
      this.#stopModelWait()
    }
    // A summary was never built for this store. An empty global partition
    // is saved as an empty summary, so it does not count (it would bring a
    // pass every hour).
    const needsProfile = Boolean(this.config.profileEnabled) && !this.#entry().profile
    const needsStructure = this.needsProfileRebuild()
    if (!this.isDue() && !needsProfile && !needsStructure) return null
    if (this.isDue() && this.#waitsForModel()) {
      // DSH has not started its model yet: run once it has, so a new
      // install's first report does not say the model was unavailable.
      this.#deferUntilModel(reason)
      return null
    }
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
    if (this.running) {
      // A manual run must not get another pass's result: that pass may be
      // a real one (no plan to confirm, deletes already done).
      if (reason === 'manual' && !options.plan) {
        return Promise.reject(maintenanceError('a memory hygiene pass is already running; try again when it has finished', 'busy'))
      }
      return this.running
    }
    if (reason === 'manual' && !options.plan && !options.profileOnly && this.#waitsForModel()) {
      // Not a failure and no degraded report: the model is starting.
      return Promise.reject(maintenanceError("DSH's model service is still starting; try again shortly", 'model-starting'))
    }
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

  /** How many memories one listing returns: the local store up to just above the safety limit, REST backends one page. */
  #listLimit() {
    return this.config.backend === 'oss' ? this.#safetyLimit() + 1 : REST_LIST_LIMIT
  }

  async #listAll() {
    // The local store lists everything up to just above the safety limit
    // (so the warning can fire); REST backends return one page of 1000, so
    // the warning cannot fire there and the report says the scan stopped.
    const limit = this.#listLimit()
    const result = await this.client.list(
      { user_id: this.config.userId },
      // timeoutMs (the per-request setting) applies, as for every request.
      { topK: limit, signal: this.signal },
    )
    this.#throwIfAborted()
    const all = Array.isArray(result?.results) ? result.results : []
    // With partitions off, hygiene and summaries see only global memories:
    // project and session ones are left exactly as they are.
    return this.partitionsEnabled() ? all : all.filter((memory) => partitionKey(memory) === 'global')
  }

  /** The "partition by project" switch (on unless set to false). */
  partitionsEnabled() {
    return this.config.projectPartitions !== false
  }

  #safetyLimit() {
    const limit = Number(this.config.storeSafetyLimit)
    return Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_SAFETY_LIMIT
  }

  /** Ids of memories similar to `memory` (its own vector when the store has one). */
  async #neighborsOf(memory) {
    const filters = { user_id: this.config.userId }
    if (typeof this.client.neighbors === 'function') {
      // Only within the memory's own partition: a project fact is never
      // merged into, or retired by, a global one (or another project's).
      const near = await this.client.neighbors(memoryId(memory), filters, { limit: 6, threshold: NEIGHBOR_THRESHOLD, samePartition: true })
      return near.map((item) => String(item.id))
    }
    const text = memoryText(memory)
    if (!text) return []
    const result = await this.client.search(text.slice(0, 2_000), filters, { topK: 7, threshold: NEIGHBOR_THRESHOLD, signal: this.signal })
    return (result?.results ?? []).map((item) => memoryId(item)).filter((id) => id && id !== memoryId(memory))
  }

  /**
   * The model part of a pass: review the new or changed memories, then the
   * backlog, call by call. Never throws for the model (it degrades to the
   * script part); only a dispose aborts.
   * @param {object[]} memories live memories (exact duplicates removed)
   * @param {{ watermark, baseline, backlog, failures }} cursor review progress of this mode
   */
  async #review(memories, cursor, reason) {
    const review = {
      status: 'ok',
      reason: null,
      calls: 0,
      groups: 0,
      reviewed: 0,
      changed: 0,
      backlog: 0,
      badAnswers: 0,
      skippedGroups: 0,
      suspicious: 0,
      retries: 0,
      unmetered: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      actions: [],
      rejected: {},
      advanceTo: null,
      backlogAdvanceTo: null,
      failures: { ...(cursor.failures ?? {}) },
      complete: false,
    }
    if (!this.modelHygieneEnabled()) return { ...review, status: 'off' }
    const services = this.llmServices
    if (!services?.llm || typeof services.llm.stream !== 'function') return { ...review, status: 'skipped', reason: 'NO_SERVICE' }
    const plan = await planReview({
      memories,
      watermark: cursor.watermark,
      baseline: cursor.baseline,
      backlog: cursor.backlog,
      neighborsOf: (memory) => this.#neighborsOf(memory),
      signal: this.signal,
    })
    this.#throwIfAborted()
    review.changed = plan.fresh.total
    review.backlog = plan.backlog.total
    review.groups = plan.groups.length
    const answered = new Set()
    const failed = { fresh: false, backlog: false }
    for (const group of plan.groups) {
      this.#throwIfAborted()
      const key = groupKey(group)
      if ((review.failures[key] ?? 0) >= MAX_GROUP_FAILURES) {
        // Failed twice with the same members: skipped, the watermark moves
        // past it (asked again only once one of them changes).
        review.skippedGroups += 1
        for (const memory of group) answered.add(String(memory.id))
        continue
      }
      try {
        const outcome = await reviewGroup(services, group, {
          signal: this.signal,
          // Every model call counts, a retry too.
          onAttempt: (attempt) => {
            review.calls += 1
            if (attempt > 1) review.retries += 1
          },
          onUsage: (usage) => {
            if (usage) review.usage = addUsage(review.usage, usage)
            else review.unmetered += 1
          },
        })
        delete review.failures[key]
        review.reviewed += group.length
        for (const memory of group) answered.add(String(memory.id))
        if (outcome.suspicious) review.suspicious += 1
        review.actions.push(...outcome.accepted)
        for (const item of outcome.rejected) review.rejected[item.reason] = (review.rejected[item.reason] ?? 0) + 1
      } catch (error) {
        this.#throwIfAborted()
        const code = typeof error?.code === 'string' ? error.code : 'LLM_FAILED'
        failed[group.lane] = true
        if (code === 'BAD_JSON' || code === 'MAX_TOKENS') {
          // One bad answer skips its call; the next call is still made.
          review.badAnswers += 1
          review.failures[key] = (review.failures[key] ?? 0) + 1
          continue
        }
        // The model is unavailable: stop calling it. Calls answered so far
        // keep their actions (they were paid for); the rest waits.
        review.status = 'degraded'
        review.reason = UNAVAILABLE_CODES.includes(code) ? code : code.slice(0, 40)
        failed.fresh = true
        failed.backlog = true
        break
      }
    }
    if (review.status === 'ok' && plan.groups.length > 0 && review.badAnswers === plan.groups.length - review.skippedGroups && review.badAnswers > 0) {
      review.status = 'degraded'
      review.reason = 'BAD_JSON'
    }
    const advance = (lane) => {
      if (!failed[lane.name]) return lane.info.advanceTo
      // Up to the first memory of a call that was not answered.
      let to = null
      for (const item of lane.info.sequence) {
        if (!answered.has(item.id)) break
        to = item.key
      }
      return to
    }
    review.advanceTo = advance({ name: 'fresh', info: plan.fresh })
    review.backlogAdvanceTo = advance({ name: 'backlog', info: plan.backlog })
    review.complete = !failed.fresh && !failed.backlog && plan.fresh.complete && plan.backlog.complete
    // Bounded failure cache (keys only: ids and versions hashed, no text).
    const keys = Object.keys(review.failures)
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_FAILURE_KEYS))) delete review.failures[stale]
    if (review.status === 'degraded') {
      review.partial = review.actions.length > 0
      this.logger?.info?.(`dsh-mem0: model hygiene unavailable (${review.reason}); ${review.partial ? 'calls answered before that are used, the rest' : 'this pass'} ran the script checks only`)
    }
    return review
  }

  async #applyImportance(items) {
    const applied = []
    if (typeof this.client.setAttributes !== 'function') return applied
    for (const { id, level } of items) {
      if (this.signal.aborted) break
      try {
        await this.client.setAttributes(id, { importance: level })
        applied.push(id)
      } catch (error) {
        this.logger?.debug?.(`dsh-mem0: could not store the importance of ${id}: ${error.message}`)
      }
    }
    return applied
  }

  /**
   * One maintenance pass. Only memories tagged `metadata.source === 'dsh'`
   * and not pinned are eligible for deletion or merging; others (written by
   * other Mem0 apps under the same user_id) feed the review and the summary
   * but are never removed.
   *
   * The script removes exact duplicates (full-text hash); facts that only
   * look alike are reported as suspected. The model review (unless off or
   * unavailable) may merge, delete and rate memories of each group; its
   * actions are validated in lib/memory-review.js. At most 100 memories go
   * per pass. Above `storeSafetyLimit` the report warns; nothing is deleted
   * for size.
   *
   * `dryRun` computes the same plan without deleting or merging. A manual
   * dry run (the settings page preview) leaves the state file untouched
   * and returns a `planId` that `runPlan` executes; an automatic one
   * records the preview report and `previewAt` (and stores importance,
   * which deletes nothing). `plan` restricts the run to that preview.
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
      const safetyLimit = this.#safetyLimit()
      const overLimit = all.length > safetyLimit
      if (overLimit && hygieneEnabled) {
        this.logger?.warn?.(`dsh-mem0: ${all.length} memories are stored, above the safety limit of ${safetyLimit}; nothing is deleted for size, review them in the settings page`)
      }
      const duplicates = []
      const suspected = []
      if (hygieneEnabled) {
        // Foreign copies always win: an own duplicate of a foreign memory is
        // removable, a foreign duplicate is never touched. Pinned memories
        // are never removed (ranking puts them first among their copies).
        // Copies are looked for within one partition: the same fact in two
        // projects is two memories. Across partitions only a project or
        // session copy of a global memory goes; a global memory never goes
        // because a project holds the same text.
        const scoped = (memory, key) => `${partitionKey(memory)}\u0000${key}`
        const globalKeys = new Set()
        for (const memory of [...foreign, ...own]) {
          if (partitionKey(memory) !== 'global') continue
          const key = dedupeKey(memoryText(memory))
          if (key) globalKeys.add(key)
        }
        const seen = new Set(foreign.map((memory) => scoped(memory, dedupeKey(memoryText(memory)))))
        const similar = new Set(foreign.map((memory) => scoped(memory, similarityKey(memoryText(memory)))))
        for (const memory of own) {
          const text = memoryText(memory)
          const key = dedupeKey(text)
          if (!key) continue
          const copyOfGlobal = partitionKey(memory) !== 'global' && globalKeys.has(key)
          if ((seen.has(scoped(memory, key)) || copyOfGlobal) && !isPinned(memory)) {
            duplicates.push(memory)
            continue
          }
          const loose = similarityKey(text)
          if (loose && similar.has(scoped(memory, loose))) suspected.push(memory)
          seen.add(scoped(memory, key))
          if (loose) similar.add(scoped(memory, loose))
        }
      }
      const duplicateSet = new Set(duplicates)
      const byId = new Map(all.map((memory) => [memoryId(memory), memory]))
      const entryBefore = this.#entry()
      const hygieneBefore = entryBefore.hygiene ?? {}
      // Review progress: real passes and manual previews (which become real
      // on confirmation) share one cursor; automatic previews keep their own,
      // so the weekly preview does not pay for the same memories again.
      const previewMode = Boolean(dryRun) && reason !== 'manual' && !plan
      const lanes = previewMode ? hygieneBefore.preview ?? {} : hygieneBefore
      // The first review sets the baseline: what was stored before it is the
      // backlog, reviewed with what each pass has left over.
      const baseline = hygieneBefore.reviewBaseline ?? { version: startedAt, id: '' }
      const cursor = {
        watermark: lanes.reviewWatermark ?? null,
        baseline,
        backlog: lanes.backlogWatermark ?? null,
        failures: lanes.groupFailures ?? {},
      }
      // The model review, or a confirmed preview's own actions.
      let review = null
      let merges = []
      let modelDeletes = []
      let importance = []
      if (plan) {
        merges = plan.merges ?? []
        importance = plan.importance ?? []
        review = plan.review ?? null
      } else if (hygieneEnabled) {
        const live = ranked.filter((memory) => !duplicateSet.has(memory) && memoryText(memory))
        review = await this.#review(live, cursor, reason)
        for (const action of review.actions) {
          // One call may carry memories of several partitions (singles are
          // packed together): a merge or a `delete … by` across partitions
          // is dropped, like any other invalid action.
          const keys = new Set([...action.ids, ...(action.type === 'delete' && action.by ? [action.by] : [])].map((id) => partitionKey(byId.get(id))))
          if ((action.type === 'merge' || action.type === 'delete') && keys.size > 1) {
            review.rejected['cross-scope'] = (review.rejected['cross-scope'] ?? 0) + 1
            continue
          }
          if (action.type === 'merge') {
            const sources = action.ids.map((id) => byId.get(id))
            const first = sources[0] ?? {}
            merges.push({
              text: action.text,
              note: action.reason,
              // The merged memory stays in its sources' partition.
              partition: { scope: scopeOf(first), projectId: first.project_id ?? null, sessionId: first.session_id ?? null },
              sources: action.ids.map((id) => ({ id, version: memoryVersion(byId.get(id)) })),
              level: Math.max(0, action.level ?? 0, ...action.ids.map((id) => memoryImportance(byId.get(id)))) || null,
              // The merged memory states facts as old as its newest source.
              factDate: new Date(Math.max(0, ...sources.map((memory) => timeOf(memory))) || Date.parse(startedAt)).toISOString(),
            })
          } else if (action.type === 'delete') {
            for (const id of action.ids) modelDeletes.push({ memory: byId.get(id), note: action.reason, by: action.by ?? null })
          } else if (action.type === 'importance') {
            for (const id of action.ids) {
              if (memoryImportance(byId.get(id)) !== action.level) importance.push({ id, version: memoryVersion(byId.get(id)), level: action.level })
            }
          }
        }
      }
      // Deletion candidates in order: exact duplicates, then model deletes,
      // then merges (all their sources or none), within the per-pass cap.
      const notes = new Map()
      const reasons = new Map()
      let planned = []
      const skippedDetails = []
      let keptMerges = []
      let deferred = plan ? plan.deferred ?? [] : []
      if (plan) {
        // A confirmed preview deletes only its own ids that are still here,
        // still this plugin's, still unpinned and unchanged.
        const present = new Map(own.map((memory) => [memoryId(memory), memory]))
        const usable = (id, version) => {
          const memory = present.get(id)
          if (!memory) return 'missing'
          if (memoryVersion(memory) !== version) return 'changed'
          if (isPinned(memory)) return 'pinned'
          return null
        }
        for (const [id, item] of plan.items) {
          const problem = usable(id, item.version)
          if (problem) skippedDetails.push({ id, reason: problem })
          else {
            planned.push(present.get(id))
            reasons.set(id, item.reason)
            if (item.note) notes.set(id, item.note)
          }
        }
        for (const merge of merges) {
          const problems = merge.sources.map((source) => usable(source.id, source.version))
          if (problems.some(Boolean)) {
            merge.sources.forEach((source, index) => skippedDetails.push({ id: source.id, reason: problems[index] ?? 'merge-incomplete' }))
            continue
          }
          keptMerges.push(merge)
        }
        importance = importance.filter((item) => present.has(item.id) && memoryVersion(present.get(item.id)) === item.version)
      } else if (hygieneEnabled) {
        const taken = new Set()
        const take = (memory, why, note) => {
          const id = memoryId(memory)
          if (!memory || taken.has(id) || planned.length >= MAX_DELETES_PER_RUN) return false
          taken.add(id)
          planned.push(memory)
          reasons.set(id, why)
          if (note) notes.set(id, note)
          return true
        }
        for (const memory of duplicates) take(memory, 'duplicate')
        // Sources of an earlier merge whose merged memory exists but whose
        // sources stayed (the merged write was queued, or a delete failed):
        // removed now if unchanged since the merge.
        for (const memory of own) {
          const from = memory?.metadata?.merged_from
          const at = Date.parse(memory?.metadata?.merged_at ?? '')
          // Only merges this plugin wrote (tools cannot set these keys).
          if (memory?.metadata?.channel !== 'dsh-hygiene' || !Array.isArray(from) || !Number.isFinite(at)) continue
          for (const id of from.map(String)) {
            const source = byId.get(id)
            if (!source || source === memory || !isOwnMemory(source) || isPinned(source) || timestamp(source) > at) continue
            take(source, 'merged', null)
          }
        }
        // Model deletes: carried over from the last pass first, then this
        // review's, at most MAX_MODEL_DELETES; the rest wait (by id and
        // version, re-checked then).
        let modelTaken = 0
        const later = []
        const carried = previewMode ? [] : (Array.isArray(hygieneBefore.deferredDeletes) ? hygieneBefore.deferredDeletes : [])
        const queue = [
          ...carried
            .map((item) => ({ memory: byId.get(String(item.id)), version: item.version, by: item.by ?? null, note: null }))
            .filter((item) => item.memory && memoryVersion(item.memory) === item.version && isOwnMemory(item.memory) && !isPinned(item.memory) && (!item.by || byId.has(String(item.by)))),
          ...modelDeletes,
        ]
        for (const item of queue) {
          if (!item.memory || taken.has(memoryId(item.memory))) continue
          if (modelTaken >= MAX_MODEL_DELETES) {
            later.push({ id: memoryId(item.memory), version: memoryVersion(item.memory), ...(item.by ? { by: String(item.by) } : {}) })
            continue
          }
          if (take(item.memory, 'model', item.note)) modelTaken += 1
        }
        deferred = later.slice(0, MAX_DEFERRED)
        for (const merge of merges) {
          const sources = merge.sources.map((source) => byId.get(source.id))
          if (sources.some((memory) => !memory || taken.has(memoryId(memory))) || planned.length + sources.length > MAX_DELETES_PER_RUN) continue
          for (const memory of sources) take(memory, 'merged', merge.note)
          keptMerges.push(merge)
        }
      }
      if (!plan && !dryRun && hygieneEnabled && (review?.calls ?? 0) > 0 && planned.length + keptMerges.length + importance.length > 0) {
        // The model calls took time (minutes, at worst): the user may have
        // pinned or edited a candidate meanwhile. List again and act only on
        // memories still here, still this plugin's, unpinned and unchanged;
        // a merge goes only with all its sources.
        const current = await this.#listAll()
        const present = new Map(current.filter(isOwnMemory).map((memory) => [memoryId(memory), memory]))
        const problemOf = (id, version) => {
          const now = present.get(id)
          if (!now) return 'missing'
          if (memoryVersion(now) !== version) return 'changed'
          if (isPinned(now)) return 'pinned'
          return null
        }
        const dropped = new Set()
        keptMerges = keptMerges.filter((merge) => {
          const problems = merge.sources.map((source) => problemOf(source.id, source.version))
          if (!problems.some(Boolean)) return true
          merge.sources.forEach((source, index) => {
            dropped.add(source.id)
            skippedDetails.push({ id: source.id, reason: problems[index] ?? 'merge-incomplete' })
          })
          return false
        })
        planned = planned.filter((memory) => {
          const id = memoryId(memory)
          if (dropped.has(id)) return false
          const problem = problemOf(id, memoryVersion(memory))
          if (problem) skippedDetails.push({ id, reason: problem })
          return !problem
        })
        importance = importance.filter((item) => !problemOf(item.id, item.version))
      }
      const reasonOf = (memory) => reasons.get(memoryId(memory)) ?? (duplicateSet.has(memory) ? 'duplicate' : 'model')
      // A short, redacted preview (and the model's reason) is only returned
      // live from a manual dry run (the settings page confirmation);
      // stripReportText removes both before anything is stored.
      const previewOf = (memory) => ({
        id: memoryId(memory),
        reason: reasonOf(memory),
        preview: redactSecrets(memoryText(memory)).slice(0, REPORT_PREVIEW_CHARS),
        ...(notes.get(memoryId(memory)) ? { note: notes.get(memoryId(memory)) } : {}),
      })
      const mergeSourceIds = new Set(keptMerges.flatMap((merge) => merge.sources.map((source) => source.id)))
      const duplicateDetails = duplicates.slice(0, 20).map(previewOf)
      const suspectedDetails = suspected.slice(0, 20).map((memory) => ({ ...previewOf(memory), reason: 'similar' }))
      const plannedById = new Map(planned.map((memory) => [memoryId(memory), previewOf(memory)]))
      const deleted = []
      const failedDetails = []
      const deletedTexts = []
      const mergedDetails = []
      // The merged memories as stored, for this pass's summaries.
      const mergedMemories = []
      let mergesPending = 0
      const removeOne = async (memory) => {
        const id = memoryId(memory)
        try {
          await this.client.remove(id, { signal: this.signal })
          deleted.push(id)
          deletedTexts.push(String(memory?.memory ?? memory?.text ?? ''))
          return true
        } catch (error) {
          if (this.signal.aborted) return false
          failedDetails.push({ id, error: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200) })
          this.logger?.debug?.(`dsh-mem0: could not remove ${id}: ${error.message}`)
          return false
        }
      }
      let importanceApplied = []
      if (!dryRun) {
        // Merges first: the merged memory is written before its sources go.
        for (const merge of keptMerges) {
          if (this.signal.aborted) break
          const ids = merge.sources.map((source) => source.id)
          let added
          try {
            const partition = merge.partition ?? { scope: 'global' }
            const result = await this.client.add([{ role: 'user', content: merge.text }], {
              infer: false,
              userId: this.config.userId,
              agentId: this.config.agentId,
              scope: partition.scope,
              ...(partition.projectId ? { projectId: partition.projectId } : {}),
              ...(partition.sessionId ? { sessionId: partition.sessionId } : {}),
              metadata: {
                source: 'dsh',
                channel: 'dsh-hygiene',
                merged_from: ids,
                merged_at: new Date().toISOString(),
                ...(merge.factDate ? { fact_date: merge.factDate } : {}),
              },
              signal: this.signal,
            })
            added = result?.queued ? null : memoryId(result?.results?.[0]) || null
            // The sources go only once the merged memory is really stored.
            if (added && typeof this.client.get === 'function') {
              const stored = await this.client.get(added, { signal: this.signal }).catch(() => null)
              if (!stored) added = null
              else mergedMemories.push(stored)
            }
          } catch (error) {
            if (this.signal.aborted) break
            ids.forEach((id) => failedDetails.push({ id, error: `merge: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 180)}` }))
            continue
          }
          if (!added) {
            // Queued (Platform) or not found yet: keep the sources. Once the
            // merged memory shows up, a later pass removes them (merged_from).
            mergesPending += 1
            mergedDetails.push({ id: null, ids, pending: true, preview: redactSecrets(merge.text).slice(0, REPORT_PREVIEW_CHARS), note: merge.note })
            continue
          }
          if (added && merge.level && typeof this.client.setAttributes === 'function') {
            await this.client.setAttributes(added, { importance: merge.level }).catch(() => {})
          }
          for (const id of ids) {
            if (this.signal.aborted) break
            await removeOne(byId.get(id) ?? { id })
          }
          mergedDetails.push({ id: added, ids, preview: redactSecrets(merge.text).slice(0, REPORT_PREVIEW_CHARS), note: merge.note })
        }
        for (const memory of planned) {
          const id = memoryId(memory)
          // Stop between deletes once the plugin is disposed or reloaded.
          if (!id || mergeSourceIds.has(id)) continue
          if (this.signal.aborted) break
          await removeOne(memory)
        }
      }
      // Ratings delete nothing: stored by every pass except a manual
      // preview (which must not change anything until it is confirmed).
      if (!(dryRun && reason === 'manual') && importance.length > 0) {
        importanceApplied = await this.#applyImportance(importance)
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
      const finishedAtPending = new Date().toISOString()
      const appliedLevels = new Map(importance.filter((item) => importanceApplied.includes(item.id)).map((item) => [item.id, item.level]))
      let summaries = null
      if (this.config.profileEnabled) {
        // Built from what is still stored, never from the plan: a preview
        // must not drop facts that are still in the store. New ratings
        // count at once; merged memories join on the next pass.
        // Merged memories written by this pass join their partition's summary.
        const rated = [...remaining, ...mergedMemories].map((memory) => (appliedLevels.has(memoryId(memory)) ? { ...memory, importance: appliedLevels.get(memoryId(memory)) } : memory))
        summaries = await this.#buildSummaries(dedupeMemories(rated).unique, {
          entry: this.#entry(),
          at: finishedAtPending,
          // A manual preview changes nothing (it stores no summary either);
          // a pass whose review found the model unavailable does not call it again.
          // A pass that only rebuilds summaries (after deletes, or the
          // hourly check) never calls the model: model summaries come with
          // the due passes only.
          allowModel: !(dryRun && reason === 'manual') && !profileOnly,
          onlyStale: profileOnly,
          unavailable: review?.status === 'degraded' ? review.reason ?? 'LLM_FAILED' : null,
          deleted: new Set(deleted),
        })
        this.#throwIfAborted()
      }
      const savedState = this.state?.read() ?? {}
      const entry = this.#entry(savedState)
      const finishedAt = new Date().toISOString()
      let nextProfile = summaries ? summaries.global : null
      // With partitions off the saved project summaries are kept unchanged.
      let nextProfiles = summaries && this.partitionsEnabled() ? summaries.projects : entry.profiles
      const profileStats = summaries ? summaries.globalStats : { tokens: 0, items: 0 }
      if (summaries && epoch !== this.invalidations) {
        // A memory was deleted or edited while this pass ran: the summaries
        // built from it are rebuilt once more before they are injected.
        // The others stay as they are.
        const changed = this.#changedSince(epoch)
        const touched = (value) => {
          if (!value || value.manual === true || value.empty === true) return false
          const sources = Array.isArray(value.memoryIds) ? value.memoryIds.map(String) : null
          return sources === null || sources.some((id) => changed.has(id))
        }
        const mark = (value) => (touched(value) ? { ...value, stale: true, staleAt: finishedAtPending } : value)
        const before = JSON.stringify([nextProfile, nextProfiles])
        nextProfile = mark(nextProfile)
        nextProfiles = Object.fromEntries(Object.entries(nextProfiles ?? {}).map(([key, value]) => [key, mark(value)]))
        if (JSON.stringify([nextProfile, nextProfiles]) !== before) this.rebuildPending = true
      }
      const costOf = (memories) => memories.reduce((total, memory) => total + estimateTokens(memoryText(memory)) + 8, 0)
      const storeTokensBefore = costOf(all)
      // Where this mode's review stands after the pass, and how many new or
      // changed memories still wait (the backlog does not count: it never
      // brings the next pass forward).
      const nextCursor = {
        watermark: (plan ? plan.advanceTo : review?.advanceTo) ?? cursor.watermark,
        backlog: (plan ? plan.backlogAdvanceTo : review?.backlogAdvanceTo) ?? cursor.backlog,
        failures: plan ? plan.failures ?? cursor.failures : review?.failures ?? cursor.failures,
      }
      const reviewUsed = Boolean(review) && (review.status === 'ok' || review.status === 'degraded')
      const pending = reviewUsed ? pendingFresh(remaining.filter((memory) => !duplicateSet.has(memory)), nextCursor.watermark, baseline) : 0
      // Catch up daily only while the model works; a degraded pass keeps
      // the normal interval (it catches up once the model answers again).
      const catchUp = reviewUsed && review.status === 'ok' && pending > 0
      const importanceSupported = typeof this.client.setAttributes === 'function'
      const model = review
        ? {
            status: review.status,
            reason: review.reason,
            calls: review.calls,
            groups: review.groups,
            reviewed: review.reviewed,
            changed: review.changed,
            backlog: review.backlog ?? 0,
            pending,
            badAnswers: review.badAnswers,
            skippedGroups: review.skippedGroups ?? 0,
            suspicious: review.suspicious ?? 0,
            retries: review.retries,
            unmetered: review.unmetered ?? 0,
            ...(review.partial ? { partial: true } : {}),
            usage: review.usage,
            merges: keptMerges.length,
            deletes: planned.filter((memory) => reasonOf(memory) === 'model').length,
            importance: importanceSupported ? importance.length : 0,
            importanceStored: importanceApplied.length,
            deferred: deferred.length,
            rejected: review.rejected,
            complete: review.complete,
            ...(plan ? { fromPreview: true } : {}),
          }
        : { status: hygieneEnabled ? 'off' : 'disabled', reason: null, calls: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
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
        merged: dryRun ? keptMerges.length : mergedDetails.filter((item) => item.id).length,
        mergesPending,
        deleted: deleted.length,
        failed: failedDetails.length,
        skipped: skippedDetails.length,
        // In a dry run: how many a confirmed run would delete (max 100/run).
        planned: hygieneEnabled || plan ? planned.length : 0,
        plannedDetails: dryRun ? planned.slice(0, 20).map(previewOf) : [],
        mergePlan: dryRun ? keptMerges.slice(0, 20).map((merge) => ({ ids: merge.sources.map((source) => source.id), preview: redactSecrets(merge.text).slice(0, REPORT_PREVIEW_CHARS * 2), note: merge.note })) : [],
        own: own.length,
        foreign: foreign.length,
        safetyLimit,
        overLimit,
        // REST backends list one page: the scan (and the limit check) stops there.
        ...(this.config.backend !== 'oss' && all.length >= REST_LIST_LIMIT ? { scanLimited: true, scanLimit: REST_LIST_LIMIT } : {}),
        pending,
        catchUp,
        model,
        // After a real run: what is left. In a dry run: what would be left.
        storeCount: projected.length + (dryRun ? 0 : mergedDetails.filter((item) => item.id).length),
        storeTokens: costOf(projected),
        profileItems: profileStats.items,
        profileTokens: profileStats.tokens,
        // Partition summaries: how many were written by the model, by the
        // script, kept unchanged; the model calls and tokens they used.
        ...(summaries ? { summaries: summaries.report } : {}),
        duplicateDetails,
        suspectedDetails,
        deletedDetails: deleted.map((id) => plannedById.get(id) ?? { id, reason: 'merged' }),
        mergedDetails,
        // Ratings only where the backend stores them.
        reviewDetails: importanceSupported ? importance.slice(0, 40).map((item) => ({ id: item.id, reason: 'importance', level: item.level })) : [],
        failedDetails,
        skippedDetails: skippedDetails.slice(0, 20),
        ...(plan ? { planId: plan.planId } : {}),
      }
      const stored = stripReportText(report)
      if (dryRun && reason === 'manual') {
        // The preview becomes a plan the confirmation must name (also an
        // empty one: confirming it records this store's first run).
        const planId = randomUUID()
        this.plans.set(planId, {
          planId,
          scopeKey: this.scopeKey,
          createdAt: Date.now(),
          items: new Map(planned.filter((memory) => !mergeSourceIds.has(memoryId(memory))).map((memory) => [memoryId(memory), { version: memoryVersion(memory), reason: reasonOf(memory), note: notes.get(memoryId(memory)) }])),
          merges: keptMerges,
          importance,
          deferred,
          review: review ? { ...review, actions: [] } : null,
          advanceTo: review?.advanceTo ?? null,
          backlogAdvanceTo: review?.backlogAdvanceTo ?? null,
          failures: review?.failures ?? cursor.failures,
          idempotencyKey: '',
          promise: null,
          result: null,
        })
        this.#prunePlans()
        report.planId = planId
        report.planExpiresAt = new Date(Date.now() + PLAN_TTL_MS).toISOString()
        this.activity.maintenance = { status: 'ok', ...stored }
        return report
      }
      // Real passes (and confirmed previews) move the real cursor; an
      // automatic preview moves its own, so the next preview goes on where
      // this one stopped instead of paying for the same memories again.
      const before = entry.hygiene ?? {}
      const realCursor = {
        reviewBaseline: before.reviewBaseline ?? baseline,
        reviewWatermark: before.reviewWatermark ?? null,
        backlogWatermark: before.backlogWatermark ?? null,
        groupFailures: before.groupFailures ?? {},
        deferredDeletes: before.deferredDeletes ?? [],
      }
      const moved = { reviewWatermark: nextCursor.watermark, backlogWatermark: nextCursor.backlog, groupFailures: nextCursor.failures }
      const progress = review || plan ? { pending, catchUp } : { pending: before.pending ?? 0, catchUp: false }
      this.#writeEntry(
        {
          profile: nextProfile,
          profiles: nextProfiles,
          hygiene: profileOnly
            ? entry.hygiene ?? null
            : dryRun
              ? {
                  ...realCursor,
                  lastRunAt: before.lastRunAt ?? null,
                  previewAt: finishedAt,
                  lastReport: stored,
                  preview: moved,
                  ...progress,
                }
              : {
                  ...realCursor,
                  ...moved,
                  deferredDeletes: deferred,
                  lastRunAt: finishedAt,
                  lastReport: stored,
                  ...progress,
                },
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
    // A pass waiting for the model is cancelled.
    this.#stopModelWait()
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer)
    this.rebuildTimer = null
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

/**
 * Derive a compact profile from Mem0 facts and keep the store bounded.
 *
 * Mem0 is the source of truth. The profile and hygiene bookkeeping live in a
 * small local JSON file so a failed rebuild never mutates memory records.
 * Everything here is deterministic: no extra model calls are made.
 */
import { estimateTokens } from './token-budget.js'
import { redactSecrets } from './redact.js'

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/
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

const DETAIL_KEYS = ['plannedDetails', 'duplicateDetails', 'prunedDetails', 'deletedDetails']
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

export function dedupeKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[。！？.!?；;，,、:：\-—_/\\]+/g, '')
    .trim()
    .slice(0, 240)
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
    title: '工作与项目',
    pattern:
      /work|project|code|plugin|dsh|mem0|build|develop|job|company|team|api|repo|工作|项目|开发|插件|代码|公司|团队/i,
  },
  {
    title: '偏好与习惯',
    pattern:
      /prefer|like|love|favorite|favourite|habit|style|tone|food|drink|tea|coffee|喜欢|偏好|习惯|口味|风格|饮食|茶|咖啡/i,
  },
  {
    title: '学习与兴趣',
    pattern:
      /learn|study|read|book|music|language|course|interest|learn|学习|阅读|音乐|语言|课程|兴趣|书/i,
  },
  {
    title: '生活与旅行',
    pattern:
      /travel|trip|food|health|family|home|city|life|生活|旅行|健康|家庭|城市|日常/i,
  },
]

function profileSection(text) {
  for (const section of PROFILE_SECTIONS) {
    if (section.pattern.test(text)) return section.title
  }
  return '其他'
}

export function buildProfile(memories, maxTokens = 1375) {
  const buckets = new Map()
  const memoryIds = []
  let tokens = 0
  for (const memory of rankMemories(memories)) {
    const raw = memoryText(memory)
    const line = `- ${raw.length > 320 ? `${raw.slice(0, 317).trimEnd()}…` : raw}`
    const title = profileSection(raw)
    const headingCost = buckets.has(title) ? 0 : estimateTokens(`## ${title}`) + 2
    const cost = estimateTokens(line) + 2 + headingCost
    if (tokens + cost > maxTokens) continue
    if (!buckets.has(title)) buckets.set(title, [])
    buckets.get(title).push(line)
    memoryIds.push(memoryId(memory))
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

export class MemoryMaintenance {
  constructor({ client, config, state, logger, activity = {}, localizer } = {}) {
    this.client = client
    this.localizer = localizer
    this.config = config
    this.state = state
    this.logger = logger
    this.activity = activity
    this.running = null
    this.lastError = null
    this.disposed = false
  }

  profileVersion() {
    return this.state?.read()?.profile?.updatedAt ?? ''
  }

  profileBlock() {
    if (!this.config.profileEnabled) return ''
    const saved = this.state?.read()
    const profile = saved?.profile
    if (!profile || saved.userId !== this.config.userId) return ''
    return typeof profile.text === 'string' ? profile.text.trim() : ''
  }

  isManualProfile() {
    const saved = this.state?.read()
    return Boolean(
      saved?.profile?.manual === true &&
        saved.userId === this.config.userId &&
        typeof saved.profile.text === 'string' &&
        saved.profile.text.trim(),
    )
  }

  /**
   * Persist a user-edited memory summary. Empty text clears the manual
   * profile so the next hygiene/profile pass can regenerate it.
   */
  setProfileText(text) {
    if (!this.config.profileEnabled) throw new Error('profile generation is disabled')
    const value = String(text ?? '').trim()
    const maxTokens = Number(this.config.profileBudgetTokens ?? 1375)
    const tokens = estimateTokens(value)
    if (value && tokens > maxTokens) {
      throw new Error(`memory summary is too long: ${tokens} tokens (max ${maxTokens})`)
    }
    const saved = this.state?.read() ?? {}
    const now = new Date().toISOString()
    const profile = value
      ? {
          userId: this.config.userId,
          text: value,
          tokens,
          items: value.split('\n').filter((line) => line.trim()).length,
          updatedAt: now,
          manual: true,
          source: 'manual',
        }
      : null
    const next = {
      version: 1,
      userId: this.config.userId,
      profile,
      hygiene: saved.hygiene ?? null,
    }
    if (!this.state?.write(next)) {
      throw new Error(this.state?.lastError || 'could not save memory summary')
    }
    return this.status()
  }

  /**
   * Rebuild the profile from all memories without deleting or pruning any.
   * Used by the UI reset button and the agent's reset tool.
   */
  async resetProfile() {
    if (!this.config.profileEnabled) throw new Error('profile generation is disabled')
    const all = await this.#listAll()
    const profile = buildProfile(all, this.config.profileBudgetTokens)
    const saved = this.state?.read() ?? {}
    const now = new Date().toISOString()
    const next = {
      version: 1,
      userId: this.config.userId,
      profile: profile.text
        ? {
            userId: this.config.userId,
            text: profile.text,
            tokens: profile.tokens,
            items: profile.items,
            updatedAt: now,
            manual: false,
            source: 'generated',
          }
        : null,
      hygiene: saved.hygiene ?? null,
    }
    if (!this.state?.write(next)) {
      throw new Error(this.state?.lastError || 'could not save memory summary')
    }
    return this.status()
  }

  status(now = new Date()) {
    const saved = this.state?.read() ?? {}
    const hygiene = saved.hygiene ?? {}
    const lastRunAt = hygiene.lastRunAt ?? null
    const last = Date.parse(lastRunAt ?? hygiene.previewAt ?? '')
    const interval = Number(this.config.hygieneIntervalDays ?? 7)
    const next = Number.isFinite(last) ? last + interval * 86_400_000 : null
    const profile = saved.profile ?? null
    return {
      enabled: Boolean(this.config.hygieneEnabled),
      intervalDays: interval,
      running: Boolean(this.running),
      lastRunAt,
      previewAt: hygiene.previewAt ?? null,
      // Until one confirmed run has happened, automatic passes only preview.
      previewOnly: !lastRunAt,
      nextRunAt: next === null ? null : new Date(next).toISOString(),
      due: this.isDue(now),
      lastReport: stripReportText(hygiene.lastReport ?? null),
      lastError: this.lastError ?? this.state?.lastError ?? null,
      stateError: this.state?.lastError ?? null,
      profile: {
        enabled: Boolean(this.config.profileEnabled),
        tokens: Number(profile?.tokens ?? 0),
        items: Number(profile?.items ?? 0),
        updatedAt: profile?.updatedAt ?? null,
        manual: profile?.manual === true,
        source: profile?.source ?? (profile?.manual ? 'manual' : 'generated'),
      },
    }
  }

  isDue(now = new Date()) {
    if (!this.config.hygieneEnabled) return false
    const hygiene = this.state?.read()?.hygiene ?? {}
    const last = Date.parse(hygiene.lastRunAt ?? hygiene.previewAt ?? '')
    if (!Number.isFinite(last)) return true
    return now.getTime() >= last + Number(this.config.hygieneIntervalDays ?? 7) * 86_400_000
  }

  needsProfileRebuild() {
    const saved = this.state?.read()
    const profile = saved?.profile
    if (!this.config.profileEnabled || !profile) return false
    if (saved.userId !== this.config.userId || profile.manual === true) return false
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
      // recorded `lastRunAt`; before that they only write a preview report.
      const dryRun = !this.state?.read()?.hygiene?.lastRunAt
      return await this.run(reason, { profileOnly: !this.isDue(), dryRun })
    } catch (error) {
      this.logger?.warn?.(`dsh-mem0: memory hygiene failed: ${error.message}`)
      return null
    }
  }

  run(reason = 'manual', options = {}) {
    if (this.running) return this.running
    this.running = this.#run(reason, options).finally(() => {
      this.running = null
    })
    return this.running
  }

  async #listAll() {
    const result = await this.client.list(
      { user_id: this.config.userId },
      { topK: 1000, timeoutMs: 15_000 },
    )
    return Array.isArray(result?.results) ? result.results : []
  }

  /**
   * One maintenance pass. Only memories tagged `metadata.source === 'dsh'`
   * are eligible for deletion; others (written by other Mem0 apps under the
   * same user_id) feed the summary but are never removed or budgeted.
   *
   * `dryRun` computes the same plan without deleting. A manual dry run (the
   * settings page preview) leaves the state file untouched; an automatic one
   * records the preview report and `previewAt`.
   */
  async #run(reason, { profileOnly = false, dryRun = false } = {}) {
    const startedAt = new Date().toISOString()
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
      let ownUnique = own
      if (hygieneEnabled) {
        // Foreign copies always win: an own duplicate of a foreign memory is
        // removable, a foreign duplicate is never touched.
        const seen = new Set(foreign.map((memory) => dedupeKey(memoryText(memory))))
        ownUnique = []
        for (const memory of own) {
          const key = dedupeKey(memoryText(memory))
          if (!key) continue
          if (seen.has(key)) {
            duplicates.push(memory)
          } else {
            seen.add(key)
            ownUnique.push(memory)
          }
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
      const removals = hygieneEnabled ? [...duplicates, ...budget.remove] : []
      const planned = removals.slice(0, 100)
      const kept = [...foreign, ...budget.keep]
      const deleted = []
      const failedDetails = []
      const duplicateSet = new Set(duplicates)
      // A short, redacted preview is only returned live from a manual dry run
      // (the settings page confirmation); stripReportText removes it before
      // anything is stored.
      const previewOf = (memory) => ({
        id: memoryId(memory),
        reason: duplicateSet.has(memory) ? 'duplicate' : 'budget',
        preview: redactSecrets(memoryText(memory)).slice(0, REPORT_PREVIEW_CHARS),
      })
      const duplicateDetails = duplicates.slice(0, 20).map(previewOf)
      const prunedDetails = budget.remove.slice(0, 20).map(previewOf)
      const removedById = new Map(removals.map((memory) => [memoryId(memory), previewOf(memory)]))
      const deletedTexts = []
      if (!dryRun) {
        for (const memory of planned) {
          const id = memoryId(memory)
          if (!id) continue
          try {
            await this.client.remove(id, { timeoutMs: 8_000 })
            deleted.push(id)
            deletedTexts.push(String(memory?.memory ?? memory?.text ?? ''))
          } catch (error) {
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
      const savedState = this.state?.read() ?? {}
      const savedProfile = savedState.profile
      const keepManual =
        this.config.profileEnabled &&
        savedProfile?.manual === true &&
        savedProfile.userId === this.config.userId &&
        typeof savedProfile.text === 'string' &&
        savedProfile.text.trim()
      const profile = this.config.profileEnabled
        ? keepManual
          ? {
              text: savedProfile.text,
              tokens: Number(savedProfile.tokens ?? estimateTokens(savedProfile.text)),
              items: Number(savedProfile.items ?? savedProfile.text.split('\n').filter(Boolean).length),
              memoryIds: [],
            }
          : buildProfile(dedupeMemories(kept).unique, this.config.profileBudgetTokens)
        : { text: '', tokens: 0, items: 0, memoryIds: [] }
      const finishedAt = new Date().toISOString()
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
        pruned: budget.remove.length,
        deleted: deleted.length,
        failed: failedDetails.length,
        // In a dry run: how many a confirmed run would delete (max 100/run).
        planned: hygieneEnabled ? planned.length : 0,
        plannedDetails: dryRun ? planned.slice(0, 20).map(previewOf) : [],
        own: own.length,
        foreign: foreign.length,
        storeCount: kept.length,
        storeTokens: costOf(kept),
        profileItems: profile.items,
        profileTokens: profile.tokens,
        duplicateDetails,
        prunedDetails,
        deletedDetails: deleted.map((id) => removedById.get(id) ?? { id }),
        failedDetails,
      }
      const stored = stripReportText(report)
      if (dryRun && reason === 'manual') {
        this.activity.maintenance = { status: 'ok', ...stored }
        return report
      }
      this.state?.write({
        version: 1,
        userId: this.config.userId,
        profile: profile.text
          ? {
              userId: this.config.userId,
              text: profile.text,
              tokens: profile.tokens,
              items: profile.items,
              updatedAt: keepManual ? savedProfile.updatedAt : finishedAt,
              manual: Boolean(keepManual),
              source: keepManual ? 'manual' : 'generated',
            }
          : null,
        hygiene: profileOnly
          ? savedState.hygiene ?? null
          : dryRun
            ? {
                lastRunAt: savedState.hygiene?.lastRunAt ?? null,
                previewAt: finishedAt,
                lastReport: stored,
              }
            : { lastRunAt: finishedAt, lastReport: stored },
      })
      this.activity.maintenance = { status: 'ok', ...stored }
      return stored
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastError = message
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

  dispose() {
    this.disposed = true
  }
}

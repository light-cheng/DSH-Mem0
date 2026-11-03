/**
 * Derive a compact profile from Mem0 facts and keep the store bounded.
 *
 * Mem0 is the source of truth. The profile and hygiene bookkeeping live in a
 * small local JSON file so a failed rebuild never mutates memory records.
 * Everything here is deterministic: no extra model calls are made.
 */
import { estimateTokens } from './token-budget.js'

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

function timestamp(memory) {
  const value = memory?.updated_at ?? memory?.created_at ?? memory?.createdAt ?? memory?.updatedAt
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

export function memoryScore(memory) {
  const metadata = memory?.metadata && typeof memory.metadata === 'object' ? memory.metadata : {}
  const importance = Number.isFinite(Number(metadata.importance)) ? Number(metadata.importance) : 0
  const pinned = metadata.pinned === true ? 1 : 0
  const recency = timestamp(memory) / 1e12
  return pinned * 1e6 + importance * 1e4 + recency + Math.min(memoryText(memory).length, 500)
}

export function dedupeKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[。！？.!?；;，,、:：\-—_/\\]+/g, '')
    .trim()
    .slice(0, 240)
}

export function rankMemories(memories) {
  return [...(Array.isArray(memories) ? memories : [])]
    .filter((memory) => memory && memoryId(memory) && memoryText(memory))
    .sort((a, b) => memoryScore(b) - memoryScore(a))
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

export function buildProfile(memories, maxTokens = 1375) {
  const lines = []
  const memoryIds = []
  let tokens = 0
  for (const memory of rankMemories(memories)) {
    const raw = memoryText(memory)
    const line = `- ${raw.length > 320 ? `${raw.slice(0, 317).trimEnd()}…` : raw}`
    const cost = estimateTokens(line) + 2
    if (tokens + cost > maxTokens) continue
    lines.push(line)
    memoryIds.push(memoryId(memory))
    tokens += cost
  }
  return {
    text: lines.join('\n'),
    tokens,
    items: lines.length,
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
  constructor({ client, config, state, logger, activity = {} }) {
    this.client = client
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

  status(now = new Date()) {
    const saved = this.state?.read() ?? {}
    const hygiene = saved.hygiene ?? {}
    const lastRunAt = hygiene.lastRunAt ?? null
    const last = Date.parse(lastRunAt ?? '')
    const interval = Number(this.config.hygieneIntervalDays ?? 7)
    const next = Number.isFinite(last) ? last + interval * 86_400_000 : null
    const profile = saved.profile ?? null
    return {
      enabled: Boolean(this.config.hygieneEnabled),
      intervalDays: interval,
      running: Boolean(this.running),
      lastRunAt,
      nextRunAt: next === null ? null : new Date(next).toISOString(),
      due: this.isDue(now),
      lastReport: hygiene.lastReport ?? null,
      lastError: this.lastError ?? this.state?.lastError ?? null,
      stateError: this.state?.lastError ?? null,
      profile: {
        enabled: Boolean(this.config.profileEnabled),
        tokens: Number(profile?.tokens ?? 0),
        items: Number(profile?.items ?? 0),
        updatedAt: profile?.updatedAt ?? null,
      },
    }
  }

  isDue(now = new Date()) {
    if (!this.config.hygieneEnabled) return false
    const lastRunAt = this.state?.read()?.hygiene?.lastRunAt
    const last = Date.parse(lastRunAt ?? '')
    if (!Number.isFinite(last)) return true
    return now.getTime() >= last + Number(this.config.hygieneIntervalDays ?? 7) * 86_400_000
  }

  async maybeRun(reason = 'schedule') {
    if (this.disposed || this.running) return null
    const needsProfile = Boolean(this.config.profileEnabled) && !this.profileBlock()
    if (!this.isDue() && !needsProfile) return null
    try {
      return await this.run(reason)
    } catch (error) {
      this.logger?.warn?.(`dsh-mem0: memory hygiene failed: ${error.message}`)
      return null
    }
  }

  run(reason = 'manual') {
    if (this.running) return this.running
    this.running = this.#run(reason).finally(() => {
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

  async #run(reason) {
    const startedAt = new Date().toISOString()
    this.lastError = null
    this.activity.maintenance = { status: 'running', reason, startedAt }
    try {
      const all = await this.#listAll()
      const hygieneEnabled = Boolean(this.config.hygieneEnabled)
      const { unique, duplicates } = hygieneEnabled
        ? dedupeMemories(all)
        : { unique: rankMemories(all), duplicates: [] }
      const budget = hygieneEnabled
        ? selectForBudget(unique, {
            maxItems: this.config.storeMaxMemories,
            maxTokens: this.config.storeMaxTokens,
          })
        : {
            keep: unique,
            remove: [],
            tokens: unique.reduce((total, memory) => total + estimateTokens(memoryText(memory)) + 8, 0),
          }
      const removals = hygieneEnabled ? [...duplicates, ...budget.remove] : []
      const deleted = []
      const failed = []
      for (const memory of removals.slice(0, 100)) {
        const id = memoryId(memory)
        if (!id) continue
        try {
          await this.client.remove(id, { timeoutMs: 8_000 })
          deleted.push(id)
        } catch (error) {
          failed.push(id)
          this.logger?.debug?.(`dsh-mem0: could not remove ${id}: ${error.message}`)
        }
      }
      const profile = this.config.profileEnabled
        ? buildProfile(budget.keep, this.config.profileBudgetTokens)
        : { text: '', tokens: 0, items: 0, memoryIds: [] }
      const finishedAt = new Date().toISOString()
      const report = {
        reason,
        startedAt,
        finishedAt,
        scanned: all.length,
        duplicates: duplicates.length,
        pruned: budget.remove.length,
        deleted: deleted.length,
        failed: failed.length,
        storeCount: budget.keep.length,
        storeTokens: budget.tokens,
        profileItems: profile.items,
        profileTokens: profile.tokens,
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
              updatedAt: finishedAt,
            }
          : null,
        hygiene: { lastRunAt: finishedAt, lastReport: report },
      })
      this.activity.maintenance = { status: 'ok', ...report }
      return report
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

/**
 * Translate memory text into the language of the settings page.
 *
 * Memories are extracted by Mem0 in the language used by the upstream model,
 * which is often English even when the user interface is Chinese. The browser
 * cannot call the host model, so this host-side helper batches the visible
 * memory texts through DSH's LLM service, caches the result, and falls back to
 * the original text when no model is available.
 *
 * Privacy: translation sends memory text to DSH's current default model, which
 * may be a cloud model, so it only runs when `translateMemories` is enabled.
 * The cache holds memory text in plain form; it is written owner-only (0600)
 * and entries are dropped when the memory they came from is deleted.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { redactSecrets } from './redact.js'

const MAX_BATCH = 12
const MAX_CACHE = 2_000
const MAX_CONCURRENCY = 3
const TIMEOUT_MS = 15_000
const CACHE_VERSION = 1

export function preserveMarkdownPrefixes(originalLines, translatedLines) {
  return originalLines.map((line, index) => {
    const translated = translatedLines[index] ?? line
    const match = /^(#{1,6}\s+|[-*]\s+)/.exec(line)
    if (!match) return translated
    const prefix = match[1]
    // A model may keep the original Markdown marker in its translation.
    // Do not duplicate it when the marker is already present.
    if (translated.includes(prefix)) return translated
    const body = translated.replace(/^(#{1,6}\s+|[-*]\s+)/, '')
    return `${prefix}${body}`
  })
}

export function normalizeLanguage(value) {
  const lang = String(value ?? '').trim().toLowerCase()
  if (lang.startsWith('zh')) return 'zh'
  if (lang.startsWith('en')) return 'en'
  return ''
}

export function hasChinese(text) {
  return /[\u3400-\u9fff]/.test(String(text ?? ''))
}

function countMatches(value, pattern) {
  return (value.match(pattern) ?? []).length
}

export function needsTranslation(text, lang) {
  const value = String(text ?? '')
  if (!value.trim()) return false
  if (lang === 'zh') {
    const cjk = countMatches(value, /[\u3400-\u9fff]/g)
    if (cjk === 0) return true
    // A line is mixed-language when the Latin part is substantial enough to
    // make the line look English with a Chinese term embedded. Counting
    // Chinese characters alone leaves those lines untranslated forever.
    const latin = countMatches(value, /[A-Za-z]/g)
    return latin >= 8 && latin >= cjk * 2
  }
  if (lang === 'en') return hasChinese(value)
  return false
}

function cacheKey(lang, text) {
  return `${lang}\u0000${text}`
}

/**
 * The forms one memory text can take when it reaches `translate()`: the
 * settings routes redact and cut it to 500 (memory list) or 240 (recall
 * preview) characters before translating.
 */
function sourceVariants(text) {
  const raw = String(text ?? '')
  const redacted = redactSecrets(raw)
  return new Set([raw, redacted, redacted.slice(0, 500), redacted.slice(0, 240)].filter((value) => value.trim()))
}

function parseNumbered(text, count) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const parsed = new Array(count).fill('')
  for (const line of lines) {
    const match = line.match(/^(\d+)\s*[.)、:：-]\s*(.*)$/)
    if (!match) continue
    const index = Number(match[1]) - 1
    if (index >= 0 && index < count && !parsed[index]) parsed[index] = match[2].trim()
  }
  return parsed
}

export class MemoryLocalizer {
  constructor({ llm, modelSelection, logger, cachePath, enabled = true } = {}) {
    // The plugin passes `config.translateMemories` (default off); the class
    // default stays on so the helper is usable on its own.
    this.enabled = enabled !== false
    this.llm = llm
    this.modelSelection = modelSelection
    this.logger = logger
    this.cachePath = cachePath
    this.cache = new Map()
    this.loadedFromDisk = false
    this.dirty = false
    this.saveTimer = null
    this.lastError = null
  }

  setServices({ llm, agentDefaultModel } = {}) {
    if (llm) this.llm = llm
    if (agentDefaultModel) this.modelSelection = agentDefaultModel
  }

  available() {
    return Boolean(this.llm && typeof this.llm.stream === 'function')
  }

  diagnostics() {
    return {
      enabled: this.enabled,
      available: this.available(),
      selected: this.#selection(),
      lastError: this.lastError,
    }
  }

  #selection() {
    try {
      const selected = this.modelSelection?.currentSelection?.()
      if (selected?.provider && selected?.model) {
        return { provider: selected.provider, model: selected.model }
      }
    } catch {
      // Fall through: a missing selection is a normal fallback path.
    }
    return null
  }

  /**
   * Drop cached translations of the given source texts (memories that were
   * deleted) and persist the smaller cache.
   * @param {string[]} texts
   * @returns {Promise<number>} number of removed entries
   */
  async forget(texts) {
    await this.#loadCache()
    const sources = new Set()
    for (const text of Array.isArray(texts) ? texts : []) {
      for (const variant of sourceVariants(text)) sources.add(variant)
    }
    if (sources.size === 0) return 0
    let removed = 0
    for (const key of [...this.cache.keys()]) {
      const source = key.slice(key.indexOf('\u0000') + 1)
      if (sources.has(source)) {
        this.cache.delete(key)
        removed += 1
      }
    }
    if (removed > 0) {
      this.dirty = true
      this.#scheduleSave()
    }
    return removed
  }

  /** Write pending cache changes now (used on dispose and by tests). */
  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.cachePath && this.dirty) await this.#saveCache()
  }

  #remember(key, value) {
    if (this.cache.size >= MAX_CACHE) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(key, value)
    this.dirty = true
  }

  async #loadCache() {
    if (!this.cachePath || this.loadedFromDisk) return
    this.loadedFromDisk = true
    try {
      const raw = await readFile(this.cachePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed?.version !== CACHE_VERSION) return
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length < 2) continue
        const [key, value] = entry
        if (typeof key === 'string' && typeof value === 'string' && key.includes('\u0000')) {
          this.cache.set(key, value)
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.debug?.(`dsh-mem0: could not read translation cache: ${error.message}`)
      }
    }
  }

  #scheduleSave() {
    if (!this.cachePath || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.#saveCache()
    }, 250)
    this.saveTimer.unref?.()
  }

  async #saveCache() {
    const entries = [...this.cache.entries()]
    this.dirty = false
    try {
      await mkdir(path.dirname(this.cachePath), { recursive: true })
      const temp = `${this.cachePath}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify({ version: CACHE_VERSION, entries }), { encoding: 'utf8', mode: 0o600 })
      // `mode` only applies when the file is created; tighten a reused temp too.
      await chmod(temp, 0o600)
      await rename(temp, this.cachePath)
    } catch (error) {
      this.dirty = true
      this.logger?.debug?.(`dsh-mem0: could not write translation cache: ${error.message}`)
    }
  }

  async #request(texts, lang) {
    const selection = this.#selection()
    if (!selection || !this.available()) {
      this.lastError = selection ? 'LLM service is not available' : 'No model is selected'
      return null
    }
    const language = lang === 'zh' ? 'Simplified Chinese' : 'English'
    const prompt = [
      `Translate each numbered memory fact into ${language}.`,
      'Preserve names, IDs, code identifiers, URLs, numbers, and technical terms.',
      'Do not add, remove, merge, or explain facts.',
      `Output exactly ${texts.length} lines, each prefixed with its number and a period.`,
      'No preamble, no markdown, no blank lines.',
      '',
      ...texts.map((text, index) => `${index + 1}. ${text}`),
    ].join('\n')
    const chunks = []
    try {
      const stream = this.llm.stream({
        provider: selection.provider,
        model: selection.model,
        sessionId: 'dsh-mem0-i18n',
        system: 'You are a precise translator. Output only the numbered translations.',
        temperature: 0,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: prompt }],
          },
        ],
      })
      for await (const chunk of stream) {
        if (
          (chunk?.type === 'text-delta' || chunk?.type === 'text') &&
          typeof chunk.text === 'string'
        ) {
          chunks.push(chunk.text)
        }
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.logger?.debug?.(`dsh-mem0: memory translation failed: ${this.lastError}`)
      return null
    }
    const parsed = parseNumbered(chunks.join(''), texts.length)
    return parsed.some(Boolean) ? parsed : null
  }

  /**
   * Translate a list of strings. Returns the same number of strings; entries
   * that do not need translation, or that fail, keep their original text.
   */
  async translate(texts, lang) {
    const input = Array.isArray(texts) ? texts.map((text) => String(text ?? '')) : []
    // Disabled: memory text never leaves for the model, and no cache is read.
    if (!this.enabled) return input
    const target = normalizeLanguage(lang)
    await this.#loadCache()
    if (!target || input.length === 0) return input
    const output = [...input]
    const pending = []
    const pendingIndexes = []
    for (let index = 0; index < input.length; index += 1) {
      const text = input[index]
      if (!needsTranslation(text, target)) continue
      const key = cacheKey(target, text)
      const hit = this.cache.get(key)
      if (hit !== undefined) {
        output[index] = hit
        continue
      }
      pending.push(text)
      pendingIndexes.push(index)
    }
    if (pending.length === 0) return output
    const jobs = []
    for (let start = 0; start < pending.length; start += MAX_BATCH) {
      jobs.push({
        batch: pending.slice(start, start + MAX_BATCH),
        indexes: pendingIndexes.slice(start, start + MAX_BATCH),
      })
    }
    let cursor = 0
    const worker = async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor]
        cursor += 1
        const translated = await this.#request(job.batch, target)
        if (!translated) continue
        for (let offset = 0; offset < job.batch.length; offset += 1) {
          const value = translated[offset]
          if (!value) continue
          output[job.indexes[offset]] = value
          this.#remember(cacheKey(target, job.batch[offset]), value)
        }
      }
    }
    const workers = Math.min(MAX_CONCURRENCY, jobs.length)
    await Promise.all(Array.from({ length: workers }, () => worker()))
    if (this.dirty) this.#scheduleSave()
    return output
  }
}

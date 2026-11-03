/**
 * Translate memory text into the language of the settings page.
 *
 * Memories are extracted by Mem0 in the language used by the upstream model,
 * which is often English even when the user interface is Chinese. The browser
 * cannot call the host model, so this host-side helper batches the visible
 * memory texts through DSH's LLM service, caches the result, and falls back to
 * the original text when no model is available.
 */

const MAX_BATCH = 12
const MAX_CACHE = 2_000
const TIMEOUT_MS = 15_000

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

export function needsTranslation(text, lang) {
  const value = String(text ?? '')
  if (!value.trim()) return false
  if (lang === 'zh') return !hasChinese(value)
  if (lang === 'en') return hasChinese(value)
  return false
}

function cacheKey(lang, text) {
  return `${lang}\u0000${text}`
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
  constructor({ llm, modelSelection, logger } = {}) {
    this.llm = llm
    this.modelSelection = modelSelection
    this.logger = logger
    this.cache = new Map()
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
    return { available: this.available(), selected: this.#selection(), lastError: this.lastError }
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

  #remember(key, value) {
    if (this.cache.size >= MAX_CACHE) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(key, value)
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
    const target = normalizeLanguage(lang)
    const input = Array.isArray(texts) ? texts.map((text) => String(text ?? '')) : []
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
    for (let start = 0; start < pending.length; start += MAX_BATCH) {
      const batch = pending.slice(start, start + MAX_BATCH)
      const indexes = pendingIndexes.slice(start, start + MAX_BATCH)
      const translated = await this.#request(batch, target)
      if (!translated) continue
      for (let offset = 0; offset < batch.length; offset += 1) {
        const value = translated[offset]
        if (!value) continue
        output[indexes[offset]] = value
        this.#remember(cacheKey(target, batch[offset]), value)
      }
    }
    return output
  }
}

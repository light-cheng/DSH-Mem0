/**
 * The Mem0 V3 additive extraction step, ported from mem0ai 2.2.1
 * (Apache-2.0, https://github.com/mem0ai/mem0; see NOTICE):
 *
 * - `buildExtractionMessages`: the system and user prompt of
 *   `Memory._add_to_vector_store` with `generate_additive_extraction_prompt
 *   (..., use_input_language=True)`. Byte for byte what Python sends for the
 *   same input (dates, JSON separators, truncation of past messages);
 * - `inspectExtraction`: the answer parsed the way Mem0 parses it
 *   (`remove_code_blocks`, `json.loads(strict=False)`, `extract_json`), plus
 *   why an unusable answer failed (`not_json`, `empty`, `truncated`,
 *   `refusal`), which Mem0 itself swallows.
 *
 * Deviation from Python 2.2.1: `use_input_language` is on (the user's
 * decision): memories keep the language of the conversation.
 */
import { ADDITIVE_EXTRACTION_PROMPT, AGENT_CONTEXT_SUFFIX, LANGUAGE_REQUIREMENT, PAST_MESSAGE_TRUNCATION_LIMIT } from './mem0-prompts.js'

export const EXTRACT_REASONS = Object.freeze(['not_json', 'empty', 'truncated', 'refusal'])
// Nothing was stored, so asking the LLM again cannot duplicate a memory. A
// refusal is not retried: the same text gets the same answer.
export const RETRYABLE_EXTRACT_REASONS = Object.freeze(['not_json', 'empty', 'truncated'])

const EXTRACT_MESSAGES = {
  not_json: "the LLM's fact-extraction answer was not JSON",
  empty: "the LLM's fact-extraction answer was empty",
  truncated: "the LLM's fact-extraction answer was cut off (truncated JSON)",
  refusal: 'the LLM refused to extract facts',
}

export function extractionMessage(reason) {
  return `${EXTRACT_MESSAGES[reason] ?? EXTRACT_MESSAGES.not_json}; nothing was stored`
}

/**
 * The message of an extraction that a gateway refused with an error saying
 * the output budget ran out (lib/providers.js matchOutputLimit). Short, so
 * the failure history keeps all of it; the gateway's own words go in the
 * error's `detail`.
 */
export function outputLimitMessage(maxTokens, status) {
  const budget = Number.isInteger(maxTokens) ? `max_tokens ${maxTokens}` : 'max_tokens'
  return `the LLM answer hit its output limit (${budget}${Number.isInteger(status) ? `, HTTP ${status}` : ''}): reasoning used up the output; nothing was stored. ` +
    "Raise Mem0's llmMaxTokens (8000 or more) or set llmReasoningEffort to low (not DSH's model setting)"
}

const REFUSAL_RE =
  /\b(?:i\s*(?:'m|am)\s+(?:sorry|unable|not able)|i\s+(?:can(?:'|no)t|cannot|won't|will not)|sorry\b|as an ai\b|unable to (?:help|assist|comply)|not able to (?:help|assist))|抱歉|对不起|无法(?:帮助|协助|提供|完成|处理)|不能(?:帮助|协助|提供)/i

/**
 * Python `json.dumps(value, ensure_ascii=False)`: `", "` and `": "`
 * separators, non-ASCII kept as is.
 */
export function pyJson(value) {
  if (Array.isArray(value)) return `[${value.map(pyJson).join(', ')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pyJson(item)}`).join(', ')}}`
  }
  if (value === undefined) return 'null'
  return JSON.stringify(value)
}

/** Text shortened to `limit` code points (Python `len`), with `...`. */
export function truncatePast(text, limit = PAST_MESSAGE_TRUNCATION_LIMIT) {
  const points = Array.from(String(text))
  return points.length <= limit ? String(text) : `${points.slice(0, limit).join('')}...`
}

/** mem0 `parse_messages`: `role: content\n` per message, system/user/assistant only. */
export function parseMessages(messages) {
  let out = ''
  for (const message of messages ?? []) {
    const content = message?.content
    if (content === undefined || content === null) continue
    if (message.role === 'system' || message.role === 'user' || message.role === 'assistant') {
      out += `${message.role}: ${content}\n`
    }
  }
  return out
}

/** mem0 `_format_conversation_history` over the stored last messages. */
export function formatConversationHistory(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  let out = ''
  for (const message of messages) {
    const role = message?.role ?? ''
    const content = message?.message || message?.content || ''
    if (role && content) out += `${role}: ${truncatePast(content)}\n`
  }
  return out
}

/** UTC date as Python `datetime.now(timezone.utc).date().isoformat()`. */
export function utcDate(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

/**
 * The two chat messages of one extraction call.
 * @param {object} input
 * @param {string} input.newMessages parseMessages() of this turn.
 * @param {{ id: string, text: string }[]} input.existingMemories similar memories, ids mapped to "0", "1", ….
 * @param {object[]} input.lastMessages stored recent messages (oldest first).
 * @param {boolean} input.agentScoped agent_id without user_id (adds AGENT_CONTEXT_SUFFIX).
 * @param {boolean} [input.useInputLanguage] default true.
 */
export function buildExtractionMessages({ newMessages, existingMemories = [], lastMessages = [], agentScoped = false, useInputLanguage = true, now = new Date() }) {
  const system = agentScoped ? ADDITIVE_EXTRACTION_PROMPT + AGENT_CONTEXT_SUFFIX : ADDITIVE_EXTRACTION_PROMPT
  const date = utcDate(now)
  const sections = [
    '## Summary\n',
    `## Last k Messages\n${formatConversationHistory(lastMessages)}`,
    `## Recently Extracted Memories\n${pyJson([])}`,
    `## Existing Memories\n${pyJson(existingMemories ?? [])}`,
    `## New Messages\n${typeof newMessages === 'string' ? newMessages : pyJson(newMessages ?? [])}`,
    `## Observation Date\n${date}`,
    `## Current Date\n${date}`,
  ]
  if (useInputLanguage) sections.push(LANGUAGE_REQUIREMENT)
  sections.push('# Output:')
  return [
    { role: 'system', content: system },
    { role: 'user', content: sections.join('\n\n') },
  ]
}

/** mem0 `remove_code_blocks`: a whole-answer fence and `<think>` sections. */
export function removeCodeBlocks(content) {
  let text = content
  if (Array.isArray(text)) {
    text = text.map((block) => (typeof block === 'string' ? block : block && typeof block === 'object' ? String(block.text ?? '') : '')).join('')
  }
  if (typeof text !== 'string') return ''
  const stripped = text.trim()
  const match = /^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/.exec(stripped)
  const inner = match ? match[1].trim() : stripped
  return inner.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

/** mem0 `extract_json`: a fence anywhere, else first `{` to last `}`. */
export function extractJson(text) {
  const trimmed = String(text).trim()
  const match = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(trimmed)
  if (match) return match[1]
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) return trimmed.slice(start, end + 1)
  return trimmed
}

/**
 * `JSON.parse` that accepts raw control characters inside strings, like
 * Python's `json.loads(strict=False)` (models put real newlines in values).
 */
export function parseJsonLoose(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (const char of String(text)) {
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      } else if (char.charCodeAt(0) < 0x20) {
        out += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
        continue
      }
    } else if (char === '"') {
      inString = true
    }
    out += char
  }
  return JSON.parse(out)
}

/** JSON that starts but never closes: an open string, object or array. */
export function looksTruncated(text) {
  const brace = text.indexOf('{')
  const bracket = text.indexOf('[')
  const starts = [brace, bracket].filter((index) => index >= 0)
  if (starts.length === 0) return false
  let depth = 0
  let inString = false
  let escaped = false
  for (const char of text.slice(Math.min(...starts))) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
  }
  return inString || depth > 0
}

function failureReason(text) {
  if (looksTruncated(text)) return 'truncated'
  if (!text.includes('{') && REFUSAL_RE.test(text)) return 'refusal'
  return 'not_json'
}

/**
 * `{ facts, reason }` for an extraction answer, parsed like mem0 2.2.1.
 * `facts` is null when Mem0 could not use the answer. A blank answer is "no
 * facts" for Mem0 but reported as reason `empty`: a JSON-mode model answers
 * `{"memory": []}` when there is nothing to remember. `finishReason: 'length'`
 * turns a not-JSON or empty answer into `truncated` (the output budget ran
 * out, often on thinking).
 */
export function inspectExtraction(response, { finishReason } = {}) {
  const result = inspect(response)
  if (finishReason === 'length' && (result.reason === 'not_json' || result.reason === 'empty')) {
    return { facts: result.facts, reason: 'truncated' }
  }
  return result
}

function inspect(response) {
  let value
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    value = response
  } else {
    const text = removeCodeBlocks(response)
    if (!text) return { facts: [], reason: 'empty' }
    try {
      try {
        value = parseJsonLoose(text)
      } catch {
        value = parseJsonLoose(extractJson(text))
      }
    } catch {
      return { facts: null, reason: failureReason(text) }
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { facts: null, reason: 'not_json' }
  for (const key of ['memory', 'facts']) {
    if (Array.isArray(value[key])) return { facts: value[key].filter(Boolean), reason: undefined }
  }
  return { facts: [], reason: undefined }
}

/** Length and shape of an LLM answer for logs, never its text. */
export function describeAnswer(response) {
  if (response === undefined || response === null) return 'no answer'
  const text = typeof response === 'string' ? response : String(response)
  const stripped = text.trimStart()
  let kind = 'text'
  if (!stripped) kind = 'blank'
  else if (stripped.startsWith('```')) kind = 'code fence'
  else if (stripped.toLowerCase().startsWith('<think>')) kind = '<think> section'
  else if ('{['.includes(stripped[0])) kind = 'JSON-like'
  return `${text.length} chars, starts with ${kind}`
}

/** 'finish_reason=length, 2000/2000 output tokens (1697 reasoning), …' */
export function describeStats(stats) {
  if (!stats) return 'no finish_reason or usage from the endpoint'
  const parts = [`finish_reason=${stats.finishReason ?? '?'}`]
  if ('completionTokens' in stats || 'maxTokens' in stats) parts.push(`${stats.completionTokens ?? '?'}/${stats.maxTokens ?? '?'} output tokens`)
  if ('reasoningTokens' in stats) parts[parts.length - 1] += ` (${stats.reasoningTokens} reasoning)`
  if ('promptTokens' in stats) parts.push(`${stats.promptTokens} prompt tokens`)
  if ('reasoningEffort' in stats) parts.push(`reasoning_effort=${stats.reasoningEffort}`)
  return parts.join(', ')
}

/**
 * Text handling shared by automatic paths and tools.
 *
 * Memory is user data and is also sent to local model/embedding services, so
 * credential-looking values are redacted before storage and before recall
 * context is shown to the model.
 */

const SECRET_PATTERNS = [
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]'],
  [/(authorization\s*[:=]\s*(?:bearer|token)\s+)[^\s"']+/gi, '$1[REDACTED]'],
  [
    /((?:api[_-]?key|secret(?:[_-]?access[_-]?key)?|access[_-]?token|refresh[_-]?token|session[_-]?token|password|passwd|credential)\s*[:=]\s*)[^\s"'`]+/gi,
    '$1[REDACTED]',
  ],
  [/\b(?:sk-|m0sk_|mem0_sk_|psk-)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]'],
  [/\b(?:ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g, '[REDACTED]'],
]

/** Redact common credential shapes from one value. Never throws. */
export function redactSecrets(value) {
  let text
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement)
  return text
}

/** Extract plain text from a DSH content value (string or content-block array). */
export function extractText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (block) =>
        block &&
        typeof block === 'object' &&
        block.type === 'text' &&
        typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
}

const SENTENCE_ENDS = ['。', '！', '？', '.', '!', '?']

/**
 * Cap one message at a sentence boundary within maxChars. The default (450)
 * is a conservative cap for small embedding-model contexts used by local OSS
 * deployments.
 */
export function truncateForCapture(text, maxChars = 450) {
  if (typeof text !== 'string') return ''
  if (text.length <= maxChars) return text
  const window = text.slice(0, maxChars)
  let cut = -1
  for (const end of SENTENCE_ENDS) cut = Math.max(cut, window.lastIndexOf(end))
  if (cut > Math.floor(maxChars / 3)) return text.slice(0, cut + 1)
  return window
}

/** Remove the plugin's own delimiter strings from untrusted memory text. */
export function stripRecallDelimiters(text) {
  return String(text ?? '')
    .replace(/<\/?mem0-relevant-memories>/gi, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

/** Compact one memory line for model-facing tools. */
export function formatMemoryLine(memory, index) {
  const prefix = typeof index === 'number' ? `${index + 1}. ` : ''
  const id = memory && memory.id ? `[mem0:${memory.id}] ` : ''
  const body = stripRecallDelimiters(redactSecrets(memory && memory.memory ? memory.memory : '(empty)'))
  const score = memory && typeof memory.score === 'number' ? ` (score ${memory.score.toFixed(3)})` : ''
  return `${prefix}${id}${body.trim()}${score}`
}

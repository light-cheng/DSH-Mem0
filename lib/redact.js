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
  // A bare `Bearer <token>` outside an Authorization header. The token must
  // look like a credential (16+ token chars, at least one digit) so prose such
  // as "the bearer of this letter" is left alone.
  [/(\bbearer\s+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1[REDACTED]'],
  // Credentials embedded in a URL: scheme://user:password@host.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi, '$1[REDACTED]$2'],
  // Chinese password phrasing: 密码：xxx, 口令是 xxx, 密码为 xxx. After 是/为
  // the value must start with an ASCII character, so questions such as
  // 「密码是什么」 are left alone.
  [/((?:密码|口令)\s*(?:[:：]\s*|(?:是|为)\s*(?=[!-~])))[^\s，。,；;、！？]+/g, '$1[REDACTED]'],
  [
    /((?:api[_-]?key|secret(?:[_-]?access[_-]?key)?|access[_-]?token|refresh[_-]?token|session[_-]?token|password|passwd|credential)\s*[:=]\s*)[^\s"'`]+/gi,
    '$1[REDACTED]',
  ],
  [/\b(?:sk-|m0sk_|mem0_sk_|psk-)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]'],
  [/\b(?:ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g, '[REDACTED]'],
  [/\btvly-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]'],
  // Google API keys: AIza + 35 key chars.
  [/\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, '[REDACTED]'],
  // JWTs: three base64url segments; header and payload are base64 JSON ("eyJ").
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
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

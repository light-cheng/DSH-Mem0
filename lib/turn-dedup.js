/**
 * Near-duplicate check of one turn's capture (lib/native-client.js): is a
 * newly extracted fact already said by a memory written in the same turn
 * (the explicit `mem0_add`, or an earlier fact of the same batch)?
 *
 * Two rules, both against this turn's writes only:
 *
 *   1. cosine ≥ `captureTurnDedupThreshold` (default 0.85);
 *   2. "covered": cosine ≥ COVER_FLOOR (0.75) and every content token of
 *      the fact appears in the other memory.
 *
 * Why (bge-m3, measured 2026-11-21 on the Windows case): the explicit add
 * "用户下周三要去上海出差" and the capture of the same message scored 0.84–0.92,
 * because the extraction LLM resolves the date ("2026年11月25日（下周三）") or
 * splits the sentence ("用户下周三出差" 0.91). Different facts said in one
 * turn scored at most 0.81 ("下周五要去杭州开会"). So 0.85 catches most
 * rewordings; the coverage rule catches the rest (0.84 "用户将于2026年11月25日
 * （下周三）去上海出差": once the resolved date and the filler words go, every
 * character is in the explicit memory) without lowering the threshold
 * further. A fact that adds anything (another city, "五" for "三", "npm" for
 * "pnpm", "浅" for "深") keeps a token the other memory lacks and is not
 * covered.
 *
 * Tokens: CJK characters one by one, Latin words and numbers whole (case
 * folded, a plain -s/-es/-ed/-ing dropped). Dates the LLM writes out
 * ("2026年11月25日", "2026-11-25", "November 25, 2026") and filler words
 * ("用户", "计划", "will", "the", …) are removed first; brackets go, their
 * content stays ("（下周三）" still says 下周三).
 */

/** The coverage rule needs at least this cosine (bge-m3: unrelated facts of one turn ≤ 0.67). */
export const COVER_FLOOR = 0.75

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
const DATE_PATTERNS = [
  /\d{2,4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*[日号]?/g,
  /\d{1,2}\s*月\s*\d{1,2}\s*[日号]/g,
  /\d{2,4}\s*年\s*\d{1,2}\s*月/g,
  /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g,
  /\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b/g,
  new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s*,?\\s*\\d{4})?\\b`, 'g'),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\.?(?:\\s*,?\\s*\\d{4})?\\b`, 'g'),
]
// Filler the extraction LLM adds to a fact; removed as whole words.
const CJK_FILLER = /用户|计划|打算|准备|已经|将要|将会|将于|目前|当前|现在|即将|需要|应该|可能|大概|左右/g
// Single CJK characters that carry no content of their own.
const CJK_STOP = new Set('的了在是也和与及并就已将于要会即为把被让给着过呢吧啊哦'.split(''))
const LATIN_STOP = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'to', 'on', 'in', 'at', 'of', 'for', 'by', 'with', 'from', 'as', 'and', 'or', 'that', 'this', 'it', 'its', 'has', 'have', 'had', 'do', 'does', 'did',
  'user', 'users', 'user\'s', 'he', 'she', 'they', 'their', 'his', 'her', 'i', 'my', 'me', 'we', 'our', 'you', 'your',
  'plan', 'plans', 'planned', 'planning', 'going', 'go', 'about', 'currently', 'now', 'also', 'so', 'which', 'who',
])
const TOKEN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+(?:['’._+-][\p{L}\p{N}]+)*/gu
const CJK_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u

function stem(word) {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2)
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/** The content tokens of a memory text (see the header). */
export function contentTokens(text) {
  let value = String(text ?? '').normalize('NFKC').toLowerCase()
  for (const pattern of DATE_PATTERNS) value = value.replace(pattern, ' ')
  value = value.replace(CJK_FILLER, ' ')
  const tokens = []
  for (const match of value.matchAll(TOKEN_RE)) {
    const token = match[0]
    if (CJK_RE.test(token)) {
      if (!CJK_STOP.has(token)) tokens.push(token)
      continue
    }
    if (LATIN_STOP.has(token)) continue
    tokens.push(/^\p{N}+$/u.test(token) ? token : stem(token))
  }
  return tokens
}

/** Whether every content token of `fact` appears in `other` (and `fact` has some). */
export function coveredBy(fact, other) {
  const tokens = contentTokens(fact)
  if (tokens.length === 0) return false
  const have = new Set(contentTokens(other))
  return tokens.every((token) => have.has(token))
}

/**
 * Whether a new fact repeats one of this turn's writes: `candidates` are
 * `{ text, score }` (score = cosine with the fact). `threshold` 0 = off.
 */
export function repeatsTurnWrite(fact, candidates, threshold) {
  if (!(threshold > 0)) return false
  const floor = Math.min(threshold, COVER_FLOOR)
  return candidates.some(({ text, score }) => score >= threshold || (score >= floor && coveredBy(fact, text)))
}

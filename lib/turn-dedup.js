/**
 * Near-duplicate check of one turn's capture (lib/native-client.js): is a
 * newly extracted fact already said by a memory written in the same turn
 * (the explicit `mem0_add`, or an earlier fact of the same batch)?
 *
 * Two rules, both against this turn's writes only:
 *
 *   1. cosine ≥ `captureTurnDedupThreshold` (default 0.93);
 *   2. "covered": cosine ≥ COVER_FLOOR (0.75) and every content token of
 *      the fact appears in the other memory.
 *
 * Why (bge-m3, measured 2026-11-21 on the Windows case): the explicit add
 * "用户下周三要去上海出差" and the capture of the same message scored 0.84–0.94,
 * because the extraction LLM resolves the date ("2026年11月25日（下周三）") or
 * splits the sentence ("用户下周三出差" 0.91). Different facts on one topic
 * said together score as high: "项目使用 pnpm" / "项目使用 npm" 0.89,
 * "喜欢深色主题" / "喜欢浅色主题" 0.92. So the plain cosine rule stays at
 * 0.93, above those, and the coverage rule catches the rewordings below it
 * (0.84 "用户将于2026年11月25日（下周三）去上海出差": once the resolved date and
 * the filler words go, every character is in the explicit memory). A fact
 * that adds anything (another city, "五" for "三", "npm" for "pnpm", "浅"
 * for "深") keeps a token the other memory lacks and is not covered.
 *
 * Tokens: CJK characters one by one, Latin words and numbers whole (case
 * folded, a plain -s/-es/-ed/-ing dropped). Before splitting, a small fixed
 * word list (coverage only; the embedding never sees it) evens out how the
 * extraction LLM rewrites a Chinese fact:
 *   - a bracket that explains a date ("即" plus a date or "当周" / "下一个",
 *     as in "（下周三，即2026年11月20日当周的下一个周三）") goes whole;
 *   - dates it writes out ("2026年11月25日", "2026-11-25", "November 25,
 *     2026") go;
 *   - "前往", "去往", "赶往", "动身去" read as "去";
 *   - filler ("用户", "计划", "目的地", "出发", "will", "the", …) goes;
 *   - other brackets go, their content stays ("（下周三）" still says 下周三).
 * There are no English synonyms: "User has a business trip next Wednesday"
 * against "User is traveling to Shanghai next Wednesday" (0.85) is stored,
 * and memory hygiene merges such rewordings later.
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
// A bracket that explains a date: "即" and a date or a week phrase inside.
const DATE_NOTE = /\(([^()]*)\)/g
const DATE_NOTE_WORDS = /当周|下一个|下个|这周|本周|上一个|上个/
// Ways of saying "go to" that the extraction LLM uses for 去.
const CJK_GO = /动身去|前往|去往|赶往/g
// Filler the extraction LLM adds to a fact; removed as whole words.
const CJK_FILLER = /用户|计划|打算|准备|已经|将要|将会|将于|目前|当前|现在|即将|需要|应该|可能|大概|左右|目的地|出发/g
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

/** Whether a bracket's content explains a date ("即" plus a date or a week phrase). */
function isDateNote(inner) {
  if (!inner.includes('即')) return false
  return DATE_NOTE_WORDS.test(inner) || DATE_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags.replace('g', '')).test(inner))
}

/** The content tokens of a memory text (see the header). */
export function contentTokens(text) {
  // NFKC turns full-width brackets into ASCII ones.
  let value = String(text ?? '').normalize('NFKC').toLowerCase()
  value = value.replace(DATE_NOTE, (whole, inner) => (isDateNote(inner) ? ' ' : whole))
  for (const pattern of DATE_PATTERNS) value = value.replace(pattern, ' ')
  value = value.replace(CJK_GO, '去').replace(CJK_FILLER, ' ')
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

/**
 * Input-side filter for automatic capture: what of the assistant's final
 * reply is sent to fact extraction.
 *
 * Mem0 2.2.1's additive prompt (lib/mem0-prompts.js, kept byte for byte)
 * extracts facts from assistant messages too. A reply that confirms a memory
 * ("Got it, I've saved that you travel next week") or talks about the tools
 * or screenshots of this turn then becomes a second, reworded copy of the
 * user's fact, or a "fact" about the assistant. The prompt may not be
 * changed, so such sentences are removed from the input instead. Only the
 * assistant's reply is filtered; the user's own words are always sent.
 */

// Split after sentence ends (CJK and Latin) and line breaks; the separators
// stay with their sentence so the kept text reads as before.
const SENTENCE_RE = /[^。！？!?\n]+(?:[。！？!?]+|\n+|$)|[。！？!?\n]+/g

// The assistant confirming a memory operation, or naming the memory tools.
const MEMORY_META = [
  /\bmem0(?:_\w+)?\b/i,
  /(?:长期)?记忆(?:库|系统|工具)|写入记忆|存入记忆|保存到记忆|加入记忆|记忆里/,
  /(?:已|已经|帮你|为你|给你|替你|我(?:会|来|已|已经|都|就)?|好的?[，,]?\s*|收到[，,]?\s*)\s*(?:记住|记下|记录下?|保存|存下|存好|记好)(?:了|啦|好了)?/,
  /\b(?:I(?:'ve|'ll| have| will| just)?|I've)\s+(?:saved|stored|noted|remembered|recorded|added|memorized|kept)\b/i,
  /\b(?:saved|stored|added|noted|recorded)\s+(?:it|this|that|these)?\s*(?:to|in|into)\s+(?:your\s+|my\s+|the\s+)?(?:long-term\s+)?memory\b/i,
  /\b(?:I'll|I will) remember\b|\bgot it[,.!]?\s*(?:I'll|I will)? ?remember\b/i,
]

// The assistant talking about this turn's tools or screenshots (test
// instructions, "I called X", "take a screenshot of…").
const TOOL_META = [
  /截图|截屏|屏幕快照/,
  /\bscreenshots?\b|\bscreen\s?shots?\b/i,
  /(?:调用|使用|用)了?\s*[`'"]?[\w.-]*[`'"]?\s*工具|工具调用|\btool\s+calls?\b/i,
  /\b(?:called|calling|used|using|ran|invoked)\s+(?:the\s+)?[`'"]?[\w.-]+[`'"]?\s+tool\b/i,
]

/** Whether one assistant sentence is memory or tool meta information. */
export function isAssistantMeta(sentence) {
  const text = String(sentence ?? '')
  if (!text.trim()) return false
  return MEMORY_META.some((re) => re.test(text)) || TOOL_META.some((re) => re.test(text))
}

/**
 * The assistant reply without memory confirmations and tool or screenshot
 * meta sentences. Returns `{ text, dropped }` (sentences removed).
 * @param {string} text
 */
export function stripAssistantMeta(text) {
  const source = String(text ?? '')
  const sentences = source.match(SENTENCE_RE) ?? []
  let dropped = 0
  const kept = []
  for (const sentence of sentences) {
    if (isAssistantMeta(sentence)) dropped += 1
    else kept.push(sentence)
  }
  if (dropped === 0) return { text: source, dropped: 0 }
  return { text: kept.join('').replace(/\n{3,}/g, '\n\n').trim(), dropped }
}

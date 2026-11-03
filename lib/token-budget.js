/**
 * Cheap, deterministic token estimate for budgeting.
 *
 * CJK characters are roughly one token each; Latin text is roughly four
 * characters per token. This is deliberately approximate: it is used to keep
 * a prompt block bounded, not to bill tokens exactly.
 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

export function estimateTokens(text) {
  let cjk = 0
  let other = 0
  for (const char of String(text ?? '')) {
    if (CJK.test(char)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

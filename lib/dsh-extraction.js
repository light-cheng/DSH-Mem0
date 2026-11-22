/**
 * Fact extraction with DSH's current model (`llmProvider: 'dsh'`): the
 * extraction prompt of lib/extraction.js sent through `ctx.llm`
 * (lib/dsh-llm.js) instead of an OpenAI-compatible endpoint.
 *
 * - The model is `agentDefaultModel.currentSelection()`, read when the call
 *   starts. A model changed in DSH while a call runs applies to the next
 *   call (a retry included); the running one keeps its model.
 * - DSH resolves the provider's address and key itself: the plugin never
 *   sees them and stores nothing but `llmProvider: 'dsh'`.
 * - The request passes DSH's `llm/stream` hooks, where other plugins can
 *   read it: the user message (conversation, existing memories) is
 *   redacted (redactSecrets) first, and the request carries the purpose
 *   `dsh-mem0/extract`.
 * - JSON comes from the prompt alone (DSH has no JSON mode); thinking
 *   (`reasoning-delta`) is not part of the answer; the lowest reasoning
 *   effort is asked for (`leastEffort`); an answer cut off at max tokens is
 *   returned with `finishReason: 'length'`, so lib/extraction.js reports it
 *   as `truncated` and the capture is retried with a larger budget.
 */
import { completeText, defaultModel } from './dsh-llm.js'
import { redactSecrets } from './redact.js'

export const EXTRACT_PURPOSE = 'dsh-mem0/extract'

// Failures where nothing reached a model: safe to send again.
const NOT_DELIVERED = new Set(['NO_SERVICE', 'NO_MODEL', 'NO_ADAPTER'])

/** `provider/model` of a selection, or ''. */
export function selectionName(selection) {
  return selection?.provider && selection?.model ? `${selection.provider}/${selection.model}` : ''
}

/** DSH's current model as `{ provider, model, name }`, or null. Never a key or an address. */
export function currentDshModel(services) {
  const selection = defaultModel(services?.agentDefaultModel)
  return selection ? { provider: selection.provider, model: selection.model, name: selectionName(selection) } : null
}

function failureMessage(code, name) {
  const model = name ? `DSH's model ${name}` : "DSH's model"
  switch (code) {
    case 'NO_SERVICE':
      return "DSH's model service is not available (NO_SERVICE)"
    case 'NO_MODEL':
      return 'no model is selected in DSH (NO_MODEL)'
    case 'NO_ADAPTER':
      return `${model} is not available: its provider is not loaded (NO_ADAPTER)`
    case 'MISSING_CREDENTIAL':
      return `${model} has no key: API key is missing in DSH (MISSING_CREDENTIAL)`
    case 'INVALID_CREDENTIAL':
      return `${model} has an invalid api key in DSH (INVALID_CREDENTIAL)`
    case 'AUTH':
      return `${model} refused the request: authentication failed (AUTH)`
    case 'RATE_LIMIT':
      return `${model} is rate limited (rate limit, RATE_LIMIT)`
    case 'QUOTA':
    case 'ACCOUNT_QUOTA':
      return `${model} has no quota left (quota, ${code})`
    case 'CONTEXT_WINDOW_EXCEEDED':
      return `the extraction prompt is longer than the context window of ${model} (CONTEXT_WINDOW_EXCEEDED)`
    case 'TIMEOUT':
      return `${model} did not answer in time (timed out)`
    default:
      return `${model} failed (${code})`
  }
}

/**
 * The error of a failed DSH call, for capture and the wizard: `code` the
 * DSH failure code (TIMEOUT for our own time limit), `component: 'llm'`,
 * `provider: 'dsh'`, `model` (`provider/model`), `delivered: false` when no
 * model got the request. The message names the code, never DSH's own text.
 */
export function dshExtractionError(error, selection) {
  const code = typeof error?.code === 'string' && error.code ? error.code : 'LLM_FAILED'
  const name = selectionName(selection)
  const out = new Error(`dsh-mem0: ${failureMessage(code, name)}`)
  out.name = code === 'TIMEOUT' ? 'TimeoutError' : 'DshModelError'
  out.code = code === 'TIMEOUT' ? 'ETIMEDOUT' : code
  out.dshCode = code
  out.component = 'llm'
  out.provider = 'dsh'
  out.step = 'llm_extract'
  if (name) out.model = name
  if (NOT_DELIVERED.has(code)) out.delivered = false
  return out
}

/** finish_reason and token counts of a DSH answer, as providers.js reports them. */
export function dshStats({ usage, finish, config }, maxTokens) {
  const stats = { finishReason: finish?.kind === 'max-tokens' ? 'length' : 'stop' }
  const cap = Number.isInteger(config?.maxTokens) ? config.maxTokens : maxTokens
  if (Number.isInteger(cap)) stats.maxTokens = cap
  if (Number.isFinite(Number(usage?.outputTokens))) stats.completionTokens = Number(usage.outputTokens)
  if (Number.isFinite(Number(usage?.reasoningTokens)) && Number(usage.reasoningTokens) > 0) stats.reasoningTokens = Number(usage.reasoningTokens)
  if (Number.isFinite(Number(usage?.inputTokens))) stats.promptTokens = Number(usage.inputTokens)
  if (typeof config?.reasoningEffort === 'string' && config.reasoningEffort) stats.reasoningEffort = config.reasoningEffort
  return stats
}

/**
 * One extraction call with DSH's current model.
 * @param {object} services `{ llm, agentDefaultModel }` (injected by DSH).
 * @param {{ role, content }[]} prompt buildExtractionMessages() output.
 * @returns {Promise<{ content: string, stats: object, selection: object }>}
 *   rejects with dshExtractionError(); a caller abort rejects with code ABORTED.
 */
export async function dshExtraction(services, prompt, { maxTokens, signal, timeoutMs, providerWaitMs = 3_000 } = {}) {
  const selection = defaultModel(services?.agentDefaultModel)
  if (!services?.llm || typeof services.llm.stream !== 'function') throw dshExtractionError({ code: 'NO_SERVICE' }, null)
  if (!selection) throw dshExtractionError({ code: 'NO_MODEL' }, null)
  const system = prompt.find((message) => message.role === 'system')?.content ?? ''
  const user = prompt.filter((message) => message.role !== 'system').map((message) => String(message.content ?? '')).join('\n\n')
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(Math.max(1, Math.round(timeoutMs))) : undefined
  const combined = timer && signal ? AbortSignal.any([signal, timer]) : timer ?? signal
  let answer
  try {
    answer = await completeText(services, {
      system,
      prompt: redactSecrets(user),
      ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
      leastEffort: true,
      allowTruncated: true,
      selection,
      purpose: EXTRACT_PURPOSE,
      providerWaitMs,
      ...(combined ? { signal: combined } : {}),
    })
  } catch (error) {
    if (error?.code === 'ABORTED' || combined?.aborted) {
      if (timer?.aborted && !signal?.aborted) throw dshExtractionError({ code: 'TIMEOUT' }, selection)
    }
    throw dshExtractionError(error, selection)
  }
  return { content: answer.text, stats: dshStats(answer, maxTokens), selection }
}

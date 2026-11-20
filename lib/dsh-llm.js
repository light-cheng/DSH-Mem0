/**
 * Calls to DSH's own model service (`ctx.llm`, @deepseek-ai/dsh-llm) from
 * the plugin, outside any session: memory translation now, model-driven
 * hygiene later. One place for the rules measured in DSH 0.2.2:
 *
 * - services come from `ctx.inject(['llm', 'agentDefaultModel'], …)` as an
 *   optional dependency; the background model is
 *   `agentDefaultModel.currentSelection()` → `{ provider, model }`;
 * - no `sessionId`: a call without one writes no session file and starts
 *   no title generation;
 * - the answer is the concatenated `text-delta` chunks (`reasoning-delta`
 *   is thinking, not answer); `usage` gives `{ inputTokens, outputTokens,
 *   totalTokens }`;
 * - `stream()` never throws: failures arrive as `finish` with
 *   `{ kind: 'error', failure: { code } }` (NO_ADAPTER, TRANSPORT, AUTH,
 *   MISSING_CREDENTIAL, UNKNOWN_MODEL, …) or `{ kind: 'aborted' }` (also
 *   on a timeout); `{ kind: 'max-tokens' }` is a cut-off answer;
 * - adapters register ~170 ms after the services appear, so a call right
 *   after startup may wait briefly for the provider (`waitForProvider`).
 *
 * Everything sent here also passes DSH's global `llm/stream` hooks, where
 * other plugins can see it: callers redact (redactSecrets) first.
 */

export class DshLlmError extends Error {
  constructor(message, { code = 'LLM_FAILED', finish, usage } = {}) {
    super(message)
    this.name = 'DshLlmError'
    this.code = code
    this.component = 'llm'
    if (finish) this.finish = finish
    if (usage) this.usage = usage
  }
}

/** `{ provider, model, reasoningEffort? }` of DSH's background default model, or null. */
export function defaultModel(selectionService) {
  try {
    const selected = selectionService?.currentSelection?.()
    if (selected?.provider && selected?.model) {
      const out = { provider: String(selected.provider), model: String(selected.model) }
      if (typeof selected.reasoningEffort === 'string' && selected.reasoningEffort) out.reasoningEffort = selected.reasoningEffort
      return out
    }
  } catch {
    // No selection is a normal fallback path.
  }
  return null
}

function providerListed(llm, provider) {
  try {
    const listed = llm?.listProviders?.()
    if (!Array.isArray(listed)) return true
    return listed.some((item) => (typeof item === 'string' ? item : item?.id ?? item?.provider ?? item?.name) === provider)
  } catch {
    return true
  }
}

/** Wait (bounded) until `provider` is registered with the llm service. */
export async function waitForProvider(llm, provider, { timeoutMs = 1_000, intervalMs = 50 } = {}) {
  if (typeof llm?.listProviders !== 'function') return true
  const deadline = Date.now() + timeoutMs
  while (!providerListed(llm, provider)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return true
}

/**
 * One text completion. Resolves `{ text, usage, finish }`; rejects with
 * DshLlmError (`code` from the finish failure, `ABORTED`, `MAX_TOKENS`,
 * `NO_MODEL`, `NO_SERVICE`).
 * @param {object} services `{ llm, agentDefaultModel }`
 * @param {object} request `{ system?, prompt | messages, temperature?, maxTokens?, leastEffort?, signal? }`
 *   The result also carries `config` (the controls actually sent).
 */
export async function completeText(services, request = {}) {
  const llm = services?.llm
  if (!llm || typeof llm.stream !== 'function') throw new DshLlmError('LLM service is not available', { code: 'NO_SERVICE' })
  const selection = request.selection ?? defaultModel(services?.agentDefaultModel)
  if (!selection) throw new DshLlmError('No model is selected', { code: 'NO_MODEL' })
  await waitForProvider(llm, selection.provider, { timeoutMs: request.providerWaitMs ?? 1_000 })
  const messages = request.messages ?? [{ role: 'user', content: [{ type: 'text', text: String(request.prompt ?? '') }] }]
  const controls = {}
  if (Number.isFinite(request.temperature)) controls.temperature = request.temperature
  if (Number.isInteger(request.maxTokens) && request.maxTokens > 0) controls.maxTokens = request.maxTokens
  let config = { provider: selection.provider, model: selection.model, ...controls }
  let streamOf = (options) => llm.stream(options)
  // `leastEffort`: the model's lowest reasoning effort plus the explicit
  // output cap, chosen by prepareCall against the exact model (README of
  // @deepseek-ai/dsh-llm). A model without efforts keeps its default.
  if (request.leastEffort === true && typeof llm.prepareCall === 'function') {
    let prepared
    try {
      prepared = await llm.prepareCall(config, request.signal, (current, model) => {
        const first = model?.reasoning?.efforts?.[0]
        const next = { ...current, ...controls }
        return first?.id === undefined ? next : { ...next, reasoningEffort: first.id }
      })
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'LLM_FAILED'
      throw new DshLlmError(`${code}: ${error instanceof Error ? error.message : String(error)}`, { code })
    }
    config = { ...prepared.config }
    streamOf = (options) => prepared.stream(options)
  }
  const options = { ...config, messages }
  if (request.system) options.system = request.system
  if (request.signal) options.signal = request.signal
  const parts = []
  let usage
  let finish
  try {
    for await (const chunk of streamOf(options)) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') parts.push(chunk.text)
      else if (chunk?.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage
      else if (chunk?.type === 'finish') finish = chunk.reason ?? chunk.finish ?? null
    }
  } catch (error) {
    throw new DshLlmError(error instanceof Error ? error.message : String(error), { code: error?.code ?? 'LLM_FAILED', usage })
  }
  const kind = finish?.kind
  if (kind === 'error') {
    const code = typeof finish.failure?.code === 'string' ? finish.failure.code : 'LLM_FAILED'
    throw new DshLlmError(`${code}: ${finish.failure?.message ?? 'model call failed'}`, { code, finish, usage })
  }
  if (kind === 'aborted') throw new DshLlmError('model call aborted', { code: 'ABORTED', finish, usage })
  const text = parts.join('')
  if (kind === 'max-tokens' && request.allowTruncated !== true) {
    const error = new DshLlmError('model answer was cut off (max tokens)', { code: 'MAX_TOKENS', finish, usage })
    error.text = text
    throw error
  }
  return { text, usage: usage ?? null, finish: finish ?? null, config: { maxTokens: config.maxTokens ?? null, reasoningEffort: config.reasoningEffort ?? null } }
}

/** Sum two usage records (`{ inputTokens, outputTokens, totalTokens }`). */
export function addUsage(total, usage) {
  const out = { inputTokens: 0, outputTokens: 0, totalTokens: 0, ...(total ?? {}) }
  if (!usage || typeof usage !== 'object') return out
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    const value = Number(usage[key])
    if (Number.isFinite(value) && value > 0) out[key] = (out[key] ?? 0) + value
  }
  if (!(Number(usage.totalTokens) > 0)) {
    const sum = (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0)
    if (sum > 0) out.totalTokens += sum
  }
  return out
}

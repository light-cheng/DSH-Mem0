/**
 * Extra `mem0_status` lines: where the local backend keeps memories, which
 * embedder and LLM it uses (never their keys), the latest failure to open
 * the store, settings of earlier versions that are ignored now, and
 * settings that DSH's settings sync dropped. Everything here is already
 * redacted (home paths shown as `~`).
 */
import { describeConfigWarning } from './config-guard.js'
import { sanitizeFailureMessage } from './failure-history.js'

function describeEndpoint(settings) {
  if (!settings?.baseUrl) return 'not configured'
  try {
    const url = new URL(settings.baseUrl)
    return `${settings.model || '?'} at ${url.host}`
  } catch {
    return settings.model || '?'
  }
}

/**
 * Notices for users upgrading from the Python sidecar versions, from the
 * config alone (nothing connects to Qdrant):
 * - `legacyQdrant`: oss.json still names a Qdrant server and the SQLite
 *   store has no memories of this user (the setup wizard moves them);
 * - `qdrantMigrated`: the store was filled from Qdrant; the old data is
 *   still there, unused;
 * - `noLocalConfig`: no embedder is configured for the local backend, or
 *   nothing was found and `auto` chose the Platform (earlier versions fell
 *   back to reading settings from elsewhere).
 * @returns {Array<{ code: string, endpoint?: string, collection?: string }>}
 */
export function upgradeNotices(config, { memoryCount, migration } = {}) {
  const notices = []
  if (!config) return notices
  if (config.backend === 'oss' && migration) {
    notices.push({ code: 'qdrantMigrated', endpoint: migration.endpoint ?? undefined, collection: migration.collection ?? undefined })
  } else if (config.backend === 'oss' && config.legacyQdrant && !(memoryCount > 0)) {
    notices.push({ code: 'legacyQdrant', endpoint: config.legacyQdrant.endpoint, collection: config.legacyQdrant.collection })
  }
  const embedderMissing = config.backend === 'oss' && (config.native?.problems ?? []).some((problem) => problem.component === 'embedder' && problem.code === 'CONFIG_MISSING')
  if (embedderMissing || config.backendSource === 'auto-default') notices.push({ code: 'noLocalConfig' })
  return notices
}

/** One English line per upgrade notice. */
export function describeUpgradeNotice(notice) {
  if (notice?.code === 'legacyQdrant') {
    return `upgrade: earlier memories are still in Qdrant (${notice.endpoint}, collection ${notice.collection}); this version stores memories in SQLite and does not read them. Move them with the setup wizard on the settings page ("Move memories from Qdrant").`
  }
  if (notice?.code === 'qdrantMigrated') {
    return `upgrade: memories were moved from Qdrant (${notice.endpoint ?? '?'}, collection ${notice.collection ?? '?'}). The old data is still in Qdrant and no longer used; you may delete it or stop the Qdrant service.`
  }
  if (notice?.code === 'noLocalConfig') {
    return 'upgrade: no local backend settings were found in ~/.dsh/mem0/oss.json. Earlier versions fell back to reading settings from elsewhere; this one does not. Set it up again with the setup wizard on the settings page (or add the "dsh_mem0" block, README "Local backend").'
  }
  return ''
}

const MAX_TOKENS_SOURCES = { plugin: 'plugin setting llmMaxTokens', 'oss.json': 'oss.json llm.config.max_tokens', default: 'default' }

/** ', max_tokens 2000 (oss.json llm.config.max_tokens)', or '' when unknown. */
export function describeMaxTokens(llm) {
  if (!Number.isInteger(llm?.maxTokens)) return ''
  const source = MAX_TOKENS_SOURCES[llm.maxTokensSource]
  return `, max_tokens ${llm.maxTokens}${source ? ` (${source})` : ''}`
}

/**
 * 'last extraction: 2026-11-22T…, deepseek-official/deepseek-flash, 2 facts,
 * 1834 prompt + 96 output tokens (40 reasoning)', or '' before the first.
 */
export function describeLastExtraction(last) {
  if (!last?.at) return ''
  const parts = [last.at]
  if (last.via === 'dsh') parts.push(last.model ? `DSH model ${last.model}` : 'DSH model')
  if (last.ok === false) parts.push(`failed (${Number.isInteger(last.status) ? `HTTP ${last.status}, ` : ''}${last.reason ?? last.code ?? '?'})`)
  else if (Number.isInteger(last.facts)) parts.push(`${last.facts} facts`)
  const tokens = []
  if (Number.isFinite(last.promptTokens)) tokens.push(`${last.promptTokens} prompt`)
  if (Number.isFinite(last.completionTokens)) tokens.push(`${last.completionTokens} output`)
  if (tokens.length) parts.push(`${tokens.join(' + ')} tokens${last.reasoningTokens > 0 ? ` (${last.reasoningTokens} reasoning)` : ''}`)
  if (last.finishReason === 'length') parts.push(`cut off at the output budget${Number.isInteger(last.maxTokens) ? ` (max_tokens ${last.maxTokens})` : ''}`)
  let line = `last extraction: ${parts.join(', ')}`
  // A gateway's "cut at its output budget" HTTP error: what to change, and
  // the gateway's own words.
  if (last.ok === false && last.reason === 'truncated' && Number.isInteger(last.status)) {
    line += ". Raise Mem0's llmMaxTokens (8000 or more) or set llmReasoningEffort to low (not DSH's model setting)"
    if (last.detail) line += `. Gateway: ${sanitizeFailureMessage(last.detail, { max: 300 })}`
  }
  return line
}

/** @returns {string[]} */
export function diagnosticLines({ client, config, configGuard, memoryCount } = {}) {
  const lines = []
  for (const notice of upgradeNotices(config, { memoryCount })) lines.push(describeUpgradeNotice(notice))
  if (config?.backend === 'oss') {
    const native = config.native
    if (native) {
      lines.push(`store: ${sanitizeFailureMessage(native.storePath ?? '')} (SQLite)`)
      lines.push(`embedder: ${native.embedder?.provider ?? 'openai'} ${describeEndpoint(native.embedder)}${native.embedder?.apiKeyRef ? `, key from credential ${native.embedder.apiKeyRef}` : ''}`)
      if (native.llm?.provider !== 'dsh') lines.push(`extraction LLM: ${describeEndpoint(native.llm)}${describeMaxTokens(native.llm)}${native.llm?.apiKeyRef ? `, key from credential ${native.llm.apiKeyRef}` : ''}`)
      for (const problem of native.problems ?? []) lines.push(`configuration (${problem.component}): ${problem.message}`)
    }
    let status
    try {
      status = client?.status?.()
    } catch {
      status = undefined
    }
    // Configuration and last call, as two lines: with llmProvider 'dsh' the
    // model of the last call may differ from the one selected now.
    if (native?.llm?.provider === 'dsh') {
      const now = status?.dshModel
      lines.push(`extraction LLM (configured): follows DSH's current model${status ? `, now ${now ?? 'none (no model is selected in DSH)'}` : ''}`)
    }
    const last = describeLastExtraction(status?.lastExtraction)
    if (last) lines.push(last)
    const failure = status?.lastStartFailure
    if (failure && !status?.running) {
      lines.push(`last store failure (${failure.at}, ${failure.component ?? 'vector_store'}, ${failure.code ?? '?'}): ${sanitizeFailureMessage(failure.reason ?? '')}`)
    }
  }
  if (config?.ignoredSettings?.length) {
    lines.push(`ignored settings of the removed Python sidecar: ${config.ignoredSettings.join(', ')}`)
  }
  const warning = configGuard?.status?.()
  if (warning) lines.push(`warning: ${describeConfigWarning(warning)}`)
  return lines
}

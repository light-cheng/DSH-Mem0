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

/** @returns {string[]} */
export function diagnosticLines({ client, config, configGuard } = {}) {
  const lines = []
  if (config?.backend === 'oss') {
    const native = config.native
    if (native) {
      lines.push(`store: ${sanitizeFailureMessage(native.storePath ?? '')} (SQLite)`)
      lines.push(`embedder: ${native.embedder?.provider ?? 'openai'} ${describeEndpoint(native.embedder)}${native.embedder?.apiKeyRef ? `, key from credential ${native.embedder.apiKeyRef}` : ''}`)
      lines.push(`extraction LLM: ${describeEndpoint(native.llm)}${native.llm?.apiKeyRef ? `, key from credential ${native.llm.apiKeyRef}` : ''}`)
      for (const problem of native.problems ?? []) lines.push(`configuration (${problem.component}): ${problem.message}`)
    }
    let status
    try {
      status = client?.status?.()
    } catch {
      status = undefined
    }
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

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
 *   store has no memories of this user;
 * - `noLocalConfig`: no embedder is configured for the local backend, or
 *   nothing was found and `auto` chose the Platform (earlier versions also
 *   read the Hermes Mem0 setup).
 * @returns {Array<{ code: string, endpoint?: string, collection?: string }>}
 */
export function upgradeNotices(config, { memoryCount } = {}) {
  const notices = []
  if (!config) return notices
  if (config.backend === 'oss' && config.legacyQdrant && !(memoryCount > 0)) {
    notices.push({ code: 'legacyQdrant', endpoint: config.legacyQdrant.endpoint, collection: config.legacyQdrant.collection })
  }
  const embedderMissing = config.backend === 'oss' && (config.native?.problems ?? []).some((problem) => problem.component === 'embedder' && problem.code === 'CONFIG_MISSING')
  if (embedderMissing || config.backendSource === 'auto-default') notices.push({ code: 'noLocalConfig' })
  return notices
}

/** One English line per upgrade notice. */
export function describeUpgradeNotice(notice) {
  if (notice?.code === 'legacyQdrant') {
    return `upgrade: earlier memories are still in Qdrant (${notice.endpoint}, collection ${notice.collection}); this version stores memories in SQLite and does not read them. Moving them over comes with the setup wizard of a later version.`
  }
  if (notice?.code === 'noLocalConfig') {
    return 'upgrade: no local backend settings were found in ~/.dsh/mem0/oss.json. Earlier versions could fall back to the Hermes Mem0 setup; this one does not. Add the "dsh_mem0" block (README, "Local backend") or wait for the setup wizard of a later version.'
  }
  return ''
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

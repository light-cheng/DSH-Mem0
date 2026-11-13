/**
 * Extra `mem0_status` lines: which Python the OSS sidecar uses and why, the
 * latest failed sidecar start, and settings that DSH's settings sync
 * dropped. Everything here is already redacted (home paths shown as `~`).
 */
import { describeConfigWarning } from './config-guard.js'
import { sanitizeFailureMessage } from './failure-history.js'

const PYTHON_SOURCES = {
  configured: 'pythonPath setting',
  'oss-config': 'dsh_mem0.pythonPath in oss.json',
  default: 'default ~/.dsh/mem0/venv',
  legacy: 'legacy location',
  path: 'PATH fallback: no ~/.dsh/mem0/venv found',
}

/** @returns {string[]} */
export function diagnosticLines({ client, config, configGuard } = {}) {
  const lines = []
  if (config?.backend === 'oss') {
    const python = sanitizeFailureMessage(config.pythonPath ?? '')
    lines.push(`python interpreter: ${python} (${PYTHON_SOURCES[config.pythonSource] ?? 'configured'})`)
    let status
    try {
      status = client?.status?.()
    } catch {
      status = undefined
    }
    const failure = status?.lastStartFailure
    if (failure && !status?.running) {
      const exit = Number.isInteger(failure.exitCode) ? `, exit code ${failure.exitCode}` : failure.signal ? `, signal ${failure.signal}` : ''
      lines.push(`last sidecar start failure (${failure.at}${exit}, ${failure.component ?? 'sidecar'}): ${failure.reason}`)
      if (failure.configError) lines.push('this is a configuration error: the sidecar is not started again until oss.json changes')
    }
  }
  const warning = configGuard?.status?.()
  if (warning) lines.push(`warning: ${describeConfigWarning(warning)}`)
  return lines
}

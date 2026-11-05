/**
 * Plugin configuration and path normalization.
 *
 * The plugin supports three backends:
 *   platform — Mem0 Platform (managed API, Authorization: Token)
 *   server   — a self-hosted Mem0 REST server (X-API-Key or Bearer)
 *   oss      — a local Mem0 OSS Python sidecar (Mem0 SDK + Qdrant/embedder)
 *
 * `backend: auto` picks platform when an API key is configured (in the
 * settings, in DSH credentials under `apiKeyEnv`, or in the `apiKeyEnv`
 * environment variable), server when a
 * non-default baseUrl is configured, and OSS when a Mem0 OSS config file is
 * present. This keeps a fresh install simple while still supporting local
 * bge-m3/Qdrant setups. Because an inherited `MEM0_API_KEY` alone selects the
 * cloud Platform, the resolved config records why a backend was chosen
 * (`backendSource`) so status output can show it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { LEGACY_MEM0_CONFIGS, LEGACY_PYTHONS } from './legacy-paths.js'

export const DEFAULT_PLATFORM_BASE_URL = 'https://api.mem0.ai'
export const DEFAULT_SERVER_BASE_URL = 'http://127.0.0.1:8888'
export const DEFAULT_MEM0_CONFIG = path.join(os.homedir(), '.dsh', 'mem0', 'oss.json')
/** @deprecated First entry of LEGACY_MEM0_CONFIGS (see lib/legacy-paths.js). */
export const LEGACY_HERMES_CONFIG = LEGACY_MEM0_CONFIGS[0]
export const DEFAULT_PYTHON = path.join(os.homedir(), '.dsh', 'mem0', 'venv', 'bin', 'python')
/** @deprecated First entry of LEGACY_PYTHONS (see lib/legacy-paths.js). */
export const LEGACY_PYTHON = LEGACY_PYTHONS[0]
export const DEFAULT_HISTORY_DB = path.join(os.homedir(), '.dsh', 'mem0', 'history.db')

export const COLLECTION_RE = /^[A-Za-z0-9_-]{1,64}$/
export const BACKENDS = ['auto', 'platform', 'server', 'oss']

export const Config = z.object({
  backend: z.union([z.const('auto'), z.const('platform'), z.const('server'), z.const('oss')]).default('auto'),
  apiKey: z.string().role('secret').default(''),
  apiKeyEnv: z.string().default('MEM0_API_KEY'),
  baseUrl: z.string().default(''),
  authType: z.union([
    z.const('apiKey'),
    z.const('bearer'),
    z.const('token'),
    z.const('none'),
  ]).default('apiKey'),
  pythonPath: z.string().default(''),
  mem0ConfigPath: z.string().default(''),
  collectionName: z.string().default('dsh_mem0'),
  historyDbPath: z.string().default(''),
  userId: z.string().default('dsh-user'),
  agentId: z.string().default('dsh'),
  autoRecall: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
  includeSubagents: z.boolean().default(false),
  captureMaxChars: z.number().min(50).max(4000).default(450),
  recallTopK: z.number().min(1).max(20).default(5),
  timeoutMs: z.number().min(1).max(300000).default(30000),
  recallTimeoutMs: z.number().min(100).max(60000).default(3000),
  addTimeoutMs: z.number().min(1000).max(600000).default(120000),
  sidecarEnv: z.array(z.string()).default([]),
  captureFilter: z.union([z.const('off'), z.const('heuristic')]).default('heuristic'),
  profileEnabled: z.boolean().default(true),
  profileBudgetTokens: z.number().min(128).max(8000).default(1375),
  memoryBudgetTokens: z.number().min(128).max(20000).default(2200),
  storeMaxMemories: z.number().min(20).max(5000).default(500),
  storeMaxTokens: z.number().min(500).max(200000).default(20000),
  hygieneEnabled: z.boolean().default(true),
  hygieneIntervalDays: z.number().min(1).max(90).default(7),
  translateMemories: z.boolean().default(false),
  enabled: z.boolean().default(true),
}).volatile()

/**
 * Unwrap a Schemastery volatile config reference, leaving plain objects as-is.
 * `apply` receives a reference because Config is volatile so the settings page
 * can edit it without a full plugin remount; tests pass plain objects.
 * @param {object|undefined} raw
 * @returns {object|undefined}
 */
export function unwrapConfig(raw) {
  return raw && typeof raw.get === 'function' ? raw.get() : raw
}

function expandHome(value) {
  if (typeof value !== 'string') return value
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

function nonEmpty(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function normalizeUrl(value, fallback) {
  const url = nonEmpty(value, fallback)
  return url.replace(/\/+$/, '')
}

function resolvePython(value) {
  const configured = nonEmpty(value, '')
  if (configured) return path.resolve(expandHome(configured))
  return findDefaultPython()
}

function resolveMem0Config(value) {
  const configured = nonEmpty(value, '')
  if (configured) return path.resolve(expandHome(configured))
  return findDefaultMem0Config()
}

/**
 * Default Mem0 OSS config: `~/.dsh/mem0/oss.json`, then the legacy locations
 * in lib/legacy-paths.js; `~/.dsh/mem0/oss.json` when none exists.
 */
export function findDefaultMem0Config() {
  return [DEFAULT_MEM0_CONFIG, ...LEGACY_MEM0_CONFIGS].find((candidate) => fs.existsSync(candidate)) ?? DEFAULT_MEM0_CONFIG
}

/**
 * Default Python: `~/.dsh/mem0/venv/bin/python`, then the legacy locations in
 * lib/legacy-paths.js, then `python3` from PATH.
 */
export function findDefaultPython() {
  return [DEFAULT_PYTHON, ...LEGACY_PYTHONS].find((candidate) => fs.existsSync(candidate)) ?? 'python3'
}

/**
 * Normalize a raw loader config into the values consumed by the plugin.
 * @param {object|undefined} raw
 * @returns {object}
 */
export function resolveConfig(raw = {}, { credential } = {}) {
  const unwrapped = unwrapConfig(raw)
  const value = unwrapped && typeof unwrapped === 'object' ? unwrapped : {}
  const apiKeyEnv = nonEmpty(value.apiKeyEnv, 'MEM0_API_KEY')
  // Key precedence: literal `apiKey` in config, then the host credential
  // service's answer for `apiKeyEnv` (lib/credentials.js), then process.env.
  const configuredApiKey = nonEmpty(value.apiKey, '')
  const credentialApiKey = configuredApiKey ? '' : nonEmpty(credential?.value, '')
  const credentialFromStore = Boolean(credentialApiKey) && credential?.source !== 'env'
  const envApiKey = configuredApiKey || credentialApiKey ? '' : nonEmpty(process.env[apiKeyEnv], '')
  const apiKey = configuredApiKey || credentialApiKey || envApiKey
  // 'config' | 'credentials' (DSH credential store or .env) | 'env' | 'none'
  const apiKeySource = configuredApiKey
    ? 'config'
    : credentialApiKey
      ? credentialFromStore ? 'credentials' : 'env'
      : envApiKey ? 'env' : 'none'
  const baseUrl = normalizeUrl(value.baseUrl, '')
  const mem0ConfigPath = resolveMem0Config(value.mem0ConfigPath)
  const collectionName = nonEmpty(value.collectionName, 'dsh_mem0')
  if (!COLLECTION_RE.test(collectionName)) {
    throw new Error('dsh-mem0: collectionName must match ^[A-Za-z0-9_-]{1,64}$')
  }
  const userId = nonEmpty(value.userId, 'dsh-user')
  const agentId = nonEmpty(value.agentId, 'dsh')
  const captureMaxChars = Number(value.captureMaxChars ?? 450)
  const recallTopK = Number(value.recallTopK ?? 5)
  const timeoutMs = Number(value.timeoutMs ?? 30000)
  const recallTimeoutMs = Number(value.recallTimeoutMs ?? 3000)
  const addTimeoutMs = Number(value.addTimeoutMs ?? 120000)
  const profileBudgetTokens = Number(value.profileBudgetTokens ?? 1375)
  const memoryBudgetTokens = Number(value.memoryBudgetTokens ?? 2200)
  const storeMaxMemories = Number(value.storeMaxMemories ?? 500)
  const storeMaxTokens = Number(value.storeMaxTokens ?? 20000)
  const hygieneIntervalDays = Number(value.hygieneIntervalDays ?? 7)
  if (!Number.isInteger(captureMaxChars) || captureMaxChars < 50 || captureMaxChars > 4000) {
    throw new Error('dsh-mem0: captureMaxChars must be an integer in [50, 4000]')
  }
  if (!Number.isInteger(recallTopK) || recallTopK < 1 || recallTopK > 20) {
    throw new Error('dsh-mem0: recallTopK must be an integer in [1, 20]')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw new Error('dsh-mem0: timeoutMs must be an integer in [1, 300000]')
  }
  if (!Number.isInteger(recallTimeoutMs) || recallTimeoutMs < 100 || recallTimeoutMs > 60000) {
    throw new Error('dsh-mem0: recallTimeoutMs must be an integer in [100, 60000]')
  }
  if (!Number.isInteger(addTimeoutMs) || addTimeoutMs < 1000 || addTimeoutMs > 600000) {
    throw new Error('dsh-mem0: addTimeoutMs must be an integer in [1000, 600000]')
  }
  const sidecarEnv = Array.isArray(value.sidecarEnv)
    ? [...new Set(value.sidecarEnv.map((name) => String(name).trim()).filter(Boolean))]
    : []
  for (const name of sidecarEnv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`dsh-mem0: sidecarEnv entry ${JSON.stringify(name)} is not an environment variable name`)
    }
  }
  if (!Number.isInteger(profileBudgetTokens) || profileBudgetTokens < 128 || profileBudgetTokens > 8000) {
    throw new Error('dsh-mem0: profileBudgetTokens must be an integer in [128, 8000]')
  }
  if (!Number.isInteger(memoryBudgetTokens) || memoryBudgetTokens < 128 || memoryBudgetTokens > 20000) {
    throw new Error('dsh-mem0: memoryBudgetTokens must be an integer in [128, 20000]')
  }
  if (!Number.isInteger(storeMaxMemories) || storeMaxMemories < 20 || storeMaxMemories > 5000) {
    throw new Error('dsh-mem0: storeMaxMemories must be an integer in [20, 5000]')
  }
  if (!Number.isInteger(storeMaxTokens) || storeMaxTokens < 500 || storeMaxTokens > 200000) {
    throw new Error('dsh-mem0: storeMaxTokens must be an integer in [500, 200000]')
  }
  if (!Number.isInteger(hygieneIntervalDays) || hygieneIntervalDays < 1 || hygieneIntervalDays > 90) {
    throw new Error('dsh-mem0: hygieneIntervalDays must be an integer in [1, 90]')
  }

  const configuredBackend = BACKENDS.includes(value.backend) ? value.backend : 'auto'
  let backend = configuredBackend
  // Why this backend: 'configured', or the auto-detection rule that matched.
  let backendSource = 'configured'
  if (backend === 'auto') {
    if (apiKey) {
      backend = 'platform'
      backendSource =
        apiKeySource === 'env' ? 'auto-api-key-env' : apiKeySource === 'credentials' ? 'auto-api-key-credentials' : 'auto-api-key'
    } else if (baseUrl && baseUrl !== DEFAULT_PLATFORM_BASE_URL) {
      backend = 'server'
      backendSource = 'auto-base-url'
    } else if (fs.existsSync(mem0ConfigPath)) {
      backend = 'oss'
      backendSource = 'auto-oss-config'
    } else {
      backend = 'platform'
      backendSource = 'auto-default'
    }
  }
  let backendBaseUrl = baseUrl
  if (backend === 'platform' && !baseUrl) backendBaseUrl = DEFAULT_PLATFORM_BASE_URL
  if (backend === 'server' && !baseUrl) backendBaseUrl = DEFAULT_SERVER_BASE_URL
  if (backend === 'oss') backendBaseUrl = baseUrl || ''

  return {
    backend,
    backendSource,
    apiKey,
    apiKeySource,
    apiKeyEnv,
    baseUrl: backendBaseUrl,
    authType: nonEmpty(value.authType, backend === 'platform' ? 'token' : 'apiKey'),
    pythonPath: resolvePython(value.pythonPath),
    mem0ConfigPath,
    collectionName,
    historyDbPath: path.resolve(expandHome(nonEmpty(value.historyDbPath, DEFAULT_HISTORY_DB))),
    userId,
    agentId,
    autoRecall: value.autoRecall !== false,
    autoCapture: value.autoCapture !== false,
    announceToAgent: value.announceToAgent !== false,
    includeSubagents: value.includeSubagents === true,
    captureMaxChars,
    recallTopK,
    timeoutMs,
    recallTimeoutMs,
    addTimeoutMs,
    sidecarEnv,
    captureFilter: value.captureFilter === 'off' ? 'off' : 'heuristic',
    profileEnabled: value.profileEnabled !== false,
    profileBudgetTokens,
    memoryBudgetTokens,
    storeMaxMemories,
    storeMaxTokens,
    hygieneEnabled: value.hygieneEnabled !== false,
    hygieneIntervalDays,
    translateMemories: value.translateMemories === true,
    enabled: value.enabled !== false,
  }
}

/**
 * One-line, human-readable reason for the resolved backend, naming where the
 * memory data goes. Used by `mem0_status` and the settings page.
 * @param {object} config Resolved config.
 * @returns {string}
 */
export function describeBackendChoice(config) {
  const env = config?.apiKeyEnv || 'MEM0_API_KEY'
  switch (config?.backendSource) {
    case 'auto-api-key-env':
      return `auto: ${env} is set in the environment, so memories go to the Mem0 Platform (${config.baseUrl || DEFAULT_PLATFORM_BASE_URL}). Set backend explicitly to override.`
    case 'auto-api-key-credentials':
      return `auto: ${env} is stored in DSH credentials, so memories go to the Mem0 Platform (${config.baseUrl || DEFAULT_PLATFORM_BASE_URL}).`
    case 'auto-api-key':
      return `auto: an API key is configured, so memories go to the Mem0 Platform (${config.baseUrl || DEFAULT_PLATFORM_BASE_URL}).`
    case 'auto-base-url':
      return `auto: a custom baseUrl is configured, so memories go to that server (${config.baseUrl}).`
    case 'auto-oss-config':
      return 'auto: a local Mem0 OSS config was found, so memories stay in the local OSS sidecar.'
    case 'auto-default':
      return `auto: nothing else was configured, so the Mem0 Platform (${config.baseUrl || DEFAULT_PLATFORM_BASE_URL}) is used; it needs an API key.`
    default:
      return 'configured explicitly'
  }
}

export { expandHome }

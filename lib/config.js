/**
 * Plugin configuration and path normalization.
 *
 * The plugin supports three backends:
 *   platform — Mem0 Platform (managed API, Authorization: Token)
 *   server   — a self-hosted Mem0 REST server (X-API-Key or Bearer)
 *   oss      — local memory: a SQLite file (`~/.dsh/mem0/memory.sqlite`)
 *              written by the plugin itself, with your own embedder and
 *              extraction LLM (lib/native-client.js). No Python, no Qdrant.
 *
 * `backend: auto` picks platform when an API key is configured (in the
 * settings, in DSH credentials under `apiKeyEnv`, or in the `apiKeyEnv`
 * environment variable), server when a non-default baseUrl is configured,
 * and the local backend when `~/.dsh/mem0/oss.json` or the memory store
 * exists. Because an inherited `MEM0_API_KEY` alone selects the cloud
 * Platform, the resolved config records why a backend was chosen
 * (`backendSource`) so status output can show it.
 *
 * Local settings (embedder, LLM, store path, credential names) may live in
 * the profile or in the `dsh_mem0` block of oss.json (lib/oss-config.js),
 * which DSH's settings sync never rewrites.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_OSS_CONFIG,
  DEPRECATED_FIELDS,
  ossDeprecatedFields,
  ossFallbacks,
  publicNativeSettings,
  qdrantMode,
  readOssConfig,
  resolveNativeSettings,
} from './oss-config.js'

export const DEFAULT_PLATFORM_BASE_URL = 'https://api.mem0.ai'
export const DEFAULT_SERVER_BASE_URL = 'http://127.0.0.1:8888'
/** The local backend's settings file (always this path). */
export const DEFAULT_MEM0_CONFIG = DEFAULT_OSS_CONFIG
export { DEFAULT_STORE_PATH } from './oss-config.js'

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
  // Local backend (oss). Empty means "from oss.json, else the default".
  storePath: z.string().default(''),
  embedderProvider: z.string().default(''),
  embedderBaseUrl: z.string().default(''),
  embedderModel: z.string().default(''),
  embedderDims: z.number().min(0).max(65536).default(0),
  embedderApiKeyRef: z.string().default(''),
  llmBaseUrl: z.string().default(''),
  llmModel: z.string().default(''),
  llmApiKeyRef: z.string().default(''),
  llmMaxTokens: z.number().min(256).max(65536).default(8000),
  llmTemperature: z.number().min(0).max(2).default(0),
  llmReasoningEffort: z.string().default(''),
  // The Qdrant collection of earlier versions; read only by the migration.
  collectionName: z.string().default('dsh_mem0'),
  userId: z.string().default('dsh-user'),
  agentId: z.string().default('dsh'),
  autoRecall: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
  includeSubagents: z.boolean().default(false),
  captureMaxChars: z.number().min(50).max(4000).default(450),
  recallTopK: z.number().min(1).max(20).default(5),
  timeoutMs: z.number().min(1).max(300000).default(30000),
  recallTimeoutMs: z.number().min(100).max(60000).default(5000),
  addTimeoutMs: z.number().min(1000).max(600000).default(120000),
  captureFilter: z.union([z.const('off'), z.const('heuristic')]).default('heuristic'),
  profileEnabled: z.boolean().default(true),
  profileBudgetTokens: z.number().min(128).max(8000).default(1375),
  memoryBudgetTokens: z.number().min(128).max(20000).default(2200),
  // Above this many memories hygiene warns; it never deletes for size.
  storeSafetyLimit: z.number().min(1000).max(1000000).default(20000),
  hygieneEnabled: z.boolean().default(true),
  // Hygiene asks DSH's current model (billed to that provider); off = script checks only.
  modelHygiene: z.boolean().default(true),
  // Recall weight of the importance hygiene assigns (0 = off).
  importanceWeight: z.number().min(0).max(1).default(0.2),
  // Recall weight of the current project's (and session's) memories against global ones.
  projectRecallBoost: z.number().min(1).max(2).default(1.1),
  hygieneIntervalDays: z.number().min(1).max(90).default(7),
  translateMemories: z.boolean().default(false),
  captureStrataFolds: z.boolean().default(false),
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
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

function nonEmpty(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function normalizeUrl(value, fallback) {
  const url = nonEmpty(value, fallback)
  return url.replace(/\/+$/, '')
}

/** Values Config fills in for a field the profile does not set. */
const SCHEMA_DEFAULTS = Object.freeze({
  collectionName: 'dsh_mem0',
  userId: 'dsh-user',
  agentId: 'dsh',
  translateMemories: false,
  captureStrataFolds: false,
  storePath: '',
  embedderProvider: '',
  embedderBaseUrl: '',
  embedderModel: '',
  embedderDims: 0,
  embedderApiKeyRef: '',
  llmBaseUrl: '',
  llmModel: '',
  llmApiKeyRef: '',
  llmMaxTokens: 8000,
  llmTemperature: 0,
  llmReasoningEffort: '',
})

/**
 * Plugin settings that live in the profile but break the local setup, or
 * change what is stored, when DSH's settings sync drops them. Watched by
 * lib/config-guard.js.
 */
export const KEY_FIELDS = Object.freeze(['backend', ...Object.keys(SCHEMA_DEFAULTS)])

/**
 * Key fields of earlier versions that no longer exist (the Python sidecar
 * is gone). lib/config-guard.js drops them from an old fingerprint instead
 * of reporting them missing.
 */
export const RETIRED_KEY_FIELDS = Object.freeze(['pythonPath', 'mem0ConfigPath', 'historyDbPath'])

/**
 * Whether the profile sets `key` to something other than what Config fills
 * in (DSH hands the plugin schema-filled values, so "equal to the default"
 * is "not set").
 */
export function isFieldSet(value, key) {
  const field = value?.[key]
  if (key === 'backend') return typeof field === 'string' && field !== '' && field !== 'auto'
  if (!(key in SCHEMA_DEFAULTS)) return field !== undefined
  const fallback = SCHEMA_DEFAULTS[key]
  if (typeof fallback === 'boolean') return typeof field === 'boolean' && field !== fallback
  if (typeof fallback === 'number') return typeof field === 'number' && Number.isFinite(field) && field !== fallback
  return typeof field === 'string' && field.trim() !== '' && field.trim() !== fallback
}

/**
 * The profile config with the `dsh_mem0` block of oss.json filled in for
 * fields the profile does not set. Returns the merged values and which
 * fields came from oss.json.
 */
function withOssFallbacks(value, raw) {
  const fallbacks = ossFallbacks(raw)
  const merged = { ...value }
  const fromOss = []
  for (const [key, fallback] of Object.entries(fallbacks)) {
    if (isFieldSet(value, key)) continue
    merged[key] = fallback
    fromOss.push(key)
  }
  return { merged, fromOss }
}

function integerIn(value, fallback, min, max, name) {
  const number = Number(value ?? fallback)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`dsh-mem0: ${name} must be an integer in [${min}, ${max}]`)
  }
  return number
}

/**
 * Normalize a raw loader config into the values consumed by the plugin.
 * @param {object|undefined} raw
 * @param {object} [options]
 * @param {{ value: string, source: string }} [options.credential] DSH credential hit for `apiKeyEnv`.
 * @param {string} [options.ossConfigPath] oss.json to read (tests); default `~/.dsh/mem0/oss.json`.
 * @returns {object}
 */
export function resolveConfig(raw = {}, { credential, ossConfigPath = DEFAULT_MEM0_CONFIG } = {}) {
  const unwrapped = unwrapConfig(raw)
  const profileValue = unwrapped && typeof unwrapped === 'object' ? unwrapped : {}
  // Plugin settings may also live in oss.json's `dsh_mem0` block, which
  // DSH's settings sync never rewrites; the profile wins when it sets one.
  const ossRaw = readOssConfig(ossConfigPath)
  const { merged: value, fromOss: settingsFromOss } = withOssFallbacks(profileValue, ossRaw)
  // Settings of the Python sidecar era: ignored, reported once at debug level.
  const ignoredSettings = [
    ...DEPRECATED_FIELDS.filter((key) => {
      const field = profileValue[key]
      return field !== undefined && field !== '' && !(Array.isArray(field) && field.length === 0)
    }),
    ...ossDeprecatedFields(ossRaw).map((key) => `dsh_mem0.${key}`),
  ]
  // Size limits of earlier versions: hygiene no longer deletes for size.
  const retiredLimits = ['storeMaxMemories', 'storeMaxTokens'].filter((key) => profileValue[key] !== undefined)
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
  const collectionName = nonEmpty(value.collectionName, 'dsh_mem0')
  if (!COLLECTION_RE.test(collectionName)) {
    throw new Error('dsh-mem0: collectionName must match ^[A-Za-z0-9_-]{1,64}$')
  }
  const userId = nonEmpty(value.userId, 'dsh-user')
  const agentId = nonEmpty(value.agentId, 'dsh')
  const captureMaxChars = integerIn(value.captureMaxChars, 450, 50, 4000, 'captureMaxChars')
  const recallTopK = integerIn(value.recallTopK, 5, 1, 20, 'recallTopK')
  const timeoutMs = integerIn(value.timeoutMs, 30000, 1, 300000, 'timeoutMs')
  const recallTimeoutMs = integerIn(value.recallTimeoutMs, 5000, 100, 60000, 'recallTimeoutMs')
  const addTimeoutMs = integerIn(value.addTimeoutMs, 120000, 1000, 600000, 'addTimeoutMs')
  const profileBudgetTokens = integerIn(value.profileBudgetTokens, 1375, 128, 8000, 'profileBudgetTokens')
  const memoryBudgetTokens = integerIn(value.memoryBudgetTokens, 2200, 128, 20000, 'memoryBudgetTokens')
  const storeSafetyLimit = integerIn(value.storeSafetyLimit, 20000, 1000, 1000000, 'storeSafetyLimit')
  const importanceWeight = Number(value.importanceWeight ?? 0.2)
  if (!Number.isFinite(importanceWeight) || importanceWeight < 0 || importanceWeight > 1) {
    throw new Error('dsh-mem0: importanceWeight must be a number in [0, 1]')
  }
  const projectRecallBoost = Number(value.projectRecallBoost ?? 1.1)
  if (!Number.isFinite(projectRecallBoost) || projectRecallBoost < 1 || projectRecallBoost > 2) {
    throw new Error('dsh-mem0: projectRecallBoost must be a number in [1, 2]')
  }
  const hygieneIntervalDays = integerIn(value.hygieneIntervalDays, 7, 1, 90, 'hygieneIntervalDays')

  // Local backend settings (embedder, LLM, store), resolved again by the
  // client whenever oss.json changes; this copy is for status and choice.
  // Only what the user set: DSH hands over schema-filled values, and a
  // filled-in default (llmMaxTokens 8000, llmTemperature 0) must not hide
  // max_tokens or temperature of a Mem0-format oss.json.
  const nativeValues = Object.fromEntries(Object.keys(SCHEMA_DEFAULTS).filter((key) => isFieldSet(value, key)).map((key) => [key, value[key]]))
  const native = resolveNativeSettings(nativeValues, ossRaw)

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
    } else if (fs.existsSync(ossConfigPath) || fs.existsSync(native.storePath)) {
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
  if (backend === 'oss') backendBaseUrl = ''

  return {
    backend,
    backendSource,
    apiKey,
    apiKeySource,
    apiKeyEnv,
    baseUrl: backendBaseUrl,
    authType: nonEmpty(value.authType, backend === 'platform' ? 'token' : 'apiKey'),
    settingsFromOss,
    // Settings of earlier versions found in the profile or oss.json; ignored.
    ignoredSettings,
    retiredLimits,
    // Which key fields the profile itself sets (lib/config-guard.js).
    profileFields: KEY_FIELDS.filter((key) => isFieldSet(profileValue, key)),
    ossConfigPath: path.resolve(expandHome(ossConfigPath)),
    // Plugin values the local client merges with oss.json again on change.
    nativeValues,
    // The Qdrant server of earlier versions, named in oss.json's oss block:
    // read for the upgrade notice only, never connected to.
    legacyQdrant: (() => {
      const mode = qdrantMode(ossRaw)
      return mode.mode === 'server' && mode.endpoint ? { endpoint: mode.endpoint, collection: mode.collection ?? collectionName } : null
    })(),
    native: publicNativeSettings(native),
    storePath: native.storePath,
    collectionName,
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
    captureFilter: value.captureFilter === 'off' ? 'off' : 'heuristic',
    profileEnabled: value.profileEnabled !== false,
    profileBudgetTokens,
    memoryBudgetTokens,
    storeSafetyLimit,
    hygieneEnabled: value.hygieneEnabled !== false,
    modelHygiene: value.modelHygiene !== false,
    importanceWeight,
    projectRecallBoost,
    hygieneIntervalDays,
    translateMemories: value.translateMemories === true,
    captureStrataFolds: value.captureStrataFolds === true,
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
      return 'auto: ~/.dsh/mem0/oss.json or the local memory store was found, so memories stay on this computer (SQLite).'
    case 'auto-default':
      return `auto: nothing else was configured, so the Mem0 Platform (${config.baseUrl || DEFAULT_PLATFORM_BASE_URL}) is used; it needs an API key.`
    default:
      return 'configured explicitly'
  }
}

export { expandHome }

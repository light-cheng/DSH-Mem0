/**
 * The local (OSS) backend's own settings file, `~/.dsh/mem0/oss.json`.
 *
 * It may hold two blocks:
 *
 * - `dsh_mem0`: plugin settings kept where DSH's settings sync cannot
 *   rewrite them (`OSS_FALLBACK_FIELDS`; a field the profile sets wins,
 *   see lib/config.js). This is where the embedder, the extraction LLM,
 *   the store path and the credential reference names go:
 *
 *       "dsh_mem0": {
 *         "embedderProvider": "openai" | "ollama",
 *         "embedderBaseUrl": "http://127.0.0.1:8000/v1",
 *         "embedderModel": "bge-m3",
 *         "embedderDims": 1024,                 // sent as `dimensions` only when set
 *         "embedderApiKeyRef": "DSH_MEM0_EMBEDDER_API_KEY",
 *         "llmBaseUrl": "https://api.deepseek.com",
 *         "llmModel": "deepseek-chat",
 *         "llmApiKeyRef": "DSH_MEM0_LLM_API_KEY",
 *         "llmMaxTokens": 8000, "llmTemperature": 0, "llmReasoningEffort": "low",
 *         "storePath": "~/.dsh/mem0/memory.sqlite"
 *       }
 *
 *   `*ApiKeyRef` names a key in DSH's credential store (lib/credentials.js);
 *   the key itself is never written here.
 *
 * - `oss`: a Mem0 OSS config (`llm`, `embedder`, `vector_store` blocks), the
 *   format earlier versions used. Its `embedder` and `llm` blocks still fill
 *   in what `dsh_mem0` leaves out, including a literal `api_key`, so an
 *   existing file keeps working. Its `vector_store` (Qdrant) block is read
 *   only by the one-time migration: `qdrantMode()` and `hostPort()` tell
 *   whether and where a Qdrant server was configured.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DEFAULT_STORE_PATH } from './store-sqlite.js'

export const QDRANT_DOCS_URL = 'https://github.com/light-cheng/DSH-Mem0#migrating-from-qdrant'
export const WINDOWS_DOCS_URL = 'https://github.com/light-cheng/DSH-Mem0#windows-troubleshooting'
export const DEFAULT_OSS_CONFIG = path.join(os.homedir(), '.dsh', 'mem0', 'oss.json')
export { DEFAULT_STORE_PATH }
/** @deprecated The embedded-Qdrant check moved to the migration (lib/oss-config.js qdrantMode). */
export const EMBEDDED_QDRANT_CODE = 'QDRANT_EMBEDDED_UNSUPPORTED'
/** The store holds vectors of another embedder (model or dimension). */
export const EMBEDDER_MISMATCH_CODE = 'EMBEDDER_MISMATCH'
/** Error codes that mean "the config is wrong": retrying without a change cannot help. */
export const CONFIG_ERROR_CODES = Object.freeze([EMBEDDED_QDRANT_CODE, 'CONFIG_INVALID', 'CONFIG_MISSING', EMBEDDER_MISMATCH_CODE, 'schema_newer'])

/** Whether an error is a config error that retrying cannot fix. */
export function isConfigError(error) {
  return Boolean(error && (error.configError === true || CONFIG_ERROR_CODES.includes(error.code)))
}

/** Plugin settings the `dsh_mem0` block of oss.json may hold, with their type. */
export const OSS_FALLBACK_FIELDS = Object.freeze({
  collectionName: 'string',
  userId: 'string',
  agentId: 'string',
  translateMemories: 'boolean',
  captureStrataFolds: 'boolean',
  storePath: 'string',
  embedderProvider: 'string',
  embedderBaseUrl: 'string',
  embedderModel: 'string',
  embedderDims: 'number',
  embedderApiKeyRef: 'string',
  llmProvider: 'string',
  llmBaseUrl: 'string',
  llmModel: 'string',
  llmApiKeyRef: 'string',
  llmMaxTokens: 'number',
  llmTemperature: 'number',
  llmReasoningEffort: 'string',
})

/**
 * Settings of earlier versions that no longer do anything (the Python
 * sidecar is gone). Ignored with a debug line, never an error.
 */
export const DEPRECATED_FIELDS = Object.freeze(['pythonPath', 'mem0ConfigPath', 'historyDbPath', 'sidecarEnv'])

/**
 * `host:port` of a URL or a bare `host:port`; no scheme, path, query or
 * user info. Undefined when nothing usable is there.
 */
export function hostPort(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const text = value.trim()
  try {
    const url = new URL(text.includes('://') ? text : `http://${text}`)
    if (!url.hostname) return undefined
    return url.port ? `${url.hostname}:${url.port}` : url.hostname
  } catch {
    return undefined
  }
}

const ENDPOINT_KEYS = ['ollama_base_url', 'openai_base_url', 'base_url', 'url', 'api_base', 'lmstudio_base_url', 'vllm_base_url', 'deepseek_base_url']

/** host:port of one provider block (`{provider, config}`). */
export function blockEndpoint(block) {
  const config = block && typeof block.config === 'object' && block.config ? block.config : {}
  for (const key of ENDPOINT_KEYS) {
    const endpoint = hostPort(config[key])
    if (endpoint) return endpoint
  }
  if (typeof config.host === 'string' && config.host) {
    return config.port ? `${config.host}:${config.port}` : config.host
  }
  return undefined
}

/**
 * Migration only: the Qdrant mode of a parsed oss.json: `server` (url, or
 * host and port), `embedded` (anything else with provider qdrant), `other`
 * (another vector store), or `unknown` (no oss.vector_store block).
 */
export function qdrantMode(raw) {
  const block = raw?.oss?.vector_store
  if (!block || typeof block !== 'object') return { mode: 'unknown' }
  const provider = typeof block.provider === 'string' && block.provider ? block.provider : 'qdrant'
  if (provider.toLowerCase() !== 'qdrant') return { mode: 'other', provider }
  const config = block.config && typeof block.config === 'object' ? block.config : {}
  const url = typeof config.url === 'string' && config.url.trim() ? config.url.trim() : ''
  const host = typeof config.host === 'string' && config.host.trim() ? config.host.trim() : ''
  const hasPath = typeof config.path === 'string' && config.path.trim() !== ''
  const collection = typeof config.collection_name === 'string' && config.collection_name.trim() ? config.collection_name.trim() : undefined
  // Mem0 uses host only together with a port; a host alone falls back to
  // an embedded store at its default path.
  if (url || (host && config.port)) {
    return { mode: 'server', provider, endpoint: blockEndpoint(block), pathIgnored: hasPath, ...(collection ? { collection } : {}) }
  }
  return { mode: 'embedded', provider, hasPath }
}

export class OssConfigError extends Error {
  constructor(message, { code = 'CONFIG_INVALID', component = 'embedder', cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'OssConfigError'
    this.code = code
    this.component = component
    this.configError = true
  }
}

/**
 * Key of the object readOssConfig returns for a file that exists but is not
 * valid JSON: `{ [OSS_CONFIG_INVALID]: message }` (line and column only, no
 * text of the file, which may hold keys).
 */
export const OSS_CONFIG_INVALID = Symbol('dsh-mem0.ossConfigInvalid')

function jsonErrorWhere(text, error) {
  const message = String(error?.message ?? '')
  const lineColumn = message.match(/line (\d+) column (\d+)/)
  if (lineColumn) return `line ${lineColumn[1]}, column ${lineColumn[2]}`
  const position = message.match(/position (\d+)/)
  if (position) {
    const before = text.slice(0, Number(position[1]))
    const line = before.split('\n').length
    return `line ${line}, column ${before.length - before.lastIndexOf('\n')}`
  }
  return 'unexpected end or bad syntax'
}

/**
 * Parsed oss.json; undefined when the file does not exist or cannot be
 * read; `{ [OSS_CONFIG_INVALID]: message }` when it is not valid JSON.
 */
export function readOssConfig(filePath) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    return { [OSS_CONFIG_INVALID]: `${path.basename(filePath)} is not valid JSON (${jsonErrorWhere(text, error)}); fix the file, nothing in it is used until then` }
  }
}

/**
 * Fingerprint of the config file's bytes, so settings are re-read (and a
 * config error retried) only when the file changes. `missing` when it
 * cannot be read.
 */
export function fileFingerprint(filePath) {
  try {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 16)
  } catch {
    return 'missing'
  }
}

/** Endpoints of the components, for messages: `{ vector_store, embedder, llm }`. */
export function ossEndpoints(raw) {
  const oss = raw?.oss
  if (!oss || typeof oss !== 'object') return {}
  const out = {}
  for (const [component, section] of [['vector_store', 'vector_store'], ['embedder', 'embedder'], ['llm', 'llm']]) {
    const block = oss[section]
    if (!block || typeof block !== 'object') continue
    out[component] = { provider: typeof block.provider === 'string' ? block.provider : 'unknown', endpoint: blockEndpoint(block) }
  }
  return out
}

/**
 * The valid fields of the `dsh_mem0` block (plugin settings kept in
 * oss.json). Unknown keys and wrong types are dropped; deprecated keys are
 * listed in `ignored` (see DEPRECATED_FIELDS).
 */
export function ossFallbacks(raw) {
  const block = raw?.dsh_mem0
  if (!block || typeof block !== 'object' || Array.isArray(block)) return {}
  const out = {}
  for (const [key, type] of Object.entries(OSS_FALLBACK_FIELDS)) {
    const value = block[key]
    if (type === 'string' && typeof value === 'string' && value.trim()) out[key] = value.trim()
    if (type === 'boolean' && typeof value === 'boolean') out[key] = value
    if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

/** Deprecated keys present in the `dsh_mem0` block (for one debug line). */
export function ossDeprecatedFields(raw) {
  const block = raw?.dsh_mem0
  if (!block || typeof block !== 'object' || Array.isArray(block)) return []
  return DEPRECATED_FIELDS.filter((key) => key in block)
}

function expandHome(value) {
  if (typeof value !== 'string') return value
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// Mem0 OSS provider names → our two embedder adapters and their default URLs.
const MEM0_EMBEDDERS = {
  openai: { provider: 'openai', urlKey: 'openai_base_url', defaultUrl: 'https://api.openai.com/v1' },
  lmstudio: { provider: 'openai', urlKey: 'lmstudio_base_url', defaultUrl: 'http://localhost:1234/v1' },
  ollama: { provider: 'ollama', urlKey: 'ollama_base_url', defaultUrl: 'http://localhost:11434' },
}
// Mem0 OSS LLM providers that speak the OpenAI chat completions API.
const MEM0_LLMS = {
  openai: { urlKey: 'openai_base_url', defaultUrl: 'https://api.openai.com/v1' },
  deepseek: { urlKey: 'deepseek_base_url', defaultUrl: 'https://api.deepseek.com' },
  lmstudio: { urlKey: 'lmstudio_base_url', defaultUrl: 'http://localhost:1234/v1' },
  vllm: { urlKey: 'vllm_base_url', defaultUrl: 'http://localhost:8000/v1' },
  ollama: { urlKey: 'ollama_base_url', defaultUrl: 'http://localhost:11434', suffix: '/v1' },
}

function mem0Embedder(raw) {
  const block = raw?.oss?.embedder
  if (!block || typeof block !== 'object') return {}
  const name = text(block.provider).toLowerCase() || 'openai'
  const config = block.config && typeof block.config === 'object' ? block.config : {}
  const known = MEM0_EMBEDDERS[name]
  if (!known) return { unsupported: name }
  return {
    provider: known.provider,
    baseUrl: text(config[known.urlKey]) || text(config.base_url) || known.defaultUrl,
    model: text(config.model),
    dims: Number.isInteger(config.embedding_dims) && config.embedding_dims > 0 ? config.embedding_dims : undefined,
    apiKey: text(config.api_key),
  }
}

function mem0Llm(raw) {
  const block = raw?.oss?.llm
  if (!block || typeof block !== 'object') return {}
  const name = text(block.provider).toLowerCase() || 'openai'
  const config = block.config && typeof block.config === 'object' ? block.config : {}
  const known = MEM0_LLMS[name]
  if (!known) return { unsupported: name }
  const base = text(config[known.urlKey]) || text(config.base_url) || known.defaultUrl
  return {
    baseUrl: known.suffix && !base.replace(/\/+$/, '').endsWith(known.suffix) ? `${base.replace(/\/+$/, '')}${known.suffix}` : base,
    model: text(config.model),
    apiKey: text(config.api_key),
    maxTokens: Number.isInteger(config.max_tokens) && config.max_tokens > 0 ? config.max_tokens : undefined,
    temperature: number(config.temperature),
    topP: number(config.top_p),
    reasoningEffort: text(config.reasoning_effort),
  }
}

const REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The local backend's settings: plugin values (profile, then `dsh_mem0`)
 * first, the Mem0-format `oss` block second, defaults last.
 *
 * Returns `{ storePath, embedder, llm, problems }` where embedder is
 * `{ provider, baseUrl, model, dims, apiKeyRef, apiKey, source }`, llm is
 * `{ baseUrl, model, apiKeyRef, apiKey, maxTokens, temperature, topP,
 * reasoningEffort, source }`, and problems lists config errors
 * (`{ component, code, message }`). `apiKey` is a literal key from the
 * `oss` block: keep it out of logs and status.
 * @param {object} values merged plugin settings (lib/config.js).
 * @param {object|undefined} raw parsed oss.json.
 */
export function resolveNativeSettings(values = {}, raw) {
  const problems = []
  // A broken file first: "no embedder configured" would send the user
  // looking for a missing field.
  if (raw?.[OSS_CONFIG_INVALID]) {
    for (const component of ['embedder', 'llm']) problems.push({ component, code: 'CONFIG_INVALID', message: raw[OSS_CONFIG_INVALID] })
  }
  const fileEmbedder = mem0Embedder(raw)
  const fileLlm = mem0Llm(raw)
  const providerSetting = text(values.embedderProvider).toLowerCase()
  if (providerSetting && providerSetting !== 'openai' && providerSetting !== 'ollama') {
    problems.push({ component: 'embedder', code: 'CONFIG_INVALID', message: `embedderProvider must be "openai" (any OpenAI-compatible server) or "ollama", not ${JSON.stringify(providerSetting)}` })
  }
  const pluginEmbedder = Boolean(text(values.embedderModel) || text(values.embedderBaseUrl))
  if (fileEmbedder.unsupported && !pluginEmbedder) {
    problems.push({ component: 'embedder', code: 'CONFIG_INVALID', message: `embedder provider ${JSON.stringify(fileEmbedder.unsupported)} in oss.json is not supported; use an OpenAI-compatible server or Ollama (dsh_mem0.embedderProvider)` })
  }
  const provider = providerSetting === 'ollama' || providerSetting === 'openai'
    ? providerSetting
    : fileEmbedder.provider ?? 'openai'
  const embedder = {
    provider,
    baseUrl: (text(values.embedderBaseUrl) || (fileEmbedder.provider === provider ? fileEmbedder.baseUrl : '') || (provider === 'ollama' ? 'http://localhost:11434' : '')).replace(/\/+$/, ''),
    model: text(values.embedderModel) || (fileEmbedder.provider === provider ? fileEmbedder.model : '') || '',
    dims: Number.isInteger(values.embedderDims) && values.embedderDims > 0 ? values.embedderDims : fileEmbedder.dims,
    apiKeyRef: text(values.embedderApiKeyRef),
    // oss.json's literal key goes only to oss.json's own server: never to a
    // baseUrl set in dsh_mem0 or the profile, nor next to a credential ref.
    apiKey: !text(values.embedderBaseUrl) && !text(values.embedderApiKeyRef) && fileEmbedder.provider === provider ? fileEmbedder.apiKey ?? '' : '',
    source: pluginEmbedder ? 'dsh_mem0' : fileEmbedder.model ? 'oss' : 'none',
  }
  if (embedder.apiKeyRef && !REF_RE.test(embedder.apiKeyRef)) {
    problems.push({ component: 'embedder', code: 'CONFIG_INVALID', message: 'embedderApiKeyRef must be a credential name (letters, digits, _)' })
  }
  const invalidFile = Boolean(raw?.[OSS_CONFIG_INVALID])
  if (!invalidFile && (!embedder.model || !embedder.baseUrl)) {
    problems.push({
      component: 'embedder',
      code: 'CONFIG_MISSING',
      message: 'No embedder is configured: set embedderBaseUrl and embedderModel (and embedderApiKeyRef for a cloud API) in the "dsh_mem0" block of ~/.dsh/mem0/oss.json',
    })
  }
  const llmProvider = text(values.llmProvider).toLowerCase()
  if (llmProvider && llmProvider !== 'dsh' && llmProvider !== 'openai') {
    problems.push({ component: 'llm', code: 'CONFIG_INVALID', message: `llmProvider must be "dsh" (DSH's current model) or "openai" (an OpenAI-compatible endpoint), not ${JSON.stringify(llmProvider)}` })
  }
  const pluginLlm = Boolean(text(values.llmModel) || text(values.llmBaseUrl))
  if (fileLlm.unsupported && !pluginLlm) {
    problems.push({ component: 'llm', code: 'CONFIG_INVALID', message: `LLM provider ${JSON.stringify(fileLlm.unsupported)} in oss.json is not supported; use an OpenAI-compatible endpoint (dsh_mem0.llmBaseUrl)` })
  }
  // DSH's current model: read live per call (lib/dsh-llm.js); DSH holds
  // the provider, address and key, so none of them is set or needed here.
  if (llmProvider === 'dsh') {
    const llm = {
      provider: 'dsh',
      baseUrl: '',
      model: '',
      apiKeyRef: '',
      apiKey: '',
      maxTokens: Number.isInteger(values.llmMaxTokens) && values.llmMaxTokens > 0 ? values.llmMaxTokens : 8000,
      maxTokensSource: Number.isInteger(values.llmMaxTokens) && values.llmMaxTokens > 0 ? 'plugin' : 'default',
      temperature: number(values.llmTemperature) ?? 0,
      topP: 0.1,
      reasoningEffort: '',
      source: 'dsh_mem0',
    }
    const storePath = path.resolve(expandHome(text(values.storePath) || DEFAULT_STORE_PATH))
    return { storePath, embedder, llm, problems }
  }
  const llm = {
    baseUrl: (text(values.llmBaseUrl) || fileLlm.baseUrl || '').replace(/\/+$/, ''),
    model: text(values.llmModel) || fileLlm.model || '',
    apiKeyRef: text(values.llmApiKeyRef),
    apiKey: !text(values.llmBaseUrl) && !text(values.llmApiKeyRef) ? fileLlm.apiKey ?? '' : '',
    maxTokens: Number.isInteger(values.llmMaxTokens) && values.llmMaxTokens > 0 ? values.llmMaxTokens : fileLlm.maxTokens ?? 8000,
    // Where max_tokens came from, for mem0_status: the plugin's
    // llmMaxTokens, oss.json's Mem0-format llm.config.max_tokens, or 8000.
    maxTokensSource: Number.isInteger(values.llmMaxTokens) && values.llmMaxTokens > 0 ? 'plugin' : fileLlm.maxTokens ? 'oss.json' : 'default',
    temperature: number(values.llmTemperature) ?? fileLlm.temperature ?? 0,
    topP: fileLlm.topP ?? 0.1,
    reasoningEffort: text(values.llmReasoningEffort) || fileLlm.reasoningEffort || '',
    source: pluginLlm ? 'dsh_mem0' : fileLlm.model ? 'oss' : 'none',
  }
  if (llm.apiKeyRef && !REF_RE.test(llm.apiKeyRef)) {
    problems.push({ component: 'llm', code: 'CONFIG_INVALID', message: 'llmApiKeyRef must be a credential name (letters, digits, _)' })
  }
  if (llm.reasoningEffort && !/^[a-z]{1,12}$/.test(llm.reasoningEffort)) {
    problems.push({ component: 'llm', code: 'CONFIG_INVALID', message: 'llmReasoningEffort must be a short lowercase word such as "low"' })
  }
  if (!invalidFile && (!llm.model || !llm.baseUrl)) {
    problems.push({
      component: 'llm',
      code: 'CONFIG_MISSING',
      message: 'No extraction LLM is configured: set llmBaseUrl and llmModel (and llmApiKeyRef) in the "dsh_mem0" block of ~/.dsh/mem0/oss.json; memories can still be stored verbatim (infer: false)',
    })
  }
  const storePath = path.resolve(expandHome(text(values.storePath) || DEFAULT_STORE_PATH))
  return { storePath, embedder, llm, problems }
}

/** The settings without literal keys, for config and status. */
export function publicNativeSettings(settings) {
  if (!settings) return undefined
  const { apiKey: embedderKey, ...embedder } = settings.embedder ?? {}
  const { apiKey: llmKey, ...llm } = settings.llm ?? {}
  return {
    storePath: settings.storePath,
    embedder: { ...embedder, literalKey: Boolean(embedderKey) },
    llm: { ...llm, literalKey: Boolean(llmKey) },
    problems: (settings.problems ?? []).map((problem) => ({ ...problem })),
  }
}

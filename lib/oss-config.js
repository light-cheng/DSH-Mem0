/**
 * What the plugin reads from the Mem0 OSS config file (`oss.json`) itself,
 * before any Python starts:
 *
 * - the Qdrant mode check: only a Qdrant *server* (`url`, or `host` and
 *   `port`) is supported. Embedded Qdrant (`vector_store.config.path`) is
 *   not: the sidecar's read and write Memory instances would each open the
 *   same local folder, and embedded Qdrant locks it exclusively (issue #23);
 * - the host:port of Qdrant and of the embedder, for error messages
 *   (scheme, path and credentials are dropped);
 * - the optional `dsh_mem0` block: plugin settings kept next to the Mem0
 *   config, where DSH's settings sync cannot rewrite them (see
 *   `OSS_FALLBACK_FIELDS` and lib/config.js).
 *
 * The python sidecar repeats the Qdrant check in `build_memory_config`.
 */
import fs from 'node:fs'
import { createHash } from 'node:crypto'

export const QDRANT_DOCS_URL = 'https://github.com/light-cheng/DSH-Mem0#qdrant-server-only'
export const WINDOWS_DOCS_URL = 'https://github.com/light-cheng/DSH-Mem0#windows-troubleshooting'
export const EMBEDDED_QDRANT_CODE = 'QDRANT_EMBEDDED_UNSUPPORTED'
/** Error codes that mean "the config is wrong": retrying without a change cannot help. */
export const CONFIG_ERROR_CODES = Object.freeze([EMBEDDED_QDRANT_CODE, 'CONFIG_INVALID', 'CONFIG_MISSING'])

export const EMBEDDED_QDRANT_MESSAGE =
  'Embedded Qdrant (vector_store.config.path) is not supported. Start a Qdrant server and set vector_store.config.url in oss.json. ' +
  '不支持嵌入式 Qdrant，请启动 Qdrant 服务端并在 oss.json 里用 url。' +
  ` See ${QDRANT_DOCS_URL}`

/** Plugin settings the `dsh_mem0` block of oss.json may hold. */
export const OSS_FALLBACK_FIELDS = Object.freeze({
  pythonPath: 'string',
  collectionName: 'string',
  userId: 'string',
  agentId: 'string',
  historyDbPath: 'string',
  translateMemories: 'boolean',
  captureStrataFolds: 'boolean',
})

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
    // No default port is invented: qdrant-client, for one, uses 6333 for a
    // URL without a port.
    return url.port ? `${url.hostname}:${url.port}` : url.hostname
  } catch {
    return undefined
  }
}

const ENDPOINT_KEYS = ['ollama_base_url', 'openai_base_url', 'base_url', 'url', 'api_base', 'lmstudio_base_url', 'vllm_base_url']

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
 * The Qdrant mode of a parsed oss.json: `server` (url, or host and port),
 * `embedded` (anything else with provider qdrant), `other` (another vector
 * store), or `unknown` (no oss.vector_store block; the sidecar reports that).
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
  // Mem0 uses host only together with a port; a host alone falls back to
  // an embedded store at its default path.
  if (url || (host && config.port)) {
    return { mode: 'server', provider, endpoint: blockEndpoint(block), pathIgnored: hasPath }
  }
  return { mode: 'embedded', provider, hasPath }
}

export class OssConfigError extends Error {
  constructor(message, { code = 'CONFIG_INVALID', component = 'vector_store', cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'OssConfigError'
    this.code = code
    this.component = component
    this.configError = true
  }
}

/** Parsed oss.json, or undefined when it cannot be read or parsed. */
export function readOssConfig(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Throws OssConfigError for a config the plugin does not support (embedded
 * Qdrant). A file that cannot be parsed is left to the sidecar, which
 * reports the JSON error itself. Returns the Qdrant mode otherwise.
 */
export function checkOssConfig(raw) {
  const mode = qdrantMode(raw)
  if (mode.mode === 'embedded') throw new OssConfigError(EMBEDDED_QDRANT_MESSAGE, { code: EMBEDDED_QDRANT_CODE })
  return mode
}

/**
 * Fingerprint of the config file's bytes, so a config error is not retried
 * until the file changes. `missing` when it cannot be read.
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
 * oss.json). Unknown keys and wrong types are dropped.
 */
export function ossFallbacks(raw) {
  const block = raw?.dsh_mem0
  if (!block || typeof block !== 'object' || Array.isArray(block)) return {}
  const out = {}
  for (const [key, type] of Object.entries(OSS_FALLBACK_FIELDS)) {
    const value = block[key]
    if (type === 'string' && typeof value === 'string' && value.trim()) out[key] = value.trim()
    if (type === 'boolean' && typeof value === 'boolean') out[key] = value
  }
  return out
}

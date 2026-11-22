/**
 * The local backend's setup wizard, server side (the settings page drives
 * it through lib/gui-routes.js):
 *
 *   1. embedder: a cloud API first (OpenAI-compatible: URL, model, key), or
 *      a local server found on 127.0.0.1 (Ollama 11434/15434, LM Studio
 *      1234, oMLX 8000 on macOS only); one test embedding gives the
 *      dimension;
 *   2. extraction LLM: one test extraction with Mem0's prompt and a fixed
 *      sample, with output-budget advice (PR #22);
 *   3. store: where the SQLite file lives, checked writable and not on a
 *      network or sync drive;
 *   4. self-test: a probe memory (infer: false) for the test user
 *      `dsh-mem0-wizard-selftest` is written, found, deleted, and nothing of
 *      that user is left. Only then is anything saved.
 *
 * Saving stores typed keys in DSH credentials only (`*ApiKeyRef` names in
 * oss.json) and writes the `dsh_mem0` block of oss.json (a backup of the
 * previous file first; the `oss` block is kept as it is).
 *
 * Probes connect only to 127.0.0.1. An address the user types is contacted
 * only when the user presses a test button. Nothing here reads `~/.hermes`.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildExtractionMessages, describeStats, inspectExtraction, parseMessages } from './extraction.js'
import { Mem0NativeClient } from './native-client.js'
import { DEFAULT_OSS_CONFIG, OSS_CONFIG_INVALID, OSS_FALLBACK_FIELDS, WINDOWS_DOCS_URL, hostPort, readOssConfig, resolveNativeSettings } from './oss-config.js'
import { chatCompletion, embedTexts } from './providers.js'
import { redactSecrets } from './redact.js'
import { DEFAULT_STORE_PATH, displayPath } from './store-sqlite.js'

/** The only user id the self-test writes, finds and deletes. */
export const SELFTEST_USER_ID = 'dsh-mem0-wizard-selftest'
export const SELFTEST_AGENT_ID = 'dsh-mem0-wizard'
export const DEFAULT_EMBEDDER_KEY_REF = 'DSH_MEM0_EMBEDDER_API_KEY'
export const DEFAULT_LLM_KEY_REF = 'DSH_MEM0_LLM_API_KEY'
const REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const PROBE_TIMEOUT_MS = 1_500

/**
 * Cloud embedding APIs the wizard suggests first (OpenAI-compatible).
 * `dims` is the model's native size; the test call confirms it.
 */
export const CLOUD_EMBEDDERS = Object.freeze([
  { id: 'openai-small', label: 'OpenAI text-embedding-3-small', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', dims: 1536 },
  { id: 'openai-large', label: 'OpenAI text-embedding-3-large', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-large', dims: 3072 },
  { id: 'siliconflow-bge-m3', label: 'SiliconFlow BAAI/bge-m3', baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3', dims: 1024 },
  { id: 'dashscope-v3', label: 'Alibaba Cloud text-embedding-v3', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v3', dims: 1024 },
])

/** Local embedding models worth suggesting, with their usual dimension. */
export const LOCAL_EMBEDDING_MODELS = Object.freeze([
  { model: 'bge-m3', dims: 1024, note: 'multilingual (Chinese and English), recommended' },
  { model: 'qwen3-embedding:0.6b', dims: 1024, note: 'multilingual, small' },
  { model: 'nomic-embed-text', dims: 768, note: 'English, small' },
  { model: 'mxbai-embed-large', dims: 1024, note: 'English' },
])

/**
 * Local servers to probe on this platform. oMLX runs on Apple Silicon
 * only, so port 8000 is probed on macOS alone.
 */
export function localServiceCandidates(platform = process.platform) {
  const list = [
    { id: 'ollama', label: 'Ollama', provider: 'ollama', port: 11434, baseUrl: 'http://127.0.0.1:11434', listPath: '/api/tags' },
    { id: 'ollama-15434', label: 'Ollama', provider: 'ollama', port: 15434, baseUrl: 'http://127.0.0.1:15434', listPath: '/api/tags' },
    { id: 'lmstudio', label: 'LM Studio', provider: 'openai', port: 1234, baseUrl: 'http://127.0.0.1:1234/v1', listPath: '/models' },
  ]
  if (platform === 'darwin') {
    list.push({ id: 'omlx', label: 'oMLX', provider: 'openai', port: 8000, baseUrl: 'http://127.0.0.1:8000/v1', listPath: '/models' })
  }
  return list
}

const EMBEDDING_NAME_RE = /embed|bge|\be5\b|e5-|gte|minilm|nomic|mxbai|jina|arctic|snowflake/i

/** Whether a model name looks like an embedding model. */
export function isLikelyEmbeddingModel(name) {
  return EMBEDDING_NAME_RE.test(String(name ?? ''))
}

function errorChain(error) {
  const out = []
  for (let current = error, depth = 0; current && depth < 6; current = current.cause, depth += 1) {
    out.push(current)
    if (Array.isArray(current.errors)) out.push(...current.errors)
  }
  return out
}

/** Whether an error says the port is in a reserved range (Windows 10013). */
export function isReservedPortError(error) {
  return errorChain(error).some((item) => /10013|access a socket in a way forbidden|WSAEACCES/i.test(String(item?.message ?? '')) || item?.errno === 10013 || item?.errno === -4092)
}

function isRefused(error) {
  return errorChain(error).some((item) => item?.code === 'ECONNREFUSED' || /ECONNREFUSED|10061/.test(String(item?.message ?? '')))
}

/**
 * The hint for a Windows port problem: a service whose port lies in a range
 * Windows reserved (Hyper-V, WSL, Docker) cannot listen there (os error
 * 10013), so it looks "refused" to us. The command is PowerShell.
 */
export function reservedPortHint(platform = process.platform) {
  if (platform !== 'win32') return undefined
  return {
    code: 'WINDOWS_RESERVED_PORT',
    command: 'netsh int ipv4 show excludedportrange protocol=tcp',
    docs: WINDOWS_DOCS_URL,
  }
}

async function getJson(url, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS, apiKey } = {}) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = undefined
  }
  return { status: response.status, ok: response.ok, body, text }
}

const LOCAL_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])$/i

/**
 * The local service an address points to on this platform, by its port
 * (`oMLX` on 8000 only on macOS), or null for any other address.
 */
export function serviceAt(baseUrl, platform = process.platform) {
  let url
  try {
    url = new URL(String(baseUrl ?? ''))
  } catch {
    return null
  }
  if (!LOCAL_HOST_RE.test(url.hostname)) return null
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  return localServiceCandidates(platform).find((item) => item.port === port) ?? null
}

/** The error text an answer carries (OpenAI `error.message`, Ollama `error`, or the body's first line). */
export function answerDetail(body, text) {
  const value = typeof body?.error === 'string'
    ? body.error
    : typeof body?.error?.message === 'string'
      ? body.error.message
      : typeof body?.message === 'string'
        ? body.message
        : typeof body?.detail === 'string'
          ? body.detail
          : body === undefined ? String(text ?? '') : ''
  return value
}

function firstLine(value, apiKey) {
  let line = String(value ?? '').split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? ''
  if (apiKey && apiKey.length >= 4) line = line.split(apiKey).join('[REDACTED]')
  line = redactSecrets(line)
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

function isTimeout(error) {
  return errorChain(error).some((item) => item?.code === 'ETIMEDOUT' || item?.name === 'TimeoutError' || /timed out|timeout/i.test(String(item?.message ?? '')))
}

/**
 * Why a call to a model server failed, for the page to explain (the page
 * builds its own text from this; it never parses `error`):
 * `{ reason, status?, detail?, service?, port?, endpoint, origin, local,
 * keySent, provider, platform, timeoutMs?, suggestedBaseUrl? }`.
 *
 * reason: `auth` (401/403), `not_found` (404), `refused` (nothing listens
 * on the port), `timeout`, `http` (any other status), `network` (another
 * connection error), `bad_response` (an answer of the wrong shape), `bad_url`. `detail` is the first line of the server's
 * error text (or of the connection error), redacted and at most 200
 * characters. `suggestedBaseUrl`: a 404 from an OpenAI-compatible address
 * without a path gets the same address with `/v1` (the page offers it;
 * nothing is changed by itself). `service` is the local service the port
 * belongs to (oMLX, LM Studio, Ollama), else absent.
 */
export function failureOf({ error, status, body, text, baseUrl, provider = 'openai', apiKey, timeoutMs, platform = process.platform } = {}) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  const out = { reason: 'network', endpoint: '', local: false, keySent: Boolean(apiKey), provider: provider === 'ollama' ? 'ollama' : 'openai', platform }
  let url = null
  try {
    url = new URL(base)
  } catch {
    url = null
  }
  if (!url || !/^https?:$/.test(url.protocol)) return { ...out, reason: 'bad_url' }
  out.endpoint = url.host
  out.origin = url.origin
  out.local = LOCAL_HOST_RE.test(url.hostname)
  const service = serviceAt(base, platform)
  if (service) {
    out.service = service.label
    out.port = service.port
  } else if (out.local) {
    out.port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  }
  const code = Number.isInteger(status) ? status : Number.isInteger(error?.status) && error.status >= 300 ? error.status : undefined
  if (error?.code === 'BAD_RESPONSE') return { ...out, reason: 'bad_response', detail: firstLine(error.message, apiKey) }
  if (code !== undefined) {
    out.status = code
    const detail = firstLine(error ? (error.detail ?? '') : answerDetail(body, text), apiKey)
    if (detail) out.detail = detail
    if (code === 401 || code === 403) out.reason = 'auth'
    else if (code === 404) {
      out.reason = 'not_found'
      if (provider !== 'ollama' && (url.pathname === '' || url.pathname === '/')) out.suggestedBaseUrl = `${url.origin}/v1`
    } else out.reason = 'http'
    return out
  }
  if (isRefused(error)) return { ...out, reason: 'refused' }
  if (isTimeout(error)) return { ...out, reason: 'timeout', ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}) }
  const chain = errorChain(error)
  const message = chain.map((item) => item?.code && !String(item.message).includes(item.code) ? `${item.message} (${item.code})` : item?.message).filter(Boolean).at(-1)
  const detail = firstLine(message ?? error, apiKey)
  return detail ? { ...out, detail } : out
}

function modelNames(provider, body) {
  if (provider === 'ollama') return (Array.isArray(body?.models) ? body.models : []).map((item) => String(item?.name ?? item?.model ?? '')).filter(Boolean)
  return (Array.isArray(body?.data) ? body.data : []).map((item) => String(item?.id ?? '')).filter(Boolean)
}

/**
 * Probe the local servers of this platform (127.0.0.1 only). Each result:
 * `{ id, label, provider, port, baseUrl, ok, models, embeddingModels,
 * error, hint }`.
 */
export async function probeLocalServices({ platform = process.platform, fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const candidates = localServiceCandidates(platform)
  return Promise.all(candidates.map(async (candidate) => {
    const out = { ...candidate, ok: false, running: false, needsKey: false, models: [], embeddingModels: [], error: null, failure: null }
    delete out.listPath
    try {
      const { ok, status, body, text } = await getJson(`${candidate.baseUrl}${candidate.listPath}`, { fetchImpl, timeoutMs })
      if (!ok) {
        out.error = `HTTP ${status}`
        out.failure = failureOf({ status, body, text, baseUrl: candidate.baseUrl, provider: candidate.provider, platform })
        // Something answers on the port: running, just not listing (a key
        // is needed, or another path).
        out.running = true
        out.needsKey = out.failure.reason === 'auth'
        return out
      }
      out.ok = true
      out.running = true
      out.models = modelNames(candidate.provider, body).slice(0, 100)
      out.embeddingModels = out.models.filter(isLikelyEmbeddingModel)
    } catch (error) {
      out.failure = failureOf({ error, baseUrl: candidate.baseUrl, provider: candidate.provider, timeoutMs, platform })
      out.error = out.failure.reason === 'refused' ? 'not running' : out.failure.reason === 'timeout' ? 'no answer' : redactSecrets(String(error?.message ?? error)).slice(0, 160)
      // Only a real 10013 gets the hint here; the page sums up refused
      // services on Windows once.
      if (isReservedPortError(error)) out.hint = reservedPortHint(platform)
    }
    return out
  }))
}

/**
 * List the models of a server the user typed (on the user's request):
 * OpenAI-compatible `/models` or Ollama `/api/tags`. A failure carries
 * `failure` (failureOf).
 */
export async function listModels({ provider, baseUrl, apiKey, fetchImpl = fetch, timeoutMs = 8_000, platform = process.platform }) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  const kind = provider === 'ollama' ? 'ollama' : 'openai'
  if (!/^https?:\/\//i.test(base)) return { ok: false, models: [], error: 'the address must start with http:// or https://', failure: failureOf({ baseUrl: base, provider: kind, apiKey, platform }) }
  try {
    const { ok, status, body, text } = await getJson(`${base}${kind === 'ollama' ? '/api/tags' : '/models'}`, { fetchImpl, timeoutMs, apiKey })
    if (!ok) return { ok: false, models: [], error: `HTTP ${status}`, status, failure: failureOf({ status, body, text, baseUrl: base, provider: kind, apiKey, platform }) }
    const models = modelNames(kind, body).slice(0, 200)
    return { ok: true, models, embeddingModels: models.filter(isLikelyEmbeddingModel) }
  } catch (error) {
    const out = { ok: false, models: [], error: redactSecrets(String(error?.message ?? error)).slice(0, 200), failure: failureOf({ error, baseUrl: base, provider: kind, apiKey, timeoutMs, platform }) }
    if (isReservedPortError(error)) out.hint = reservedPortHint(platform)
    return out
  }
}

// ---- store location ---------------------------------------------------------

const SYNC_FOLDERS = [
  [/^onedrive(?:\s*-\s*.+)?$/i, 'OneDrive'],
  [/^dropbox(?:\s*\(.+\))?$/i, 'Dropbox'],
  [/^google drive$|^googledrive$|^my drive$/i, 'Google Drive'],
  [/^icloud ?drive(?:\s*\(.+\))?$/i, 'iCloud Drive'],
  [/^nutstore$|^坚果云$/i, 'Nutstore'],
  [/^baidunetdisk$|^百度网盘$/i, 'Baidu Netdisk'],
  [/^box$|^box sync$/i, 'Box'],
  [/^pcloud ?drive$/i, 'pCloud'],
  [/^syncthing$|^sync$/i, 'Sync'],
]

/**
 * Where a store path lies, from the path alone (no file system access, so
 * it is tested with path.win32 and path.posix on every platform):
 * `{ kind: 'local' | 'network' | 'sync' | 'external', provider?, reason? }`.
 * `network` and `sync` are refused: SQLite's locking is unreliable on
 * network shares, and sync clients replace the file under an open
 * connection. `external` (a removable or mounted volume) is a warning.
 */
export function classifyStorePath(file, { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const text = String(file ?? '')
  if (platform === 'win32') {
    if (/^\\\\\?\\UNC\\/i.test(text) || (/^[\\/]{2}[^\\/?.]/.test(text))) return { kind: 'network', reason: 'UNC path (a network share)' }
  } else if (/^\/(?:net|Network)\//.test(text)) {
    return { kind: 'network', reason: 'network mount' }
  }
  const normalized = p.normalize(text)
  const lower = normalized.toLowerCase()
  const under = (dir) => {
    if (!dir) return false
    const base = p.normalize(String(dir)).toLowerCase().replace(/[\\/]+$/, '')
    return lower === base || lower.startsWith(`${base}${p.sep}`)
  }
  if (platform === 'win32') {
    for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
      if (env?.[key] && under(env[key])) return { kind: 'sync', provider: 'OneDrive', reason: `inside ${key}` }
    }
  }
  if (platform === 'darwin' && home) {
    if (under(p.join(home, 'Library', 'Mobile Documents'))) return { kind: 'sync', provider: 'iCloud Drive', reason: 'inside iCloud Drive' }
    if (under(p.join(home, 'Library', 'CloudStorage'))) {
      const rest = normalized.slice(p.join(home, 'Library', 'CloudStorage').length + 1)
      const folder = rest.split(p.sep)[0] ?? ''
      const provider = folder.split('-')[0] || 'cloud storage'
      return { kind: 'sync', provider, reason: 'inside ~/Library/CloudStorage' }
    }
  }
  for (const segment of normalized.split(/[\\/]+/)) {
    for (const [pattern, provider] of SYNC_FOLDERS) {
      if (pattern.test(segment)) return { kind: 'sync', provider, reason: `inside a ${provider} folder` }
    }
  }
  if (platform === 'darwin' && /^\/Volumes\/[^/]+/.test(normalized)) return { kind: 'external', reason: 'on another volume (/Volumes)' }
  if (platform === 'linux' && /^\/(?:mnt|media|run\/media)\//.test(normalized)) return { kind: 'external', reason: 'on a mounted volume' }
  return { kind: 'local' }
}

// statfs f_type of network and FUSE file systems on Linux.
const LINUX_NETWORK_FS = new Map([
  [0x6969, 'NFS'],
  [0x517b, 'SMB'],
  [0xff534d42, 'CIFS'],
  [0xfe534d42, 'SMB2'],
  [0x65735546, 'FUSE'],
  [0x564c, 'NCP'],
  [0x7461636f, 'OCFS2'],
  [0x47504653, 'GPFS'],
  [0x0bd00bd0, 'Lustre'],
  [0x73757245, 'Coda'],
  [0x6b414653, 'AFS'],
])

// macOS `mount` types: network shares, and the local disk formats.
const MAC_NETWORK_FS = new Set(['smbfs', 'nfs', 'afpfs', 'webdav', 'cifs', 'ftp', 'cddafs'])
const MAC_LOCAL_FS = new Set(['apfs', 'hfs', 'exfat', 'msdos', 'ntfs', 'ufs'])

/**
 * The file system type of the mount holding `target`, from `mount` output
 * (lines like `//u@nas/share on /Volumes/share (smbfs, nodev, …)`).
 */
export function macMountType(target, mountOutput) {
  let best = null
  for (const line of String(mountOutput ?? '').split('\n')) {
    const match = / on (.+?) \(([^,)]+)/.exec(line)
    if (!match) continue
    const [, point, type] = match
    const inside = target === point || target.startsWith(point.endsWith('/') ? point : `${point}/`)
    if (inside && (!best || point.length > best.point.length)) best = { point, type: type.trim().toLowerCase() }
  }
  return best
}

function readMountTable() {
  try {
    return execFileSync('/sbin/mount', [], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

function nearestExisting(dir) {
  let current = dir
  for (let depth = 0; depth < 64; depth += 1) {
    if (fs.existsSync(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

/**
 * Check a store path on this computer: its location (classifyStorePath,
 * plus the file system type on Linux and iCloud's Desktop & Documents sync
 * on macOS), and that its folder can be created and written. Creates the
 * folder; writes and removes one small test file; never touches an
 * existing database.
 */
export function checkStoreLocation(file, { platform = process.platform, env = process.env, home = os.homedir(), mountTable = readMountTable, realpath = (dir) => fs.realpathSync.native(dir), confirmed = false } = {}) {
  const resolved = path.resolve(expandHome(String(file || DEFAULT_STORE_PATH), home))
  const out = { path: displayPath(resolved, home), exists: fs.existsSync(resolved), writable: false, ...classifyStorePath(resolved, { platform, env, home }) }
  if (out.kind === 'local' && platform === 'win32') {
    // A mapped network drive (Z:) resolves to its \\server\share path.
    try {
      const real = String(realpath(nearestExisting(path.dirname(resolved))))
      if (/^\\\\\?\\UNC\\/i.test(real) || /^[\\/]{2}[^\\/?.]/.test(real)) Object.assign(out, { kind: 'network', reason: `a network drive (${real.slice(0, 80)})` })
    } catch {
      // unknown: keep the path-based answer
    }
  }
  if (out.kind === 'external' && platform === 'darwin') {
    // /Volumes holds USB disks and SMB/NFS/AFP shares alike: ask `mount`.
    // Mount points exist; the folder below one need not exist yet.
    const mounted = macMountType(path.dirname(resolved), mountTable())
    if (mounted && MAC_NETWORK_FS.has(mounted.type)) Object.assign(out, { kind: 'network', reason: `${mounted.type} share at ${mounted.point}` })
    else if (mounted && MAC_LOCAL_FS.has(mounted.type)) out.reason = `on another disk (${mounted.type}, ${mounted.point})`
    else Object.assign(out, { kind: 'unverified', reason: `on a volume of unknown type (${mounted?.type ?? 'not found'}); confirm it is a local disk` })
  }
  if (out.kind === 'local' && platform === 'linux' && typeof fs.statfsSync === 'function') {
    try {
      const type = Number(fs.statfsSync(nearestExisting(path.dirname(resolved))).type) >>> 0
      if (LINUX_NETWORK_FS.has(type)) Object.assign(out, { kind: 'network', reason: `${LINUX_NETWORK_FS.get(type)} file system` })
    } catch {
      // unknown: keep the path-based answer
    }
  }
  if (out.kind === 'local' && platform === 'darwin' && home) {
    // "Desktop & Documents Folders" in iCloud moves both into iCloud Drive.
    for (const folder of ['Desktop', 'Documents']) {
      const local = path.join(home, folder)
      if ((resolved === local || resolved.startsWith(`${local}${path.sep}`)) && fs.existsSync(path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', folder))) {
        Object.assign(out, { kind: 'sync', provider: 'iCloud Drive', reason: `~/${folder} is synced by iCloud (Desktop & Documents)` })
      }
    }
  }
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    const probe = path.join(path.dirname(resolved), `.dsh-mem0-write-test-${process.pid}-${randomUUID().slice(0, 8)}`)
    fs.writeFileSync(probe, 'ok', { mode: 0o600 })
    fs.rmSync(probe, { force: true })
    out.writable = true
  } catch (error) {
    out.error = `the folder cannot be written: ${error.code ?? error.message}`
  }
  out.ok = out.writable && (out.kind === 'local' || out.kind === 'external' || (out.kind === 'unverified' && confirmed === true))
  if (out.kind === 'unverified') out.needsConfirm = !confirmed
  return out
}

function expandHome(value, home = os.homedir()) {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2))
  return value
}

// ---- drafts -----------------------------------------------------------------

function text(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/**
 * The wizard's draft (from the page) as `dsh_mem0` fields. Keys are not
 * part of it; `embedder.apiKey` / `llm.apiKey` travel separately.
 */
export function draftFields(draft = {}) {
  const embedder = draft.embedder ?? {}
  const llm = draft.llm ?? {}
  const fields = {}
  const set = (key, value) => {
    if (value !== '' && value !== undefined && value !== null) fields[key] = value
  }
  const provider = text(embedder.provider).toLowerCase()
  set('embedderProvider', provider === 'ollama' ? 'ollama' : provider ? 'openai' : '')
  set('embedderBaseUrl', text(embedder.baseUrl).replace(/\/+$/, ''))
  set('embedderModel', text(embedder.model, 200))
  const dims = Number(embedder.dims)
  if (Number.isInteger(dims) && dims > 0 && dims <= 65536 && embedder.sendDims === true) fields.embedderDims = dims
  set('embedderApiKeyRef', text(embedder.apiKeyRef, 100))
  set('llmBaseUrl', text(llm.baseUrl).replace(/\/+$/, ''))
  set('llmModel', text(llm.model, 200))
  set('llmApiKeyRef', text(llm.apiKeyRef, 100))
  const maxTokens = Number(llm.maxTokens)
  if (Number.isInteger(maxTokens) && maxTokens >= 256 && maxTokens <= 65536) fields.llmMaxTokens = maxTokens
  set('llmReasoningEffort', text(llm.reasoningEffort, 12).toLowerCase())
  set('storePath', text(draft.storePath, 1000))
  return fields
}

/** Native settings for a draft (validated like oss.json's dsh_mem0 block). */
export function draftSettings(draft) {
  return resolveNativeSettings(draftFields(draft), undefined)
}

function problemsOf(settings, component) {
  return (settings.problems ?? []).filter((problem) => problem.component === component).map((problem) => problem.message)
}

function describeError(error) {
  return redactSecrets(String(error?.message ?? error)).slice(0, 400)
}

/** `{ ok, dims, expectedDims, error, hint }` for one test embedding. */
export async function testEmbedder(embedder, { apiKey, fetchImpl, timeoutMs = 20_000, platform = process.platform, expectedDims } = {}) {
  try {
    const [vector] = await embedTexts(embedder, ['dsh-mem0 setup test'], { apiKey, fetchImpl, timeoutMs })
    const out = { ok: true, dims: vector.length, model: embedder.model, endpoint: hostPort(embedder.baseUrl) }
    if (Number.isInteger(expectedDims) && expectedDims > 0 && expectedDims !== vector.length) {
      out.dimsDiffer = { expected: expectedDims, actual: vector.length }
    }
    return out
  } catch (error) {
    const out = { ok: false, error: describeError(error), code: error?.code, status: error?.status, failure: failureOf({ error, baseUrl: embedder?.baseUrl, provider: embedder?.provider === 'ollama' ? 'ollama' : 'openai', apiKey, timeoutMs, platform }) }
    if (isReservedPortError(error) || (platform === 'win32' && error?.code === 'NETWORK_ERROR' && /refused/i.test(String(error?.message)))) out.hint = reservedPortHint(platform)
    if (error?.status === 401 || error?.status === 403) out.authFailed = true
    return out
  }
}

const SAMPLE_CONVERSATION = [
  { role: 'user', content: 'I moved to Lisbon last spring and I prefer green tea over coffee. Please answer me in English.' },
  { role: 'assistant', content: 'Noted: you live in Lisbon, like green tea and want answers in English.' },
]

/**
 * One test extraction (Mem0's prompt, a fixed sample) with budget advice.
 * `advice`: `raise-max-tokens` (cut off, or most of the budget went to
 * reasoning), `lower-effort` (a reasoning model: `reasoning_effort` low or
 * none if the gateway supports it), `json-mode` (answer not JSON).
 */
export async function testLlm(llm, { apiKey, fetchImpl, timeoutMs = 60_000, platform = process.platform } = {}) {
  const messages = buildExtractionMessages({ newMessages: parseMessages(SAMPLE_CONVERSATION), existingMemories: [], lastMessages: [] })
  const started = Date.now()
  try {
    const { content, stats } = await chatCompletion(llm, messages, { apiKey, fetchImpl, timeoutMs })
    const ms = Date.now() - started
    const { facts, reason } = inspectExtraction(content, stats)
    const advice = []
    const reasoningShare = stats.reasoningTokens && stats.completionTokens ? stats.reasoningTokens / stats.completionTokens : 0
    if (reason === 'truncated' || stats.finishReason === 'length') advice.push('raise-max-tokens')
    if (stats.reasoningTokens > 0 || reasoningShare > 0) advice.push('lower-effort')
    if (reasoningShare > 0.6 && !advice.includes('raise-max-tokens') && (stats.maxTokens ?? 0) < 8000) advice.push('raise-max-tokens')
    if (reason === 'not_json') advice.push('json-mode')
    return {
      ok: facts !== null && !reason,
      facts: Array.isArray(facts) ? facts.length : 0,
      reason: reason ?? null,
      stats,
      statsText: describeStats(stats),
      advice,
      endpoint: hostPort(llm.baseUrl),
      ms,
    }
  } catch (error) {
    const out = { ok: false, error: describeError(error), code: error?.code, status: error?.status, advice: [], ms: Date.now() - started, failure: failureOf({ error, baseUrl: llm?.baseUrl, provider: 'openai', apiKey, timeoutMs, platform }) }
    if (isReservedPortError(error)) out.hint = reservedPortHint(platform)
    if (error?.status === 401 || error?.status === 403) out.authFailed = true
    return out
  }
}

/**
 * The self-test: write, find and delete one probe memory of the test user,
 * then check that user has nothing left (leftovers of an earlier, broken
 * run are removed too). Opens the store at `settings.storePath`; only rows
 * of `SELFTEST_USER_ID` are written or deleted.
 * `apiKeys` (the keys in use) only say whether a key was sent, for `failure`.
 * @returns {Promise<{ ok, steps: Array<{ step, ok, error? }>, error?, code?, failure?, component?, storedEmbedder? }>}
 */
export async function runSelfTest({ settings, resolveSecret, fetchImpl, logger, timeoutMs = 30_000, apiKeys = {} }) {
  const steps = []
  const client = new Mem0NativeClient({
    config: { userId: SELFTEST_USER_ID, agentId: SELFTEST_AGENT_ID, timeoutMs, addTimeoutMs: timeoutMs },
    loadSettings: () => settings,
    resolveSecret,
    fetchImpl,
    logger,
  })
  const nonce = randomUUID()
  const probe = `dsh-mem0 wizard self-test ${nonce}`
  const scope = { user_id: SELFTEST_USER_ID }
  let id
  const fail = (step, error) => {
    steps.push({ step, ok: false, error: describeError(error) })
    // A model server's failure (the embedder, or the LLM): why, for the page.
    const component = error?.component === 'llm' ? 'llm' : error?.component === 'embedder' ? 'embedder' : null
    const failure = component
      ? failureOf({ error, baseUrl: settings?.[component]?.baseUrl, provider: component === 'embedder' && settings?.embedder?.provider === 'ollama' ? 'ollama' : 'openai', apiKey: apiKeys[component] || settings?.[component]?.apiKey, timeoutMs })
      : null
    return { ok: false, steps, error: describeError(error), code: error?.code, ...(failure ? { failure, component } : {}), ...(error?.storedEmbedder ? { storedEmbedder: { ...error.storedEmbedder } } : {}) }
  }
  try {
    try {
      const added = await client.add([{ role: 'user', content: probe }], { infer: false, userId: SELFTEST_USER_ID, agentId: SELFTEST_AGENT_ID, metadata: { source: 'dsh-mem0-wizard' } })
      id = added?.results?.[0]?.id
      if (!id) throw new Error('the store returned no id for the probe')
      steps.push({ step: 'write', ok: true })
    } catch (error) {
      return fail('write', error)
    }
    try {
      const found = await client.search(probe, scope, { topK: 5 })
      if (!found.results.some((item) => item.id === id)) throw new Error('the probe was written but search did not return it')
      steps.push({ step: 'search', ok: true })
    } catch (error) {
      return fail('search', error)
    }
    try {
      await client.remove(id)
      id = undefined
      steps.push({ step: 'delete', ok: true })
    } catch (error) {
      return fail('delete', error)
    }
    try {
      const left = await client.list(scope, { topK: 100 })
      for (const item of left.results) {
        if (item?.user_id === SELFTEST_USER_ID) await client.remove(item.id)
      }
      const after = await client.list(scope, { topK: 1 })
      if (after.results.length > 0) throw new Error('the test user still has memories after the cleanup')
      steps.push({ step: 'leftover', ok: true, ...(left.results.length > 0 ? { removed: left.results.length } : {}) })
    } catch (error) {
      return fail('leftover', error)
    }
    return { ok: true, steps }
  } finally {
    if (id) {
      try {
        await client.remove(id)
      } catch {
        // reported by the leftover check of the next run
      }
    }
    await client.dispose()
  }
}

// ---- saving -----------------------------------------------------------------

function timestamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

function restrict(file) {
  if (process.platform === 'win32') return
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // best effort
  }
}

/**
 * Write the wizard's fields into the `dsh_mem0` block of oss.json, keeping
 * every other key (the `oss` block the migration reads included). The old
 * file is copied to `oss.json.bak-<UTC time>` first; the new one is written
 * to a temporary file and renamed into place. Both are chmod 600 on Unix.
 * Fields the wizard manages but the draft leaves empty are removed from the
 * block. Returns `{ path, backup }` (home shown as `~`).
 */
export function writeOssSettings(fields, { file = DEFAULT_OSS_CONFIG, now = new Date(), dropLiteralKeys = [] } = {}) {
  const current = readOssConfig(file)
  if (current?.[OSS_CONFIG_INVALID]) {
    const error = new Error(`${current[OSS_CONFIG_INVALID]}; the wizard does not overwrite a file it cannot read`)
    error.code = 'CONFIG_INVALID'
    throw error
  }
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {}
  const block = base.dsh_mem0 && typeof base.dsh_mem0 === 'object' && !Array.isArray(base.dsh_mem0) ? { ...base.dsh_mem0 } : {}
  for (const key of WIZARD_FIELDS) delete block[key]
  for (const [key, value] of Object.entries(fields)) {
    if (!(key in OSS_FALLBACK_FIELDS)) continue
    if (key.endsWith('ApiKeyRef') && !REF_RE.test(String(value))) continue
    block[key] = value
  }
  const next = { ...base, dsh_mem0: block }
  // Keys now in DSH credentials leave the `oss` block (the migration reads
  // only vector_store and embedder.config.model there).
  const dropped = []
  if (next.oss && typeof next.oss === 'object') {
    next.oss = { ...next.oss }
    for (const component of dropLiteralKeys) {
      const section = next.oss[component]
      if (section?.config && typeof section.config === 'object' && 'api_key' in section.config) {
        const { api_key: _removed, ...rest } = section.config
        next.oss[component] = { ...section, config: rest }
        dropped.push(component)
      }
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let backup
  if (fs.existsSync(file)) {
    backup = `${file}.bak-${timestamp(now)}`
    fs.copyFileSync(file, backup)
    restrict(backup)
  }
  const temp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  try {
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
  restrict(file)
  return { path: displayPath(file), backup: backup ? displayPath(backup) : undefined, droppedLiteralKeys: dropped, ...(dropped.length && backup ? { backupHasKeys: true } : {}) }
}

/** dsh_mem0 fields the wizard owns (cleared when a draft leaves them empty). */
export const WIZARD_FIELDS = Object.freeze([
  'storePath', 'embedderProvider', 'embedderBaseUrl', 'embedderModel', 'embedderDims', 'embedderApiKeyRef',
  'llmBaseUrl', 'llmModel', 'llmApiKeyRef', 'llmMaxTokens', 'llmReasoningEffort',
])

export { problemsOf }

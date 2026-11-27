/**
 * Same-origin HTTP routes used by the browser-side Mem0 settings page.
 *
 * The DSH Web client cannot call the plugin's model-facing tools directly, so
 * the page needs a tiny read-only health endpoint. Routes are registered only
 * when the composition serves a Web server and expose no secrets: the
 * response contains the effective backend, endpoint, collection and local
 * dependency versions, never the configured API key.
 */
import { redactSecrets } from './redact.js'
import { describeBackendChoice } from './config.js'
import { upgradeNotices } from './diagnostics.js'
import { normalizeLanguage, preserveMarkdownPrefixes } from './memory-localizer.js'
import { redactLogText, sanitizeFailureMessage } from './failure-history.js'
import { diagnosisFingerprint } from './diagnose-report.js'
import { isOwnMemory } from './memory-maintenance.js'
import { isPinned } from './memory-review.js'
import { assertOwned } from './tools.js'
import { inPartitions, isDshDefaultProject, scopeOf } from './project-scope.js'
import { handleSetupAction, jobStatus, setupState } from './setup-routes.js'
import { handleBackupHandled, handleFailuresAcknowledged, handleSettingsSaved, readBackupForRestore } from './settings-routes.js'

export const GUI_STATUS_PATH = '/dsh-mem0/gui/status'
export const GUI_TEST_PATH = '/dsh-mem0/gui/test'
export const GUI_ACTIVITY_PATH = '/dsh-mem0/gui/activity'
export const GUI_HYGIENE_PATH = '/dsh-mem0/gui/hygiene'
export const GUI_MEMORIES_PATH = '/dsh-mem0/gui/memories'
export const GUI_PROFILE_PATH = '/dsh-mem0/gui/profile'
export const GUI_SETUP_PATH = '/dsh-mem0/gui/setup'
/** Settings copy in oss.json after a save; restore from a crash-recovery backup. */
export const GUI_PROFILE_PATCH_PATH = '/dsh-mem0/gui/profile-patch'
/** "Got it" on the failure banner. */
export const GUI_FAILURES_PATH = '/dsh-mem0/gui/failures'

const PLAN_ERRORS = new Set(['plan-required', 'plan-unknown', 'plan-conflict', 'plan-scope', 'busy', 'model-starting'])

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function methodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

function sanitizeStatus(status, config) {
  const details = {
    backend: status?.backend ?? config.backend,
    endpoint: status?.baseUrl ?? (config.baseUrl || '(local OSS)'),
    // Where memories live: the SQLite file of the local backend (home shown
    // as ~), the collection of a REST server.
    collection: config.backend === 'oss'
      ? redactLogText(status?.store?.path ?? config.native?.storePath ?? config.storePath ?? '')
      : status?.collection ?? config.collectionName,
    user: status?.userId ?? config.userId,
    agent: status?.agentId ?? config.agentId,
    apiKeyConfigured: Boolean(config.apiKey),
    // Where the key and backend came from, so the page can say plainly when
    // an inherited environment variable sent memories to the cloud.
    apiKeySource: config.apiKeySource ?? (config.apiKey ? 'config' : 'none'),
    apiKeyEnv: config.apiKeyEnv,
    backendSource: config.backendSource ?? 'configured',
    backendChoice: describeBackendChoice(config),
    // Old memories left in Qdrant, no local settings found (from the config only).
    upgradeNotices: upgradeNotices(config, { memoryCount: status?.memoryCount, migration: status?.store?.migration }),
  }
  if (status?.mem0Reference) details.mem0Reference = status.mem0Reference
  if (status?.store) {
    details.store = {
      ok: Boolean(status.store.ok),
      kind: status.store.kind,
      path: status.store.path ? redactLogText(status.store.path) : undefined,
      schemaVersion: status.store.schemaVersion,
      sqliteVersion: status.store.sqliteVersion,
      error: status.store.error ? redactSecrets(String(status.store.error)) : undefined,
      migration: status.store.migration ?? undefined,
    }
  }
  if (status?.llm) {
    details.llm = {
      configured: Boolean(status.llm.configured),
      model: status.llm.model,
      ...(status.llm.followsDsh ? { followsDsh: true } : {}),
      error: status.llm.error ? redactSecrets(String(status.llm.error)) : undefined,
    }
  }
  if (status?.qdrant) details.qdrant = { ok: Boolean(status.qdrant.ok), error: status.qdrant.error }
  if (status?.embedder) {
    details.embedder = {
      ok: Boolean(status.embedder.ok),
      dimensions: status.embedder.dimensions,
      model: status.embedder.model,
      provider: status.embedder.provider,
      error: status.embedder.error,
    }
  }
  return details
}

function sanitizeRecallPreview(preview) {
  if (!Array.isArray(preview)) return undefined
  return preview.slice(0, 5).map((item) => ({
    id: item?.id ?? null,
    memory: redactSecrets(String(item?.memory ?? '')).slice(0, 240),
  }))
}

const CAPTURE_EVENTS = new Set(['ADD', 'UPDATE', 'DELETE'])

/** The capture card's rows (lib/memory-lifecycle.js toCapturePreview), re-checked like the recall preview. */
function sanitizeCapturePreview(preview) {
  if (!Array.isArray(preview)) return undefined
  return preview
    .filter((item) => CAPTURE_EVENTS.has(item?.event))
    .slice(0, 5)
    .map((item) => {
      const row = {
        id: item?.id === undefined || item?.id === null ? '' : String(item.id),
        memory: redactSecrets(String(item?.memory ?? '')).slice(0, 240),
        event: item.event,
      }
      if (item.event === 'UPDATE' && typeof item.previous === 'string' && item.previous) {
        row.previous = redactSecrets(item.previous).slice(0, 240)
      }
      if (typeof item.partition === 'string' && /^(global|project:[\w.:-]{1,200})$/.test(item.partition)) row.partition = item.partition
      return row
    })
}

function sanitizePending(pending) {
  if (!pending || typeof pending !== 'object') return undefined
  return pending.eventId ? { eventId: redactSecrets(String(pending.eventId)).slice(0, 120) } : {}
}

function sanitizeActivity(activity) {
  const clean = (value, preview = sanitizeRecallPreview) => {
    if (!value) return null
    return {
      ...value,
      error: value.error ? redactSecrets(String(value.error)) : undefined,
      firstError: value.firstError ? redactSecrets(String(value.firstError)) : undefined,
      trippedBy: value.trippedBy
        ? { ...value.trippedBy, message: redactSecrets(String(value.trippedBy.message ?? '')) }
        : undefined,
      preview: preview(value.preview),
    }
  }
  const capture = clean(activity?.capture, sanitizeCapturePreview)
  if (capture) capture.pending = sanitizePending(capture.pending)
  // The last round that wrote something (lib/memory-lifecycle.js toLastWrite):
  // only its time, counts, partition and the same rows as the capture card.
  const last = activity?.lastWrite
  const lastWrite = last && typeof last === 'object'
    ? {
        at: last.at,
        add: last.add,
        update: last.update,
        delete: last.delete,
        scope: last.scope,
        project: last.project,
        preview: sanitizeCapturePreview(last.preview),
      }
    : null
  return {
    recall: clean(activity?.recall),
    capture,
    lastWrite,
    maintenance: clean(activity?.maintenance),
  }
}

/**
 * Local store status (open or not, file path, the last failure to open it);
 * null for REST backends.
 */
function readStore(runtime) {
  if (runtime?.config?.backend !== 'oss') return null
  let status = null
  try {
    status = runtime.client?.status?.() ?? null
  } catch {
    status = null
  }
  const failure = status?.lastStartFailure
  return {
    running: Boolean(status?.running),
    kind: status?.store?.kind ?? 'sqlite',
    path: redactLogText(status?.store?.path ?? runtime.config.native?.storePath ?? ''),
    lastStartFailure: failure ? { ...failure, reason: redactSecrets(String(failure.reason ?? '')) } : null,
  }
}

/**
 * Recent failures, newest first; entries are already redacted when stored.
 * Each carries `diagnosisSessionId`: the diagnosis session already opened
 * for the same problem (lib/diagnose-sessions.js), so the page can offer
 * "Open diagnosis session" instead of a new one.
 */
function readFailures(runtime) {
  try {
    const list = runtime?.failures?.list?.() ?? []
    const store = runtime?.diagnoseSessions
    if (typeof store?.sessionFor !== 'function') return list
    const sanitize = (text) => sanitizeFailureMessage(text)
    return list.map((entry) => {
      const sessionId = store.sessionFor(diagnosisFingerprint(entry, { plugin: 'dsh-mem0', sanitize }))
      return sessionId ? { ...entry, diagnosisSessionId: sessionId } : entry
    })
  } catch {
    return []
  }
}

/** The newest failure the user acknowledged ("Got it"), or null. */
function readAcknowledgedAt(runtime) {
  const value = runtime?.failures?.acknowledgedAt
  return typeof value === 'string' ? value : null
}

function sanitizeMemory(memory) {
  const source = memory?.metadata?.source
  return {
    id: memory?.id ?? null,
    memory: redactSecrets(String(memory?.memory ?? memory?.text ?? '')).slice(0, 500),
    createdAt: memory?.created_at ?? memory?.createdAt ?? null,
    updatedAt: memory?.updated_at ?? memory?.updatedAt ?? null,
    score: typeof memory?.score === 'number' ? memory.score : undefined,
    // Only memories this plugin wrote may be deleted from the page.
    source: typeof source === 'string' ? source.slice(0, 64) : null,
    deletable: isOwnMemory(memory),
    pinned: isPinned(memory),
    importance: Number.isInteger(memory?.importance) ? memory.importance : null,
    // Partition (lib/project-scope.js): global unless the store says otherwise.
    scope: scopeOf(memory),
    projectId: memory?.project_id ? String(memory.project_id) : null,
    sessionId: memory?.session_id ? String(memory.session_id) : null,
  }
}

/** `global`, `project:<id>` or `session:<id>` → the partitions it names; '' → all. */
export function partitionsFromKey(key) {
  const text = String(key ?? '').trim()
  if (!text) return undefined
  if (text === 'global') return [{ scope: 'global' }]
  const match = text.match(/^(project|session):([A-Za-z0-9._:-]{1,128})$/)
  if (!match) return []
  return match[1] === 'project' ? [{ scope: 'project', project_id: match[2] }] : [{ scope: 'session', session_id: match[2] }]
}

/**
 * The memory page's tree: global, each project (with its sessions) and
 * sessions without a project, with counts. REST backends have no
 * partitions: everything is global.
 */
async function readTree(runtime) {
  if (!runtime?.client) return { ok: false, error: 'Mem0 memory is disabled', partitioned: false, global: 0, projects: [], sessions: [] }
  try {
    if (typeof runtime.client.partitionCounts !== 'function') {
      const result = await runtime.client.list({ user_id: runtime.config.userId }, { topK: 1000, timeoutMs: 8_000 })
      const count = Array.isArray(result?.results) ? result.results.length : 0
      return { ok: true, partitioned: false, global: count, total: count, projects: [], sessions: [] }
    }
    const [counts, names, defaultIds] = await Promise.all([
      runtime.client.partitionCounts({ user_id: runtime.config.userId }),
      typeof runtime.client.projects === 'function' ? runtime.client.projects() : {},
      Promise.resolve(runtime.projects?.defaultWorkspaceIds?.() ?? []).catch(() => []),
    ])
    const projects = new Map()
    const loose = []
    let global = 0
    const projectNode = (id) => {
      if (!projects.has(id)) {
        const node = { id, key: `project:${id}`, name: String(names?.[id]?.name || '').slice(0, 80), count: 0, sessions: [] }
        // DSH's default workspace, stored as a project before it counted as
        // none: the page names it instead of showing the folder name.
        if (isDshDefaultProject(id, names?.[id], defaultIds)) node.dshDefault = true
        projects.set(id, node)
      }
      return projects.get(id)
    }
    for (const row of counts) {
      if (row.scope === 'global') global += row.count
      else if (row.scope === 'project') projectNode(row.project_id).count += row.count
      else {
        // Sessions are labelled by their latest memory's time on the page.
        const node = { id: row.session_id, key: `session:${row.session_id}`, count: row.count, newest: row.newest ?? null }
        if (row.project_id) projectNode(row.project_id).sessions.push(node)
        else loose.push(node)
      }
    }
    const list = [...projects.values()].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
    const total = counts.reduce((sum, row) => sum + row.count, 0)
    return { ok: true, partitioned: true, global, total, projects: list, sessions: loose }
  } catch (error) {
    return { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)), partitioned: false, global: 0, projects: [], sessions: [] }
  }
}

/**
 * Current text of memories named by id (the hygiene report keeps ids only):
 * `{ texts: { [id]: { memory, pinned, importance } | null } }`, null when the
 * memory is gone or belongs to another user. At most 60 ids, 300 characters.
 */
async function lookupMemories(runtime, rawIds) {
  if (!runtime?.client) return { ok: false, error: 'Mem0 memory is disabled', texts: {} }
  const ids = [...new Set(String(rawIds ?? '').split(',').map((id) => id.trim()).filter((id) => /^[A-Za-z0-9._:-]{1,128}$/.test(id)))].slice(0, 60)
  const texts = {}
  // A few at a time: a REST backend answers each id with one request.
  await mapLimit(ids, LOOKUP_CONCURRENCY, async (id) => {
    try {
      const memory = await runtime.client.get(id, { timeoutMs: 8_000 })
      const owner = memory?.user_id == null ? '' : String(memory.user_id)
      if (!memory || (owner && owner !== runtime.config.userId)) {
        texts[id] = null
        return
      }
      texts[id] = {
        memory: redactSecrets(String(memory.memory ?? memory.text ?? '')).slice(0, 300),
        pinned: isPinned(memory),
        importance: Number.isInteger(memory.importance) ? memory.importance : null,
      }
    } catch {
      texts[id] = null
    }
  })
  return { ok: true, texts }
}

const LOOKUP_CONCURRENCY = 6

/** Run `task` over `items`, at most `limit` at once. */
async function mapLimit(items, limit, task) {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await task(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** Move one memory of the configured user to the global partition (text unchanged). */
async function makeGlobal(runtime, id) {
  if (!runtime?.client) return { status: 200, body: { ok: false, reason: 'disabled', error: 'Mem0 memory is disabled' } }
  const memoryId = String(id ?? '').trim()
  if (!memoryId) return { status: 400, body: { ok: false, reason: 'missing-id', error: 'A memory id is required' } }
  if (typeof runtime.client.setScope !== 'function') {
    return { status: 200, body: { ok: false, reason: 'unsupported', error: 'Partitions need the local memory backend' } }
  }
  let memory
  try {
    memory = await assertOwned(runtime.client, memoryId, runtime.config.userId)
  } catch (error) {
    const reason = error?.code === 'not-found' ? 'not-found' : 'other-user'
    return { status: reason === 'not-found' ? 404 : 403, body: { ok: false, reason, error: redactSecrets(error instanceof Error ? error.message : String(error)) } }
  }
  // Only a project memory this plugin wrote moves, and only to global.
  if (!isOwnMemory(memory)) {
    return { status: 403, body: { ok: false, reason: 'not-own', error: 'Only memories this plugin wrote can be moved' } }
  }
  if (scopeOf(memory) !== 'project') {
    return { status: 409, body: { ok: false, reason: 'not-project', error: 'Only a project memory can be made global' } }
  }
  await runtime.client.setScope(memoryId, { scope: 'global' })
  // Its project's summary no longer holds it.
  try {
    runtime.maintenance?.invalidateMemories?.([memoryId], { reason: 'update' })
  } catch {
    // best effort
  }
  return { status: 200, body: { ok: true, id: memoryId, scope: 'global' } }
}

/** Pin or unpin one memory of the configured user (local backend). */
async function pinOneMemory(runtime, id, pinned) {
  if (!runtime?.client) return { status: 200, body: { ok: false, reason: 'disabled', error: 'Mem0 memory is disabled' } }
  const memoryId = String(id ?? '').trim()
  if (!memoryId) return { status: 400, body: { ok: false, reason: 'missing-id', error: 'A memory id is required' } }
  if (typeof pinned !== 'boolean') return { status: 400, body: { ok: false, reason: 'bad-request', error: 'pinned must be true or false' } }
  if (typeof runtime.client.setAttributes !== 'function') {
    return { status: 200, body: { ok: false, reason: 'unsupported', error: 'Pinning needs the local memory backend' } }
  }
  try {
    await assertOwned(runtime.client, memoryId, runtime.config.userId)
  } catch (error) {
    return { status: 403, body: { ok: false, reason: 'other-user', error: redactSecrets(error instanceof Error ? error.message : String(error)) } }
  }
  await runtime.client.setAttributes(memoryId, { pinned })
  return { status: 200, body: { ok: true, id: memoryId, pinned } }
}

const DELETE_REASON = {
  'missing-id': 'A memory id is required',
  'not-found': 'Memory not found',
  'other-user': 'This memory belongs to another Mem0 user, so it cannot be deleted here',
  'unproven-owner':
    'The backend did not confirm this memory belongs to the configured Mem0 user, so it cannot be deleted here',
  'foreign-source':
    'Only memories written by DSH-Mem0 (metadata.source = "dsh") can be deleted here; this one came from another app',
  disabled: 'Mem0 memory is disabled',
}

function deleteRejection(status, reason, extra = {}) {
  return { status, body: { ok: false, reason, error: DELETE_REASON[reason], ...extra } }
}

/**
 * Look up one memory for the delete flow and check it may be deleted: it
 * must belong to the configured user (the `mem0_delete` tool's rule) and
 * carry `metadata.source === 'dsh'`. Returns `{ memory }` or a rejection.
 */
async function checkDeletable(runtime, rawId) {
  if (!runtime?.client) return deleteRejection(503, 'disabled')
  const id = String(rawId ?? '').trim()
  if (!id) return deleteRejection(400, 'missing-id')
  let memory
  try {
    memory = await assertOwned(runtime.client, id, runtime.config.userId)
  } catch (error) {
    if (error?.code === 'not-found' || error?.status === 404) return deleteRejection(404, 'not-found', { id })
    if (error?.code === 'other-user') return deleteRejection(403, 'other-user', { id })
    if (error?.code === 'unproven-owner') return deleteRejection(403, 'unproven-owner', { id })
    throw error
  }
  if (!isOwnMemory(memory)) {
    const source = memory?.metadata?.source
    return deleteRejection(403, 'foreign-source', {
      id,
      source: typeof source === 'string' ? source.slice(0, 64) : null,
    })
  }
  return { memory, id }
}

/** GET ?id= : the full (redacted) text and id the confirmation dialog shows. */
async function describeForDelete(runtime, rawId) {
  const checked = await checkDeletable(runtime, rawId)
  if (!checked.memory) return checked
  const { memory, id } = checked
  return {
    status: 200,
    body: {
      ok: true,
      memory: {
        id,
        memory: redactSecrets(String(memory?.memory ?? memory?.text ?? '')),
        source: 'dsh',
        createdAt: memory?.created_at ?? memory?.createdAt ?? null,
        deletable: true,
      },
    },
  }
}

/** DELETE ?id= : delete one memory after the same checks. Exported for tests. */
export async function deleteOneMemory(runtime, rawId) {
  const checked = await checkDeletable(runtime, rawId)
  if (!checked.memory) return checked
  const { memory, id } = checked
  const result = await runtime.client.remove(id)
  // The server backend's library copy must not show it again.
  forgetLibraryCache(runtime)
  // Translations of a deleted memory must not outlive it on disk.
  try {
    await runtime.localizer?.forget?.([memory?.memory ?? memory?.text ?? ''])
  } catch {
    // The memory is gone either way; a stale cache entry is harmless.
  }
  // The summary must stop injecting it before the next turn.
  try {
    runtime.maintenance?.invalidateMemories?.([id], { reason: 'delete' })
  } catch {
    // Best effort: the next pass rebuilds the summary anyway.
  }
  runtime.logger?.info?.(`dsh-mem0: deleted memory ${id} from the settings page`)
  return { status: 200, body: { ok: true, id, message: redactSecrets(String(result?.message ?? 'deleted')) } }
}

async function readRecentMemories(runtime, { lang = '' } = {}) {
  try {
    const result = await runtime.client.list(
      { user_id: runtime.config.userId },
      { topK: 5, timeoutMs: 8_000 },
    )
    let memories = (Array.isArray(result?.results) ? result.results : []).map(sanitizeMemory)
    if (runtime.localizer && lang) {
      const translated = await runtime.localizer.translate(
        memories.map((memory) => memory.memory),
        lang,
      )
      memories = memories.map((memory, index) => ({
        ...memory,
        memory: translated[index] || memory.memory,
      }))
    }
    return {
      memories,
      error: undefined,
    }
  } catch (error) {
    return {
      memories: [],
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
    }
  }
}

/** Why a setup POST is refused (not JSON, or not from the same origin), or null. */
export function setupPostRefusal(req) {
  const headers = req?.headers ?? {}
  const type = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') return { status: 415, error: 'the setup route takes application/json only' }
  const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site && site !== 'same-origin' && site !== 'none') return { status: 403, error: 'the setup route takes requests from the settings page only' }
  const origin = headers.origin
  if (origin !== undefined) {
    let host = ''
    try {
      host = new URL(String(origin)).host
    } catch {
      host = ''
    }
    if (!host || host.toLowerCase() !== String(headers.host ?? '').toLowerCase()) return { status: 403, error: 'the setup route takes requests from the settings page only' }
  }
  return null
}

async function readJsonBody(req, limit = 64 * 1024) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('request body must be JSON')
  }
}

/**
 * Partitions of the library filter's key: `partitionsFromKey`'s forms, plus
 * `tree:<projectId>` (a project with its sessions, user decision 8) and
 * `projects` (every project and its sessions).
 */
export function libraryPartitions(key) {
  const text = String(key ?? '').trim()
  if (text === 'projects') return [{ scope: 'project', project_id: '*' }, { scope: 'session', project_id: '*' }]
  const tree = text.match(/^tree:([A-Za-z0-9._:-]{1,128})$/)
  if (tree) return [{ scope: 'project', project_id: tree[1] }, { scope: 'session', project_id: tree[1] }]
  return partitionsFromKey(text)
}

/** `libraryPartitions` in JS, for backends read whole (REST memories are all global). */
function inLibraryPartitions(memory, partitions) {
  if (!Array.isArray(partitions)) return true
  const scope = scopeOf(memory)
  return partitions.some((partition) => {
    if (partition.scope === 'project' && partition.project_id === '*') return scope === 'project'
    if (partition.scope === 'session' && !partition.session_id) {
      if (scope !== 'session' || !memory?.project_id) return false
      return partition.project_id === '*' || String(memory.project_id) === String(partition.project_id ?? '')
    }
    return inPartitions(memory, [partition])
  })
}

// A self-hosted server's `GET /memories` has no paging: the newest 1,000
// are read once and kept 30 seconds, and the library is searched and paged
// from that copy. Deleting from the page drops the copy.
export const LIBRARY_CACHE_MS = 30_000
export const LIBRARY_CACHE_CAP = 1000
const libraryCache = new WeakMap()

async function cachedLibrary(runtime) {
  const userId = runtime.config.userId
  const now = Date.now()
  const hit = libraryCache.get(runtime)
  if (hit && hit.userId === userId && now - hit.at < LIBRARY_CACHE_MS) return hit.list
  const result = await runtime.client.list({ user_id: userId }, { topK: LIBRARY_CACHE_CAP, timeoutMs: 8_000 })
  const list = Array.isArray(result?.results) ? result.results : []
  libraryCache.set(runtime, { userId, at: now, list })
  return list
}

function forgetLibraryCache(runtime) {
  if (runtime) libraryCache.delete(runtime)
}

const MEMORY_ID = /^[A-Za-z0-9._:-]{1,128}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function byCreated(order) {
  const sign = order === 'oldest' ? -1 : 1
  return (left, right) => {
    const a = String(left?.created_at ?? left?.createdAt ?? '')
    const b = String(right?.created_at ?? right?.createdAt ?? '')
    if (a !== b) return a < b ? sign : -sign
    const x = String(left?.id ?? '')
    const y = String(right?.id ?? '')
    return x === y ? 0 : (x < y ? -1 : 1) * sign
  }
}

/** The configured user's memory by id, or null (another user's reads as none). */
async function ownMemory(runtime, id) {
  try {
    const memory = await runtime.client.get(id, { timeoutMs: 8_000 })
    const owner = memory?.user_id == null ? '' : String(memory.user_id)
    return memory && (!owner || owner === runtime.config.userId) ? memory : null
  } catch {
    return null
  }
}

/**
 * One page of the memory library.
 *
 * - Local backend (`listPage`): filtered, searched, counted and paged in SQLite.
 * - Platform: `page` / `page_size`; a search is the Platform's semantic
 *   search (by relevance, not substring); no partitions, no order.
 * - Self-hosted server: the newest 1,000, cached 30 s, paged in memory.
 *
 * `locate`: the page holding that memory (by id) in this order and filter,
 * `located` saying whether it was found. Only the page is translated.
 */
async function readMemories(runtime, { query = '', limit = 100, offset = 0, order = 'newest', lang = '', partition = '', locate = '' } = {}) {
  const shownQuery = String(query ?? '').trim().slice(0, 200)
  if (!runtime?.client) {
    return { ok: false, memories: [], total: 0, query: shownQuery, error: 'Mem0 memory is disabled' }
  }
  const size = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)))
  let start = Math.max(0, Math.floor(Number(offset) || 0))
  const sort = order === 'oldest' ? 'oldest' : 'newest'
  const target = MEMORY_ID.test(String(locate ?? '')) ? String(locate) : ''
  const filters = { user_id: runtime.config.userId }
  try {
    const partitions = libraryPartitions(partition)
    let items = []
    let total = 0
    let totalKnown = true
    let hasMore
    let located
    let mode
    let capped = false
    if (typeof runtime.client.listPage === 'function') {
      mode = 'sql'
      const options = { order: sort, query: shownQuery, ...(partitions ? { partitions } : {}) }
      if (target) {
        const index = await runtime.client.libraryIndexOf(target, filters, options)
        located = index >= 0
        if (located) start = Math.floor(index / size) * size
      }
      const page = await runtime.client.listPage(filters, { ...options, offset: start, limit: size })
      items = Array.isArray(page?.results) ? page.results : []
      total = Number(page?.total) || 0
    } else if (runtime.config.backend === 'platform') {
      if (target || UUID.test(shownQuery)) {
        // By id: the memory alone (the Platform cannot say which page it is on).
        mode = 'id'
        const memory = await ownMemory(runtime, target || shownQuery)
        items = memory ? [memory] : []
        total = items.length
        start = 0
        if (target) located = items.length > 0
      } else if (shownQuery) {
        mode = 'semantic'
        const topK = Math.min(100, start + size)
        const result = await runtime.client.search(shownQuery, filters, { topK, timeoutMs: 8_000 })
        const hits = (Array.isArray(result?.results) ? result.results : []).filter((memory) => inLibraryPartitions(memory, partitions))
        total = hits.length
        items = hits.slice(start, start + size)
      } else {
        mode = 'pages'
        const pageSize = Math.min(200, size)
        const page = Math.floor(start / pageSize) + 1
        start = (page - 1) * pageSize
        const result = await runtime.client.list(filters, { page, pageSize, timeoutMs: 8_000 })
        items = (Array.isArray(result?.results) ? result.results : []).filter((memory) => inLibraryPartitions(memory, partitions))
        hasMore = Boolean(result?.hasNext)
        if (Number.isFinite(result?.count)) total = Number(result.count)
        else {
          // No total from the Platform: the page offers "next" only.
          totalKnown = false
          total = null
        }
      }
    } else {
      mode = 'cached'
      const all = await cachedLibrary(runtime)
      capped = all.length >= LIBRARY_CACHE_CAP
      const needle = shownQuery.toLowerCase()
      const matches = all
        .filter((memory) => inLibraryPartitions(memory, partitions))
        .filter((memory) => !needle || String(memory?.memory ?? memory?.text ?? '').toLowerCase().includes(needle) || String(memory?.id ?? '').toLowerCase().includes(needle))
        .sort(byCreated(sort))
      if (target) {
        const index = matches.findIndex((memory) => String(memory?.id) === target)
        located = index >= 0
        if (located) start = Math.floor(index / size) * size
      }
      total = matches.length
      items = matches.slice(start, start + size)
    }
    const original = items.map(sanitizeMemory)
    let translated = original.map((memory) => memory.memory)
    if (runtime.localizer && lang && translated.length > 0) {
      translated = await runtime.localizer.translate(translated, lang)
    }
    const pinnable = typeof runtime.client.setAttributes === 'function'
    const scopable = typeof runtime.client.setScope === 'function'
    const memories = original.map((memory, index) => ({
      ...memory,
      pinnable,
      // Only a project memory can be made global (P3: no other moves).
      globalizable: scopable && memory.scope === 'project',
      memory: translated[index] || memory.memory,
    }))
    if (hasMore === undefined) hasMore = totalKnown && start + memories.length < total
    return {
      ok: true,
      memories,
      total,
      totalKnown,
      hasMore,
      offset: start,
      limit: size,
      order: sort,
      mode,
      ...(capped ? { capped: true } : {}),
      ...(located !== undefined ? { located } : {}),
      query: shownQuery,
      partition: String(partition ?? ''),
    }
  } catch (error) {
    return {
      ok: false,
      memories: [],
      total: 0,
      query: shownQuery,
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
    }
  }
}

async function localizeActivity(runtime, activity, lang) {
  const clean = sanitizeActivity(activity)
  const recallRows = clean.recall?.preview ?? []
  const captureRows = clean.capture?.preview ?? []
  const lastRows = clean.lastWrite?.preview ?? []
  if (!runtime?.localizer || !lang || (recallRows.length === 0 && captureRows.length === 0 && lastRows.length === 0)) return clean
  // One call: the recall rows, then each capture and last-write row's text and old text.
  const texts = [...recallRows.map((item) => item.memory)]
  const slotsFor = (rows) => rows.map((item) => {
    const slot = { memory: texts.push(item.memory) - 1 }
    if (item.previous) slot.previous = texts.push(item.previous) - 1
    return slot
  })
  const slots = slotsFor(captureRows)
  const lastSlots = slotsFor(lastRows)
  const translated = await runtime.localizer.translate(texts, lang)
  const translatedRows = (rows, rowSlots) => rows.map((item, index) => {
    const slot = rowSlots[index]
    const row = { ...item, memory: translated[slot.memory] || item.memory }
    if (slot.previous !== undefined) row.previous = translated[slot.previous] || item.previous
    return row
  })
  const out = { ...clean }
  if (recallRows.length > 0) {
    out.recall = {
      ...clean.recall,
      preview: recallRows.map((item, index) => ({ ...item, memory: translated[index] || item.memory })),
    }
  }
  if (captureRows.length > 0) {
    out.capture = { ...clean.capture, preview: translatedRows(captureRows, slots) }
  }
  if (lastRows.length > 0) out.lastWrite = { ...clean.lastWrite, preview: translatedRows(lastRows, lastSlots) }
  return out
}

async function readStatus(runtime, { test, lang = '', translate = true } = {}) {
  if (!runtime) {
    return {
      ok: false,
      backend: 'unknown',
      error: 'Mem0 plugin runtime is not ready',
      activity: { recall: null, capture: null, lastWrite: null, maintenance: null },
      failures: [],
      maintenance: null,
      recentMemories: [],
    }
  }
  let profileText = redactSecrets(runtime.maintenance?.profileBlock?.() ?? '').slice(0, 8_000)
  if (translate && runtime.localizer && lang && profileText) {
    const lines = profileText.split('\n')
    const translated = await runtime.localizer.translate(lines, lang)
    profileText = preserveMarkdownPrefixes(lines, translated).join('\n')
  }
  const base = {
    backend: runtime.config.backend,
    ...sanitizeStatus(undefined, runtime.config),
    activity: translate ? await localizeActivity(runtime, runtime.activity, lang) : sanitizeActivity(runtime.activity),
    failures: readFailures(runtime),
    failuresAcknowledgedAt: readAcknowledgedAt(runtime),
    store: readStore(runtime),
    // Key settings the profile lost, and a crash-recovery backup (lib/config-guard.js).
    configWarning: runtime.configGuard?.status?.() ?? null,
    maintenance: runtime.maintenance?.status?.() ?? null,
    profileText,
    translation: runtime.localizer?.diagnostics?.() ?? null,
    recentMemories: [],
    recentMemoriesError: undefined,
    testedAt: new Date().toISOString(),
  }
  if (!runtime.client) {
    return { ...base, ok: false, error: 'Mem0 memory is disabled' }
  }
  const [health, recent] = await Promise.allSettled([
    runtime.client.health({ timeoutMs: test ? 12_000 : 8_000 }),
    readRecentMemories(runtime, { lang: translate ? lang : '' }),
  ])
  const details = health.status === 'fulfilled'
    ? {
        ...base,
        ok: health.value?.ok !== false,
        ...sanitizeStatus(health.value, runtime.config),
      }
    : {
        ...base,
        ok: false,
        error: redactSecrets(health.reason instanceof Error ? health.reason.message : String(health.reason)),
      }
  if (recent.status === 'fulfilled') {
    details.recentMemories = recent.value.memories
    details.recentMemoriesError = recent.value.error
  } else {
    details.recentMemoriesError = redactSecrets(
      recent.reason instanceof Error ? recent.reason.message : String(recent.reason),
    )
  }
  return details
}

async function readActivity(runtime, { lang = '', translate = true, sessionId = '' } = {}) {
  if (!runtime) {
    return {
      ok: false,
      backend: 'unknown',
      enabled: false,
      activity: { recall: null, capture: null, lastWrite: null, maintenance: null },
      failures: [],
    }
  }
  return {
    ok: true,
    backend: runtime.config.backend,
    enabled: runtime.config.enabled !== false,
    // The composer status: whole sentence or short state (MEM0_DOCK_DETAILS wins).
    dockDetails: runtime.config.dockDetails === true,
    activity: translate ? await localizeActivity(runtime, runtime.activity, lang) : sanitizeActivity(runtime.activity),
    failures: readFailures(runtime),
    failuresAcknowledgedAt: readAcknowledgedAt(runtime),
    store: readStore(runtime),
    // Key settings the profile lost, and a crash-recovery backup (lib/config-guard.js).
    configWarning: runtime.configGuard?.status?.() ?? null,
    maintenance: runtime.maintenance?.status?.() ?? null,
    // Where this session's new memories go (the composer chip).
    memoryScope: (await runtime.lifecycle?.memoryScope?.(sessionId)) ?? null,
    at: new Date().toISOString(),
  }
}

/**
 * Register the settings-page routes behind the DSH connection trust fence.
 * @param {object} ctx Cordis plugin context.
 * @param {() => object|undefined} getRuntime Current Mem0 runtime.
 */
export function registerGuiRoutes(ctx, getRuntime) {
  ctx.inject(['webServer', 'connection'], (child) => {
    const reject = (req, res) => {
      const connection = child.get('connection')
      // No trust fence to ask: refuse rather than serve unchecked.
      const rejection = typeof connection?.requestRejection === 'function' ? connection.requestRejection(req) : 503
      if (rejection === undefined) return false
      res.statusCode = rejection
      res.end()
      return true
    }

    const statusHandler = async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      const url = new URL(req.url ?? '/', 'http://localhost')
      const lang = normalizeLanguage(url.searchParams.get('lang'))
      const translate = url.searchParams.get('translate') !== '0'
      sendJson(res, 200, await readStatus(getRuntime(), { test: false, lang, translate }))
    }

    const testHandler = async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      sendJson(res, 200, await readStatus(getRuntime(), { test: true }))
    }

    const activityHandler = async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      const url = new URL(req.url ?? '/', 'http://localhost')
      const lang = normalizeLanguage(url.searchParams.get('lang'))
      const translate = url.searchParams.get('translate') !== '0'
      const session = String(url.searchParams.get('session') ?? '').slice(0, 200)
      sendJson(res, 200, await readActivity(getRuntime(), { lang, translate, sessionId: session }))
    }

    const memoriesHandler = async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'GET' && req.method !== 'DELETE' && req.method !== 'POST') return methodNotAllowed(res, 'GET, DELETE, POST')
      const url = new URL(req.url ?? '/', 'http://localhost')
      // POST { id, pinned }: pin or unpin one memory; { id, scope: 'global' }:
      // move a project memory to global.
      if (req.method === 'POST') {
        try {
          const body = await readJsonBody(req)
          const outcome = body?.scope !== undefined
            ? body.scope === 'global'
              ? await makeGlobal(getRuntime(), body?.id)
              : { status: 400, body: { ok: false, reason: 'bad-request', error: 'a memory can only be moved to global' } }
            : await pinOneMemory(getRuntime(), body?.id, body?.pinned)
          sendJson(res, outcome.status, outcome.body)
        } catch (error) {
          sendJson(res, 502, { ok: false, reason: 'backend', error: redactSecrets(error instanceof Error ? error.message : String(error)) })
        }
        return
      }
      // One memory at a time: `?id=` is required for DELETE, and there is no
      // bulk, clear-all or delete-by-filter form.
      if (req.method === 'DELETE' || url.searchParams.has('id')) {
        try {
          const id = url.searchParams.get('id')
          const outcome = req.method === 'DELETE'
            ? await deleteOneMemory(getRuntime(), id)
            : await describeForDelete(getRuntime(), id)
          sendJson(res, outcome.status, outcome.body)
        } catch (error) {
          sendJson(res, 502, {
            ok: false,
            reason: 'backend',
            error: redactSecrets(error instanceof Error ? error.message : String(error)),
          })
        }
        return
      }
      if (url.searchParams.has('tree')) {
        sendJson(res, 200, await readTree(getRuntime()))
        return
      }
      if (url.searchParams.has('ids')) {
        sendJson(res, 200, await lookupMemories(getRuntime(), url.searchParams.get('ids')))
        return
      }
      const query = String(url.searchParams.get('q') ?? '').slice(0, 200)
      const limit = Number(url.searchParams.get('limit') ?? 100)
      // Paging (PR3): offset into the list, newest or oldest first, and the
      // page holding one memory. Without them the answer is as before.
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const order = url.searchParams.get('order') === 'oldest' ? 'oldest' : 'newest'
      const locate = String(url.searchParams.get('locate') ?? '').slice(0, 128)
      const lang = normalizeLanguage(url.searchParams.get('lang'))
      const partition = String(url.searchParams.get('partition') ?? '').slice(0, 160)
      sendJson(res, 200, await readMemories(getRuntime(), { query, limit, offset, order, lang, partition, locate }))
    }

    const profileHandler = async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      const runtime = getRuntime()
      if (!runtime?.maintenance) {
        sendJson(res, 200, { ok: false, error: 'Memory summary is not available' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const status = body?.reset === true
          ? await runtime.maintenance.resetProfile()
          : runtime.maintenance.setProfileText(body?.text ?? '')
        sendJson(res, 200, {
          ok: true,
          maintenance: status,
          profileText: runtime.maintenance.profileBlock(),
        })
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          error: redactSecrets(error instanceof Error ? error.message : String(error)),
          maintenance: runtime.maintenance.status(),
        })
      }
    }

    const hygieneHandler = async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      const runtime = getRuntime()
      if (!runtime?.maintenance) {
        sendJson(res, 200, { ok: false, error: 'Memory maintenance is not available' })
        return
      }
      try {
        // `{ dryRun: true }` returns the plan (what a run would delete, with
        // a planId) without touching Mem0 or the state file. The real run
        // must name that planId plus an idempotency key: it deletes only the
        // plan's ids, once; a resend gets the first result back.
        const body = typeof req?.[Symbol.asyncIterator] === 'function' ? await readJsonBody(req) : {}
        const report = body?.dryRun === true
          ? await runtime.maintenance.run('manual', { dryRun: true })
          : await runtime.maintenance.runPlan({ planId: body?.planId, idempotencyKey: body?.idempotencyKey })
        sendJson(res, 200, {
          ok: true,
          report,
          maintenance: runtime.maintenance.status(),
        })
      } catch (error) {
        const planError = PLAN_ERRORS.has(error?.code)
        sendJson(res, planError ? 409 : 200, {
          ok: false,
          ...(planError ? { reason: error.code } : {}),
          error: redactSecrets(error instanceof Error ? error.message : String(error)),
          maintenance: runtime.maintenance.status(),
        })
      }
    }

    // The setup wizard and the Qdrant migration (lib/setup-routes.js).
    const setupHandler = async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, 'GET, POST')
      try {
        if (req.method === 'GET') {
          const url = new URL(req.url ?? '/', 'http://localhost')
          if (url.searchParams.has('job')) {
            const job = jobStatus(url.searchParams.get('job'))
            sendJson(res, job ? 200 : 404, job ? { ok: true, job } : { ok: false, error: 'unknown job' })
            return
          }
          sendJson(res, 200, await setupState(ctx, getRuntime()))
          return
        }
        // This route can store keys and send them to a server: JSON from the
        // settings page itself only (no form or text/plain cross-site post).
        const refused = setupPostRefusal(req)
        if (refused) {
          sendJson(res, refused.status, { ok: false, error: refused.error })
          return
        }
        const body = await readJsonBody(req)
        sendJson(res, 200, await handleSetupAction(ctx, getRuntime(), body))
      } catch (error) {
        sendJson(res, 200, { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) })
      }
    }

    // GET: the pending crash-recovery backup's dsh-mem0 entry; POST
    // { action: 'saved' } (copy into oss.json) or { action: 'handled' }.
    const profilePatchHandler = async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, 'GET, POST')
      try {
        if (req.method === 'GET') {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const outcome = readBackupForRestore(getRuntime(), url.searchParams.get('file') ?? '')
          sendJson(res, outcome.status, outcome.body)
          return
        }
        const refused = setupPostRefusal(req)
        if (refused) {
          sendJson(res, refused.status, { ok: false, error: refused.error })
          return
        }
        const body = await readJsonBody(req)
        if (body?.action === 'saved') {
          sendJson(res, 200, handleSettingsSaved(getRuntime(), body, { logger: ctx.logger }))
          return
        }
        if (body?.action === 'handled') {
          const outcome = handleBackupHandled(getRuntime(), body)
          sendJson(res, outcome.status, outcome.body)
          return
        }
        sendJson(res, 400, { ok: false, reason: 'bad-request', error: 'action must be "saved" or "handled"' })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) })
      }
    }

    // POST { action: 'acknowledge', at }: "Got it" on the failure banner.
    const failuresHandler = async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      try {
        const refused = setupPostRefusal(req)
        if (refused) {
          sendJson(res, refused.status, { ok: false, error: refused.error })
          return
        }
        const body = await readJsonBody(req)
        if (body?.action === 'acknowledge') {
          const outcome = handleFailuresAcknowledged(getRuntime(), body)
          sendJson(res, outcome.status, outcome.body)
          return
        }
        sendJson(res, 400, { ok: false, reason: 'bad-request', error: 'action must be "acknowledge"' })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) })
      }
    }

    child.effect(
      () => child.webServer.register({ kind: 'exact', path: GUI_FAILURES_PATH, handler: failuresHandler }),
      `dsh-mem0: POST ${GUI_FAILURES_PATH}`,
    )
    child.effect(
      () => child.webServer.register({ kind: 'exact', path: GUI_PROFILE_PATCH_PATH, handler: profilePatchHandler }),
      `dsh-mem0: GET/POST ${GUI_PROFILE_PATCH_PATH}`,
    )
    child.effect(
      () => child.webServer.register({ kind: 'exact', path: GUI_SETUP_PATH, handler: setupHandler }),
      `dsh-mem0: GET/POST ${GUI_SETUP_PATH}`,
    )
    child.effect(
      () => child.webServer.register({ kind: 'exact', path: GUI_STATUS_PATH, handler: statusHandler }),
      `dsh-mem0: GET ${GUI_STATUS_PATH}`,
    )
    child.effect(
      () => child.webServer.register({ kind: 'exact', path: GUI_TEST_PATH, handler: testHandler }),
      `dsh-mem0: POST ${GUI_TEST_PATH}`,
    )
    child.effect(
      () => child.webServer.register({ kind: 'exact', path: GUI_ACTIVITY_PATH, handler: activityHandler }),
      `dsh-mem0: GET ${GUI_ACTIVITY_PATH}`,
    )
    child.effect(
      () => child.webServer.register({ kind: 'exact', path: GUI_MEMORIES_PATH, handler: memoriesHandler }),
      `dsh-mem0: GET/DELETE ${GUI_MEMORIES_PATH}`,
    )
    child.effect(
      () => child.webServer.register({ kind: 'exact', path: GUI_PROFILE_PATH, handler: profileHandler }),
      `dsh-mem0: POST ${GUI_PROFILE_PATH}`,
    )
    child.effect(
      () => child.webServer.register({ kind: 'exact', path: GUI_HYGIENE_PATH, handler: hygieneHandler }),
      `dsh-mem0: POST ${GUI_HYGIENE_PATH}`,
    )
  })
}

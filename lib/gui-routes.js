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
import { normalizeLanguage, preserveMarkdownPrefixes } from './memory-localizer.js'
import { redactLogText } from './failure-history.js'
import { assertOwned } from './tools.js'
import { isOwnMemory } from './memory-maintenance.js'

export const GUI_STATUS_PATH = '/dsh-mem0/gui/status'
export const GUI_TEST_PATH = '/dsh-mem0/gui/test'
export const GUI_ACTIVITY_PATH = '/dsh-mem0/gui/activity'
export const GUI_HYGIENE_PATH = '/dsh-mem0/gui/hygiene'
export const GUI_MEMORIES_PATH = '/dsh-mem0/gui/memories'
export const GUI_PROFILE_PATH = '/dsh-mem0/gui/profile'
export const GUI_SIDECAR_LOG_PATH = '/dsh-mem0/gui/sidecar-log'

const PLAN_ERRORS = new Set(['plan-required', 'plan-unknown', 'plan-conflict', 'plan-scope'])

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
    collection: status?.collection ?? config.collectionName,
    user: status?.userId ?? config.userId,
    agent: status?.agentId ?? config.agentId,
    apiKeyConfigured: Boolean(config.apiKey),
    // Where the key and backend came from, so the page can say plainly when
    // an inherited environment variable sent memories to the cloud.
    apiKeySource: config.apiKeySource ?? (config.apiKey ? 'config' : 'none'),
    apiKeyEnv: config.apiKeyEnv,
    backendSource: config.backendSource ?? 'configured',
    backendChoice: describeBackendChoice(config),
  }
  if (status?.pythonVersion || status?.mem0Version) {
    details.pythonVersion = status?.pythonVersion
    details.mem0Version = status?.mem0Version
  }
  if (status?.qdrant) details.qdrant = { ok: Boolean(status.qdrant.ok), error: status.qdrant.error }
  if (status?.embedder) {
    details.embedder = {
      ok: Boolean(status.embedder.ok),
      dimensions: status.embedder.dimensions,
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

function sanitizeActivity(activity) {
  const clean = (value) => {
    if (!value) return null
    return {
      ...value,
      error: value.error ? redactSecrets(String(value.error)) : undefined,
      firstError: value.firstError ? redactSecrets(String(value.firstError)) : undefined,
      trippedBy: value.trippedBy
        ? { ...value.trippedBy, message: redactSecrets(String(value.trippedBy.message ?? '')) }
        : undefined,
      preview: sanitizeRecallPreview(value.preview),
    }
  }
  return {
    recall: clean(activity?.recall),
    capture: clean(activity?.capture),
    maintenance: clean(activity?.maintenance),
  }
}

/**
 * OSS sidecar process status (PID, start time, restarts, last exit) and
 * where its log is; null for REST backends.
 */
function readSidecar(runtime) {
  if (runtime?.config?.backend !== 'oss') return null
  let status = null
  try {
    status = runtime.client?.status?.() ?? null
  } catch {
    status = null
  }
  const file = runtime.sidecarLog?.filePath
  return {
    ...(status ?? { running: false, pid: null, restarts: 0, lastExit: null }),
    logPath: file ? redactLogText(file) : null,
  }
}

/** Recent failures, newest first; entries are already redacted when stored. */
function readFailures(runtime) {
  try {
    return runtime?.failures?.list?.() ?? []
  } catch {
    return []
  }
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
  }
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

async function readMemories(runtime, { query = '', limit = 100, lang = '' } = {}) {
  if (!runtime?.client) {
    return { ok: false, memories: [], total: 0, query, error: 'Mem0 memory is disabled' }
  }
  try {
    const result = await runtime.client.list(
      { user_id: runtime.config.userId },
      { topK: 1000, timeoutMs: 8_000 },
    )
    const original = (Array.isArray(result?.results) ? result.results : []).map(sanitizeMemory)
    let translated = original.map((memory) => memory.memory)
    if (runtime.localizer && lang) {
      translated = await runtime.localizer.translate(translated, lang)
    }
    const all = original.map((memory, index) => ({
      ...memory,
      originalMemory: memory.memory,
      memory: translated[index] || memory.memory,
    }))
    const needle = String(query ?? '').trim().toLowerCase()
    const filtered = needle
      ? all.filter(
          (memory) =>
            memory.memory.toLowerCase().includes(needle) ||
            memory.originalMemory.toLowerCase().includes(needle) ||
            String(memory.id ?? '').toLowerCase().includes(needle),
        )
      : all
    const bounded = Math.min(500, Math.max(1, Number(limit) || 100))
    return {
      ok: true,
      memories: filtered.slice(0, bounded).map(({ originalMemory, ...memory }) => memory),
      total: filtered.length,
      query: String(query ?? '').trim().slice(0, 200),
    }
  } catch (error) {
    return {
      ok: false,
      memories: [],
      total: 0,
      query: String(query ?? '').trim().slice(0, 200),
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
    }
  }
}

async function localizeActivity(runtime, activity, lang) {
  const clean = sanitizeActivity(activity)
  if (!runtime?.localizer || !lang || !clean.recall?.preview?.length) return clean
  const translated = await runtime.localizer.translate(
    clean.recall.preview.map((item) => item.memory),
    lang,
  )
  return {
    ...clean,
    recall: {
      ...clean.recall,
      preview: clean.recall.preview.map((item, index) => ({
        ...item,
        memory: translated[index] || item.memory,
      })),
    },
  }
}

async function readStatus(runtime, { test, lang = '', translate = true } = {}) {
  if (!runtime) {
    return {
      ok: false,
      backend: 'unknown',
      error: 'Mem0 plugin runtime is not ready',
      activity: { recall: null, capture: null, maintenance: null },
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
    sidecar: readSidecar(runtime),
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

async function readActivity(runtime, { lang = '', translate = true } = {}) {
  if (!runtime) {
    return {
      ok: false,
      backend: 'unknown',
      enabled: false,
      activity: { recall: null, capture: null, maintenance: null },
      failures: [],
    }
  }
  return {
    ok: true,
    backend: runtime.config.backend,
    enabled: runtime.config.enabled !== false,
    activity: translate ? await localizeActivity(runtime, runtime.activity, lang) : sanitizeActivity(runtime.activity),
    failures: readFailures(runtime),
    sidecar: readSidecar(runtime),
    maintenance: runtime.maintenance?.status?.() ?? null,
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
      const rejection = connection?.requestRejection?.(req)
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
      sendJson(res, 200, await readActivity(getRuntime(), { lang, translate }))
    }

    // The last lines of sidecar.log, redacted again, for "copy last lines".
    const sidecarLogHandler = async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      const url = new URL(req.url ?? '/', 'http://localhost')
      const runtime = getRuntime()
      const log = runtime?.sidecarLog
      if (!log) {
        sendJson(res, 200, { ok: false, lines: [], error: 'No sidecar log: the backend is not oss' })
        return
      }
      const count = Math.max(1, Math.min(500, Number(url.searchParams.get('lines') ?? 50) || 50))
      sendJson(res, 200, {
        ok: true,
        path: log.filePath ? redactLogText(log.filePath) : null,
        lines: log.tail(count).map((line) => redactLogText(line)),
      })
    }

    const memoriesHandler = async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'GET' && req.method !== 'DELETE') return methodNotAllowed(res, 'GET, DELETE')
      const url = new URL(req.url ?? '/', 'http://localhost')
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
      const query = String(url.searchParams.get('q') ?? '').slice(0, 200)
      const limit = Number(url.searchParams.get('limit') ?? 100)
      const lang = normalizeLanguage(url.searchParams.get('lang'))
      sendJson(res, 200, await readMemories(getRuntime(), { query, limit, lang }))
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
      () => child.webServer.register({ kind: 'exact', path: GUI_SIDECAR_LOG_PATH, handler: sidecarLogHandler }),
      `dsh-mem0: GET ${GUI_SIDECAR_LOG_PATH}`,
    )
    child.effect(
      () => child.webServer.register({ kind: 'exact', path: GUI_HYGIENE_PATH, handler: hygieneHandler }),
      `dsh-mem0: POST ${GUI_HYGIENE_PATH}`,
    )
  })
}

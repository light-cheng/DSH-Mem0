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

export const GUI_STATUS_PATH = '/dsh-mem0/gui/status'
export const GUI_TEST_PATH = '/dsh-mem0/gui/test'
export const GUI_ACTIVITY_PATH = '/dsh-mem0/gui/activity'
export const GUI_HYGIENE_PATH = '/dsh-mem0/gui/hygiene'
export const GUI_MEMORIES_PATH = '/dsh-mem0/gui/memories'

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
      preview: sanitizeRecallPreview(value.preview),
    }
  }
  return {
    recall: clean(activity?.recall),
    capture: clean(activity?.capture),
    maintenance: clean(activity?.maintenance),
  }
}

function sanitizeMemory(memory) {
  return {
    id: memory?.id ?? null,
    memory: redactSecrets(String(memory?.memory ?? memory?.text ?? '')).slice(0, 500),
    createdAt: memory?.created_at ?? memory?.createdAt ?? null,
    updatedAt: memory?.updated_at ?? memory?.updatedAt ?? null,
    score: typeof memory?.score === 'number' ? memory.score : undefined,
  }
}

async function readRecentMemories(runtime) {
  try {
    const result = await runtime.client.list(
      { user_id: runtime.config.userId },
      { topK: 5, timeoutMs: 8_000 },
    )
    return {
      memories: (Array.isArray(result?.results) ? result.results : []).map(sanitizeMemory),
      error: undefined,
    }
  } catch (error) {
    return {
      memories: [],
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
    }
  }
}

async function readMemories(runtime, { query = '', limit = 100 } = {}) {
  if (!runtime?.client) {
    return { ok: false, memories: [], total: 0, query, error: 'Mem0 memory is disabled' }
  }
  try {
    const result = await runtime.client.list(
      { user_id: runtime.config.userId },
      { topK: 1000, timeoutMs: 8_000 },
    )
    const all = (Array.isArray(result?.results) ? result.results : []).map(sanitizeMemory)
    const needle = String(query ?? '').trim().toLowerCase()
    const filtered = needle
      ? all.filter(
          (memory) =>
            memory.memory.toLowerCase().includes(needle) ||
            String(memory.id ?? '').toLowerCase().includes(needle),
        )
      : all
    const bounded = Math.min(500, Math.max(1, Number(limit) || 100))
    return {
      ok: true,
      memories: filtered.slice(0, bounded),
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

async function readStatus(runtime, { test }) {
  if (!runtime) {
    return {
      ok: false,
      backend: 'unknown',
      error: 'Mem0 plugin runtime is not ready',
      activity: { recall: null, capture: null, maintenance: null },
      maintenance: null,
      recentMemories: [],
    }
  }
  const base = {
    backend: runtime.config.backend,
    ...sanitizeStatus(undefined, runtime.config),
    activity: sanitizeActivity(runtime.activity),
    maintenance: runtime.maintenance?.status?.() ?? null,
    recentMemories: [],
    recentMemoriesError: undefined,
    testedAt: new Date().toISOString(),
  }
  if (!runtime.client) {
    return { ...base, ok: false, error: 'Mem0 memory is disabled' }
  }
  const [health, recent] = await Promise.allSettled([
    runtime.client.health({ timeoutMs: test ? 12_000 : 8_000 }),
    readRecentMemories(runtime),
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

function readActivity(runtime) {
  if (!runtime) {
    return {
      ok: false,
      backend: 'unknown',
      enabled: false,
      activity: { recall: null, capture: null, maintenance: null },
    }
  }
  return {
    ok: true,
    backend: runtime.config.backend,
    enabled: runtime.config.enabled !== false,
    activity: sanitizeActivity(runtime.activity),
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
      sendJson(res, 200, await readStatus(getRuntime(), { test: false }))
    }

    const testHandler = async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      sendJson(res, 200, await readStatus(getRuntime(), { test: true }))
    }

    const activityHandler = async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      sendJson(res, 200, readActivity(getRuntime()))
    }

    const memoriesHandler = async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      const url = new URL(req.url ?? '/', 'http://localhost')
      const query = String(url.searchParams.get('q') ?? '').slice(0, 200)
      const limit = Number(url.searchParams.get('limit') ?? 100)
      sendJson(res, 200, await readMemories(getRuntime(), { query, limit }))
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
        const report = await runtime.maintenance.run('manual')
        sendJson(res, 200, {
          ok: true,
          report,
          maintenance: runtime.maintenance.status(),
        })
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
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
      `dsh-mem0: GET ${GUI_MEMORIES_PATH}`,
    )
    child.effect(
      () => child.webServer.register({ kind: 'exact', path: GUI_HYGIENE_PATH, handler: hygieneHandler }),
      `dsh-mem0: POST ${GUI_HYGIENE_PATH}`,
    )
  })
}

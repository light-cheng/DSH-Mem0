/**
 * `/dsh-mem0/gui/setup`: the settings page's setup wizard and Qdrant
 * migration (lib/setup-wizard.js, lib/qdrant-migration.js).
 *
 * GET  → wizard state: the current local settings (no keys), which
 *        credential names are set, the store, whether an earlier Qdrant
 *        setup was found, and the migration record of the store.
 * GET ?job=<id> → progress of a migration or re-embedding job.
 * POST { action, … } → probe | listModels | testEmbedder | testLlm |
 *        checkStore | selfTest | save | reembed | migratePreflight |
 *        migrate.
 *
 * Keys the user types (`keys.embedder`, `keys.llm`) are used for the test
 * calls and, on `save`, stored in DSH credentials under the draft's
 * `*ApiKeyRef`; they are never logged, echoed, or written to oss.json.
 */
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { describeCredential, resolveSecret, storeCredential } from './credentials.js'
import { DEFAULT_OSS_CONFIG, OSS_CONFIG_INVALID, qdrantMode, readOssConfig, resolveNativeSettings } from './oss-config.js'
import { migrate, preflight, canCopyVectors, MigrationError } from './qdrant-migration.js'
import { redactSecrets } from './redact.js'
import { MIGRATION_META_KEY, SqliteStore, displayPath } from './store-sqlite.js'
import { Mem0NativeClient } from './native-client.js'
import {
  CLOUD_EMBEDDERS,
  DEFAULT_EMBEDDER_KEY_REF,
  DEFAULT_LLM_KEY_REF,
  LOCAL_EMBEDDING_MODELS,
  SELFTEST_USER_ID,
  WIZARD_FIELDS,
  checkStoreLocation,
  draftFields,
  draftSettings,
  listModels,
  probeLocalServices,
  runSelfTest,
  testEmbedder,
  testLlm,
  writeOssSettings,
} from './setup-wizard.js'

const jobs = new Map()
const MAX_JOBS = 8

function errorText(error) {
  return redactSecrets(String(error?.message ?? error)).slice(0, 500)
}

function ossPath(runtime) {
  return runtime?.config?.ossConfigPath || DEFAULT_OSS_CONFIG
}

function readMarker(file) {
  if (!file || !fs.existsSync(file)) return null
  const store = new SqliteStore({ filePath: file })
  try {
    store.open()
    const value = store.getMeta(MIGRATION_META_KEY)
    const count = store.count({})
    const parsed = value ? JSON.parse(value) : null
    return { migration: parsed, memoryCount: count, embedder: store.embedderInfo() ?? null }
  } catch {
    return null
  } finally {
    store.close()
  }
}

/** The page's wizard state (no keys, home shown as ~). */
export async function setupState(ctx, runtime) {
  const file = ossPath(runtime)
  const raw = readOssConfig(file)
  const invalid = raw?.[OSS_CONFIG_INVALID] ?? null
  const native = runtime?.config?.native
  const storePath = native?.storePath ?? runtime?.config?.storePath
  const mode = invalid ? { mode: 'unknown' } : qdrantMode(raw)
  const embedderRef = native?.embedder?.apiKeyRef || DEFAULT_EMBEDDER_KEY_REF
  const llmRef = native?.llm?.apiKeyRef || DEFAULT_LLM_KEY_REF
  const [embedderKey, llmKey] = await Promise.all([describeCredential(ctx, embedderRef), describeCredential(ctx, llmRef)])
  const store = readMarker(storePath)
  const profileFields = runtime?.config?.profileFields ?? []
  return {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    backend: runtime?.config?.backend ?? 'unknown',
    ossConfig: { path: displayPath(file), exists: fs.existsSync(file), invalid: invalid ? redactSecrets(invalid) : null },
    current: native
      ? {
          storePath: displayPath(native.storePath),
          embedder: { ...native.embedder },
          llm: { ...native.llm },
          problems: native.problems ?? [],
        }
      : null,
    credentials: {
      service: embedderKey !== undefined,
      embedder: { ref: embedderRef, ...(embedderKey ?? { configured: false, writable: false }) },
      llm: { ref: llmRef, ...(llmKey ?? { configured: false, writable: false }) },
    },
    // Wizard fields the profile sets itself: they win over oss.json.
    shadowed: profileFields.filter((key) => WIZARD_FIELDS.includes(key)),
    store: store ? { path: displayPath(storePath), memoryCount: store.memoryCount, embedder: store.embedder } : storePath ? { path: displayPath(storePath), memoryCount: 0, embedder: null } : null,
    legacy: {
      detected: mode.mode === 'server' || mode.mode === 'embedded',
      mode: mode.mode,
      endpoint: mode.endpoint ?? null,
      collection: mode.mode === 'server' ? mode.collection ?? runtime?.config?.collectionName ?? 'dsh_mem0' : runtime?.config?.collectionName ?? 'dsh_mem0',
      oldModel: typeof raw?.oss?.embedder?.config?.model === 'string' ? raw.oss.embedder.config.model : null,
    },
    migration: store?.migration
      ? { at: store.migration.at ?? null, endpoint: store.migration.endpoint ?? null, collection: store.migration.collection ?? null, imported: Number(store.migration.imported ?? 0), vectors: store.migration.vectors ?? null }
      : null,
    userId: runtime?.config?.userId ?? null,
    selftestUserId: SELFTEST_USER_ID,
    recommendations: { cloud: CLOUD_EMBEDDERS, local: LOCAL_EMBEDDING_MODELS },
    refs: { embedder: DEFAULT_EMBEDDER_KEY_REF, llm: DEFAULT_LLM_KEY_REF },
  }
}

/**
 * The key for one component: what the user typed, else the credential the
 * draft names, else oss.json's literal key when the draft talks to the
 * same server (`useLiteralKey`).
 */
async function keyFor(ctx, runtime, component, draft, keys, logger) {
  const typed = typeof keys?.[component] === 'string' ? keys[component].trim() : ''
  if (typed) return typed
  const block = draft?.[component] ?? {}
  const ref = typeof block.apiKeyRef === 'string' ? block.apiKeyRef.trim() : ''
  if (ref) {
    const value = await resolveSecret(ctx, ref, { logger })
    if (value) return value
  }
  if (draft?.useLiteralKey?.[component] === true) {
    const file = resolveNativeSettings({}, readOssConfig(ossPath(runtime)))
    const literal = file?.[component]
    if (literal?.apiKey && literal.baseUrl === String(block.baseUrl ?? '').trim().replace(/\/+$/, '')) return literal.apiKey
  }
  return undefined
}

function startJob(kind, run) {
  for (const [id, job] of jobs) {
    if (job.state === 'running' && job.kind === kind) return { id, already: true }
    if (jobs.size >= MAX_JOBS && job.state !== 'running') jobs.delete(id)
  }
  const id = randomUUID()
  const job = { id, kind, state: 'running', progress: null, result: null, error: null, startedAt: new Date().toISOString() }
  jobs.set(id, job)
  void Promise.resolve()
    .then(() => run((progress) => {
      job.progress = progress
    }))
    .then((result) => {
      job.state = 'done'
      job.result = result
    }, (error) => {
      job.state = 'failed'
      job.error = { message: errorText(error), step: error?.step ?? null, code: error?.code ?? null, ...(error?.hint ? { hint: error.hint } : {}) }
    })
  return { id }
}

/** Progress of a job, or null. */
export function jobStatus(id) {
  const job = jobs.get(String(id ?? ''))
  return job ? { id: job.id, kind: job.kind, state: job.state, progress: job.progress, result: job.result, error: job.error, startedAt: job.startedAt } : null
}

/** Tests: forget all jobs. */
export function resetJobs() {
  jobs.clear()
}

function settingsProblem(settings, components) {
  const problems = (settings.problems ?? []).filter((problem) => components.includes(problem.component))
  return problems.length > 0 ? { ok: false, error: problems.map((problem) => problem.message).join('; '), problems } : null
}

/**
 * Run one wizard action. `options.fetchImpl` and `options.restart` are for
 * tests; `restart` defaults to restarting the plugin's fiber.
 */
export async function handleSetupAction(ctx, runtime, body = {}, { fetchImpl, restart } = {}) {
  const logger = ctx?.logger
  const action = String(body?.action ?? '')
  const draft = body?.draft ?? {}
  const keys = body?.keys ?? {}
  switch (action) {
    case 'probe':
      return { ok: true, services: await probeLocalServices({ fetchImpl }) }
    case 'listModels': {
      const component = body?.component === 'llm' ? 'llm' : 'embedder'
      const block = draft?.[component] ?? {}
      const apiKey = await keyFor(ctx, runtime, component, draft, keys, logger)
      return listModels({ provider: component === 'llm' ? 'openai' : block.provider, baseUrl: block.baseUrl, apiKey, fetchImpl })
    }
    case 'testEmbedder': {
      const settings = draftSettings(draft)
      const problem = settingsProblem(settings, ['embedder'])
      if (problem) return problem
      const apiKey = await keyFor(ctx, runtime, 'embedder', draft, keys, logger)
      const result = await testEmbedder(settings.embedder, { apiKey, fetchImpl, expectedDims: Number(draft?.embedder?.dims) || undefined })
      // Vectors already in the target store: does this embedder match them?
      const store = readMarker(settings.storePath)
      if (result.ok && store?.embedder && store.memoryCount > 0) {
        const differs = (store.embedder.model && store.embedder.model !== settings.embedder.model) || (store.embedder.dims && store.embedder.dims !== result.dims)
        if (differs) result.storeMismatch = { model: store.embedder.model, dims: store.embedder.dims, memories: store.memoryCount }
      }
      return result
    }
    case 'testLlm': {
      const settings = draftSettings(draft)
      const problem = settingsProblem(settings, ['llm'])
      if (problem) return problem
      const apiKey = await keyFor(ctx, runtime, 'llm', draft, keys, logger)
      return testLlm(settings.llm, { apiKey, fetchImpl })
    }
    case 'checkStore':
      return checkStoreLocation(draftSettings(draft).storePath)
    case 'selfTest':
    case 'save': {
      const settings = draftSettings(draft)
      const problem = settingsProblem(settings, ['embedder', 'llm'])
      if (problem) return problem
      const location = checkStoreLocation(settings.storePath)
      if (!location.ok) return { ok: false, step: 'store', error: location.error ?? `the store would be ${location.reason}`, location }
      const embedderKey = await keyFor(ctx, runtime, 'embedder', draft, keys, logger)
      const llmKey = await keyFor(ctx, runtime, 'llm', draft, keys, logger)
      const secrets = new Map([[settings.embedder.apiKeyRef, embedderKey], [settings.llm.apiKeyRef, llmKey]].filter(([ref]) => ref))
      // The self-test uses the draft and the typed keys, before anything is
      // saved: a failure leaves the old configuration as it was.
      const selfTest = await runSelfTest({
        settings: { ...settings, embedder: { ...settings.embedder, apiKey: settings.embedder.apiKeyRef ? '' : embedderKey ?? '' }, llm: { ...settings.llm, apiKey: settings.llm.apiKeyRef ? '' : llmKey ?? '' } },
        resolveSecret: async (ref) => secrets.get(ref),
        fetchImpl,
        logger,
      })
      if (!selfTest.ok || action === 'selfTest') return { ...selfTest, location }
      // Save: typed keys into DSH credentials first, then oss.json.
      const stored = []
      for (const component of ['embedder', 'llm']) {
        const typed = typeof keys?.[component] === 'string' ? keys[component].trim() : ''
        const literal = draft?.useLiteralKey?.[component] === true
        const ref = settings[component].apiKeyRef
        if (!typed && !literal) continue
        if (!ref) return { ok: false, step: 'credentials', error: `a credential name (${component}ApiKeyRef) is needed to store the ${component} key`, selfTest }
        const value = typed || (component === 'embedder' ? embedderKey : llmKey)
        if (!value) continue
        const outcome = await storeCredential(ctx, ref, value, { logger })
        if (!outcome.ok) return { ok: false, step: 'credentials', reason: outcome.reason, ref, error: `the key could not be stored in DSH credentials (${outcome.reason}); add ${ref} in DSH's credential settings yourself, then save again`, selfTest }
        stored.push(ref)
      }
      let written
      try {
        written = writeOssSettings(draftFields(draft), { file: ossPath(runtime) })
      } catch (error) {
        return { ok: false, step: 'write', error: errorText(error), selfTest, storedCredentials: stored }
      }
      logger?.info?.(`dsh-mem0: setup wizard saved ${written.path}${stored.length ? ` (keys stored as ${stored.join(', ')})` : ''}`)
      // Already on the local backend: reload now. Otherwise the page saves
      // backend: oss, which reloads the plugin itself.
      const restarting = runtime?.config?.backend === 'oss'
      if (restarting) {
        const doRestart = restart ?? (() => ctx?.fiber?.restart?.())
        setTimeout(() => {
          void Promise.resolve(doRestart()).catch((error) => logger?.warn?.(`dsh-mem0: could not reload after the wizard: ${error?.message}`))
        }, 50).unref?.()
      }
      return { ok: true, selfTest, location, written, storedCredentials: stored, restarting }
    }
    case 'reembed': {
      const settings = draftSettings(draft)
      const problem = settingsProblem(settings, ['embedder'])
      if (problem) return problem
      const embedderKey = await keyFor(ctx, runtime, 'embedder', draft, keys, logger)
      return {
        ok: true,
        job: startJob('reembed', async (progress) => {
          const client = new Mem0NativeClient({
            config: { userId: SELFTEST_USER_ID, agentId: 'dsh-mem0-wizard' },
            loadSettings: () => ({ ...settings, embedder: { ...settings.embedder, apiKey: embedderKey ?? '' } }),
            resolveSecret: async () => embedderKey,
            fetchImpl,
            logger,
          })
          try {
            return await client.reembed({ onProgress: (done, total) => progress({ phase: 'embed', done, total }) })
          } finally {
            await client.dispose()
          }
        }),
      }
    }
    case 'migratePreflight':
    case 'migrate': {
      if (runtime?.config?.backend !== 'oss' || !runtime?.client) {
        return { ok: false, step: 'preflight', error: 'finish the setup (local backend switched on) before moving memories' }
      }
      const raw = readOssConfig(ossPath(runtime))
      if (raw?.[OSS_CONFIG_INVALID]) return { ok: false, step: 'preflight', error: redactSecrets(raw[OSS_CONFIG_INVALID]) }
      const qdrantApiKey = typeof raw?.oss?.vector_store?.config?.api_key === 'string' ? raw.oss.vector_store.config.api_key : undefined
      const settings = runtime.client.settings()
      const embedderKey = settings.embedder.apiKeyRef ? await resolveSecret(ctx, settings.embedder.apiKeyRef, { logger }) : settings.embedder.apiKey || undefined
      const common = { url: body?.url, collection: body?.collection || runtime.config.collectionName, userId: runtime.config.userId, raw, fetchImpl }
      let pre
      try {
        pre = await preflight({ ...common, apiKey: qdrantApiKey })
      } catch (error) {
        return { ok: false, step: error?.step ?? 'preflight', code: error?.code ?? null, error: errorText(error), ...(error?.hint ? { hint: error.hint } : {}) }
      }
      const probe = await testEmbedder(settings.embedder, { apiKey: embedderKey, fetchImpl })
      if (!probe.ok) return { ok: false, step: 'embedder', error: probe.error, preflight: pre }
      const copyPossible = canCopyVectors({ oldModel: pre.oldModel, oldDims: pre.dims, distance: pre.distance, embedderModel: settings.embedder.model, embedderDims: probe.dims })
      if (action === 'migratePreflight') {
        return { ok: true, preflight: pre, embedder: { model: settings.embedder.model, dims: probe.dims }, copyPossible, store: displayPath(settings.storePath) }
      }
      const copyVectors = body?.copyVectors === true && copyPossible
      return {
        ok: true,
        job: startJob('migrate', async (progress) => {
          const report = await migrate({
            ...common,
            qdrantApiKey,
            storePath: settings.storePath,
            embedder: settings.embedder,
            embedderKey,
            dims: probe.dims,
            copyVectors,
            onProgress: progress,
            logger,
          })
          let summary = { adopted: false }
          try {
            summary = runtime.maintenance?.adoptManualProfile?.({ collection: pre.collection }) ?? summary
          } catch (error) {
            logger?.debug?.(`dsh-mem0: could not carry over the manual summary: ${error?.message}`)
          }
          logger?.info?.(`dsh-mem0: moved ${report.imported} memories from Qdrant ${pre.endpoint} (${pre.collection}) into ${report.store} (${report.mode}, vectors ${report.vectors})`)
          return { ...report, manualSummary: summary.adopted === true }
        }),
      }
    }
    default:
      return { ok: false, error: `unknown action ${JSON.stringify(action.slice(0, 40))}` }
  }
}

export { MigrationError }

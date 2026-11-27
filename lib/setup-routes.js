/**
 * `/dsh-mem0/gui/setup`: the settings page's setup wizard and Qdrant
 * migration (lib/setup-wizard.js, lib/qdrant-migration.js).
 *
 * GET  → wizard state: the current local settings (no keys), which
 *        credential names are set, the store, whether an earlier Qdrant
 *        setup was found, and the migration record of the store.
 * GET ?job=<id> → progress of a migration or re-embedding job.
 * POST { action, … } → probe | dshModel | listModels | testEmbedder | testLlm |
 *        checkStore | selfTest | save | migratePreflight | migrate |
 *        readOmlxKey (on a click: oMLX key read server side, never echoed) |
 *        revealOmlxSettings.
 *
 * Keys the user types (`keys.embedder`, `keys.llm`) are used for the test
 * calls and, on `save`, stored in DSH credentials under the draft's
 * `*ApiKeyRef`; they are never logged, echoed, or written to oss.json.
 * A key already stored is used only for the server it was saved for (same
 * provider and host), and only credential names the wizard owns or the
 * current settings use are read or written.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { describeCredential, resolveSecret, storeCredential } from './credentials.js'
import { DEFAULT_OSS_CONFIG, OSS_CONFIG_INVALID, hostPort, qdrantMode, readOssConfig, resolveNativeSettings } from './oss-config.js'
import { allowedCollections, migrate, preflight, canCopyVectors, qdrantUrl, MigrationError } from './qdrant-migration.js'
import { redactSecrets } from './redact.js'
import { MIGRATION_META_KEY, SqliteStore, displayPath } from './store-sqlite.js'
import { Mem0NativeClient } from './native-client.js'
import { currentDshModel } from './dsh-extraction.js'
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
  readOmlxApiKey,
  revealOmlxSettings,
  runSelfTest,
  serviceAt,
  testEmbedder,
  testLlm,
  writeOssSettings,
} from './setup-wizard.js'

const jobs = new Map()
const MAX_JOBS = 8

/**
 * Keys read from oMLX's settings.json for this wizard (`readOmlxKey`), per
 * component and bound to the server they were read for. They stay in this
 * process: never sent to the page, never logged. They act like a typed key
 * (tests, self-test; on save they go to DSH credentials), then are dropped.
 */
const readKeys = new Map()

/** Tests: forget keys read from oMLX. */
export function resetReadKeys() {
  readKeys.clear()
}

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

function withoutKey(block) {
  const { apiKey, ...rest } = block ?? {}
  return { ...rest, literalKey: Boolean(rest.literalKey || apiKey) }
}

/** DSH's model services `{ llm, agentDefaultModel }`, or null (not injected yet). */
function dshServices(runtime) {
  return runtime?.llmServices?.current ?? null
}

/** `{ available, provider, model, name }` of DSH's current model: names only. */
function dshModelState(runtime) {
  const services = dshServices(runtime)
  const current = currentDshModel(services)
  return current ? { available: true, ...current } : { available: false, reason: services?.llm ? 'no_model' : 'no_service' }
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
  const collections = allowedCollections({ raw: invalid ? null : raw, configured: runtime?.config?.collectionName })
  // Earlier versions may have read another setup than oss.json: a local
  // backend chosen before, or settings only earlier versions had, also
  // point to memories left in Qdrant (the address is then the default).
  const strong = mode.mode === 'server' || mode.mode === 'embedded'
  const possibleReason = strong
    ? null
    : (runtime?.config?.ignoredSettings ?? []).length > 0
      ? 'old-settings'
      : runtime?.config?.backend === 'oss' && (runtime?.config?.backendSource === 'configured' || runtime?.config?.backendSource === 'auto-oss-config')
        ? 'local-backend'
        : null
  let defaultEndpoint = null
  try {
    defaultEndpoint = hostPort(qdrantUrl('', { raw: invalid ? null : raw }))
  } catch {
    defaultEndpoint = null
  }
  return {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    backend: runtime?.config?.backend ?? 'unknown',
    ossConfig: { path: displayPath(file), exists: fs.existsSync(file), invalid: invalid ? redactSecrets(invalid) : null },
    current: native
      ? {
          storePath: displayPath(native.storePath),
          // Never the key itself: whether oss.json holds one, as literalKey.
          embedder: withoutKey(native.embedder),
          llm: withoutKey(native.llm),
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
      detected: strong,
      possible: possibleReason !== null,
      reason: possibleReason,
      mode: mode.mode,
      endpoint: mode.endpoint ?? defaultEndpoint,
      collection: (mode.mode === 'server' && collections.includes(mode.collection) ? mode.collection : null) ?? collections[0] ?? 'dsh_mem0',
      collections,
      oldModel: typeof raw?.oss?.embedder?.config?.model === 'string' ? raw.oss.embedder.config.model : null,
    },
    migration: store?.migration
      ? { at: store.migration.at ?? null, endpoint: store.migration.endpoint ?? null, collection: store.migration.collection ?? null, imported: Number(store.migration.imported ?? 0), vectors: store.migration.vectors ?? null }
      : null,
    jobs: runningJobs(),
    userId: runtime?.config?.userId ?? null,
    selftestUserId: SELFTEST_USER_ID,
    recommendations: { cloud: CLOUD_EMBEDDERS, local: LOCAL_EMBEDDING_MODELS },
    refs: { embedder: DEFAULT_EMBEDDER_KEY_REF, llm: DEFAULT_LLM_KEY_REF },
    dshModel: dshModelState(runtime),
  }
}

/** The settings saved now (what the running client uses), or null. */
function savedSettings(runtime) {
  if (runtime?.config?.native) return runtime.config.native
  try {
    const raw = readOssConfig(ossPath(runtime))
    if (!raw || raw[OSS_CONFIG_INVALID]) return null
    const block = raw.dsh_mem0 && typeof raw.dsh_mem0 === 'object' ? raw.dsh_mem0 : {}
    return resolveNativeSettings(block, raw)
  } catch {
    return null
  }
}

/** `provider|host` of a component's server (the default server when no address is set). */
export function serverOf(component, block) {
  const provider = component === 'llm' ? 'openai' : String(block?.provider || 'openai')
  const base = String(block?.baseUrl ?? '').trim()
  if (!base) return `${provider}|default`
  try {
    return `${provider}|${new URL(base).host.toLowerCase()}`
  } catch {
    return `${provider}|invalid`
  }
}

/**
 * Whether the key stored under the draft's credential name may be used:
 * the same name as the saved settings, for the same provider and host.
 * Changing the server needs the key typed again.
 */
function storedKeyApplies(runtime, component, draft) {
  const saved = savedSettings(runtime)?.[component]
  if (!saved) return false
  const settings = draftSettings(draft)[component]
  const ref = String(settings?.apiKeyRef ?? '')
  return Boolean(ref) && ref === String(saved.apiKeyRef ?? '') && serverOf(component, settings) === serverOf(component, saved)
}

/** Credential names the wizard may read or write: its own, or the one in use. */
function allowedRefs(runtime, component) {
  const own = component === 'llm' ? DEFAULT_LLM_KEY_REF : DEFAULT_EMBEDDER_KEY_REF
  const current = savedSettings(runtime)?.[component]?.apiKeyRef
  return [own, ...(current && current !== own ? [current] : [])]
}

/** The first credential name of the draft the wizard may not use, or null. */
function refProblem(runtime, draft) {
  for (const component of ['embedder', 'llm']) {
    const ref = String(draft?.[component]?.apiKeyRef ?? '').trim()
    if (ref && !allowedRefs(runtime, component).includes(ref)) {
      return { ok: false, step: 'credentials', code: 'REF_NOT_ALLOWED', ref, allowed: allowedRefs(runtime, component), error: `the wizard uses only the credential names ${allowedRefs(runtime, component).join(' or ')} for the ${component}` }
    }
  }
  return null
}

/**
 * The key for one component: what the user typed, else the stored key when
 * it belongs to this server (storedKeyApplies), else oss.json's literal key
 * when the draft talks to the same server (`useLiteralKey`).
 */
async function keyFor(ctx, runtime, component, draft, keys, logger) {
  const typed = typeof keys?.[component] === 'string' ? keys[component].trim() : ''
  if (typed) return typed
  const block = draft?.[component] ?? {}
  const ref = typeof block.apiKeyRef === 'string' ? block.apiKeyRef.trim() : ''
  if (ref && storedKeyApplies(runtime, component, draft)) {
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
  const controller = new AbortController()
  const job = { id, kind, state: 'running', progress: null, result: null, error: null, startedAt: new Date().toISOString(), controller, cancellable: true }
  jobs.set(id, job)
  void Promise.resolve()
    .then(() => run((progress) => {
      job.progress = progress
    }, controller.signal, job))
    .then((result) => {
      job.state = 'done'
      job.result = result
    }, (error) => {
      const cancelled = controller.signal.aborted && error?.code === 'ABORTED'
      job.state = cancelled ? 'cancelled' : 'failed'
      job.error = cancelled
        ? { message: 'cancelled; nothing was changed', step: error?.step ?? null, code: 'CANCELLED' }
        : { message: errorText(error), step: error?.step ?? null, code: error?.code ?? null, ...(error?.hint ? { hint: error.hint } : {}) }
    })
    .finally(() => {
      job.controller = null
    })
  return { id }
}

/**
 * Cancel a running migration or re-embedding job. It stops at its next
 * step and leaves nothing behind (the migration drops its `.importing`
 * file; re-embedding writes no vector). Once the save job has written the
 * new vectors it is no longer cancellable and finishes saving.
 */
export function cancelJob(id) {
  const job = jobs.get(String(id ?? ''))
  if (!job) return { ok: false, code: 'UNKNOWN_JOB', error: 'no such job' }
  if (job.state !== 'running') return { ok: true, state: job.state }
  if (!job.cancellable || !job.controller) return { ok: false, code: 'NOT_CANCELLABLE', error: 'the job is finishing and can no longer be cancelled' }
  job.controller.abort(Object.assign(new Error('cancelled'), { code: 'ABORTED' }))
  return { ok: true, state: 'cancelling' }
}

/** Jobs still running (the page picks them up again after a reload). */
export function runningJobs() {
  return [...jobs.values()].filter((job) => job.state === 'running').map((job) => ({ id: job.id, kind: job.kind, progress: job.progress, startedAt: job.startedAt, cancellable: job.cancellable === true }))
}

function runningJob(kind) {
  for (const job of jobs.values()) if (job.state === 'running' && job.kind === kind) return job
  return null
}

/** Progress of a job, or null. */
export function jobStatus(id) {
  const job = jobs.get(String(id ?? ''))
  return job ? { id: job.id, kind: job.kind, state: job.state, progress: job.progress, result: job.result, error: job.error, startedAt: job.startedAt, cancellable: job.state === 'running' && job.cancellable === true } : null
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
 * Run one wizard action. `options.fetchImpl`, `options.restart` and
 * `options.omlx` (env, home, platform, readText, exists, reveal for the
 * oMLX key) are for tests; `restart` defaults to restarting the plugin's
 * fiber.
 */
export async function handleSetupAction(ctx, runtime, body = {}, { fetchImpl, restart, omlx, ignoreReadKeys = false } = {}) {
  const logger = ctx?.logger
  const action = String(body?.action ?? '')
  const draft = body?.draft ?? {}
  const keys = { ...(body?.keys ?? {}) }
  // A key read from oMLX stands in for a typed one, for the same server
  // only. Not for mem0_setting_set (lib/diagnose-tools.js): it never stores
  // a key, and a key the user read but did not save stays unsaved.
  for (const component of ignoreReadKeys ? [] : ['embedder', 'llm']) {
    const typed = typeof keys[component] === 'string' ? keys[component].trim() : ''
    const read = readKeys.get(component)
    if (!typed && read && read.server === serverOf(component, draft?.[component])) keys[component] = read.key
  }
  if (['listModels', 'testEmbedder', 'testLlm', 'selfTest', 'save'].includes(action)) {
    const problem = refProblem(runtime, draft)
    if (problem) return problem
  }
  switch (action) {
    case 'readOmlxKey': {
      // Only on the user's click, only for an address that is oMLX.
      const component = body?.component === 'llm' ? 'llm' : 'embedder'
      const block = draft?.[component] ?? {}
      if (serviceAt(block.baseUrl, omlx?.platform ?? process.platform)?.id !== 'omlx') {
        return { ok: false, reason: 'not_omlx', error: 'the address is not oMLX (127.0.0.1:8000 on macOS)' }
      }
      const read = readOmlxApiKey(omlx ?? {})
      if (!read.ok) return { ok: false, reason: read.reason, ...(read.code ? { code: read.code } : {}), file: read.file, source: read.source }
      readKeys.set(component, { key: read.key, server: serverOf(component, block) })
      // The page learns that a key was read, never the key.
      return { ok: true, component, file: read.file, source: read.source }
    }
    case 'revealOmlxSettings':
      return revealOmlxSettings(omlx ?? {})
    case 'cancelJob':
      return cancelJob(body?.job)
    case 'dshModel':
      // The model extraction uses with llmProvider 'dsh', read now.
      return { ok: true, dshModel: dshModelState(runtime) }
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
      if (settings.llm.provider === 'dsh') return testLlm(settings.llm, { llmServices: dshServices(runtime) })
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
      const location = checkStoreLocation(settings.storePath, { confirmed: draft?.storeConfirmed === true })
      if (!location.ok) return { ok: false, step: 'store', code: location.needsConfirm ? 'STORE_UNVERIFIED' : 'STORE_REFUSED', error: location.error ?? `the store would be ${location.reason}`, location }
      if (action === 'save' && runningJob('save')) return { ok: true, job: { id: runningJob('save').id, already: true } }
      const embedderKey = await keyFor(ctx, runtime, 'embedder', draft, keys, logger)
      // DSH's current model: DSH holds its key, the wizard never asks for it.
      const followsDsh = settings.llm.provider === 'dsh'
      const llmKey = followsDsh ? undefined : await keyFor(ctx, runtime, 'llm', draft, keys, logger)
      // The store's vectors: a store of another embedder is re-embedded on
      // save, never before (the running setup keeps working meanwhile).
      const probe = await testEmbedder(settings.embedder, { apiKey: embedderKey, fetchImpl })
      if (!probe.ok) return { ok: false, step: 'embedder', error: probe.error, probe, failure: probe.failure, component: 'embedder' }
      const store = readMarker(settings.storePath)
      const reembedCount = store?.embedder && store.memoryCount > 0 && ((store.embedder.model && store.embedder.model !== settings.embedder.model) || (store.embedder.dims && store.embedder.dims !== probe.dims)) ? store.memoryCount : 0
      const secrets = new Map([[settings.embedder.apiKeyRef, embedderKey], [settings.llm.apiKeyRef, llmKey]].filter(([ref]) => ref))
      // The self-test uses the draft and the typed keys, before anything is
      // saved: a failure leaves the old configuration as it was. With
      // vectors to recompute it runs in a temporary store.
      const scratch = reembedCount > 0 ? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-selftest-')) : null
      let selfTest
      try {
        selfTest = await runSelfTest({
          settings: {
            ...settings,
            ...(scratch ? { storePath: path.join(scratch, 'memory.sqlite') } : {}),
            embedder: { ...settings.embedder, apiKey: settings.embedder.apiKeyRef ? '' : embedderKey ?? '' },
            llm: { ...settings.llm, apiKey: settings.llm.apiKeyRef ? '' : llmKey ?? '' },
          },
          resolveSecret: async (ref) => secrets.get(ref),
          fetchImpl,
          logger,
          apiKeys: { embedder: embedderKey, llm: llmKey },
          llmServices: dshServices(runtime),
        })
      } finally {
        if (scratch) {
          try {
            fs.rmSync(scratch, { recursive: true, force: true })
          } catch {
            // a temporary folder; the system cleans it up
          }
        }
      }
      if (reembedCount > 0) selfTest = { ...selfTest, scratchStore: true }
      if (!selfTest.ok || action === 'selfTest') return { ...selfTest, location, reembed: reembedCount }

      // Keys typed for a credential that holds another key already (not the
      // wizard's own) are stored only after the user confirmed it.
      const overwrite = Array.isArray(body?.overwriteRefs) ? body.overwriteRefs.map(String) : []
      for (const component of ['embedder', 'llm']) {
        const typed = typeof keys?.[component] === 'string' ? keys[component].trim() : ''
        const ref = settings[component].apiKeyRef
        if (component === 'llm' && followsDsh) continue
        const own = component === 'llm' ? DEFAULT_LLM_KEY_REF : DEFAULT_EMBEDDER_KEY_REF
        if (!typed || !ref || ref === own || overwrite.includes(ref)) continue
        const described = await describeCredential(ctx, ref)
        if (described?.configured) return { ok: false, step: 'credentials', code: 'REF_EXISTS', ref, error: `${ref} holds a key already; confirm to replace it`, selfTest }
      }

      const commit = async () => {
        if (reembedCount > 0) {
          const client = new Mem0NativeClient({
            config: { userId: SELFTEST_USER_ID, agentId: 'dsh-mem0-wizard' },
            loadSettings: () => ({ ...settings, embedder: { ...settings.embedder, apiKey: embedderKey ?? '' } }),
            resolveSecret: async () => embedderKey,
            fetchImpl,
            logger,
          })
          try {
            await client.reembed({ signal: commit.signal, onProgress: (done, total) => commit.progress?.({ phase: 'reembed', done, total }) })
          } finally {
            await client.dispose()
          }
          // The vectors are written: saving must finish now.
          if (commit.job) commit.job.cancellable = false
        }
        // Typed keys into DSH credentials first, then oss.json.
        const stored = []
        for (const component of ['embedder', 'llm']) {
          const typed = typeof keys?.[component] === 'string' ? keys[component].trim() : ''
          const literal = draft?.useLiteralKey?.[component] === true
          const ref = settings[component].apiKeyRef
          if (component === 'llm' && followsDsh) continue
          if (!typed && !literal) continue
          if (!ref) return { ok: false, step: 'credentials', error: `a credential name (${component}ApiKeyRef) is needed to store the ${component} key`, selfTest }
          const value = typed || (component === 'embedder' ? embedderKey : llmKey)
          if (!value) continue
          const outcome = await storeCredential(ctx, ref, value, { logger })
          if (!outcome.ok) return { ok: false, step: 'credentials', reason: outcome.reason, ref, error: `the key could not be stored in DSH credentials (${outcome.reason}); add ${ref} in DSH's credential settings yourself, then save again`, selfTest }
          stored.push({ component, ref })
        }
        let written
        try {
          written = writeOssSettings(draftFields(draft), { file: ossPath(runtime), dropLiteralKeys: stored.map((item) => item.component) })
        } catch (error) {
          return { ok: false, step: 'write', error: errorText(error), selfTest, storedCredentials: stored.map((item) => item.ref) }
        }
        logger?.info?.(`dsh-mem0: setup wizard saved ${written.path}${stored.length ? ` (keys stored as ${stored.map((item) => item.ref).join(', ')})` : ''}${reembedCount ? ` after recomputing ${reembedCount} vectors` : ''}`)
        // Already on the local backend: reload now. Otherwise the page saves
        // backend: oss, which reloads the plugin itself.
        const restarting = runtime?.config?.backend === 'oss'
        if (restarting) {
          const doRestart = restart ?? (() => ctx?.fiber?.restart?.())
          setTimeout(() => {
            void Promise.resolve(doRestart()).catch((error) => logger?.warn?.(`dsh-mem0: could not reload after the wizard: ${error?.message}`))
          }, 50).unref?.()
        }
        // Stored in DSH credentials now: forget the keys read from oMLX.
        readKeys.clear()
        return { ok: true, selfTest, location, written, storedCredentials: stored.map((item) => item.ref), restarting, reembedded: reembedCount }
      }
      if (reembedCount === 0) return commit()
      // Recomputing can take minutes: a job the page polls.
      return {
        ok: true,
        selfTest,
        reembed: reembedCount,
        job: startJob('save', async (progress, signal, job) => {
          commit.progress = progress
          commit.signal = signal
          commit.job = job
          const result = await commit()
          if (!result.ok) {
            const error = new Error(result.error)
            error.step = result.step
            error.code = result.code ?? null
            throw error
          }
          return result
        }),
      }
    }
    case 'migratePreflight':
    case 'migrate': {
      if (runtime?.config?.backend !== 'oss' || !runtime?.client) {
        return { ok: false, step: 'preflight', code: 'LOCAL_BACKEND_OFF', error: 'finish the setup (local backend switched on) before moving memories' }
      }
      // A migration still running (the page was reloaded): pick it up.
      if (action === 'migrate' && runningJob('migrate')) return { ok: true, job: { id: runningJob('migrate').id, already: true } }
      const raw = readOssConfig(ossPath(runtime))
      if (raw?.[OSS_CONFIG_INVALID]) return { ok: false, step: 'preflight', code: 'CONFIG_INVALID', error: redactSecrets(raw[OSS_CONFIG_INVALID]) }
      const settings = runtime.client.settings()
      const earlier = readMarker(settings.storePath)?.migration ?? null
      if (action === 'migrate' && earlier && body?.again !== true) {
        return { ok: false, step: 'preflight', code: 'ALREADY_MIGRATED', migration: earlier, error: 'this store was migrated already; migrating again brings back memories deleted since' }
      }
      const allowed = allowedCollections({ raw, configured: runtime.config.collectionName })
      const collection = String(body?.collection || qdrantMode(raw).collection || runtime.config.collectionName || 'dsh_mem0').trim()
      // oss.json's Qdrant key goes only to oss.json's Qdrant.
      let sameQdrant = false
      try {
        sameQdrant = hostPort(qdrantUrl(body?.url, { raw })) === hostPort(qdrantUrl('', { raw }))
      } catch {
        sameQdrant = false
      }
      const qdrantApiKey = sameQdrant && typeof raw?.oss?.vector_store?.config?.api_key === 'string' ? raw.oss.vector_store.config.api_key : undefined
      const embedderKey = settings.embedder.apiKeyRef ? await resolveSecret(ctx, settings.embedder.apiKeyRef, { logger }) : settings.embedder.apiKey || undefined
      const common = { url: body?.url, collection, allowed, userId: runtime.config.userId, raw, fetchImpl }
      let pre
      try {
        pre = await preflight({ ...common, apiKey: qdrantApiKey })
      } catch (error) {
        return { ok: false, step: error?.step ?? 'preflight', code: error?.code ?? null, error: errorText(error), ...(error?.hint ? { hint: error.hint } : {}) }
      }
      const probe = await testEmbedder(settings.embedder, { apiKey: embedderKey, fetchImpl })
      if (!probe.ok) return { ok: false, step: 'embedder', code: 'EMBEDDER_FAILED', error: probe.error, preflight: pre }
      const copyPossible = canCopyVectors({ oldModel: pre.oldModel, oldDims: pre.dims, distance: pre.distance, embedderModel: settings.embedder.model, embedderDims: probe.dims })
      if (action === 'migratePreflight') {
        return { ok: true, preflight: pre, embedder: { model: settings.embedder.model, dims: probe.dims }, copyPossible, store: displayPath(settings.storePath), alreadyMigrated: earlier }
      }
      const copyVectors = body?.copyVectors === true && copyPossible
      return {
        ok: true,
        job: startJob('migrate', async (progress, signal, job) => {
          const report = await migrate({
            signal,
            onCommit: () => {
              // Switched over: the migration can no longer be undone.
              job.cancellable = false
            },
            ...common,
            qdrantApiKey,
            storePath: settings.storePath,
            embedder: settings.embedder,
            embedderKey,
            dims: probe.dims,
            copyVectors,
            again: body?.again === true,
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

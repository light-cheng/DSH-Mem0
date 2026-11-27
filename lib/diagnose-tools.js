/**
 * The two tools of a diagnosis session (lib/diagnose-sessions.js):
 *
 * - `mem0_check` (read-only) runs the checks the settings page runs: the
 *   connection test (`/gui/test`), the setup wizard's tests (`/gui/setup`:
 *   probe, listModels, testEmbedder, testLlm, checkStore, selfTest) and a
 *   summary of the open failures. What comes back is redacted: no key, no
 *   memory text, endpoints as `host:port` only.
 * - `mem0_setting_set` changes one setting of a short allow-list, through
 *   the same path the settings page saves with:
 *   - profile fields through DSH's settings service (`ctx.settings.mutate`,
 *     the service the page's `ctx.configForms…mutate` reaches through
 *     `ctx.remote.settings`), then the oss.json copy the page asks for
 *     (`saved`, lib/config-mirror.js);
 *   - the local backend's model servers through the setup wizard's `save`
 *     (self-test first, then oss.json), with the credential names and keys
 *     left as they are.
 *   It asks every time (the gate in lib/diagnose-sessions.js, whatever
 *   "skip confirmation" says), never touches a key or a credential, and
 *   runs the matching check once the plugin has reloaded with the change.
 *
 * Both are offered in diagnosis sessions only: DSH's step-time `when`
 * condition hides them elsewhere, and `execute` refuses outside one too
 * (a DSH without `when` lists them, but they do nothing there).
 */
import { Config, DEFAULT_PLATFORM_BASE_URL } from './config.js'
import { MIRROR_FIELDS, mirrorSavedSettings } from './config-mirror.js'
import { diagnosisFacts, hostPort } from './diagnose-report.js'
import { diagnosticLines } from './diagnostics.js'
import { redactLogText, sanitizeFailureMessage } from './failure-history.js'
import { handleSetupAction, setupState } from './setup-routes.js'

export const CHECK_TOOL = 'mem0_check'
export const SETTING_TOOL = 'mem0_setting_set'
export const DIAGNOSE_TOOLS = Object.freeze([CHECK_TOOL, SETTING_TOOL])
/** The plugin's entry id in the profile (DSH settings namespace). */
export const SETTINGS_NAMESPACE = 'dsh-mem0'

/** What mem0_check can run. */
export const CHECK_TARGETS = Object.freeze(['status', 'connection', 'failures', 'embedder', 'llm', 'models', 'store', 'probe', 'selftest'])
// Targets of the local backend's setup wizard.
const LOCAL_TARGETS = new Set(['embedder', 'llm', 'models', 'store', 'selftest'])

/**
 * The settings mem0_setting_set may change. `via: 'profile'` goes through
 * DSH's settings service, `via: 'wizard'` through the setup wizard's save
 * (local backend only). `check` is the mem0_check target run afterwards.
 * Left out on purpose: keys and credential names (apiKey, apiKeyEnv,
 * *ApiKeyRef), where memories live or whose they are (backend, storePath,
 * userId, agentId, collectionName), and the plugin's own on/off switch.
 */
export const SETTING_FIELDS = Object.freeze({
  autoRecall: { via: 'profile', type: 'boolean', check: 'status' },
  autoCapture: { via: 'profile', type: 'boolean', check: 'status' },
  projectPartitions: { via: 'profile', type: 'boolean', check: 'status', backend: 'oss' },
  profileEnabled: { via: 'profile', type: 'boolean', check: 'status' },
  hygieneEnabled: { via: 'profile', type: 'boolean', check: 'status' },
  captureFilter: { via: 'profile', type: 'enum', values: ['off', 'heuristic'], check: 'status' },
  recallTopK: { via: 'profile', type: 'number', check: 'status' },
  memoryBudgetTokens: { via: 'profile', type: 'number', check: 'status' },
  timeoutMs: { via: 'profile', type: 'number', check: 'connection' },
  recallTimeoutMs: { via: 'profile', type: 'number', check: 'status' },
  addTimeoutMs: { via: 'profile', type: 'number', check: 'status' },
  embedderKeepAlive: { via: 'profile', type: 'duration', check: 'status', backend: 'oss' },
  baseUrl: { via: 'profile', type: 'url', check: 'connection', backend: 'server' },
  embedderBaseUrl: { via: 'wizard', type: 'url', component: 'embedder', key: 'baseUrl', check: 'embedder' },
  embedderModel: { via: 'wizard', type: 'name', component: 'embedder', key: 'model', check: 'embedder' },
  llmBaseUrl: { via: 'wizard', type: 'url', component: 'llm', key: 'baseUrl', check: 'llm' },
  llmModel: { via: 'wizard', type: 'name', component: 'llm', key: 'model', check: 'llm' },
  llmMaxTokens: { via: 'wizard', type: 'number', min: 256, max: 65536, component: 'llm', key: 'maxTokens', check: 'llm' },
  llmReasoningEffort: { via: 'wizard', type: 'enum', values: ['', 'low', 'medium', 'high'], component: 'llm', key: 'reasoningEffort', check: 'llm' },
})
export const SETTING_NAMES = Object.freeze(Object.keys(SETTING_FIELDS))

const MAX_TEXT = 300
const MAX_LIST = 12
// Keys never passed on from a check's result, at any depth.
const DROPPED_KEYS = /api_?key|secret|token|password|authorization|credential|content|text|memor(?:y|ies)|profile|keyTyped|literal/i
// Counts and dims may sit under a dropped-looking key (memoryCount): kept.
const KEPT_KEYS = /^(?:memoryCount|maxTokens|tokens)$/

/** A text with secrets and home paths removed and every URL cut to `host:port`. */
export function scrubText(value, { max = MAX_TEXT } = {}) {
  let text = redactLogText(String(value ?? ''))
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>()]+/gi, (url) => hostPort(url) ?? '[url]')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`
  return text
}

/** A check's result made safe to show the model: see DROPPED_KEYS and scrubText. */
export function scrubResult(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return scrubText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth > 5) return undefined
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_LIST).map((item) => scrubResult(item, depth + 1)).filter((item) => item !== undefined)
    return value.length > MAX_LIST ? [...items, `… ${value.length - MAX_LIST} more`] : items
  }
  if (typeof value !== 'object') return undefined
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    if (DROPPED_KEYS.test(key) && !KEPT_KEYS.test(key)) continue
    // An address field: host:port only.
    if (/^(?:baseUrl|url|endpoint|host)$/i.test(key) && typeof child === 'string') {
      out[key] = hostPort(child) ?? (child ? '[url]' : '')
      continue
    }
    const scrubbed = scrubResult(child, depth + 1)
    if (scrubbed !== undefined) out[key] = scrubbed
  }
  return out
}

function asText(value) {
  return JSON.stringify(scrubResult(value))
}

/**
 * The setup wizard's draft for the settings in use (as the page's
 * emptyWizardDraft builds it): same credential names, so the stored keys
 * apply and never leave the plugin. `changes` `{ embedder: {…}, llm: {…} }`
 * replace single fields.
 */
export function currentDraft(state, changes = {}) {
  const current = state?.current ?? {}
  const embedder = current.embedder ?? {}
  const llm = current.llm ?? {}
  const draft = {
    embedder: {
      provider: embedder.provider || 'openai',
      baseUrl: embedder.baseUrl || '',
      model: embedder.model || '',
      ...(embedder.dims ? { dims: embedder.dims, sendDims: embedder.sendDims === true } : {}),
      apiKeyRef: embedder.apiKeyRef || '',
      ...changes.embedder,
    },
    llm: llm.provider === 'dsh' || (!llm.model && !llm.baseUrl)
      ? { provider: 'dsh', ...(llm.maxTokens ? { maxTokens: llm.maxTokens } : {}), ...changes.llm }
      : {
          provider: 'openai',
          baseUrl: llm.baseUrl || '',
          model: llm.model || '',
          apiKeyRef: llm.apiKeyRef || '',
          ...(llm.maxTokens ? { maxTokens: llm.maxTokens } : {}),
          ...(llm.reasoningEffort ? { reasoningEffort: llm.reasoningEffort } : {}),
          ...changes.llm,
        },
    // The store in use; a default path is written as no path.
    storePath: current.storePath && current.storePath !== '~/.dsh/mem0/memory.sqlite' ? current.storePath : '',
    // The store in use is the user's own: no "confirm this folder" step.
    storeConfirmed: true,
    useLiteralKey: { embedder: false, llm: false },
  }
  return draft
}

/** The literal-key choice for a read-only check: oss.json's key, for the same server only (lib/setup-routes.js keyFor). */
function checkDraft(state) {
  const draft = currentDraft(state)
  draft.useLiteralKey = { embedder: state?.current?.embedder?.literalKey === true, llm: state?.current?.llm?.literalKey === true }
  return draft
}

function configLines(config) {
  const lines = [
    `backend: ${config.backend}${config.backendSource ? ` (${config.backendSource})` : ''}`,
    `enabled: ${config.enabled !== false}`,
    `autoRecall: ${config.autoRecall !== false}, autoCapture: ${config.autoCapture !== false}, captureFilter: ${config.captureFilter ?? 'heuristic'}`,
    `recallTopK: ${config.recallTopK}, memoryBudgetTokens: ${config.memoryBudgetTokens}, profileEnabled: ${config.profileEnabled !== false}, hygieneEnabled: ${config.hygieneEnabled !== false}`,
    `timeoutMs: ${config.timeoutMs}, recallTimeoutMs: ${config.recallTimeoutMs}, addTimeoutMs: ${config.addTimeoutMs}`,
  ]
  if (config.backend === 'oss') {
    lines.push(`projectPartitions: ${config.projectPartitions !== false}, embedderKeepAlive: ${config.embedderKeepAlive || '30m'}`)
  } else {
    const host = hostPort(config.baseUrl || (config.backend === 'platform' ? DEFAULT_PLATFORM_BASE_URL : ''))
    lines.push(`endpoint: ${host ?? 'not set'}`, `key source: ${config.apiKeySource ?? (config.apiKey ? 'config' : 'none')}`)
  }
  return lines
}

/** The open (not recovered) failures, newest first, as fact lines. */
export function failureLines(failures, { limit = 5 } = {}) {
  const open = (Array.isArray(failures) ? failures : []).filter((entry) => entry && entry.recovered !== true)
  if (open.length === 0) return ['open failures: none']
  const lines = [`open failures: ${open.length}${open.length > limit ? ` (newest ${limit} shown)` : ''}`]
  for (const entry of open.slice(0, limit)) {
    const facts = diagnosisFacts(entry, { sanitize: (text) => scrubText(sanitizeFailureMessage(text), { max: 200 }) })
    lines.push(`- ${facts.map(([key, value]) => `${key}=${value}`).join(' ')}`)
  }
  return lines
}

function breakerLine(runtime) {
  const open = runtime?.breaker?.isOpen?.()
  return `circuit breaker: ${open === true ? 'open (calls paused)' : open === false ? 'closed' : 'unknown'}`
}

/**
 * Run one mem0_check target. `ctx` is the plugin context (credentials for
 * the wizard tests), `runtime` the running plugin's. Returns plain text.
 */
export async function runCheck(ctx, runtime, { target, component } = {}, { fetchImpl, signal } = {}) {
  const name = CHECK_TARGETS.includes(target) ? target : 'status'
  if (!runtime?.config) return `${CHECK_TOOL} ${name}: the plugin is not running.`
  const config = runtime.config
  if (LOCAL_TARGETS.has(name) && config.backend !== 'oss') {
    return `${CHECK_TOOL} ${name}: only for the local backend; this one is ${config.backend}. Use "connection".`
  }
  const head = `${CHECK_TOOL} ${name}:`
  switch (name) {
    case 'status': {
      const lines = [...configLines(config), breakerLine(runtime)]
      try {
        lines.push(...diagnosticLines({ client: runtime.client, config, configGuard: runtime.configGuard }).map((line) => scrubText(line)))
      } catch {
        // the configuration lines above still say enough
      }
      const open = (runtime.failures?.list?.() ?? []).filter((entry) => entry && entry.recovered !== true).length
      lines.push(`open failures: ${open}${open ? ` (details: ${CHECK_TOOL} failures)` : ''}`)
      return [head, ...lines].join('\n')
    }
    case 'connection': {
      if (!runtime.client) return `${head} memory is disabled (enabled: false).`
      try {
        const health = await runtime.client.health({ timeoutMs: 12_000, signal })
        const lines = [`ok: ${health?.ok !== false}`, `backend: ${health?.backend ?? config.backend}`]
        if (health?.baseUrl) lines.push(`endpoint: ${hostPort(health.baseUrl) ?? '[url]'}`)
        if (health?.store) lines.push(`store: ${health.store.ok ? 'ok' : `error: ${scrubText(health.store.error ?? 'unknown')}`}`)
        if (Number.isInteger(health?.memoryCount)) lines.push(`memories: ${health.memoryCount}`)
        if (health?.embedder) lines.push(`embedder: ${health.embedder.ok ? `ok (${health.embedder.dimensions ?? '?'} dims, ${scrubText(health.embedder.model ?? '?')})` : `error: ${scrubText(health.embedder.error ?? 'unknown')}`}`)
        if (health?.llm) lines.push(`extraction LLM: ${health.llm.followsDsh ? 'follows DSH' : health.llm.configured ? `configured (${scrubText(health.llm.model ?? '?')})` : `not configured${health.llm.error ? `: ${scrubText(health.llm.error)}` : ''}`}`)
        if (health?.qdrant) lines.push(`qdrant: ${health.qdrant.ok ? 'ok' : `error: ${scrubText(health.qdrant.error ?? 'unknown')}`}`)
        if (health?.error) lines.push(`error: ${scrubText(health.error)}`)
        lines.push(breakerLine(runtime))
        return [head, ...lines].join('\n')
      } catch (error) {
        return `${head} failed: ${scrubText(error?.message ?? error)}`
      }
    }
    case 'failures':
      return [head, ...failureLines(runtime.failures?.list?.() ?? [])].join('\n')
    case 'probe': {
      const result = await handleSetupAction(ctx, runtime, { action: 'probe' }, { fetchImpl })
      const services = (result?.services ?? []).map((service) => ({
        id: service.id,
        at: hostPort(service.baseUrl),
        running: service.running,
        needsKey: service.needsKey,
        models: (service.models ?? []).length,
        embeddingModels: (service.embeddingModels ?? []).slice(0, MAX_LIST),
        error: service.error,
      }))
      return `${head} ${asText(services)}`
    }
    default: {
      const state = await setupState(ctx, runtime)
      const draft = checkDraft(state)
      // The server a target tests: llm and embedder name it; models and
      // the rest follow `component`.
      const part = name === 'llm' ? 'llm' : name === 'embedder' ? 'embedder' : component === 'llm' ? 'llm' : 'embedder'
      if (name === 'llm' || (name === 'models' && part === 'llm')) {
        if (draft.llm.provider === 'dsh') {
          if (name === 'models') return `${head} the extraction LLM follows DSH's current model; there is no model list of its own.`
        }
      }
      const action = { embedder: 'testEmbedder', llm: 'testLlm', models: 'listModels', store: 'checkStore', selftest: 'selfTest' }[name]
      const result = await handleSetupAction(ctx, runtime, { action, draft, component: part }, { fetchImpl })
      if (name === 'models') {
        const models = Array.isArray(result?.models) ? result.models.map(String) : []
        const summary = { ok: result?.ok !== false, component: part, at: hostPort(draft[part]?.baseUrl), configured: draft[part]?.model || null, configuredListed: models.includes(draft[part]?.model), count: models.length, models: models.slice(0, 50) }
        if (!result?.ok) Object.assign(summary, { error: result?.error, failure: result?.failure })
        return `${head} ${asText(summary)}`
      }
      const tested = name === 'store' ? {} : { component: name === 'selftest' ? 'all' : part, at: name === 'selftest' ? undefined : hostPort(draft[part]?.baseUrl), model: name === 'selftest' ? undefined : draft[part]?.model || (draft[part]?.provider === 'dsh' ? 'follows DSH' : null) }
      return `${head} ${asText({ ...tested, ...result })}`
    }
  }
}

// ---- mem0_setting_set -------------------------------------------------------

function schemaCheck(field, value) {
  try {
    Config({ [field]: value })
    return null
  } catch (error) {
    return scrubText(error?.message ?? error, { max: 160 })
  }
}

/**
 * The value to write for one allowed field, or `{ error }`. Pure apart
 * from the profile schema.
 */
export function validateSetting(field, raw) {
  const spec = Object.hasOwn(SETTING_FIELDS, field) ? SETTING_FIELDS[field] : null
  if (!spec) return { error: `${field} is not a setting ${SETTING_TOOL} may change; allowed: ${SETTING_NAMES.join(', ')}` }
  let value = raw
  switch (spec.type) {
    case 'boolean':
      if (value === 'true' || value === 'false') value = value === 'true'
      if (typeof value !== 'boolean') return { error: `${field} takes true or false` }
      break
    case 'number':
      if (typeof value === 'string' && value.trim() !== '') value = Number(value)
      if (!Number.isInteger(value)) return { error: `${field} takes a whole number` }
      if (spec.min !== undefined && (value < spec.min || value > spec.max)) return { error: `${field} takes ${spec.min}–${spec.max}` }
      break
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value.trim().toLowerCase())) return { error: `${field} takes one of: ${spec.values.map((item) => item || '""').join(', ')}` }
      value = value.trim().toLowerCase()
      break
    case 'duration':
      if (typeof value !== 'string' || !/^(?:-1|0|\d{1,5}(?:ms|s|m|h))$/.test(value.trim())) return { error: `${field} takes a duration such as 30m, 2h or -1 (keep loaded)` }
      value = value.trim()
      break
    case 'url':
      if (typeof value !== 'string' || !/^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/i.test(value.trim())) return { error: `${field} takes an http(s) address such as http://127.0.0.1:11434/v1` }
      if (/@/.test(value)) return { error: `${field} may not carry a user name or password` }
      value = value.trim().replace(/\/+$/, '')
      break
    case 'name':
      if (typeof value !== 'string' || !/^[\w.:/@+-]{1,200}$/.test(value.trim())) return { error: `${field} takes a model name (letters, digits and . _ - : / @ +)` }
      value = value.trim()
      break
    default:
      return { error: `${field} cannot be set` }
  }
  if (spec.via === 'profile') {
    const problem = schemaCheck(field, value)
    if (problem) return { error: `${field}: ${problem}` }
  }
  return { value, spec }
}

/** The text DSH's confirmation card shows for one call. */
export function settingConfirmText({ field, value } = {}, lang = 'en') {
  const shown = typeof value === 'string' ? (SETTING_FIELDS[field]?.type === 'url' ? hostPort(value) ?? scrubText(value, { max: 80 }) : scrubText(value, { max: 80 })) : JSON.stringify(value)
  const name = String(field ?? '?').slice(0, 40)
  return lang === 'zh'
    ? `dsh-mem0：${SETTING_TOOL} 要把设置 ${name} 改成 ${shown}（诊断会话；改设置总会确认）。`
    : `dsh-mem0: ${SETTING_TOOL} changes the setting ${name} to ${shown} (diagnosis session; setting changes always ask).`
}

function currentValue(runtime, field, spec, state) {
  if (spec.via === 'wizard') return state?.current?.[spec.component]?.[spec.key] ?? null
  return runtime?.config?.[field] ?? null
}

// The tool checks after a change itself: one more round of checks only
// costs tokens (a live run re-ran five).
const CHECKED = 'Checked above after the change; report to the user now, without further checks unless they ask.'

/**
 * Wait until the plugin has reloaded with a new runtime (`getRuntime()`
 * returns another object than `before`), at most `timeoutMs`.
 */
export async function nextRuntime(getRuntime, before, { timeoutMs = 15_000, intervalMs = 200 } = {}) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const current = getRuntime()
    if (current && current !== before) return current
    if (Date.now() >= until) return null
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * Change one allowed setting and check it. `deps`: `ctx`, `getRuntime()`
 * (the newest runtime, also after a reload), `settings` (DSH's settings
 * service), `fetchImpl` and `restart` (tests), `reloadTimeoutMs`.
 */
export async function applySetting({ field, value: raw } = {}, deps = {}) {
  const { ctx, getRuntime, fetchImpl, restart, reloadTimeoutMs } = deps
  const head = `${SETTING_TOOL} ${String(field ?? '').slice(0, 40)}:`
  const checked = validateSetting(field, raw)
  if (checked.error) return `${head} refused: ${checked.error}`
  const { value, spec } = checked
  const runtime = getRuntime()
  if (!runtime?.config) return `${head} the plugin is not running.`
  const backend = runtime.config.backend
  if (spec.via === 'wizard' && backend !== 'oss') return `${head} refused: the local backend's model servers; this backend is ${backend}.`
  if (spec.backend && spec.backend !== backend) return `${head} refused: only for the ${spec.backend} backend; this one is ${backend}.`

  if (spec.via === 'profile') {
    const settings = deps.settings ?? ctx?.get?.('settings')
    if (typeof settings?.mutate !== 'function') return `${head} DSH's settings service is not available; tell the user to change ${field} on the plugin's settings page.`
    const previous = currentValue(runtime, field, spec)
    if (previous === value) return `${head} already ${JSON.stringify(value)}; nothing changed.\n${await runCheck(ctx, runtime, { target: spec.check }, { fetchImpl })}`
    let revision
    try {
      revision = settings.describe?.()?.find?.((row) => row.ns === SETTINGS_NAMESPACE)?.revision
    } catch {
      revision = undefined
    }
    try {
      await settings.mutate(SETTINGS_NAMESPACE, [{ op: 'set', path: [field], value }], revision)
    } catch (error) {
      return `${head} DSH refused the change: ${scrubText(error?.message ?? error)}`
    }
    // The settings page copies some fields into oss.json after a save.
    if (MIRROR_FIELDS.includes(field)) {
      mirrorSavedSettings({ values: { [field]: value }, previous: { [field]: previous }, changed: [field] }, { file: runtime.config.ossConfigPath, logger: ctx?.logger })
    }
    const after = (await nextRuntime(getRuntime, runtime, { timeoutMs: reloadTimeoutMs })) ?? getRuntime()
    const now = after?.config?.[field]
    const applied = now === value
    return [
      `${head} saved through DSH's settings (${JSON.stringify(previous)} → ${JSON.stringify(value)}); ${applied ? 'the plugin reloaded with it' : after === runtime ? 'the plugin has not reloaded yet' : `the plugin reloaded but reads ${JSON.stringify(now)} (another layer may set it)`}.`,
      await runCheck(ctx, after, { target: spec.check }, { fetchImpl }),
      CHECKED,
    ].join('\n')
  }

  // The local backend's model servers: the setup wizard's save.
  const state = await setupState(ctx, runtime)
  if ((state?.shadowed ?? []).includes(field)) {
    return `${head} refused: the profile sets ${field} itself, so the setup wizard's copy would not apply. Tell the user to change it on the settings page's profile layer.`
  }
  if (spec.component === 'llm' && state?.current?.llm?.provider === 'dsh' && spec.key !== 'maxTokens') {
    return `${head} refused: the extraction LLM follows DSH's current model; switching it to a server of its own is done in the setup wizard.`
  }
  const previous = currentValue(runtime, field, spec, state)
  if (previous === value) return `${head} already ${JSON.stringify(value)}; nothing changed.`
  const draft = currentDraft(state, { [spec.component]: { [spec.key]: value } })
  // A changed address keeps the credential name; the stored key then
  // applies only to the same provider and host (lib/setup-routes.js), so
  // the self-test fails rather than sending the key elsewhere.
  const test = await handleSetupAction(ctx, runtime, { action: 'selfTest', draft }, { fetchImpl, ignoreReadKeys: true })
  if (!test?.ok) {
    return `${head} not saved: the self-test with the new value failed, the old setting stays. ${asText({ step: test?.step, component: test?.component, error: test?.error, failure: test?.failure, code: test?.code })}`
  }
  if (Number(test.reembed) > 0) {
    return `${head} not saved: the new embedder would recompute the vectors of ${test.reembed} memories. That runs in the setup wizard, where the user can follow it.`
  }
  const saved = await handleSetupAction(ctx, runtime, { action: 'save', draft }, { fetchImpl, restart, ignoreReadKeys: true })
  if (!saved?.ok) return `${head} not saved: ${asText({ step: saved?.step, error: saved?.error, code: saved?.code })}`
  const after = saved.restarting ? (await nextRuntime(getRuntime, runtime, { timeoutMs: reloadTimeoutMs })) ?? getRuntime() : getRuntime()
  return [
    `${head} saved through the setup wizard (${JSON.stringify(previous)} → ${JSON.stringify(value)}, self-test passed: write, search and delete of a test memory); ${after !== runtime ? 'the plugin reloaded with it' : 'the plugin has not reloaded yet'}.`,
    await runCheck(ctx, after, { target: spec.check }, { fetchImpl }),
    CHECKED,
  ].join('\n')
}

// ---- tool definitions -------------------------------------------------------

// The runtime of the newest apply(): a settings change reloads the plugin,
// and the call that made it checks against the reloaded one.
let LATEST_RUNTIME = null

/** Record the runtime of the plugin instance that just started. */
export function setLatestRuntime(runtime) {
  LATEST_RUNTIME = runtime ?? null
}

/** The runtime of the newest plugin instance, or null. */
export function latestRuntime() {
  return LATEST_RUNTIME
}

const textOutput = {
  schema: { type: 'string' },
  render(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
  },
}

const OUTSIDE = (name) => `${name} is only available in a Mem0 diagnosis session.`

/**
 * The tool definitions. `inDiagnosis(session)` decides where they are
 * offered (also the `when` condition, see diagnoseToolOptions).
 */
export function createDiagnoseTools({ ctx, getRuntime, inDiagnosis = () => false, fetchImpl, restart } = {}) {
  const allowed = (exec) => {
    try {
      return inDiagnosis(exec?.agent?.session) === true
    } catch {
      return false
    }
  }
  return [
    {
      name: CHECK_TOOL,
      description:
        'Mem0 diagnosis only. Run one of the checks of the plugin\'s settings page and get a redacted result (no keys, no memory text, endpoints as host:port). ' +
        'target: status (settings in effect, no network), connection (the connection test), failures (open failures), probe (local model servers on this machine), ' +
        'and for the local backend: embedder, llm (test call with the saved settings and stored key), models (model names on the configured server; component embedder|llm), store (store location), selftest (write, search and delete a test memory under a separate test user).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: { type: 'string', enum: [...CHECK_TARGETS] },
          component: { type: 'string', enum: ['embedder', 'llm'], description: 'For target models: which server (default embedder).' },
        },
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      timeoutMs: 120_000,
      async execute(args, exec) {
        if (!allowed(exec)) return OUTSIDE(CHECK_TOOL)
        try {
          return await runCheck(ctx, getRuntime(), { target: args?.target, component: args?.component }, { fetchImpl, signal: exec?.signal })
        } catch (error) {
          return `${CHECK_TOOL} failed: ${scrubText(error?.message ?? error)}`
        }
      },
    },
    {
      name: SETTING_TOOL,
      description:
        'Mem0 diagnosis only. Change one plugin setting the way the settings page saves it, then check it. Always asks the user. Never changes keys or credentials. ' +
        `field is one of: ${SETTING_NAMES.join(', ')}. ` +
        'embedder*/llm* fields are the local backend\'s model servers: saved only after a self-test with the new value passes. ' +
        'For anything else (keys, backend, store path, user id) tell the user where to change it on the settings page.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'value'],
        properties: {
          field: { type: 'string', enum: [...SETTING_NAMES] },
          value: { type: 'string', description: 'The new value as text: true/false, a number such as 15000, a name or an http(s) address.' },
        },
      },
      output: textOutput,
      timeoutMs: 180_000,
      async execute(args, exec) {
        if (!allowed(exec)) return OUTSIDE(SETTING_TOOL)
        try {
          return await applySetting({ field: args?.field, value: args?.value }, { ctx, getRuntime, fetchImpl, restart })
        } catch (error) {
          return `${SETTING_TOOL} failed: ${scrubText(error?.message ?? error)}`
        }
      },
    },
  ]
}

/** DSH's step-time condition: offered in diagnosis sessions only. */
export function diagnoseToolOptions(inDiagnosis) {
  return {
    when: (context) => {
      try {
        return inDiagnosis(context?.agent?.session) === true
      } catch {
        return false
      }
    },
  }
}

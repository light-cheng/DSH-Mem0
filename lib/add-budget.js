/**
 * The time budget of one local-backend write (lib/native-client.js add).
 *
 * Every step of a write shares one budget, `addTimeoutMs` (120 s by
 * default), counted from when the add runs: the wait behind an earlier
 * write of the same scope and a capture's project lookup come before it and
 * are recorded (`queueMs`, `projectMs`) but not counted. A network step gets
 * what is left of the budget; an embedding call gets at most `timeoutMs`
 * (the request timeout, 30 s by default) on top, as recall and search do,
 * so a stuck embedder is reported as the embedder and leaves the LLM the
 * rest. The first embedding of a write gets at least 60 s of it: it may
 * have to load a local model (an Ollama cold start).
 *
 * A step that times out says where the time went: the error carries
 * `limitMs` (the limit that step had), `budgetMs` (the whole budget),
 * `limitSetting` (the setting that limit came from), `stepElapsedMs` and
 * `timings` (how long the earlier steps took), and its message names them:
 *   "… request timed out after 11082 ms — only 11.1 s of the 120 s write
 *    timeout (addTimeoutMs) were left; embedding took 108.9 s before it"
 *   "… request timed out after 30000 ms — embedding the facts exceeded the
 *    30 s request timeout (timeoutMs)"
 *   "…; before this write started, the save waited 100 s (not counted in
 *    the write timeout)"
 */

/** Settings a limit can come from (failures.json `limitSetting`). */
export const LIMIT_SETTINGS = Object.freeze(['addTimeoutMs', 'timeoutMs', 'recallTimeoutMs'])

/**
 * Steps a write times, in the order they run (failures.json `timings`).
 * `projectMs` and `queueMs` happen before the budget starts: the capture's
 * project lookup, and the wait behind an earlier write of the same scope.
 */
export const TIMING_STEPS = Object.freeze({
  projectMs: 'finding the project',
  queueMs: 'waiting for an earlier write',
  storeMs: 'reading the store',
  embedMs: 'embedding',
  llmKeyMs: 'the LLM key lookup',
  llmMs: 'fact extraction',
  factsEmbedMs: 'embedding the facts',
})

/** Steps shorter than this are left out of a message (still recorded). */
const NOTABLE_MS = 100

/** Seconds with one decimal; whole seconds without one ("120 s", "11.1 s"). */
export function seconds(ms) {
  const value = Math.max(0, Number(ms) || 0) / 1000
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/** The known step timings of `raw` as whole milliseconds; undefined when none. */
export function cleanTimings(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const out = {}
  for (const key of Object.keys(TIMING_STEPS)) {
    const value = Number(raw[key])
    if (raw[key] !== null && raw[key] !== undefined && Number.isFinite(value) && value >= 0) out[key] = Math.round(value)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const EXTRA_TIMING_KEYS = { projectMs: 'x.project_ms', queueMs: 'x.queue_ms', storeMs: 'x.store_ms', embedMs: 'x.embed_ms', llmKeyMs: 'x.llm_key_ms', llmMs: 'x.llm_ms', factsEmbedMs: 'x.facts_embed_ms' }

/**
 * The budget fields of a failure entry as diagnosis `x.` fields
 * (lib/diagnose-report.js diagnosisExtra): `x.limit_ms`, `x.budget_ms`,
 * `x.limit_setting` and one `x.<step>_ms` per earlier step. Empty for
 * entries without them (older ones, other failures).
 */
export function budgetExtra(entry) {
  const out = []
  if (!entry || typeof entry !== 'object') return out
  for (const [key, field] of [['limitMs', 'x.limit_ms'], ['budgetMs', 'x.budget_ms']]) {
    const value = Number(entry[key])
    if (entry[key] !== null && entry[key] !== undefined && Number.isFinite(value) && value >= 0) out.push([field, Math.round(value)])
  }
  if (LIMIT_SETTINGS.includes(entry.limitSetting)) out.push(['x.limit_setting', entry.limitSetting])
  const timings = cleanTimings(entry.timings) ?? {}
  for (const [key, field] of Object.entries(EXTRA_TIMING_KEYS)) if (key in timings) out.push([field, timings[key]])
  return out
}

function isTimeout(error) {
  return error?.code === 'ETIMEDOUT'
}

/**
 * "embedding took 108.2 s", "waiting for an earlier write took 25.0 s and
 * embedding took 30.0 s": the two longest notable steps, in run order;
 * "earlier steps took 0.1 s" when none is notable.
 */
export function describePrior(timings, keys) {
  const entries = keys.filter((key) => Number.isFinite(timings?.[key])).map((key) => [key, timings[key]])
  const notable = entries.filter(([, ms]) => ms >= NOTABLE_MS)
  if (notable.length === 0) {
    const total = entries.reduce((sum, [, ms]) => sum + ms, 0)
    return `earlier steps took ${seconds(total)} s`
  }
  const longest = [...notable].sort((a, b) => b[1] - a[1]).slice(0, 2)
  const kept = notable.filter((entry) => longest.includes(entry))
  return kept.map(([key, ms]) => `${TIMING_STEPS[key]} took ${seconds(ms)} s`).join(' and ')
}

const SETTING_NAMES = { addTimeoutMs: 'write timeout', timeoutMs: 'request timeout', recallTimeoutMs: 'recall timeout' }

function limitName(ms, setting) {
  return setting ? `${seconds(ms)} s ${SETTING_NAMES[setting]} (${setting})` : `${seconds(ms)} s time limit of this call`
}

/** Steps a write times before its budget starts (never counted against it). */
export const UNCOUNTED_STEPS = Object.freeze(['projectMs', 'queueMs'])

export class AddBudget {
  /**
   * @param {object} options
   * @param {number} options.budgetMs the whole budget.
   * @param {string} [options.budgetSetting] the setting it comes from (undefined: the caller's own timeoutMs).
   * @param {number} options.startedAt when the budget started (ms since epoch): when the add runs.
   * @param {number} [options.stepCapMs] the cap of an embedding call (request timeout).
   * @param {object} [options.timings] step timings so far, the ones before the
   *   budget started included (UNCOUNTED_STEPS); filled in place.
   * @param {() => number} [options.now] clock (tests).
   */
  constructor({ budgetMs, budgetSetting, startedAt, stepCapMs, timings = {}, now = Date.now }) {
    this.budgetMs = budgetMs
    this.budgetSetting = budgetSetting
    this.deadline = startedAt + budgetMs
    this.stepCapMs = Number.isFinite(stepCapMs) && stepCapMs > 0 ? stepCapMs : undefined
    this.timings = timings
    // Keys of `timings` measured inside the budget, in run order.
    this.counted = []
    this.now = now
  }

  /** What is left of the budget (at least 1 ms). */
  remaining() {
    return Math.max(1, this.deadline - this.now())
  }

  /**
   * The limit of the next step: `{ limitMs, limitSetting, capped }`. A
   * capped step (an embedding) gets at most the request timeout, raised to
   * `floorMs` when that is longer (the first embedding of a write, which may
   * have to load a local model).
   */
  limit({ capped = false, floorMs } = {}) {
    const left = this.remaining()
    if (capped && this.stepCapMs !== undefined) {
      const cap = Number.isFinite(floorMs) ? Math.max(this.stepCapMs, floorMs) : this.stepCapMs
      if (cap < left) return { limitMs: cap, limitSetting: 'timeoutMs', capped: true }
    }
    return { limitMs: left, limitSetting: this.budgetSetting, capped: false }
  }

  /** Add `ms` to a step's timing (a step can run twice: two key lookups). */
  record(key, ms) {
    this.timings[key] = (this.timings[key] ?? 0) + Math.max(0, ms)
    if (!this.counted.includes(key)) this.counted.push(key)
  }

  /**
   * Run one step with its limit: `fn(limitMs)`. Its time goes to
   * `timings[key]`; a timeout of it gets the budget fields and message.
   * When nothing is left of the budget the step does not start.
   * `component`/`step` tag the error of a step that could not start.
   */
  async run(key, { capped = false, floorMs, component, step } = {}, fn) {
    const prior = this.counted.filter((item) => item !== key)
    if (this.deadline - this.now() <= 0) throw this.#exhausted(key, prior, { component, step })
    const { limitMs, limitSetting, capped: wasCapped } = this.limit({ capped, floorMs })
    const started = this.now()
    try {
      return await fn(limitMs)
    } catch (error) {
      if (isTimeout(error)) this.#explain(error, { key, prior, limitMs, limitSetting, capped: wasCapped, elapsed: this.now() - started })
      throw error
    } finally {
      this.record(key, this.now() - started)
    }
  }

  /** The time spent before the budget started (project lookup, queue), when notable. */
  #waited() {
    const ms = UNCOUNTED_STEPS.reduce((sum, key) => sum + (Number.isFinite(this.timings[key]) ? this.timings[key] : 0), 0)
    return ms >= NOTABLE_MS ? `; before this write started, the save waited ${seconds(ms)} s (not counted in the write timeout)` : ''
  }

  #fields(error, { limitMs, limitSetting, elapsed, prior }) {
    error.limitMs = Math.round(limitMs)
    error.budgetMs = this.budgetMs
    if (limitSetting) error.limitSetting = limitSetting
    if (Number.isFinite(elapsed)) error.stepElapsedMs = Math.round(elapsed)
    // The earlier steps, the uncounted ones before the budget included.
    const keys = [...UNCOUNTED_STEPS, ...prior.filter((item) => !UNCOUNTED_STEPS.includes(item))]
    const timings = cleanTimings(Object.fromEntries(keys.map((item) => [item, this.timings[item]])))
    if (timings) error.timings = timings
  }

  #explain(error, { key, prior, limitMs, limitSetting, capped, elapsed }) {
    if (error.limitMs !== undefined) return
    this.#fields(error, { limitMs, limitSetting, elapsed, prior })
    const label = TIMING_STEPS[key]
    const usedBefore = prior.reduce((sum, item) => sum + (this.timings[item] ?? 0), 0)
    let why
    if (capped && this.stepCapMs !== undefined && limitMs > this.stepCapMs) {
      why = `${label} exceeded its ${seconds(limitMs)} s limit (the first embedding of a write gets the request timeout, timeoutMs, but at least ${seconds(limitMs)} s)`
    } else if (capped) why = `${label} exceeded the ${limitName(limitMs, 'timeoutMs')}`
    else if (usedBefore < NOTABLE_MS) why = `${label} used the whole ${limitName(this.budgetMs, this.budgetSetting)}`
    else why = `only ${seconds(limitMs)} s of the ${limitName(this.budgetMs, this.budgetSetting)} were left; ${describePrior(this.timings, prior)} before it`
    error.message = `${error.message} — ${why}${this.#waited()}`
  }

  #exhausted(key, prior, { component, step }) {
    const error = new Error(
      `dsh-mem0: the ${limitName(this.budgetMs, this.budgetSetting)} ran out before ${TIMING_STEPS[key]} started; ${describePrior(this.timings, prior)}${this.#waited()}`,
    )
    error.name = 'TimeoutError'
    error.code = 'ETIMEDOUT'
    if (component) error.component = component
    if (step) error.step = step
    this.#fields(error, { limitMs: 0, limitSetting: this.budgetSetting, elapsed: 0, prior })
    return error
  }
}

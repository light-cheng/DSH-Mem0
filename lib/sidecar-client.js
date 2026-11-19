/**
 * Managed bridge to the Python Mem0 OSS sidecar.
 *
 * The sidecar binds a random loopback port and is protected by a per-process
 * bearer token. Node owns its lifecycle, so a plugin unload/HMR cannot leave an
 * orphaned Python process holding the Qdrant collection.
 *
 * The token reaches the child on stdin, never on the command line (where `ps`
 * would show it), and the child gets an allowlisted environment instead of a
 * copy of everything DSH inherited.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { CircuitBreaker, failureAttribution, requestJson } from './http.js'
import { sanitizeFailureMessage } from './failure-history.js'
import { CONFIG_ERROR_CODES, WINDOWS_DOCS_URL, checkOssConfig, fileFingerprint, readOssConfig } from './oss-config.js'

// Re-exported for callers that imported it from here before lib/http.js existed.
export { CircuitBreaker }

const SIDECAR_SCRIPT = fileURLToPath(new URL('../python/mem0_sidecar.py', import.meta.url))
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_ADD_TIMEOUT_MS = 120_000
const DEFAULT_STOP_GRACE_MS = 3_000
// After a failed start, fail-open callers (automatic recall) do not trigger a
// new Python process for this long, so a broken install does not respawn the
// sidecar on every user message.
const DEFAULT_RESTART_BACKOFF_MS = 30_000
// After a request fails with a network error, how long to wait for the
// child's `exit` event so the failure can say how the sidecar died. A killed
// child resets its sockets before Node processes its exit.
const DEFAULT_EXIT_WAIT_MS = 500
// When the child exits, requests still in flight to it are aborted only after
// this grace. The socket error (refused/reset) normally arrives first and is
// the more precise answer: a refused connection proves the request was never
// delivered, which lets a capture be retried safely.
const DEFAULT_EXIT_ABORT_GRACE_MS = 1_000

// Variables the sidecar may need: process basics, locale, proxies and CA
// bundles, Python/virtualenv settings, model caches, and the provider SDKs
// that Mem0 OSS falls back to when an API key is not in its config file.
const ENV_EXACT = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TZ',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'VIRTUAL_ENV', 'MEM0_DIR',
])
const ENV_PREFIXES = [
  'LC_', 'XDG_', 'PYTHON', 'CONDA_', 'UV_', 'PIP_',
  'HF_', 'HUGGINGFACE_', 'HUGGING_FACE_', 'TRANSFORMERS_', 'SENTENCE_TRANSFORMERS_', 'TORCH_', 'CUDA_', 'TOKENIZERS_', 'NLTK_',
  'OPENAI_', 'AZURE_', 'ANTHROPIC_', 'GOOGLE_', 'GEMINI_', 'VERTEX_', 'AWS_', 'GROQ_', 'TOGETHER_', 'DEEPSEEK_',
  'OLLAMA_', 'LMSTUDIO_', 'VLLM_', 'LITELLM_', 'MISTRAL_', 'XAI_', 'VOYAGE_', 'COHERE_', 'JINA_', 'FIREWORKS_',
  'QDRANT_', 'NEO4J_', 'MEMGRAPH_',
]
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * A NO_PROXY list Python's httpx accepts: bracketed IPv6 entries (`[::1]`,
 * `[::1]:8080`) become their bare address (port dropped), duplicates go.
 * Exported for tests.
 * @param {string} value
 * @returns {string}
 */
export function pythonNoProxy(value) {
  const out = []
  for (const raw of String(value).split(/[,\s]+/)) {
    const entry = raw.trim()
    if (!entry) continue
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(entry)
    const host = bracketed ? bracketed[1] : entry
    if (!out.includes(host)) out.push(host)
  }
  return out.join(',')
}

/**
 * Environment for the sidecar child: the allowlist above, plus `extraNames`
 * from the plugin's `sidecarEnv` setting. Exported for tests.
 * @param {Record<string, string|undefined>} source
 * @param {string[]} extraNames
 * @returns {Record<string, string>}
 */
export function buildSidecarEnv(source = process.env, extraNames = []) {
  const extra = new Set((Array.isArray(extraNames) ? extraNames : []).filter((name) => ENV_NAME_RE.test(String(name))))
  const env = {}
  for (const [name, value] of Object.entries(source ?? {})) {
    if (typeof value !== 'string') continue
    if (extra.has(name) || ENV_EXACT.has(name) || ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      env[name] = value
    }
  }
  // OpenAILLM routes to OpenRouter when this is set; the sidecar removes it
  // too, but there is no reason to hand it over.
  if (!extra.has('OPENROUTER_API_KEY')) delete env.OPENROUTER_API_KEY
  // DSH adds `[::1]` to NO_PROXY whenever a proxy is set (undici needs the
  // brackets). Python's httpx, used by the OpenAI and Qdrant clients, rejects
  // a bracketed entry ("Invalid port: ':1]'"), so the sidecar could not start
  // at all behind a proxy. Python matches the bare `::1` form.
  for (const name of ['NO_PROXY', 'no_proxy']) {
    if (typeof env[name] === 'string') env[name] = pythonNoProxy(env[name])
  }
  env.MEM0_TELEMETRY = 'false'
  env.PYTHONUNBUFFERED = '1'
  return env
}

/**
 * Component of the longest-running step in a GET /steps answer, with its
 * provider/endpoint and elapsed time. Empty when nothing was running.
 */
export function attributeRunningStep(status) {
  const steps = Array.isArray(status?.steps) ? status.steps : []
  const longest = steps
    .filter((step) => step && typeof step.component === 'string')
    .sort((left, right) => Number(right.elapsedMs ?? 0) - Number(left.elapsedMs ?? 0))[0]
  if (!longest) return {}
  const details = status?.components?.[longest.component]
  return {
    ...failureAttribution({
      component: longest.component,
      step: longest.step,
      provider: details?.provider,
      endpoint: details?.endpoint ?? undefined,
    }),
    ...(Number.isFinite(Number(longest.elapsedMs)) ? { stepElapsedMs: Number(longest.elapsedMs) } : {}),
  }
}

/**
 * True only when the error proves the request never reached the sidecar: the
 * TCP connection was refused (nothing listens on the port, e.g. the sidecar
 * already exited before the request was sent). A reset, a closed socket, a
 * timeout or an abort may happen after the sidecar read the request, so they
 * are "unknown", never "not delivered". Exported for tests.
 */
export function provesNotDelivered(error) {
  const seen = new Set()
  const queue = [error]
  while (queue.length > 0) {
    const item = queue.shift()
    if (!item || typeof item !== 'object' || seen.has(item) || seen.size > 16) continue
    seen.add(item)
    if (item.code === 'ECONNREFUSED') return true
    queue.push(item.cause)
    if (Array.isArray(item.errors)) queue.push(...item.errors)
  }
  return false
}

const SIGNAL_RE = /^SIG[A-Z0-9]{1,12}$/
// Stderr lines kept during startup, to find the exception that stopped it.
const STARTUP_STDERR_LINES = 60
// "ModuleNotFoundError: No module named 'mem0'", "ValueError: …",
// "qdrant_client.http.exceptions.ResponseHandlingException: …".
const EXCEPTION_LINE_RE = /^(?:[A-Za-z_][\w]*\.)*([A-Z][A-Za-z0-9_]*(?:Error|Exception|Exit|Interrupt|Warning))(?::\s*(.*))?$/

/**
 * The last Python exception line in stderr ("ModuleNotFoundError: No module
 * named 'mem0'"), or '' when there is none. Exported for tests.
 * @param {string[]} lines
 */
export function lastExceptionLine(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = String(lines[index] ?? '').trim()
    const match = EXCEPTION_LINE_RE.exec(line)
    if (match) return match[2] ? `${match[1]}: ${match[2]}` : match[1]
  }
  return ''
}

const MEM0_MISSING_RE = /No module named '?mem0(?:[.'\s]|$)/

/**
 * A readable start-failure message for an interpreter without mem0. The
 * exception comes first: stored failure messages are capped.
 */
function mem0MissingMessage(pythonPath, pythonSource, reason) {
  const python = sanitizeFailureMessage(pythonPath)
  const fallback = pythonSource === 'path' ? ' (no ~/.dsh/mem0/venv was found, so the python on PATH was used)' : ''
  return (
    `dsh-mem0: ${reason}: interpreter ${python} has no mem0${fallback}. Set pythonPath to the Mem0 venv's python ` +
    `(Windows: ~\\.dsh\\mem0\\venv\\Scripts\\python.exe), or create the venv. See ${WINDOWS_DOCS_URL}`
  )
}

/** Whether an error is a config error that retrying cannot fix. */
export function isConfigError(error) {
  return Boolean(error && (error.configError === true || CONFIG_ERROR_CODES.includes(error.code)))
}

/** Exit fields attached to an error and stored in failures.json. */
export function exitFields(exit) {
  if (!exit) return {}
  const out = { component: 'sidecar' }
  if (Number.isInteger(exit.code)) out.exitCode = exit.code
  if (typeof exit.signal === 'string' && SIGNAL_RE.test(exit.signal)) out.signal = exit.signal
  if (Number.isFinite(exit.uptimeMs)) out.uptimeMs = Math.max(0, Math.round(exit.uptimeMs))
  return out
}

function describeExit(exit) {
  const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 'null'}`
  const by = exit.stoppedBy ? `, stopped by the plugin (${exit.stoppedBy})` : ''
  return `sidecar exited (${how}) after ${exit.uptimeMs} ms while ${exit.phase}${by}; pid ${exit.pid ?? '?'}`
}

export class Mem0SidecarError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'Mem0SidecarError'
    this.code = options.code ?? 'DSH_MEM0_SIDECAR_ERROR'
    this.status = options.status
    this.path = options.path
  }
}

/** Whether a child process has exited (its exit event fired or exit status is known). */
export function hasExited(child) {
  return child.dshExited === true || (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
}

/** Resolve true once `child` exits, false after `ms`. */
function waitForExit(child, ms) {
  return new Promise((resolve) => {
    if (hasExited(child)) {
      resolve(true)
      return
    }
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off?.('exit', onExit)
      resolve(false)
    }, ms)
    child.once('exit', onExit)
  })
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
  })
}

export class Mem0SidecarClient {
  constructor(options) {
    this.pythonPath = options.pythonPath
    // `hermesConfigPath` is the option's pre-0.2 name; see lib/legacy-paths.js.
    this.mem0ConfigPath = options.mem0ConfigPath ?? options.hermesConfigPath
    this.collectionName = options.collectionName
    this.userId = options.userId
    this.agentId = options.agentId
    this.historyDbPath = options.historyDbPath
    this.logger = options.logger
    this.sidecarPath = options.sidecarPath ?? SIDECAR_SCRIPT
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.addTimeoutMs = options.addTimeoutMs ?? DEFAULT_ADD_TIMEOUT_MS
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS
    this.restartBackoffMs = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS
    // Where pythonPath came from (lib/config.js): configured, default,
    // legacy or path (the PATH fallback). Shown in status and sidecar.log.
    this.pythonSource = options.pythonSource
    // Called once the sidecar is ready (lib/config-guard.js records then
    // which settings were in effect).
    this.onReady = options.onReady
    this.extraEnv = options.extraEnv ?? []
    this.env = options.env ?? process.env
    this.lastStartFailureAt = 0
    // The error of the latest failed start and its redacted summary
    // (lastStartFailure), shown while later calls are skipped.
    this.lastStartError = undefined
    this.lastStartFailure = null
    // oss.json fingerprint when the latest start failed on a config error:
    // no new start until the file changes.
    this.configErrorFingerprint = undefined
    this.now = options.now ?? (() => Date.now())
    this.token = randomUUID()
    this.child = undefined
    this.port = undefined
    this.ready = false
    this.disposed = false
    this.startPromise = undefined
    // controller -> child it was sent to, so a child's exit aborts only its
    // own requests.
    this.pendingControllers = new Map()
    // Optional SidecarLog (lib/sidecar-log.js): stderr and start/exit events.
    this.log = options.log
    this.exitWaitMs = options.exitWaitMs ?? DEFAULT_EXIT_WAIT_MS
    this.exitAbortGraceMs = options.exitAbortGraceMs ?? DEFAULT_EXIT_ABORT_GRACE_MS
    // Process status for the settings page.
    this.starts = 0
    this.pid = undefined
    this.launcherPid = undefined
    this.startedAt = undefined
    this.lastExit = null
    this.currentExit = undefined
  }

  /**
   * Sidecar process status for /activity and the settings page. `pid` is the
   * interpreter's own PID (reported by the sidecar); `launcherPid` is set
   * when it differs from the spawned process (a Windows venv `python.exe` is
   * a launcher that starts the real interpreter as its child).
   */
  status() {
    return {
      running: this.running,
      starting: Boolean(this.startPromise),
      pid: this.running ? this.pid ?? null : null,
      launcherPid: this.running && this.launcherPid && this.launcherPid !== this.pid ? this.launcherPid : null,
      startedAt: this.running && this.startedAt ? new Date(this.startedAt).toISOString() : null,
      starts: this.starts,
      restarts: Math.max(0, this.starts - 1),
      lastExit: this.lastExit ? { ...this.lastExit } : null,
      lastStartFailure: this.lastStartFailure ? { ...this.lastStartFailure } : null,
      python: { path: sanitizeFailureMessage(this.pythonPath ?? ''), source: this.pythonSource ?? 'configured' },
    }
  }

  /**
   * The config error of the latest start while oss.json is unchanged, as a
   * fresh error (`repeated: true`); undefined when a start may be tried.
   */
  #unchangedConfigError() {
    if (!this.configErrorFingerprint || !isConfigError(this.lastStartError)) return undefined
    if (fileFingerprint(this.mem0ConfigPath) !== this.configErrorFingerprint) {
      this.configErrorFingerprint = undefined
      return undefined
    }
    const previous = this.lastStartError
    const error = new Mem0SidecarError(previous.message, { code: previous.code, cause: previous.cause })
    error.component = previous.component ?? 'vector_store'
    error.configError = true
    error.repeated = true
    return error
  }

  /** Remember why this start failed (redacted, short) for later skips and status. */
  #recordStartFailure(error) {
    this.lastStartError = error
    this.configErrorFingerprint = isConfigError(error) ? fileFingerprint(this.mem0ConfigPath) : undefined
    const summary = {
      at: new Date(this.now()).toISOString(),
      code: typeof error?.code === 'string' ? error.code : 'START_FAILED',
      component: typeof error?.component === 'string' ? error.component : 'sidecar',
      reason: sanitizeFailureMessage(error?.startReason || error?.message || String(error)).replace(/^dsh-mem0:?\s*(?:sidecar failed:\s*)?/, ''),
    }
    if (typeof error?.endpoint === 'string') summary.endpoint = error.endpoint
    if (Number.isInteger(error?.exitCode)) summary.exitCode = error.exitCode
    if (typeof error?.signal === 'string') summary.signal = error.signal
    if (isConfigError(error)) summary.configError = true
    this.lastStartFailure = summary
  }

  get running() {
    return this.ready && this.child !== undefined
  }

  /** Start eagerly in the background; failures stay fail-open for the agent. */
  startInBackground() {
    void this.ensureStarted().catch((error) => {
      this.logger?.warn?.(`dsh-mem0: sidecar warm-up failed: ${error.message}`)
    })
  }

  async ensureStarted() {
    if (this.disposed) throw new Mem0SidecarError('dsh-mem0: sidecar has been disposed', { code: 'DISPOSED' })
    if (this.ready && this.child !== undefined) return
    if (this.startPromise) return this.startPromise
    // A config error is not retried until oss.json changes.
    const configError = this.#unchangedConfigError()
    if (configError) throw configError
    // One startup is shared by every concurrent caller.
    this.startPromise = this.#start().then(
      () => {
        this.lastStartFailureAt = 0
      },
      (error) => {
        this.lastStartFailureAt = this.now()
        this.#recordStartFailure(error)
        this.log?.write(`sidecar start failed: ${this.lastStartFailure.reason}`, 'event')
        throw error
      },
    ).finally(() => {
      this.startPromise = undefined
    })
    return this.startPromise
  }

  /**
   * Wait for the shared startup, but stop waiting when `signal` aborts. The
   * startup itself keeps running for the next caller.
   */
  #awaitStarted(signal) {
    const started = this.ensureStarted()
    if (!signal) return started
    if (signal.aborted) {
      started.catch(() => {})
      return Promise.reject(new Mem0SidecarError('dsh-mem0: aborted while the sidecar was starting', {
        code: 'ABORTED',
        cause: signal.reason,
      }))
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        reject(new Mem0SidecarError('dsh-mem0: aborted while the sidecar was starting', {
          code: 'ABORTED',
          cause: signal.reason,
        }))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      started.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }

  /**
   * Fail-open path for callers that must not wait for Python to boot: start
   * (or keep starting) in the background and throw `STARTING` at once. A
   * recent failed start throws `START_FAILED` without respawning.
   */
  #requireReadyNow() {
    if (this.disposed) throw new Mem0SidecarError('dsh-mem0: sidecar has been disposed', { code: 'DISPOSED' })
    if (!this.startPromise) {
      const configError = this.#unchangedConfigError()
      if (configError) throw configError
    }
    if (!this.startPromise && this.lastStartFailureAt > 0 && this.now() - this.lastStartFailureAt < this.restartBackoffMs) {
      // Say why the last start failed and which component stopped it. The
      // exit code stays in lastStartFailure, not on this error: each exit is
      // stored as its own failure, while these skips fold into one entry.
      const last = this.lastStartFailure
      const error = new Mem0SidecarError(
        `dsh-mem0: sidecar failed to start recently${last?.reason ? `: ${last.reason}` : ''}; skipping`,
        { code: 'START_FAILED' },
      )
      error.startFailure = last ? { ...last } : undefined
      const previous = this.lastStartError
      error.component = typeof previous?.component === 'string' ? previous.component : 'sidecar'
      for (const key of ['provider', 'endpoint', 'step']) if (typeof previous?.[key] === 'string') error[key] = previous[key]
      throw error
    }
    this.startInBackground()
    throw new Mem0SidecarError('dsh-mem0: sidecar is starting; skipping this request', { code: 'STARTING' })
  }

  async #start() {
    if (!existsSync(this.mem0ConfigPath)) {
      throw new Mem0SidecarError(
        `dsh-mem0: Mem0 OSS config not found at ${this.mem0ConfigPath}`,
        { code: 'CONFIG_MISSING' },
      )
    }
    if (!existsSync(this.sidecarPath)) {
      throw new Mem0SidecarError(`dsh-mem0: sidecar script not found at ${this.sidecarPath}`, {
        code: 'SIDECAR_MISSING',
      })
    }
    // Unsupported configs (embedded Qdrant) fail here, before Python starts;
    // the sidecar repeats the check. An unreadable file is left to it.
    const ossConfig = readOssConfig(this.mem0ConfigPath)
    if (ossConfig) {
      let mode
      try {
        mode = checkOssConfig(ossConfig)
      } catch (error) {
        const wrapped = new Mem0SidecarError(`dsh-mem0: ${error.message}`, { code: error.code, cause: error })
        wrapped.component = error.component
        wrapped.configError = true
        throw wrapped
      }
      if (mode.pathIgnored && !this.warnedPathIgnored) {
        this.warnedPathIgnored = true
        this.logger?.warn?.('dsh-mem0: vector_store.config.path is ignored; the Qdrant server at url/host is used')
        this.log?.write('vector_store.config.path is ignored; the Qdrant server at url/host is used', 'event')
      }
    }

    const child = spawn(
      this.pythonPath,
      [
        this.sidecarPath,
        '--config',
        this.mem0ConfigPath,
        '--collection',
        this.collectionName,
        '--user-id',
        this.userId,
        '--agent-id',
        this.agentId,
        '--history-db',
        this.historyDbPath,
        '--token-stdin',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildSidecarEnv(this.env, this.extraEnv),
      },
    )
    // The token travels on stdin so it never appears in the process list.
    child.stdin?.on('error', () => {})
    child.stdin?.end(`${this.token}
`)
    this.child = child
    this.ready = false
    this.port = undefined
    this.starts += 1
    const spawnedAt = this.now()
    let readyAt
    let resolveExit
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve
    })
    this.currentExit = { child, promise: exitPromise }
    this.log?.write(
      `sidecar starting (start #${this.starts}, spawned pid ${child.pid ?? '?'}, python ${this.pythonPath}${this.pythonSource === 'path' ? ' from PATH: no Mem0 venv was found' : this.pythonSource ? ` (${this.pythonSource})` : ''})`,
      'event',
    )

    let settle
    const readyPromise = new Promise((resolve, reject) => {
      settle = { resolve, reject }
    })

    const stdout = createInterface({ input: child.stdout })
    let gotReady = false
    const timer = setTimeout(() => {
      if (!gotReady) {
        settle.reject(
          new Mem0SidecarError(
            `dsh-mem0: sidecar did not become ready within ${this.startupTimeoutMs}ms`,
            { code: 'STARTUP_TIMEOUT' },
          ),
        )
        child.dshStoppedBy = 'startup-timeout'
        this.#terminateChild(child, true)
      }
    }, this.startupTimeoutMs)

    const stderr = createInterface({ input: child.stderr })
    // The last stderr lines before ready, to name the exception that
    // stopped a start (a traceback ends with it).
    const startupStderr = []
    stderr.on('line', (line) => {
      if (!line.trim()) return
      if (!gotReady) {
        startupStderr.push(line)
        if (startupStderr.length > STARTUP_STDERR_LINES) startupStderr.shift()
      }
      this.logger?.debug?.(`dsh-mem0 sidecar: ${line}`)
      this.log?.write(line, 'stderr')
    })

    stdout.on('line', (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.logger?.debug?.(`dsh-mem0 sidecar stdout: ${line}`)
        return
      }
      if (!gotReady && message && typeof message.port === 'number') {
        gotReady = true
        this.port = message.port
        this.ready = true
        readyAt = this.now()
        this.startedAt = readyAt
        // The sidecar reports os.getpid(): on Windows the spawned venv
        // python.exe is a launcher and this is the real interpreter.
        this.pid = Number.isInteger(message.pid) ? message.pid : child.pid
        this.launcherPid = child.pid
        clearTimeout(timer)
        this.logger?.info?.(`dsh-mem0: sidecar ready on 127.0.0.1:${message.port} (collection ${this.collectionName})`)
        this.log?.write(
          `sidecar ready after ${readyAt - spawnedAt} ms, pid ${this.pid}${this.launcherPid && this.launcherPid !== this.pid ? ` (launcher pid ${this.launcherPid})` : ''}`,
          'event',
        )
        settle.resolve()
      } else if (message && message.error) {
        const code = typeof message.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(message.code) ? message.code : 'SIDECAR_START_FAILED'
        const error = new Mem0SidecarError(`dsh-mem0 sidecar failed: ${message.error}`, { code })
        // component / provider / endpoint when a component stopped the start
        // (Qdrant refused, Ollama down, embedded Qdrant config).
        Object.assign(error, failureAttribution(message))
        if (CONFIG_ERROR_CODES.includes(code)) error.configError = true
        error.startReason = String(message.error)
        settle.reject(error)
      }
    })

    child.once('error', (error) => {
      if (!gotReady) settle.reject(new Mem0SidecarError(`dsh-mem0: failed to spawn Python: ${error.message}`, {
        code: 'SPAWN_FAILED',
        cause: error,
      }))
    })

    child.once('exit', (code, signal) => {
      child.dshExited = true
      const wasReady = gotReady
      const exitedAt = this.now()
      const exit = {
        at: new Date(exitedAt).toISOString(),
        code: Number.isInteger(code) ? code : null,
        signal: typeof signal === 'string' ? signal : null,
        uptimeMs: Math.max(0, exitedAt - (readyAt ?? spawnedAt)),
        phase: wasReady ? 'running' : 'startup',
        pid: (wasReady ? this.pid : undefined) ?? child.pid ?? null,
        ...(child.dshStoppedBy ? { stoppedBy: child.dshStoppedBy } : {}),
      }
      this.lastExit = exit
      resolveExit(exit)
      this.log?.write(describeExit(exit), 'event')
      if (this.child === child) {
        this.child = undefined
        this.ready = false
        this.port = undefined
      }
      if (wasReady) {
        this.logger?.warn?.(`dsh-mem0: sidecar exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`)
      } else {
        settle.reject(
          new Mem0SidecarError(
            `dsh-mem0: sidecar exited before ready (code ${code ?? 'null'}, signal ${signal ?? 'none'})`,
            { code: 'START_FAILED' },
          ),
        )
      }
      // Requests to this child normally fail on their own (refused/reset)
      // right away; abort what is left after a grace so nothing hangs.
      const abortLeft = () => {
        for (const [controller, target] of this.pendingControllers) {
          if (target !== child) continue
          controller.abort(new Error('dsh-mem0 sidecar exited'))
          this.pendingControllers.delete(controller)
        }
      }
      if (this.exitAbortGraceMs > 0) setTimeout(abortLeft, this.exitAbortGraceMs).unref?.()
      else abortLeft()
    })

    // Keep reading stdout and stderr for the child's whole life. Closing the
    // readline interfaces pauses the pipes; the sidecar logs a ~11 KB
    // traceback per failed request, so after a handful of failures its next
    // write blocks and every request hangs (the process stays alive). The
    // streams end on their own when the child exits.
    try {
      await readyPromise
      this.#notifyReady()
    } catch (error) {
      // A child that exited during startup: say how (code, signal, uptime).
      if (error?.code !== 'STARTUP_TIMEOUT' && error?.code !== 'SPAWN_FAILED') {
        const exit = await Promise.race([exitPromise, delay(this.exitWaitMs)])
        if (exit && !Number.isInteger(error.exitCode) && !error.signal) {
          // exitFields sets component sidecar; keep a component the sidecar named.
          const component = error.component
          Object.assign(error, exitFields(exit))
          if (component) error.component = component
        }
      }
      // Name the exception that stopped it: the JSON error line, else the
      // last exception in stderr (a crash before the sidecar could answer).
      if (!error.startReason) {
        const fromStderr = lastExceptionLine(startupStderr)
        if (fromStderr) {
          error.startReason = fromStderr
          error.message = `${error.message}: ${sanitizeFailureMessage(fromStderr)}`
        }
      }
      if (MEM0_MISSING_RE.test(error.startReason ?? '') || error.code === 'MEM0_NOT_INSTALLED') {
        const reason = /ModuleNotFoundError/.test(error.startReason ?? '') ? error.startReason : "ModuleNotFoundError: No module named 'mem0'"
        error.startReason = mem0MissingMessage(this.pythonPath, this.pythonSource, reason)
        error.message = error.startReason
        error.component = 'sidecar'
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  #notifyReady() {
    try {
      this.onReady?.()
    } catch (error) {
      this.logger?.debug?.(`dsh-mem0: sidecar onReady failed: ${error?.message}`)
    }
  }

  /**
   * Send SIGTERM (or SIGKILL with `force`) unless the child has already
   * exited. `child.killed` only says a signal was sent, so it is not a
   * reason to skip: a child that ignored SIGTERM must still get SIGKILL.
   *
   * Windows has no POSIX signals: Node's `kill()` calls TerminateProcess
   * for both, so SIGTERM already ends the spawned process at once. That is
   * the venv launcher (`python.exe`); the real interpreter is its child.
   * The launcher is not a Job object owner, so when it is killed its child
   * normally exits on the closed stdio pipes (the sidecar's serve loop ends
   * when Node, its only client, goes away) rather than with the launcher.
   */
  #terminateChild(child, force = false) {
    if (!child || hasExited(child)) return
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM')
    } catch {
      // The process may already be gone.
    }
  }

  /**
   * `options.waitForStart: false` (automatic recall) never waits for Python to
   * boot: it starts the sidecar in the background and fails fast. Otherwise
   * the caller waits for the shared startup, which honours `options.signal`
   * and is bounded by `startupTimeoutMs`; `timeoutMs` then bounds the request.
   */
  async request(method, path, body, options = {}) {
    if (!this.running) {
      if (options.waitForStart === false) this.#requireReadyNow()
      else await this.#awaitStarted(options.signal)
    }
    if (!this.port) throw new Mem0SidecarError('dsh-mem0: sidecar has no port', { code: 'NOT_READY' })
    // Tracked so a sidecar exit or dispose aborts requests still in flight.
    const controller = new AbortController()
    const served = this.currentExit
    this.pendingControllers.set(controller, served?.child)
    try {
      return await requestJson({
        url: `http://127.0.0.1:${this.port}${path}`,
        method,
        path,
        headers: {
          'content-type': 'application/json',
          'x-dsh-mem0-token': this.token,
        },
        body,
        signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
        timeoutMs: options.timeoutMs ?? this.requestTimeoutMs,
        ErrorClass: Mem0SidecarError,
        label: 'dsh-mem0:',
      })
    } catch (error) {
      // Our own timeout fired while the sidecar was still working: ask which
      // step is running (an Ollama embedder reloading its model, a slow
      // cloud LLM, …) so the failure names the component.
      if (error?.code === 'ABORTED' && !controller.signal.aborted && !options.signal?.aborted && path !== '/steps') {
        await this.#attachRunningStep(error)
      }
      if (error?.code === 'NETWORK_ERROR' || (error?.code === 'ABORTED' && controller.signal.aborted && !this.disposed)) {
        // Only a refused connection proves the sidecar never got the request
        // (see provesNotDelivered); callers may retry only then.
        error.delivered = provesNotDelivered(error) ? false : undefined
        if (error.delivered === undefined) delete error.delivered
        // The sidecar may have died: wait briefly for its exit so the
        // failure carries the exit code, signal and uptime.
        const exit = served ? await Promise.race([served.promise, delay(this.exitWaitMs)]) : undefined
        if (exit) Object.assign(error, exitFields(exit))
      }
      throw error
    } finally {
      this.pendingControllers.delete(controller)
    }
  }

  async #attachRunningStep(error) {
    try {
      const status = await requestJson({
        url: `http://127.0.0.1:${this.port}/steps`,
        method: 'GET',
        path: '/steps',
        headers: { 'x-dsh-mem0-token': this.token },
        timeoutMs: 1_000,
        ErrorClass: Mem0SidecarError,
        label: 'dsh-mem0:',
      })
      Object.assign(error, attributeRunningStep(status))
    } catch {
      // Older sidecar or no answer: the failure stays unattributed.
    }
  }

  health(options = {}) {
    return this.request('GET', '/health', undefined, { ...options, timeoutMs: options.timeoutMs ?? 5_000 })
  }

  search(query, filters, options = {}) {
    return this.request('POST', '/search', {
      query,
      filters,
      top_k: options.topK,
      threshold: options.threshold,
    }, options)
  }

  add(messages, options = {}) {
    return this.request('POST', '/add', {
      messages,
      user_id: options.userId,
      agent_id: options.agentId,
      run_id: options.runId,
      metadata: options.metadata,
      infer: options.infer === true,
      // Output budget for this add's LLM calls (the retry after an
      // extraction answer cut off at finish_reason=length).
      llm_max_tokens: Number.isInteger(options.llmMaxTokens) ? options.llmMaxTokens : undefined,
    }, { ...options, timeoutMs: options.timeoutMs ?? this.addTimeoutMs })
  }

  list(filters, options = {}) {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(filters ?? {})) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
    }
    if (options.topK !== undefined) query.set('top_k', String(options.topK))
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return this.request('GET', `/memories${suffix}`, undefined, options)
  }

  get(memoryId, options = {}) {
    return this.request('GET', `/memories/${encodeURIComponent(memoryId)}`, undefined, options)
  }

  update(memoryId, update, options = {}) {
    return this.request('PUT', `/memories/${encodeURIComponent(memoryId)}`, update, options)
  }

  remove(memoryId, options = {}) {
    return this.request('DELETE', `/memories/${encodeURIComponent(memoryId)}`, undefined, options)
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const controller of this.pendingControllers.keys()) controller.abort(new Error('dsh-mem0 disposed'))
    this.pendingControllers.clear()
    const child = this.child
    if (!child) return
    child.dshStoppedBy = 'dispose'
    this.#terminateChild(child)
    let exited = await waitForExit(child, this.stopGraceMs)
    if (!exited) {
      // It ignored SIGTERM: escalate and wait for the exit to be confirmed.
      this.log?.write(`sidecar did not exit ${this.stopGraceMs} ms after SIGTERM; sending SIGKILL`, 'event')
      this.#terminateChild(child, true)
      exited = await waitForExit(child, this.stopGraceMs)
      if (!exited) this.logger?.warn?.(`dsh-mem0: sidecar pid ${child.pid ?? '?'} did not exit after SIGKILL`)
    }
    this.child = undefined
    this.ready = false
    this.port = undefined
  }
}

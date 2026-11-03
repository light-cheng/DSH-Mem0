/**
 * Managed bridge to the Python Mem0 OSS sidecar.
 *
 * The sidecar binds a random loopback port and is protected by a per-process
 * bearer token. Node owns its lifecycle, so a plugin unload/HMR cannot leave an
 * orphaned Python process holding the Qdrant collection.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const SIDECAR_SCRIPT = fileURLToPath(new URL('../python/mem0_sidecar.py', import.meta.url))
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_ADD_TIMEOUT_MS = 120_000
const DEFAULT_STOP_GRACE_MS = 3_000

export class Mem0SidecarError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'Mem0SidecarError'
    this.code = options.code ?? 'DSH_MEM0_SIDECAR_ERROR'
    this.status = options.status
    this.path = options.path
  }
}

/** Small circuit breaker for background memory calls. */
export class CircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 120_000, now = () => Date.now() } = {}) {
    this.threshold = threshold
    this.cooldownMs = cooldownMs
    this.now = now
    this.failures = 0
    this.openUntil = 0
  }

  isOpen() {
    if (this.failures < this.threshold) return false
    if (this.now() < this.openUntil) return true
    this.failures = 0
    this.openUntil = 0
    return false
  }

  recordSuccess() {
    this.failures = 0
    this.openUntil = 0
  }

  recordFailure() {
    this.failures += 1
    if (this.failures >= this.threshold) this.openUntil = this.now() + this.cooldownMs
    return this.failures >= this.threshold
  }

  reset() {
    this.failures = 0
    this.openUntil = 0
  }
}

function combineSignals(signal, timeoutMs) {
  const controller = new AbortController()
  const timer =
    typeof timeoutMs === 'number' && timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs)
      : undefined
  const abortFromCaller = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) abortFromCaller()
    else signal.addEventListener('abort', abortFromCaller, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup() {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', abortFromCaller)
    },
  }
}

export class Mem0SidecarClient {
  constructor(options) {
    this.pythonPath = options.pythonPath
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
    this.token = randomUUID()
    this.child = undefined
    this.port = undefined
    this.ready = false
    this.disposed = false
    this.startPromise = undefined
    this.pendingControllers = new Set()
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
    this.startPromise = this.#start().finally(() => {
      this.startPromise = undefined
    })
    return this.startPromise
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
        '--token',
        this.token,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          MEM0_TELEMETRY: 'false',
          PYTHONUNBUFFERED: '1',
        },
      },
    )
    this.child = child
    this.ready = false
    this.port = undefined

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
        this.#terminateChild(child, true)
      }
    }, this.startupTimeoutMs)

    const stderr = createInterface({ input: child.stderr })
    stderr.on('line', (line) => {
      if (line.trim()) this.logger?.debug?.(`dsh-mem0 sidecar: ${line}`)
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
        clearTimeout(timer)
        this.logger?.info?.(`dsh-mem0: sidecar ready on 127.0.0.1:${message.port} (collection ${this.collectionName})`)
        settle.resolve()
      } else if (message && message.error) {
        settle.reject(new Mem0SidecarError(`dsh-mem0 sidecar failed: ${message.error}`, {
          code: message.code ?? 'SIDECAR_START_FAILED',
        }))
      }
    })

    child.once('error', (error) => {
      if (!gotReady) settle.reject(new Mem0SidecarError(`dsh-mem0: failed to spawn Python: ${error.message}`, {
        code: 'SPAWN_FAILED',
        cause: error,
      }))
    })

    child.once('exit', (code, signal) => {
      const wasReady = gotReady
      this.child = undefined
      this.ready = false
      this.port = undefined
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
      for (const controller of this.pendingControllers) {
        controller.abort(new Error('dsh-mem0 sidecar exited'))
      }
      this.pendingControllers.clear()
    })

    try {
      await readyPromise
    } finally {
      clearTimeout(timer)
      stdout.close()
      stderr.close()
    }
  }

  #terminateChild(child, force = false) {
    if (!child || child.killed) return
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM')
    } catch {
      // The process may already be gone.
    }
  }

  async request(method, path, body, options = {}) {
    await this.ensureStarted()
    if (!this.port) throw new Mem0SidecarError('dsh-mem0: sidecar has no port', { code: 'NOT_READY' })
    const url = new URL(`http://127.0.0.1:${this.port}${path}`)
    const { signal, cleanup } = combineSignals(options.signal, options.timeoutMs ?? this.requestTimeoutMs)
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    this.pendingControllers.add(controller)
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-dsh-mem0-token': this.token,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? null : JSON.parse(text)
      } catch {
        payload = text
      }
      if (!response.ok) {
        const detail =
          payload && typeof payload === 'object' && typeof payload.error === 'string'
            ? payload.error
            : typeof payload === 'string'
              ? payload
              : `HTTP ${response.status}`
        throw new Mem0SidecarError(`dsh-mem0: ${method} ${path} failed: ${detail}`, {
          code: 'BACKEND_ERROR',
          status: response.status,
          path,
        })
      }
      return payload
    } catch (error) {
      if (error instanceof Mem0SidecarError) throw error
      if (signal.aborted) {
        throw new Mem0SidecarError(`dsh-mem0: ${method} ${path} aborted`, {
          code: 'ABORTED',
          path,
          cause: error,
        })
      }
      throw new Mem0SidecarError(`dsh-mem0: ${method} ${path} failed: ${error.message}`, {
        code: 'NETWORK_ERROR',
        path,
        cause: error,
      })
    } finally {
      signal.removeEventListener('abort', abort)
      this.pendingControllers.delete(controller)
      cleanup()
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
    for (const controller of this.pendingControllers) controller.abort(new Error('dsh-mem0 disposed'))
    this.pendingControllers.clear()
    const child = this.child
    if (!child) return
    this.#terminateChild(child)
    const exited = await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true)
        return
      }
      const timer = setTimeout(() => resolve(false), this.stopGraceMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (!exited) this.#terminateChild(child, true)
    this.child = undefined
    this.ready = false
    this.port = undefined
  }
}

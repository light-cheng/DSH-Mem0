/**
 * `sidecar.log`: the OSS sidecar's stderr, plus its start/exit events, kept
 * in the plugin's profile data directory (next to failures.json) so the
 * reason a sidecar died can still be read after it is gone.
 *
 * Every line is redacted before it is written (redactSecrets, home paths
 * shortened to `~`) and capped in length. The file is capped at `maxBytes`;
 * when a write would pass the cap the file is renamed to `sidecar.log.1`
 * (replacing an older one) and a new file starts. Without a file path the
 * log keeps only the last lines in memory.
 *
 * Writes are synchronous appends: the sidecar writes stderr rarely (a
 * warning at startup, a traceback per failed request).
 */
import fs from 'node:fs'
import path from 'node:path'
import { redactLogText } from './failure-history.js'

export const SIDECAR_LOG_MAX_BYTES = 512 * 1024
export const SIDECAR_LOG_LINE_MAX_CHARS = 2_000
const MEMORY_LINES = 200

export class SidecarLog {
  /**
   * @param {object} [options]
   * @param {string} [options.filePath] log file; without one, memory only.
   * @param {number} [options.maxBytes] rotate when the file would pass this.
   */
  constructor({ filePath, maxBytes = SIDECAR_LOG_MAX_BYTES, logger, now = () => new Date(), home } = {}) {
    this.filePath = filePath
    this.maxBytes = Math.max(1024, Number(maxBytes) || SIDECAR_LOG_MAX_BYTES)
    this.logger = logger
    this.now = now
    this.home = home
    this.memory = []
    this.lastError = null
    this.warned = false
  }

  /** Redacted, single-line, capped. Exported behaviour for tests. */
  sanitize(line) {
    let text = redactLogText(String(line ?? ''), this.home === undefined ? undefined : { home: this.home })
      .replace(/[\r\n]+/g, ' ')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trimEnd()
    if (text.length > SIDECAR_LOG_LINE_MAX_CHARS) text = `${text.slice(0, SIDECAR_LOG_LINE_MAX_CHARS - 1)}…`
    return text
  }

  /** Append one line (`source` is e.g. `stderr` or `event`). Never throws. */
  write(line, source = 'stderr') {
    const text = this.sanitize(line)
    if (!text.trim()) return
    const entry = `${this.now().toISOString()} ${source} ${text}\n`
    this.memory.push(entry.trimEnd())
    if (this.memory.length > MEMORY_LINES) this.memory.splice(0, this.memory.length - MEMORY_LINES)
    if (!this.filePath) return
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      let size = 0
      try {
        size = fs.statSync(this.filePath).size
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      if (size > 0 && size + Buffer.byteLength(entry) > this.maxBytes) {
        fs.renameSync(this.filePath, `${this.filePath}.1`)
      }
      fs.appendFileSync(this.filePath, entry, { mode: 0o600 })
      this.lastError = null
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      if (!this.warned) {
        this.warned = true
        this.logger?.warn?.(`dsh-mem0: could not write sidecar.log: ${this.lastError}`)
      }
    }
  }

  /**
   * The last `count` lines (oldest first), from the file and its rotated
   * copy, or from memory without a file. Lines are redacted again on the
   * way out, in case the file was edited by hand.
   */
  tail(count = 50) {
    const limit = Math.max(1, Math.min(500, Math.floor(Number(count) || 50)))
    if (!this.filePath) return this.memory.slice(-limit).map((line) => this.sanitize(line))
    const lines = []
    for (const file of [this.filePath, `${this.filePath}.1`]) {
      let text
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const fileLines = text.split('\n').filter((line) => line.trim())
      lines.unshift(...fileLines.slice(-(limit - lines.length)))
      if (lines.length >= limit) break
    }
    return lines.slice(-limit).map((line) => this.sanitize(line))
  }
}

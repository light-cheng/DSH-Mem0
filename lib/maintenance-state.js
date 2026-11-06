/**
 * Small local state file for the derived user profile and hygiene history.
 *
 * The profile is intentionally local: it is a cache derived from the backend
 * memories, not a second source of truth. Keeping it out of Mem0 means a
 * failed profile rebuild can never damage the actual memory store.
 *
 * `read()` runs on every prompt assembly (the summary section), so the parsed
 * file is cached in memory. A write refreshes the cache directly; a read only
 * re-parses the file when its stat signature (mtime, size, inode) changed,
 * which covers another DSH process writing the same profile.
 */
import fs from 'node:fs'
import path from 'node:path'

const EMPTY = Object.freeze({ version: 1, userId: '', profile: null, hygiene: null })

function parse(value) {
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY }
    return {
      version: 1,
      userId: typeof parsed.userId === 'string' ? parsed.userId : '',
      profile: parsed.profile && typeof parsed.profile === 'object' ? parsed.profile : null,
      hygiene: parsed.hygiene && typeof parsed.hygiene === 'object' ? parsed.hygiene : null,
    }
  } catch {
    return { ...EMPTY }
  }
}

export class MaintenanceState {
  constructor(filePath, logger) {
    this.filePath = filePath
    this.logger = logger
    this.lastError = null
    this.cache = undefined
    this.cacheSignature = undefined
    this.fileReads = 0
  }

  #signature() {
    try {
      const stat = fs.statSync(this.filePath, { bigint: true })
      return `${stat.mtimeNs}:${stat.size}:${stat.ino}`
    } catch (error) {
      if (error?.code === 'ENOENT') return 'missing'
      throw error
    }
  }

  read() {
    // No file (no profile directory): state lives in memory only.
    if (!this.filePath) return structuredClone(this.cache ?? { ...EMPTY })
    try {
      const signature = this.#signature()
      if (this.cache === undefined || signature !== this.cacheSignature) {
        if (signature === 'missing') {
          this.cache = { ...EMPTY }
        } else {
          this.fileReads += 1
          this.cache = parse(fs.readFileSync(this.filePath, 'utf8'))
        }
        this.cacheSignature = signature
      }
      // Callers may mutate what they get back (update mutators do).
      return structuredClone(this.cache)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.warn?.(`dsh-mem0: could not read maintenance state: ${error.message}`)
      }
      this.cache = undefined
      this.cacheSignature = undefined
      return { ...EMPTY }
    }
  }

  write(value) {
    if (!this.filePath) {
      this.cache = parse(JSON.stringify(value))
      this.lastError = null
      return true
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.tmp`
      const text = `${JSON.stringify(value, null, 2)}\n`
      fs.writeFileSync(temporary, text, { mode: 0o600 })
      fs.renameSync(temporary, this.filePath)
      this.cache = parse(text)
      try {
        this.cacheSignature = this.#signature()
      } catch {
        this.cache = undefined
        this.cacheSignature = undefined
      }
      this.lastError = null
      return true
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.logger?.warn?.(`dsh-mem0: could not write maintenance state: ${this.lastError}`)
      return false
    }
  }

  update(mutator) {
    const next = mutator(this.read())
    return this.write(next) ? next : null
  }
}

export { EMPTY as EMPTY_MAINTENANCE_STATE }

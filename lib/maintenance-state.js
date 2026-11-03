/**
 * Small local state file for the derived user profile and hygiene history.
 *
 * The profile is intentionally local: it is a cache derived from the backend
 * memories, not a second source of truth. Keeping it out of Mem0 means a
 * failed profile rebuild can never damage the actual memory store.
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
  }

  read() {
    try {
      return parse(fs.readFileSync(this.filePath, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.warn?.(`dsh-mem0: could not read maintenance state: ${error.message}`)
      }
      return { ...EMPTY }
    }
  }

  write(value) {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.tmp`
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(temporary, this.filePath)
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

/**
 * Notices when DSH rewrote the plugin's profile settings.
 *
 * DSH's settings sync (installing a plugin, changing a setting) rewrites the
 * profile's `cordis.patch.yml` from its in-memory tree. It has been seen to
 * cut the dsh-mem0 block down to `backend` alone, dropping the local
 * backend's settings, userId, agentId, translateMemories and
 * captureStrataFolds: memories then went to another store or user, or the
 * embedder was gone, with no error saying why.
 *
 * `config-fingerprint.json` in the plugin's profile data folder records
 * which key settings (lib/config.js KEY_FIELDS) were set the last time the
 * plugin ran fine: field names only, never their values. When a later start
 * finds some of them gone, the plugin reports it (settings page and
 * mem0_status) with how to restore them.
 *
 * A setting counts as kept when the `dsh_mem0` block of oss.json supplies
 * it: that block is outside DSH's reach (lib/oss-config.js).
 *
 * The fingerprint only grows: a rewrite must never become the new baseline.
 * After removing a setting on purpose, delete the file to clear the notice
 * (the settings page writes through DSH's own config API, so the plugin
 * cannot tell a page save from a settings-sync rewrite).
 *
 * Settings that no longer exist (`retiredFields`: pythonPath,
 * mem0ConfigPath, historyDbPath of the Python sidecar era) are dropped
 * from an old fingerprint instead of being reported missing, and the file
 * is rewritten without them the next time the plugin runs fine.
 */
import fs from 'node:fs'
import path from 'node:path'

export const CONFIG_FINGERPRINT_FILE = 'config-fingerprint.json'

export class ConfigGuard {
  /**
   * @param {object} options
   * @param {string} [options.filePath] fingerprint file; without one, nothing is kept.
   * @param {string[]} options.profileFields key fields the profile sets now.
   * @param {string[]} [options.fallbackFields] key fields oss.json's dsh_mem0 block supplies.
   * @param {string[]} [options.retiredFields] fields that no longer exist; ignored in an old fingerprint.
   */
  constructor({ filePath, profileFields = [], fallbackFields = [], retiredFields = [], logger, now = () => new Date() } = {}) {
    this.filePath = filePath
    this.logger = logger
    this.now = now
    this.retired = new Set(retiredFields)
    this.current = [...new Set(profileFields)].filter((field) => !this.retired.has(field)).sort()
    this.covered = new Set([...profileFields, ...fallbackFields])
    this.stored = this.#load()
    const missing = (this.stored?.fields ?? []).filter((field) => !this.covered.has(field))
    this.warning = missing.length > 0
      ? { missing, lastGoodAt: this.stored?.savedAt ?? null }
      : null
  }

  #load() {
    if (!this.filePath) return null
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (!Array.isArray(parsed?.fields)) return null
      const valid = parsed.fields.filter((field) => typeof field === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(field))
      const fields = valid.filter((field) => !this.retired.has(field))
      if (fields.length !== valid.length) {
        this.logger?.debug?.(`dsh-mem0: config fingerprint lists retired settings (${valid.filter((field) => this.retired.has(field)).join(', ')}); ignored`)
      }
      return {
        fields,
        savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
        hadRetired: fields.length !== valid.length,
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.debug?.(`dsh-mem0: ignoring config fingerprint: ${error.message}`)
      return null
    }
  }

  #write(fields) {
    if (!this.filePath) return
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const body = { version: 1, savedAt: this.now().toISOString(), fields: [...fields].sort() }
      fs.writeFileSync(this.filePath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
      this.stored = { fields: body.fields, savedAt: body.savedAt }
    } catch (error) {
      this.logger?.debug?.(`dsh-mem0: could not write config fingerprint: ${error.message}`)
    }
  }

  /**
   * The plugin ran fine with the current settings (the local store opened,
   * or a REST backend was set up). Recorded only when nothing is
   * missing, so a rewritten config never becomes the new baseline.
   */
  markWorking() {
    if (this.warning) return
    const fields = new Set([...(this.stored?.fields ?? []), ...this.current])
    const same = this.stored && !this.stored.hadRetired && this.stored.fields.length === fields.size
    if (!same) this.#write(fields)
  }

  /** `{ missing, lastGoodAt }` or null. */
  status() {
    return this.warning ? { missing: [...this.warning.missing], lastGoodAt: this.warning.lastGoodAt } : null
  }
}

/** One line for mem0_status and logs. */
export function describeConfigWarning(warning) {
  if (!warning?.missing?.length) return ''
  return (
    `dsh-mem0 settings look rewritten (DSH's settings sync can do this when a plugin is installed or a setting changes); missing: ${warning.missing.join(', ')}` +
    `${warning.lastGoodAt ? ` (all set on ${warning.lastGoodAt})` : ''}. ` +
    'Restore them on the plugin settings page, or keep them in the "dsh_mem0" block of oss.json, which DSH does not rewrite. ' +
    `If you removed them on purpose, delete ${CONFIG_FINGERPRINT_FILE} in the plugin's profile data folder (next to failures.json).`
  )
}

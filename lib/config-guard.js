/**
 * Notices when the plugin's profile settings went missing.
 *
 * The settings live in the DSH profile's `cordis.patch.yml`, which DSH
 * changes on its own in two ways:
 *
 * - Crash recovery (the cause of every whole-block loss seen so far): when
 *   DSH desktop fails to start, its dialog offers "Disable third-party
 *   plugins, back up the profile patch and restart". That button renames
 *   the whole file to `cordis.patch.yml.bak-<ms>` and leaves an empty `[]`
 *   in its place: the dsh-mem0 block, other plugins' blocks and the host's
 *   own settings (language, theme) are then only in the backup. A later
 *   save on the settings page writes a block holding just what it changed
 *   (often only `backend`). Memories then went to another store or user,
 *   or the embedder was gone, with no error saying why.
 * - A settings-page save drops every key of the dsh-mem0 block outside the
 *   Config schema (Config is volatile at the root), retired keys such as
 *   `pythonPath` included. That is expected and not reported.
 *
 * `config-fingerprint.json` in the plugin's profile data folder records
 * which key settings (lib/config.js KEY_FIELDS) were set the last time the
 * plugin ran fine: field names only, never their values. When a later start
 * finds some of them gone, the plugin reports it (settings page and
 * mem0_status) with how to restore them.
 *
 * A setting counts as kept when the `dsh_mem0` block of oss.json supplies
 * it: that block is outside DSH's reach (lib/oss-config.js), and the
 * plugin copies the key settings there on every settings-page save
 * (lib/config-mirror.js).
 *
 * Crash-recovery backups: a `cordis.patch.yml.bak-*` in the profile folder
 * newer than the fingerprint's `savedAt` is named in the notice (the file
 * name only; nothing of its content is read here), even when oss.json
 * covers every field, because the host's and other plugins' settings are
 * in it too. It stays `pendingBackup` until the settings page restores the
 * dsh-mem0 entry from it or the user dismisses the notice
 * (`handledBackups`).
 *
 * The fingerprint only grows: a lost block must never become the new
 * baseline. After removing a setting on purpose, delete the file to clear
 * the notice (the settings page writes through DSH's own config API, so
 * the plugin cannot tell a page save from a lost block).
 *
 * Settings that no longer exist (`retiredFields`: pythonPath,
 * mem0ConfigPath, historyDbPath of the Python sidecar era) are dropped
 * from an old fingerprint instead of being reported missing, and the file
 * is rewritten without them the next time the plugin runs fine.
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATCH_FILE, findPatchBackups, isPatchBackupName } from './patch-backup.js'

export const CONFIG_FINGERPRINT_FILE = 'config-fingerprint.json'

export class ConfigGuard {
  /**
   * @param {object} options
   * @param {string} [options.filePath] fingerprint file; without one, nothing is kept.
   * @param {string[]} options.profileFields key fields the profile sets now.
   * @param {string[]} [options.fallbackFields] key fields oss.json's dsh_mem0 block supplies.
   * @param {string[]} [options.retiredFields] fields that no longer exist; ignored in an old fingerprint.
   * @param {string} [options.profileDir] the profile folder holding cordis.patch.yml (crash-recovery backups).
   */
  constructor({ filePath, profileFields = [], fallbackFields = [], retiredFields = [], profileDir, logger, now = () => new Date(), fsModule = fs, pathModule = path } = {}) {
    this.filePath = filePath
    this.profileDir = profileDir
    this.logger = logger
    this.now = now
    this.fs = fsModule
    this.path = pathModule
    this.retired = new Set(retiredFields)
    this.current = [...new Set(profileFields)].filter((field) => !this.retired.has(field)).sort()
    this.covered = new Set([...profileFields, ...fallbackFields])
    this.stored = this.#load()
    this.missing = (this.stored?.fields ?? []).filter((field) => !this.covered.has(field))
    this.backup = this.#findBackup()
    this.#refresh()
  }

  #refresh() {
    this.warning = this.missing.length > 0 || this.backup
      ? { missing: [...this.missing], lastGoodAt: this.stored?.savedAt ?? null, backup: this.backup ?? null }
      : null
  }

  /**
   * The crash-recovery backup to name: the one already pending, else the
   * newest backup made after the plugin last ran fine. Needs a fingerprint
   * (without one there is no "last ran fine" to compare with).
   */
  #findBackup() {
    if (!this.profileDir || !this.stored?.savedAt) return null
    const handled = new Set(this.stored.handledBackups ?? [])
    const backups = findPatchBackups(this.profileDir, { fsModule: this.fs, pathModule: this.path })
    const names = new Set(backups.map((backup) => backup.name))
    const pending = this.stored.pendingBackup
    if (pending && names.has(pending) && !handled.has(pending)) return pending
    const savedAt = Date.parse(this.stored.savedAt)
    const newer = backups.find((backup) => Number.isFinite(savedAt) && backup.at > savedAt && !handled.has(backup.name))
    if (!newer) {
      if (pending) this.#write(this.stored.fields, { savedAt: this.stored.savedAt, pendingBackup: null })
      return null
    }
    this.#write(this.stored.fields, { savedAt: this.stored.savedAt, pendingBackup: newer.name })
    return newer.name
  }

  #load() {
    if (!this.filePath) return null
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'))
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
        pendingBackup: isPatchBackupName(parsed.pendingBackup) ? parsed.pendingBackup : null,
        handledBackups: Array.isArray(parsed.handledBackups) ? parsed.handledBackups.filter(isPatchBackupName).slice(-20) : [],
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.debug?.(`dsh-mem0: ignoring config fingerprint: ${error.message}`)
      return null
    }
  }

  #write(fields, { savedAt, pendingBackup, handledBackups } = {}) {
    if (!this.filePath) return
    const pending = pendingBackup === undefined ? this.stored?.pendingBackup ?? null : pendingBackup
    const handled = handledBackups ?? this.stored?.handledBackups ?? []
    try {
      this.fs.mkdirSync(this.path.dirname(this.filePath), { recursive: true })
      const body = {
        version: 1,
        savedAt: savedAt ?? this.now().toISOString(),
        fields: [...fields].sort(),
        ...(pending ? { pendingBackup: pending } : {}),
        ...(handled.length ? { handledBackups: handled.slice(-20) } : {}),
      }
      this.fs.writeFileSync(this.filePath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
      this.stored = { fields: body.fields, savedAt: body.savedAt, pendingBackup: pending, handledBackups: body.handledBackups ?? [] }
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
    // Missing fields block a new baseline; a pending backup alone does
    // not (oss.json covered every field), and it stays pending.
    if (this.missing.length > 0) return
    const fields = new Set([...(this.stored?.fields ?? []), ...this.current])
    const same = this.stored && !this.stored.hadRetired && this.stored.fields.length === fields.size
    if (!same) this.#write(fields)
  }

  /**
   * The user restored the dsh-mem0 entry from `name`, or dismissed the
   * notice: stop naming it. Returns whether it was the pending backup.
   */
  handleBackup(name) {
    if (!isPatchBackupName(name)) return false
    const handled = [...new Set([...(this.stored?.handledBackups ?? []), name])]
    const wasPending = this.backup === name
    if (this.stored) {
      this.#write(this.stored.fields, { savedAt: this.stored.savedAt, pendingBackup: wasPending ? null : this.stored.pendingBackup, handledBackups: handled })
    }
    if (wasPending) {
      this.backup = null
      this.#refresh()
    }
    return wasPending
  }

  /** `{ missing, lastGoodAt, backup }` or null. */
  status() {
    return this.warning ? { missing: [...this.warning.missing], lastGoodAt: this.warning.lastGoodAt, backup: this.warning.backup } : null
  }
}

/** The profile folder's patch file name and its backups' name pattern, for messages. */
export { PATCH_FILE }

/** One line for mem0_status and logs. */
export function describeConfigWarning(warning) {
  const missing = warning?.missing ?? []
  const backup = warning?.backup ?? null
  if (!missing.length && !backup) return ''
  // Two sentences at most: what happened (backup file, missing fields), then what to do.
  // Where the copy in oss.json and config-fingerprint.json come in is in the README.
  if (backup) {
    const what = missing.length
      ? `dsh-mem0 settings are missing from the profile (${missing.join(', ')}): DSH desktop crash recovery moved ${PATCH_FILE} to ${backup} in the profile folder.`
      : `DSH desktop crash recovery moved ${PATCH_FILE} to ${backup} in the profile folder.`
    return `${what} "Restore dsh-mem0 settings from the backup" on the plugin settings page brings back only this plugin's settings; the host settings (language, theme) and other plugins' settings are in that backup too and have to be copied back by hand.`
  }
  return `dsh-mem0 settings are missing from the profile: ${missing.join(', ')}${warning.lastGoodAt ? ` (all set on ${warning.lastGoodAt})` : ''}. Fill them in on the plugin settings page and save.`
}

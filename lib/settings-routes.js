/**
 * Settings-page actions around DSH's profile patch:
 *
 * - `saved`: the page saved settings through DSH's settings API; copy the
 *   key ones into oss.json's dsh_mem0 block (lib/config-mirror.js). A
 *   failure is reported as `{ ok: false }` with one warning in the log and
 *   never undoes or fails the save.
 * - `backup` (GET): the dsh-mem0 entry of the crash-recovery backup the
 *   notice names (lib/patch-backup.js), reduced to Config fields the page
 *   may write back. The page writes them with DSH's settings API (the
 *   dsh-mem0 form only), so no other entry of the profile is touched.
 * - `handled`: the page restored from the backup or the user dismissed
 *   the notice (lib/config-guard.js handleBackup).
 */
import { Config, RETIRED_KEY_FIELDS } from './config.js'
import { MIRROR_FIELDS, mirrorSavedSettings } from './config-mirror.js'
import { PatchBackupError, isPatchBackupName, readMem0Entry } from './patch-backup.js'
import { DEPRECATED_FIELDS } from './oss-config.js'

/** Config fields the restore never writes back. */
const NOT_RESTORED = new Set(['apiKey', ...RETIRED_KEY_FIELDS, ...DEPRECATED_FIELDS])

function schemaDefault(key) {
  const schema = Config.dict?.[key]
  return schema?.meta?.default
}

/**
 * The fields of a backup's dsh-mem0 config the page may write back: Config
 * fields only, of the field's type, no literal key, no retired setting.
 * Pure. Returns `{ settings, skipped, hadApiKey }` (skipped: names only).
 */
export function restorableSettings(config = {}) {
  const settings = {}
  const skipped = []
  for (const [key, value] of Object.entries(config ?? {})) {
    if (NOT_RESTORED.has(key) || !(key in (Config.dict ?? {}))) {
      if (key !== 'apiKey') skipped.push(key)
      continue
    }
    const fallback = schemaDefault(key)
    if (fallback !== undefined && typeof value !== typeof fallback) {
      skipped.push(key)
      continue
    }
    try {
      Config({ [key]: value })
    } catch {
      skipped.push(key)
      continue
    }
    settings[key] = value
  }
  const hadApiKey = typeof config?.apiKey === 'string' && config.apiKey.trim() !== ''
  return { settings, skipped: skipped.sort(), hadApiKey }
}

function pick(object, keys) {
  const out = {}
  if (!object || typeof object !== 'object') return out
  for (const key of keys) if (key in object) out[key] = object[key]
  return out
}

/** POST { action: 'saved', values, previous, changed }. */
export function handleSettingsSaved(runtime, body, { logger } = {}) {
  const file = runtime?.config?.ossConfigPath
  const changed = Array.isArray(body?.changed) ? body.changed.filter((key) => MIRROR_FIELDS.includes(key)) : []
  return mirrorSavedSettings(
    { values: pick(body?.values, MIRROR_FIELDS), previous: pick(body?.previous, MIRROR_FIELDS), changed },
    { file, logger },
  )
}

/** GET: the pending backup's dsh-mem0 entry, ready to write back. */
export function readBackupForRestore(runtime, name) {
  const pending = runtime?.configGuard?.status?.()?.backup ?? null
  const file = name || pending
  if (!file || !isPatchBackupName(file)) return { status: 404, body: { ok: false, reason: 'no-backup', error: 'no crash-recovery backup is pending' } }
  if (file !== pending) return { status: 409, body: { ok: false, reason: 'not-pending', error: 'only the backup the notice names can be restored' } }
  if (!runtime?.profileDir) return { status: 404, body: { ok: false, reason: 'no-profile', error: 'the profile folder is not known' } }
  try {
    const entry = readMem0Entry(runtime.profileDir, file)
    if (!entry.found) return { status: 200, body: { ok: false, reason: 'no-entry', file, error: `${file} has no dsh-mem0 entry` } }
    const { settings, skipped, hadApiKey } = restorableSettings(entry.config)
    return { status: 200, body: { ok: true, file, settings, skipped, hadApiKey } }
  } catch (error) {
    const code = error instanceof PatchBackupError ? error.code : 'BACKUP_UNREADABLE'
    return { status: 200, body: { ok: false, reason: code, file, error: error?.message ?? String(error) } }
  }
}

/** POST { action: 'handled', file }. */
export function handleBackupHandled(runtime, body) {
  const file = String(body?.file ?? '')
  if (!isPatchBackupName(file)) return { status: 400, body: { ok: false, reason: 'bad-request', error: 'file must be a cordis.patch.yml.bak-* name' } }
  const cleared = runtime?.configGuard?.handleBackup?.(file) ?? false
  return { status: 200, body: { ok: true, cleared, configWarning: runtime?.configGuard?.status?.() ?? null } }
}

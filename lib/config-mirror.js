/**
 * A copy of the key plugin settings in oss.json's `dsh_mem0` block, written
 * by the plugin after every settings-page save.
 *
 * The profile's `cordis.patch.yml` is DSH's file and DSH changes it on its
 * own: desktop's crash recovery ("disable third-party plugins, back up the
 * profile patch and restart") moves the whole file to
 * `cordis.patch.yml.bak-<ms>`, and a settings-page save drops every key of
 * the dsh-mem0 block outside the Config schema (Config is volatile at the
 * root). `~/.dsh/mem0/oss.json` is never touched by DSH, and lib/config.js
 * already fills fields the profile leaves unset from its `dsh_mem0` block:
 * the profile wins, the copy only fills gaps.
 *
 * What is copied: `MIRROR_FIELDS` (lib/oss-config.js OSS_FALLBACK_FIELDS):
 * the backend and where it is (backend, baseUrl, authType, apiKeyEnv), who
 * memories belong to (userId, agentId, collectionName), the local store,
 * embedder and extraction LLM, translateMemories and captureStrataFolds.
 * Never a key: `apiKey` is not a mirror field, credential fields must be
 * reference names, and a URL with user info is skipped.
 *
 * How the block changes on a save:
 * - a field set to something other than its default is written;
 * - a field the save changed back to its default (or emptied) is removed,
 *   but only when the block still holds the value the profile had before
 *   the save, so a value the setup wizard wrote is not removed by an
 *   unrelated profile change;
 * - every other field is left as it is (a profile that lost a field must
 *   not wipe the copy).
 *
 * The file is written atomically (temporary file, then rename) and only
 * the `dsh_mem0` block changes; every other key is kept. A failure never
 * fails the save: the caller logs one warning.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isFieldSet } from './config.js'
import { OSS_CONFIG_INVALID, OSS_FALLBACK_FIELDS, fallbackValue, readOssConfig } from './oss-config.js'

export const MIRROR_FIELDS = Object.freeze(Object.keys(OSS_FALLBACK_FIELDS))

export class MirrorError extends Error {
  constructor(message, code = 'MIRROR_FAILED') {
    super(message)
    this.name = 'MirrorError'
    this.code = code
  }
}

function same(a, b) {
  return a === b || (typeof a === 'string' && typeof b === 'string' && a.trim() === b.trim())
}

/**
 * The next `dsh_mem0` block for a save. Pure.
 * @param {object} block the current block.
 * @param {object} save
 * @param {object} save.values the profile's values after the save.
 * @param {object} [save.previous] the profile's values before it.
 * @param {string[]} [save.changed] fields the save changed.
 * @returns {{ block: object, written: string[], removed: string[] }}
 */
export function mirrorBlock(block = {}, { values = {}, previous = {}, changed = [] } = {}) {
  const next = { ...block }
  const written = []
  const removed = []
  const changedSet = new Set(changed)
  for (const key of MIRROR_FIELDS) {
    if (isFieldSet(values, key)) {
      const value = fallbackValue(key, values[key])
      if (value === undefined) continue
      if (!same(next[key], value)) written.push(key)
      next[key] = value
      continue
    }
    if (!changedSet.has(key) || !(key in next)) continue
    if (isFieldSet(previous, key) && same(next[key], fallbackValue(key, previous[key]))) {
      delete next[key]
      removed.push(key)
    }
  }
  // Defence in depth: whatever was in the block, no literal key goes back.
  for (const key of ['apiKey', 'api_key']) {
    if (key in next) {
      delete next[key]
      removed.push(key)
    }
  }
  return { block: next, written, removed }
}

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

function renameWithRetry(fsModule, from, to, platform) {
  // Windows: an antivirus or indexer holding oss.json open fails the
  // rename for a moment; try a few times before giving up.
  const attempts = platform === 'win32' ? 5 : 1
  for (let attempt = 1; ; attempt += 1) {
    try {
      fsModule.renameSync(from, to)
      return
    } catch (error) {
      if (attempt >= attempts || !RETRY_CODES.has(error?.code)) throw error
      const until = Date.now() + 40 * attempt
      while (Date.now() < until) {
        // short busy wait: a save is rare and this is a sync write
      }
    }
  }
}

/**
 * Write the copy into `file`'s `dsh_mem0` block.
 * @returns {{ changed: boolean, written: string[], removed: string[] }}
 */
export function writeSettingsCopy(save, { file, fsModule = fs, pathModule = path, platform = process.platform } = {}) {
  if (!file) throw new MirrorError('no oss.json path', 'MIRROR_NO_PATH')
  const current = readOssConfig(file, { fsModule })
  if (current?.[OSS_CONFIG_INVALID]) {
    throw new MirrorError(`${current[OSS_CONFIG_INVALID]}; the settings copy was not written`, 'CONFIG_INVALID')
  }
  if (current !== undefined && (typeof current !== 'object' || current === null || Array.isArray(current))) {
    throw new MirrorError('oss.json is not a JSON object; the settings copy was not written', 'CONFIG_INVALID')
  }
  const base = current ?? {}
  const block = base.dsh_mem0 && typeof base.dsh_mem0 === 'object' && !Array.isArray(base.dsh_mem0) ? base.dsh_mem0 : {}
  const { block: nextBlock, written, removed } = mirrorBlock(block, save)
  if (written.length === 0 && removed.length === 0 && current !== undefined) return { changed: false, written, removed }
  if (current === undefined && Object.keys(nextBlock).length === 0) return { changed: false, written, removed }
  const next = { ...base, dsh_mem0: nextBlock }
  fsModule.mkdirSync(pathModule.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  fsModule.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  try {
    renameWithRetry(fsModule, temp, file, platform)
  } catch (error) {
    try {
      fsModule.rmSync(temp, { force: true })
    } catch {
      // nothing more to do
    }
    throw error
  }
  if (platform !== 'win32') {
    try {
      fsModule.chmodSync(file, 0o600)
    } catch {
      // best effort
    }
  }
  return { changed: true, written, removed }
}

/**
 * Copy a save into oss.json; never throws. A failure is one warning line
 * (no values: they are the user's settings).
 * @returns {{ ok: boolean, written?: string[], removed?: string[], error?: string }}
 */
export function mirrorSavedSettings(save, { file, logger, ...options } = {}) {
  try {
    const outcome = writeSettingsCopy(save, { file, ...options })
    if (outcome.changed) {
      logger?.debug?.(`dsh-mem0: settings copy in oss.json updated (${[...outcome.written, ...outcome.removed.map((key) => `-${key}`)].join(', ')})`)
    }
    return { ok: true, written: outcome.written, removed: outcome.removed }
  } catch (error) {
    const message = `dsh-mem0: the settings were saved, but their copy in oss.json (dsh_mem0) could not be written: ${error?.code ? `${error.code} ` : ''}${error?.message ?? error}`
    logger?.warn?.(message)
    return { ok: false, error: message }
  }
}

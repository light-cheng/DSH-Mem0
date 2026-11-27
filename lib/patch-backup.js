/**
 * Backups of the profile patch left by DSH desktop's crash recovery.
 *
 * When the desktop app fails to start it offers "Disable third-party
 * plugins, back up the profile patch and restart". That button renames the
 * whole `cordis.patch.yml` to `cordis.patch.yml.bak-<Date.now()>` and DSH
 * then writes an empty `[]` template in its place: the host's own settings
 * (language, theme), every plugin's block and the dsh-mem0 block are all
 * only in the backup from then on. DSH never merges it back.
 *
 * This module finds those backups (by file name only) and reads the one
 * entry whose id is `dsh-mem0` out of one, so the settings page can write
 * it back through DSH's settings API. Nothing else in the backup is read
 * into the plugin, and nothing of it goes to a log.
 *
 * DSH writes the patch with the `yaml` package; the plugin has no YAML
 * dependency, so `parseYaml` reads the subset a profile patch uses: block
 * and flow mappings and sequences, plain and quoted scalars, comments.
 * Anchors, tags and block scalars (`|`, `>`) are refused with an error, and
 * the user restores by hand.
 */
import fs from 'node:fs'
import path from 'node:path'

export const PATCH_FILE = 'cordis.patch.yml'
const BACKUP_RE = /^cordis\.patch\.yml\.bak-(\d{10,16})$/

/**
 * Crash-recovery backups of the profile patch in `profileDir`, newest
 * first: `[{ name, at }]` (`at` in ms, from the name; the file's mtime when
 * the number is not a plausible time).
 * @param {string|undefined} profileDir
 * @param {object} [options]
 * @param {typeof fs} [options.fsModule]
 * @param {typeof path} [options.pathModule] path.win32 in tests.
 */
export function findPatchBackups(profileDir, { fsModule = fs, pathModule = path } = {}) {
  if (!profileDir) return []
  let names
  try {
    names = fsModule.readdirSync(profileDir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const match = BACKUP_RE.exec(String(name))
    if (!match) continue
    let at = Number(match[1])
    // Date.now() of 2001…2286 has 13 digits; anything else: ask the file.
    if (!(at >= 1e12 && at < 1e13)) {
      try {
        at = fsModule.statSync(pathModule.join(profileDir, name)).mtimeMs
      } catch {
        continue
      }
    }
    out.push({ name: String(name), at })
  }
  return out.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1))
}

/** Whether `name` is a backup file name this module would read. */
export function isPatchBackupName(name) {
  return typeof name === 'string' && BACKUP_RE.test(name)
}

export class PatchBackupError extends Error {
  constructor(message, code = 'BACKUP_UNREADABLE') {
    super(message)
    this.name = 'PatchBackupError'
    this.code = code
  }
}

/**
 * The `config` of the `dsh-mem0` entry in a backup:
 * `{ found, config }` (config `{}` when the entry has none).
 * Looks at top-level entries and those inside an `insert:` list.
 * @param {string} profileDir
 * @param {string} name a backup file name (no directory).
 */
export function readMem0Entry(profileDir, name, { fsModule = fs, pathModule = path, id = 'dsh-mem0' } = {}) {
  if (!isPatchBackupName(name)) throw new PatchBackupError('not a profile patch backup name', 'BACKUP_NAME')
  let text
  try {
    text = fsModule.readFileSync(pathModule.join(profileDir, name), 'utf8')
  } catch (error) {
    throw new PatchBackupError(`${name} cannot be read (${error?.code ?? 'error'})`, error?.code === 'ENOENT' ? 'BACKUP_MISSING' : 'BACKUP_UNREADABLE')
  }
  let doc
  try {
    doc = parseYaml(text)
  } catch (error) {
    // Line number only: the backup holds other plugins' settings and keys.
    throw new PatchBackupError(`${name} could not be parsed (${error.message}); copy the dsh-mem0 entry back by hand`, 'BACKUP_PARSE')
  }
  return mem0EntryOf(doc, id)
}

/** The `dsh-mem0` entry of a parsed patch list. */
export function mem0EntryOf(doc, id = 'dsh-mem0') {
  const entries = []
  for (const item of Array.isArray(doc) ? doc : []) {
    if (!isMap(item)) continue
    entries.push(item)
    if (Array.isArray(item.insert)) entries.push(...item.insert.filter(isMap))
  }
  const entry = entries.find((item) => item.id === id)
  if (!entry) return { found: false, config: {} }
  return { found: true, config: isMap(entry.config) ? { ...entry.config } : {} }
}

function isMap(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// ---- a YAML subset ----------------------------------------------------------

class YamlError extends Error {}

function fail(message, line) {
  throw new YamlError(line ? `line ${line}: ${message}` : message)
}

/** Text of a line without its comment (a `#` at the start or after a space, outside quotes). */
function stripComment(text) {
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quote) {
      if (quote === "'" && char === "'" && text[i + 1] === "'") i += 1
      else if (quote === '"' && char === '\\') i += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i)
  }
  return text
}

function tokenize(source) {
  const lines = []
  const raw = String(source).replace(/^﻿/, '').split(/\r?\n/)
  raw.forEach((line, index) => {
    if (/^\t/.test(line)) fail('tab indentation', index + 1)
    const text = stripComment(line).replace(/\s+$/, '')
    if (!text.trim()) return
    if (/^(---|\.\.\.)(\s|$)/.test(text)) return
    if (/^%/.test(text)) return
    const indent = text.length - text.trimStart().length
    lines.push({ indent, text: text.trimStart(), line: index + 1 })
  })
  return lines
}

const KEY_RE = /^((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^']|'')*')|(?:[^\s"'#{}[\],&*!|>%@`][^:#]*?|[^\s"'#{}[\],&*!|>%@`]))\s*:(?:\s+|$)/

/**
 * Parse a YAML document of the subset a DSH profile patch uses.
 * @param {string} source
 */
export function parseYaml(source) {
  const lines = tokenize(source)
  if (lines.length === 0) return null
  const state = { lines, i: 0 }
  const value = parseNode(state, lines[0].indent)
  if (state.i < lines.length) fail('unexpected indentation', lines[state.i].line)
  return value
}

function parseNode(state, indent) {
  const current = state.lines[state.i]
  if (!current || current.indent < indent) return null
  if (current.text === '-' || current.text.startsWith('- ')) return parseSequence(state, current.indent)
  if (KEY_RE.test(current.text)) return parseMapping(state, current.indent)
  state.i += 1
  return parseInline(collectFlow(state, current), current.line)
}

/** A flow collection may continue on later lines: join until brackets close. */
function collectFlow(state, first) {
  let text = first.text
  if (!/^[[{]/.test(text)) return text
  while (!flowClosed(text)) {
    const next = state.lines[state.i]
    if (!next) fail('unclosed flow collection', first.line)
    text += ` ${next.text}`
    state.i += 1
  }
  return text
}

function flowClosed(text) {
  let depth = 0
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quote) {
      if (quote === "'" && char === "'" && text[i + 1] === "'") i += 1
      else if (quote === '"' && char === '\\') i += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth -= 1
  }
  return depth <= 0
}

function parseSequence(state, indent) {
  const out = []
  while (state.i < state.lines.length) {
    const current = state.lines[state.i]
    if (current.indent !== indent || !(current.text === '-' || current.text.startsWith('- '))) break
    const rest = current.text === '-' ? '' : current.text.slice(2).trimStart()
    if (!rest) {
      state.i += 1
      const next = state.lines[state.i]
      out.push(next && next.indent > indent ? parseNode(state, next.indent) : null)
      continue
    }
    // "- key: value" or "- - x": the rest is a node indented past the dash.
    const offset = current.text.length - rest.length
    state.lines[state.i] = { indent: indent + offset, text: rest, line: current.line }
    out.push(parseNode(state, indent + offset))
  }
  return out
}

function parseMapping(state, indent) {
  const out = {}
  while (state.i < state.lines.length) {
    const current = state.lines[state.i]
    if (current.indent !== indent) {
      if (current.indent > indent) fail('unexpected indentation', current.line)
      break
    }
    const match = KEY_RE.exec(current.text)
    if (!match) break
    const key = scalarKey(match[1], current.line)
    const rest = current.text.slice(match[0].length)
    state.i += 1
    let value
    if (rest) {
      value = parseInline(collectFlow(state, { ...current, text: rest }), current.line)
    } else {
      const next = state.lines[state.i]
      if (next && next.indent > indent) value = parseNode(state, next.indent)
      else if (next && next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) value = parseSequence(state, indent)
      else value = null
    }
    out[key] = value
  }
  return out
}

function scalarKey(text, line) {
  const value = parseInline(text, line)
  return typeof value === 'string' ? value : String(value)
}

function parseInline(text, line) {
  const trimmed = text.trim()
  if (/^[&*!]/.test(trimmed)) fail('anchors, aliases and tags are not supported', line)
  if (/^[|>]/.test(trimmed)) fail('block scalars are not supported', line)
  if (/^[[{]/.test(trimmed)) {
    const reader = { text: trimmed, pos: 0, line }
    const value = readFlow(reader)
    skipSpace(reader)
    if (reader.pos < reader.text.length) fail('unexpected text after a flow collection', line)
    return value
  }
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const reader = { text: trimmed, pos: 0, line }
    const value = readQuoted(reader)
    skipSpace(reader)
    if (reader.pos < reader.text.length) fail('unexpected text after a quoted string', line)
    return value
  }
  return plainScalar(trimmed)
}

function plainScalar(text) {
  if (text === '' || text === '~' || /^(null|Null|NULL)$/.test(text)) return null
  if (/^(true|True|TRUE)$/.test(text)) return true
  if (/^(false|False|FALSE)$/.test(text)) return false
  if (/^[-+]?(0|[1-9][0-9]*)$/.test(text)) return Number(text)
  if (/^0x[0-9a-fA-F]+$/.test(text)) return Number.parseInt(text.slice(2), 16)
  if (/^0o[0-7]+$/.test(text)) return Number.parseInt(text.slice(2), 8)
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(text)) return Number(text)
  if (/^[-+]?\.(inf|Inf|INF)$/.test(text)) return text.startsWith('-') ? -Infinity : Infinity
  if (/^\.(nan|NaN|NAN)$/.test(text)) return Number.NaN
  return text
}

function skipSpace(reader) {
  while (reader.pos < reader.text.length && /\s/.test(reader.text[reader.pos])) reader.pos += 1
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', b: '\b', f: '\f', e: '\x1b', ' ': ' ', N: '\u0085', _: ' ' }

function readQuoted(reader) {
  const quote = reader.text[reader.pos]
  reader.pos += 1
  let out = ''
  while (reader.pos < reader.text.length) {
    const char = reader.text[reader.pos]
    if (quote === "'") {
      if (char === "'") {
        if (reader.text[reader.pos + 1] === "'") {
          out += "'"
          reader.pos += 2
          continue
        }
        reader.pos += 1
        return out
      }
      out += char
      reader.pos += 1
      continue
    }
    if (char === '\\') {
      const next = reader.text[reader.pos + 1]
      if (next === 'x' || next === 'u' || next === 'U') {
        const size = next === 'x' ? 2 : next === 'u' ? 4 : 8
        const hex = reader.text.slice(reader.pos + 2, reader.pos + 2 + size)
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== size) fail('bad escape', reader.line)
        out += String.fromCodePoint(Number.parseInt(hex, 16))
        reader.pos += 2 + size
        continue
      }
      if (!(next in ESCAPES)) fail('bad escape', reader.line)
      out += ESCAPES[next]
      reader.pos += 2
      continue
    }
    if (char === '"') {
      reader.pos += 1
      return out
    }
    out += char
    reader.pos += 1
  }
  return fail('unclosed quoted string', reader.line)
}

function readFlow(reader) {
  skipSpace(reader)
  const char = reader.text[reader.pos]
  if (char === '[') {
    reader.pos += 1
    const out = []
    for (;;) {
      skipSpace(reader)
      if (reader.text[reader.pos] === ']') {
        reader.pos += 1
        return out
      }
      out.push(readFlow(reader))
      skipSpace(reader)
      const sep = reader.text[reader.pos]
      if (sep === ',') reader.pos += 1
      else if (sep !== ']') fail('expected , or ] in a flow sequence', reader.line)
    }
  }
  if (char === '{') {
    reader.pos += 1
    const out = {}
    for (;;) {
      skipSpace(reader)
      if (reader.text[reader.pos] === '}') {
        reader.pos += 1
        return out
      }
      const key = readFlowScalar(reader, true)
      skipSpace(reader)
      let value = null
      if (reader.text[reader.pos] === ':') {
        reader.pos += 1
        skipSpace(reader)
        const next = reader.text[reader.pos]
        value = next === ',' || next === '}' ? null : readFlow(reader)
      }
      out[typeof key === 'string' ? key : String(key)] = value
      skipSpace(reader)
      const sep = reader.text[reader.pos]
      if (sep === ',') reader.pos += 1
      else if (sep !== '}') fail('expected , or } in a flow mapping', reader.line)
    }
  }
  return readFlowScalar(reader, false)
}

function readFlowScalar(reader, isKey) {
  skipSpace(reader)
  const char = reader.text[reader.pos]
  if (char === '"' || char === "'") return readQuoted(reader)
  if (char === '[' || char === '{') return readFlow(reader)
  if (/[&*!|>]/.test(char ?? '')) fail('anchors, aliases, tags and block scalars are not supported', reader.line)
  const start = reader.pos
  while (reader.pos < reader.text.length) {
    const c = reader.text[reader.pos]
    if (c === ',' || c === ']' || c === '}') break
    // "key: value" inside a flow mapping; "http://x" stays one scalar.
    if (c === ':' && isKey && /[\s,}\]]/.test(reader.text[reader.pos + 1] ?? ' ')) break
    reader.pos += 1
  }
  return plainScalar(reader.text.slice(start, reader.pos).trim())
}

/**
 * Memory partitions (scopes) and project identification.
 *
 * Three levels: `global` (everywhere), `project` (one repository or folder)
 * and `session` (one DSH session). A memory without a scope (written before
 * partitions existed, migrated from Qdrant, or by a REST backend) counts as
 * global; nothing rewrites old rows.
 *
 * A project id is a hash, in this order of preference, of
 *   1. the normalised git `origin` URL (ssh and https forms of one remote
 *      give one id, credentials and `.git` dropped),
 *   2. the repository root path,
 *   3. the working directory path.
 * Paths are normalised per platform: on Windows the case is folded and
 * backslashes become slashes, so `C:\Repo` and `c:/repo/` are one project;
 * POSIX paths keep their case. Only the hash and a display name (the
 * repository or folder name) are stored, never a path or a remote URL: both
 * carry user and organisation names.
 *
 * The working directory comes from DSH's `workingDirectory` service or the
 * session header (P0 probe §4). Without a session (background work) there is
 * none; the caller then uses the memory's own scope or falls back to global.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'

export const SCOPES = Object.freeze(['global', 'project', 'session'])
export const DEFAULT_PROJECT_BOOST = 1.1
export const GIT_TIMEOUT_MS = 2_000
const MAX_CACHED = 64

/** `global`, `project` or `session` for a memory (missing or unknown: global). */
export function scopeOf(memory) {
  const scope = memory?.scope
  if (scope === 'project' && memory?.project_id) return 'project'
  if (scope === 'session' && memory?.session_id) return 'session'
  return 'global'
}

/** Stable key of a memory's partition: `global`, `project:<id>`, `session:<id>`. */
export function partitionKey(memory) {
  const scope = scopeOf(memory)
  if (scope === 'project') return `project:${memory.project_id}`
  if (scope === 'session') return `session:${memory.session_id}`
  return 'global'
}

/**
 * Normalise a git remote URL to `host/path` (lower case, no scheme, user,
 * port, `.git` or trailing slash). `git@github.com:Owner/Repo.git`,
 * `ssh://git@github.com:22/owner/repo` and
 * `https://user:token@GitHub.com/owner/repo.git/` all give
 * `github.com/owner/repo`. Local paths and `file://` URLs are normalised as
 * paths. Empty when there is nothing usable.
 */
export function normalizeGitRemote(url, { platform = process.platform } = {}) {
  let text = String(url ?? '').trim()
  if (!text) return ''
  if (/^file:\/\//i.test(text)) return `file:${normalizePath(decodeURIComponent(text.replace(/^file:\/\/(localhost)?/i, '')), { platform })}`
  let host = ''
  let rest = ''
  const scheme = text.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i)
  if (scheme) {
    const body = scheme[2]
    const slash = body.indexOf('/')
    const authority = slash < 0 ? body : body.slice(0, slash)
    rest = slash < 0 ? '' : body.slice(slash + 1)
    host = authority.replace(/^[^@]*@/, '').replace(/:\d*$/, '')
  } else {
    // scp-like `[user@]host:path` (not a Windows drive `C:\…`).
    const scp = text.match(/^(?:[^@/\\\s]+@)?([^:/\\\s]+):(?!\\|\/\/)(.*)$/)
    if (scp && !/^[a-z]$/i.test(scp[1])) {
      host = scp[1]
      rest = scp[2]
    } else {
      return `path:${normalizePath(text, { platform })}`
    }
  }
  rest = rest
    .replace(/\\/g, '/')
    .replace(/[?#].*$/, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  host = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return ''
  return rest ? `${host}/${rest.toLowerCase()}` : host
}

/**
 * Normalise a file-system path for hashing. Windows (`platform: 'win32'`):
 * `path.win32` resolution, forward slashes, case folded (NTFS is case
 * insensitive), no trailing slash; `\\?\` prefixes dropped. POSIX: `path.posix`
 * normalisation, case kept, no trailing slash.
 */
export function normalizePath(value, { platform = process.platform } = {}) {
  let text = String(value ?? '').trim()
  if (!text) return ''
  if (platform === 'win32') {
    text = text.replace(/^\\\\\?\\(UNC\\)?/i, (_, unc) => (unc ? '\\\\' : ''))
    let normal = path.win32.normalize(text).replace(/\\/g, '/')
    if (normal.length > 3) normal = normal.replace(/\/+$/, '')
    return normal.toLowerCase()
  }
  let normal = path.posix.normalize(text.replace(/\\/g, '/'))
  if (normal.length > 1) normal = normal.replace(/\/+$/, '')
  return normal
}

function shortHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** Last path segment of a remote or a path, for display. */
function displayName(value, platform) {
  const clean = String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '')
  const parts = clean.split(/[/:]/).filter(Boolean)
  const name = parts.at(-1) ?? ''
  return platform === 'win32' && /^[a-z]$/i.test(name) ? `${name.toUpperCase()}:` : name.slice(0, 80)
}

/**
 * The project of a working directory, from what git reported:
 * `{ projectId, kind: 'git'|'root'|'cwd', name }`, or null without a cwd.
 * `projectId` is `p` + 16 hex digits of the hashed source.
 */
export function projectIdentity({ cwd, root, origin } = {}, { platform = process.platform } = {}) {
  const remote = normalizeGitRemote(origin, { platform })
  if (remote) return { projectId: `p${shortHash(`git:${remote}`)}`, kind: 'git', name: displayName(remote, platform) || displayName(root || cwd, platform) }
  const repo = normalizePath(root, { platform })
  if (repo) return { projectId: `p${shortHash(`root:${repo}`)}`, kind: 'root', name: displayName(root, platform) }
  const dir = normalizePath(cwd, { platform })
  if (dir) return { projectId: `p${shortHash(`cwd:${dir}`)}`, kind: 'cwd', name: displayName(cwd, platform) }
  return null
}

/** `git -C <cwd> <args>`: stdout trimmed, or '' on any failure (no git, not a repo, timeout). */
export function runGit(cwd, args, { timeoutMs = GIT_TIMEOUT_MS, execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    try {
      execFileImpl(
        process.platform === 'win32' ? 'git.exe' : 'git',
        ['-C', cwd, ...args],
        { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } },
        (error, stdout) => resolve(error ? '' : String(stdout ?? '').trim()),
      )
    } catch {
      resolve('')
    }
  })
}

/** The working directory of a DSH session: the live one, then the header's. */
export function sessionWorkingDirectory(session, workingDirectory) {
  if (!session) return ''
  try {
    const live = workingDirectory?.get?.(session)
    if (typeof live === 'string' && live) return live
  } catch {
    // service missing or session gone
  }
  const header = session.header?.cwd
  return typeof header === 'string' ? header : ''
}

/**
 * Resolves (and caches, per working directory) the project of a session.
 * `peek` answers from the cache only, for synchronous callers.
 */
export class ProjectResolver {
  constructor({ git = runGit, platform = process.platform, logger, workingDirectory = () => undefined } = {}) {
    this.git = git
    this.platform = platform
    this.logger = logger
    this.workingDirectory = typeof workingDirectory === 'function' ? workingDirectory : () => workingDirectory
    this.cache = new Map()
    this.pending = new Map()
  }

  cwdOf(session) {
    return sessionWorkingDirectory(session, this.workingDirectory())
  }

  /** Cached project of a working directory, or undefined (null: none). */
  peekCwd(cwd) {
    if (!cwd) return null
    return this.cache.get(normalizePath(cwd, { platform: this.platform }))
  }

  peek(session) {
    return this.peekCwd(this.cwdOf(session))
  }

  async resolveCwd(cwd) {
    if (!cwd) return null
    const key = normalizePath(cwd, { platform: this.platform })
    if (this.cache.has(key)) return this.cache.get(key)
    if (this.pending.has(key)) return this.pending.get(key)
    const task = (async () => {
      const root = await this.git(cwd, ['rev-parse', '--show-toplevel'])
      const origin = root ? await this.git(cwd, ['remote', 'get-url', 'origin']) : ''
      const identity = projectIdentity({ cwd, root, origin }, { platform: this.platform })
      this.cache.set(key, identity)
      if (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value)
      this.logger?.debug?.(`dsh-mem0: project of this session: ${identity ? `${identity.name} (${identity.kind})` : 'none'}`)
      return identity
    })().finally(() => this.pending.delete(key))
    this.pending.set(key, task)
    return task
  }

  resolve(session) {
    return this.resolveCwd(this.cwdOf(session))
  }
}

/**
 * The partitions a recall or a search reads: global, plus the current
 * project and session when known. `all` reads every partition (cross-project
 * search must be asked for).
 */
export function recallPartitions({ projectId, sessionId } = {}) {
  const out = [{ scope: 'global' }]
  if (projectId) out.push({ scope: 'project', project_id: String(projectId) })
  if (sessionId) out.push({ scope: 'session', session_id: String(sessionId) })
  return out
}

/** Whether a memory lies in one of `partitions` (undefined: every one). */
export function inPartitions(memory, partitions) {
  if (!Array.isArray(partitions)) return true
  const scope = scopeOf(memory)
  return partitions.some((partition) => {
    if (partition.scope === 'global') return scope === 'global'
    if (partition.scope === 'project') return scope === 'project' && String(memory.project_id) === String(partition.project_id ?? '')
    if (partition.scope === 'session') return scope === 'session' && String(memory.session_id) === String(partition.session_id ?? '')
    return false
  })
}

/** Recall weight of the partition: the current project and session × boost, global × 1. */
export function partitionWeight(memory, boost = DEFAULT_PROJECT_BOOST) {
  const value = Number(boost)
  if (!(value > 0)) return 1
  return scopeOf(memory) === 'global' ? 1 : value
}

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
 *   2. the repository's common git directory (`--git-common-dir`: every
 *      worktree of one repository shares it),
 *   3. the working directory's real path.
 * The other ids of the same folder (its repository and folder hashes) are
 * recorded as aliases of a git project, so memories written before an
 * `origin` was added, or while git failed, are still read with it.
 * A session's project follows its current working directory (DSH's
 * `workingDirectory` service: the model's `working_directory` tool and
 * DSH's worktree entry change it during a session), so the composer chip,
 * recall and new memories all move with it from the next lookup. The home
 * directory outside git is no project (its name is the user's name).
 * Paths are normalised per platform: on Windows the case is folded and
 * backslashes become slashes, so `C:\Repo` and `c:/repo/` are one project;
 * POSIX paths keep their case. Only the hash and a display name (the
 * repository or folder name) are stored, never a path or a remote URL: both
 * carry user and organisation names.
 *
 * DSH's default workspace (desktop: `<Documents>/deepseek-harness/
 * default-workspace`, created on first use) is no project either: a chat
 * started there is not "in a project", so its memories go to global. It is
 * recognised by DSH's own records, never by the folder name alone: the
 * workspace registry's default workspace, or a workspace still carrying the
 * automatic first-use title `default-workspace` (DSH's own rule,
 * `workspaceDisplayTitle`).
 *
 * The working directory comes from DSH's `workingDirectory` service, else
 * the session header (its starting directory). Without a session (background
 * work) there is none; the caller then uses the memory's own scope or falls
 * back to global.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SCOPES = Object.freeze(['global', 'project', 'session'])
export const DEFAULT_PROJECT_BOOST = 1.1
export const GIT_TIMEOUT_MS = 2_000
const MAX_CACHED = 64
const MAX_SESSIONS = 500
/** A lookup that failed for a passing reason (git timed out) is retried after this long. */
export const TRANSIENT_CACHE_MS = 60_000
/** Leaf folder and automatic title of DSH's first-use workspace (dsh-api-workspace-controller). */
export const DSH_DEFAULT_WORKSPACE_DIRECTORY = 'default-workspace'
/** Variables that would point every `git -C` at one repository. */
const GIT_ENV_DROP = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM']

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
    // Credentials end at the last `@` (a password may hold an unescaped one).
    host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '')
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
export function projectIdentity({ cwd, root, commonDir, origin } = {}, { platform = process.platform } = {}) {
  const repo = normalizePath(commonDir || root, { platform })
  const dir = normalizePath(cwd, { platform })
  const rootId = repo ? `p${shortHash(`root:${repo}`)}` : null
  const cwdId = dir ? `p${shortHash(`cwd:${dir}`)}` : null
  const repoName = displayName(repoFolder(commonDir) || root, platform)
  const remote = normalizeGitRemote(origin, { platform })
  if (remote) {
    const aliases = [rootId, cwdId].filter(Boolean)
    return { projectId: `p${shortHash(`git:${remote}`)}`, kind: 'git', name: displayName(remote, platform) || repoName || displayName(cwd, platform), aliases }
  }
  if (rootId) return { projectId: rootId, kind: 'root', name: repoName || displayName(cwd, platform), aliases: cwdId && cwdId !== rootId ? [cwdId] : [] }
  if (cwdId) return { projectId: cwdId, kind: 'cwd', name: displayName(cwd, platform), aliases: [] }
  return null
}

/** The repository folder of a common git directory (`…/repo/.git` → `…/repo`). */
function repoFolder(commonDir) {
  const text = String(commonDir ?? '').replace(/[\\/]+$/, '')
  return /[\\/]\.git$/i.test(text) ? text.replace(/[\\/]\.git$/i, '') : text
}

/** The environment for git: no prompts, no locks, no inherited repository. */
function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  for (const name of GIT_ENV_DROP) delete env[name]
  return env
}

/**
 * `git -C <cwd> <args>`: `{ stdout, error }`. `error` is null, `'timeout'`
 * (killed after `timeoutMs`, or aborted: a passing failure), `'missing'` (no
 * git) or `'failed'` (not a repository, no origin, …).
 */
export function gitQuery(cwd, args, { timeoutMs = GIT_TIMEOUT_MS, signal, execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    try {
      execFileImpl(
        process.platform === 'win32' ? 'git.exe' : 'git',
        ['-C', cwd, ...args],
        { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', env: gitEnv(), ...(signal ? { signal } : {}) },
        (error, stdout) => {
          if (!error) return resolve({ stdout: String(stdout ?? '').trim(), error: null })
          const kind = error.killed || error.code === 'ETIMEDOUT' || error.name === 'AbortError' || error.code === 'ABORT_ERR' ? 'timeout' : error.code === 'ENOENT' ? 'missing' : 'failed'
          resolve({ stdout: '', error: kind })
        },
      )
    } catch {
      resolve({ stdout: '', error: 'failed' })
    }
  })
}

/** `git -C <cwd> <args>`: stdout trimmed, or '' on any failure (no git, not a repo, timeout). */
export async function runGit(cwd, args, options = {}) {
  return (await gitQuery(cwd, args, options)).stdout
}

/** The real path of a folder (8.3 short names and symlinks expanded), or the path itself. */
export async function realPath(value) {
  try {
    return await fs.promises.realpath(value)
  } catch {
    return value
  }
}

/**
 * The current directory of a DSH session: the `workingDirectory` service's
 * (a `cd` during the session moves it), else the session header's cwd (its
 * starting directory). The service answers its own `defaultDirectory` (DSH's
 * launch folder) for a session it holds no record of: with a header cwd of
 * its own, that answer is the service not knowing this session object, and
 * the header wins.
 */
export function sessionWorkingDirectory(session, workingDirectory) {
  if (!session) return ''
  const header = typeof session.header?.cwd === 'string' && session.header.cwd ? session.header.cwd : ''
  try {
    const live = workingDirectory?.get?.(session)
    if (typeof live === 'string' && live) {
      const fallback = typeof workingDirectory?.defaultDirectory === 'string' ? workingDirectory.defaultDirectory : ''
      if (!(header && fallback && live === fallback && live !== header)) return live
    }
  } catch {
    // service missing or session gone
  }
  return header
}

function sessionKey(session) {
  const id = session?.id
  return id === undefined || id === null || id === '' ? '' : String(id)
}

/**
 * The paths of DSH's default workspace, from its workspace registry
 * (`ctx.workspaceRegistry`): the workspace the registry created on first use
 * (its `defaultWorkspaceId`), and any workspace still titled
 * `default-workspace` (DSH labels exactly those as the default workspace).
 * Empty without a registry. Never throws.
 */
export function dshDefaultWorkspaces(registry) {
  if (!registry) return []
  let list = []
  try {
    list = typeof registry.list === 'function' ? registry.list() : []
  } catch {
    return []
  }
  let defaultId
  try {
    // The registry's own record of the first-use workspace (not a public
    // getter in DSH 0.2.2; read defensively).
    defaultId = registry.state?.defaultWorkspaceId
  } catch {
    defaultId = undefined
  }
  const out = []
  for (const workspace of Array.isArray(list) ? list : []) {
    try {
      const isDefault = (defaultId !== undefined && String(workspace?.id) === String(defaultId)) || workspace?.title === DSH_DEFAULT_WORKSPACE_DIRECTORY
      if (isDefault && typeof workspace.path === 'string' && workspace.path) out.push(workspace.path)
    } catch {
      // a workspace that went away while listing
    }
  }
  return out
}

/**
 * Whether a recorded project is the default workspace of an earlier version
 * (a folder project named like DSH's first-use folder, or one of `ids`).
 */
export function isDshDefaultProject(projectId, info, ids = []) {
  if (ids.includes(String(projectId))) return true
  return info?.kind === 'cwd' && String(info?.name ?? '').toLowerCase() === DSH_DEFAULT_WORKSPACE_DIRECTORY
}

/** One session-to-project map per process: it outlives a plugin restart (a settings change). */
export const SESSION_PROJECTS = new Map()

/**
 * Resolves (and caches, per working directory) the project of a session.
 * A session follows its current directory. `peek` answers from the
 * caches only, for synchronous callers.
 *
 * `known()` lists the recorded projects (`{ [id]: { name, kind, aliases } }`)
 * and `record(identity)` records one; both are optional (the local store).
 * A lookup that only found a repository or folder id that a recorded git
 * project lists as an alias answers with that git project.
 */
export class ProjectResolver {
  constructor({ git = gitQuery, platform = process.platform, logger, workingDirectory = () => undefined, known, record, homeDir = os.homedir(), now = () => Date.now(), defaultWorkspaces = () => [], sessions = new Map() } = {}) {
    this.git = git
    this.platform = platform
    this.logger = logger
    this.workingDirectory = typeof workingDirectory === 'function' ? workingDirectory : () => workingDirectory
    this.known = typeof known === 'function' ? known : null
    this.record = typeof record === 'function' ? record : null
    this.homeDir = homeDir
    this.now = now
    this.cache = new Map()
    this.pending = new Map()
    this.sessions = sessions
    this.defaultWorkspaces = typeof defaultWorkspaces === 'function' ? defaultWorkspaces : () => defaultWorkspaces
  }

  /** DSH's default workspace folders, real paths (lib comment above). Never throws. */
  async #defaultWorkspacePaths() {
    let paths = []
    try {
      paths = (await this.defaultWorkspaces()) ?? []
    } catch {
      return []
    }
    const out = []
    for (const value of Array.isArray(paths) ? paths : []) if (typeof value === 'string' && value) out.push(this.#key(await realPath(value)))
    return out
  }

  /** The project ids the default workspace folders had as folder projects (before this rule). */
  async defaultWorkspaceIds() {
    const ids = []
    for (const key of await this.#defaultWorkspacePaths()) ids.push(`p${shortHash(`cwd:${key}`)}`)
    return ids
  }

  cwdOf(session) {
    return sessionWorkingDirectory(session, this.workingDirectory())
  }

  #key(cwd) {
    return normalizePath(cwd, { platform: this.platform })
  }

  #hit(key) {
    const hit = this.cache.get(key)
    if (!hit) return undefined
    if (hit.expires && hit.expires <= this.now()) {
      this.cache.delete(key)
      return undefined
    }
    return hit
  }

  #cached(key) {
    return this.#hit(key)?.identity
  }

  /**
   * How the current directory's project was decided (lib comment on
   * #details), once that directory was looked up; undefined before.
   */
  describeCwd(cwd) {
    if (!cwd) return { basis: 'none' }
    return this.#hit(this.#key(cwd))?.details
  }

  /** Cached project of a working directory, or undefined (null: none). */
  peekCwd(cwd) {
    if (!cwd) return null
    return this.#cached(this.#key(cwd))
  }

  /** The session's entry for its current directory, or undefined. */
  #sessionHit(id, key) {
    const entry = id ? this.sessions.get(id) : undefined
    return entry && typeof entry === 'object' && 'key' in entry && entry.key === key ? entry : undefined
  }

  /** The project a session has in its current directory (undefined: not looked up yet). */
  peek(session) {
    const cwd = this.cwdOf(session)
    const hit = this.#sessionHit(sessionKey(session), cwd ? this.#key(cwd) : '')
    if (hit) return hit.project
    return this.peekCwd(cwd)
  }

  /**
   * The project of a session's latest lookup, by id alone (undefined: none),
   * for callers without the session object. It is the directory the
   * session had then; a session object gives the current one (resolve).
   */
  sessionProject(sessionId) {
    const id = sessionId === undefined || sessionId === null ? '' : String(sessionId)
    const entry = id ? this.sessions.get(id) : undefined
    return entry && typeof entry === 'object' && 'key' in entry ? entry.project : undefined
  }

  /** How the project of sessionProject() was decided (describeCwd), or undefined. */
  sessionDetails(sessionId) {
    const id = sessionId === undefined || sessionId === null ? '' : String(sessionId)
    const entry = id ? this.sessions.get(id) : undefined
    return entry && typeof entry === 'object' && 'key' in entry ? entry.details : undefined
  }

  /** `git` answers `{ stdout, error }` (gitQuery) or a plain string (tests). */
  async #git(cwd, args, signal) {
    const answer = await this.git(cwd, args, { signal })
    return typeof answer === 'string' ? { stdout: answer.trim(), error: answer.trim() ? null : 'failed' } : { stdout: String(answer?.stdout ?? '').trim(), error: answer?.error ?? null }
  }

  async #lookup(cwd, signal) {
    const dir = await realPath(cwd)
    // DSH's default workspace: no project, whatever git says.
    if ((await this.#defaultWorkspacePaths()).includes(this.#key(dir))) return { identity: null, transient: false, defaultWorkspace: true, details: { basis: 'default-workspace', cwd: dir } }
    // Both questions at once: one 2-second bound for the first prompt.
    const [revParse, remote] = await Promise.all([
      this.#git(dir, ['rev-parse', '--show-toplevel', '--git-common-dir'], signal),
      this.#git(dir, ['config', '--get', 'remote.origin.url'], signal),
    ])
    const transient = revParse.error === 'timeout' || remote.error === 'timeout'
    const [top = '', common = ''] = revParse.error ? [] : revParse.stdout.split(/\r?\n/)
    const root = top ? await realPath(top) : ''
    const commonDir = common ? await realPath(path.isAbsolute(common) ? common : path.resolve(dir, common)) : ''
    const origin = root ? remote.stdout : ''
    let identity = null
    if (root || !this.#isHome(dir)) identity = projectIdentity({ cwd: dir, root, commonDir, origin }, { platform: this.platform })
    return { identity, transient, details: this.#details({ dir, root, commonDir, identity, revParse }) }
  }

  /**
   * How a directory's project was decided, for the composer chip's hover
   * panel (kept in memory, never stored): `basis` git-origin, git-root,
   * folder, home or none; `cwd` the real directory; `path` the folder the
   * id stands for (the repository's root, the main checkout for a linked
   * worktree); `worktree` true for a linked worktree, `gitError` when git
   * could not answer.
   */
  #details({ dir, root, commonDir, identity, revParse }) {
    const out = { cwd: dir }
    if (!identity) return { ...out, basis: this.#isHome(dir) ? 'home' : 'none' }
    if (identity.kind === 'cwd') {
      out.basis = 'folder'
      out.path = dir
      if (revParse?.error === 'timeout' || revParse?.error === 'missing') out.gitError = revParse.error
      return out
    }
    out.basis = identity.kind === 'git' ? 'git-origin' : 'git-root'
    const main = repoFolder(commonDir)
    // A linked worktree: its common directory is not its own `.git`.
    const worktree = Boolean(commonDir && root && /[\\/]\.git$/i.test(String(commonDir).replace(/[\\/]+$/, '')) && this.#key(main) !== this.#key(root))
    out.path = worktree ? main : root
    if (worktree) {
      out.worktree = true
      out.checkout = root
    }
    return out
  }

  #isHome(dir) {
    if (!this.homeDir) return false
    return this.#key(dir) === this.#key(this.homeDir)
  }

  /** A repository or folder id that a recorded git project lists as an alias: that project. */
  async #canonical(identity) {
    if (!identity || identity.kind === 'git' || !this.known) return identity
    let known = {}
    try {
      known = (await this.known()) ?? {}
    } catch {
      return identity
    }
    for (const [projectId, info] of Object.entries(known)) {
      if (info?.kind !== 'git' || !Array.isArray(info.aliases) || !info.aliases.includes(identity.projectId)) continue
      const aliases = [...new Set([...info.aliases, ...identity.aliases, identity.projectId])].filter((id) => id !== projectId)
      return { projectId, kind: 'git', name: String(info.name || identity.name), aliases, via: identity.kind }
    }
    return identity
  }

  async resolveCwd(cwd, { signal } = {}) {
    if (!cwd) return null
    const key = this.#key(cwd)
    const hit = this.#cached(key)
    if (hit !== undefined) return hit
    let task = this.pending.get(key)
    if (!task) {
      task = (async () => {
        const { identity: found, transient, defaultWorkspace, details } = await this.#lookup(cwd)
        const identity = await this.#canonical(found)
        // git timed out: keep the answer a minute only, then ask again.
        this.cache.set(key, { identity, details, expires: transient ? this.now() + TRANSIENT_CACHE_MS : 0 })
        if (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value)
        if (identity && this.record) {
          try {
            this.record(identity)
          } catch {
            // recording the name is best effort
          }
        }
        this.logger?.debug?.(`dsh-mem0: project of this session: ${identity ? `${identity.name} (${identity.kind})` : defaultWorkspace ? 'none (DSH default workspace)' : 'none'}${transient ? ' (git timed out)' : ''}`)
        return identity
      })().finally(() => this.pending.delete(key))
      this.pending.set(key, task)
    }
    // A caller that gives up (its turn was cancelled) gets null; the lookup
    // goes on for the others.
    if (!signal) return task
    if (signal.aborted) return null
    return new Promise((resolve) => {
      const onAbort = () => resolve(null)
      signal.addEventListener('abort', onAbort, { once: true })
      task.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        () => resolve(null),
      )
    })
  }

  /**
   * The session's project in its current directory. The answer is kept per
   * session and directory: a `cd` makes the next call look the new
   * directory up (cached per directory as well).
   */
  async resolve(session, { signal } = {}) {
    const id = sessionKey(session)
    const cwd = this.cwdOf(session)
    const key = cwd ? this.#key(cwd) : ''
    const hit = this.#sessionHit(id, key)
    if (hit) return hit.project
    const project = await this.resolveCwd(cwd, { signal })
    if (id && !signal?.aborted) {
      // Re-insert so the map's oldest entry is the least recently moved.
      this.sessions.delete(id)
      this.sessions.set(id, { key, project, details: this.describeCwd(cwd) })
      if (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value)
    }
    return project
  }

  /** How the session's project was decided (describeCwd), with its current directory. */
  describe(session) {
    const cwd = this.cwdOf(session)
    const found = this.describeCwd(cwd)
    if (found !== undefined) return found
    // Answered from the per-process session map (after a plugin restart):
    // the details it kept for this directory.
    return this.#sessionHit(sessionKey(session), cwd ? this.#key(cwd) : '')?.details
  }
}

/**
 * The partitions a recall or a search reads: global, plus the current
 * project and session when known. `all` reads every partition (cross-project
 * search must be asked for).
 */
export function recallPartitions({ projectId, aliases, sessionId } = {}) {
  const out = [{ scope: 'global' }]
  if (projectId) out.push({ scope: 'project', project_id: String(projectId) })
  // Earlier ids of the same project (its folder before an origin was added).
  if (projectId && Array.isArray(aliases)) for (const alias of aliases) if (alias && alias !== projectId) out.push({ scope: 'project', project_id: String(alias) })
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

/** A path for display: the home folder as `~` (the path is still the user's: shown, never stored). */
export function displayPath(value, { homeDir = os.homedir(), platform = process.platform } = {}) {
  const text = String(value ?? '')
  if (!text || !homeDir) return text
  const sep = platform === 'win32' ? /[\\/]/ : /\//
  const fold = (part) => (platform === 'win32' ? part.toLowerCase().replace(/\\/g, '/') : part)
  const home = fold(String(homeDir).replace(/[\\/]+$/, ''))
  const folded = fold(text)
  if (folded === home) return '~'
  if (folded.startsWith(`${home}/`) && sep.test(text.charAt(home.length))) return `~${text.slice(home.length).replace(/\\/g, '/')}`
  return text
}

/**
 * The composer chip's hover details (ProjectResolver#details plus the
 * project's partition), or undefined before the directory was looked up.
 * Paths shown with `~`; meant for the local page, never stored.
 */
export function chipDetail(details, project, options = {}) {
  if (!details || typeof details !== 'object') return undefined
  const out = { basis: String(details.basis ?? 'none') }
  if (details.cwd) out.cwd = displayPath(details.cwd, options)
  if (details.path) out.path = displayPath(details.path, options)
  if (details.worktree) out.worktree = true
  if (details.checkout) out.checkout = displayPath(details.checkout, options)
  if (details.gitError) out.gitError = String(details.gitError)
  if (project?.via) out.via = String(project.via)
  out.partition = project?.projectId ? `project:${project.projectId}` : 'global'
  return out
}

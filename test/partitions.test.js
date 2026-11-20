// v2 P3: partitions (global / project / session), project identification
// on Windows and POSIX paths, partitioned recall with the project boost,
// partitioned capture, tools, the store's partition columns, partition
// summaries (L0) written by a mock model, and the memory page routes.
// Test user ids, temporary files and mock services only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DSH_DEFAULT_WORKSPACE_DIRECTORY,
  ProjectResolver,
  SESSION_PROJECTS,
  dshDefaultWorkspaces,
  gitQuery,
  isDshDefaultProject,
  inPartitions,
  normalizeGitRemote,
  normalizePath,
  partitionKey,
  partitionWeight,
  projectIdentity,
  recallPartitions,
  runGit,
  scopeOf,
  sessionWorkingDirectory,
} from '../lib/project-scope.js'
import { SqliteStore } from '../lib/store-sqlite.js'
import { MemoryLifecycle, PROFILE_SECTION_NAME } from '../lib/memory-lifecycle.js'
import { MemoryMaintenance } from '../lib/memory-maintenance.js'
import { MaintenanceState } from '../lib/maintenance-state.js'
import { createMem0Tools, searchPartitions } from '../lib/tools.js'
import { cleanSummary, sameSources, summaryInput, SUMMARY_SYSTEM_PROMPT } from '../lib/scope-summary.js'
import { GUI_MEMORIES_PATH, partitionsFromKey, registerGuiRoutes } from '../lib/gui-routes.js'

const USER = 'dsh-mem0-p3-test-user'
const quiet = { warn() {}, debug() {}, info() {} }

function tempDir(t, prefix = 'dsh-mem0-p3-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A store in a temporary folder, closed before the folder is removed (Windows cannot remove an open file). */
function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-p3-'))
  const store = new SqliteStore({ filePath: path.join(dir, 'memory.sqlite') })
  t.after(() => {
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return store
}

// ------------------------------------------------------------- remotes and paths

test('git remotes: ssh, scp-like and https forms of one repository normalise alike', () => {
  const forms = [
    'git@github.com:Light-Cheng/DSH-Mem0.git',
    'ssh://git@github.com/light-cheng/dsh-mem0.git',
    'ssh://git@github.com:22/light-cheng/dsh-mem0',
    'https://github.com/light-cheng/dsh-mem0',
    'https://user:secret-token@GitHub.com/light-cheng/dsh-mem0.git/',
    'http://github.com/light-cheng/dsh-mem0.git',
    'git://github.com/light-cheng/dsh-mem0.git',
  ]
  for (const form of forms) assert.equal(normalizeGitRemote(form), 'github.com/light-cheng/dsh-mem0', form)
  assert.notEqual(normalizeGitRemote('git@gitlab.com:light-cheng/dsh-mem0.git'), normalizeGitRemote(forms[0]))
  assert.equal(normalizeGitRemote(''), '')
  assert.equal(normalizeGitRemote('   '), '')
  // No credential survives normalisation.
  assert.equal(normalizeGitRemote(forms[4]).includes('secret'), false)
  // A password with an unescaped `@`: the host starts after the last one.
  assert.equal(normalizeGitRemote('https://user:p@ss@github.com/light-cheng/dsh-mem0.git'), 'github.com/light-cheng/dsh-mem0')
})

test('git remotes that are local paths normalise as paths, per platform', () => {
  assert.equal(normalizeGitRemote('C:\\Repos\\Origin.git', { platform: 'win32' }), 'path:c:/repos/origin.git')
  assert.equal(normalizeGitRemote('c:/repos/origin.git/', { platform: 'win32' }), 'path:c:/repos/origin.git')
  assert.equal(normalizeGitRemote('/srv/git/Origin.git', { platform: 'linux' }), 'path:/srv/git/Origin.git')
  assert.equal(normalizeGitRemote('file:///srv/git/origin.git', { platform: 'linux' }), 'file:/srv/git/origin.git')
})

test('paths: win32 folds case and slashes, posix keeps case (path.win32 and path.posix assertions)', () => {
  // Windows: drive letter case, backslashes, trailing separators, \\?\ prefix.
  assert.equal(normalizePath('C:\\Users\\Dev\\Repo\\', { platform: 'win32' }), 'c:/users/dev/repo')
  assert.equal(normalizePath('c:/users/dev/repo', { platform: 'win32' }), 'c:/users/dev/repo')
  assert.equal(normalizePath('C:\\Users\\Dev\\Repo\\..\\Repo', { platform: 'win32' }), 'c:/users/dev/repo')
  assert.equal(normalizePath('\\\\?\\C:\\Users\\Dev\\Repo', { platform: 'win32' }), 'c:/users/dev/repo')
  assert.equal(normalizePath('\\\\server\\share\\Repo\\', { platform: 'win32' }), '//server/share/repo')
  assert.equal(normalizePath('C:\\', { platform: 'win32' }), 'c:/')
  assert.equal(path.win32.normalize('C:\\Users\\Dev\\Repo\\').replace(/\\/g, '/').toLowerCase().replace(/\/$/, ''), normalizePath('C:\\Users\\Dev\\Repo\\', { platform: 'win32' }))
  // POSIX: case kept, trailing slash and dot segments removed.
  assert.equal(normalizePath('/Users/Dev/Repo/', { platform: 'darwin' }), '/Users/Dev/Repo')
  assert.equal(normalizePath('/home/dev/repo/./sub/..', { platform: 'linux' }), '/home/dev/repo')
  assert.notEqual(normalizePath('/home/Dev/repo', { platform: 'linux' }), normalizePath('/home/dev/repo', { platform: 'linux' }))
  assert.equal(normalizePath('/', { platform: 'linux' }), '/')
  assert.equal(path.posix.normalize('/home/dev/repo/'), `${normalizePath('/home/dev/repo/', { platform: 'linux' })}/`)
})

test('project id: origin first, then the repository root, then the working directory', () => {
  const viaSsh = projectIdentity({ cwd: '/home/dev/a/src', root: '/home/dev/a', origin: 'git@github.com:Org/Tool.git' }, { platform: 'linux' })
  const viaHttps = projectIdentity({ cwd: 'D:\\work\\tool', root: 'D:\\work\\tool', origin: 'https://github.com/org/tool' }, { platform: 'win32' })
  assert.equal(viaSsh.kind, 'git')
  assert.equal(viaSsh.name, 'tool')
  assert.match(viaSsh.projectId, /^p[0-9a-f]{16}$/)
  // One remote cloned in two places, on two systems, is one project.
  assert.equal(viaSsh.projectId, viaHttps.projectId)

  const root = projectIdentity({ cwd: '/home/dev/b/src', root: '/home/dev/b', origin: '' }, { platform: 'linux' })
  assert.equal(root.kind, 'root')
  assert.equal(root.name, 'b')
  assert.equal(projectIdentity({ cwd: '/home/dev/b', root: '/home/dev/b/' }, { platform: 'linux' }).projectId, root.projectId)

  const cwd = projectIdentity({ cwd: '/home/dev/notes' }, { platform: 'linux' })
  assert.equal(cwd.kind, 'cwd')
  assert.equal(cwd.name, 'notes')
  assert.notEqual(cwd.projectId, root.projectId)

  // Windows: case and separators do not split a folder into two projects.
  const win1 = projectIdentity({ cwd: 'C:\\Users\\Dev\\Notes\\' }, { platform: 'win32' })
  const win2 = projectIdentity({ cwd: 'c:/users/dev/notes' }, { platform: 'win32' })
  assert.equal(win1.projectId, win2.projectId)
  assert.equal(win1.name, 'Notes')
  // POSIX: case does.
  assert.notEqual(projectIdentity({ cwd: '/Users/Dev/Notes' }, { platform: 'darwin' }).projectId, projectIdentity({ cwd: '/Users/dev/notes' }, { platform: 'darwin' }).projectId)
  // A root and a cwd with the same path are different sources (no collision).
  assert.notEqual(projectIdentity({ root: '/x' }, { platform: 'linux' }).projectId, projectIdentity({ cwd: '/x' }, { platform: 'linux' }).projectId)
  assert.equal(projectIdentity({}, { platform: 'linux' }), null)
  // Neither the path nor the remote is kept.
  assert.equal(JSON.stringify(viaSsh).includes('github'), false)
  assert.equal(JSON.stringify(root).includes('/home'), false)
})

test('the working directory is the session header\'s (its start), then the workingDirectory service', () => {
  const session = { id: 's1', header: { cwd: '/start' } }
  // A `cd` during the session moves the live directory, not the project.
  assert.equal(sessionWorkingDirectory(session, { get: () => '/moved' }), '/start')
  assert.equal(sessionWorkingDirectory(session, undefined), '/start')
  assert.equal(sessionWorkingDirectory({ id: 's2' }, { get: () => '/live' }), '/live')
  assert.equal(sessionWorkingDirectory({ id: 's3' }, { get: () => { throw new Error('gone') } }), '')
  assert.equal(sessionWorkingDirectory({ id: 's2' }, undefined), '')
  assert.equal(sessionWorkingDirectory(null, { get: () => '/x' }), '')
})

test('ProjectResolver: origin, no origin, not a repository, cached per directory, git missing', async () => {
  const calls = []
  const answers = {
    '/repo-a': { toplevel: '/repo-a', origin: 'git@github.com:org/a.git' },
    '/repo-b': { toplevel: '/repo-b', origin: '' },
  }
  const git = async (cwd, args) => {
    calls.push([cwd, args[0]])
    const entry = answers[cwd]
    if (!entry) return ''
    return args[0] === 'rev-parse' ? entry.toplevel : entry.origin
  }
  const resolver = new ProjectResolver({ git, platform: 'linux' })
  const a = await resolver.resolveCwd('/repo-a')
  assert.equal(a.kind, 'git')
  assert.equal(a.name, 'a')
  assert.equal((await resolver.resolveCwd('/repo-b')).kind, 'root')
  assert.equal((await resolver.resolveCwd('/plain')).kind, 'cwd')
  const before = calls.length
  assert.equal((await resolver.resolveCwd('/repo-a/')).projectId, a.projectId, 'cached by normalised directory')
  assert.equal(calls.length, before)
  assert.equal(resolver.peekCwd('/repo-a').projectId, a.projectId)
  assert.equal(resolver.peekCwd('/never-seen'), undefined)
  assert.equal(await resolver.resolveCwd(''), null)

  // No git at all: every lookup answers '', the folder still is a project.
  const noGit = new ProjectResolver({ git: async () => '', platform: 'win32' })
  const folder = await noGit.resolveCwd('C:\\Work\\Thing')
  assert.equal(folder.kind, 'cwd')
  assert.equal(folder.projectId, (await noGit.resolveCwd('c:/work/thing')).projectId)

  // Sessions: the header's directory first, the service without one; a
  // session keeps its first project when its directory changes.
  let live = '/repo-b'
  const sessions = new ProjectResolver({ git, platform: 'linux', workingDirectory: () => ({ get: () => live }) })
  assert.equal((await sessions.resolve({ id: 's', header: { cwd: '/repo-a' } })).projectId, a.projectId)
  const roaming = { id: 'r' }
  const first = await sessions.resolve(roaming)
  assert.equal(first.kind, 'root')
  live = '/repo-a'
  assert.equal((await sessions.resolve(roaming)).projectId, first.projectId, 'a cd does not move the session')
  assert.equal(sessions.peek(roaming).projectId, first.projectId)
  assert.equal(sessions.sessionProject('r').projectId, first.projectId)
  assert.equal(sessions.sessionProject('unknown'), undefined)
  assert.equal(await sessions.resolve(null), null)
})

test('ProjectResolver: git timeouts are retried, worktrees share a project, aliases, the home folder, aborts', async () => {
  let now = 1_000
  let slow = true
  const timeoutGit = async (cwd, args) => {
    if (slow) return { stdout: '', error: 'timeout' }
    return args[0] === 'rev-parse' ? { stdout: `${cwd}\n${cwd}/.git`, error: null } : { stdout: 'git@github.com:org/late.git', error: null }
  }
  const resolver = new ProjectResolver({ git: timeoutGit, platform: 'linux', now: () => now, homeDir: '/home/me' })
  const during = await resolver.resolveCwd('/work/late')
  assert.equal(during.kind, 'cwd', 'git timed out: the folder for now')
  slow = false
  assert.equal((await resolver.resolveCwd('/work/late')).kind, 'cwd', 'cached for a while')
  now += 61_000
  const after = await resolver.resolveCwd('/work/late')
  assert.equal(after.kind, 'git', 'asked again after a minute')
  assert.ok(after.aliases.includes(during.projectId), 'the folder id is an alias of the git project')

  // Worktrees of one repository without origin: one common git directory.
  const worktreeGit = async (cwd, args) => {
    if (args[0] !== 'rev-parse') return { stdout: '', error: 'failed' }
    return { stdout: `${cwd}\n/src/main-repo/.git`, error: null }
  }
  const trees = new ProjectResolver({ git: worktreeGit, platform: 'linux' })
  const one = await trees.resolveCwd('/src/main-repo')
  const two = await trees.resolveCwd('/src/worktrees/feature-x')
  assert.equal(one.kind, 'root')
  assert.equal(one.projectId, two.projectId)
  assert.equal(two.name, 'main-repo')

  // A recorded git project claims its repository and folder ids: a lookup
  // where git fails later answers with the git project.
  const recorded = {}
  const known = async () => recorded
  const record = (identity) => {
    recorded[identity.projectId] = { name: identity.name, kind: identity.kind, aliases: identity.aliases }
  }
  let failing = false
  const flaky = async (cwd, args) => {
    if (failing) return { stdout: '', error: 'failed' }
    return args[0] === 'rev-parse' ? { stdout: `${cwd}\n${cwd}/.git`, error: null } : { stdout: 'https://github.com/org/flaky', error: null }
  }
  const withStore = new ProjectResolver({ git: flaky, platform: 'linux', known, record })
  const gitProject = await withStore.resolveCwd('/src/flaky')
  assert.equal(gitProject.kind, 'git')
  assert.ok(recorded[gitProject.projectId].aliases.length >= 1)
  failing = true
  const again = new ProjectResolver({ git: flaky, platform: 'linux', known, record })
  const resolved = await again.resolveCwd('/src/flaky')
  assert.equal(resolved.projectId, gitProject.projectId, 'the folder id maps to the git project')
  assert.equal(resolved.kind, 'git')

  // The home folder outside git is no project (its name is the user's).
  const home = new ProjectResolver({ git: async () => '', platform: 'linux', homeDir: '/home/me' })
  assert.equal(await home.resolveCwd('/home/me'), null)
  assert.equal((await home.resolveCwd('/home/me/notes')).kind, 'cwd')

  // A cancelled turn stops waiting; the lookup itself goes on.
  let release
  const blocked = new ProjectResolver({ git: () => new Promise((resolve) => { release = resolve }), platform: 'linux' })
  const controller = new AbortController()
  const waiting = blocked.resolveCwd('/slow', { signal: controller.signal })
  controller.abort()
  assert.equal(await waiting, null)
  while (!release) await new Promise((resolve) => setImmediate(resolve))
  release({ stdout: '', error: 'failed' })
})

test('gitQuery: drops inherited repository variables, tells timeouts from failures', async () => {
  const saved = process.env.GIT_DIR
  process.env.GIT_DIR = '/somewhere/.git'
  try {
    let seen
    await gitQuery('/x', ['status'], { execFileImpl: (_file, _args, options, callback) => { seen = options.env; callback(null, 'ok\n') } })
    assert.equal(seen.GIT_DIR, undefined)
    assert.equal(seen.GIT_TERMINAL_PROMPT, '0')
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = saved
  }
  const killed = await gitQuery('/x', ['status'], { execFileImpl: (_f, _a, _o, callback) => callback(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' })) })
  assert.equal(killed.error, 'timeout')
  const missing = await gitQuery('/x', ['status'], { execFileImpl: (_f, _a, _o, callback) => callback(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })) })
  assert.equal(missing.error, 'missing')
  const failed = await gitQuery('/x', ['status'], { execFileImpl: (_f, _a, _o, callback) => callback(Object.assign(new Error('not a repo'), { code: 128 })) })
  assert.equal(failed.error, 'failed')
})

test('runGit: a missing binary or a failing command answers empty; a real repository answers', async (t) => {
  assert.equal(await runGit('/nowhere', ['status'], { execFileImpl: (_file, _args, _options, callback) => callback(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })) }), '')
  assert.equal(await runGit('/nowhere', ['status'], { execFileImpl: () => { throw new Error('boom') } }), '')
  // The real git of this machine (CI runners have one): a temporary repository.
  const dir = tempDir(t)
  const plain = await runGit(dir, ['rev-parse', '--show-toplevel'])
  assert.equal(plain, '', 'not a repository')
  const init = await runGit(dir, ['init', '-q'])
  assert.equal(init, '')
  await runGit(dir, ['remote', 'add', 'origin', 'git@example.com:team/sample.git'])
  const top = await runGit(dir, ['rev-parse', '--show-toplevel'])
  assert.ok(top, 'git reports the repository root')
  // realpath.native expands Windows 8.3 short names (RUNNER~1), as git does.
  assert.equal(normalizePath(fs.realpathSync.native(top)), normalizePath(fs.realpathSync.native(dir)))
  const resolver = new ProjectResolver()
  const project = await resolver.resolveCwd(dir)
  assert.equal(project.kind, 'git')
  assert.equal(project.name, 'sample')
  assert.equal(project.projectId, projectIdentity({ origin: 'https://example.com/team/sample' }).projectId)
  // A folder without git is hashed by its real path (8.3 short names and
  // symlinks expanded), so both spellings of one folder are one project.
  const plainDir = tempDir(t)
  const noGit = new ProjectResolver({ git: async () => '' })
  const folder = await noGit.resolveCwd(plainDir)
  assert.equal(folder.kind, 'cwd')
  assert.equal(folder.projectId, projectIdentity({ cwd: fs.realpathSync.native(plainDir) }).projectId)

  // A real repository without origin and a worktree of it: one project,
  // from the shared git directory (git gets the folder's real path).
  const repo = tempDir(t)
  await runGit(repo, ['init', '-q'])
  await runGit(repo, ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '-q', '--allow-empty', '-m', 'init'])
  const tree = path.join(tempDir(t), 'feature')
  await runGit(repo, ['worktree', 'add', '-q', tree])
  const fresh = new ProjectResolver({ homeDir: '' })
  const main = await fresh.resolveCwd(repo)
  const side = await fresh.resolveCwd(tree)
  assert.equal(main.kind, 'root')
  assert.equal(side.projectId, main.projectId, 'a worktree is the same project')
  assert.equal(main.name, path.basename(fs.realpathSync.native(repo)))
})

test('scopes: unknown or missing scope is global; partitions and weights', () => {
  assert.equal(scopeOf({}), 'global')
  assert.equal(scopeOf({ scope: 'project' }), 'global', 'a project scope without an id is global')
  assert.equal(scopeOf({ scope: 'project', project_id: 'p1' }), 'project')
  assert.equal(scopeOf({ scope: 'session', session_id: 's1' }), 'session')
  assert.equal(scopeOf({ scope: 'weird', project_id: 'p1' }), 'global')
  assert.equal(partitionKey({ scope: 'project', project_id: 'p1' }), 'project:p1')
  const parts = recallPartitions({ projectId: 'p1', sessionId: 's1' })
  assert.deepEqual(parts, [{ scope: 'global' }, { scope: 'project', project_id: 'p1' }, { scope: 'session', session_id: 's1' }])
  assert.ok(inPartitions({}, parts))
  assert.ok(inPartitions({ scope: 'project', project_id: 'p1' }, parts))
  assert.equal(inPartitions({ scope: 'project', project_id: 'p2' }, parts), false)
  assert.equal(inPartitions({ scope: 'session', session_id: 's2' }, parts), false)
  assert.ok(inPartitions({ scope: 'project', project_id: 'p2' }, undefined), 'no partitions: everything')
  assert.equal(partitionWeight({}, 1.1), 1)
  assert.equal(partitionWeight({ scope: 'project', project_id: 'p1' }, 1.1), 1.1)
  assert.equal(partitionWeight({ scope: 'project', project_id: 'p1' }, 0), 1)
  assert.deepEqual(partitionsFromKey('global'), [{ scope: 'global' }])
  assert.deepEqual(partitionsFromKey('project:p1'), [{ scope: 'project', project_id: 'p1' }])
  assert.deepEqual(partitionsFromKey('session:s-1'), [{ scope: 'session', session_id: 's-1' }])
  assert.equal(partitionsFromKey(''), undefined)
  assert.deepEqual(partitionsFromKey('project:../../etc'), [])
})

// ------------------------------------------------------------- store

function unit(values) {
  return Float32Array.from(values)
}

test('store: partition columns, partitioned list/search/neighbors, setScope, counts, project names', (t) => {
  const store = tempStore(t)
  const base = { user_id: USER }
  store.insert([
    { id: 'g1', text: 'Global fact', hash: 'h1', vector: unit([1, 0, 0]), payload: base, scope: 'global' },
    { id: 'old', text: 'Legacy fact with no scope', hash: 'h0', vector: unit([0.9, 0.1, 0]), payload: base, scope: null },
    { id: 'p1', text: 'Project one fact', hash: 'h2', vector: unit([0.95, 0.05, 0]), payload: base, scope: 'project', projectId: 'pA' },
    { id: 'p2', text: 'Project two fact', hash: 'h3', vector: unit([0.97, 0.03, 0]), payload: base, scope: 'project', projectId: 'pB' },
    { id: 's1', text: 'Session fact', hash: 'h4', vector: unit([0.96, 0.04, 0]), payload: base, scope: 'session', sessionId: 'S1', projectId: 'pA' },
  ])
  assert.equal(store.get('g1').scope, 'global')
  assert.equal(store.get('old').scope, undefined, 'a legacy row has no scope (read as global)')
  assert.equal(store.get('p1').project_id, 'pA')
  assert.equal(store.get('s1').session_id, 'S1')

  const recall = [{ scope: 'global' }, { scope: 'project', project_id: 'pA' }, { scope: 'session', session_id: 'S1' }]
  const listed = store.list(base, { partitions: recall }).map((item) => item.id).sort()
  assert.deepEqual(listed, ['g1', 'old', 'p1', 's1'])
  assert.deepEqual(store.list(base, { partitions: [{ scope: 'global' }] }).map((item) => item.id).sort(), ['g1', 'old'])
  const hits = store.search(unit([1, 0, 0]), base, { topK: 10, partitions: recall }).map((item) => item.id)
  assert.equal(hits.includes('p2'), false, 'another project is not recalled')
  assert.equal(store.search(unit([1, 0, 0]), base, { topK: 10 }).length, 5, 'no partitions: every memory')

  const near = store.neighbors('p1', base, { threshold: 0.5, samePartition: true }).map((item) => item.id)
  assert.deepEqual(near, [], 'no other memory in project A')
  assert.ok(store.neighbors('g1', base, { threshold: 0.5, samePartition: true }).some((item) => item.id === 'old'), 'legacy rows share the global partition')
  assert.ok(store.neighbors('p1', base, { threshold: 0.5 }).length >= 3)

  assert.equal(store.setScope('p1', { scope: 'global' }), true)
  assert.equal(store.get('p1').scope, 'global')
  assert.equal(store.get('p1').project_id, undefined)
  assert.ok(store.search(unit([1, 0, 0]), base, { topK: 10, partitions: [{ scope: 'global' }] }).some((item) => item.id === 'p1'), 'the vector cache follows the move')
  assert.equal(store.setScope('missing', { scope: 'global' }), false)
  assert.throws(() => store.setScope('g1', { scope: 'project' }), /project id/)

  const counts = store.partitionCounts(base).sort((a, b) => a.scope.localeCompare(b.scope))
  assert.ok(counts.every((row) => typeof row.newest === 'string'), 'the latest write, for session labels')
  assert.deepEqual(counts.map(({ newest: _newest, ...row }) => row), [
    { scope: 'global', project_id: null, session_id: null, count: 3 },
    { scope: 'project', project_id: 'pB', session_id: null, count: 1 },
    { scope: 'session', project_id: 'pA', session_id: 'S1', count: 1 },
  ])
  store.setProject('pA', { name: 'alpha', kind: 'git' })
  store.setProject('pA', { name: 'alpha', kind: 'git' })
  assert.deepEqual(store.projects(), { pA: { name: 'alpha', kind: 'git' } })
})

// ------------------------------------------------------------- recall and capture

function fakeSession({ id = 'session-1', cwd = '/work/alpha', messages = [] } = {}) {
  return { id, header: { cwd }, deriveMessages: () => messages }
}

function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function projectResolver({ record } = {}) {
  return new ProjectResolver({
    platform: 'linux',
    git: async (cwd, args) => (cwd === '/work/alpha' ? (args[0] === 'rev-parse' ? '/work/alpha' : 'git@github.com:org/alpha.git') : ''),
    record,
  })
}

function engine(client, { overrides = {}, maintenance, ...rest } = {}) {
  const projects = 'projects' in rest ? rest.projects : projectResolver()
  return new MemoryLifecycle({
    client,
    config: { userId: USER, agentId: 'dsh', recallTopK: 2, captureMaxChars: 450, autoRecall: true, autoCapture: true, captureFilter: 'off', importanceWeight: 0, ...overrides },
    logger: quiet,
    breaker: { isOpen: () => false, recordSuccess() {}, recordFailure() {} },
    activity: { recall: null, capture: null },
    maintenance,
    projects,
  })
}

test('recall reads global + the current project + this session, and the project boost reorders', async () => {
  const searches = []
  const named = []
  const client = {
    async search(query, filters, options) {
      searches.push(options)
      return {
        results: [
          { id: 'g', memory: 'Global memory', score: 0.85 },
          { id: 'p', memory: 'Project memory', score: 0.8, scope: 'project', project_id: options.partitions[1].project_id },
          { id: 'g2', memory: 'Weaker global memory', score: 0.6 },
        ],
      }
    },
  }
  const lifecycle = engine(client, { projects: projectResolver({ record: (identity) => named.push([identity.projectId, { name: identity.name, kind: identity.kind }]) }) })
  const session = fakeSession({ messages: [userMessage('what do we use for tests?')] })
  const result = await lifecycle.onSystemPromptAssemble({}, { agent: { session } }, async () => ({ contexts: [] }))
  const alpha = projectIdentity({ cwd: '/work/alpha', root: '/work/alpha', origin: 'git@github.com:org/alpha.git' }, { platform: 'linux' })
  // The project's repository and folder ids (aliases) are read with it.
  assert.deepEqual(searches[0].partitions, recallPartitions({ projectId: alpha.projectId, aliases: alpha.aliases, sessionId: 'session-1' }))
  assert.deepEqual(searches[0].partitions.slice(0, 2), [{ scope: 'global' }, { scope: 'project', project_id: alpha.projectId }])
  assert.equal(searches[0].partitions.length, 2 + alpha.aliases.length + 1)
  assert.equal(searches[0].topK, 8, 'a wide pool, so global memories cannot keep the project out')
  const block = result.contexts[0].text
  // 0.80 × 1.1 = 0.88 > 0.85: the project memory leads.
  assert.ok(block.indexOf('Project memory') < block.indexOf('Global memory'))
  assert.equal(block.includes('Weaker global memory'), false, 'cut to recallTopK')
  assert.deepEqual(named, [[alpha.projectId, { name: 'alpha', kind: 'git' }]], 'the project name is recorded, not its path')
})

test('recall without a boost keeps the similarity order; without a project only global and the session', async () => {
  const searches = []
  const client = {
    async search(query, filters, options) {
      searches.push(options)
      return { results: [{ id: 'g', memory: 'Global memory', score: 0.85 }, { id: 'p', memory: 'Project memory', score: 0.8, scope: 'project', project_id: 'x' }] }
    },
  }
  const flat = engine(client, { overrides: { projectRecallBoost: 1 } })
  const out = await flat.onSystemPromptAssemble({}, { agent: { session: fakeSession({ messages: [userMessage('question one')] }) } }, async () => ({ contexts: [] }))
  assert.ok(out.contexts[0].text.indexOf('Global memory') < out.contexts[0].text.indexOf('Project memory'))
  const noProject = engine(client, { projects: undefined })
  await noProject.onSystemPromptAssemble({}, { agent: { session: fakeSession({ messages: [userMessage('question two')] }) } }, async () => ({ contexts: [] }))
  assert.deepEqual(searches.at(-1).partitions, [{ scope: 'global' }, { scope: 'session', session_id: 'session-1' }])
})

test('capture stores a turn in its project; no working directory → global; folds use the session seen before', async () => {
  const adds = []
  const client = {
    async search() {
      return { results: [] }
    },
    async add(messages, options) {
      adds.push(options)
      return { results: [{ id: `m${adds.length}`, memory: 'x', event: 'ADD' }] }
    },
    setProject() {},
  }
  const lifecycle = engine(client, { overrides: { captureStrataFolds: true } })
  const turn = (session) => {
    lifecycle.onSessionEvent(session, { type: 'turn/start', data: {} })
    lifecycle.onSessionEvent(session, { type: 'user/message', data: userMessage('Please remember: this repository uses pnpm and vitest for every package.') })
    lifecycle.onSessionEvent(session, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Noted, pnpm and vitest.' }] } } })
    lifecycle.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  }
  const alpha = fakeSession()
  turn(alpha)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(adds[0].scope, 'project')
  assert.match(adds[0].projectId, /^p[0-9a-f]{16}$/)
  const nowhere = { id: 'session-2', header: {}, deriveMessages: () => [] }
  turn(nowhere)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(adds[1].scope, 'global', 'no working directory: global')
  assert.equal(adds[1].projectId, undefined)
  // A dsh-strata fold carries only the session id.
  lifecycle.onStrataFold({ sessionId: 'session-1', foldId: 'f1', tier: 1, topic: 'setup', summary: 'The repository uses pnpm workspaces and vitest for unit tests across all packages, decided after a long discussion.' })
  lifecycle.onStrataFold({ sessionId: 'session-9', foldId: 'f2', tier: 1, topic: 'x', summary: 'An unknown session summary that is long enough to be captured by the heuristic filter as durable.' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(adds[2].scope, 'project')
  assert.equal(adds[2].projectId, adds[0].projectId)
  assert.equal(adds.length, 3, 'a fold of a session this plugin never handled is ignored')

  // A fold of a session whose project was not looked up in this process
  // (after a reload): DSH's session registry gives the session. Without it
  // the fold is not saved: written globally it would reach every project.
  const folds = []
  const foldClient = { ...client, async add(messages, options) { folds.push(options); return { results: [{ id: `f${folds.length}`, memory: 'x', event: 'ADD' }] } } }
  const registry = new Map([['session-1', fakeSession()]])
  const reloaded = new MemoryLifecycle({
    client: foldClient,
    config: { userId: USER, agentId: 'dsh', recallTopK: 2, captureMaxChars: 450, autoRecall: true, autoCapture: true, captureFilter: 'off', captureStrataFolds: true },
    logger: quiet,
    breaker: { isOpen: () => false, recordSuccess() {}, recordFailure() {} },
    activity: { recall: null, capture: null },
    projects: projectResolver(),
    sessions: () => ({ get: (id) => registry.get(id) }),
  })
  for (const id of ['session-1', 'session-gone']) reloaded.onSessionEvent({ id, header: {}, deriveMessages: () => [] }, { type: 'turn/start', data: {} })
  const summary = 'The repository uses pnpm workspaces and vitest for unit tests across all packages, decided after a long discussion.'
  reloaded.onStrataFold({ sessionId: 'session-1', foldId: 'r1', tier: 1, topic: 'setup', summary })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(folds.length, 1)
  assert.equal(folds[0].scope, 'project', 'the project of the session the registry gave')
  assert.equal(folds[0].projectId, adds[0].projectId)
  reloaded.onStrataFold({ sessionId: 'session-gone', foldId: 'r2', tier: 1, topic: 'setup', summary })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(folds.length, 1, 'no session: the fold is not saved, not written globally')
  reloaded.dispose()
})

test('the summary section joins the current project summary once the project is known', async () => {
  const asked = []
  const maintenance = {
    profileBlock(options) {
      asked.push(options)
      return options.projectId ? '# Global\n- g\n\n# Project: alpha\n- p' : '- g'
    },
  }
  const lifecycle = engine({ async search() { return { results: [] } }, setProject() {} }, { maintenance, overrides: { profileEnabled: true } })
  const session = fakeSession({ messages: [userMessage('hello there friend')] })
  // DSH renders sections first, then runs the assemble waterfall.
  const rendered = lifecycle.profileSectionText({ agent: { session } })
  assert.match(rendered, /- g/)
  assert.doesNotMatch(rendered, /Project/)
  assert.deepEqual(asked[0], {}, 'before the project is resolved: global only')
  const assembly = { sections: [{ name: 'other', text: 'x' }, { name: PROFILE_SECTION_NAME, text: rendered, interpolate: false }], contexts: [] }
  await lifecycle.onSystemPromptAssemble(assembly, { agent: { session } }, async () => {
    // The first prompt already carries the project summary.
    assert.match(assembly.sections[1].text, /Project: alpha/)
    assert.equal(assembly.sections[0].text, 'x')
    return assembly
  })
  assert.equal(asked.at(-1).projectName, 'alpha')
  // Later renders find the project cached: same text, nothing rewritten.
  const again = lifecycle.profileSectionText({ agent: { session } })
  assert.equal(again, assembly.sections[1].text)
})

// ------------------------------------------------------------- tools

test('mem0_add stores in the project by default, global or session on request; mem0_search scopes', async () => {
  const adds = []
  const searches = []
  const client = {
    async add(messages, options) {
      adds.push(options)
      return { results: [{ id: 'n1', memory: messages[0].content, event: 'ADD' }] }
    },
    async search(query, filters, options) {
      searches.push(options)
      return { results: [] }
    },
    async setScope() {},
    setProject() {},
    async setAttributes() {},
  }
  const tools = createMem0Tools(client, { userId: USER, agentId: 'dsh', backend: 'oss' }, { projects: projectResolver() })
  const tool = (name) => tools.find((item) => item.name === name)
  const exec = { agent: { session: fakeSession() } }
  assert.ok(tool('mem0_add').parameters.properties.scope)
  assert.match(await tool('mem0_add').execute({ content: 'Uses pnpm here' }, exec), /in this project/)
  assert.equal(adds[0].scope, 'project')
  assert.match(await tool('mem0_add').execute({ content: 'Prefers dark mode', scope: 'global' }, exec), /as global/)
  assert.equal(adds[1].scope, 'global')
  await tool('mem0_add').execute({ content: 'Working on the login bug today', scope: 'session' }, exec)
  assert.deepEqual([adds[2].scope, adds[2].sessionId, adds[2].projectId], ['session', 'session-1', adds[0].projectId])
  // No session (a programmatic call): a project add is global.
  await tool('mem0_add').execute({ content: 'Background fact' }, {})
  assert.equal(adds[3].scope, 'global')

  await tool('mem0_search').execute({ query: 'tests' }, exec)
  // Global, the project (with its alias ids) and the session.
  assert.deepEqual(searches[0].partitions.map((partition) => partition.scope), ['global', 'project', ...searches[0].partitions.slice(2, -1).map(() => 'project'), 'session'])
  assert.equal(searches[0].partitions[1].project_id, adds[0].projectId)
  await tool('mem0_search').execute({ query: 'tests', scope: 'all' }, exec)
  assert.equal(searches[1].partitions, undefined, 'all: cross-project search')
  await tool('mem0_search').execute({ query: 'tests', scope: 'global' }, exec)
  assert.deepEqual(searches[2].partitions, [{ scope: 'global' }])
  assert.match(await tool('mem0_search').execute({ query: 'tests', scope: 'project' }, {}), /no project/)
  assert.deepEqual(searchPartitions('project', { projectId: 'p1' }), [{ scope: 'project', project_id: 'p1' }])

  // REST backends: no partitions, no scope parameter.
  const rest = createMem0Tools({ ...client, setScope: undefined }, { userId: USER }, {})
  assert.equal(rest.find((item) => item.name === 'mem0_add').parameters.properties.scope, undefined)
})

// ------------------------------------------------------------- partition summaries

function memory(id, text, extra = {}) {
  return { id, memory: text, user_id: USER, created_at: '2026-11-01T00:00:00.000000+00:00', updated_at: extra.updated_at ?? '2026-11-01T00:00:00.000000+00:00', metadata: { source: 'dsh' }, ...extra }
}

function listStore(rows, { projects = {} } = {}) {
  const map = new Map(rows.map((row) => [row.id, { ...row }]))
  return {
    map,
    async list() {
      return { results: [...map.values()].map((row) => ({ ...row })) }
    },
    async get(id) {
      return map.get(id) ?? null
    },
    async remove(id) {
      map.delete(id)
      return { message: 'deleted' }
    },
    async projects() {
      return projects
    },
    async search() {
      return { results: [] }
    },
  }
}

/** A mock ctx.llm answering summary calls with `summary(records)`; review calls get an empty action list. */
function summaryLlm(summary) {
  const calls = []
  const llm = {
    listProviders: () => ['mock'],
    async *stream(options) {
      const text = options.messages[0].content[0].text
      if (options.system === SUMMARY_SYSTEM_PROMPT) {
        const records = JSON.parse(text.split('\n')[2]).records
        calls.push({ label: text.split('\n')[0], records })
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }
        yield { type: 'text-delta', text: summary(records, text) }
      } else {
        yield { type: 'text-delta', text: '{"actions":[]}' }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return { services: { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-model' }) } }, calls }
}

function maintenanceFor(t, client, llm, overrides = {}) {
  const dir = tempDir(t)
  const state = new MaintenanceState(path.join(dir, 'maintenance.json'))
  const maintenance = new MemoryMaintenance({
    client,
    config: { backend: 'oss', storePath: '/test/p3/memory.sqlite', userId: USER, agentId: 'dsh', profileEnabled: true, profileBudgetTokens: 500, hygieneEnabled: true, hygieneIntervalDays: 7, modelHygiene: true, ...overrides },
    state,
    logger: quiet,
    llm: llm?.services,
    rebuildDelayMs: 0,
  })
  t.after(() => maintenance.dispose())
  return maintenance
}

const PROJECT = 'p0123456789abcdef'

test('summaries: one per partition, written by the model, injected as global + current project', async (t) => {
  const client = listStore([
    memory('g1', 'Prefers concise answers', { importance: 5 }),
    memory('g2', 'Lives in Shanghai'),
    memory('p1', 'Uses pnpm in this repository', { scope: 'project', project_id: PROJECT, importance: 4 }),
    memory('s1', 'Debugging the login bug now', { scope: 'session', session_id: 'S1' }),
  ], { projects: { [PROJECT]: { name: 'alpha' } } })
  const llm = summaryLlm((records) => `## Facts\n${records.map((record) => `- ${record.text}`).join('\n')}`)
  const maintenance = maintenanceFor(t, client, llm)
  const report = await maintenance.run('manual')
  assert.equal(report.summaries.model, 2, 'global and the project, not the session')
  assert.equal(report.summaries.calls, 2)
  assert.equal(report.summaries.usage.totalTokens, 240)
  assert.match(llm.calls[0].label, /global/)
  assert.match(llm.calls[1].label, /alpha/)
  // Importance first in what the model reads.
  assert.equal(llm.calls[0].records[0].text, 'Prefers concise answers')
  assert.equal(llm.calls[0].records[0].importance, 5)
  assert.ok(llm.calls.every((call) => !call.records.some((record) => record.text.includes('login bug'))))

  assert.equal(maintenance.profileBlock(), '## Facts\n- Prefers concise answers\n- Lives in Shanghai')
  const joined = maintenance.profileBlock({ projectId: PROJECT, projectName: 'alpha' })
  assert.match(joined, /^# Global\n## Facts\n- Prefers concise answers/)
  assert.match(joined, /# Project: alpha\n## Facts\n- Uses pnpm in this repository$/)
  assert.equal(maintenance.profileBlock({ projectId: 'pother' }), maintenance.profileBlock(), 'a project without a summary: global only')
  const status = maintenance.status()
  assert.equal(status.projectProfiles.length, 1)
  assert.equal(status.projectProfiles[0].name, 'alpha')
  assert.equal(status.projectProfiles[0].source, 'model')
  assert.equal(JSON.stringify(status.projectProfiles).includes('pnpm'), false, 'status carries no summary text')

  // Same sources next pass: no new call.
  const again = await maintenance.run('manual')
  assert.equal(again.summaries.calls, 0)
  assert.equal(again.summaries.kept, 2)
})

test('summaries: a delete or an edit marks the partition summary stale (not injected) and it is rebuilt', async (t) => {
  const client = listStore([
    memory('g1', 'Prefers concise answers'),
    memory('p1', 'Uses pnpm in this repository', { scope: 'project', project_id: PROJECT }),
    memory('p2', 'Tests run with vitest', { scope: 'project', project_id: PROJECT }),
  ])
  const llm = summaryLlm((records) => records.map((record) => `- ${record.text}`).join('\n'))
  const maintenance = maintenanceFor(t, client, llm)
  await maintenance.run('manual')
  assert.match(maintenance.profileBlock({ projectId: PROJECT }), /vitest/)
  client.map.delete('p2')
  assert.equal(maintenance.invalidateMemories(['p2']), true)
  const stale = maintenance.profileBlock({ projectId: PROJECT })
  assert.equal(stale.includes('pnpm'), false, 'the stale project summary is not injected')
  assert.equal(stale, '- Prefers concise answers', 'the global one, untouched, still is')
  assert.equal(maintenance.status().projectProfiles[0].stale, true)
  assert.equal(maintenance.needsProfileRebuild(), true)
  // The rebuild the invalidation scheduled.
  await new Promise((resolve) => setTimeout(resolve, 20))
  while (maintenance.running) await maintenance.running.catch(() => {})
  const rebuilt = maintenance.profileBlock({ projectId: PROJECT })
  assert.match(rebuilt, /pnpm/)
  assert.equal(rebuilt.includes('vitest'), false)
  // An unrelated id changes nothing.
  assert.equal(maintenance.invalidateMemories(['unknown-id']), false)
})

test('summaries: without the model (off, unavailable or a bad answer) the script writes them', async (t) => {
  const rows = [memory('g1', 'Prefers concise answers'), memory('p1', 'Uses pnpm in this repository', { scope: 'project', project_id: PROJECT })]
  const off = maintenanceFor(t, listStore(rows), summaryLlm(() => '- never'), { modelHygiene: false })
  const offReport = await off.run('manual')
  assert.equal(offReport.summaries.status, 'off')
  assert.equal(offReport.summaries.script, 2)
  assert.match(off.profileBlock({ projectId: PROJECT }), /## /, 'script summaries have headings')

  const bad = maintenanceFor(t, listStore(rows), summaryLlm(() => '{"not":"a summary"}'))
  const badReport = await bad.run('manual')
  assert.equal(badReport.summaries.model, 0)
  assert.equal(badReport.summaries.script, 2)
  assert.equal(badReport.summaries.reason, 'BAD_SUMMARY')

  const broken = summaryLlm(() => '')
  broken.services.llm.stream = async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'none' } } }
  }
  const down = maintenanceFor(t, listStore(rows), broken)
  const downReport = await down.run('manual')
  assert.equal(downReport.summaries.script, 2)
  // The review already found the model unavailable: no summary call is tried.
  assert.equal(downReport.summaries.status, 'skipped')
  assert.equal(downReport.summaries.reason, 'NO_ADAPTER')
  assert.equal(downReport.summaries.calls, 0)
})

test('summary helpers: input ranked and redacted, answers cleaned, sources compared', () => {
  const input = summaryInput([
    { id: 'a', memory: 'Key sk-abcdefghijklmnop123456 is used', updated_at: '2026-11-02' },
    { id: 'b', memory: 'x'.repeat(400), updated_at: '2026-11-01', importance: 4 },
  ])
  assert.equal(input.records[0].text.includes('sk-abcdefghijklmnop123456'), false)
  assert.ok(input.records[1].text.length <= 320)
  assert.equal(input.records[1].importance, 4)
  assert.deepEqual(input.memoryIds, ['a', 'b'])
  assert.ok(sameSources({ memoryIds: ['a', 'b'], memoryVersions: { ...input.memoryVersions } }, input))
  assert.equal(sameSources({ memoryIds: ['a'], memoryVersions: { a: input.memoryVersions.a } }, input), false)
  assert.equal(sameSources(null, input), false)

  assert.equal(cleanSummary('Here is the summary:\n## A\n- one\n- two', 100), '## A\n- one\n- two')
  assert.equal(cleanSummary('```markdown\n- one\n```', 100), '- one')
  assert.equal(cleanSummary('{"actions":[]}', 100), '')
  assert.equal(cleanSummary('I cannot help with that.', 100), '')
  assert.equal(cleanSummary('- token sk-abcdefghijklmnop123456', 100).includes('sk-abcdefghijklmnop123456'), false)
  assert.equal(cleanSummary(`- ${'word '.repeat(50)}\n- ${'more '.repeat(50)}`, 70).split('\n').length, 1, 'cut to the budget')
})

test('review: a merge or a delete-by across partitions is dropped; a merge stays in its partition', async (t) => {
  const rows = [
    memory('g1', 'Uses tabs for indentation', { updated_at: '2026-11-01T00:00:00.000000+00:00' }),
    memory('p1', 'Uses two spaces for indentation in this repository', { scope: 'project', project_id: PROJECT, updated_at: '2026-11-02T00:00:00.000000+00:00' }),
    memory('p2', 'Indentation here is two spaces', { scope: 'project', project_id: PROJECT, updated_at: '2026-11-03T00:00:00.000000+00:00' }),
  ]
  const adds = []
  const client = {
    ...listStore(rows),
    async neighbors(id) {
      return rows.filter((row) => row.id !== id).map((row) => ({ id: row.id, score: 0.9 }))
    },
    async add(messages, options) {
      adds.push(options)
      return { results: [{ id: 'merged1', memory: messages[0].content }] }
    },
    async get(id) {
      return id === 'merged1' ? { id } : rows.find((row) => row.id === id) ?? null
    },
    async remove() {
      return { message: 'deleted' }
    },
  }
  const llm = {
    listProviders: () => ['mock'],
    async *stream(options) {
      if (options.system === SUMMARY_SYSTEM_PROMPT) {
        yield { type: 'text-delta', text: '- summary' }
      } else {
        const records = JSON.parse(options.messages[0].content[0].text.split('\n')[1]).records
        const ref = (text) => records.find((record) => record.text.startsWith(text))?.id
        yield { type: 'text-delta', text: JSON.stringify({ actions: answer(ref).filter((action) => action.ids.every(Boolean) && (!('by' in action) || action.by)) }) }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const services = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'm' }) } }
  let answer = (ref) => [{ type: 'merge', ids: [ref('Uses tabs'), ref('Uses two spaces')], text: 'Indentation', reason: 'same topic' }]
  const first = await maintenanceFor(t, client, { services }).run('manual', { dryRun: true })
  assert.equal(first.model.rejected['cross-scope'], 1, 'a merge across partitions is dropped')
  assert.equal(first.mergePlan.length, 0)
  answer = (ref) => [{ type: 'delete', ids: [ref('Uses tabs')], by: ref('Indentation here'), reason: 'newer' }]
  const second = await maintenanceFor(t, client, { services }).run('manual', { dryRun: true })
  assert.equal(second.model.rejected['cross-scope'], 1, 'a project memory does not retire a global one')
  assert.equal(second.planned, 0)
  answer = (ref) => [{ type: 'merge', ids: [ref('Uses two spaces'), ref('Indentation here')], text: 'Uses two spaces for indentation in this repository', reason: 'duplicate' }]
  const maintenance = maintenanceFor(t, client, { services })
  const preview = await maintenance.run('manual', { dryRun: true })
  const report = await maintenance.runPlan({ planId: preview.planId, idempotencyKey: 'k1' })
  assert.equal(report.merged, 1)
  assert.equal(adds[0].scope, 'project')
  assert.equal(adds[0].projectId, PROJECT)
  assert.equal(report.deletedDetails.some((item) => item.id === 'g1'), false, 'the global memory is not retired by a project one')
})

test('B1: with project memories only, hourly checks do not call the model again', async (t) => {
  // Other apps' memories: no review calls, only summary calls reach the model.
  const foreign = { metadata: { source: 'other-app' } }
  const client = listStore([
    memory('p1', 'Uses pnpm in this repository', { scope: 'project', project_id: PROJECT, ...foreign }),
    memory('p2', 'Tests run with vitest', { scope: 'project', project_id: PROJECT, ...foreign }),
  ])
  const llm = summaryLlm((records) => records.map((record) => `- ${record.text}`).join('\n'))
  let streams = 0
  const stream = llm.services.llm.stream
  llm.services.llm.stream = function (...args) {
    streams += 1
    return stream.apply(this, args)
  }
  const maintenance = maintenanceFor(t, client, llm)
  for (let index = 0; index < 3; index += 1) await maintenance.maybeRun('schedule')
  assert.equal(streams, 1, 'one model call: the project summary of the first (due) pass')
  assert.equal(llm.calls.length, 1)
  assert.match(maintenance.profileBlock({ projectId: PROJECT }), /vitest/)
  assert.equal(maintenance.profileBlock(), '', 'the empty global partition injects nothing')
  assert.equal(maintenance.needsProfileRebuild(), false)
  // A new memory in the project: the hourly check still does not call the model.
  client.map.set('p3', memory('p3', 'Lint with biome', { scope: 'project', project_id: PROJECT, ...foreign, updated_at: '2026-11-02T00:00:00.000000+00:00' }))
  await maintenance.maybeRun('schedule')
  assert.equal(streams, 1)
})

test('B1: a partition whose model summary is unusable twice for the same sources gets the script one', async (t) => {
  const client = listStore([memory('p1', 'Uses pnpm in this repository', { scope: 'project', project_id: PROJECT })])
  const llm = summaryLlm(() => '{"not":"a summary"}')
  const maintenance = maintenanceFor(t, client, llm)
  for (let index = 0; index < 4; index += 1) await maintenance.run('manual')
  assert.equal(llm.calls.length, 2, 'asked twice, then left to the script')
  assert.match(maintenance.profileBlock({ projectId: PROJECT }), /pnpm/)
  // New sources: the model is asked again.
  client.map.set('p2', memory('p2', 'Tests run with vitest', { scope: 'project', project_id: PROJECT, updated_at: '2026-11-02T00:00:00.000000+00:00' }))
  await maintenance.run('manual')
  assert.equal(llm.calls.length, 3)
})

test('B2: exact copies are removed within one partition; a project copy of a global memory goes, never the global one', async (t) => {
  const older = { created_at: '2026-10-01T00:00:00.000000+00:00', updated_at: '2026-10-01T00:00:00.000000+00:00' }
  const client = listStore([
    memory('a1', 'The user uses pnpm', { scope: 'project', project_id: 'pa00000000000000a', ...older }),
    memory('b1', 'The user uses pnpm', { scope: 'project', project_id: 'pb00000000000000b' }),
    memory('g1', 'Prefers dark mode', older),
    memory('c1', 'Prefers dark mode', { scope: 'project', project_id: 'pc00000000000000c' }),
    memory('a2', 'Tests run with vitest', { scope: 'project', project_id: 'pa00000000000000a', ...older }),
    memory('a3', 'Tests run with vitest', { scope: 'project', project_id: 'pa00000000000000a' }),
  ])
  const maintenance = maintenanceFor(t, client, summaryLlm(() => '- x'), { modelHygiene: false })
  const preview = await maintenance.run('manual', { dryRun: true })
  const planned = preview.plannedDetails.map((item) => item.id).sort()
  assert.deepEqual(planned, ['a2', 'c1'], 'the same fact in two projects stays; the project copy of a global fact and a copy within one project go')
  assert.equal(planned.includes('g1'), false, 'a global memory never goes for a project copy')
})

test('summaries: stale with unchanged sources is reused; a pass marks only the touched partition; rebuilds wait and use the script', async (t) => {
  const client = listStore([
    memory('g1', 'Prefers concise answers'),
    memory('p1', 'Uses pnpm in this repository', { scope: 'project', project_id: PROJECT }),
    memory('q1', 'Deploys with fly.io', { scope: 'project', project_id: 'pfedcba9876543210' }),
  ])
  const llm = summaryLlm((records) => records.map((record) => `- model: ${record.text}`).join('\n'))
  const maintenance = maintenanceFor(t, client, llm, {})
  await maintenance.run('manual')
  assert.equal(llm.calls.length, 3)
  // Marked stale, but nothing changed: the next pass keeps it without a call.
  maintenance.invalidateMemories(['p1'])
  assert.equal(maintenance.profileBlock({ projectId: PROJECT }).includes('pnpm'), false, 'stale: not injected')
  while (maintenance.running) await maintenance.running.catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  while (maintenance.running) await maintenance.running.catch(() => {})
  assert.equal(llm.calls.length, 3, 'the rebuild after a delete never calls the model')
  assert.match(maintenance.profileBlock({ projectId: PROJECT }), /model: Uses pnpm/, 'same sources: the model summary is reused')
  assert.equal(maintenance.status().projectProfiles.every((item) => !item.stale), true)

  // A real delete in one project: only that summary is rebuilt (by the
  // script), the other project and global keep the model's text.
  client.map.delete('p1')
  client.map.set('p4', memory('p4', 'Uses bun now', { scope: 'project', project_id: PROJECT }))
  maintenance.invalidateMemories(['p1'])
  await new Promise((resolve) => setTimeout(resolve, 20))
  while (maintenance.running) await maintenance.running.catch(() => {})
  assert.equal(llm.calls.length, 3)
  assert.match(maintenance.profileBlock({ projectId: PROJECT }), /bun/)
  assert.doesNotMatch(maintenance.profileBlock({ projectId: PROJECT }), /model:.*bun/, 'rebuilt by the script')
  assert.match(maintenance.profileBlock({ projectId: 'pfedcba9876543210' }), /model: Deploys with fly.io/)
  assert.match(maintenance.profileBlock(), /model: Prefers concise answers/)
})

test('summaries: a run of deletes gives one delayed rebuild', async (t) => {
  const rows = Array.from({ length: 5 }, (_, index) => memory(`p${index}`, `Project fact number ${index}`, { scope: 'project', project_id: PROJECT }))
  const client = listStore(rows)
  let lists = 0
  const list = client.list
  client.list = async (...args) => {
    lists += 1
    return list(...args)
  }
  const dir = tempDir(t)
  const maintenance = new MemoryMaintenance({
    client,
    config: { backend: 'oss', storePath: '/test/p3/memory.sqlite', userId: USER, agentId: 'dsh', profileEnabled: true, profileBudgetTokens: 500, hygieneEnabled: true, hygieneIntervalDays: 7, modelHygiene: false },
    state: new MaintenanceState(path.join(dir, 'maintenance.json')),
    logger: quiet,
    rebuildDelayMs: 40,
  })
  t.after(() => maintenance.dispose())
  await maintenance.run('manual')
  const before = lists
  for (let index = 0; index < 4; index += 1) {
    client.map.delete(`p${index}`)
    maintenance.invalidateMemories([`p${index}`])
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(lists, before, 'nothing yet: the rebuild waits for more deletes')
  await new Promise((resolve) => setTimeout(resolve, 80))
  while (maintenance.running) await maintenance.running.catch(() => {})
  assert.equal(lists, before + 1, 'one rebuild for four deletes')
  assert.match(maintenance.profileBlock({ projectId: PROJECT }), /number 4/)
})

// ------------------------------------------------------------- memory page routes

function routes(runtime) {
  const table = new Map()
  registerGuiRoutes({
    inject(_names, register) {
      register({
        get: (name) => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
        webServer: { register: (route) => (table.set(route.path, route.handler), () => {}) },
        effect: (fn) => fn(),
      })
    },
  }, () => runtime)
  return table.get(GUI_MEMORIES_PATH)
}

async function call(handler, method, url, body) {
  const res = { statusCode: 200, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value }, end(value = '') { this.body = value } }
  const req = { method, url }
  if (body !== undefined) req[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify(body)) }
  await handler(req, res)
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined }
}

test('memory page: tree with counts, partition filter, make global, report bodies by id', async (t) => {
  const store = tempStore(t)
  const payload = { user_id: USER, source: 'dsh' }
  store.insert([
    { id: 'g1', text: 'Global fact', hash: 'a', vector: unit([1, 0]), payload },
    { id: 'p1', text: 'Alpha fact', hash: 'b', vector: unit([1, 0]), payload, scope: 'project', projectId: 'pA' },
    { id: 'p2', text: 'Alpha second fact', hash: 'c', vector: unit([1, 0]), payload, scope: 'project', projectId: 'pA' },
    { id: 's1', text: 'Session fact', hash: 'd', vector: unit([1, 0]), payload, scope: 'session', sessionId: 'S1', projectId: 'pA' },
    { id: 's2', text: 'Loose session fact', hash: 'e', vector: unit([1, 0]), payload, scope: 'session', sessionId: 'S2' },
    { id: 'x1', text: 'Someone else', hash: 'f', vector: unit([1, 0]), payload: { user_id: 'other-user', source: 'dsh' } },
  ])
  store.setProject('pA', { name: 'alpha', kind: 'git' })
  const invalidated = []
  const client = {
    list: async (filters, options) => ({ results: store.list(filters, { limit: options?.topK, partitions: options?.partitions }) }),
    get: async (id) => store.get(id),
    setScope: async (id, scope) => store.setScope(id, scope),
    setAttributes: async (id, attributes) => store.setAttributes(id, attributes),
    partitionCounts: async (filters) => store.partitionCounts(filters),
    projects: async () => store.projects(),
  }
  const handler = routes({ client, config: { userId: USER, backend: 'oss' }, maintenance: { invalidateMemories: (ids) => invalidated.push(...ids) } })

  const tree = (await call(handler, 'GET', `${GUI_MEMORIES_PATH}?tree=1`)).body
  assert.equal(tree.partitioned, true)
  assert.equal(tree.total, 5)
  assert.equal(tree.global, 1)
  assert.deepEqual(tree.projects.map((item) => [item.name, item.count, item.sessions.map((session) => session.id)]), [['alpha', 2, ['S1']]])
  assert.deepEqual(tree.sessions.map((item) => item.id), ['S2'])

  const alpha = (await call(handler, 'GET', `${GUI_MEMORIES_PATH}?partition=project:pA`)).body
  assert.deepEqual(alpha.memories.map((item) => item.id).sort(), ['p1', 'p2'])
  assert.ok(alpha.memories.every((item) => item.scope === 'project' && item.projectId === 'pA' && item.globalizable))
  const searched = (await call(handler, 'GET', `${GUI_MEMORIES_PATH}?partition=project:pA&q=second`)).body
  assert.deepEqual(searched.memories.map((item) => item.id), ['p2'])
  const all = (await call(handler, 'GET', `${GUI_MEMORIES_PATH}`)).body
  assert.equal(all.total, 5)
  assert.equal(all.memories.find((item) => item.id === 'g1').globalizable, false)
  assert.equal((await call(handler, 'GET', `${GUI_MEMORIES_PATH}?partition=project:..%2Fx`)).body.total, 0)

  const moved = await call(handler, 'POST', GUI_MEMORIES_PATH, { id: 'p1', scope: 'global' })
  assert.equal(moved.status, 200)
  assert.equal(store.get('p1').scope, 'global')
  assert.equal(store.get('p1').memory, 'Alpha fact', 'text unchanged')
  assert.deepEqual(invalidated, ['p1'])
  assert.equal((await call(handler, 'POST', GUI_MEMORIES_PATH, { id: 'p2', scope: 'session' })).status, 400, 'only to global')
  assert.equal((await call(handler, 'POST', GUI_MEMORIES_PATH, { id: 'x1', scope: 'global' })).status, 403)
  // The backend enforces "project → global only, this plugin's own": a
  // forged request for a session, global or foreign memory is refused.
  store.insert([{ id: 'o1', text: 'Other app fact', hash: 'g', vector: unit([1, 0]), payload: { user_id: USER, source: 'other-app' }, scope: 'project', projectId: 'pA' }])
  const refused = async (id) => {
    const answer = await call(handler, 'POST', GUI_MEMORIES_PATH, { id, scope: 'global' })
    return [answer.status, answer.body.reason]
  }
  assert.deepEqual(await refused('s1'), [409, 'not-project'])
  assert.deepEqual(await refused('p1'), [409, 'not-project'], 'already global')
  assert.deepEqual(await refused('o1'), [403, 'not-own'])
  assert.deepEqual(await refused('missing'), [404, 'not-found'])
  assert.equal(store.get('s1').scope, 'session')
  assert.equal(store.get('o1').scope, 'project')
  assert.deepEqual(invalidated, ['p1'], 'nothing else moved')

  // An expired memory is neither listed nor counted in the tree.
  store.insert([{ id: 'e1', text: 'Expired alpha fact', hash: 'h', vector: unit([1, 0]), payload: { user_id: USER, source: 'dsh', expiration_date: '2000-01-01' }, scope: 'project', projectId: 'pA' }])
  const recount = (await call(handler, 'GET', `${GUI_MEMORIES_PATH}?tree=1`)).body
  const listedAlpha = (await call(handler, 'GET', `${GUI_MEMORIES_PATH}?partition=project:pA`)).body.memories
  assert.equal(recount.projects.find((item) => item.id === 'pA').count, listedAlpha.length)
  assert.ok(recount.projects.find((item) => item.id === 'pA').sessions.every((session) => typeof session.newest === 'string'))

  // Report rows keep ids: the page reads the current text, null when gone.
  const lookup = (await call(handler, 'GET', `${GUI_MEMORIES_PATH}?ids=g1,missing,x1,${encodeURIComponent('bad id!')}`)).body
  assert.equal(lookup.texts.g1.memory, 'Global fact')
  assert.equal(lookup.texts.missing, null)
  assert.equal(lookup.texts.x1, null, 'another user’s memory is not shown')
  assert.equal(Object.hasOwn(lookup.texts, 'bad id!'), false)
})

test('memory page on a REST backend: no partitions, one flat list', async () => {
  const client = { list: async () => ({ results: [{ id: 'r1', memory: 'Remote fact', user_id: USER }] }), get: async () => null }
  const handler = routes({ client, config: { userId: USER, backend: 'platform' } })
  const tree = (await call(handler, 'GET', `${GUI_MEMORIES_PATH}?tree=1`)).body
  assert.equal(tree.partitioned, false)
  assert.equal(tree.global, 1)
  const listed = (await call(handler, 'GET', `${GUI_MEMORIES_PATH}?partition=global`)).body
  assert.equal(listed.memories[0].scope, 'global')
  assert.equal(listed.memories[0].globalizable, false)
})

test('memory page: report texts are read a few at a time (REST backends answer one id per request)', async () => {
  let inFlight = 0
  let peak = 0
  const client = {
    async get(id) {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return { id, memory: `Text ${id}`, user_id: USER }
    },
  }
  const handler = routes({ client, config: { userId: USER, backend: 'platform' } })
  const ids = Array.from({ length: 20 }, (_, index) => `m${index}`)
  const lookup = (await call(handler, 'GET', `${GUI_MEMORIES_PATH}?ids=${ids.join(',')}`)).body
  assert.equal(Object.keys(lookup.texts).length, 20)
  assert.ok(peak <= 6, `at most 6 at once (saw ${peak})`)
})

// ------------------------------------------------------------- "partition by project" switch

const ALPHA = projectIdentity({ cwd: '/work/alpha', root: '/work/alpha', origin: 'git@github.com:org/alpha.git' }, { platform: 'linux' })

/**
 * A partition-aware client over a list of rows: search keeps the rows in the
 * requested partitions whose text shares a word with the query, by score.
 */
function partitionClient(rows) {
  const map = new Map(rows.map((row) => [row.id, { user_id: USER, metadata: { source: 'dsh' }, ...row }]))
  const searches = []
  const adds = []
  const words = (text) => new Set(String(text).toLowerCase().match(/[a-z]{4,}/g) ?? [])
  return {
    map,
    searches,
    adds,
    async search(query, filters, options = {}) {
      searches.push(options)
      const wanted = words(query)
      const hits = [...map.values()]
        .filter((row) => inPartitions(row, options.partitions))
        .filter((row) => [...words(row.memory)].some((word) => wanted.has(word)))
        .sort((a, b) => b.score - a.score)
        .slice(0, options.topK ?? 10)
      return { results: hits.map((row) => ({ ...row })) }
    },
    async add(messages, options) {
      adds.push(options)
      const id = `n${adds.length}`
      const row = { id, memory: String(messages.at(-1)?.content ?? ''), score: 0.5, user_id: USER, metadata: { source: 'dsh' } }
      if (options.scope === 'project') Object.assign(row, { scope: 'project', project_id: options.projectId })
      else if (options.scope === 'session') Object.assign(row, { scope: 'session', session_id: options.sessionId })
      map.set(id, row)
      return { results: [{ id, memory: row.memory, event: 'ADD' }] }
    },
    async list() {
      return { results: [...map.values()].map((row) => ({ ...row })) }
    },
    async get(id) {
      return map.has(id) ? { ...map.get(id) } : null
    },
    async remove(id) {
      map.delete(id)
      return { message: 'deleted' }
    },
    async projects() {
      return { [ALPHA.projectId]: { name: 'alpha' } }
    },
    setProject() {},
    async setScope() {},
    async setAttributes() {},
  }
}

async function recallText(lifecycle, session, query) {
  session.deriveMessages = () => [userMessage(query)]
  const out = await lifecycle.onSystemPromptAssemble({}, { agent: { session } }, async () => ({ contexts: [] }))
  return out.contexts[0]?.text ?? ''
}

test('switch off: new memories go to global, recall reads only global and the session; back on, project memories return', async () => {
  const client = partitionClient([
    { id: 'g1', memory: 'Deploy with the shared release script', score: 0.7 },
    { id: 'p1', memory: 'Deploy alpha with make ship', score: 0.9, scope: 'project', project_id: ALPHA.projectId },
    { id: 's1', memory: 'Deploy notes kept for this session', score: 0.6, scope: 'session', session_id: 'session-1' },
  ])
  const asked = []
  const maintenance = { profileBlock: (options) => (asked.push(options), '- g') }
  const off = engine(client, { maintenance, overrides: { projectPartitions: false, profileEnabled: true } })
  const session = fakeSession()
  const offBlock = await recallText(off, session, 'how do we deploy here?')
  assert.deepEqual(client.searches.at(-1).partitions, [{ scope: 'global' }, { scope: 'session', session_id: 'session-1' }])
  assert.match(offBlock, /shared release script/)
  assert.match(offBlock, /Deploy notes kept/)
  assert.equal(offBlock.includes('make ship'), false, 'no project memory while the switch is off')
  // The injected summary is the global one only.
  assert.equal(off.profileSectionText({ agent: { session } }), off.profileSectionText({ agent: { session } }))
  assert.ok(asked.every((options) => options.projectId === undefined))
  // No session event yet and no session registry: the chip's project is pending.
  assert.deepEqual(await off.memoryScope('session-1'), { partitions: false, available: true, project: null, pending: true })

  // A captured turn goes to global.
  off.onSessionEvent(session, { type: 'turn/start', data: {} })
  off.onSessionEvent(session, { type: 'user/message', data: userMessage('Please remember: deployments of this service need a change ticket first.') })
  off.onSessionEvent(session, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Noted, a change ticket first.' }] } } })
  off.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(client.adds.at(-1).scope, 'global')
  assert.equal(client.adds.at(-1).projectId, undefined)
  // The chip still names the session's project while the switch is off, so
  // turning it on shows "Memory: project alpha" at once (Windows retest).
  assert.deepEqual(await off.memoryScope('session-1'), { partitions: false, available: true, project: { name: 'alpha', kind: 'git' } })
  assert.equal(client.adds.at(-1).readPartitions, undefined)

  // The tools follow the switch: a default add is global, search reads global + session.
  const tools = createMem0Tools(client, { userId: USER, agentId: 'dsh', backend: 'oss', projectPartitions: false }, { projects: projectResolver() })
  const tool = (name) => tools.find((item) => item.name === name)
  assert.match(await tool('mem0_add').execute({ content: 'Deploy freeze on Fridays' }, { agent: { session } }), /as global/)
  assert.equal(client.adds.at(-1).scope, 'global')
  await tool('mem0_search').execute({ query: 'deploy' }, { agent: { session } })
  assert.deepEqual(client.searches.at(-1).partitions, [{ scope: 'global' }, { scope: 'session', session_id: 'session-1' }])
  off.dispose()

  // The project memory was not changed or moved; back on, it is recalled again.
  assert.deepEqual(client.map.get('p1').scope, 'project')
  assert.equal(client.map.get('p1').project_id, ALPHA.projectId)
  const on = engine(client)
  const onBlock = await recallText(on, fakeSession(), 'how do we deploy here?')
  assert.match(onBlock, /make ship/)
  assert.deepEqual((await on.memoryScope('session-1')).project, { name: 'alpha', kind: 'git' })
  on.dispose()
})

test('switch off: hygiene and summaries handle only global; project memories and summaries stay, and are handled again when on', async (t) => {
  const client = listStore([
    memory('g1', 'Prefers dark mode'),
    memory('p1', 'Uses pnpm in this repository', { scope: 'project', project_id: PROJECT }),
  ], { projects: { [PROJECT]: { name: 'alpha' } } })
  const llm = summaryLlm((records) => `## Facts\n${records.map((record) => `- ${record.text}`).join('\n')}`)
  const maintenance = maintenanceFor(t, client, llm)
  await maintenance.run('manual')
  assert.equal(llm.calls.length, 2)
  const projectSummary = maintenance.profileBlock({ projectId: PROJECT })
  assert.match(projectSummary, /pnpm/)

  // Off: a project copy of a global memory, a new project memory and a new global one.
  maintenance.config.projectPartitions = false
  client.map.set('c1', memory('c1', 'Prefers dark mode', { scope: 'project', project_id: PROJECT }))
  client.map.set('p2', memory('p2', 'Tests run with vitest', { scope: 'project', project_id: PROJECT }))
  client.map.set('g2', memory('g2', 'Lives in Shanghai'))
  const preview = await maintenance.run('manual', { dryRun: true })
  assert.equal(preview.plannedDetails.some((item) => item.id === 'c1'), false, 'project memories are not touched while off')
  const calls = llm.calls.length
  const report = await maintenance.run('manual')
  const newCalls = llm.calls.slice(calls)
  assert.equal(newCalls.length, 1, 'only the global summary is rebuilt')
  assert.match(newCalls[0].label, /global/)
  assert.ok(newCalls[0].records.every((record) => !/pnpm|vitest/.test(record.text)), 'no project memory reaches the global summary')
  assert.equal(report.summaries.model, 1)
  assert.ok(client.map.has('c1') && client.map.has('p2'), 'nothing in a project is deleted')
  assert.match(maintenance.profileBlock(), /Shanghai/)
  // The saved project summary is kept as it was.
  assert.equal(maintenance.profileBlock({ projectId: PROJECT }).includes(projectSummary.split('\n').at(-1)), true)
  assert.equal(maintenance.status().projectProfiles.length, 1)
  // A stale project summary does not bring passes while off.
  client.map.delete('p1')
  maintenance.invalidateMemories(['p1'])
  await new Promise((resolve) => setTimeout(resolve, 20))
  while (maintenance.running) await maintenance.running.catch(() => {})
  assert.equal(maintenance.status().projectProfiles[0].stale, true, 'kept, still stale: not rebuilt while off')
  assert.equal(maintenance.needsProfileRebuild(), false)

  // On again: the project is handled as before.
  maintenance.config.projectPartitions = true
  assert.equal(maintenance.needsProfileRebuild(), true)
  await maintenance.run('manual')
  assert.equal(client.map.has('c1'), false, 'the project copy of a global memory goes (B2)')
  assert.ok(client.map.has('g1'), 'never the global one')
  const rebuilt = maintenance.profileBlock({ projectId: PROJECT })
  assert.match(rebuilt, /vitest/)
  assert.equal(rebuilt.includes('pnpm'), false)
  assert.equal(maintenance.profileBlock().includes('vitest'), false, 'the project summary is never merged into the global one')
})

// ------------------------------------------------------------- design 5.9 acceptance

test('5.9 (a): the same term in two projects: a session sees only its project and global', async (t) => {
  const BETA = 'pbeta000000000001'
  const rows = [
    { id: 'g', memory: 'Deploy only after the tests pass', score: 0.6 },
    { id: 'pa', memory: 'Deploy alpha with make ship', score: 0.8, scope: 'project', project_id: ALPHA.projectId },
    { id: 'pb', memory: 'Deploy beta with helm upgrade', score: 0.9, scope: 'project', project_id: BETA },
  ]
  const client = partitionClient(rows)
  const lifecycle = engine(client, { overrides: { recallTopK: 5 } })
  const block = await recallText(lifecycle, fakeSession(), 'how do we deploy?')
  assert.match(block, /make ship/)
  assert.match(block, /tests pass/)
  assert.equal(block.includes('helm'), false, 'another project with the same term is not seen')
  lifecycle.dispose()
  const tools = createMem0Tools(client, { userId: USER, agentId: 'dsh', backend: 'oss' }, { projects: projectResolver() })
  const search = tools.find((item) => item.name === 'mem0_search')
  const current = await search.execute({ query: 'deploy' }, { agent: { session: fakeSession() } })
  assert.equal(current.includes('helm'), false)
  assert.match(current, /make ship/)
  assert.match(await search.execute({ query: 'deploy', scope: 'all' }, { agent: { session: fakeSession() } }), /helm/, 'only an explicit all-projects search reaches it')

  // The same in the real store.
  const store = tempStore(t)
  const base = { user_id: USER }
  store.insert([
    { id: 'g', text: rows[0].memory, hash: 'h1', vector: unit([0.9, 0.1, 0]), payload: base, scope: 'global' },
    { id: 'pa', text: rows[1].memory, hash: 'h2', vector: unit([0.95, 0.05, 0]), payload: base, scope: 'project', projectId: ALPHA.projectId },
    { id: 'pb', text: rows[2].memory, hash: 'h3', vector: unit([1, 0, 0]), payload: base, scope: 'project', projectId: BETA },
  ])
  const hits = store.search(unit([1, 0, 0]), base, { topK: 10, partitions: recallPartitions({ projectId: ALPHA.projectId, sessionId: 'session-1' }) }).map((item) => item.id).sort()
  assert.deepEqual(hits, ['g', 'pa'])
})

test('5.9 (b): first-turn recall on pre-upgrade data (all global) is not worse than before', async (t) => {
  const store = tempStore(t)
  const base = { user_id: USER }
  const texts = ['Uses pnpm for installs', 'Prefers vitest for tests', 'Deploys with make ship', 'Lives in Shanghai', 'Prefers dark mode', 'Writes commit messages in English']
  const vectors = [[1, 0, 0], [0.9, 0.1, 0], [0.8, 0.2, 0], [0.1, 0.9, 0], [0.2, 0.8, 0], [0.7, 0.3, 0]]
  // Rows written before partitions existed: no scope column value.
  store.insert(texts.map((text, index) => ({ id: `old${index}`, text, hash: `h${index}`, vector: unit(vectors[index]), payload: base, scope: null })))
  const client = {
    async search(query, filters, options = {}) {
      return { results: store.search(unit([1, 0, 0]), base, { topK: options.topK, ...(options.partitions ? { partitions: options.partitions } : {}) }) }
    },
    setProject() {},
  }
  for (const recallTopK of [2, 3, 5]) {
    // Before the upgrade: no partitions, the plain top K.
    const before = store.search(unit([1, 0, 0]), base, { topK: recallTopK }).map((item) => item.memory ?? item.text)
    const lifecycle = engine(client, { overrides: { recallTopK } })
    const block = await recallText(lifecycle, fakeSession(), 'which tools do we use?')
    lifecycle.dispose()
    for (const text of before) assert.ok(block.includes(text), `topK ${recallTopK}: "${text}" is still recalled`)
    const shown = texts.filter((text) => block.includes(text))
    assert.equal(shown.length, before.length, `topK ${recallTopK}: as many memories as before`)
  }
})

test('5.9 (c): after a delete, summary and search agree and the deleted memory never comes back', async (t) => {
  const client = partitionClient([
    { ...memory('g1', 'Prefers dark mode themes'), score: 0.6 },
    { ...memory('g2', 'Prefers vitest testing setup'), score: 0.7 },
    { ...memory('p1', 'Uses pnpm testing workspace', { scope: 'project', project_id: ALPHA.projectId }), score: 0.8 },
    { ...memory('p2', 'Runs vitest testing in watch mode', { scope: 'project', project_id: ALPHA.projectId }), score: 0.9 },
  ])
  const llm = summaryLlm((records) => records.map((record) => `- ${record.text}`).join('\n'))
  const maintenance = maintenanceFor(t, client, llm)
  await maintenance.run('manual')
  assert.match(maintenance.profileBlock({ projectId: ALPHA.projectId }), /watch mode/)
  assert.match(maintenance.profileBlock(), /vitest testing setup/)
  const tools = createMem0Tools(client, { userId: USER, agentId: 'dsh', backend: 'oss' }, { projects: projectResolver(), maintenance })
  const tool = (name) => tools.find((item) => item.name === name)
  const exec = { agent: { session: fakeSession() } }

  for (const id of ['p2', 'g2']) {
    assert.match(await tool('mem0_delete').execute({ memory_id: id }, exec), /Deleted/)
  }
  const gone = /watch mode|vitest testing setup/
  // At once: the summaries built from them are not injected, search does not find them.
  assert.doesNotMatch(maintenance.profileBlock({ projectId: ALPHA.projectId }), gone)
  assert.doesNotMatch(await tool('mem0_search').execute({ query: 'vitest testing' }, exec), gone)
  // After the rebuild: the summaries are back without them.
  await new Promise((resolve) => setTimeout(resolve, 20))
  while (maintenance.running) await maintenance.running.catch(() => {})
  const after = maintenance.profileBlock({ projectId: ALPHA.projectId })
  assert.match(after, /pnpm testing workspace/)
  assert.match(after, /dark mode/)
  assert.doesNotMatch(after, gone)
  assert.ok(maintenance.status().projectProfiles.every((item) => item.stale === false))
  // A later pass (hygiene or recall) does not bring them back either.
  await maintenance.run('manual')
  assert.doesNotMatch(maintenance.profileBlock({ projectId: ALPHA.projectId }), gone)
  const lifecycle = engine(client, { overrides: { recallTopK: 5 } })
  assert.doesNotMatch(await recallText(lifecycle, fakeSession(), 'vitest testing'), gone)
  lifecycle.dispose()
})

// Windows retest (2026-11-20): DSH's first-use workspace showed up on the
// memory page as a project of its own. A chat there is in no project.
test('DSH default workspace: no project on POSIX and Windows paths, from DSH\'s registry, never by name alone', async () => {
  const registryOf = (workspaces, defaultWorkspaceId) => ({ list: () => workspaces, state: { defaultWorkspaceId } })
  const cases = [
    { platform: 'linux', home: '/home/me', ws: '/home/me/Documents/deepseek-harness/default-workspace', other: '/home/me/work/mem-test-a' },
    { platform: 'darwin', home: '/Users/me', ws: '/Users/me/Documents/deepseek-harness/default-workspace', other: '/Users/me/work/mem-test-a' },
    { platform: 'win32', home: 'C:\\Users\\Administrator', ws: 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace', other: 'C:\\Users\\Administrator\\mem-test-a' },
  ]
  for (const { platform, home, ws, other } of cases) {
    // By the registry's record (the workspace may have been renamed) …
    const byId = registryOf([{ id: 'w1', title: 'My chats', path: ws }, { id: 'w2', title: 'mem-test-a', path: other }], 'w1')
    assert.deepEqual(dshDefaultWorkspaces(byId), [ws])
    // … or by DSH's own rule: the automatic first-use title.
    const byTitle = registryOf([{ id: 'w1', title: DSH_DEFAULT_WORKSPACE_DIRECTORY, path: ws }])
    assert.deepEqual(dshDefaultWorkspaces(byTitle), [ws])
    const resolver = new ProjectResolver({ git: async () => '', platform, homeDir: home, defaultWorkspaces: () => dshDefaultWorkspaces(byId) })
    assert.equal(await resolver.resolveCwd(ws), null, `${platform}: the default workspace is no project`)
    // Windows: case and slashes do not matter.
    if (platform === 'win32') assert.equal(await resolver.resolve({ id: 'w-s1', header: { cwd: ws.toLowerCase().replace(/\\/g, '/') + '/' } }), null)
    const project = await resolver.resolveCwd(other)
    assert.equal(project.name, 'mem-test-a')
    // A sub-folder of it is a folder of its own (DSH starts chats in the workspace itself).
    assert.equal((await resolver.resolveCwd(platform === 'win32' ? `${ws}\\notes` : `${ws}/notes`)).name, 'notes')
    for (const name of [project.name]) assert.notEqual(name.toLowerCase(), 'defaultproject')
    // The ids the folder had as a project before: the memory page names them.
    const ids = await resolver.defaultWorkspaceIds()
    assert.deepEqual(ids, [projectIdentity({ cwd: ws }, { platform }).projectId])
    assert.equal(isDshDefaultProject(ids[0], { name: 'whatever', kind: 'cwd' }, ids), true)
  }
  // A folder that is merely named like it, without DSH saying so, is a project.
  const plain = new ProjectResolver({ git: async () => '', platform: 'linux', homeDir: '/home/me', defaultWorkspaces: () => [] })
  assert.equal((await plain.resolveCwd('/srv/default-workspace')).name, 'default-workspace')
  // No registry, or one that throws: nothing is the default workspace.
  assert.deepEqual(dshDefaultWorkspaces(undefined), [])
  assert.deepEqual(dshDefaultWorkspaces({ list: () => { throw new Error('gone') } }), [])
  const throwing = new ProjectResolver({ git: async () => '', platform: 'linux', defaultWorkspaces: () => { throw new Error('gone') } })
  assert.equal((await throwing.resolveCwd('/work/x')).name, 'x')
  // Recorded before this rule: a folder project with the first-use name.
  assert.equal(isDshDefaultProject('p1', { name: 'default-workspace', kind: 'cwd' }), true)
  assert.equal(isDshDefaultProject('p1', { name: 'default-workspace', kind: 'git' }), false)
  assert.equal(isDshDefaultProject('p1', { name: 'mem-test-a', kind: 'cwd' }), false)
})

test('DSH default workspace: a chat there writes to global even with partitions on', async () => {
  const client = partitionClient([])
  const ws = '/home/me/Documents/deepseek-harness/default-workspace'
  const projects = new ProjectResolver({ git: async () => '', platform: 'linux', homeDir: '/home/me', defaultWorkspaces: () => [ws] })
  const life = engine(client, { projects })
  const session = fakeSession({ id: 'dw-1', cwd: ws })
  await recallText(life, session, 'how do I like answers?')
  assert.deepEqual(client.searches.at(-1).partitions, [{ scope: 'global' }, { scope: 'session', session_id: 'dw-1' }])
  life.onSessionEvent(session, { type: 'turn/start', data: {} })
  life.onSessionEvent(session, { type: 'user/message', data: userMessage('Please remember: I prefer short answers in every chat.') })
  life.onSessionEvent(session, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Short answers it is.' }] } } })
  life.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(client.adds.at(-1).scope, 'global')
  assert.equal(client.adds.at(-1).projectId, undefined)
  assert.deepEqual(await life.memoryScope('dw-1'), { partitions: true, available: true, project: null })
  life.dispose()
})

test('scope chip: the session\'s project is kept across a plugin restart, so a flip shows it at once', async () => {
  const shared = new Map()
  const client = partitionClient([])
  const session = fakeSession({ id: 'chip-1' })
  const resolver = () => new ProjectResolver({
    platform: 'linux',
    git: async (cwd, args) => (cwd === '/work/alpha' ? (args[0] === 'rev-parse' ? '/work/alpha' : 'git@github.com:org/alpha.git') : ''),
    sessions: shared,
  })
  // Switch off: the first event already looks the project up.
  const off = engine(client, { projects: resolver(), overrides: { projectPartitions: false } })
  off.onSessionEvent(session, { type: 'turn/start', data: {} })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(await off.memoryScope('chip-1'), { partitions: false, available: true, project: { name: 'alpha', kind: 'git' } })
  off.dispose()
  // The switch flipped: DSH restarts the plugin; the new lifecycle has no
  // session registry and no event yet, and still knows the project.
  const on = engine(client, { projects: resolver() })
  assert.deepEqual(await on.memoryScope('chip-1'), { partitions: true, available: true, project: { name: 'alpha', kind: 'git' } })
  on.dispose()
  assert.ok(SESSION_PROJECTS instanceof Map, 'index.js shares one map per process')
})

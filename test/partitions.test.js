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
  ProjectResolver,
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

test('the working directory comes from the workingDirectory service, then the session header', () => {
  const session = { id: 's1', header: { cwd: '/start' } }
  assert.equal(sessionWorkingDirectory(session, { get: () => '/moved' }), '/moved')
  assert.equal(sessionWorkingDirectory(session, { get: () => { throw new Error('gone') } }), '/start')
  assert.equal(sessionWorkingDirectory(session, undefined), '/start')
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

  // Sessions: the resolver reads the working directory service.
  const sessions = new ProjectResolver({ git, platform: 'linux', workingDirectory: () => ({ get: () => '/repo-a' }) })
  assert.equal((await sessions.resolve({ id: 's', header: { cwd: '/elsewhere' } })).projectId, a.projectId)
  assert.equal(await sessions.resolve(null), null)
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
  assert.equal(normalizePath(fs.realpathSync(top)), normalizePath(fs.realpathSync(dir)))
  const resolver = new ProjectResolver()
  const project = await resolver.resolveCwd(dir)
  assert.equal(project.kind, 'git')
  assert.equal(project.name, 'sample')
  assert.equal(project.projectId, projectIdentity({ origin: 'https://example.com/team/sample' }).projectId)
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
  const store = new SqliteStore({ filePath: path.join(tempDir(t), 'memory.sqlite') })
  t.after(() => store.close())
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
  assert.deepEqual(counts, [
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

function projectResolver() {
  return new ProjectResolver({
    platform: 'linux',
    git: async (cwd, args) => (cwd === '/work/alpha' ? (args[0] === 'rev-parse' ? '/work/alpha' : 'git@github.com:org/alpha.git') : ''),
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
    setProject(id, info) {
      named.push([id, info])
    },
  }
  const lifecycle = engine(client)
  const session = fakeSession({ messages: [userMessage('what do we use for tests?')] })
  const result = await lifecycle.onSystemPromptAssemble({}, { agent: { session } }, async () => ({ contexts: [] }))
  const alpha = projectIdentity({ cwd: '/work/alpha', root: '/work/alpha', origin: 'git@github.com:org/alpha.git' }, { platform: 'linux' })
  assert.deepEqual(searches[0].partitions, [{ scope: 'global' }, { scope: 'project', project_id: alpha.projectId }, { scope: 'session', session_id: 'session-1' }])
  assert.equal(searches[0].topK, 4, 'extra hits so the boost can reorder')
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
  assert.equal(searches[0].partitions.length, 3)
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
  const store = new SqliteStore({ filePath: path.join(tempDir(t), 'memory.sqlite') })
  t.after(() => store.close())
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

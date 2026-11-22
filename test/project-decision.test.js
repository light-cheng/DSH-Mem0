/**
 * How a working directory's project (memory partition) is decided, with
 * real git and real folders: every case runs on macOS, Linux and Windows
 * (none is skipped; where file systems differ, the assertion says what each
 * one does).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chipDetail, displayPath, normalizePath, ProjectResolver, projectIdentity } from '../lib/project-scope.js'

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-project-')))
const home = path.join(base, 'home')
fs.mkdirSync(home)
test.after(() => fs.rmSync(base, { recursive: true, force: true }))

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', '-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()
}

function mkdir(...parts) {
  const dir = path.join(base, ...parts)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function repo(...parts) {
  const dir = mkdir(...parts)
  git(dir, 'init', '-q')
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'first')
  return dir
}

function resolver(options = {}) {
  return new ProjectResolver({ homeDir: home, ...options })
}

async function decide(r, cwd) {
  const project = await r.resolveCwd(cwd)
  return { project, detail: chipDetail(r.describeCwd(cwd), project, { homeDir: home }) }
}

// One folder name, two spellings: the same folder on a case-insensitive
// file system (macOS, Windows), two folders on a case-sensitive one.
function caseInsensitive(dir) {
  const other = path.join(path.dirname(dir), path.basename(dir).toUpperCase())
  return fs.existsSync(other)
}

test('a subdirectory of a repository is the repository (its root, not the subdirectory)', async () => {
  const root = repo('sub', 'shop')
  const deep = mkdir('sub', 'shop', 'src', 'lib')
  const r = resolver()
  const top = await decide(r, root)
  const inner = await decide(r, deep)
  assert.equal(top.project.kind, 'root')
  assert.equal(inner.project.projectId, top.project.projectId)
  assert.equal(inner.project.name, 'shop')
  assert.equal(inner.detail.basis, 'git-root')
  assert.equal(normalizePath(inner.detail.path), normalizePath(root))
  assert.equal(normalizePath(inner.detail.cwd), normalizePath(deep))
  assert.equal(inner.detail.partition, `project:${top.project.projectId}`)
})

test('two repositories with one folder name (/a/app, /b/app) are two partitions, named alike', async () => {
  const a = repo('two', 'a', 'app')
  const b = repo('two', 'b', 'app')
  const r = resolver()
  const first = await decide(r, a)
  const second = await decide(r, b)
  assert.notEqual(first.project.projectId, second.project.projectId)
  assert.equal(first.project.name, second.project.name, 'the chip alone cannot tell them apart: the hover shows the path')
  assert.notEqual(first.detail.path, second.detail.path)
  // Plain folders too.
  const plainA = mkdir('two-plain', 'a', 'app')
  const plainB = mkdir('two-plain', 'b', 'app')
  assert.notEqual((await r.resolveCwd(plainA)).projectId, (await r.resolveCwd(plainB)).projectId)
})

test('two clones of one remote share a partition (one project); without the remote they do not', async () => {
  const one = repo('clones', 'one', 'site')
  const two = repo('clones', 'two', 'site')
  for (const dir of [one, two]) git(dir, 'remote', 'add', 'origin', 'git@github.com:Org/Site.git')
  const r = resolver()
  const first = await decide(r, one)
  const second = await decide(r, two)
  assert.equal(first.project.kind, 'git')
  assert.equal(first.project.projectId, second.project.projectId)
  assert.equal(first.detail.basis, 'git-origin')
  assert.notEqual(first.detail.path, second.detail.path, 'the hover shows the clone in use')
})

test('a folder outside git is its own partition; each folder is a separate one; the home folder is none', async () => {
  const notes = mkdir('plain', 'notes')
  const inner = mkdir('plain', 'notes', 'drafts')
  const r = resolver()
  const top = await decide(r, notes)
  assert.equal(top.project.kind, 'cwd')
  assert.equal(top.project.name, 'notes')
  assert.equal(top.detail.basis, 'folder')
  assert.equal(normalizePath(top.detail.path), normalizePath(notes))
  // No repository to tie them: a subfolder is another partition.
  assert.notEqual((await r.resolveCwd(inner)).projectId, top.project.projectId)
  const atHome = await decide(r, home)
  assert.equal(atHome.project, null)
  assert.deepEqual(atHome.detail, { basis: 'home', cwd: '~', partition: 'global' })
})

test('DSH\'s default workspace is global, even inside a repository', async () => {
  const workspace = mkdir('Documents', 'deepseek-harness', 'default-workspace')
  const r = resolver({ defaultWorkspaces: () => [workspace] })
  const there = await decide(r, workspace)
  assert.equal(there.project, null)
  assert.equal(there.detail.basis, 'default-workspace')
  assert.equal(there.detail.partition, 'global')
  // Recognised by DSH's registry only: another folder of that name is a folder project.
  const lookalike = mkdir('elsewhere', 'default-workspace')
  assert.equal((await r.resolveCwd(lookalike)).kind, 'cwd')
  const inRepo = repo('wsrepo')
  const nested = mkdir('wsrepo', 'default-workspace')
  const r2 = resolver({ defaultWorkspaces: () => [nested] })
  assert.equal(await r2.resolveCwd(nested), null)
  assert.equal((await r2.resolveCwd(inRepo)).kind, 'root')
})

test('git worktrees (also .claude/worktrees/*) share the main checkout\'s partition', async () => {
  const main = repo('wt', 'ledger')
  const nested = path.join(main, '.claude', 'worktrees', 'brave-fox')
  fs.mkdirSync(path.dirname(nested), { recursive: true })
  git(main, 'worktree', 'add', '-q', '-b', 'brave', nested)
  const beside = path.join(base, 'wt', 'ledger-feature')
  git(main, 'worktree', 'add', '-q', '-b', 'feature', beside)
  const r = resolver()
  const top = await decide(r, main)
  for (const dir of [nested, beside, path.join(nested, '.')]) {
    const tree = await decide(r, dir)
    assert.equal(tree.project.projectId, top.project.projectId, dir)
    assert.equal(tree.project.name, 'ledger', 'named after the main checkout')
    assert.equal(tree.detail.worktree, true)
    assert.equal(normalizePath(tree.detail.path), normalizePath(main))
    assert.equal(normalizePath(tree.detail.checkout), normalizePath(fs.realpathSync.native(dir)))
  }
  assert.equal(top.detail.worktree, undefined)
  // With a remote: one git id for all of them.
  git(main, 'remote', 'add', 'origin', 'https://example.com/org/ledger.git')
  const r2 = resolver()
  assert.equal((await r2.resolveCwd(nested)).projectId, (await r2.resolveCwd(main)).projectId)
  assert.equal((await r2.resolveCwd(nested)).kind, 'git')
})

test('a repository inside another (not a worktree) is its own partition', async () => {
  const outer = repo('nest', 'outer')
  const inner = repo('nest', 'outer', 'vendor', 'inner')
  const r = resolver()
  assert.notEqual((await r.resolveCwd(inner)).projectId, (await r.resolveCwd(outer)).projectId)
  assert.equal((await r.resolveCwd(inner)).name, 'inner')
})

test('a symlinked (Windows: junction) folder is the folder it points to', async () => {
  const target = repo('links', 'real')
  const link = path.join(base, 'links', 'alias')
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  const plain = mkdir('links', 'plain-real')
  const plainLink = path.join(base, 'links', 'plain-alias')
  fs.symlinkSync(plain, plainLink, process.platform === 'win32' ? 'junction' : 'dir')
  const r = resolver()
  assert.equal((await r.resolveCwd(link)).projectId, (await r.resolveCwd(target)).projectId)
  assert.equal((await r.resolveCwd(plainLink)).projectId, (await r.resolveCwd(plain)).projectId)
  assert.equal(normalizePath((await decide(r, plainLink)).detail.path), normalizePath(plain))
})

test('letter case: one folder on macOS and Windows, two folders on Linux', async () => {
  const dir = repo('case', 'Pocket')
  const plain = mkdir('case', 'Notes')
  const r = resolver()
  const upper = path.join(base, 'case', 'POCKET')
  const lower = path.join(base, 'case', 'notes')
  if (caseInsensitive(dir)) {
    assert.equal((await r.resolveCwd(upper)).projectId, (await r.resolveCwd(dir)).projectId)
    assert.equal((await r.resolveCwd(lower)).projectId, (await r.resolveCwd(plain)).projectId)
    assert.equal((await r.resolveCwd(lower)).name, 'Notes', 'the name as on disk')
  } else {
    fs.mkdirSync(upper)
    fs.mkdirSync(lower)
    assert.notEqual((await r.resolveCwd(upper)).projectId, (await r.resolveCwd(dir)).projectId)
    assert.notEqual((await r.resolveCwd(lower)).projectId, (await r.resolveCwd(plain)).projectId)
  }
})

test('Unicode: a name typed composed or decomposed is one folder where the file system says so', async () => {
  const composed = 'Caf\u00e9'
  const decomposed = 'Cafe\u0301'
  const dir = mkdir('uni', decomposed)
  const r = resolver()
  const other = path.join(base, 'uni', composed)
  if (fs.existsSync(other)) {
    assert.equal((await r.resolveCwd(other)).projectId, (await r.resolveCwd(dir)).projectId)
  } else {
    fs.mkdirSync(other)
    assert.notEqual((await r.resolveCwd(other)).projectId, (await r.resolveCwd(dir)).projectId)
  }
})

test('Windows paths: backslashes, drive letter case, trailing separators and \\\\?\\ are one project', () => {
  const ids = ['C:\\Users\\Me\\Repo', 'c:/users/me/repo/', 'C:\\USERS\\ME\\REPO\\', '\\\\?\\C:\\Users\\Me\\Repo'].map(
    (cwd) => projectIdentity({ cwd }, { platform: 'win32' }).projectId,
  )
  assert.equal(new Set(ids).size, 1)
  const roots = ['C:/Work/App/.git', 'c:\\work\\app\\.git'].map((commonDir) => projectIdentity({ root: 'C:/Work/App', commonDir }, { platform: 'win32' }).projectId)
  assert.equal(roots[0], roots[1])
  assert.equal(projectIdentity({ cwd: 'D:\\' }, { platform: 'win32' }).name, 'D:')
  assert.notEqual(projectIdentity({ cwd: 'C:\\Work' }, { platform: 'win32' }).projectId, projectIdentity({ cwd: 'D:\\Work' }, { platform: 'win32' }).projectId)
  // POSIX keeps the case.
  assert.notEqual(projectIdentity({ cwd: '/Work/App' }, { platform: 'linux' }).projectId, projectIdentity({ cwd: '/work/app' }, { platform: 'linux' }).projectId)
  // Display: the home folder as ~ (Windows: any case, either separator).
  assert.equal(displayPath('C:\\Users\\Me\\Repo', { homeDir: 'c:\\users\\me', platform: 'win32' }), '~/Repo')
  assert.equal(displayPath('/home/me/repo', { homeDir: '/home/me', platform: 'linux' }), '~/repo')
  assert.equal(displayPath('/home/meadow', { homeDir: '/home/me', platform: 'linux' }), '/home/meadow')
  assert.equal(displayPath('/Home/me/x', { homeDir: '/home/me', platform: 'linux' }), '/Home/me/x')
})

test('on this machine, a path typed with other separators or case finds the same project', async () => {
  const dir = repo('typed', 'Mixed')
  const r = resolver()
  const id = (await r.resolveCwd(dir)).projectId
  if (process.platform === 'win32') {
    assert.equal((await r.resolveCwd(dir.replace(/\\/g, '/'))).projectId, id)
    assert.equal((await r.resolveCwd(dir.charAt(0).toLowerCase() + dir.slice(1))).projectId, id)
    assert.equal((await r.resolveCwd(`${dir}\\`)).projectId, id)
  } else {
    assert.equal((await r.resolveCwd(`${dir}/`)).projectId, id)
    assert.equal((await r.resolveCwd(path.join(dir, '.', 'x', '..'))).projectId, id)
  }
})

test('a session that changes directory moves to the new project; the hover says how each was decided', async () => {
  const shop = repo('move', 'shop')
  const notes = mkdir('move', 'notes')
  const workspace = mkdir('move', 'default-workspace')
  let live = shop
  const r = resolver({ workingDirectory: () => ({ get: () => live, defaultDirectory: base }), defaultWorkspaces: () => [workspace] })
  const session = { id: 'moving', header: { cwd: shop } }
  const atShop = await r.resolve(session)
  assert.equal(atShop.name, 'shop')
  live = notes
  const atNotes = await r.resolve(session)
  assert.equal(atNotes.kind, 'cwd')
  assert.equal(r.describe(session).basis, 'folder')
  live = workspace
  assert.equal(await r.resolve(session), null)
  assert.equal(r.describe(session).basis, 'default-workspace')
  live = path.join(shop, 'src')
  fs.mkdirSync(live)
  assert.equal((await r.resolve(session)).projectId, atShop.projectId)
  assert.equal(r.sessionDetails('moving').basis, 'git-root')
})

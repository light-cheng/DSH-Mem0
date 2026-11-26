// The memory library's pages in SQL (lib/store-sqlite.js listPage and
// libraryIndexOf), over a few thousand fake memories of a test user in a
// temporary file. No test is skipped on any platform.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SqliteStore, escapeLike } from '../lib/store-sqlite.js'
import { inPartitions, scopeOf } from '../lib/project-scope.js'
import { libraryPartitions } from '../lib/gui-routes.js'

const SCOPE = { user_id: 'dsh-mem0-paging-test-user', agent_id: 'dsh-test' }
const TOTAL = 5000

function stamp(index) {
  // One second apart, a few sharing a second (ties are ordered by id).
  const seconds = Math.floor(index * 0.9)
  return new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString().replace('Z', '000+00:00')
}

function partitionFor(index) {
  const slot = index % 10
  if (slot < 4) return {} // global
  if (slot < 7) return { scope: 'project', projectId: 'pA' }
  if (slot === 7) return { scope: 'session', projectId: 'pA', sessionId: `sA${index % 3}` }
  if (slot === 8) return { scope: 'project', projectId: 'pB' }
  return { scope: 'session', sessionId: `loose${index % 2}` } // a session with no project
}

function textFor(index) {
  if (index === 10) return 'I am 100% sure about tea'
  if (index === 11) return 'Uses snake_case names'
  if (index === 12) return 'Uses snakeXcase names'
  if (index === 13) return 'Said 100 percent, about TEA'
  if (index === 14) return 'A path with back\\slash'
  return `Fact number ${index} about topic ${index % 17}`
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-paging-'))
  const store = new SqliteStore({ filePath: path.join(dir, 'memory.sqlite'), now: () => new Date('2026-11-20T10:00:00Z') }).open()
  t.after(() => {
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const records = []
  for (let index = 0; index < TOTAL; index += 1) {
    const payload = { ...SCOPE, created_at: stamp(index) }
    // Every 250th expired (a date before "now"), never index 10–14.
    if (index % 250 === 3) payload.expiration_date = '2026-01-02'
    records.push({ id: `m${String(index).padStart(5, '0')}`, text: textFor(index), hash: `h${index}`, vector: [1, 0, 0], payload, embedModel: 'test-embed', ...partitionFor(index) })
  }
  records.push({ id: 'other-user', text: 'Fact of someone else about tea', hash: 'ho', vector: [1, 0, 0], payload: { user_id: 'someone-else', created_at: stamp(TOTAL) }, embedModel: 'test-embed' })
  const started = performance.now()
  store.insert(records)
  const insertMs = performance.now() - started
  // The reference: every live memory of the user, in the library's order.
  const all = store.list(SCOPE, { limit: TOTAL * 2 })
  return { store, all, insertMs }
}

const ids = (items) => items.map((item) => item.id)

test('escapeLike makes %, _ and \\ literal', () => {
  assert.equal(escapeLike('100%_a\\b'), '100\\%\\_a\\\\b')
  assert.equal(escapeLike('plain'), 'plain')
})

test('listPage: pages of 20, newest or oldest first, counted, the same rows as list()', (t) => {
  const { store, all } = fixture(t)
  const expired = Math.ceil((TOTAL - 3) / 250)
  assert.equal(all.length, TOTAL - expired)
  const first = store.listPage(SCOPE, { offset: 0, limit: 20 })
  assert.equal(first.total, all.length)
  assert.deepEqual(ids(first.results), ids(all.slice(0, 20)))
  const third = store.listPage(SCOPE, { offset: 40, limit: 20 })
  assert.deepEqual(ids(third.results), ids(all.slice(40, 60)))
  // Every page in turn gives every memory once, in list()'s order.
  const walked = []
  for (let offset = 0; offset < first.total; offset += 20) walked.push(...ids(store.listPage(SCOPE, { offset, limit: 20 }).results))
  assert.deepEqual(walked, ids(all))
  // Oldest first is the exact reverse.
  const oldest = []
  for (let offset = 0; offset < first.total; offset += 1000) oldest.push(...ids(store.listPage(SCOPE, { offset, limit: 1000, order: 'oldest' }).results))
  assert.deepEqual(oldest, ids(all).reverse())
  // At most 1,000 a page.
  assert.equal(store.listPage(SCOPE, { limit: 5000 }).results.length, 1000)
  // Past the end: no rows, the same total.
  const past = store.listPage(SCOPE, { offset: first.total + 100, limit: 20 })
  assert.deepEqual(past.results, [])
  assert.equal(past.total, first.total)
  // The last page is partial.
  const lastOffset = Math.floor((first.total - 1) / 20) * 20
  assert.equal(store.listPage(SCOPE, { offset: lastOffset, limit: 20 }).results.length, first.total - lastOffset)
  // Expired ones only on request; another user's never.
  assert.equal(store.listPage(SCOPE, { showExpired: true }).total, TOTAL)
  assert.equal(store.listPage(SCOPE, { query: 'someone else' }).total, 0)
  // Bad numbers fall back to safe ones.
  assert.equal(store.listPage(SCOPE, { offset: -5, limit: 'x' }).results.length, 20)
  // Rows keep the item shape (partition included).
  const item = store.listPage(SCOPE, { query: 'm00017' }).results[0]
  assert.equal(item.id, 'm00017')
  assert.equal(item.scope, 'session')
  assert.equal(item.project_id, 'pA')
})

test('listPage search: substring of text or id, %, _ and \\ literal, ASCII case folded', (t) => {
  const { store, all } = fixture(t)
  const search = (query) => ids(store.listPage(SCOPE, { query, limit: 1000 }).results)
  assert.deepEqual(search('%'), ['m00010'])
  assert.deepEqual(search('100%'), ['m00010'])
  assert.deepEqual(search('_'), ['m00011'])
  assert.deepEqual(search('snake_case'), ['m00011'], 'the _ does not match the X of snakeXcase')
  assert.deepEqual(search('\\'), ['m00014'])
  assert.deepEqual(search('TEA').sort(), ['m00010', 'm00013'])
  // By id.
  assert.deepEqual(search('m04321'), ['m04321'])
  // Agrees with a JS substring filter on a common word.
  const expected = all.filter((item) => item.memory.toLowerCase().includes('topic 5') || item.id.includes('topic 5'))
  assert.deepEqual(search('topic 5'), ids(expected).slice(0, 1000))
  assert.equal(store.listPage(SCOPE, { query: 'topic 5' }).total, expected.length)
  // Blank means no search.
  assert.equal(store.listPage(SCOPE, { query: '   ' }).total, all.length)
})

test('listPage partitions: global, project, project with its sessions, every project, session; agrees with JS', (t) => {
  const { store, all } = fixture(t)
  const check = (partitions, predicate, label) => {
    const page = store.listPage(SCOPE, { partitions, limit: 1000 })
    const expected = all.filter(predicate)
    assert.equal(page.total, expected.length, label)
    assert.deepEqual(ids(page.results), ids(expected.slice(0, 1000)), label)
  }
  check([{ scope: 'global' }], (item) => scopeOf(item) === 'global', 'global')
  check([{ scope: 'project', project_id: 'pA' }], (item) => inPartitions(item, [{ scope: 'project', project_id: 'pA' }]), 'project pA')
  check([{ scope: 'session', session_id: 'sA1' }], (item) => inPartitions(item, [{ scope: 'session', session_id: 'sA1' }]), 'session sA1')
  // User decision 8: a project's filter holds its session memories.
  check(libraryPartitions('tree:pA'), (item) => item.project_id === 'pA' && scopeOf(item) !== 'global', 'tree pA')
  // Every project (and their sessions), not loose sessions or global.
  check(libraryPartitions('projects'), (item) => scopeOf(item) !== 'global' && Boolean(item.project_id), 'projects')
  // A partition naming nothing matches nothing.
  assert.equal(store.listPage(SCOPE, { partitions: [] }).total, 0)
  assert.equal(store.listPage(SCOPE, { partitions: libraryPartitions('project:..%2Fx') }).total, 0)
  // With a search too.
  const both = store.listPage(SCOPE, { partitions: [{ scope: 'global' }], query: 'topic 3', limit: 1000 })
  assert.equal(both.total, all.filter((item) => scopeOf(item) === 'global' && item.memory.includes('topic 3')).length)
})

test('libraryIndexOf: the position in the same order and filter, -1 when it does not match', (t) => {
  const { store, all } = fixture(t)
  for (const id of ['m00000', 'm01234', 'm04999', 'm02500']) {
    const index = all.findIndex((item) => item.id === id)
    assert.equal(store.libraryIndexOf(id, SCOPE), index, id)
    assert.equal(store.libraryIndexOf(id, SCOPE, { order: 'oldest' }), all.length - 1 - index, `${id} oldest`)
    // The page it is on holds it.
    const offset = Math.floor(index / 20) * 20
    assert.ok(ids(store.listPage(SCOPE, { offset, limit: 20 }).results).includes(id))
  }
  const tree = libraryPartitions('tree:pA')
  const inTree = all.filter((item) => item.project_id === 'pA' && scopeOf(item) !== 'global')
  assert.equal(store.libraryIndexOf('m00017', SCOPE, { partitions: tree }), inTree.findIndex((item) => item.id === 'm00017'))
  assert.equal(store.libraryIndexOf('m00000', SCOPE, { partitions: tree }), -1, 'a global memory is not in a project')
  assert.equal(store.libraryIndexOf('m00003', SCOPE), -1, 'expired')
  assert.equal(store.libraryIndexOf('other-user', SCOPE), -1)
  assert.equal(store.libraryIndexOf('missing', SCOPE), -1)
})

test('speed: 5,000 memories page, search and filter in milliseconds', (t) => {
  const { store, insertMs } = fixture(t)
  const time = (fn, runs = 30) => {
    fn()
    const started = performance.now()
    for (let run = 0; run < runs; run += 1) fn()
    return (performance.now() - started) / runs
  }
  const timings = {
    firstPage: time(() => store.listPage(SCOPE, { offset: 0, limit: 20 })),
    lastPage: time(() => store.listPage(SCOPE, { offset: 4960, limit: 20, order: 'oldest' })),
    search: time(() => store.listPage(SCOPE, { query: 'topic 9', offset: 100, limit: 20 })),
    project: time(() => store.listPage(SCOPE, { partitions: libraryPartitions('tree:pA'), offset: 200, limit: 20 })),
    locate: time(() => store.libraryIndexOf('m00042', SCOPE)),
  }
  t.diagnostic(`insert ${TOTAL}: ${insertMs.toFixed(0)} ms; per call (ms): ${Object.entries(timings).map(([key, ms]) => `${key} ${ms.toFixed(2)}`).join(', ')}`)
  // Generous bounds for slow CI machines; locally each is a few ms.
  for (const [key, ms] of Object.entries(timings)) assert.ok(ms < 250, `${key} took ${ms.toFixed(1)} ms`)
})

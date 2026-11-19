// The local SQLite store (lib/store-sqlite.js). Every test uses a file in
// a temporary folder; the real ~/.dsh/mem0/memory.sqlite is never opened.
// No test is skipped on any platform: node:sqlite is required.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DEFAULT_STORE_PATH,
  RECENT_MESSAGES_LIMIT,
  SCHEMA_VERSION,
  SqliteStore,
  StoreError,
  displayPath,
  isExpired,
  loadSqlite,
  pyUtcNow,
  rowToItem,
  splitPayload,
  storeError,
} from '../lib/store-sqlite.js'

const STORE_MODULE = pathToFileURL(path.resolve('lib/store-sqlite.js')).href
const SCOPE = { user_id: 'dsh-mem0-store-test-user', agent_id: 'dsh-test' }

function tempStore(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-store-'))
  const filePath = path.join(dir, 'mem0', 'memory.sqlite')
  const stores = []
  const make = (extra = {}) => {
    const store = new SqliteStore({ filePath, ...options, ...extra })
    stores.push(store)
    return store
  }
  t.after(() => {
    for (const store of stores) store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, filePath, make }
}

function record(id, text, vector, payload = {}) {
  return { id, text, hash: `hash-${id}`, vector, payload: { ...SCOPE, ...payload }, embedModel: 'test-embed' }
}

test('node:sqlite is available on this platform (Node >= 24.9), never skipped', () => {
  const { DatabaseSync } = loadSqlite()
  assert.equal(typeof DatabaseSync, 'function')
  const [major, minor] = process.versions.node.split('.').map(Number)
  assert.ok(major > 24 || (major === 24 && minor >= 9), process.versions.node)
})

test('the default file is ~/.dsh/mem0/memory.sqlite inside the test HOME', () => {
  assert.equal(DEFAULT_STORE_PATH, path.join(os.homedir(), '.dsh', 'mem0', 'memory.sqlite'))
  assert.notEqual(DEFAULT_STORE_PATH, path.join(process.env.DSH_MEM0_TEST_REAL_HOME ?? '/nonexistent', '.dsh', 'mem0', 'memory.sqlite'))
})

test('displayPath shortens the home folder on Windows and POSIX paths', () => {
  assert.equal(displayPath('/home/me/.dsh/mem0/memory.sqlite', '/home/me'), '~/.dsh/mem0/memory.sqlite')
  assert.equal(displayPath('/srv/memory.sqlite', '/home/me'), '/srv/memory.sqlite')
  assert.equal(displayPath('C:\\Users\\me\\.dsh\\mem0\\memory.sqlite', 'C:\\Users\\me'), '~\\.dsh\\mem0\\memory.sqlite')
  assert.equal(displayPath('C:\\Users\\meme\\memory.sqlite', 'C:\\Users\\me'), 'C:\\Users\\meme\\memory.sqlite')
  // Paths built for either platform keep their own separators.
  assert.equal(path.win32.join('C:\\Users\\me', '.dsh', 'mem0', 'memory.sqlite'), 'C:\\Users\\me\\.dsh\\mem0\\memory.sqlite')
  assert.equal(path.posix.join('/Users/me', '.dsh', 'mem0', 'memory.sqlite'), '/Users/me/.dsh/mem0/memory.sqlite')
})

test('open creates the folder, the schema (P2/P3 columns included), WAL and the busy timeout', (t) => {
  const { filePath, make } = tempStore(t, { busyTimeoutMs: 1234 })
  const store = make().open()
  assert.ok(fs.existsSync(filePath))
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.equal(Number(store.db.prepare('PRAGMA busy_timeout').get().timeout), 1234)
  assert.equal(store.getMeta('schema_version'), String(SCHEMA_VERSION))
  const columns = store.db.prepare('PRAGMA table_info(memories)').all().map((row) => row.name)
  for (const column of ['importance', 'pinned', 'scope', 'project_id', 'session_id', 'kind', 'embed_model', 'embed_dims', 'embedding']) {
    assert.ok(columns.includes(column), column)
  }
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
  assert.ok(tables.includes('recent_messages'))
  if (process.platform !== 'win32') assert.equal(fs.statSync(filePath).mode & 0o777, 0o600)
  // Idempotent.
  assert.equal(store.open(), store)
})

test('insert, get, list (newest first, expired hidden), update keeps created_at, delete', (t) => {
  const { make } = tempStore(t)
  const store = make({ now: () => new Date('2026-11-20T10:00:00Z') }).open()
  store.insert([
    record('a', 'Likes green tea', [1, 0, 0], { created_at: '2026-11-01T00:00:00.000000+00:00', topic: 'drinks' }),
    record('b', 'Old fact', [0, 1, 0], { created_at: '2026-11-02T00:00:00.000000+00:00', expiration_date: '2026-11-10' }),
    record('c', 'Other user', [0, 0, 1], { user_id: 'someone-else' }),
  ])
  const a = store.get('a')
  assert.equal(a.memory, 'Likes green tea')
  assert.equal(a.user_id, SCOPE.user_id)
  assert.deepEqual(a.metadata, { topic: 'drinks' })
  assert.equal(a.created_at, '2026-11-01T00:00:00.000000+00:00')
  assert.equal(store.get('missing'), null)
  assert.deepEqual(store.list(SCOPE).map((item) => item.id), ['a'])
  assert.deepEqual(store.list(SCOPE, { showExpired: true }).map((item) => item.id), ['b', 'a'])
  assert.deepEqual(store.list({ ...SCOPE, topic: 'drinks' }).map((item) => item.id), ['a'])
  assert.equal(store.count(SCOPE), 2)
  assert.equal(store.count({}), 3)

  assert.equal(store.update('a', { text: 'Likes oolong', hash: 'h2', metadata: { user_id: 'hijack', mood: 'calm' }, vector: [0.9, 0.1, 0], updatedAt: '2026-11-20T10:00:00.000000+00:00' }), true)
  const updated = store.get('a')
  assert.equal(updated.memory, 'Likes oolong')
  assert.equal(updated.user_id, SCOPE.user_id, 'identity keys cannot be changed by update')
  assert.deepEqual(updated.metadata, { topic: 'drinks', mood: 'calm' })
  assert.equal(updated.created_at, '2026-11-01T00:00:00.000000+00:00')
  assert.equal(updated.updated_at, '2026-11-20T10:00:00.000000+00:00')
  assert.equal(store.update('missing', { text: 'x' }), false)

  assert.equal(store.delete('a'), true)
  assert.equal(store.delete('a'), false)
  assert.equal(store.get('a'), null)
  assert.equal(store.searchVectors([1, 0, 0], SCOPE, 5).some(({ row }) => row.id === 'a'), false)
})

test('search: cosine, entity filters, threshold, topK, other dimensions skipped', (t) => {
  const { make } = tempStore(t)
  const store = make().open()
  store.insert([
    record('tea', 'Likes tea', [1, 0, 0]),
    record('coffee', 'Hates coffee', [0.7, 0.7, 0]),
    record('far', 'Unrelated', [0, 0, 1]),
    record('other', 'Other user likes tea', [1, 0, 0], { user_id: 'someone-else' }),
    record('dims', 'Another embedder', [1, 0, 0, 0]),
  ])
  const results = store.search([1, 0, 0], SCOPE, { topK: 5, threshold: 0.1 })
  assert.deepEqual(results.map((item) => item.id), ['tea', 'coffee'])
  assert.ok(Math.abs(results[0].score - 1) < 1e-6)
  assert.ok(Math.abs(results[1].score - Math.SQRT1_2) < 1e-3)
  assert.deepEqual(store.search([1, 0, 0], SCOPE, { topK: 1 }).map((item) => item.id), ['tea'])
  // Raw search has no threshold.
  assert.deepEqual(store.searchVectors([1, 0, 0], SCOPE, 10).map(({ row }) => row.id), ['tea', 'coffee', 'far'])
  assert.equal(store.hasHash('hash-tea', SCOPE), true)
  assert.equal(store.hasHash('hash-tea', { user_id: 'nobody' }), false)
})

test('another connection\'s write is seen through data_version; our own writes update the cache', (t) => {
  const { make } = tempStore(t)
  const first = make().open()
  const second = make().open()
  first.insert([record('one', 'First', [1, 0, 0])])
  assert.equal(first.searchVectors([1, 0, 0], SCOPE, 5).length, 1)
  // second has not loaded its cache yet: loads it now.
  assert.equal(second.searchVectors([1, 0, 0], SCOPE, 5).length, 1)
  second.insert([record('two', 'Second', [0, 1, 0])])
  assert.deepEqual(first.searchVectors([0, 1, 0], SCOPE, 1).map(({ row }) => row.id), ['two'], 'first reloads after second\'s commit')
  first.delete('two')
  assert.deepEqual(second.searchVectors([0, 1, 0], SCOPE, 5).map(({ row }) => row.id), ['one'], 'second drops what first deleted')
})

test('a write from another process reaches this process\'s cache', (t) => {
  const { filePath, make } = tempStore(t)
  const store = make().open()
  store.insert([record('mine', 'Mine', [1, 0, 0])])
  assert.equal(store.searchVectors([0, 1, 0], SCOPE, 5).length, 1)
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { SqliteStore } = await import(${JSON.stringify(STORE_MODULE)})
    const other = new SqliteStore({ filePath: ${JSON.stringify(filePath)} }).open()
    other.insert([{ id: 'theirs', text: 'Theirs', hash: 'h', vector: [0, 1, 0], payload: ${JSON.stringify(SCOPE)} }])
    other.close()
  `], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(store.searchVectors([0, 1, 0], SCOPE, 1).map(({ row }) => row.id), ['theirs'])
})

test('a writer holding the database past the busy timeout gives code busy (vector_store)', (t) => {
  const { make } = tempStore(t)
  const holder = make().open()
  const waiter = make({ busyTimeoutMs: 50 }).open()
  holder.db.exec('BEGIN IMMEDIATE')
  try {
    const error = (() => {
      try {
        waiter.insert([record('x', 'X', [1, 0, 0])])
      } catch (caught) {
        return caught
      }
      return null
    })()
    assert.ok(error instanceof StoreError, String(error))
    assert.equal(error.code, 'busy')
    assert.equal(error.component, 'vector_store')
    assert.equal(error.provider, 'sqlite')
    assert.equal(error.step, 'store')
    assert.match(error.message, /memory\.sqlite/)
  } finally {
    holder.db.exec('ROLLBACK')
  }
  // Retried later, it works.
  waiter.insert([record('x', 'X', [1, 0, 0])])
  assert.equal(holder.count(SCOPE), 1)
})

test('a file that is not a database gives code corrupt', (t) => {
  const { filePath, make } = tempStore(t)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, 'this is not a sqlite database, just text '.repeat(200))
  const error = (() => {
    try {
      make().open()
    } catch (caught) {
      return caught
    }
    return null
  })()
  assert.ok(error instanceof StoreError, String(error))
  assert.equal(error.code, 'corrupt')
  assert.equal(error.component, 'vector_store')
})

test('a store written by a newer schema is a config error (schema_newer), never overwritten', (t) => {
  const { make } = tempStore(t)
  const store = make().open()
  store.setMeta('schema_version', String(SCHEMA_VERSION + 1))
  store.close()
  const error = (() => {
    try {
      make().open()
    } catch (caught) {
      return caught
    }
    return null
  })()
  assert.ok(error instanceof StoreError)
  assert.equal(error.code, 'schema_newer')
  assert.equal(error.configError, true)
})

test('node:sqlite and file-system errors map to busy, readonly, corrupt, disk_full, cantopen, ioerr', () => {
  const cases = [
    [{ errcode: 5 }, 'busy'],
    [{ errcode: 6 }, 'busy'],
    [{ errcode: 517 }, 'busy'], // SQLITE_BUSY_SNAPSHOT: extended codes use the low byte
    [{ errcode: 8 }, 'readonly'],
    [{ errcode: 3 }, 'readonly'],
    [{ errcode: 11 }, 'corrupt'],
    [{ errcode: 26 }, 'corrupt'],
    [{ errcode: 13 }, 'disk_full'],
    [{ errcode: 14 }, 'cantopen'],
    [{ errcode: 10 }, 'ioerr'],
    [{ code: 'EACCES' }, 'readonly'],
    [{ code: 'EPERM' }, 'readonly'],
    [{ code: 'ENOSPC' }, 'disk_full'],
    [{ message: 'database is locked' }, 'busy'],
    [{ errcode: 1 }, 'sqlite'],
  ]
  for (const [fields, code] of cases) {
    const error = storeError(Object.assign(new Error(fields.message ?? 'sqlite failed'), fields), { step: 'search', file: path.join(os.homedir(), 'x', 'memory.sqlite') })
    assert.equal(error.code, code, JSON.stringify(fields))
    assert.equal(error.step, 'search')
    assert.equal(error.endpoint.startsWith('~'), true)
  }
  const same = new StoreError('x', { code: 'busy' })
  assert.equal(storeError(same), same)
})

test('a read-only database file cannot be written: readonly (or cantopen), never a silent loss', (t) => {
  const { filePath, make } = tempStore(t)
  const store = make().open()
  store.insert([record('a', 'A', [1, 0, 0])])
  store.close()
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(`${filePath}${suffix}`)) fs.chmodSync(`${filePath}${suffix}`, 0o444)
  }
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.chmodSync(`${filePath}${suffix}`, 0o644)
      } catch {
        // gone already
      }
    }
  })
  const error = (() => {
    try {
      make().open().insert([record('b', 'B', [0, 1, 0])])
    } catch (caught) {
      return caught
    }
    return null
  })()
  assert.ok(error instanceof StoreError, `expected a StoreError, got ${error}`)
  assert.ok(['readonly', 'cantopen'].includes(error.code), error.code)
  assert.equal(error.component, 'vector_store')
})

test('recent messages: the last 10 per session scope, oldest first', (t) => {
  const { make } = tempStore(t)
  const store = make().open()
  for (let index = 0; index < 13; index += 1) store.saveMessages('user_id=u', [{ role: index % 2 ? 'assistant' : 'user', content: `m${index}` }])
  store.saveMessages('user_id=other', [{ role: 'user', content: 'elsewhere', name: 'bob' }])
  const last = store.lastMessages('user_id=u')
  assert.equal(RECENT_MESSAGES_LIMIT, 10)
  assert.equal(last.length, 10)
  assert.equal(last[0].content, 'm3')
  assert.equal(last.at(-1).content, 'm12')
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM recent_messages WHERE session_scope = 'user_id=u'").get().n, 10)
  assert.deepEqual(store.lastMessages('user_id=other').map((message) => message.name), ['bob'])
})

test('embedder info and replaceVectors (re-embedding)', (t) => {
  const { make } = tempStore(t)
  const store = make().open()
  assert.equal(store.embedderInfo(), undefined)
  store.setEmbedderInfo({ model: 'bge-m3', dims: 3 })
  assert.deepEqual(store.embedderInfo(), { model: 'bge-m3', dims: 3 })
  store.insert([record('a', 'A', [1, 0, 0]), record('b', 'B', [0, 1, 0])])
  store.replaceVectors([{ id: 'a', vector: [0, 0, 1, 0] }, { id: 'b', vector: [0, 1, 0, 0] }], { model: 'new-embed' })
  assert.deepEqual(store.searchVectors([0, 0, 1, 0], SCOPE, 1).map(({ row }) => row.id), ['a'])
  assert.equal(store.getRaw('a').embed_model, 'new-embed')
  assert.equal(store.getRaw('a').embed_dims, 4)
  assert.deepEqual(store.allTexts().map((row) => row.id).sort(), ['a', 'b'])
})

test('helpers: Python-style UTC timestamps, expiration, payload split, item shape', () => {
  const stamp = pyUtcNow(new Date('2026-11-20T01:02:03.456Z'))
  assert.match(stamp, /^2026-11-20T01:02:03\.456\d{3}\+00:00$/)
  assert.notEqual(pyUtcNow(new Date('2026-11-20T01:02:03.456Z')), stamp, 'two stamps in one millisecond differ')
  assert.equal(isExpired('2026-11-19', new Date('2026-11-20T00:00:00Z')), true)
  assert.equal(isExpired('2026-11-21', new Date('2026-11-20T00:00:00Z')), false)
  assert.equal(isExpired(null), false)
  const { columns, metadata } = splitPayload({ user_id: 'u', role: 'user', data: 'x', hash: 'h', created_at: 'c', topic: 't', empty: '' })
  assert.deepEqual(columns, { user_id: 'u', role: 'user' })
  assert.deepEqual(metadata, { topic: 't', empty: '' })
  const item = rowToItem({ id: 1, text: 'T', hash: 'h', user_id: 'u', agent_id: null, metadata_json: '{}', created_at: 'c', updated_at: 'u2' }, 0.5)
  assert.deepEqual(item, { id: '1', memory: 'T', hash: 'h', metadata: null, created_at: 'c', updated_at: 'u2', score: 0.5, user_id: 'u' })
})

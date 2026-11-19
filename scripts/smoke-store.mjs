#!/usr/bin/env node
/**
 * Smoke test of the local SQLite store, run by CI on every platform
 * (Windows included): open a store in a temporary directory, write, search,
 * see another process's write through data_version, reopen. Never touches
 * ~/.dsh: the file lives under the OS temp directory and is removed after.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { SqliteStore } = await import(pathToFileURL(path.join(ROOT, 'lib', 'store-sqlite.js')).href)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-smoke-'))
const file = path.join(dir, 'nested', 'memory.sqlite')
const scope = { user_id: 'smoke-user', agent_id: 'smoke-agent' }
try {
  const store = new SqliteStore({ filePath: file }).open()
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  store.setEmbedderInfo({ model: 'smoke', dims: 3 })
  store.insert([{ id: 'a', text: 'likes green tea', hash: 'h-a', vector: [1, 0, 0], payload: scope, embedModel: 'smoke' }])
  assert.equal(store.search([1, 0, 0], scope, { topK: 5 })[0]?.id, 'a')

  // A write from another process must reach this connection's cache.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { SqliteStore } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'lib', 'store-sqlite.js')).href)})
    const other = new SqliteStore({ filePath: ${JSON.stringify(file)} }).open()
    other.insert([{ id: 'b', text: 'uses Windows', hash: 'h-b', vector: [0, 1, 0], payload: ${JSON.stringify(scope)}, embedModel: 'smoke' }])
    other.close()
  `], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(store.search([0, 1, 0], scope, { topK: 1 })[0]?.id, 'b')
  assert.equal(store.count(scope), 2)
  store.close()

  const reopened = new SqliteStore({ filePath: file }).open()
  assert.deepEqual(reopened.embedderInfo(), { model: 'smoke', dims: 3 })
  assert.equal(reopened.count(scope), 2)
  reopened.close()
  console.log(`smoke-store ok: ${process.platform} ${process.arch} node ${process.version}`)
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

// Tests never touch the developer's ~/.dsh (fixtures/isolate-home.mjs), and
// the plugin never falls back to the shared ~/.dsh/mem0 folder for its own
// files when there is no profile directory.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_HISTORY_DB } from '../lib/config.js'
import { apply } from '../index.js'

function listFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out
}

test('the test process runs with an isolated HOME and DSH_HOME', () => {
  const home = process.env.DSH_MEM0_TEST_HOME
  assert.ok(home, 'run tests with `npm test` (node --import ./test/fixtures/isolate-home.mjs --test)')
  assert.equal(os.homedir(), home)
  assert.notEqual(os.homedir(), process.env.DSH_MEM0_TEST_REAL_HOME)
  assert.ok(home.startsWith(fs.realpathSync(os.tmpdir())) || home.startsWith(os.tmpdir()))
  assert.equal(process.env.DSH_HOME, path.join(home, '.dsh'))
  // The default history.db (and with it the old failures.json fallback) is
  // inside the temporary home, not the real ~/.dsh.
  assert.ok(DEFAULT_HISTORY_DB.startsWith(home))
})

test('without a profile directory nothing is written under ~/.dsh (failures, maintenance, sidecar.log)', async (t) => {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    throw Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
  }
  t.after(() => {
    globalThis.fetch = original
  })
  const listeners = new Map()
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    get: () => undefined, // no profileContext
    inject() {},
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    fiber: { restart: async () => {} },
    systemPrompt: { section: () => () => {} },
    tools: { register: () => () => {} },
  }
  t.after(() => {
    for (const dispose of disposers.splice(0)) dispose()
  })
  await apply(ctx, {
    backend: 'server',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'test',
    userId: 'dsh-mem0-isolation-test-user',
    hygieneEnabled: true,
  })
  // One completed turn → a capture that fails (connection refused) → the
  // failure history records it; maintenance ran at startup.
  const session = { id: 's1', header: {} }
  const emit = (event) => {
    for (const handler of listeners.get('session/event') ?? []) handler(session, event)
  }
  emit({ type: 'turn/start' })
  emit({ type: 'user/message', data: { source: { kind: 'user' }, content: 'Please remember: I always write release notes in English and Chinese, every time.' } })
  emit({ type: 'assistant/message', data: { message: { content: 'Noted, I will write release notes in both English and Chinese from now on.' } } })
  emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 200))
  const dsh = path.join(os.homedir(), '.dsh')
  assert.deepEqual(listFiles(dsh), [])
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, inject, name } from '../index.js'
import { PROFILE_SECTION_NAME } from '../lib/memory-lifecycle.js'

// A minimal stand-in for the Cordis context index.js uses.
function fakeContext({ services = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-index-'))
  const ctx = {
    dir,
    listeners: new Map(),
    injected: [],
    sections: [],
    tools: [],
    disposers: [],
    restarts: 0,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    get: (key) => (key === 'profileContext' ? { dir } : services[key]),
    inject(names, callback) {
      ctx.injected.push(names)
    },
    on(event, handler) {
      if (!ctx.listeners.has(event)) ctx.listeners.set(event, [])
      ctx.listeners.get(event).push(handler)
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') ctx.disposers.push(dispose)
    },
    fiber: {
      restart: async () => {
        ctx.restarts += 1
      },
    },
    systemPrompt: {
      section(section) {
        ctx.sections.push(section)
        return () => {}
      },
    },
  }
  ctx.tools = {
    registered: [],
    register(tool) {
      ctx.tools.registered.push(tool.name)
      return () => {}
    },
  }
  ctx.emit = (event, ...args) => {
    for (const handler of ctx.listeners.get(event) ?? []) handler(...args)
  }
  ctx.close = () => {
    for (const dispose of ctx.disposers.splice(0)) dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return ctx
}

// No test may reach a real Mem0 endpoint.
function blockNetwork(t) {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('network disabled in index.test.js')
  }
  t.after(() => {
    globalThis.fetch = original
  })
}

const PLATFORM = { backend: 'platform', apiKey: 'm0-test', userId: 'dsh-mem0-index-test-user', hygieneEnabled: false }

test('plugin metadata: name and required services', () => {
  assert.equal(name, 'dsh-mem0')
  assert.deepEqual(inject, ['tools', 'systemPrompt'])
})

test('enabled: false returns early but keeps routes and the settings restart hook', async (t) => {
  blockNetwork(t)
  const ctx = fakeContext()
  t.after(() => ctx.close())
  await apply(ctx, { ...PLATFORM, enabled: false })
  assert.deepEqual(ctx.tools.registered, [])
  assert.equal(ctx.sections.length, 0)
  assert.equal(ctx.listeners.has('session/event'), false)
  assert.equal(ctx.listeners.has('system-prompt/assemble'), false)
  assert.ok(ctx.injected.some((names) => names.includes('webServer')), 'GUI routes still registered')
  assert.equal(ctx.listeners.get('loader/volatile-update')?.length, 1)
  // Re-enabling from the settings page works without restarting DSH.
  ctx.emit('loader/volatile-update')
  assert.equal(ctx.restarts, 1)
})

test('a settings change (loader/volatile-update) restarts the plugin fiber', async (t) => {
  blockNetwork(t)
  const ctx = fakeContext()
  t.after(() => ctx.close())
  await apply(ctx, PLATFORM)
  ctx.emit('loader/volatile-update')
  ctx.emit('loader/volatile-update')
  assert.equal(ctx.restarts, 2)
})

test('the default config registers tools, guidance, summary section, recall and capture', async (t) => {
  blockNetwork(t)
  const ctx = fakeContext()
  t.after(() => ctx.close())
  await apply(ctx, PLATFORM)
  assert.deepEqual([...ctx.tools.registered].sort(), [
    'mem0_add', 'mem0_delete', 'mem0_get', 'mem0_pin', 'mem0_profile_get', 'mem0_profile_reset',
    'mem0_profile_update', 'mem0_search', 'mem0_status', 'mem0_update',
  ])
  assert.deepEqual(ctx.sections.map((section) => section.name), ['plugin:dsh-mem0', PROFILE_SECTION_NAME])
  assert.equal(ctx.listeners.get('system-prompt/assemble')?.length, 1)
  assert.equal(ctx.listeners.get('session/event')?.length, 1)
})

test('config composition: recall without capture still subscribes to turn events (I1)', async (t) => {
  blockNetwork(t)
  const ctx = fakeContext()
  t.after(() => ctx.close())
  await apply(ctx, { ...PLATFORM, autoCapture: false })
  assert.equal(ctx.listeners.get('session/event')?.length, 1)
  assert.equal(ctx.listeners.get('system-prompt/assemble')?.length, 1)
  // Turn-1 recall: the current question arrives via the inbox claim.
  assert.equal(ctx.listeners.get('agent/inbox/claimed')?.length, 1)
})

test('config composition: capture without recall has no summary section or recall hook', async (t) => {
  blockNetwork(t)
  const ctx = fakeContext()
  t.after(() => ctx.close())
  await apply(ctx, { ...PLATFORM, autoRecall: false })
  assert.equal(ctx.listeners.get('session/event')?.length, 1)
  assert.equal(ctx.listeners.has('system-prompt/assemble'), false)
  assert.equal(ctx.listeners.has('agent/inbox/claimed'), false)
  assert.equal(ctx.sections.some((section) => section.name === PROFILE_SECTION_NAME), false)
})

test('config composition: neither recall nor capture means no session listener; announceToAgent: false drops the guidance', async (t) => {
  blockNetwork(t)
  const ctx = fakeContext()
  t.after(() => ctx.close())
  await apply(ctx, { ...PLATFORM, autoRecall: false, autoCapture: false, announceToAgent: false })
  assert.equal(ctx.listeners.has('session/event'), false)
  assert.equal(ctx.sections.length, 0)
  assert.ok(ctx.tools.registered.length > 0, 'tools stay available')
})

test('backend auto asks DSH credentials for apiKeyEnv and restarts when that credential changes (G12)', async (t) => {
  blockNetwork(t)
  const asked = []
  const credentials = {
    resolve: async (ref) => {
      asked.push(ref)
      return { value: 'm0-stored', source: 'file' }
    },
  }
  const ctx = fakeContext({ services: { credentials } })
  t.after(() => ctx.close())
  await apply(ctx, { apiKeyEnv: 'DSH_MEM0_INDEX_TEST_KEY', userId: 'dsh-mem0-index-test-user', hygieneEnabled: false })
  // Once at startup (backend choice); REST requests ask again on their own.
  assert.equal(asked[0], 'DSH_MEM0_INDEX_TEST_KEY')
  assert.ok(asked.every((ref) => ref === 'DSH_MEM0_INDEX_TEST_KEY'))
  ctx.emit('credentials/reference-updated', 'SOME_OTHER_KEY')
  assert.equal(ctx.restarts, 0)
  ctx.emit('credentials/reference-updated', 'DSH_MEM0_INDEX_TEST_KEY')
  assert.equal(ctx.restarts, 1)
})

test('a literal apiKey skips the credential service and its restart hook', async (t) => {
  blockNetwork(t)
  let asked = 0
  const ctx = fakeContext({ services: { credentials: { resolve: async () => ((asked += 1), undefined) } } })
  t.after(() => ctx.close())
  await apply(ctx, PLATFORM)
  assert.equal(asked, 0)
  assert.equal(ctx.listeners.has('credentials/reference-updated'), false)
})

test('oss: an upgraded profile with pythonPath and other sidecar settings starts the native backend with a debug note, no warning', async (t) => {
  blockNetwork(t)
  const ctx = fakeContext()
  const debug = []
  const warn = []
  ctx.logger = { info() {}, warn: (line) => warn.push(line), debug: (line) => debug.push(line), error() {} }
  t.after(() => ctx.close())
  const storePath = path.join(ctx.dir, 'store', 'memory.sqlite')
  // A fingerprint written by 0.3.x, when the profile set the sidecar's fields.
  fs.mkdirSync(path.join(ctx.dir, 'dsh-mem0'), { recursive: true })
  fs.writeFileSync(path.join(ctx.dir, 'dsh-mem0', 'config-fingerprint.json'), JSON.stringify({
    version: 1,
    savedAt: '2026-11-01T00:00:00.000Z',
    fields: ['backend', 'historyDbPath', 'mem0ConfigPath', 'pythonPath', 'userId'],
  }))
  await apply(ctx, {
    backend: 'oss',
    userId: 'dsh-mem0-index-test-user',
    hygieneEnabled: false,
    storePath,
    embedderBaseUrl: 'http://127.0.0.1:9/v1',
    embedderModel: 'test-embed',
    pythonPath: '/old/venv/bin/python',
    mem0ConfigPath: '~/.dsh/mem0/oss.json',
    historyDbPath: '/old/history.db',
    sidecarEnv: ['OPENAI_API_KEY'],
  })
  assert.ok(debug.some((line) => /ignoring settings of the removed Python sidecar: pythonPath, mem0ConfigPath, historyDbPath, sidecarEnv/.test(line)), debug.join('\n'))
  assert.equal(warn.some((line) => /settings look rewritten/.test(line)), false, warn.join('\n'))
  assert.ok(ctx.tools.registered.includes('mem0_status'))
  // The store opens in the background, in the configured temporary folder.
  for (let index = 0; index < 50 && !fs.existsSync(storePath); index += 1) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(fs.existsSync(storePath))
  const fingerprint = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'dsh-mem0', 'config-fingerprint.json'), 'utf8'))
  assert.equal(fingerprint.fields.includes('pythonPath'), false, 'retired names are dropped once the store opened')
  assert.ok(fingerprint.fields.includes('storePath'))
  // DSH's model service is injected for background calls (translation).
  assert.ok(ctx.injected.some((names) => names.includes('llm') && names.includes('agentDefaultModel')))
})

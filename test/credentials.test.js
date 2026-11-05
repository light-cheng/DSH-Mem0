import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, describeBackendChoice } from '../lib/config.js'
import { lookupApiKey } from '../lib/credentials.js'
import { Mem0RestClient } from '../lib/rest-client.js'

function ctxWith(service) {
  return { get: (name) => (name === 'credentials' ? service : undefined) }
}

function withEnv(name, value, fn) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

test('lookupApiKey resolves apiKeyEnv through ctx.credentials (G12)', async () => {
  const asked = []
  const service = { resolve: async (ref) => (asked.push(ref), { value: 'm0-stored', source: 'file' }) }
  assert.deepEqual(await lookupApiKey(ctxWith(service), { apiKeyEnv: 'MY_MEM0_KEY' }), { value: 'm0-stored', source: 'file' })
  assert.deepEqual(asked, ['MY_MEM0_KEY'])
})

test('lookupApiKey skips the service for a literal apiKey and tolerates missing or failing services', async () => {
  let called = false
  const service = { resolve: async () => ((called = true), { value: 'x', source: 'file' }) }
  assert.equal(await lookupApiKey(ctxWith(service), { apiKey: 'literal' }), undefined)
  assert.equal(called, false)
  assert.equal(await lookupApiKey(ctxWith(undefined), {}), undefined)
  assert.equal(await lookupApiKey({}, {}), undefined)
  assert.equal(await lookupApiKey(ctxWith({ resolve: async () => { throw new Error('boom') } }), {}), undefined)
  assert.equal(await lookupApiKey(ctxWith({ resolve: async () => undefined }), {}), undefined)
  assert.equal(await lookupApiKey(ctxWith({ resolve: () => new Promise(() => {}) }), {}, { timeoutMs: 20 }), undefined)
  assert.equal(await lookupApiKey(ctxWith(service), { apiKeyEnv: 'not a name' }), undefined)
})

test('config key precedence: literal apiKey, then DSH credentials, then process.env (G12)', () => {
  withEnv('MEM0_API_KEY', 'm0-env', () => {
    const literal = resolveConfig({ apiKey: 'm0-literal' }, { credential: { value: 'm0-stored', source: 'file' } })
    assert.equal(literal.apiKey, 'm0-literal')
    assert.equal(literal.apiKeySource, 'config')
    assert.equal(literal.backendSource, 'auto-api-key')

    const stored = resolveConfig({}, { credential: { value: 'm0-stored', source: 'file' } })
    assert.equal(stored.apiKey, 'm0-stored')
    assert.equal(stored.apiKeySource, 'credentials')
    assert.equal(stored.backend, 'platform')
    assert.equal(stored.backendSource, 'auto-api-key-credentials')
    assert.match(describeBackendChoice(stored), /stored in DSH credentials/)

    // The credential service's own environment fallback still reports 'env'.
    const viaServiceEnv = resolveConfig({}, { credential: { value: 'm0-env', source: 'env' } })
    assert.equal(viaServiceEnv.apiKeySource, 'env')
    assert.equal(viaServiceEnv.backendSource, 'auto-api-key-env')

    // No credential service: process.env as before.
    const envOnly = resolveConfig({})
    assert.equal(envOnly.apiKey, 'm0-env')
    assert.equal(envOnly.apiKeySource, 'env')
  })
  withEnv('MEM0_API_KEY', undefined, () => {
    assert.equal(resolveConfig({ backend: 'platform' }).apiKeySource, 'none')
  })
})

test('REST client asks resolveApiKey before each request, falling back to the startup key (G12)', async (t) => {
  const seen = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    seen.push(init.headers.authorization)
    return new Response('[]', { status: 200 })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  let current = 'm0-first'
  const client = new Mem0RestClient({
    mode: 'platform',
    baseUrl: 'https://api.mem0.ai',
    apiKey: 'm0-startup',
    resolveApiKey: async () => current,
    userId: 'u',
  })
  await client.list({ user_id: 'u' })
  current = 'm0-rotated'
  await client.list({ user_id: 'u' })
  current = undefined
  await client.list({ user_id: 'u' })
  assert.deepEqual(seen, ['Token m0-first', 'Token m0-rotated', 'Token m0-startup'])
})

test('mem0_status names the key source without printing the key', async () => {
  const { createMem0Tools } = await import('../lib/tools.js')
  const config = resolveConfig({}, { credential: { value: 'm0-secret-value', source: 'file' } })
  const client = { health: async () => ({ ok: true, backend: 'platform', baseUrl: 'https://api.mem0.ai' }) }
  const status = createMem0Tools(client, config).find((tool) => tool.name === 'mem0_status')
  const text = await status.execute({}, {})
  assert.match(text, /key source: credentials/)
  assert.doesNotMatch(text, /m0-secret-value/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { createMem0Tools } from '../lib/tools.js'

function toolMap(client, maintenance, extra = {}) {
  const config = {
    backend: 'platform',
    collectionName: 'dsh_mem0',
    userId: 'dsh-user',
    agentId: 'dsh',
    baseUrl: 'https://api.mem0.ai',
    ...(extra.config ?? {}),
  }
  return new Map(createMem0Tools(client, config, { maintenance, localizer: extra.localizer }).map((tool) => [tool.name, tool]))
}

function fakeClient(overrides = {}) {
  const calls = []
  return {
    calls,
    async search(...args) {
      calls.push(['search', ...args])
      return { results: [{ id: 'm1', memory: 'Likes tea', score: 0.9, user_id: 'dsh-user' }] }
    },
    async add(...args) {
      calls.push(['add', ...args])
      return { results: [{ id: 'm2', memory: 'Fact', event: 'ADD' }] }
    },
    async list(...args) {
      calls.push(['list', ...args])
      return { results: [{ id: 'm1', memory: 'Likes tea', user_id: 'dsh-user' }] }
    },
    async get(...args) {
      calls.push(['get', ...args])
      return { id: 'm1', memory: 'Likes tea', user_id: 'dsh-user' }
    },
    async update(...args) {
      calls.push(['update', ...args])
      return { message: 'Memory updated successfully!' }
    },
    async remove(...args) {
      calls.push(['remove', ...args])
      return { message: 'Memory deleted successfully!' }
    },
    async health(...args) {
      calls.push(['health', ...args])
      return {
        ok: true,
        backend: 'platform',
        baseUrl: 'https://api.mem0.ai',
        collection: 'dsh_mem0',
        userId: 'dsh-user',
        agentId: 'dsh',
        pythonVersion: '3.11.16',
        mem0Version: '2.0.10',
        qdrant: { ok: true },
        embedder: { ok: true, dimensions: 1024 },
      }
    },
    ...overrides,
  }
}

test('registers the memory tools with the expected names', () => {
  const tools = toolMap(fakeClient())
  assert.deepEqual([...tools.keys()].sort(), [
    'mem0_add',
    'mem0_delete',
    'mem0_get',
    'mem0_profile_get',
    'mem0_profile_reset',
    'mem0_profile_update',
    'mem0_search',
    'mem0_status',
    'mem0_update',
  ])
})

test('mem0_search scopes to the configured user and formats results', async () => {
  const client = fakeClient()
  const result = await toolMap(client).get('mem0_search').execute({ query: 'drink', top_k: 3 }, {})
  assert.match(result, /\[mem0:m1\] Likes tea/)
  assert.equal(client.calls[0][0], 'search')
  assert.deepEqual(client.calls[0][2], { user_id: 'dsh-user' })
  assert.equal(client.calls[0][3].topK, 3)
})

test('mem0_add stores verbatim and redacts credentials', async () => {
  const client = fakeClient()
  const result = await toolMap(client).get('mem0_add').execute({ content: 'api_key=supersecret' }, {})
  assert.match(result, /Stored 1 memory/)
  assert.equal(client.calls[0][0], 'add')
  assert.equal(client.calls[0][1][0].content, 'api_key=[REDACTED]')
  assert.equal(client.calls[0][2].infer, false)
})

test('mem0_update rejects a memory owned by another user', async () => {
  const client = fakeClient({
    async get() {
      return { id: 'm1', memory: 'Other', user_id: 'somebody-else' }
    },
  })
  const result = await toolMap(client).get('mem0_update').execute(
    { memory_id: 'm1', text: 'new text' },
    {},
  )
  assert.match(result, /does not belong to user dsh-user/)
})

test('mem0_delete removes an owned memory', async () => {
  const client = fakeClient()
  const result = await toolMap(client).get('mem0_delete').execute({ memory_id: 'm1' }, {})
  assert.match(result, /Deleted memory m1/)
  assert.equal(client.calls.at(-1)[0], 'remove')
})

test('mem0_delete drops cached translations of the deleted memory', async () => {
  const client = fakeClient()
  const forgotten = []
  const localizer = { forget: (texts) => forgotten.push(...texts) }
  await toolMap(client, undefined, { localizer }).get('mem0_delete').execute({ memory_id: 'm1' }, {})
  assert.deepEqual(forgotten, ['Likes tea'])
})

test('mem0_status says when an environment API key chose the Platform', async () => {
  const client = fakeClient()
  const result = await toolMap(client, undefined, {
    config: { backendSource: 'auto-api-key-env', apiKeyEnv: 'MEM0_API_KEY' },
  }).get('mem0_status').execute({}, {})
  assert.match(result, /backend choice: auto: MEM0_API_KEY is set in the environment/)
  assert.match(result, /api\.mem0\.ai/)
})

test('mem0_status reports the sidecar health without secrets', async () => {
  const client = fakeClient()
  const result = await toolMap(client).get('mem0_status').execute({}, {})
  assert.match(result, /backend: platform/)
  assert.match(result, /status: ready/)
  assert.match(result, /mem0: 2\.0\.10/)
  assert.match(result, /embedder: ok \(1024 dims\)/)
  assert.doesNotMatch(result, /api.?key/i)
})

test('all tools return a readable failure instead of throwing', async () => {
  const client = fakeClient({
    async search() {
      throw new Error('backend down')
    },
  })
  const result = await toolMap(client).get('mem0_search').execute({ query: 'x' }, {})
  assert.match(result, /mem0_search failed: backend down/)
})

test('profile tools read, update and reset editable memory summary', async () => {
  let text = '- Likes tea'
  const maintenance = {
    profileBlock: () => text,
    setProfileText: (value) => {
      text = String(value)
      return { profile: { items: text ? text.split('\n').length : 0, tokens: 12 } }
    },
    resetProfile: async () => {
      text = '- Rebuilt from memories'
      return { profile: { items: 1, tokens: 20 } }
    },
  }
  const tools = toolMap(fakeClient(), maintenance)
  assert.match(await tools.get('mem0_profile_get').execute({}, {}), /Likes tea/)
  assert.match(
    await tools.get('mem0_profile_update').execute({ text: '- Likes coffee' }, {}),
    /Updated memory summary/,
  )
  assert.equal(text, '- Likes coffee')
  assert.match(await tools.get('mem0_profile_reset').execute({}, {}), /Rebuilt memory summary/)
  assert.equal(text, '- Rebuilt from memories')
})

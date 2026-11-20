// The native local backend (lib/native-client.js) with mocked embedder and
// LLM endpoints (no network) and a SQLite file in a temporary folder.
// Test user ids only; the real ~/.dsh/mem0/memory.sqlite is never opened.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Mem0NativeClient, md5, sessionScope } from '../lib/native-client.js'
import { SqliteStore } from '../lib/store-sqlite.js'
import { resolveNativeSettings } from '../lib/oss-config.js'
import { classifyFailure, attributeFailure, FailureHistory } from '../lib/failure-history.js'
import { retryMaxTokens } from '../lib/memory-lifecycle.js'

const USER = 'dsh-mem0-native-test-user'
const AGENT = 'dsh-test'
const VOCAB = ['tea', 'coffee', 'green', 'release', 'notes', 'english', 'chinese', 'pnpm', 'falcon', 'morning', '茶', '发布']

/** Deterministic bag-of-words vectors, so similar texts score high. */
function embedText(text, dims = VOCAB.length + 1) {
  const lower = String(text).toLowerCase()
  const vector = VOCAB.map((word) => (lower.includes(word) ? 1 : 0))
  vector.push(0.05)
  while (vector.length < dims) vector.push(0)
  return vector.slice(0, dims)
}

function setup(t, { llm, dims, embedModel = 'test-embed', provider = 'openai', apiKeyRef = '', llmKeyRef = '', secrets = {}, storePath, embedGate, logger, resolveSecret } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-native-'))
  const file = storePath ?? path.join(dir, 'memory.sqlite')
  const calls = { embed: [], llm: [] }
  const settings = {
    storePath: file,
    embedder: { provider, baseUrl: provider === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:18000/v1', model: embedModel, dims: undefined, apiKeyRef, apiKey: '' },
    llm: { baseUrl: 'http://127.0.0.1:13425/v1', model: 'test-llm', apiKeyRef: llmKeyRef, apiKey: '', maxTokens: 8000, temperature: 0, topP: 0.1, reasoningEffort: '' },
    problems: [],
  }
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    const headers = init.headers
    if (url.endsWith('/embeddings') || url.endsWith('/api/embed')) {
      calls.embed.push({ url, body, headers })
      // Tests hold an embedding back; a timeout or abort still ends it.
      if (embedGate) {
        await new Promise((resolve, reject) => {
          const done = embedGate(body, calls.embed.length)
          init.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')), { once: true })
          Promise.resolve(done).then(resolve, reject)
        })
      }
      const vectors = body.input.map((text) => embedText(text, dims))
      const payload = url.endsWith('/api/embed') ? { embeddings: vectors } : { data: vectors.map((embedding, index) => ({ index, embedding })) }
      return new Response(JSON.stringify(payload), { status: 200 })
    }
    if (url.endsWith('/chat/completions')) {
      calls.llm.push({ url, body, headers, startedAt: Date.now() })
      const answer = await (llm ?? (() => ({ content: '{"memory": []}' })))(body, calls.llm.length)
      const response = {
        choices: [{ message: { content: answer.content }, finish_reason: answer.finishReason ?? 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: answer.completionTokens ?? 20 },
      }
      return new Response(JSON.stringify(response), { status: answer.status ?? 200 })
    }
    throw new Error(`unexpected url ${url}`)
  }
  const client = new Mem0NativeClient({
    config: { backend: 'oss', userId: USER, agentId: AGENT },
    loadSettings: () => settings,
    resolveSecret: resolveSecret ?? (async (ref) => secrets[ref]),
    fetchImpl,
    logger,
  })
  t.after(async () => {
    await client.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { client, calls, settings, file, dir }
}

const facts = (...texts) => JSON.stringify({ memory: texts.map((text) => ({ id: '0', text, attributed_to: 'user' })) })

test('sessionScope and md5 follow mem0 2.2.1', () => {
  assert.equal(sessionScope({ user_id: 'u', agent_id: 'a', run_id: 'r' }), 'agent_id=a&run_id=r&user_id=u')
  assert.equal(sessionScope({ user_id: 'a&b=c%d' }), 'user_id=a%26b%3Dc%25d')
  assert.equal(sessionScope({ user_id: 'u', agent_id: '' }), 'user_id=u')
  assert.equal(md5('Likes tea'), 'ed0d2a668f61805c737f938e64f1961d')
  assert.equal(md5('中文'), 'a7bac2239fcdcb3a067903d8077c4a07')
  assert.match(md5('x'), /^[0-9a-f]{32}$/)
})

test('infer:false stores each message verbatim; search, list, get, update, remove', async (t) => {
  const { client, calls } = setup(t)
  const added = await client.add([{ role: 'user', content: 'I drink green tea every morning' }, { role: 'system', content: 'skip me' }], { infer: false, metadata: { source: 'test', user_id: 'hijack' } })
  assert.equal(added.results.length, 1)
  assert.equal(added.results[0].event, 'ADD')
  assert.equal(calls.llm.length, 0)
  const id = added.results[0].id
  const item = await client.get(id)
  assert.equal(item.memory, 'I drink green tea every morning')
  assert.equal(item.user_id, USER, 'metadata cannot override the identity')
  assert.equal(item.role, 'user')
  assert.deepEqual(item.metadata, { source: 'test' })
  const found = await client.search('green tea', { user_id: USER })
  assert.equal(found.results[0].id, id)
  assert.ok(found.results[0].score > 0.5)
  assert.equal((await client.list({ user_id: USER })).results.length, 1)
  assert.deepEqual(await client.update(id, { text: 'Drinks oolong now' }), { message: 'Memory updated successfully!' })
  assert.equal((await client.get(id)).memory, 'Drinks oolong now')
  assert.deepEqual(await client.remove(id), { message: 'Memory deleted successfully!' })
  assert.equal(await client.get(id), null)
  const missing = await client.remove(id).catch((error) => error)
  assert.equal(missing.status, 404)
  assert.equal(missing.code, 'NOT_FOUND')
})

test('infer:true sends mem0\'s request and stores only new facts (md5 dedup against similar memories and within the batch)', async (t) => {
  const { client, calls } = setup(t, {
    llm: (_body, index) => ({
      content: index === 1
        ? facts('User drinks green tea every morning')
        : facts('User drinks green tea every morning', 'User writes release notes in English and Chinese', 'User writes release notes in English and Chinese', ''),
    }),
  })
  const first = await client.add([{ role: 'user', content: 'I drink green tea every morning' }, { role: 'assistant', content: 'Noted.' }])
  assert.deepEqual(first.summary, { facts: 1, add: 1, update: 0, delete: 0, none: 0, skippedDuplicate: 0, skippedSimilar: 0 })
  const request = calls.llm[0].body
  assert.equal(request.model, 'test-llm')
  assert.equal(request.temperature, 0)
  assert.equal(request.top_p, 0.1)
  assert.equal(request.max_tokens, 8000)
  assert.deepEqual(request.response_format, { type: 'json_object' })
  assert.equal(request.messages[0].role, 'system')
  assert.match(request.messages[0].content, /# ROLE/)
  assert.match(request.messages[1].content, /## New Messages\nuser: I drink green tea every morning\nassistant: Noted\.\n/)
  assert.match(request.messages[1].content, /## Language Requirement/)
  assert.match(request.messages[1].content, /## Existing Memories\n\[\]/)

  const second = await client.add([{ role: 'user', content: 'Tea again; and I write release notes in English and Chinese' }])
  // Existing memories are sent with ids mapped to "0", "1", … and the last
  // messages of this scope are part of the prompt.
  const prompt = calls.llm[1].body.messages[1].content
  assert.match(prompt, /## Existing Memories\n\[\{"id": "0", "text": "User drinks green tea every morning"\}\]/)
  assert.match(prompt, /## Last k Messages\nuser: I drink green tea every morning\nassistant: Noted\.\n/)
  assert.deepEqual(second.summary, { facts: 4, add: 1, update: 0, delete: 0, none: 3, skippedDuplicate: 2, skippedSimilar: 0 })
  const all = await client.list({ user_id: USER })
  assert.deepEqual(all.results.map((item) => item.memory).sort(), ['User drinks green tea every morning', 'User writes release notes in English and Chinese'])
  assert.equal(all.results.find((item) => item.memory.includes('release')).attributed_to, 'user')
})

test('adds to one scope run one after another; other scopes are not held up', async (t) => {
  let active = 0
  let maxActive = 0
  const { client, calls } = setup(t, {
    llm: async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 30))
      active -= 1
      return { content: '{"memory": []}' }
    },
  })
  await Promise.all([
    client.add([{ role: 'user', content: 'one' }]),
    client.add([{ role: 'user', content: 'two' }]),
    client.add([{ role: 'user', content: 'three' }]),
  ])
  assert.equal(maxActive, 1)
  assert.equal(calls.llm.length, 3)
  // The second add saw the first one's messages.
  assert.match(calls.llm[1].body.messages[1].content, /## Last k Messages\nuser: one\n/)
  active = 0
  maxActive = 0
  await Promise.all([
    client.add([{ role: 'user', content: 'a' }], { userId: 'dsh-mem0-native-test-user-2' }),
    client.add([{ role: 'user', content: 'b' }], { userId: 'dsh-mem0-native-test-user-3' }),
  ])
  assert.equal(maxActive, 2)
})

test('a cut-off answer: LLM_EXTRACT_FAILED/truncated with stats, the turn not remembered, the retry doubles max_tokens', async (t) => {
  const { client, calls } = setup(t, {
    llm: (body) => (body.max_tokens === 8000
      ? { content: '{"memory": [{"text": "User likes', finishReason: 'length', completionTokens: 8000 }
      : { content: facts('User likes tea') }),
  })
  const error = await client.add([{ role: 'user', content: 'I like tea' }]).catch((value) => value)
  assert.equal(error.code, 'LLM_EXTRACT_FAILED')
  assert.equal(error.status, 502)
  assert.equal(error.component, 'llm')
  assert.equal(error.step, 'llm_extract')
  assert.equal(error.extractReason, 'truncated')
  assert.equal(error.retryable, true)
  assert.deepEqual(error.extractStats, { maxTokens: 8000, finishReason: 'length', promptTokens: 100, completionTokens: 8000 })
  assert.equal(classifyFailure(error), 'extraction')
  assert.equal(attributeFailure(error, { backend: 'oss' }).component, 'llm')
  const entry = new FailureHistory({ backend: 'oss' }).record({ kind: 'capture', error })
  assert.equal(entry.reason, 'truncated')
  assert.equal(entry.extract.finishReason, 'length')
  assert.equal(client.status().lastExtraction.finishReason, 'length')

  const doubled = retryMaxTokens(error)
  assert.equal(doubled, 16000)
  const retried = await client.add([{ role: 'user', content: 'I like tea' }], { llmMaxTokens: doubled })
  assert.equal(calls.llm[1].body.max_tokens, 16000)
  assert.equal(retried.summary.add, 1)
  // The failed attempt left no trace in the prompt of the retry.
  assert.match(calls.llm[1].body.messages[1].content, /## Last k Messages\n\n/)
})

test('a refusal is not retried and the turn is remembered; not-JSON and empty answers are retryable', async (t) => {
  const answers = ["I'm sorry, I can't help with that.", 'here are facts but no json', '   ']
  const { client, calls } = setup(t, { llm: (_body, index) => ({ content: answers[index - 1] ?? '{"memory": []}' }) })
  const refusal = await client.add([{ role: 'user', content: 'first' }]).catch((value) => value)
  assert.equal(refusal.extractReason, 'refusal')
  assert.equal(refusal.retryable, false)
  const notJson = await client.add([{ role: 'user', content: 'second' }]).catch((value) => value)
  assert.equal(notJson.extractReason, 'not_json')
  assert.equal(notJson.retryable, true)
  const empty = await client.add([{ role: 'user', content: 'third' }]).catch((value) => value)
  assert.equal(empty.extractReason, 'empty')
  await client.add([{ role: 'user', content: 'fourth' }])
  const last = calls.llm[3].body.messages[1].content
  assert.match(last, /user: first\n/, 'the refused turn is remembered')
  assert.doesNotMatch(last, /user: second|user: third/, 'retryable failures are not')
})

test('an LLM that answers HTTP 429 is an llm auth failure with its endpoint', async (t) => {
  const { client } = setup(t, { llm: () => ({ status: 429, content: '' }) })
  const error = await client.add([{ role: 'user', content: 'x' }]).catch((value) => value)
  assert.equal(error.status, 429)
  assert.equal(classifyFailure(error), 'auth')
  assert.deepEqual(attributeFailure(error, { backend: 'oss' }), { component: 'llm', step: 'llm_extract', provider: 'openai', endpoint: '127.0.0.1:13425' })
})

test('keys come from the credential lookup by reference name, never into messages', async (t) => {
  const { client, calls } = setup(t, {
    apiKeyRef: 'DSH_MEM0_TEST_EMBED_KEY',
    llmKeyRef: 'DSH_MEM0_TEST_LLM_KEY',
    secrets: { DSH_MEM0_TEST_EMBED_KEY: 'sk-embed-secret-1', DSH_MEM0_TEST_LLM_KEY: 'sk-llm-secret-2' },
    llm: () => ({ content: facts('User likes tea') }),
  })
  await client.add([{ role: 'user', content: 'I like tea' }])
  assert.equal(calls.embed[0].headers.authorization, 'Bearer sk-embed-secret-1')
  assert.equal(calls.llm[0].headers.authorization, 'Bearer sk-llm-secret-2')
  const health = await client.health()
  assert.equal(JSON.stringify(health).includes('sk-'), false)
  assert.equal(JSON.stringify(client.status()).includes('sk-'), false)
})

test('openai embedder: newlines become spaces; ollama embedder uses /api/embed', async (t) => {
  const openai = setup(t)
  await openai.client.add([{ role: 'user', content: 'line one\nline two' }], { infer: false })
  assert.deepEqual(openai.calls.embed[0].body.input, ['line one line two'])
  assert.ok(openai.calls.embed[0].url.endsWith('/v1/embeddings'))
  const ollama = setup(t, { provider: 'ollama' })
  await ollama.client.add([{ role: 'user', content: 'line one\nline two' }], { infer: false })
  assert.equal(ollama.calls.embed[0].url, 'http://127.0.0.1:11434/api/embed')
  assert.deepEqual(ollama.calls.embed[0].body.input, ['line one\nline two'])
})

test('another embedder than the one in the store is a clear config error; an empty store just takes the new one', async (t) => {
  const first = setup(t)
  await first.client.add([{ role: 'user', content: 'tea' }], { infer: false })
  await first.client.dispose()
  const store = new SqliteStore({ filePath: first.file }).open()
  assert.deepEqual(store.embedderInfo(), { model: 'test-embed', dims: VOCAB.length + 1 })
  store.close()

  const switched = setup(t, { storePath: first.file, embedModel: 'other-embed', dims: 8 })
  const error = await switched.client.search('tea', { user_id: USER }).catch((value) => value)
  assert.equal(error.code, 'EMBEDDER_MISMATCH')
  assert.equal(error.component, 'embedder')
  assert.match(error.message, /test-embed \(13 dims\).*other-embed/)
  // The store's meta is compared first: a mismatch costs no embedding call.
  assert.equal(switched.calls.embed.length, 0)
  assert.equal(classifyFailure(error), 'config')
  const health = await switched.client.health()
  assert.equal(health.ok, false)
  assert.match(health.embedder.error, /EMBEDDER|holds vectors of embedder test-embed/)

  // Re-embedding makes the store follow the new embedder.
  const result = await switched.client.reembed()
  assert.deepEqual(result, { updated: 1, model: 'other-embed', dims: 8 })
  assert.equal((await switched.client.search('tea', { user_id: USER })).results.length, 1)
  // switched uses first's file: close it before first's folder is removed.
  await switched.client.dispose()

  // An empty store with old embedder info: the new embedder takes over.
  const empty = setup(t)
  const emptyStore = new SqliteStore({ filePath: empty.file }).open()
  emptyStore.setEmbedderInfo({ model: 'old-embed', dims: 3 })
  emptyStore.close()
  assert.deepEqual((await empty.client.search('tea', { user_id: USER })).results, [])
})

test('health: store ok (sqlite), the old qdrant field, embedder dims, llm model', async (t) => {
  const { client } = setup(t)
  const health = await client.health()
  assert.equal(health.ok, true)
  assert.equal(health.backend, 'oss')
  assert.equal(health.engine, 'native')
  assert.equal(health.mem0Reference, '2.2.1')
  assert.equal(health.store.ok, true)
  assert.equal(health.store.kind, 'sqlite')
  assert.equal(health.store.schemaVersion, 1)
  assert.match(health.store.sqliteVersion, /^3\./)
  assert.deepEqual(health.qdrant, { ok: true, error: null })
  assert.equal(health.embedder.dimensions, VOCAB.length + 1)
  assert.deepEqual(health.llm, { configured: true, model: 'test-llm', error: null })
  assert.equal(client.status().running, true)
  assert.equal(client.status().store.kind, 'sqlite')
})

test('a missing LLM: infer:true is a config error, infer:false still works', async (t) => {
  const { client, settings } = setup(t)
  settings.llm.model = ''
  settings.problems = [{ component: 'llm', code: 'CONFIG_MISSING', message: 'No extraction LLM is configured' }]
  const error = await client.add([{ role: 'user', content: 'x' }]).catch((value) => value)
  assert.equal(error.code, 'CONFIG_MISSING')
  assert.equal(classifyFailure(error), 'config')
  assert.equal((await client.add([{ role: 'user', content: 'x' }], { infer: false })).results.length, 1)
})

test('dispose waits for an add in flight', async (t) => {
  let release
  const { client } = setup(t, {
    llm: () => new Promise((resolve) => {
      release = () => resolve({ content: facts('User likes tea') })
    }),
  })
  const pending = client.add([{ role: 'user', content: 'I like tea' }])
  await new Promise((resolve) => setTimeout(resolve, 20))
  let disposed = false
  const disposing = client.dispose().then(() => {
    disposed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(disposed, false)
  release()
  assert.equal((await pending).summary.add, 1)
  await disposing
  assert.equal(disposed, true)
  const after = await client.add([{ role: 'user', content: 'x' }]).catch((value) => value)
  assert.equal(after.code, 'DISPOSED')
})

// ---- PR #26 review ------------------------------------------------------

test('dispose while a search waits on the embedder: no connection is opened again afterwards', async (t) => {
  let release
  let gate = false
  const ctx = setup(t, { embedGate: () => (gate ? new Promise((resolve) => { release = resolve }) : undefined) })
  await ctx.client.add([{ role: 'user', content: 'tea' }], { infer: false })
  const store = ctx.client.store
  assert.ok(store.db)
  gate = true
  const searching = ctx.client.search('tea', { user_id: USER }).catch((value) => value)
  await new Promise((resolve) => setTimeout(resolve, 20))
  await ctx.client.dispose()
  assert.equal(store.db, undefined, 'closed when dispose() returned')
  release()
  const error = await searching
  assert.equal(error.code, 'DISPOSED')
  assert.equal(store.db, undefined, 'the late search did not reopen the file')
  // The file can be removed at once (Windows: EPERM while it is open).
  fs.rmSync(ctx.dir, { recursive: true, force: true })
  assert.equal(fs.existsSync(ctx.file), false)
})

test('an add waiting behind another add of the same scope gets its full time budget', async (t) => {
  let releaseLlm
  const ctx = setup(t, {
    llm: () => new Promise((resolve) => {
      releaseLlm = () => resolve({ content: facts('User likes tea') })
    }),
    // Every embedding takes 60 ms.
    embedGate: () => new Promise((resolve) => setTimeout(resolve, 60)),
  })
  const first = ctx.client.add([{ role: 'user', content: 'I like tea' }], { timeoutMs: 5_000 })
  const second = ctx.client.add([{ role: 'user', content: 'coffee notes' }], { infer: false, timeoutMs: 300 })
  // The first add holds the queue for longer than the second's budget.
  await new Promise((resolve) => setTimeout(resolve, 400))
  releaseLlm()
  assert.equal((await first).summary.add, 1)
  const result = await second
  assert.equal(result.results.length, 1, 'the 300 ms count from when the second add started, not from when it was queued')
})

test('startInBackground followed by dispose logs nothing and opens nothing', async (t) => {
  const warn = []
  const ctx = setup(t, { logger: { warn: (line) => warn.push(line), debug() {}, info() {} } })
  ctx.client.startInBackground()
  await ctx.client.dispose()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(warn, [])
  assert.equal(fs.existsSync(ctx.file), false)
})

test('the credential lookup gets the time left of the call, at most 3 s', async (t) => {
  const asked = []
  const ctx = setup(t, { apiKeyRef: 'MEM0_EMBEDDER_API_KEY', resolveSecret: async (ref, options) => (asked.push({ ref, ...options }), 'embed-key') })
  await ctx.client.search('tea', { user_id: USER }, { timeoutMs: 500 })
  assert.equal(asked[0].ref, 'MEM0_EMBEDDER_API_KEY')
  assert.ok(asked[0].timeoutMs > 0 && asked[0].timeoutMs <= 500, JSON.stringify(asked))
  await ctx.client.search('tea', { user_id: USER }, { timeoutMs: 60_000 })
  assert.equal(asked[1].timeoutMs, 3_000)
})

test('a baseUrl set in dsh_mem0 never receives the literal key of the oss block', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-native-key-'))
  const raw = { oss: { embedder: { provider: 'openai', config: { model: 'm', api_key: 'sk-oss-literal-abcdef123456', openai_base_url: 'https://api.openai.com/v1' } } } }
  const seen = []
  const client = new Mem0NativeClient({
    config: { backend: 'oss', userId: USER, agentId: AGENT },
    loadSettings: () => resolveNativeSettings({ storePath: path.join(dir, 'memory.sqlite'), embedderBaseUrl: 'http://127.0.0.1:18001/v1', embedderModel: 'm' }, raw),
    fetchImpl: async (url, init) => {
      seen.push({ url, authorization: init.headers.authorization })
      const body = JSON.parse(init.body)
      return new Response(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: embedText(text) })) }), { status: 200 })
    },
  })
  t.after(async () => {
    await client.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await client.search('tea', { user_id: USER })
  assert.equal(seen[0].url, 'http://127.0.0.1:18001/v1/embeddings')
  assert.equal(seen[0].authorization, undefined)
})

test('reembed retry reuses the vectors of unchanged memories and recomputes only new or edited ones (PR #27 review 16)', async (t) => {
  const first = setup(t)
  for (const text of ['tea', 'coffee', 'pnpm']) await first.client.add([{ role: 'user', content: text }], { infer: false })
  await first.client.dispose()
  let inserted = false
  const switched = setup(t, {
    storePath: first.file,
    embedModel: 'other-embed',
    dims: 8,
    // During the first attempt another process adds a memory and edits one.
    embedGate: () => {
      if (inserted) return
      inserted = true
      const other = new SqliteStore({ filePath: first.file }).open()
      other.insert([{ id: 'late', text: 'falcon', hash: md5('falcon'), vector: embedText('falcon', 8), payload: { user_id: USER }, embedModel: 'other-embed' }])
      const edited = other.list({ user_id: USER }).find((item) => item.memory === 'coffee')
      other.update(edited.id, { text: 'green coffee', hash: md5('green coffee'), vector: embedText('green coffee', 8), embedModel: 'other-embed' })
      other.close()
    },
  })
  const result = await switched.client.reembed({ batchSize: 32 })
  assert.equal(result.updated, 4)
  // First attempt: 3 texts. Retry: only 'falcon' (new) and 'green coffee' (edited).
  assert.deepEqual(switched.calls.embed.map((call) => call.body.input.length), [3, 2])
  assert.deepEqual(switched.calls.embed[1].body.input.sort(), ['falcon', 'green coffee'])
  assert.deepEqual(switched.client.lastReembed, { computed: 5, reused: 2 })
  await switched.client.dispose()
})

test('reembed stops on a cancelled signal before writing any vector', async (t) => {
  const first = setup(t)
  await first.client.add([{ role: 'user', content: 'tea' }], { infer: false })
  await first.client.dispose()
  const controller = new AbortController()
  const switched = setup(t, { storePath: first.file, embedModel: 'other-embed', dims: 8, embedGate: () => controller.abort() })
  await assert.rejects(switched.client.reembed({ signal: controller.signal }), { code: 'ABORTED' })
  await switched.client.dispose()
  const store = new SqliteStore({ filePath: first.file }).open()
  assert.deepEqual(store.embedderInfo(), { model: 'test-embed', dims: VOCAB.length + 1 })
  store.close()
})

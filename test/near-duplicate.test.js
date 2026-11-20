// Near-duplicate memories from one turn (Windows test, 2026-11-20): the
// explicit mem0_add, the automatic capture of the same turn, and the
// assistant's confirmation used to give three copies of one fact. Real
// lifecycle, real mem0_add tool and the real local client over a temporary
// SQLite file; embedder and LLM are mocked (no network). Test user only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isAssistantMeta, stripAssistantMeta } from '../lib/capture-filter.js'
import { captureConversation, MemoryLifecycle } from '../lib/memory-lifecycle.js'
import { DEFAULT_DEDUP_THRESHOLD, dedupThreshold, Mem0NativeClient } from '../lib/native-client.js'
import { createMem0Tools } from '../lib/tools.js'

const USER = 'dsh-mem0-neardup-test-user'
const AGENT = 'dsh-test'
// Bag-of-words vectors: rewordings of one fact share all words (cosine 1),
// another city shares two of three (cosine 0.67).
const VOCAB = ['下周', '上海', '北京', '出差', '截图', '记录', 'tea', 'green', 'morning']

function embed(text) {
  const lower = String(text).toLowerCase()
  const vector = VOCAB.map((word) => (lower.includes(word) ? 1 : 0))
  vector.push(0.01)
  return vector
}

/** The "## New Messages" part of an extraction prompt. */
function newMessages(body) {
  const prompt = body.messages[1].content
  const start = prompt.indexOf('## New Messages')
  return start < 0 ? '' : prompt.slice(start, prompt.indexOf('##', start + 3) > 0 ? prompt.indexOf('##', start + 3) : undefined)
}

/**
 * An extraction LLM that behaves like the friend's run: a reworded copy of
 * the user's fact, plus one fact per assistant sentence it is shown (the
 * confirmation and the screenshot advice).
 */
function extractionLlm(body) {
  const shown = newMessages(body)
  const out = []
  if (shown.includes('上海')) out.push({ id: '0', text: '用户下周将去上海出差', attributed_to: 'user' })
  if (shown.includes('北京')) out.push({ id: '1', text: '用户下周要去北京出差', attributed_to: 'user' })
  if (shown.includes('记住了') || shown.includes('记下了')) out.push({ id: '2', text: '助手已为用户记录出差安排', attributed_to: 'assistant' })
  if (shown.includes('截图')) out.push({ id: '3', text: '助手建议用户截图保存测试结果', attributed_to: 'assistant' })
  return JSON.stringify({ memory: out })
}

function setup(t, { dedup } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-neardup-'))
  const settings = {
    storePath: path.join(dir, 'memory.sqlite'),
    embedder: { provider: 'openai', baseUrl: 'http://127.0.0.1:18000/v1', model: 'test-embed', apiKeyRef: '', apiKey: '' },
    llm: { baseUrl: 'http://127.0.0.1:13425/v1', model: 'test-llm', apiKeyRef: '', apiKey: '', maxTokens: 8000, temperature: 0, topP: 0.1, reasoningEffort: '' },
    problems: [],
  }
  const prompts = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    if (url.endsWith('/embeddings')) {
      return new Response(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: embed(text) })) }), { status: 200 })
    }
    prompts.push(body)
    return new Response(JSON.stringify({ choices: [{ message: { content: extractionLlm(body) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 })
  }
  const config = {
    backend: 'oss',
    userId: USER,
    agentId: AGENT,
    autoRecall: false,
    autoCapture: true,
    captureMaxChars: 450,
    captureFilter: 'heuristic',
    ...(dedup === undefined ? {} : { captureDedupThreshold: dedup }),
  }
  const client = new Mem0NativeClient({ config, loadSettings: () => settings, fetchImpl, warmUpOnStart: false })
  const activity = { recall: null, capture: null }
  const lifecycle = new MemoryLifecycle({
    client,
    config,
    logger: { debug() {}, warn() {} },
    breaker: { isOpen: () => false, recordSuccess() {}, recordFailure() {} },
    activity,
  })
  const tools = new Map(createMem0Tools(client, config, { activity, onExplicitAdd: (session, rows) => lifecycle.noteExplicitAdd(session, rows) }).map((tool) => [tool.name, tool]))
  t.after(async () => {
    lifecycle.dispose()
    await client.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { client, lifecycle, tools, activity, prompts }
}

const session = { id: 'neardup-session-1', header: { origin: 'user' } }

function text(value) {
  return [{ type: 'text', text: value }]
}

/** One completed turn: the user's message, optional tool calls, the final reply. */
async function turn(ctx, { user, adds = [], reply }) {
  ctx.lifecycle.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  ctx.lifecycle.onSessionEvent(session, { type: 'user/message', data: { role: 'user', content: text(user), source: { kind: 'user' } } })
  for (const content of adds) {
    const answer = await ctx.tools.get('mem0_add').execute({ content }, { agent: { session } })
    assert.match(answer, /^Stored 1 memory/)
  }
  ctx.lifecycle.onSessionEvent(session, { type: 'assistant/message', data: { message: { role: 'assistant', content: text(reply) } } })
  ctx.lifecycle.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (['saved', 'error', 'skipped'].includes(ctx.activity.capture?.status)) break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return ctx.activity.capture
}

async function stored(client) {
  return (await client.list({ user_id: USER })).results.map((item) => item.memory).sort()
}

const REPLY = '好的，我已经记住了：你下周要去上海出差。另外建议你截图保存测试结果。祝出差顺利！'

test('explicit mem0_add plus the capture of the same turn leave one memory', async (t) => {
  const ctx = setup(t)
  const capture = await turn(ctx, { user: '记住我下周要去上海出差', adds: ['用户下周要去上海出差'], reply: REPLY })
  assert.equal(capture.status, 'saved')
  assert.deepEqual(await stored(ctx.client), ['用户下周要去上海出差'])
  // The extraction saw the explicit memory as existing, and none of the
  // assistant's confirmation or screenshot advice.
  const prompt = ctx.prompts[0].messages[1].content
  assert.match(prompt, /## Existing Memories\n\[\{"id": "0", "text": "用户下周要去上海出差"\}\]/)
  assert.doesNotMatch(newMessages(ctx.prompts[0]), /记住了|截图/)
  assert.match(newMessages(ctx.prompts[0]), /assistant: 祝出差顺利！/)
  assert.equal(capture.facts, 1)
  assert.equal(capture.add, 0)
  assert.equal(capture.similar, 1)
  assert.equal(capture.metaDropped, 2)
})

test('the assistant restating a fact gives no extra memory', async (t) => {
  const ctx = setup(t)
  const capture = await turn(ctx, { user: '记住：下周我要去上海出差', reply: '好的，记下了：你下周要去上海出差。' })
  assert.equal(capture.status, 'saved')
  assert.deepEqual(await stored(ctx.client), ['用户下周将去上海出差'])
  assert.doesNotMatch(newMessages(ctx.prompts[0]), /assistant:/, 'a reply that was only a confirmation is not sent')
})

test('a near-duplicate of a memory stored earlier is not stored again; a different fact is', async (t) => {
  const ctx = setup(t)
  await ctx.client.add([{ role: 'user', content: '用户下周要去上海出差' }], { infer: false })
  const again = await turn(ctx, { user: '记住，我下周要去上海出差', reply: '祝出差顺利！' })
  assert.equal(again.add, 0)
  assert.equal(again.similar, 1)
  const other = await turn(ctx, { user: '记住，我下周要去北京出差', reply: '祝一路顺风！' })
  assert.equal(other.add, 1)
  assert.deepEqual(await stored(ctx.client), ['用户下周要去上海出差', '用户下周要去北京出差'].sort())
})

test('captureDedupThreshold 0 turns the check off (md5 only, as upstream Mem0)', async (t) => {
  const ctx = setup(t, { dedup: 0 })
  await turn(ctx, { user: '记住我下周要去上海出差', adds: ['用户下周要去上海出差'], reply: '祝出差顺利！' })
  assert.deepEqual(await stored(ctx.client), ['用户下周将去上海出差', '用户下周要去上海出差'].sort())
})

test('dedupThreshold: default 0.95, 0 or out of range is off', () => {
  assert.equal(DEFAULT_DEDUP_THRESHOLD, 0.95)
  assert.equal(dedupThreshold({}), 0.95)
  assert.equal(dedupThreshold({ captureDedupThreshold: 0.9 }), 0.9)
  assert.equal(dedupThreshold({ captureDedupThreshold: 0 }), 0)
  assert.equal(dedupThreshold({ captureDedupThreshold: 2 }), 0)
})

test('assistant meta filter: memory confirmations, tool and screenshot notes go; content stays', () => {
  for (const sentence of [
    '好的，我已经记住了。',
    '已帮你保存到长期记忆。',
    '收到，记下了：你下周出差。',
    '我调用了 mem0_add 工具。',
    '建议你截图保存这一步的结果。',
    "Got it, I've saved that to your memory.",
    'I stored this in long-term memory.',
    'Please take a screenshot of the result.',
    'I called the mem0_search tool first.',
  ]) assert.equal(isAssistantMeta(sentence), true, sentence)
  for (const sentence of [
    'Python 的列表推导式很好用。',
    '祝出差顺利！',
    '上海下周有雨，记得带伞。',
    'The release notes are in English and Chinese.',
    'Use pnpm for this project.',
  ]) assert.equal(isAssistantMeta(sentence), false, sentence)
  assert.deepEqual(stripAssistantMeta('第一句。第二句。'), { text: '第一句。第二句。', dropped: 0 })
  assert.deepEqual(stripAssistantMeta('好的，我已经记住了。上海下周有雨，记得带伞。'), { text: '上海下周有雨，记得带伞。', dropped: 1 })
  assert.deepEqual(stripAssistantMeta('好的，我已经记住了。'), { text: '', dropped: 1 })
})

test('captureConversation keeps user messages whole and only filters the reply', () => {
  const { conversation, dropped } = captureConversation(
    [{ seq: 0, role: 'user', content: '记住：我习惯截图保存每一步。' }],
    { seq: 1, role: 'assistant', content: '好的，记下了。' },
  )
  assert.deepEqual(conversation, [{ role: 'user', content: '记住：我习惯截图保存每一步。' }])
  assert.equal(dropped, 1)
})

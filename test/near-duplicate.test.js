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
import { COVER_FLOOR, contentTokens, coveredBy, repeatsTurnWrite } from '../lib/turn-dedup.js'

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

function setup(t, { dedup, embedFn = embed, llmFn = extractionLlm } = {}) {
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
      return new Response(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: embedFn(text) })) }), { status: 200 })
    }
    prompts.push(body)
    return new Response(JSON.stringify({ choices: [{ message: { content: llmFn(body) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 })
  }
  const config = {
    backend: 'oss',
    userId: USER,
    agentId: AGENT,
    autoRecall: false,
    autoCapture: true,
    captureMaxChars: 450,
    captureFilter: 'heuristic',
    ...(dedup === undefined ? {} : { captureTurnDedupThreshold: dedup }),
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

test('a correction close to an older memory is still stored; older memories get md5 only', async (t) => {
  const ctx = setup(t)
  // An older fact from an earlier turn. The capture's reworded fact scores
  // cosine 1 against it (≥ 0.95), as a correction such as "moved to the
  // week after" would: V3 additive only adds, so dropping it would lose the
  // new information. Only this turn's writes are compared by meaning.
  await ctx.client.add([{ role: 'user', content: '用户下周要去上海出差' }], { infer: false })
  const correction = await turn(ctx, { user: '记住，我下周要去上海出差的安排改了', reply: '好的。' })
  assert.equal(correction.add, 1)
  assert.equal(correction.similar, undefined)
  assert.deepEqual(await stored(ctx.client), ['用户下周将去上海出差', '用户下周要去上海出差'].sort())
  // An exact copy of an older memory is still dropped by md5, as upstream.
  const exact = await ctx.client.add([{ role: 'user', content: '记住，我下周要去上海出差' }])
  assert.equal(exact.summary.add, 0)
  assert.equal(exact.summary.skippedDuplicate, 1)
  // A different fact is stored as before.
  const other = await turn(ctx, { user: '记住，我下周要去北京出差', reply: '祝一路顺风！' })
  assert.equal(other.add, 1)
})

test('captureTurnDedupThreshold 0 turns the check off (md5 only, as upstream Mem0)', async (t) => {
  const ctx = setup(t, { dedup: 0 })
  await turn(ctx, { user: '记住我下周要去上海出差', adds: ['用户下周要去上海出差'], reply: '祝出差顺利！' })
  assert.deepEqual(await stored(ctx.client), ['用户下周将去上海出差', '用户下周要去上海出差'].sort())
})

test('dedupThreshold: default 0.85, 0 or out of range is off', () => {
  assert.equal(DEFAULT_DEDUP_THRESHOLD, 0.85)
  assert.equal(dedupThreshold({}), 0.85)
  assert.equal(dedupThreshold({ captureTurnDedupThreshold: 0.9 }), 0.9)
  assert.equal(dedupThreshold({ captureTurnDedupThreshold: 0 }), 0)
  assert.equal(dedupThreshold({ captureTurnDedupThreshold: 2 }), 0)
})

// Windows retest (2026-11-20): "记住：我下周三要去上海出差" in a project. The
// explicit add went to global; the extraction LLM wrote the date out (and
// sometimes split the sentence), so the capture's copy scored below 0.95 and
// a second memory landed in the project. Cosines below are bge-m3's for
// these very texts (omlx, 2026-11-21).
const EXPLICIT = '用户下周三要去上海出差'
const BGE_M3 = new Map([
  [EXPLICIT, 1],
  ['用户计划于2026年11月25日（下周三）去上海出差', 0.8925],
  ['用户将于2026年11月25日（下周三）去上海出差', 0.8424],
  ['用户下周三出差', 0.9125],
  ['项目使用 pnpm 作为包管理器', 0.3849],
  ['用户下周五要去杭州开会', 0.8127],
])
const AXES = [...BGE_M3.keys()]
/** cos(text, EXPLICIT) as measured; any two other texts c1·c2 apart. */
function measuredEmbed(text) {
  const vector = new Array(AXES.length + 1).fill(0)
  const cosine = BGE_M3.get(text)
  if (cosine === undefined) {
    vector[AXES.length] = 1
    return vector
  }
  vector[0] = cosine
  if (cosine < 1) vector[AXES.indexOf(text)] = Math.sqrt(1 - cosine * cosine)
  return vector
}
function factsLlm(facts) {
  return () => JSON.stringify({ memory: facts.map((text, id) => ({ id: String(id), text, attributed_to: 'user' })) })
}

test('same turn: the explicit add plus reworded and split copies of it leave one memory', async (t) => {
  const ctx = setup(t, {
    embedFn: measuredEmbed,
    llmFn: factsLlm(['用户计划于2026年11月25日（下周三）去上海出差', '用户将于2026年11月25日（下周三）去上海出差', '用户下周三出差']),
  })
  const capture = await turn(ctx, { user: '记住：我下周三要去上海出差', adds: [EXPLICIT], reply: '祝出差顺利！' })
  assert.equal(capture.status, 'saved')
  assert.deepEqual(await stored(ctx.client), [EXPLICIT])
  assert.equal(capture.facts, 3)
  assert.equal(capture.add, 0)
  assert.equal(capture.similar, 3)
})

test('same turn: two really different facts are both stored', async (t) => {
  const ctx = setup(t, {
    embedFn: measuredEmbed,
    llmFn: factsLlm(['用户计划于2026年11月25日（下周三）去上海出差', '项目使用 pnpm 作为包管理器', '用户下周五要去杭州开会']),
  })
  const capture = await turn(ctx, { user: '记住：我下周三要去上海出差，下周五去杭州开会；这个项目用 pnpm', adds: [EXPLICIT], reply: '好的。' })
  assert.equal(capture.status, 'saved')
  assert.deepEqual(await stored(ctx.client), [EXPLICIT, '用户下周五要去杭州开会', '项目使用 pnpm 作为包管理器'].sort())
  assert.equal(capture.add, 2)
  assert.equal(capture.similar, 1)
})

test('coverage: a fact whose every content token is in a same-turn memory is a repeat', () => {
  assert.equal(coveredBy('用户将于2026年11月25日（下周三）去上海出差', '下周三要去上海出差'), true)
  assert.equal(coveredBy('用户下周三（2026-11-25）要去上海出差', EXPLICIT), true)
  assert.equal(coveredBy('用户下周三出差', EXPLICIT), true)
  assert.equal(coveredBy('User will travel to Shanghai on Wednesday, November 25, 2026', 'User is traveling to Shanghai next Wednesday'), true)
  // Anything new keeps a token the other memory lacks.
  assert.equal(coveredBy('用户下周五要去杭州开会', EXPLICIT), false)
  assert.equal(coveredBy('用户下周三要去北京出差', EXPLICIT), false)
  assert.equal(coveredBy('项目使用 npm', '项目使用 pnpm'), false)
  assert.equal(coveredBy('用户喜欢浅色主题', '用户喜欢深色主题'), false)
  assert.equal(coveredBy('服务端口是 8010', '服务端口是 8000'), false)
  assert.equal(coveredBy('用户', EXPLICIT), false, 'nothing but filler is no fact')
  assert.deepEqual(contentTokens('用户计划于2026年11月25日（下周三）去上海出差'), ['下', '周', '三', '去', '上', '海', '出', '差'])
})

test('repeatsTurnWrite: threshold, coverage above the floor only, 0 = off', () => {
  const fact = '用户将于2026年11月25日（下周三）去上海出差'
  assert.equal(repeatsTurnWrite('用户下周五要去杭州开会', [{ text: EXPLICIT, score: 0.86 }], 0.85), true, 'at or above the threshold')
  assert.equal(repeatsTurnWrite(fact, [{ text: EXPLICIT, score: 0.8424 }], 0.85), true, 'covered, above the floor')
  assert.equal(repeatsTurnWrite(fact, [{ text: EXPLICIT, score: COVER_FLOOR - 0.01 }], 0.85), false, 'covered but below the floor')
  assert.equal(repeatsTurnWrite('用户下周五要去杭州开会', [{ text: EXPLICIT, score: 0.8127 }], 0.85), false)
  assert.equal(repeatsTurnWrite(fact, [{ text: EXPLICIT, score: 0.99 }], 0), false)
  assert.equal(repeatsTurnWrite(fact, [], 0.85), false)
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

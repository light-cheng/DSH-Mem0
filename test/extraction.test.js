// The extraction prompt and answer parsing against mem0ai 2.2.1 itself:
// test/fixtures/mem0-2.2.1-extraction.json was produced from the 2.2.1
// wheel's own helper functions (scripts/mem0-extraction-fixture.py), so a
// difference here is a difference from what Python Mem0 sends.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import {
  EXTRACT_REASONS,
  RETRYABLE_EXTRACT_REASONS,
  buildExtractionMessages,
  describeAnswer,
  describeStats,
  extractJson,
  extractionMessage,
  formatConversationHistory,
  inspectExtraction,
  parseMessages,
  pyJson,
  removeCodeBlocks,
  truncatePast,
} from '../lib/extraction.js'
import { sessionScope } from '../lib/native-client.js'
import { PAST_MESSAGE_TRUNCATION_LIMIT } from '../lib/mem0-prompts.js'

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/mem0-2.2.1-extraction.json', import.meta.url), 'utf8'))
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

test('the fixture comes from mem0 2.2.1 and has the same truncation limit', () => {
  assert.equal(fixture.pastMessageTruncationLimit, PAST_MESSAGE_TRUNCATION_LIMIT)
  assert.ok(fixture.cases.length >= 3)
})

for (const item of fixture.cases) {
  test(`prompt byte for byte as Python mem0 2.2.1: ${item.name}`, () => {
    assert.equal(parseMessages(item.messages), item.parsed)
    assert.equal(sessionScope(item.filters), item.sessionScope)
    const [system, user] = buildExtractionMessages({
      newMessages: parseMessages(item.messages),
      existingMemories: item.existingMemories,
      lastMessages: item.lastMessages,
      agentScoped: item.agentScoped,
      now: new Date(`${item.date}T12:00:00Z`),
    })
    assert.equal(system.role, 'system')
    assert.equal(sha256(system.content), item.systemSha256)
    assert.equal(user.role, 'user')
    assert.equal(user.content, item.user)
  })
}

for (const [index, item] of fixture.parse.entries()) {
  test(`answer parsing as Python mem0 2.2.1 (#${index}: ${JSON.stringify(item.answer).slice(0, 40)})`, () => {
    assert.equal(removeCodeBlocks(item.answer), item.cleaned)
    assert.equal(extractJson(item.cleaned), item.extracted)
    const { facts } = inspectExtraction(item.answer)
    if (item.memories === null) assert.equal(facts, null)
    else assert.deepEqual(facts, item.memories)
  })
}

test('pyJson matches json.dumps(ensure_ascii=False) separators', () => {
  assert.equal(pyJson([{ id: '0', text: '中文 "q"' }]), '[{"id": "0", "text": "中文 \\"q\\""}]')
  assert.equal(pyJson([]), '[]')
  assert.equal(pyJson({ a: [1, true, null] }), '{"a": [1, true, null]}')
})

test('past messages are cut at 300 code points (not UTF-16 units), with ...', () => {
  const emoji = '🚀'.repeat(301)
  const cut = truncatePast(emoji)
  assert.equal(Array.from(cut).length, 303)
  assert.ok(cut.endsWith('🚀...'))
  assert.equal(truncatePast('short'), 'short')
  assert.equal(formatConversationHistory([{ role: 'user', content: '' }, { role: '', content: 'x' }, { role: 'assistant', message: 'm' }]), 'assistant: m\n')
})

test('unusable answers get a reason; length turns not_json and empty into truncated', () => {
  assert.deepEqual(inspectExtraction('{"memory": [{"text": "A"}]}'), { facts: [{ text: 'A' }], reason: undefined })
  assert.equal(inspectExtraction('').reason, 'empty')
  assert.equal(inspectExtraction('not json').reason, 'not_json')
  assert.equal(inspectExtraction('{"memory": [{"text": "cut').reason, 'truncated')
  assert.equal(inspectExtraction("I'm sorry, I can't help with that.").reason, 'refusal')
  assert.equal(inspectExtraction('抱歉，我无法帮助处理这个请求。').reason, 'refusal')
  assert.equal(inspectExtraction('', { finishReason: 'length' }).reason, 'truncated')
  assert.equal(inspectExtraction('thinking...', { finishReason: 'length' }).reason, 'truncated')
  assert.equal(inspectExtraction('{"memory": []}', { finishReason: 'length' }).reason, undefined)
  assert.deepEqual(EXTRACT_REASONS, ['not_json', 'empty', 'truncated', 'refusal'])
  assert.deepEqual(RETRYABLE_EXTRACT_REASONS, ['not_json', 'empty', 'truncated'])
  assert.match(extractionMessage('truncated'), /cut off.*nothing was stored/)
})

test('log descriptions never contain the answer text', () => {
  const answer = '{"memory": [{"text": "secret project Falcon"}]}'
  assert.equal(describeAnswer(answer).includes('Falcon'), false)
  assert.match(describeAnswer(answer), /JSON-like/)
  assert.equal(describeStats({ finishReason: 'length', maxTokens: 2000, completionTokens: 2000, reasoningTokens: 1697, promptTokens: 9 }), 'finish_reason=length, 2000/2000 output tokens (1697 reasoning), 9 prompt tokens')
})

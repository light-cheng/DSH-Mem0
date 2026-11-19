// Calls to DSH's own model service (lib/dsh-llm.js) with a fake `llm`
// service: no sessionId (no session file, no title generation), only
// text-delta chunks form the answer, failures arrive as finish chunks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DshLlmError, completeText, defaultModel, waitForProvider } from '../lib/dsh-llm.js'

function fakeLlm(chunks, { providers = ['deepseek'] } = {}) {
  const seen = []
  return {
    seen,
    listProviders: () => providers,
    async *stream(options) {
      seen.push(options)
      for (const chunk of typeof chunks === 'function' ? chunks(options) : chunks) yield chunk
    },
  }
}

const selection = { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }

test('the background default model comes from agentDefaultModel.currentSelection()', () => {
  assert.deepEqual(defaultModel(selection), { provider: 'deepseek', model: 'deepseek-chat' })
  assert.deepEqual(defaultModel({ currentSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }) }), { provider: 'p', model: 'm', reasoningEffort: 'low' })
  assert.equal(defaultModel({ currentSelection: () => null }), null)
  assert.equal(defaultModel({ currentSelection: () => { throw new Error('x') } }), null)
  assert.equal(defaultModel(undefined), null)
})

test('one completion: no sessionId, text-delta only, usage kept', async () => {
  const llm = fakeLlm([
    { type: 'block-start', kind: 'text' },
    { type: 'reasoning-delta', text: 'thinking about it' },
    { type: 'text-delta', text: 'Hello' },
    { type: 'text-delta', text: ', world' },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const result = await completeText({ llm, agentDefaultModel: selection }, { system: 'sys', prompt: 'hi', temperature: 0, maxTokens: 100 })
  assert.equal(result.text, 'Hello, world')
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 3, totalTokens: 8 })
  const [options] = llm.seen
  assert.equal('sessionId' in options, false)
  assert.equal(options.provider, 'deepseek')
  assert.equal(options.model, 'deepseek-chat')
  assert.equal(options.system, 'sys')
  assert.equal(options.temperature, 0)
  assert.equal(options.maxTokens, 100)
  assert.deepEqual(options.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
})

test('finish errors, aborts and cut-off answers become DshLlmError codes', async () => {
  const services = (chunks) => ({ llm: fakeLlm(chunks), agentDefaultModel: selection })
  const failed = await completeText(services([{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad key' } } }]), { prompt: 'x' }).catch((error) => error)
  assert.ok(failed instanceof DshLlmError)
  assert.equal(failed.code, 'AUTH')
  assert.equal(failed.component, 'llm')
  const aborted = await completeText(services([{ type: 'finish', reason: { kind: 'aborted' } }]), { prompt: 'x' }).catch((error) => error)
  assert.equal(aborted.code, 'ABORTED')
  const cut = [{ type: 'text-delta', text: 'part' }, { type: 'finish', reason: { kind: 'max-tokens' } }]
  const truncated = await completeText(services(cut), { prompt: 'x' }).catch((error) => error)
  assert.equal(truncated.code, 'MAX_TOKENS')
  assert.equal(truncated.text, 'part')
  assert.equal((await completeText(services(cut), { prompt: 'x', allowTruncated: true })).text, 'part')
  const thrown = await completeText({ llm: { async *stream() { throw Object.assign(new Error('boom'), { code: 'TRANSPORT' }) } }, agentDefaultModel: selection }, { prompt: 'x' }).catch((error) => error)
  assert.equal(thrown.code, 'TRANSPORT')
})

test('no service or no model is reported, not thrown as a TypeError', async () => {
  assert.equal((await completeText({}, { prompt: 'x' }).catch((error) => error)).code, 'NO_SERVICE')
  assert.equal((await completeText({ llm: fakeLlm([]), agentDefaultModel: { currentSelection: () => null } }, { prompt: 'x' }).catch((error) => error)).code, 'NO_MODEL')
})

test('a provider that registers late is waited for (bounded)', async () => {
  const providers = []
  const llm = fakeLlm([{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }], { providers })
  setTimeout(() => providers.push({ id: 'deepseek' }), 60)
  const started = Date.now()
  assert.equal((await completeText({ llm, agentDefaultModel: selection }, { prompt: 'x', providerWaitMs: 1_000 })).text, 'ok')
  assert.ok(Date.now() - started >= 50)
  assert.equal(await waitForProvider({ listProviders: () => [] }, 'none', { timeoutMs: 30, intervalMs: 10 }), false)
  assert.equal(await waitForProvider({}, 'any'), true)
})

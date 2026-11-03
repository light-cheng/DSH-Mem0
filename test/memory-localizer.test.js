import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryLocalizer, needsTranslation, normalizeLanguage, preserveMarkdownPrefixes } from '../lib/memory-localizer.js'

function fakeLlm(translations) {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    stream() {
      calls += 1
      const text = translations
        .map((value, index) => `${index + 1}. ${value}`)
        .join('\n')
      return (async function* () {
        yield { type: 'text-delta', text }
      })()
    },
  }
}

test('normalizes page languages and skips text already in the target language', () => {
  assert.equal(normalizeLanguage('zh-CN'), 'zh')
  assert.equal(normalizeLanguage('en-US'), 'en')
  assert.equal(normalizeLanguage('fr'), '')
  assert.equal(needsTranslation('Likes tea', 'zh'), true)
  assert.equal(needsTranslation('喜欢茶', 'zh'), false)
  assert.equal(needsTranslation('喜欢茶', 'en'), true)
  assert.equal(needsTranslation('Likes tea', 'en'), false)
})

test('translates a batch and caches the result', async () => {
  const llm = fakeLlm(['喜欢茶', '使用 Node 22'])
  const localizer = new MemoryLocalizer({
    llm,
    modelSelection: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  })
  assert.deepEqual(await localizer.translate(['Likes tea', 'Uses Node 22'], 'zh'), [
    '喜欢茶',
    '使用 Node 22',
  ])
  assert.equal(llm.calls, 1)
  assert.deepEqual(await localizer.translate(['Likes tea', 'Uses Node 22'], 'zh'), [
    '喜欢茶',
    '使用 Node 22',
  ])
  assert.equal(llm.calls, 1)
})

test('falls back to the original text when no model is selected', async () => {
  const localizer = new MemoryLocalizer({
    llm: { stream() { throw new Error('must not be called') } },
    modelSelection: { currentSelection: () => null },
  })
  assert.deepEqual(await localizer.translate(['Likes tea'], 'zh'), ['Likes tea'])
})

test('preserves Markdown headings and bullets across translation', () => {
  const original = ['## 工作与项目', '- 用户喜欢茶', '普通段落']
  const translated = ['Work and projects', 'User likes tea', 'Plain paragraph']
  assert.deepEqual(preserveMarkdownPrefixes(original, translated), [
    '## Work and projects',
    '- User likes tea',
    'Plain paragraph',
  ])
})

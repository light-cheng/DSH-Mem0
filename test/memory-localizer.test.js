import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
  assert.equal(needsTranslation('在 记忆维护 里查看 results and counts for every run', 'zh'), true)
  assert.equal(needsTranslation('喜欢茶和 API Key', 'zh'), false)
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

test('translates mixed Chinese and English lines instead of leaving them untouched', async () => {
  const llm = fakeLlm(['在“记忆维护”中查看每次运行的 results 和 counts'])
  const localizer = new MemoryLocalizer({
    llm,
    modelSelection: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  })
  const input = 'In 记忆维护 card, read maintenance.lastReport and show results and counts for every run'
  assert.deepEqual(await localizer.translate([input], 'zh'), [
    '在“记忆维护”中查看每次运行的 results 和 counts',
  ])
  assert.equal(llm.calls, 1)
})

test('persists the translation cache across localizer instances', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mem0-localizer-'))
  const cachePath = path.join(dir, 'translation-cache.json')
  try {
    const first = new MemoryLocalizer({
      llm: fakeLlm(['喜欢茶']),
      modelSelection: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      cachePath,
    })
    assert.deepEqual(await first.translate(['Likes tea'], 'zh'), ['喜欢茶'])
    await new Promise((resolve) => setTimeout(resolve, 450))

    const second = new MemoryLocalizer({
      llm: {
        stream() {
          throw new Error('cache should avoid the model')
        },
      },
      modelSelection: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      cachePath,
    })
    assert.deepEqual(await second.translate(['Likes tea'], 'zh'), ['喜欢茶'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('translates multiple batches concurrently', async () => {
  let active = 0
  let maximum = 0
  const llm = {
    stream(options) {
      const prompt = options.messages[0].content[0].text
      const count = (prompt.match(/^\d+\. /gm) ?? []).length
      active += 1
      maximum = Math.max(maximum, active)
      return (async function* () {
        try {
          await new Promise((resolve) => setTimeout(resolve, 30))
          const text = Array.from({ length: count }, (_, index) => `${index + 1}. 翻译${index}`).join('\n')
          yield { type: 'text-delta', text }
        } finally {
          active -= 1
        }
      })()
    },
  }
  const localizer = new MemoryLocalizer({
    llm,
    modelSelection: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  })
  const texts = Array.from({ length: 25 }, (_, index) => `English memory ${index}`)
  const output = await localizer.translate(texts, 'zh')
  assert.equal(output.length, 25)
  assert.ok(maximum >= 2, `expected concurrent batches, maximum was ${maximum}`)
})

test('a disabled localizer never calls the model', async () => {
  const localizer = new MemoryLocalizer({
    enabled: false,
    llm: { stream() { throw new Error('must not be called') } },
    modelSelection: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  })
  assert.deepEqual(await localizer.translate(['Likes tea'], 'zh'), ['Likes tea'])
  assert.equal(localizer.diagnostics().enabled, false)
})

test('writes the cache owner-only and forgets deleted memories', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mem0-localizer-'))
  const cachePath = path.join(dir, 'translation-cache.json')
  try {
    const localizer = new MemoryLocalizer({
      llm: fakeLlm(['喜欢茶', '使用 Node 22']),
      modelSelection: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      cachePath,
    })
    await localizer.translate(['Likes tea', 'Uses Node 22'], 'zh')
    await localizer.flush()
    if (process.platform !== 'win32') {
      assert.equal((await stat(cachePath)).mode & 0o777, 0o600)
    }
    assert.equal(await localizer.forget(['Likes tea']), 1)
    await localizer.flush()
    const saved = JSON.parse(await readFile(cachePath, 'utf8'))
    const sources = saved.entries.map(([key]) => key.split('\u0000')[1])
    assert.deepEqual(sources, ['Uses Node 22'])
    assert.equal(JSON.stringify(saved).includes('Likes tea'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

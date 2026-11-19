#!/usr/bin/env node
/**
 * Manual smoke test of the native local backend against REAL embedder and
 * LLM endpoints (`npm run smoke`). Never touches your ~/.dsh: HOME points
 * at a temporary folder before the plugin is loaded, the store file lives
 * there, a test user id is used, and the folder is removed at the end.
 *
 *   DSH_MEM0_SMOKE_EMBED_URL=http://127.0.0.1:8000/v1   (required)
 *   DSH_MEM0_SMOKE_EMBED_MODEL=bge-m3                    (required)
 *   DSH_MEM0_SMOKE_EMBED_PROVIDER=openai|ollama          (default openai)
 *   DSH_MEM0_SMOKE_EMBED_KEY=...                         (optional)
 *   DSH_MEM0_SMOKE_LLM_URL=http://127.0.0.1:3425/v1      (optional: skips inference without)
 *   DSH_MEM0_SMOKE_LLM_MODEL=...                         (with LLM_URL)
 *   DSH_MEM0_SMOKE_LLM_KEY=...                           (optional)
 *   DSH_MEM0_SMOKE_REASONING_EFFORT=none                 (optional)
 *
 * Keys are read from the environment only for this run and never printed.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const env = process.env
if (!env.DSH_MEM0_SMOKE_EMBED_URL || !env.DSH_MEM0_SMOKE_EMBED_MODEL) {
  console.error('set DSH_MEM0_SMOKE_EMBED_URL and DSH_MEM0_SMOKE_EMBED_MODEL (see the header of this script)')
  process.exit(2)
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-smoke-native-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
process.env.MEM0_TELEMETRY = 'false'
process.env.MEM0_DIR = path.join(home, '.mem0')

const { Mem0NativeClient } = await import(pathToFileURL(path.join(ROOT, 'lib', 'native-client.js')).href)
const USER = `dsh-mem0-smoke-${process.pid}`
const storePath = path.join(home, '.dsh', 'mem0', 'memory.sqlite')
const settings = {
  storePath,
  embedder: {
    provider: env.DSH_MEM0_SMOKE_EMBED_PROVIDER === 'ollama' ? 'ollama' : 'openai',
    baseUrl: env.DSH_MEM0_SMOKE_EMBED_URL.replace(/\/+$/, ''),
    model: env.DSH_MEM0_SMOKE_EMBED_MODEL,
    apiKeyRef: env.DSH_MEM0_SMOKE_EMBED_KEY ? 'DSH_MEM0_SMOKE_EMBED_KEY' : '',
    apiKey: '',
  },
  llm: {
    baseUrl: (env.DSH_MEM0_SMOKE_LLM_URL ?? '').replace(/\/+$/, ''),
    model: env.DSH_MEM0_SMOKE_LLM_MODEL ?? '',
    apiKeyRef: env.DSH_MEM0_SMOKE_LLM_KEY ? 'DSH_MEM0_SMOKE_LLM_KEY' : '',
    apiKey: '',
    maxTokens: 8000,
    temperature: 0,
    topP: 0.1,
    reasoningEffort: env.DSH_MEM0_SMOKE_REASONING_EFFORT ?? '',
  },
  problems: [],
}
const client = new Mem0NativeClient({
  config: { backend: 'oss', userId: USER, agentId: 'dsh-smoke' },
  loadSettings: () => settings,
  resolveSecret: async (ref) => env[ref],
  logger: { warn: (line) => console.log(`  warn: ${line}`), debug() {}, info() {} },
})

const step = async (name, fn) => {
  const started = Date.now()
  const result = await fn()
  console.log(`ok  ${name} (${Date.now() - started} ms)`)
  return result
}

try {
  const health = await step('health', () => client.health())
  assert.equal(health.store.ok, true, health.store.error)
  assert.equal(health.embedder.ok, true, health.embedder.error)
  console.log(`    store ${health.store.kind} sqlite ${health.store.sqliteVersion}, embedder ${health.embedder.dimensions} dims`)

  const raw = await step('add infer:false', () => client.add([{ role: 'user', content: 'I drink green tea every morning.' }], { infer: false }))
  const found = await step('search', () => client.search('what does the user drink?', { user_id: USER }))
  assert.equal(found.results[0]?.id, raw.results[0].id)
  console.log(`    top score ${found.results[0].score.toFixed(3)}`)

  if (settings.llm.baseUrl && settings.llm.model) {
    const inferred = await step('add infer:true (LLM extraction)', () => client.add([
      { role: 'user', content: '我每次写发布说明都要中英双语，英文在前。' },
      { role: 'assistant', content: '好的，以后发布说明都写中英双语，英文在前。' },
    ]))
    console.log(`    summary ${JSON.stringify(inferred.summary)}; extraction ${JSON.stringify(client.status().lastExtraction)}`)
    for (const item of inferred.results) console.log(`    + ${item.memory}`)
  } else {
    console.log('--  add infer:true skipped (no DSH_MEM0_SMOKE_LLM_URL)')
  }

  const listed = await step('list', () => client.list({ user_id: USER }))
  await step('update', () => client.update(raw.results[0].id, { text: 'I drink oolong tea every morning.' }))
  for (const item of listed.results) await client.remove(item.id)
  assert.equal((await client.list({ user_id: USER })).results.length, 0)
  console.log(`ok  removed ${listed.results.length} test memories`)
} finally {
  await client.dispose()
  fs.rmSync(home, { recursive: true, force: true })
}

#!/usr/bin/env node
/**
 * Real-service smoke test for the sidecar and the Mem0 OSS stack.
 *
 * Requires a local Mem0 OSS config plus the Qdrant/embedding/LLM services it
 * points at. Set DSH_MEM0_OSS_CONFIG and DSH_MEM0_PYTHON to override the
 * discovery defaults.
 * Creates a uniquely named temporary collection and deletes it afterwards.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Mem0SidecarClient } from '../lib/sidecar-client.js'

const collection = `dsh_mem0_smoke_${Date.now()}`
const historyDb = path.join(os.tmpdir(), `dsh-mem0-smoke-${process.pid}`, 'history.db')
const configuredConfigPath =
  process.env.DSH_MEM0_OSS_CONFIG ??
  path.join(os.homedir(), '.dsh', 'mem0', 'oss.json')
const mem0ConfigPath = fs.existsSync(configuredConfigPath)
  ? configuredConfigPath
  : path.join(os.homedir(), '.hermes', 'mem0.json')
const pythonPath =
  process.env.DSH_MEM0_PYTHON ??
  (fs.existsSync(path.join(os.homedir(), '.dsh', 'mem0', 'venv', 'bin', 'python'))
    ? path.join(os.homedir(), '.dsh', 'mem0', 'venv', 'bin', 'python')
    : path.join(os.homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'python'))

async function qdrantDelete(name) {
  const response = await fetch(`http://127.0.0.1:6333/collections/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
  return response.status
}

async function main() {
  const client = new Mem0SidecarClient({
    pythonPath,
    mem0ConfigPath,
    historyDbPath: historyDb,
    collectionName: collection,
    userId: 'dsh-smoke-user',
    agentId: 'dsh-smoke',
    logger: {
      debug() {},
      info(message) {
        console.log(message)
      },
      warn(message) {
        console.warn(message)
      },
    },
  })

  try {
    await client.ensureStarted()
    const health = await client.health()
    console.log('health:', JSON.stringify(health))
    if (!health.ok || !health.embedder?.ok) throw new Error('health check failed')

    const fact = `DSH Mem0 smoke fact ${Date.now()}`
    const added = await client.add(
      [{ role: 'user', content: fact }],
      {
        userId: 'dsh-smoke-user',
        agentId: 'dsh-smoke',
        metadata: { source: 'dsh-smoke' },
        infer: false,
      },
    )
    const memoryId = added?.results?.[0]?.id
    if (!memoryId) throw new Error(`add returned no memory id: ${JSON.stringify(added)}`)
    console.log('added:', memoryId)

    const searched = await client.search('smoke fact', { user_id: 'dsh-smoke-user' }, { topK: 5 })
    if (!searched?.results?.some((memory) => memory.id === memoryId)) {
      throw new Error(`search did not return ${memoryId}: ${JSON.stringify(searched)}`)
    }
    console.log('search: ok')

    const fetched = await client.get(memoryId)
    if (!fetched || fetched.id !== memoryId) throw new Error('get did not return the memory')
    console.log('get: ok')

    const updatedText = `${fact} updated`
    await client.update(memoryId, { text: updatedText })
    const updated = await client.get(memoryId)
    if (updated?.memory !== updatedText) throw new Error('update did not persist')
    console.log('update: ok')

    await client.remove(memoryId)
    await client.remove(memoryId).then(
      () => {
        throw new Error('delete was not idempotent')
      },
      () => {},
    )
    console.log('delete: ok')

    console.log('SMOKE PASSED')
  } finally {
    await client.dispose()
    await qdrantDelete(collection)
    await qdrantDelete(`${collection}_entities`)
  }
}

main().catch((error) => {
  console.error('SMOKE FAILED:', error.stack ?? error)
  process.exitCode = 1
})

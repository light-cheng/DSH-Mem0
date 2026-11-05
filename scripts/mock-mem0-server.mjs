#!/usr/bin/env node
// In-memory mock of the self-hosted Mem0 REST server, for reproducible joint
// tests (e.g. with dsh-strata). Not shipped in the npm package.
//
// Run:   node scripts/mock-mem0-server.mjs
// Env:   MOCK_MEM0_PORT  listen port on 127.0.0.1 (default 18891)
//        MOCK_MEM0_KEY   if set, requests must send this value as X-API-Key
//        MOCK_MEM0_USER  user id the seed memories belong to (default dsh-mem0-test-user)
//
// Point DSH-Mem0 at it with `backend: server`, `baseUrl: http://127.0.0.1:18891`,
// `authType: apiKey`, `apiKeyEnv: <var holding MOCK_MEM0_KEY>`, and the same
// `userId`. Inspection endpoints (no auth):
//   GET  /__captures  every POST /memories body, verbatim (check capture text)
//   GET  /__log       request log and memory count
//   POST /__reset     restore the seed state
import http from 'node:http'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.MOCK_MEM0_PORT || 18891)
const KEY = process.env.MOCK_MEM0_KEY || ''
const USER = process.env.MOCK_MEM0_USER || 'dsh-mem0-test-user'

// Distinct topics so different questions recall different memories.
const SEED = [
  'Prefers concise answers',
  'Uses pnpm and Node 22 for JavaScript projects',
  'Works on the DSH-Mem0 plugin for DeepSeek Harness',
  'Works on the dsh-strata context plugin',
  'Runs a local Qdrant at 127.0.0.1:6333',
  'Likes oolong tea',
  'Lives in the UTC+8 time zone',
  'Writes release notes in English and Chinese',
  'Prefers GitHub Releases plus npm for publishing',
  'Uses a passkey for npm two-factor authentication',
  'Tests DSH plugins in a temporary DSH_HOME',
  'Reviews pull requests before merging',
]

let store
let captures
let log

function reset() {
  store = new Map()
  captures = []
  log = []
  const now = Date.now()
  SEED.forEach((memory, index) => {
    const id = randomUUID()
    const at = new Date(now - (index + 1) * 86_400_000).toISOString()
    store.set(id, { id, memory, user_id: USER, agent_id: 'dsh', metadata: { source: 'dsh' }, created_at: at, updated_at: at })
  })
}

function terms(text) {
  const lower = String(text ?? '').toLowerCase()
  const words = lower.match(/[a-z0-9]+/g) ?? []
  const han = lower.match(/[㐀-鿿]/g) ?? []
  return new Set([...words.filter((word) => word.length > 1), ...han])
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function matchesFilters(memory, filters = {}) {
  if (filters.user_id && memory.user_id !== filters.user_id) return false
  if (filters.agent_id && memory.agent_id && memory.agent_id !== filters.agent_id) return false
  return true
}

reset()

const server = http.createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const url = new URL(req.url, 'http://127.0.0.1')
  log.push(`${req.method} ${url.pathname}`)

  if (url.pathname === '/__captures') return json(res, 200, { captures })
  if (url.pathname === '/__log') return json(res, 200, { log, count: store.size })
  if (url.pathname === '/__reset' && req.method === 'POST') {
    reset()
    return json(res, 200, { ok: true })
  }
  if (KEY && req.headers['x-api-key'] !== KEY) return json(res, 401, { detail: 'invalid api key' })

  let body
  try {
    body = raw ? JSON.parse(raw) : undefined
  } catch {
    return json(res, 400, { detail: 'invalid json' })
  }

  if (req.method === 'POST' && url.pathname === '/search') {
    const wanted = terms(body?.query)
    const results = [...store.values()]
      .filter((memory) => matchesFilters(memory, body?.filters))
      .map((memory) => {
        const have = terms(memory.memory)
        const hits = [...wanted].filter((term) => have.has(term)).length
        return { ...memory, score: wanted.size ? hits / wanted.size : 0 }
      })
      .filter((memory) => memory.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, body?.top_k ?? 5)
    return json(res, 200, { results })
  }

  if (req.method === 'POST' && url.pathname === '/memories') {
    captures.push({ at: new Date().toISOString(), body })
    const text = (body?.messages ?? []).map((message) => `${message.role}: ${message.content}`).join('\n')
    const id = randomUUID()
    const at = new Date().toISOString()
    store.set(id, {
      id,
      memory: text.slice(0, 500),
      user_id: body?.user_id,
      agent_id: body?.agent_id,
      metadata: body?.metadata ?? {},
      created_at: at,
      updated_at: at,
    })
    return json(res, 200, { results: [{ id, memory: text.slice(0, 500), event: 'ADD' }] })
  }

  if (req.method === 'GET' && url.pathname === '/memories') {
    const filters = Object.fromEntries(url.searchParams)
    const limit = Number(filters.top_k || 1000)
    const results = [...store.values()].filter((memory) => matchesFilters(memory, filters)).slice(0, limit)
    return json(res, 200, { results })
  }

  const match = url.pathname.match(/^\/memories\/([^/]+)$/)
  if (match) {
    const id = decodeURIComponent(match[1])
    const memory = store.get(id)
    if (!memory) return json(res, 404, { detail: 'not found' })
    if (req.method === 'GET') return json(res, 200, memory)
    if (req.method === 'PUT') {
      const next = { ...memory, ...(body?.text ? { memory: body.text } : {}), ...(body?.metadata ? { metadata: body.metadata } : {}), updated_at: new Date().toISOString() }
      store.set(id, next)
      return json(res, 200, next)
    }
    if (req.method === 'DELETE') {
      store.delete(id)
      return json(res, 200, { message: 'deleted' })
    }
  }

  return json(res, 404, { detail: `no route for ${req.method} ${url.pathname}` })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-mem0 listening on http://127.0.0.1:${PORT} (user ${USER}${KEY ? ', api key required' : ''})`)
})

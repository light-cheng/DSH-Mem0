import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { CircuitBreaker, Mem0SidecarClient } from '../lib/sidecar-client.js'

async function withServer(handler, fn) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    return await fn(port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('sidecar client sends the per-process token and parses JSON', async () => {
  const client = new Mem0SidecarClient({
    pythonPath: '/usr/bin/false',
    mem0ConfigPath: '/not-used',
    historyDbPath: '/not-used',
    collectionName: 'dsh_mem0',
    userId: 'dsh-user',
    agentId: 'dsh',
    requestTimeoutMs: 2_000,
  })
  await withServer(
    (req, res) => {
      assert.equal(req.headers['x-dsh-mem0-token'], client.token)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    },
    async (port) => {
      client.port = port
      client.ready = true
      client.child = {}
      const result = await client.request('GET', '/health')
      assert.deepEqual(result, { ok: true })
    },
  )
})

test('sidecar client maps HTTP errors into Mem0SidecarError', async () => {
  const client = new Mem0SidecarClient({
    pythonPath: '/usr/bin/false',
    mem0ConfigPath: '/not-used',
    historyDbPath: '/not-used',
    collectionName: 'dsh_mem0',
    userId: 'dsh-user',
    agentId: 'dsh',
    requestTimeoutMs: 2_000,
  })
  await withServer(
    (_req, res) => {
      res.statusCode = 503
      res.end(JSON.stringify({ error: 'Qdrant unavailable' }))
    },
    async (port) => {
      client.port = port
      client.ready = true
      client.child = {}
      await assert.rejects(
        () => client.request('GET', '/health'),
        /Qdrant unavailable/,
      )
    },
  )
})

test('circuit breaker opens after the threshold and closes after cooldown', () => {
  let now = 1_000
  const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 500, now: () => now })
  assert.equal(breaker.isOpen(), false)
  breaker.recordFailure()
  assert.equal(breaker.isOpen(), false)
  breaker.recordFailure()
  assert.equal(breaker.isOpen(), true)
  now += 499
  assert.equal(breaker.isOpen(), true)
  now += 2
  assert.equal(breaker.isOpen(), false)
  assert.equal(breaker.failures, 0)
})

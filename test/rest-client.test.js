import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { localServerTest } from './fixtures/local-listen.js'
import { Mem0RestClient } from '../lib/rest-client.js'

async function withServer(handler, fn) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

localServerTest('platform client uses Token auth and v3 search path', async () => {
  let seen
  await withServer(
    (req, res) => {
      seen = { method: req.method, url: req.url, auth: req.headers.authorization }
      json(res, 200, { results: [{ id: 'm1', memory: 'Likes tea', score: 0.9 }] })
    },
    async (baseUrl) => {
      const client = new Mem0RestClient({
        mode: 'platform',
        baseUrl,
        apiKey: 'x',
        userId: 'dsh-user',
        agentId: 'dsh',
      })
      const result = await client.search('tea', { user_id: 'dsh-user' }, { topK: 3 })
      assert.equal(result.results[0].memory, 'Likes tea')
      assert.equal(seen.method, 'POST')
      assert.equal(seen.url, '/v3/memories/search/')
      assert.equal(seen.auth, 'Token x')
    },
  )
})

localServerTest('platform add maps an async PENDING response to a queued result', async () => {
  await withServer(
    (_req, res) => json(res, 200, { event_id: 'evt-1', status: 'PENDING' }),
    async (baseUrl) => {
      const client = new Mem0RestClient({
        mode: 'platform',
        baseUrl,
        apiKey: 'x',
        userId: 'dsh-user',
        agentId: 'dsh',
      })
      const result = await client.add([{ role: 'user', content: 'remember me' }], {
        userId: 'dsh-user',
        agentId: 'dsh',
        infer: true,
      })
      assert.equal(result.queued, true)
      assert.equal(result.eventId, 'evt-1')
    },
  )
})

localServerTest('server client uses X-API-Key and the self-hosted routes', async () => {
  const requests = []
  await withServer(
    (req, res) => {
      requests.push({ method: req.method, url: req.url, key: req.headers['x-api-key'] })
      if (req.url.startsWith('/search')) json(res, 200, { results: [{ id: 'm2', memory: 'Local fact' }] })
      else json(res, 200, { results: [] })
    },
    async (baseUrl) => {
      const client = new Mem0RestClient({
        mode: 'server',
        baseUrl,
        apiKey: 'server-key',
        authType: 'apiKey',
        userId: 'dsh-user',
        agentId: 'dsh',
      })
      const result = await client.search('fact', { user_id: 'dsh-user' }, { topK: 2 })
      assert.equal(result.results[0].id, 'm2')
      assert.equal(requests[0].url, '/search')
      assert.equal(requests[0].key, 'server-key')
    },
  )
})

test('client refuses to call Platform without an API key', async () => {
  const client = new Mem0RestClient({
    mode: 'platform',
    baseUrl: 'https://api.mem0.ai',
    apiKey: '',
    userId: 'dsh-user',
    agentId: 'dsh',
  })
  await assert.rejects(() => client.search('x', { user_id: 'dsh-user' }), /API key is not configured/)
})

localServerTest('client maps HTTP errors without echoing the API key', async () => {
  await withServer(
    (_req, res) => json(res, 401, { detail: 'Invalid API key.' }),
    async (baseUrl) => {
      const client = new Mem0RestClient({
        mode: 'platform',
        baseUrl,
        apiKey: 'super-secret',
        userId: 'dsh-user',
        agentId: 'dsh',
      })
      await assert.rejects(
        () => client.search('x', { user_id: 'dsh-user' }),
        (error) => {
          assert.match(error.message, /Invalid API key/)
          assert.doesNotMatch(error.message, /super-secret/)
          return true
        },
      )
    },
  )
})

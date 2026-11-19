#!/usr/bin/env node
// Stand-in for python/mem0_sidecar.py in tests. Behaviour comes from env:
//   FAKE_SIDECAR_MODE  ready | crash | silent | chatty | serve   (default ready)
//     crash: write a traceback-like stderr line (with a fake key and a home
//     path, to test redaction), then exit 3 before the ready line
//     serve: listen on 127.0.0.1 for real; POST /add answers
//     {"results": []} unless FAKE_SIDECAR_ADD=die, which SIGKILLs this
//     process while the request is in flight
//     chatty: after the ready line, write 1 MB to stderr, then append
//     {"stderrDone": true} to FAKE_SIDECAR_RECORD once it is all written
//     nomem0: write a Python traceback ending in ModuleNotFoundError for
//     mem0 to stderr, then exit 1 before the ready line (no JSON line)
//     stubborn: become ready, then ignore SIGTERM (only SIGKILL stops it)
//   FAKE_SIDECAR_DELAY_MS  delay before the ready line
//   FAKE_SIDECAR_PORT  port the ready line reports (default 9, which fetch
//     refuses as a "bad port"; tests that need ECONNREFUSED pick another)
//   FAKE_SIDECAR_RECORD  file to append one JSON line per spawn to
// It never listens on a port (the sandbox may forbid it); the ready line
// reports a port nobody serves, which is enough for startup tests.
import fs from 'node:fs'

// `node --test` also loads every script under test/; do nothing there.
if (!process.env.FAKE_SIDECAR_RECORD) process.exit(0)

const mode = process.env.FAKE_SIDECAR_MODE ?? 'ready'
const delay = Number(process.env.FAKE_SIDECAR_DELAY_MS ?? 0)
let token = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  token += chunk
})
process.stdin.on('end', () => {
  if (process.env.FAKE_SIDECAR_RECORD) {
    fs.appendFileSync(
      process.env.FAKE_SIDECAR_RECORD,
      `${JSON.stringify({ argv: process.argv.slice(2), env: process.env, token: token.split('\n')[0] })}\n`,
    )
  }
  if (mode === 'crash') {
    process.stderr.write('Traceback: ValueError: bad config api_key=sk-fakefakefake1234 in /Users/alice/.dsh/mem0/oss.json\n', () => process.exit(3))
    return
  }
  if (mode === 'nomem0') {
    process.stderr.write(
      'Traceback (most recent call last):\n  File "C:\\Users\\alice\\x\\mem0_sidecar.py", line 765, in __init__\n    from mem0.memory.main import Memory\nModuleNotFoundError: No module named \'mem0\'\n',
      () => process.exit(1),
    )
    return
  }
  if (mode === 'serve') {
    import('node:http').then(({ createServer }) => {
      const server = createServer((req, res) => {
        if (req.url === '/add' && process.env.FAKE_SIDECAR_ADD === 'die') {
          process.stderr.write('about to die mid-request\n', () => setTimeout(() => process.kill(process.pid, 'SIGKILL'), 50))
          return
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ results: [], summary: { facts: 0, add: 0, update: 0, delete: 0, none: 0 } }))
      })
      server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port, pid: process.pid })))
    })
    return
  }
  setTimeout(() => {
    if (mode === 'ready' || mode === 'chatty' || mode === 'stubborn') console.log(JSON.stringify({ port: Number(process.env.FAKE_SIDECAR_PORT ?? 9), pid: process.pid }))
    if (mode === 'chatty') {
      const line = `${'x'.repeat(1023)}\n`
      let left = 1024
      const writeMore = () => {
        while (left > 0) {
          left -= 1
          if (left === 0) {
            process.stderr.write(line, () => fs.appendFileSync(process.env.FAKE_SIDECAR_RECORD, `${JSON.stringify({ stderrDone: true })}\n`))
            return
          }
          if (!process.stderr.write(line)) {
            process.stderr.once('drain', writeMore)
            return
          }
        }
      }
      writeMore()
    }
  }, delay)
})
setInterval(() => {}, 1_000)
process.on('SIGTERM', () => {
  if (mode !== 'stubborn') process.exit(0)
  if (process.env.FAKE_SIDECAR_RECORD) fs.appendFileSync(process.env.FAKE_SIDECAR_RECORD, `${JSON.stringify({ ignoredTerm: true })}\n`)
})

#!/usr/bin/env node
// Stand-in for python/mem0_sidecar.py in tests. Behaviour comes from env:
//   FAKE_SIDECAR_MODE  ready | crash | silent   (default ready)
//   FAKE_SIDECAR_DELAY_MS  delay before the ready line
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
  if (mode === 'crash') process.exit(1)
  setTimeout(() => {
    if (mode === 'ready') console.log(JSON.stringify({ port: 9, pid: process.pid }))
  }, delay)
})
setInterval(() => {}, 1_000)
process.on('SIGTERM', () => process.exit(0))

import test from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets, truncateForCapture } from '../lib/redact.js'

test('redacts common credential forms', () => {
  assert.equal(redactSecrets('api_key=supersecret'), 'api_key=[REDACTED]')
  assert.equal(redactSecrets('Authorization: Bearer abc123'), 'Authorization: Bearer [REDACTED]')
  assert.equal(redactSecrets('m0sk_abcdefghijklmnop'), '[REDACTED]')
  assert.equal(redactSecrets('sk-abcdefghijklmnop'), '[REDACTED]')
})

test('redacts Tavily keys', () => {
  assert.equal(redactSecrets('key tvly-dev-AbCdEf0123456789xyz'), 'key [REDACTED]')
})

test('redacts Google API keys', () => {
  const key = `AIza${'Sy0123456789abcdefghijklmnopqrstuvw_-'.slice(0, 35)}`
  assert.equal(key.length, 39)
  assert.equal(redactSecrets(`GOOGLE=${key} done`), 'GOOGLE=[REDACTED] done')
})

test('redacts JWTs', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
  assert.equal(redactSecrets(`token ${jwt}.`), 'token [REDACTED].')
})

test('redacts a bare Bearer token', () => {
  assert.equal(
    redactSecrets('curl -H "Bearer abcDEF1234567890ghij" url'),
    'curl -H "Bearer [REDACTED]" url',
  )
})

test('redacts credentials in URLs', () => {
  assert.equal(
    redactSecrets('db is postgres://admin:hunter2@db.local:5432/app'),
    'db is postgres://admin:[REDACTED]@db.local:5432/app',
  )
  assert.equal(
    redactSecrets('https://user:p4ss@example.com/x'),
    'https://user:[REDACTED]@example.com/x',
  )
})

test('redacts Chinese password phrasing', () => {
  assert.equal(redactSecrets('服务器密码：abc123，记住'), '服务器密码：[REDACTED]，记住')
  assert.equal(redactSecrets('WiFi 密码是 Hunter2!'), 'WiFi 密码是 [REDACTED]')
  assert.equal(redactSecrets('口令为x9y8z7。'), '口令为[REDACTED]。')
  assert.equal(redactSecrets('密码: s3cret'), '密码: [REDACTED]')
})

test('leaves ordinary text alone', () => {
  const samples = [
    'The bearer of this letter is my friend.',
    'Bearer bonds were popular in the 1980s.',
    'Visit https://example.com:8080/path@section for docs.',
    'Email me at someone@example.com.',
    'git@github.com:light-cheng/DSH-Mem0.git',
    '我忘了密码是什么，需要重置。',
    '密码学是一门有趣的学科。',
    'AIza is a prefix used by Google keys.',
    'eyJ alone is not a token.',
    'tvly-short',
    'The ratio was 3.14.15 in version 1.2.3.',
  ]
  for (const sample of samples) assert.equal(redactSecrets(sample), sample, sample)
})

test('truncates long text at a sentence boundary when possible', () => {
  const text = `${'a'.repeat(200)}。${'b'.repeat(400)}`
  const result = truncateForCapture(text, 300)
  assert.ok(result.length <= 300)
  assert.ok(result.endsWith('。'))
})

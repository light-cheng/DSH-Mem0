import test from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets, truncateForCapture } from '../lib/redact.js'

test('redacts common credential forms', () => {
  assert.equal(redactSecrets('api_key=supersecret'), 'api_key=[REDACTED]')
  assert.equal(redactSecrets('Authorization: Bearer abc123'), 'Authorization: Bearer [REDACTED]')
  assert.equal(redactSecrets('m0sk_abcdefghijklmnop'), '[REDACTED]')
  assert.equal(redactSecrets('sk-abcdefghijklmnop'), '[REDACTED]')
})

test('truncates long text at a sentence boundary when possible', () => {
  const text = `${'a'.repeat(200)}。${'b'.repeat(400)}`
  const result = truncateForCapture(text, 300)
  assert.ok(result.length <= 300)
  assert.ok(result.endsWith('。'))
})

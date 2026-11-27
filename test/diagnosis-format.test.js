// Contract test for diagnosis block format 1 (lib/diagnose-report.js).
//
// dsh-strata copies test/fixtures/diagnosis-format-1.json and
// lib/diagnose-report.js verbatim, so this test reads only the fixture and
// that module: a case that fails here fails the same way in Strata.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  DIAGNOSIS_EXTRA_KEY,
  DIAGNOSIS_EXTRA_MAX,
  DIAGNOSIS_FORMAT_VERSION,
  buildDiagnosisPrompt,
  diagnosisBlock,
  diagnosisExtra,
  diagnosisFacts,
} from '../lib/diagnose-report.js'

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/diagnosis-format-1.json', import.meta.url), 'utf8'))

function render({ plugin, version, kind, entry, facts, extra }) {
  return diagnosisBlock(entry ? diagnosisFacts(entry) : facts, { plugin, version, kind, extra }).split('\n')
}

test('the fixture is format 1', () => {
  assert.equal(fixture.format, DIAGNOSIS_FORMAT_VERSION)
  assert.ok(fixture.cases.length >= 6)
})

for (const { name, input, expected } of fixture.cases) {
  test(`format 1: ${name}`, () => {
    assert.deepEqual(render(input), expected)
  })
}

test('every block in the fixture has kind, and its x. fields follow the rules', () => {
  for (const { name, expected } of fixture.cases) {
    assert.match(expected[0], / kind="(failure|status)" format="1">$/, name)
    assert.equal(expected.at(-1), '</dsh-diagnosis>', name)
    const body = expected.slice(1, -1)
    const keys = body.map((line) => line.slice(0, line.indexOf(':')))
    const extra = keys.filter((key) => key.startsWith('x.'))
    assert.ok(extra.length <= DIAGNOSIS_EXTRA_MAX, name)
    for (const key of extra) assert.match(key, DIAGNOSIS_EXTRA_KEY, name)
    // x. fields come after every standard field.
    const first = keys.findIndex((key) => key.startsWith('x.'))
    if (first >= 0) assert.ok(keys.slice(first).every((key) => key.startsWith('x.')), name)
    for (const line of body) assert.doesNotMatch(line, /</, name)
  }
})

test('the fixture covers failure, status, bad keys, the cap, newline and <, and host:port', () => {
  const names = fixture.cases.map((entry) => entry.name).join('\n')
  for (const topic of [/failure block/, /status block with x\. fields/, /illegal x\. keys/, /more than 12/, /newline and </, /host:port/]) assert.match(names, topic)
})

test('the Strata example uses its x. fields and puts the version in the header', () => {
  const strata = fixture.cases.find((entry) => entry.input.plugin === 'dsh-strata' && entry.input.version)
  assert.ok(strata)
  assert.match(strata.expected[0], /^<dsh-diagnosis plugin="dsh-strata" version="[^"]+" kind="status" format="1">$/)
  const keys = strata.expected.slice(1, -1).map((line) => line.slice(0, line.indexOf(':')))
  assert.deepEqual(keys, ['x.mode', 'x.mode_source', 'x.auto_fold_pct', 'x.context_pct', 'x.fold_count', 'x.last_issue', 'x.last_issue_at', 'x.conflict', 'x.settings_reset'])
})

test('extra takes an object or a list of pairs, and anything else gives no fields', () => {
  assert.deepEqual(diagnosisExtra({ 'x.a': 'one' }), [['x.a', 'one']])
  assert.deepEqual(diagnosisExtra([['x.a', 'one']]), [['x.a', 'one']])
  for (const value of [undefined, null, 'x.a: one', 42, [null, 'x.a']]) assert.deepEqual(diagnosisExtra(value), [])
})

test('the failure prompt writes a failure block and passes extra through', () => {
  const entry = { at: '2026-11-27T08:15:02Z', cause: 'timeout', component: 'server', kind: 'recall', count: 1 }
  const { text } = buildDiagnosisPrompt(entry, { plugin: 'dsh-x', version: '1.0.0', extra: { 'x.retry': 2, 'bad key': 'dropped' } })
  assert.match(text, /<dsh-diagnosis plugin="dsh-x" version="1\.0\.0" kind="failure" format="1">\n/)
  assert.match(text, /last_at: 2026-11-27T08:15:02\.000Z\nx\.retry: 2\n<\/dsh-diagnosis>/)
  assert.doesNotMatch(text, /bad key/)
})

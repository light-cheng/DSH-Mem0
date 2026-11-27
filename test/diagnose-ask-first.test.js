// The diagnosis draft asks the user first, then follows the checklist of its
// failure type (lib/diagnose-report.js, lib/diagnose-kb.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { buildDiagnosisPrompt, DEFAULT_QUESTION_TOOL, diagnosisQuestions, isUnclearFailure } from '../lib/diagnose-report.js'
import {
  checklistFor,
  DIAGNOSE_SECTIONS,
  DIAGNOSE_SKILL,
  DIAGNOSE_SYMPTOMS,
  diagnoseSkillContent,
  inDiagnoseDirectory,
  registerDiagnoseSkill,
  sectionFor,
} from '../lib/diagnose-kb.js'
import { prepareDiagnosis } from '../lib/diagnose-routes.js'
import { DiagnoseSessions } from '../lib/diagnose-sessions.js'
import { FAILURE_CAUSES, sanitizeFailureMessage } from '../lib/failure-history.js'

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-ask-first-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz123456'
const KNOWN = ['timeout', 'connection', 'auth', 'circuit', 'extraction', 'startup', 'config']

function failure(cause, extra = {}) {
  return {
    at: '2026-11-27T10:00:00.000Z',
    kind: 'capture',
    backend: 'oss',
    cause,
    component: 'llm',
    endpoint: '127.0.0.1:3425',
    message: `failed from /Users/someone/proj with api_key=${SECRET}`,
    detail: 'the gateway echoed: my password is hunter2',
    ...extra,
  }
}

function runtimeFor(t, entry, { skill = false } = {}) {
  return {
    profileDir: tmpDir(t),
    failures: { list: () => [entry] },
    diagnoseSessions: new DiagnoseSessions(),
    diagnoseSkill: { ready: skill, lang: 'en' },
  }
}

// ---- the questions ----------------------------------------------------------

test('every failure type has a checklist section; the sections are exactly the failure types', () => {
  assert.deepEqual([...DIAGNOSE_SECTIONS].sort(), [...FAILURE_CAUSES].sort())
  for (const cause of FAILURE_CAUSES) {
    assert.equal(sectionFor({ cause }), cause)
    for (const lang of ['zh', 'en']) assert.ok(checklistFor({ cause }, { lang }).length >= 3, `${cause} ${lang}`)
  }
  assert.equal(sectionFor({ cause: 'made-up' }), 'other')
  assert.equal(sectionFor(null), 'other')
})

test('a known type asks what changed and how much it hurts, never what went wrong', () => {
  for (const cause of KNOWN) {
    const entry = failure(cause)
    assert.equal(isUnclearFailure(entry), false, cause)
    const zh = diagnosisQuestions(entry, { lang: 'zh', feature: '记忆' })
    assert.deepEqual(zh.map((q) => q.id), ['changes', 'impact'], cause)
    assert.equal(zh[0].multiSelect, true)
    assert.equal(zh[1].multiSelect, false)
    assert.deepEqual(zh[0].options, ['换了 API key', '换了服务商或模型', '改了网络或代理', '升级了 DSH 或插件', '什么都没改', '不确定'])
    assert.deepEqual(zh[1].options, ['记忆完全不工作', '偶尔失败', '只看到报错，其实没影响', '不确定'])
    const en = diagnosisQuestions(entry, { lang: 'en', feature: 'Memory' })
    assert.equal(en[1].options[0], 'Memory does not work at all')
    for (const q of [...zh, ...en]) assert.match(q.options.at(-1), /^(不确定|Not sure)$/)
  }
})

test('only an other or unknown-component failure asks what the user sees first', () => {
  const cases = [failure('other'), failure('timeout', { component: 'unknown' }), failure('other', { component: undefined })]
  for (const entry of cases) {
    assert.equal(isUnclearFailure(entry), true)
    const questions = diagnosisQuestions(entry, { lang: 'zh', symptoms: DIAGNOSE_SYMPTOMS.zh })
    assert.deepEqual(questions.map((q) => q.id), ['symptom', 'changes'])
    assert.deepEqual(questions[0].options, [...DIAGNOSE_SYMPTOMS.zh, '不确定'])
  }
  // Without the plugin's own words, generic ones; still ending in "not sure".
  assert.deepEqual(diagnosisQuestions(failure('other'), { lang: 'en' })[0].options.at(-1), 'Not sure')
})

test('the draft starts with one ask_user_question call; known types are told not to ask what went wrong', (t) => {
  for (const cause of [...KNOWN, 'other']) {
    const entry = failure(cause)
    const { body } = prepareDiagnosis(runtimeFor(t, entry), { failure: entry, lang: 'zh' })
    for (const text of [body.text, body.copyText]) {
      const [, steps] = text.split('做法：')
      assert.match(steps, /^\n1\. 先提问：第一步只调用 ask_user_question/, cause)
      assert.ok(steps.indexOf('ask_user_question') < steps.indexOf('2. 再排查'), cause)
      assert.match(steps, /「最近改过什么？」（可多选）：换了 API key／换了服务商或模型／改了网络或代理／升级了 DSH 或插件／什么都没改／不确定/)
      if (cause === 'other') {
        assert.match(steps, /「你看到的现象是？」：新内容没记住／想不起以前的记忆／设置页或底部栏报错／对话明显变慢／不确定/)
        assert.doesNotMatch(steps, /现在影响多大|不要再问出了什么问题/)
      } else {
        assert.match(steps, /「现在影响多大？」：记忆完全不工作／偶尔失败／只看到报错，其实没影响／不确定/)
        assert.match(steps, /不要再问出了什么问题/)
        assert.doesNotMatch(steps, /你看到的现象/)
      }
      assert.match(steps, /3\. 话要短/)
      assert.match(steps, /定位不了就如实说/)
      assert.match(steps, /由我自己去改/)
      assert.match(steps, /工具调用尽量控制在 10 次以内/)
      // Nothing is sent to an official feedback channel in this version.
      assert.doesNotMatch(text, /反馈|feedback/i)
    }
  }
  assert.equal(DEFAULT_QUESTION_TOOL, 'ask_user_question')
  const english = buildDiagnosisPrompt(failure('timeout'), { lang: 'en', questions: { tool: 'ask_user', feature: 'Memory' } }).text
  assert.match(english, /1\. Ask first: your first step is a single ask_user call with both questions below/)
  assert.match(english, /do not ask what went wrong/)
})

// ---- the checklist ------------------------------------------------------------

test('copied text carries the checklist of its own type only, in order', (t) => {
  for (const cause of FAILURE_CAUSES) {
    const entry = failure(cause)
    const { body } = prepareDiagnosis(runtimeFor(t, entry), { failure: entry, lang: 'zh' })
    const own = checklistFor(entry, { lang: 'zh' })
    assert.match(body.copyText, new RegExp(`按下面「${cause}」的顺序查`))
    let last = -1
    own.forEach((line, index) => {
      const at = body.copyText.indexOf(`   ${index + 1}) ${line}`)
      assert.ok(at > last, `${cause}: line ${index + 1} in order`)
      last = at
    })
    for (const other of FAILURE_CAUSES.filter((name) => name !== cause)) {
      for (const line of checklistFor({ cause: other }, { lang: 'zh' }).filter((text) => !own.includes(text))) {
        assert.ok(!body.copyText.includes(line), `${cause} must not carry ${other}: ${line}`)
      }
    }
    assert.doesNotMatch(body.copyText, new RegExp(DIAGNOSE_SKILL))
  }
})

test('each checklist starts where the brief says', () => {
  const first = (cause, extra) => checklistFor({ cause, ...extra }, { lang: 'zh' })[0]
  for (const cause of ['timeout', 'connection', 'extraction', 'startup', 'config']) assert.match(first(cause), /^调用一次 mem0_status/, cause)
  assert.match(first('auth'), /^先看 http_status：401 或 403 是 key 被拒；429/)
  assert.match(first('circuit'), /^熔断本身不是原因/)
  assert.match(checklistFor({ cause: 'circuit' }, { lang: 'zh' })[1], /failures\.json/)
  assert.match(first('other'), /^先按用户说的现象定方向/)
  assert.match(checklistFor({ cause: 'other' }, { lang: 'zh' }).join('\n'), /mem0_status[\s\S]*5xx[\s\S]*failures\.json[\s\S]*如实说/)
  assert.match(checklistFor({ cause: 'connection' }, { lang: 'en' }).join('\n'), /refused[\s\S]*lsof -nP -iTCP:<port> -sTCP:LISTEN[\s\S]*NO_PROXY/)
  assert.match(checklistFor({ cause: 'timeout' }, { lang: 'en' }).join('\n'), /recallTimeoutMs for recall \(default 5000\)[\s\S]*addTimeoutMs for saving \(default 120000\)[\s\S]*timeoutMs otherwise \(default 30000\)/)
})

test('an extraction failure gets the lines of its own reason only', () => {
  const notJson = checklistFor({ cause: 'extraction', reason: 'not_json' }, { lang: 'zh' }).join('\n')
  assert.match(notJson, /not_json/)
  assert.doesNotMatch(notJson, /truncated|empty|refusal/)
  const truncated = checklistFor({ cause: 'extraction', reason: 'truncated' }, { lang: 'en' }).join('\n')
  assert.match(truncated, /llmMaxTokens \(default 8000\)/)
  assert.doesNotMatch(truncated, /not_json|refusal/)
  // No reason known: every reason line.
  const all = checklistFor({ cause: 'extraction' }, { lang: 'en' }).join('\n')
  for (const reason of ['not_json', 'truncated', 'empty', 'refusal']) assert.match(all, new RegExp(reason))
})

test('with the skill offered, the draft points at its section instead of carrying the list', (t) => {
  for (const cause of FAILURE_CAUSES) {
    const entry = failure(cause, { reason: cause === 'extraction' ? 'not_json' : undefined })
    const { body } = prepareDiagnosis(runtimeFor(t, entry, { skill: true }), { failure: entry, lang: 'zh' })
    assert.match(body.text, new RegExp(`2\\. 再排查：调用技能 ${DIAGNOSE_SKILL}，只照「${cause}」一节的顺序查`))
    for (const line of checklistFor(entry, { lang: 'zh' })) assert.ok(!body.text.includes(line), `${cause}: draft carries no list line`)
    // Copied text may be pasted where the skill is not offered.
    assert.doesNotMatch(body.copyText, new RegExp(DIAGNOSE_SKILL))
    assert.match(body.copyText, new RegExp(`按下面「${cause}」的顺序查`))
  }
  // Without DSH's skill registry the draft carries the list too.
  const entry = failure('timeout')
  const { body } = prepareDiagnosis(runtimeFor(t, entry, { skill: false }), { failure: entry, lang: 'en' })
  assert.doesNotMatch(body.text, new RegExp(DIAGNOSE_SKILL))
  assert.match(body.text, /Then check, in this order \("timeout"\)/)
})

// ---- redaction stays as it was --------------------------------------------------

test('the new steps change no redaction: no key, home path, detail or memory text in any draft', (t) => {
  for (const cause of FAILURE_CAUSES) {
    for (const skill of [true, false]) {
      for (const lang of ['zh', 'en']) {
        const entry = failure(cause, { memory: 'User likes green tea', apiKey: SECRET })
        const { body } = prepareDiagnosis(runtimeFor(t, entry, { skill }), { failure: entry, lang })
        for (const text of [body.text, body.copyText]) {
          assert.doesNotMatch(text, /gdbznebdvbicthhjmuzqybhvqv|hunter2|green tea|\/Users\/someone/)
          assert.match(text, /api_key=\[REDACTED\]/)
          assert.match(text, /~\/proj/)
          assert.equal(text.match(/<\/dsh-diagnosis>/g).length, 1)
        }
      }
    }
  }
  // The same allow-list as before: the facts are what diagnosisFacts gives.
  const entry = failure('auth', { status: 401 })
  const built = buildDiagnosisPrompt(entry, { sanitize: (text) => sanitizeFailureMessage(text, { home: '/Users/someone' }) })
  assert.deepEqual(built.facts.map(([key]) => key), ['type', 'component', 'operation', 'backend', 'endpoint', 'http_status', 'message', 'count', 'last_at'])
})

test('the shared report module stays free of Mem0', () => {
  const source = fs.readFileSync(new URL('../lib/diagnose-report.js', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1])
  assert.deepEqual(imports, ['node:crypto'])
  // Plugin and tool names are parameters; no Mem0 name is written in.
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, ''), /mem0/i)
})

// ---- the skill ----------------------------------------------------------------

function fakeSkills() {
  const providers = []
  return {
    providers,
    registerProvider(factory) {
      const provider = factory({ signal: new AbortController().signal, invalidate() {} })
      providers.push(provider)
      return () => providers.splice(providers.indexOf(provider), 1)
    },
  }
}

test('the skill is offered in the diagnosis folder only and holds every section', async (t) => {
  const dir = tmpDir(t)
  const folder = path.join(dir, 'dsh-mem0', 'mem0-diagnosis')
  fs.mkdirSync(path.join(folder, 'sub'), { recursive: true })
  fs.symlinkSync(folder, path.join(dir, 'link'))
  const skills = fakeSkills()
  let ready = false
  let lang = 'zh'
  registerDiagnoseSkill({ inject: (names, fn) => names.includes('skills') && fn({ skills }) }, {
    directory: () => folder,
    lang: () => lang,
    onReady: () => {
      ready = true
    },
  })
  assert.equal(ready, true)
  const [provider] = skills.providers
  assert.equal(provider.name, 'dsh-mem0')
  for (const cwd of [folder, path.join(folder, 'sub'), path.join(dir, 'link')]) {
    const [candidate] = await provider.list({ cwd })
    assert.equal(candidate?.name, DIAGNOSE_SKILL, cwd)
    assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: false })
  }
  for (const cwd of [dir, path.join(dir, 'dsh-mem0'), `${folder}-other`, os.homedir(), undefined]) {
    assert.deepEqual(await provider.list({ cwd }), [], String(cwd))
  }
  const [candidate] = await provider.list({ cwd: folder })
  const zh = await provider.get(candidate, { cwd: folder })
  assert.equal(zh.name, DIAGNOSE_SKILL)
  for (const section of DIAGNOSE_SECTIONS) assert.match(zh.content, new RegExp(`^## ${section}（`, 'm'))
  assert.match(zh.content, /通用规则[\s\S]*10 次以内[\s\S]*不要通读插件源码[\s\S]*由用户自己改/)
  lang = 'en'
  const en = await provider.get(candidate, { cwd: folder })
  assert.match(en.content, /^## timeout \(timeout\)$/m)
  assert.equal(await provider.get({ ...candidate, name: 'something-else' }, {}), undefined)
  // Every list line of every section is in the body, in order.
  for (const section of DIAGNOSE_SECTIONS) {
    const lines = checklistFor({ cause: section }, { lang: 'en' })
    let last = en.content.indexOf(`## ${section} (`)
    for (const line of lines) {
      const at = en.content.indexOf(line)
      assert.ok(at > last, `${section}: ${line}`)
      last = at
    }
  }
  assert.doesNotMatch(diagnoseSkillContent({ lang: 'zh' }) + diagnoseSkillContent({ lang: 'en' }), /\/Users\/|sk-[a-z0-9]{10}/)
})

test('without the skill registry nothing is offered and the draft keeps its list', () => {
  let ready = false
  registerDiagnoseSkill({ inject: (names, fn) => fn({}) }, { directory: () => '/x', onReady: () => (ready = true) })
  registerDiagnoseSkill({}, { directory: () => '/x', onReady: () => (ready = true) })
  assert.equal(ready, false)
  assert.equal(inDiagnoseDirectory('/a/b', null), false)
  assert.equal(inDiagnoseDirectory(undefined, '/a'), false)
})

test('apply offers the skill for the profile\'s diagnosis folder', async (t) => {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('network disabled in diagnose-ask-first.test.js')
  }
  t.after(() => {
    globalThis.fetch = original
  })
  const dir = tmpDir(t)
  const skills = fakeSkills()
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    get: (key) => (key === 'profileContext' ? { dir } : undefined),
    inject(names, fn) {
      if (names.length === 1 && names[0] === 'skills') fn({ skills })
    },
    on() {},
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    fiber: { restart: async () => {} },
    systemPrompt: { section: () => () => {} },
    tools: { register: () => () => {} },
  }
  t.after(() => {
    for (const dispose of disposers.splice(0)) dispose()
  })
  await apply(ctx, { backend: 'platform', apiKey: 'm0-test', userId: 'dsh-mem0-diagnose-test-user', hygieneEnabled: false })
  assert.equal(skills.providers.length, 1)
  const folder = path.join(dir, 'dsh-mem0', 'mem0-diagnosis')
  fs.mkdirSync(folder, { recursive: true })
  assert.equal((await skills.providers[0].list({ cwd: folder }))[0]?.name, DIAGNOSE_SKILL)
  assert.deepEqual(await skills.providers[0].list({ cwd: dir }), [])
})

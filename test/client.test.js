import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

// Evaluate client.js the way the host does: it calls
// window.__ModuleLoader__.load({ id, factory }) and the host materializes the
// factory with its own `require`.
function loadClient() {
  let registered
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window })
  const react = { createElement: () => null, useCallback: (fn) => fn, useEffect() {}, useLayoutEffect() {}, useMemo: (fn) => fn(), useRef: () => ({}), useState: (v) => [v, () => {}] }
  const exports = registered.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require ${name}`)
  })
  return { id: registered.id, exports }
}

test('settings page dictionaries have the same keys in en and zh (G8)', () => {
  const { id, exports } = loadClient()
  assert.equal(id, 'dsh-mem0')
  const { en, zh } = exports.__test__
  const missingInZh = Object.keys(en).filter((key) => !(key in zh))
  const missingInEn = Object.keys(zh).filter((key) => !(key in en))
  assert.deepEqual(missingInZh, [])
  assert.deepEqual(missingInEn, [])
})

test('apply registers the one dictionary pair under the page namespace', () => {
  const { exports } = loadClient()
  const registered = []
  const ctx = {
    locale: { bind: () => (key) => key, register: (ns, dicts) => registered.push([ns, dicts]) },
    effect: (fn) => fn(),
    slots: { inject() {}, register() {} },
  }
  exports.apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0][0], 'dsh-mem0.settings')
  assert.equal(registered[0][1].en, exports.__test__.en)
  assert.equal(registered[0][1].zh, exports.__test__.zh)
})

test('page language comes from the host locale, not from a translated string (G8)', () => {
  const { pageLanguage } = loadClient().exports.__test__
  const ctxFor = (active, locales = []) => ({ locale: { getLocale: () => ({ active, locales }) } })
  assert.equal(pageLanguage(ctxFor('zh')), 'zh')
  assert.equal(pageLanguage(ctxFor('zh-TW')), 'zh')
  assert.equal(pageLanguage(ctxFor('en')), 'en')
  assert.equal(pageLanguage(ctxFor('ja', [{ id: 'ja', fallback: 'en' }])), 'en')
  assert.equal(pageLanguage(ctxFor('yue', [{ id: 'yue', fallback: 'zh' }])), 'zh')
  assert.equal(pageLanguage({}), 'en')
})

// ---- Activity details, circuit state and the sidecar block ----

// Arrays from the vm realm compare by value only after a copy.
const plain = (value) => JSON.parse(JSON.stringify(value))

function tFor(dict) {
  return (key) => dict[key] ?? key
}

test('activity details: skip reasons, circuit time left and cause, extraction counts, retry', () => {
  const { activityDetails, zh } = loadClient().exports.__test__
  const t = tFor(zh)
  const now = Date.parse('2026-11-06T06:00:00Z')
  const circuit = activityDetails(t, {
    status: 'skipped',
    reason: 'circuit-open',
    circuitUntil: '2026-11-06T06:01:30Z',
    trippedBy: { at: '2026-11-06T05:59:30Z', kind: 'capture', component: 'sidecar', message: 'POST /add failed: fetch failed' },
  }, now)
  assert.match(circuit[0], /熔断中/)
  assert.match(circuit[0], /1 min 30 s 后恢复/)
  assert.match(circuit[1], /自动保存 · Python sidecar（旧版本） · POST \/add failed: fetch failed/)
  assert.deepEqual(plain(activityDetails(t, { status: 'skipped', reason: 'low-value' })), ['内容太短或不值得记（保存过滤）'])
  assert.deepEqual(plain(activityDetails(t, { status: 'saved', facts: 1, add: 0, update: 0, delete: 0, none: 1 })), ['抽取 1 条：新增 0，更新 0，已存在 1'])
  assert.deepEqual(plain(activityDetails(t, { status: 'saved', facts: 0 })), ['没有抽取到新内容（不值得记，或已经记过）'])
  assert.deepEqual(plain(activityDetails(t, { status: 'saved', add: 2, update: 1, delete: 0 })), ['新增 2，更新 1，删除 0'])
  assert.deepEqual(plain(activityDetails(t, { status: 'saved', retry: 'saved' })), ['重试后已保存'])
  assert.deepEqual(plain(activityDetails(t, { status: 'error', retry: 'failed' })), ['重试仍失败'])
  // LLM extraction failures: the reason, and which retry is pending.
  assert.deepEqual(plain(activityDetails(t, { status: 'saving', retry: 'pending', retryReason: 'extraction', extractReason: 'truncated' })), ['LLM 回复不可用（回复被截断（JSON 不完整）），正在重试一次'])
  assert.deepEqual(plain(activityDetails(t, { status: 'saving', retry: 'pending' })), ['未送达，正在重试一次'])
  assert.deepEqual(plain(activityDetails(t, { status: 'error', extractReason: 'refusal' })), ['LLM 抽取失败: 模型拒答'])
  assert.deepEqual(plain(activityDetails(t, { status: 'error', extractReason: 'empty', retry: 'failed' })), ['LLM 抽取失败: 回复为空', '重试仍失败'])
  // finish_reason and token counts, and the doubled budget of the retry.
  assert.deepEqual(plain(activityDetails(t, {
    status: 'error',
    extractReason: 'truncated',
    extractStats: { finishReason: 'length', maxTokens: 4000, completionTokens: 4000, reasoningTokens: 3100 },
    retry: 'failed',
  })), ['LLM 抽取失败: 回复被截断（JSON 不完整） (finish_reason=length · 输出 4000/4000 token (其中思考 3100))', '重试仍失败'])
  assert.deepEqual(plain(activityDetails(t, { status: 'saving', retry: 'pending', retryReason: 'extraction', extractReason: 'truncated', retryMaxTokens: 16000 })), ['LLM 回复达到输出上限被截断，正在以 max_tokens 16000 重试一次'])
})

test('a stored extraction failure names its reason (zh and en)', () => {
  const { failureSummary, zh, en } = loadClient().exports.__test__
  const failure = { kind: 'capture', component: 'llm', provider: 'openai', endpoint: '127.0.0.1:64451', step: 'llm_extract', cause: 'extraction', reason: 'not_json', message: 'm' }
  assert.match(failureSummary(tFor(zh), failure), /LLM 抽取失败: 回复不是 JSON/)
  assert.match(failureSummary(tFor(en), failure), /LLM extraction failed: answer was not JSON/)
  for (const reason of ['not_json', 'empty', 'truncated', 'refusal']) {
    assert.ok(zh[`extractReason_${reason}`] && en[`extractReason_${reason}`], reason)
  }
  const cut = { ...failure, reason: 'truncated', extract: { finishReason: 'length', maxTokens: 2000, completionTokens: 2000, reasoningTokens: 1697 } }
  assert.match(failureSummary(tFor(en), cut), /answer cut off \(truncated JSON\) \(finish_reason=length · output 2000\/2000 tokens \(1697 thinking\)\)/)
})

test('the dock tells "paused by the breaker" from "skipped, too short"', () => {
  const { dockView, en } = loadClient().exports.__test__
  const t = tFor(en)
  const now = Date.parse('2026-11-06T06:00:00Z')
  const paused = dockView(t, { data: { activity: { capture: { status: 'skipped', reason: 'circuit-open', circuitUntil: '2026-11-06T06:02:00Z' } } } }, now)
  assert.equal(paused.label, 'Memory paused')
  assert.equal(paused.kind, 'circuit')
  assert.ok(paused.details.length > 0)
  const short = dockView(t, { data: { activity: { capture: { status: 'skipped', reason: 'low-value' } } } }, now)
  assert.equal(short.label, 'Capture skipped (too short)')
  // A breaker that already closed is not shown as paused.
  const closed = dockView(t, { data: { activity: { capture: { status: 'skipped', reason: 'circuit-open', circuitUntil: '2026-11-06T05:59:00Z' } } } }, now)
  assert.equal(closed.label, 'Capture skipped')
})

test('store lines show the file, whether it is open, and the last failure to open it', () => {
  const { storeLines, en, zh } = loadClient().exports.__test__
  const open = storeLines(tFor(en), { running: true, kind: 'sqlite', path: '~/.dsh/mem0/memory.sqlite', lastStartFailure: null })
  assert.equal(open[0], 'File: ~/.dsh/mem0/memory.sqlite')
  assert.equal(open[1], 'Open')
  assert.match(open.at(-1), /dsh_mem0/)
  const failed = storeLines((key) => zh[key] ?? key, {
    running: false,
    path: '~/.dsh/mem0/memory.sqlite',
    lastStartFailure: { at: '2026-11-10T11:01:05.000Z', code: 'readonly', reason: 'the memory database file or its folder is not writable', configError: true },
  })
  assert.equal(failed[1], '尚未打开（下次读写记忆时打开）')
  assert.ok(failed.some((line) => /最近一次打开失败.*readonly.*not writable/.test(line)))
  assert.ok(failed.some((line) => /配置错误/.test(line)))
  assert.equal(storeLines(tFor(en), null).length, 0)
})

// ---- "Nothing new" badge: a saved capture that wrote 0 memories ----

test('a saved capture that wrote nothing gets the neutral "Nothing new" badge', () => {
  const { captureWritten, chipState, activityChipSpec, zh, en } = loadClient().exports.__test__
  // OSS summary: facts extracted but all already known.
  assert.equal(captureWritten({ status: 'saved', facts: 1, add: 0, update: 0, delete: 0, none: 1 }), 0)
  assert.equal(captureWritten({ status: 'saved', facts: 0 }), 0)
  // Platform/server event counts.
  assert.equal(captureWritten({ status: 'saved', add: 0, update: 0, delete: 0 }), 0)
  assert.equal(captureWritten({ status: 'saved', add: 2, update: 1 }), 3)
  assert.equal(captureWritten({ status: 'saved', add: 0, update: 0, delete: 1 }), 1)
  // No counts (Platform/server without events): unknown, unchanged badge.
  assert.equal(captureWritten({ status: 'saved', count: 1 }), null)
  assert.equal(captureWritten({ status: 'error' }), null)

  assert.equal(chipState({ status: 'saved', facts: 0 }), 'nothing_new')
  assert.equal(chipState({ status: 'saved', facts: 2, add: 0, update: 0, delete: 0, none: 2 }), 'nothing_new')
  assert.equal(chipState({ status: 'saved', add: 1, update: 0, delete: 0 }), 'saved')
  assert.equal(chipState({ status: 'saved', count: 1 }), 'saved')
  assert.equal(chipState({ status: 'saved', facts: 0, retry: 'saved' }), 'saved', 'a retried save keeps its badge')
  assert.equal(chipState({ status: 'ok' }), 'ok')
  assert.equal(chipState(null), undefined)

  const [newKey, newClass] = activityChipSpec('nothing_new')
  assert.equal(zh[newKey], '无新内容')
  assert.equal(en[newKey], 'Nothing new')
  assert.equal(newClass, '', 'neutral grey, not the success colour')
  assert.deepEqual(plain(activityChipSpec('saved')), ['activitySaved', 'mem0-state-ok'])
})

test('the dock does not show success for a capture that wrote nothing', () => {
  const { dockView, zh } = loadClient().exports.__test__
  const t = tFor(zh)
  const now = Date.parse('2026-11-06T06:00:00Z')
  const at = '2026-11-06T05:59:00Z'
  const nothing = dockView(t, { data: { activity: { capture: { status: 'saved', at, facts: 1, add: 0, update: 0, delete: 0, none: 1 } } } }, now)
  assert.equal(nothing.label, '无新内容可记')
  assert.equal(nothing.state, 'idle')
  assert.notEqual(nothing.kind, 'ok')
  const wrote = dockView(t, { data: { activity: { capture: { status: 'saved', at, count: 2, add: 2, update: 0, delete: 0 } } } }, now)
  assert.equal(wrote.state, 'success')
  assert.equal(wrote.label, '已保存记忆 2')
  // Unknown counts keep today's success view.
  const unknown = dockView(t, { data: { activity: { capture: { status: 'saved', at, count: 1 } } } }, now)
  assert.equal(unknown.state, 'success')
  // A later recall still wins when it is newer.
  const recalled = dockView(t, { data: { activity: {
    capture: { status: 'saved', at, facts: 0 },
    recall: { status: 'ok', at: '2026-11-06T05:59:30Z', count: 3 },
  } } }, now)
  assert.equal(recalled.state, 'success')
})

test('delete errors name the reason in the page language', () => {
  const { deleteErrorText, en } = loadClient().exports.__test__
  const t = tFor(en)
  assert.match(deleteErrorText(t, Object.assign(new Error('x'), { reason: 'other-user' })), /another Mem0 user/)
  assert.equal(deleteErrorText(t, new Error('HTTP 502')), 'Could not delete the memory: HTTP 502')
})

test('failure card: startup/config causes and the unreachable hint', () => {
  const { failureSummary, zh } = loadClient().exports.__test__
  const t = (key) => zh[key] ?? key
  const refused = failureSummary(t, {
    kind: 'recall', cause: 'connection', component: 'vector_store', provider: 'qdrant', endpoint: '127.0.0.1:15333', message: 'refused',
  })
  assert.match(refused, /Qdrant不可达：127\.0\.0\.1:15333/)
  assert.match(refused, /10013/)
  assert.match(failureSummary(t, { kind: 'recall', cause: 'startup', component: 'sidecar', message: 'x' }), /本地后端启动失败/)
  assert.match(failureSummary(t, { kind: 'recall', cause: 'config', component: 'vector_store', message: 'x' }), /配置错误/)
  assert.doesNotMatch(failureSummary(t, { kind: 'recall', cause: 'startup', component: 'sidecar', message: 'x' }), /其他错误/)
})

test('setup wizard: texts without Python or Hermes, store and switch helpers', () => {
  const { exports } = loadClient()
  const { en, zh, storeCheckText, missingLocalSetup, wizardPayload, llmAdvice, emptyWizardDraft, migrationText } = exports.__test__
  for (const dict of [en, zh]) {
    for (const [key, value] of Object.entries(dict)) {
      if (key.startsWith('wz') || key.startsWith('upgrade')) assert.doesNotMatch(value, /python|hermes|pythonPath/i, key)
    }
  }
  const tz = (key) => zh[key]
  assert.match(storeCheckText(tz, { writable: true, kind: 'sync', provider: 'OneDrive', path: 'C:\\x' }), /OneDrive 同步目录/)
  assert.match(storeCheckText((key) => en[key], { writable: true, kind: 'network', path: '/n' }), /network drive/)
  assert.match(storeCheckText(tz, { writable: true, kind: 'local', path: '~/.dsh/mem0/memory.sqlite' }), /可写/)
  assert.deepEqual([...missingLocalSetup({ current: { problems: [{ component: 'embedder' }, { component: 'llm' }] } })], ['embedder', 'llm'])
  assert.equal(missingLocalSetup({ current: { problems: [] } }).length, 0)
  const draft = emptyWizardDraft({ refs: { embedder: 'E', llm: 'L' }, recommendations: { cloud: [{ baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', dims: 1536 }] } })
  assert.equal(draft.embedder.mode, 'cloud')
  assert.equal(draft.embedder.apiKeyRef, 'E')
  const local = wizardPayload({ ...draft, embedder: { ...draft.embedder, mode: 'local', keyTyped: false } })
  assert.equal(local.embedder.apiKeyRef, '', 'a local server gets no credential name')
  assert.equal(local.embedder.mode, undefined)
  assert.equal(llmAdvice(tz, ['raise-max-tokens']).length, 1)
  assert.match(migrationText(tz, { imported: 50, vectors: 'copied', skippedExisting: 0, skippedEmpty: 0 }), /已迁移 50 条.*旧数据仍在 Qdrant/)
})

test('setup wizard: a stored key only for its own server; errors in the page language', () => {
  const { exports } = loadClient()
  const { en, zh, storedKeyApplies, wizardError, wizardStepName, storeCheckText } = exports.__test__
  const state = { current: { embedder: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyRef: 'E' } }, credentials: { embedder: { ref: 'E', configured: true } } }
  assert.equal(storedKeyApplies(state, 'embedder', { provider: 'openai', baseUrl: 'https://api.openai.com/v1/', apiKeyRef: 'E' }), true)
  assert.equal(storedKeyApplies(state, 'embedder', { provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', apiKeyRef: 'E' }), false)
  assert.equal(storedKeyApplies(state, 'embedder', { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyRef: 'OTHER' }), false)
  const tz = (key) => zh[key] ?? key
  const te = (key) => en[key] ?? key
  assert.equal(wizardError(tz, { code: 'ALREADY_MIGRATED', error: 'this store was migrated already' }), '这个记忆文件已经从 Qdrant 迁移过一次。 (this store was migrated already)')
  assert.match(wizardError(tz, { code: 'SOMETHING_NEW', error: 'raw' }), /raw/)
  assert.equal(wizardStepName(tz, 'verify'), '核对')
  assert.equal(wizardStepName(te, 'merge'), 'merging')
  assert.match(storeCheckText(tz, { writable: true, kind: 'unverified', path: '/Volumes/X', reason: 'weirdfs' }), /无法确认/)
  // Same keys in both languages.
  assert.deepEqual(Object.keys(en).filter((key) => key.startsWith('wz')).sort(), Object.keys(zh).filter((key) => key.startsWith('wz')).sort())
})

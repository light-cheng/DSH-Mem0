// The diagnosis dialog, its buttons and the "AI troubleshoot" entry
// (client.js), and the general prompt (lib/diagnose-general.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { buildGeneralPrompt, generalState, GENERAL_FINGERPRINT, hostVersion, openFailureSummary } from '../lib/diagnose-general.js'
import { handleDiagnoseAction, prepareDiagnosis } from '../lib/diagnose-routes.js'
import { DiagnoseSessions } from '../lib/diagnose-sessions.js'

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz123456'

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-dialog-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A React stand-in whose hooks keep state between renders of one component. */
function hookReact() {
  const slots = []
  const refs = []
  let index = 0
  let refIndex = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment',
    useCallback: (fn) => fn,
    useEffect() {},
    useLayoutEffect() {},
    useMemo: (fn) => fn(),
    useRef: (value) => {
      const at = refIndex++
      if (!refs[at]) refs[at] = { current: value }
      return refs[at]
    },
    useState: (initial) => {
      const at = index++
      if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
      return [slots[at], (next) => { slots[at] = typeof next === 'function' ? next(slots[at]) : next }]
    },
  }
  return { react, reset: () => { index = 0; refIndex = 0 } }
}

function loadClient(react = hookReact().react) {
  let registered
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window, setTimeout, clearTimeout })
  return registered.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require ${name}`)
  }).__test__
}

const plain = (value) => JSON.parse(JSON.stringify(value))
const t = (key) => key

/** Every string in a rendered tree, in order. */
function texts(node) {
  if (node === null || node === undefined || node === false) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  return (node.children ?? []).flatMap(texts)
}

/** Every element of a type in a rendered tree. */
function find(node, type) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((child) => find(child, type))
  return [...(node.type === type ? [node] : []), ...(node.children ?? []).flatMap((child) => find(child, type))]
}

const CATALOG = {
  default: { provider: 'magpie', model: 'auto/deepseek-v4.1-flash' },
  groups: [
    { id: 'magpie', name: 'Magpie', models: [{ id: 'auto/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }, { id: 'auto/other', name: 'Other' }] },
    { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
  ],
  failures: [],
}

function services({ listed = [], archived = [], catalog = CATALOG, calls = [], noRemote = false } = {}) {
  return {
    sessions: {
      list: { getSnapshot: () => ({ ids: listed, byId: {} }) },
      create: async (options) => {
        calls.push(['create', plain(options)])
        await new Promise((resolve) => setTimeout(resolve, 5))
        return `new-${calls.filter((call) => call[0] === 'create').length}`
      },
      retain: (id) => {
        const session = {
          command: async () => ({ ok: true }),
          rename: async () => {},
          prompt: async () => {
            calls.push(['prompt', id])
            return { ok: true, value: { accepted: true } }
          },
          projections: { faceOf: () => ({ getSnapshot: () => ({ currentValue: 'workspace-write' }) }) },
        }
        const binding = { sessionId: id, session }
        return { binding, ready: Promise.resolve(binding), release() {} }
      },
      retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 2 }) }),
    },
    uiWorkspace: { openSession: (id) => calls.push(['open', id]), archiveSession: async () => {} },
    workspaces: {
      list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-diag', path: '/p/dsh-mem0/mem0-diagnosis', title: 'Mem0 诊断' }, { workspaceId: 'ws-a', path: '/Users/me/alpha', title: 'alpha' }, { workspaceId: 'ws-b', path: '/Users/me/beta', title: '' }], archivedSessionIds: archived }) },
      create: async () => ({ workspaceId: 'ws-diag' }),
    },
    remote: noRemote ? undefined : { session: { modelCatalog: async () => (catalog ? { ok: true, value: catalog } : { ok: false, error: { code: 'x' } }) } },
  }
}

const PREPARED = {
  texts: { each: 'EACH', skip: 'SKIP' },
  copyText: 'COPY',
  fingerprint: 'dsh-mem0:abc',
  cwd: '/p/dsh-mem0/mem0-diagnosis',
  title: 'Mem0 诊断：其他错误',
  workspaceTitle: 'Mem0 诊断',
  sessionId: null,
  keepsDefaultModel: true,
}

// ---- the dialog ---------------------------------------------------------------

test('dialog options: the diagnosis workspace first, the user\'s own by title; DSH\'s default model; "no confirmation" unticked', async () => {
  const client = loadClient()
  const host = services()
  assert.deepEqual(plain(client.diagnoseWorkspaceOptions(host, PREPARED)), [
    { value: client.DIAGNOSE_WORKSPACE, label: 'Mem0 诊断' },
    { value: 'ws-a', label: 'alpha' },
    { value: 'ws-b', label: 'beta' },
  ])
  const models = await client.diagnoseModelOptions(host)
  assert.equal(models.defaultKey, 'magpie/auto/deepseek-v4.1-flash')
  assert.deepEqual(plain(models.options.map((option) => option.value)), ['magpie/auto/deepseek-v4.1-flash', 'magpie/auto/other', 'deepseek/deepseek-chat'])
  const state = client.diagnoseDialogState({ services: host, prepared: PREPARED, models })
  assert.equal(state.view, 'form')
  assert.equal(state.workspace, client.DIAGNOSE_WORKSPACE)
  assert.equal(state.model, 'magpie/auto/deepseek-v4.1-flash')
  assert.equal(state.skipConfirm, false)
  assert.equal(state.phase, 'idle')
  // No catalog, or no way to put the default back: no model choice.
  assert.equal(await client.diagnoseModelOptions(services({ catalog: null })), null)
  assert.equal(await client.diagnoseModelOptions(services({ noRemote: true })), null)
  assert.equal(client.diagnoseDialogState({ services: host, prepared: { ...PREPARED, keepsDefaultModel: false }, models }).models, null)
})

test('the dialog says what happens, offers workspace, model and the risk note, and locks while the session opens', async () => {
  const client = loadClient()
  const host = services()
  const models = await client.diagnoseModelOptions(host)
  const state = client.diagnoseDialogState({ services: host, prepared: PREPARED, models })
  const on = { close() {}, start() {}, set() {}, continueExisting() {}, startAnother() {}, copy() {} }
  const tree = client.DiagnoseDialog({ t, dialog: state, on })
  const words = texts(tree)
  assert.ok(words.includes('dlgIntro'))
  assert.ok(words.includes('dlgWorkspace') && words.includes('dlgModel'))
  assert.ok(words.includes('dlgSkip') && words.includes('dlgSkipRisk'))
  assert.ok(words.includes('dlgStart') && words.includes('dlgClose'))
  const [checkbox] = find(tree, 'input')
  assert.equal(checkbox.props.type, 'checkbox')
  assert.equal(checkbox.props.checked, false)
  assert.equal(find(tree, 'select').length, 2)

  const opening = client.DiagnoseDialog({ t, dialog: { ...state, phase: 'opening' }, on })
  const buttons = find(opening, 'button')
  const start = buttons.find((button) => texts(button).includes('dlgOpening'))
  assert.ok(start, 'the start button reads "Opening the session…"')
  assert.equal(start.props.disabled, true)
  assert.ok(buttons.every((button) => button.props.disabled === true))

  // Failed: the reason, and Copy diagnosis to fall back on.
  const failed = client.DiagnoseDialog({ t, dialog: { ...state, phase: 'error', message: 'diagnoseFailed' }, on })
  assert.ok(texts(failed).includes('diagnoseFailed'))
  assert.ok(texts(failed).includes('diagnoseCopy'))

  // No model catalog: the model row is not shown.
  assert.equal(find(client.DiagnoseDialog({ t, dialog: { ...state, models: null }, on }), 'select').length, 1)
  const zh = loadClient().zh
  assert.equal(zh.dlgIntro, '会新建一段对话，AI 先问清再动手。')
  assert.equal(zh.dlgSkip, '修改时不用逐项确认')
  assert.equal(zh.dlgSkipRisk, '勾选后，AI 会直接修改配置、执行命令、改动记忆，不再逐项问你；改错了可能需要你手动恢复。删除记忆和重建概要仍会确认。')
  assert.equal(zh.dlgStart, '开始排查')
  assert.equal(zh.dlgClose, '关闭')
  assert.equal(zh.dlgOpening, '正在开会话…')
  assert.equal(zh.diagnoseGeneral, 'AI 排查')
  assert.equal(zh.diagnoseOpenSession, '打开诊断会话')
  assert.equal(zh.dlgContinue, '继续上次的诊断')
  assert.equal(zh.dlgNew, '另开一个')
})

test('a problem with a session still open: the row says "Open diagnosis session", the dialog offers continue or another', () => {
  const client = loadClient()
  const host = services({ listed: ['old-1'] })
  const failure = { cause: 'other', component: 'llm', diagnosisSessionId: 'old-1' }
  assert.equal(client.diagnoseRowAction(host, failure), 'open')
  assert.equal(client.diagnoseRowAction(host, { ...failure, diagnosisSessionId: 'gone' }), 'ask')
  assert.equal(client.diagnoseRowAction(services({ listed: ['old-1'], archived: ['old-1'] }), failure), 'ask')
  assert.equal(client.diagnoseRowAction(host, { cause: 'other' }), 'ask')
  const row = client.FailureAdvice({ t, failure, rowKey: 'k', diagnose: { canOpen: true, services: host, state: {}, ask() {}, reopen() {}, copy() {} } })
  assert.ok(texts(row).includes('diagnoseOpenSession'))
  assert.ok(!texts(row).includes('diagnoseAsk'))

  const choose = client.diagnoseDialogState({ services: host, prepared: { ...PREPARED, sessionId: 'old-1' }, models: null })
  assert.equal(choose.view, 'choose')
  const words = texts(client.DiagnoseDialog({ t, dialog: choose, on: { close() {}, continueExisting() {}, startAnother() {} } }))
  assert.ok(words.includes('dlgExisting') && words.includes('dlgContinue') && words.includes('dlgNew'))
  const general = client.diagnoseDialogState({ services: host, prepared: { ...PREPARED, sessionId: 'old-1' }, models: null, general: true })
  assert.ok(texts(client.DiagnoseDialog({ t, dialog: general, on: { close() {} } })).includes('dlgExistingGeneral'))
  // Gone or archived: straight to the form, a new session as usual.
  assert.equal(client.diagnoseDialogState({ services: services({ listed: [] }), prepared: { ...PREPARED, sessionId: 'old-1' } }).view, 'form')
})

test('double clicks open one session; Close does nothing while it opens; "AI troubleshoot" asks continue or new', async () => {
  const { react, reset } = hookReact()
  const client = loadClient(react)
  const calls = []
  const host = services({ calls, listed: ['general-1'] })
  const ctx = { get: (name) => ({ sessions: host.sessions, uiWorkspace: host.uiWorkspace, workspaces: host.workspaces, remote: host.remote })[name] }
  const sent = []
  const send = async (body) => {
    sent.push(plain(body))
    if (body.action === 'prepare') return body.failure ? { ok: true, ...PREPARED } : { ok: true, ...PREPARED, fingerprint: 'dsh-mem0:general', sessionId: 'general-1' }
    return { ok: true }
  }
  const render = () => {
    reset()
    return client.useDiagnose(ctx, t, () => {}, { send })
  }
  await render().ask('row-1', { cause: 'other', at: '2026-11-27T10:00:00Z' })
  let view = render()
  assert.equal(view.dialog.view, 'form')
  assert.equal(view.dialog.skipConfirm, false)
  view.on.start()
  view.on.start()
  render().on.start()
  render().on.close()
  assert.equal(render().busy, true)
  assert.ok(render().dialog, 'Close is ignored while opening')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(calls.filter((call) => call[0] === 'create').length, 1)
  assert.equal(calls.filter((call) => call[0] === 'prompt').length, 1)
  view = render()
  assert.equal(view.dialog, null)
  assert.equal(view.state['row-1'].message, 'diagnoseOpened')
  assert.equal(sent.find((body) => body.action === 'register').skipConfirm, false)

  // The general entry remembers its last session: continue it, or start new.
  await render().general()
  view = render()
  assert.equal(view.dialog.general, true)
  assert.equal(view.dialog.view, 'choose')
  assert.equal(sent.at(-1).action, 'prepare')
  assert.equal('failure' in sent.at(-1), false)
  view.on.continueExisting()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(calls.at(-1), ['open', 'general-1'])
  assert.equal(calls.filter((call) => call[0] === 'create').length, 1)
  assert.equal(render().state.general.message, 'diagnoseReopened')

  // "Start new" ticks nothing for the user: the box starts unticked again.
  await render().general()
  view = render()
  view.on.startAnother()
  assert.equal(render().dialog.view, 'form')
  assert.equal(render().dialog.skipConfirm, false)
})

test('the "AI troubleshoot" entry sits on top of the Diagnostics tab and opens the dialog', () => {
  const client = loadClient()
  let opened = 0
  const entry = client.DiagnoseEntry({ t, diagnose: { canOpen: true, state: {}, general: () => (opened += 1) } })
  assert.ok(texts(entry).includes('diagnoseGeneral'))
  find(entry, 'button')[0].props.onClick()
  assert.equal(opened, 1)
  const tab = client.DiagnosticsTab({ t, data: { failures: [] }, status: {}, diagnostics: {}, diagnose: { canOpen: true, state: {} } })
  const children = tab.children.filter(Boolean)
  assert.equal(children[0].type, client.DiagnoseEntry)
})

// ---- the general prompt -----------------------------------------------------------

test('the general prompt carries the plugin state, redacted, in the agreed words', (t) => {
  const dir = tmpDir(t)
  const failures = [
    { at: '2026-11-27T10:00:00Z', cause: 'timeout', count: 3, recovered: false, message: `with api_key=${SECRET}`, endpoint: 'https://user:pw@api.example.com/v1?key=1' },
    { at: '2026-11-27T09:00:00Z', cause: 'timeout', count: 2, recovered: false },
    { at: '2026-11-27T11:00:00Z', cause: 'auth', recovered: true },
    { at: '2026-11-27T08:00:00Z', cause: 'connection', recovered: false, detail: 'I like green tea' },
  ]
  const runtime = {
    profileDir: dir,
    config: { backend: 'platform', baseUrl: 'https://user:pw@api.mem0.ai/v1?token=abc', apiKey: SECRET, autoRecall: true, autoCapture: false, projectPartitions: true },
    breaker: { isOpen: () => false },
    failures: { list: () => failures },
    diagnoseSessions: new DiagnoseSessions(),
    dshVersion: '0.2.2-rc.5',
  }
  const summary = openFailureSummary(failures)
  assert.deepEqual(summary.map((group) => [group.cause, group.count]), [['timeout', 5], ['connection', 1]])
  const state = generalState(runtime, { pluginVersion: '0.4.1', dshVersion: '0.2.2-rc.5' })
  assert.deepEqual(plain(state.endpoints), ['api.mem0.ai'])
  assert.equal(state.partitions, false, 'partitions are a local-backend feature')
  const zh = buildGeneralPrompt(state, { lang: 'zh', confirm: 'each', tools: { write: ['mem0_add'], alwaysConfirm: ['mem0_delete', 'mem0_profile_reset'], status: 'mem0_status' }, recordFile: '/p/failures.json' })
  for (const line of [
    '这是 DSH-Mem0（记忆插件）的问题排查。用户从设置页「AI 排查」发起，没有指定哪条失败，你要先问清楚现象，再动手查。',
    '【插件已带上的状态，不用再问】',
    '插件版本 0.4.1，DSH 版本 0.2.2-rc.5',
    '后端：platform（云端），服务商 api.mem0.ai',
    '自动召回 开，自动保存 关，按项目分区 关',
    '熔断状态：正常',
    '第一步，先问清楚。用 ask_user_question 提问，一次只问一两题，每题都给选项，并留「说不清」。要覆盖这些情况：',
    '- 记不住：说过的事，下次会话里不记得',
    '- 串了：A 项目的记忆出现在 B 项目里',
    '- 第一次配置就用不了：key、服务商或本地后端连不上',
    '第二题问最近改过什么：换了 key、换了服务商或模型、改了网络或代理、升级了 DSH 或插件、什么都没改。',
    '上面状态里有未恢复的失败、而用户的描述和它对得上时，直接按那一类查，不要从头猜。',
    '先做一轮简短排查，把发现告诉用户，再问要不要继续深入。',
    '话要短，像人说话。全程用用户当前的语言。',
  ]) assert.ok(zh.includes(line), line)
  assert.match(zh, /最近未恢复的失败：超时 5 次（最后一次 [^）]+）；连接失败 1 次/)
  assert.match(zh, /调用 dsh-mem0-kb 技能/)
  assert.match(zh, /第三步，能修就修：先说原因和打算怎么改，用户同意了再改，改完用 mem0_check 验证。问题分三类：配置类[^。]*mem0_setting_set 改[\s\S]*数据类[\s\S]*外部类（服务宕机、额度用完、网络）修不了/)
  assert.match(zh, /先用 mem0_check（target status）[\s\S]*不要自己读文件、发请求或查端口/)
  assert.match(zh, /第四步，如果看起来是插件本身的问题[\s\S]*不要提交到任何地方/)
  assert.match(zh, /每一处修改（配置、命令、记忆）都会弹确认/)
  assert.match(zh, /不要直接改 cordis\.patch\.yml/)
  assert.doesNotMatch(zh, /gdbznebdvbicthhjmuzqybhvqv|green tea|user:pw|token=abc|api_key|\/v1/)
  const skip = buildGeneralPrompt(state, { lang: 'zh', confirm: 'skip', tools: { alwaysConfirm: ['mem0_delete', 'mem0_profile_reset'] } })
  assert.match(skip, /用户已选择「修改时不用逐项确认」：同意之后可以直接改；但 mem0_delete、mem0_profile_reset 仍会弹确认/)
  const en = buildGeneralPrompt({ ...state, failures: [] }, { lang: 'en' })
  assert.match(en, /Recent failures not recovered: none/)
  assert.match(buildGeneralPrompt({ ...state, failures: [] }, { lang: 'zh' }), /最近未恢复的失败：无/)
})

test('prepare without a failure: the general prompts, its fixed fingerprint and its last session', async (t) => {
  const dir = tmpDir(t)
  const runtime = { profileDir: dir, config: { backend: 'oss', embedderBaseUrl: 'http://127.0.0.1:47811/v1', embedderProvider: 'openai', llmBaseUrl: '' }, failures: { list: () => [] }, diagnoseSessions: new DiagnoseSessions(), dshVersion: '0.2.2-rc.5' }
  const first = prepareDiagnosis(runtime, { lang: 'zh' })
  assert.equal(first.status, 200)
  assert.equal(first.body.fingerprint, GENERAL_FINGERPRINT)
  assert.equal(first.body.title, 'Mem0 AI 排查')
  assert.equal(first.body.sessionId, null)
  assert.match(first.body.texts.each, /后端：oss（本地），服务商 embedder openai 127\.0\.0\.1:47811/)
  // The local client's resolved settings win (the profile may leave them to oss.json).
  const resolved = { ...runtime, config: { backend: 'oss' }, client: { settings: () => ({ embedder: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' }, llm: { provider: 'dsh' } }) } }
  assert.match(prepareDiagnosis(resolved, { lang: 'zh' }).body.texts.each, /服务商 embedder ollama 127\.0\.0\.1:11434，LLM follows DSH/)
  assert.match(first.body.texts.each, /按项目分区 开/)
  // The session checks failures with mem0_check, not by reading the file.
  assert.ok(!first.body.texts.each.includes('failures.json'))
  assert.match(first.body.texts.each, /用 mem0_check 看连接和最近的失败（target failures）/)
  assert.match(first.body.texts.each, /不要直接改 cordis\.patch\.yml（DSH 会改写它）：插件设置用 mem0_setting_set 改/)
  assert.notEqual(first.body.texts.each, first.body.texts.skip)
  await handleDiagnoseAction(runtime, { action: 'register', sessionId: 'general-1', fingerprint: GENERAL_FINGERPRINT })
  assert.equal(prepareDiagnosis(runtime, { lang: 'en' }).body.sessionId, 'general-1')
})

test('DSH\'s version comes from the host package beside the running CLI', (t) => {
  const dir = tmpDir(t)
  const scope = path.join(dir, 'node_modules', '@deepseek-ai')
  fs.mkdirSync(path.join(scope, 'dsh'), { recursive: true })
  fs.mkdirSync(path.join(scope, 'dsh-desktop-host', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(scope, 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9-test' }))
  assert.equal(hostVersion({ argv: ['node', path.join(scope, 'dsh-desktop-host', 'lib', 'cli.js')] }), '9.9.9-test')
  assert.equal(hostVersion({ argv: ['node'] }), null)
  assert.equal(hostVersion({ argv: ['node', path.join(tmpDir(t), 'elsewhere.js')] }), null)
})

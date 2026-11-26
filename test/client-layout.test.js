// The settings page layout (three tabs, header, save bar): every setting
// still has a control, the capture card follows the PR1/PR2 contract, and
// the library helpers page, filter and sort as the page expects.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

// A React stand-in that records the element tree; function components are
// called (hooks are inert), so a render can be searched like a DOM.
const react = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useCallback: (fn) => fn,
  useEffect() {},
  useLayoutEffect() {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
}

function loadClient() {
  let registered
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window })
  return registered.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require ${name}`)
  }).__test__
}

const client = loadClient()
const t = (key) => key
const plain = (value) => JSON.parse(JSON.stringify(value))

/** Expand function components into host elements, depth first. */
function render(node) {
  if (Array.isArray(node)) return node.flat(Infinity).map(render)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return render(node.type(node.props))
  return { type: node.type, props: { ...node.props, children: render(node.props.children ?? []) } }
}

function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit))
  if (!node || typeof node !== 'object') return
  visit(node)
  walk(node.props.children, visit)
}

function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || node === undefined || node === false) return ''
  if (typeof node !== 'object') return String(node)
  return textOf(node.props.children)
}

/** Every control's label (inputs, selects, toggles) and the segment buttons. */
function controls(tree) {
  const found = new Map()
  walk(tree, (node) => {
    if (String(node.props.className ?? '').split(' ').includes('mem0-field')) {
      const label = textOf(node.props.children[0])
      const input = node.props.children.find((child) => child?.type === 'input' || child?.type === 'select')
      if (input) found.set(label, input)
    }
    if (node.props.className === 'mem0-toggle-row') {
      const label = textOf(node.props.children[0].props.children[0])
      found.set(label, node.props.children[1])
    }
    if (node.props.className === 'mem0-segment') found.set(`segment:${textOf(node)}`, node)
  })
  return found
}

function renderSettings(backend, setField = () => {}) {
  const draft = { ...client.normalise({}), backend }
  const settings = render(client.SettingsTab({
    t,
    draft,
    setField,
    backend: { choose() {}, switchPrompt: null, openWizard() {}, switchAnyway() {} },
    connection: { apiKey: '', setApiKey() {}, keyConfigured: false, test() {}, testState: 'idle', testDisabled: false },
  }))
  const maintenance = render(client.MaintenanceTab({
    t,
    draft,
    setField,
    data: null,
    status: { phase: 'ready', message: '' },
    hygiene: { run() {}, state: 'idle', message: '' },
    reportTexts: null,
    local: { openWizard() {}, wizardOpen: false, wizard: null, copyPath() {}, copied: false },
    diagnostics: { issue: false, open: false },
  }))
  const header = render(client.PageHeader({ t, view: { state: 'ok', label: 'ok', parts: [], where: null }, enabled: draft.enabled, onToggleEnabled: (value) => setField('enabled', value), onCheck() {}, checking: false }))
  return { settings, maintenance, header }
}

test('every saved setting has exactly one place in the new layout', () => {
  const placed = Object.values(client.SETTINGS_LAYOUT).flat()
  assert.equal(new Set(placed).size, placed.length, 'no field placed twice')
  assert.deepEqual([...placed].sort(), [...client.FIELD_ORDER].sort())
})

test('the local backend shows a working control for every setting (third section of the proposal)', () => {
  const calls = []
  const setField = (key, value) => calls.push([key, value])
  const { settings, maintenance, header } = renderSettings('oss', setField)
  const found = new Map([...controls(settings), ...controls(maintenance)])
  for (const name of client.FIELD_ORDER) {
    if (name === 'enabled' || name === 'backend' || name === 'apiKey' || name === 'apiKeyEnv' || name === 'baseUrl' || name === 'authType') continue
    const control = found.get(client.FIELD_SPECS[name].label)
    assert.ok(control, `${name} has a control`)
    calls.length = 0
    if (control.type === 'button') control.props.onClick()
    else control.props.onChange({ target: { value: control.props.type === 'number' ? '7' : 'x' } })
    assert.equal(calls[0]?.[0], name, `${name}'s control edits ${name}`)
  }
  for (const id of ['backendAuto', 'backendPlatform', 'backendServer', 'backendOss']) assert.ok(found.has(`segment:${id}`))
  // The master switch sits in the header.
  let master
  walk(header, (node) => { if (node.props.role === 'switch') master = node })
  calls.length = 0
  master.props.onClick()
  assert.deepEqual(calls, [['enabled', false]])
})

test('REST backends show their connection fields and hide the local and partition-only ones', () => {
  for (const backend of ['platform', 'server', 'auto']) {
    const { settings, maintenance } = renderSettings(backend)
    const found = new Map([...controls(settings), ...controls(maintenance)])
    for (const label of ['apiKey', 'apiKeyEnv', 'baseUrl']) assert.ok(found.has(label), `${backend}: ${label}`)
    assert.equal(found.has('authType'), backend === 'server')
    assert.equal(found.has('storePath'), false)
    assert.equal(found.has('captureTurnDedupThreshold'), false)
    assert.equal(found.has('embedderKeepAlive'), false)
    assert.equal(found.has('projectPartitions'), backend === 'auto', `${backend}: partitions only where they apply`)
    for (const name of ['autoRecall', 'autoCapture', 'translateMemories', 'userId', 'agentId', 'recallTopK', 'timeoutMs', 'hygieneEnabled', 'profileBudgetTokens']) {
      assert.ok(found.has(name), `${backend}: ${name}`)
    }
  }
})

test('capture card: preview rows with tags, Platform pending, or the old one-line stats', () => {
  const view = client.captureView({
    status: 'saved',
    preview: [
      { id: 'a1', memory: 'new fact', event: 'ADD' },
      { id: 'b2', memory: 'changed fact', event: 'update', previous: 'old fact' },
      { id: 'c3', memory: 'gone', event: 'DELETE' },
      { id: 'd4', memory: 'no event' },
    ],
  }, 'server')
  assert.deepEqual(plain(view.items.map((item) => [item.event, item.previous, item.jumpable])), [['ADD', '', true], ['UPDATE', 'old fact', true], ['DELETE', '', false], [null, '', true]])
  assert.equal(view.pending, null)
  assert.equal(view.ossNote, false)
  assert.equal(client.captureView({ status: 'saved' }, 'oss').ossNote, true)
  assert.deepEqual(plain(client.captureView({ status: 'extracting', pending: { eventId: 'evt-1' } }, 'platform').pending), { eventId: 'evt-1' })

  const panel = (capture, backend) => textOf(render(client.CapturePanel({ t, capture, backend, onJump() {} })))
  const withPreview = panel({ status: 'saved', at: '2026-11-22T09:32:00Z', preview: [{ id: 'a1', memory: 'User prefers dark mode', event: 'ADD' }] }, 'oss')
  assert.match(withPreview, /captureTag_ADD/)
  assert.match(withPreview, /User prefers dark mode/)
  assert.match(withPreview, /captureOssOnlyAdd/)
  assert.match(panel({ status: 'extracting', eventId: 'evt-1', pending: { eventId: 'evt-1' } }, 'platform'), /capturePendingEvent/)
  // Neither field (PR1 before PR2): the existing stats line, nothing else.
  const fallback = panel({ status: 'saved', messages: 2, count: 3 }, 'server')
  assert.match(fallback, /2 activityMessages · 3 activityWritten/)
  assert.doesNotMatch(fallback, /captureTag_|capturePending/)
})

test('a capture row jumps to its memory; a removed one does not', () => {
  const jumps = []
  const tree = render(client.CapturePanel({ t, capture: { status: 'saved', preview: [{ id: 'a1', memory: 'x', event: 'ADD' }, { id: 'c3', memory: 'y', event: 'DELETE' }] }, backend: 'server', onJump: (id) => jumps.push(id) }))
  const rows = []
  walk(tree, (node) => { if (node.props.className === 'mem0-act-item') rows.push(node) })
  assert.equal(rows[0].type, 'button')
  rows[0].props.onClick()
  assert.equal(rows[1].type, 'div', 'a removed memory is not a link')
  assert.deepEqual(jumps, ['a1'])
})

test('recall meta says how many of the returned memories are shown', () => {
  assert.equal(client.recallMetaLine(t, { count: 20, latencyMs: 119, preview: [{}, {}, {}, {}, {}] }), 'recallReturnedShown · 119 ms')
  assert.equal(client.recallMetaLine(t, { count: 2, preview: [{}, {}] }), '2 activityReturned')
})

test('banners: only problems, each with where to fix it', () => {
  assert.deepEqual(plain(client.bannerItems(t, { ok: true, backend: 'oss' }, { phase: 'ready' })), [])
  const codes = (data, options = {}) => plain(client.bannerItems(t, data, { phase: 'ready', now: Date.parse('2026-11-22T12:00:00Z'), ...options })).map((item) => `${item.code}:${item.action}`)
  assert.deepEqual(codes({ ok: true, backend: 'oss', upgradeNotices: [{ code: 'legacyQdrant' }, { code: 'qdrantMigrated' }] }), ['legacyQdrant:wizard'])
  assert.deepEqual(codes({ ok: true, configWarning: { missing: ['backend'] } }), ['configWarning:settings'])
  assert.deepEqual(codes({ ok: false, backend: 'oss', error: 'no embedder' }), ['notConnected:wizard'])
  assert.deepEqual(codes({ ok: false, backend: 'platform', error: '401' }), ['notConnected:settings'])
  assert.deepEqual(codes({ ok: false, backend: 'platform', error: 'Mem0 memory is disabled' }, { enabled: false }), [], 'switched off is not a problem')
  assert.deepEqual(codes({ ok: true, activity: { capture: { status: 'skipped', reason: 'circuit-open' } }, failures: [{ at: '2026-11-22T11:00:00Z' }] }), ['circuit:diagnostics'])
  assert.deepEqual(codes({ ok: true, failures: [{ at: '2026-11-22T11:00:00Z' }, { at: '2026-11-10T11:00:00Z' }] }), ['failures:diagnostics'])
  assert.deepEqual(codes({ ok: true, failures: [{ at: '2026-11-10T11:00:00Z' }] }), [], 'old failures stay in diagnostics')
})

test('header status line: state, backend, count and where memories live', () => {
  const view = client.headerStatusView(t, { phase: 'ready', data: { ok: true, backend: 'oss', store: { path: '~/.dsh/mem0/memory.sqlite' } }, enabled: true, memoryCount: 1284 })
  assert.equal(view.state, 'ok')
  assert.deepEqual(plain(view.parts), ['backendOss', 'statusMemoryCount'])
  assert.deepEqual(plain(view.where), { prefix: 'statusStoredAt', code: '~/.dsh/mem0/memory.sqlite' })
  assert.equal(client.headerStatusView(t, { phase: 'ready', data: { ok: true, backend: 'oss' }, enabled: false }).state, 'off')
  assert.equal(client.headerStatusView(t, { phase: 'ready', data: { ok: false, backend: 'server', endpoint: 'http://127.0.0.1:8888' }, enabled: true }).where.code, 'http://127.0.0.1:8888')
})

test('library: project filter takes its sessions, pages of 20, newest or oldest first', () => {
  const tree = { partitioned: true, total: 9, global: 4, projects: [{ id: 'p1', key: 'project:p1', name: 'alpha', count: 3, sessions: [{ id: 'S1', key: 'session:S1', count: 2 }] }, { id: 'p2', key: 'project:p2', name: 'beta', count: 0, sessions: [] }] }
  const options = client.projectOptions(t, tree)
  assert.deepEqual(plain(options.map((option) => [option.id, option.keys, option.label])), [['p1', ['project:p1', 'session:S1'], 'filterProjectSessions'], ['p2', ['project:p2'], 'filterProjectCount']])
  assert.deepEqual(plain(client.libraryPartitionKeys('all', '', options)), [''])
  assert.deepEqual(plain(client.libraryPartitionKeys('global', '', options)), ['global'])
  assert.deepEqual(plain(client.libraryPartitionKeys('project', 'p1', options)), ['project:p1', 'session:S1'])
  assert.deepEqual(plain(client.libraryPartitionKeys('project', '', options)), ['project:p1', 'session:S1', 'project:p2'])
  assert.equal(client.memoryScopeTag(t, { scope: 'session', projectId: 'p1', sessionId: 'S1' }, tree), 'alpha › scopeSessionShort')
  assert.equal(client.memoryScopeTag(t, { scope: 'project', projectId: 'p1' }, tree), 'alpha')
  assert.equal(client.memoryScopeTag(t, { scope: 'global' }, tree), 'scopeGlobal')

  const memories = Array.from({ length: 45 }, (_, index) => ({ id: `m${index}`, createdAt: new Date(Date.UTC(2026, 10, 1) + index * 60_000).toISOString() }))
  const newest = client.sortMemories(memories, 'newest')
  assert.equal(newest[0].id, 'm44')
  assert.equal(client.sortMemories(memories, 'oldest')[0].id, 'm0')
  const page = client.pageOf(newest, 3)
  assert.deepEqual([page.page, page.pages, page.total, page.items.length], [3, 3, 45, 5])
  assert.equal(client.pageOf(newest, 9).page, 3, 'clamped to the last page')
  assert.equal(client.pageContaining(newest, 'm0'), 3)
  assert.equal(client.pageContaining(newest, 'nope'), 0)
})

test('library card: 20 rows a page, a pager, delete only for this plugin\'s memories', () => {
  const memories = Array.from({ length: 23 }, (_, index) => ({ id: `id-${index}-0000-0000`, memory: `fact ${index}`, deletable: index !== 1, pinnable: true, createdAt: null }))
  const tree = render(client.MemoryLibrary({
    t,
    backend: 'oss',
    tree: { partitioned: true, global: 23, projects: [] },
    library: { query: '', filter: 'all', project: '', order: 'newest', page: 1, state: { phase: 'ready', data: { ok: true, memories, total: 23 } }, list: memories, expanded: null, flash: null, notice: null, deleting: null },
    actions: {},
  }))
  const rows = []
  walk(tree, (node) => { if (node.props.className === 'mem0-mem' || node.props.className === 'mem0-mem mem0-flash') rows.push(node) })
  assert.equal(rows.length, 20)
  const deletes = []
  walk(tree, (node) => { if (node.props.className === 'mem0-icon-btn mem0-danger') deletes.push(node) })
  assert.equal(deletes[0].props.disabled, false)
  assert.equal(deletes[1].props.disabled, true, 'another app\'s memory cannot be deleted here')
  assert.match(textOf(tree), /pageLine/)
  assert.match(textOf(tree), /memoryId id-0-000/, 'the list shows the first 8 characters of an id')
})

test('the delete flow waits for the in-page dialog and gets the full memory', async () => {
  const { deleteMemoryFlow } = client
  const requests = []
  const request = async (path, options) => {
    requests.push(options?.method ?? 'GET')
    return { memory: { id: 'abc', memory: 'a fact', createdAt: '2026-11-22T09:30:00Z' } }
  }
  let shown
  const no = await deleteMemoryFlow({ t, id: 'abc', request, confirm: async (_text, memory) => { shown = memory; return false } })
  assert.equal(no.outcome, 'cancelled')
  assert.deepEqual(plain(shown), { id: 'abc', memory: 'a fact', createdAt: '2026-11-22T09:30:00Z' })
  assert.deepEqual(requests, ['GET'])
  const yes = await deleteMemoryFlow({ t, id: 'abc', request, confirm: () => Promise.resolve(true), reload: async () => {} })
  assert.equal(yes.outcome, 'deleted')
  assert.deepEqual(requests, ['GET', 'GET', 'DELETE'])
})

test('migration state reads the upgrade notices', () => {
  assert.equal(client.migrationState({ upgradeNotices: [{ code: 'legacyQdrant' }] }), 'pending')
  assert.equal(client.migrationState({ upgradeNotices: [{ code: 'qdrantMigrated' }] }), 'done')
  assert.equal(client.migrationState({}), 'none')
})

test('the save bar shows only with unsaved changes or a save result', () => {
  assert.equal(client.SaveBar({ t, dirty: false, saveState: 'idle' }), null)
  const bar = render(client.SaveBar({ t, dirty: true, saveState: 'idle', onSave() {}, onDiscard() {}, writable: true }))
  assert.match(textOf(bar), /unsaved.*discard.*save/)
})

test('the failure list shows the output-limit advice in place of the gateway error, like the dock', () => {
  const tEn = (key) => client.en[key] ?? key
  const truncated = {
    at: '2026-11-23T08:00:00.000Z', kind: 'add', cause: 'extraction', reason: 'truncated', component: 'llm',
    message: 'HTTP 502 cut at its length', detail: 'cut at its length, the whole output spent on reasoning', extract: { maxTokens: 2000 },
  }
  const other = { at: '2026-11-23T07:00:00.000Z', kind: 'add', cause: 'other', component: 'llm', message: 'HTTP 500 boom' }
  const text = textOf(render(client.FailureList({ t: tEn, failures: [truncated, other] })))
  assert.match(text, /max_tokens 2000/)
  assert.match(text, /whole output spent on reasoning/)
  assert.doesNotMatch(text, /HTTP 502 cut at its length/)
  assert.match(text, /HTTP 500 boom/)
  assert.equal(client.failureMessage(tEn, truncated), client.failureSummary(tEn, truncated).split(' · ').find((part) => part.includes('max_tokens')))
})

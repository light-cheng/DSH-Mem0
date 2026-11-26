// The composer status (footer-details-spec.md): a short state by default,
// a new notice shown whole for 8 s then folded into the hover panel, the
// last five notices, failures never folded, and the "show details" switch.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { Config, dockDetailsFromEnv, resolveConfig, unwrapConfig } from '../lib/config.js'
import { GUI_ACTIVITY_PATH, registerGuiRoutes } from '../lib/gui-routes.js'

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
const { en, zh, dockChip, dockNotices, dockDisplay, createDockFeed, DockPanel, scopeChipView } = client
const plain = (value) => JSON.parse(JSON.stringify(value))
const tFor = (dict) => (key) => dict[key] ?? key
const te = tFor(en)
const tz = tFor(zh)

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

/** A fake clock: timers fire only when `tick` passes their time. */
function fakeClock() {
  let now = 0
  let next = 1
  const timers = new Map()
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, at: now + ms }); return id },
    clearTimer: (id) => timers.delete(id),
    tick(ms) {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = end
    },
    pending: () => timers.size,
  }
}

const NOW = Date.parse('2026-11-26T06:00:00Z')
const iso = (offset) => new Date(NOW + offset).toISOString()
const recallOk = (at = iso(-1000), extra = {}) => ({ status: 'ok', at, count: 20, latencyMs: 119, query: 'what does the user prefer for tests', preview: [{ memory: 'Uses node:test' }, { memory: 'Prefers small PRs' }, { memory: 'Writes in Chinese' }, { memory: 'Fourth' }], timings: { embedMs: 80, searchMs: 30, otherMs: 9, totalMs: 119 }, ...extra })
const saved = (at = iso(-500), extra = {}) => ({ status: 'saved', at, count: 2, facts: 2, add: 2, update: 0, none: 0, delete: 0, ...extra })

test('short states: at most 12 characters, no product name, the spec wording', () => {
  assert.equal(zh.dockShortRecalled, '已召回 {count}')
  const cases = [
    [{ recall: recallOk() }, '已召回 20', 'Recalled 20'],
    [{ capture: { status: 'saving' } }, '保存中', 'Saving'],
    [{ capture: saved(iso(-500), { count: 3, add: 3 }) }, '已保存 3', 'Saved 3'],
    [{ capture: saved(iso(-500), { facts: 1, add: 0, none: 1, count: 0 }) }, '无新内容', 'Nothing new'],
    [{ recall: { status: 'searching' } }, '召回中', 'Recalling'],
  ]
  for (const [activity, zhText, enText] of cases) {
    assert.equal(dockChip(tz, { data: { activity } }, NOW).short, zhText)
    assert.equal(dockChip(te, { data: { activity } }, NOW).short, enText)
  }
  const failed = { activity: { capture: { status: 'error', at: iso(-100) } }, failures: [{ kind: 'capture', cause: 'auth', at: iso(-100) }] }
  assert.equal(dockChip(tz, { data: failed }, NOW).short, '记忆失败')
  assert.equal(dockChip(te, { data: failed }, NOW).short, 'Failed')
  const paused = { activity: { capture: { status: 'skipped', reason: 'circuit-open', circuitUntil: iso(120_000), at: iso(-100) } } }
  assert.equal(dockChip(tz, { data: paused }, NOW).short, '记忆已暂停')
  assert.equal(dockChip(te, { data: paused }, NOW).short, 'Paused')
  for (const dict of [en, zh]) {
    for (const key of Object.keys(dict).filter((name) => name.startsWith('dockShort'))) {
      const text = dict[key].replace('{count}', '20')
      assert.ok([...text].length <= 12, `${key}: ${text}`)
      assert.doesNotMatch(text, /Mem0/)
    }
  }
})

test('whole sentences: "已召回记忆 20 · 119 ms", "已保存 2 条新记忆", "记忆失败：…"', () => {
  assert.equal(dockChip(tz, { data: { activity: { recall: recallOk() } } }, NOW).full, '已召回记忆 20 · 119 ms')
  assert.equal(dockChip(te, { data: { activity: { recall: recallOk() } } }, NOW).full, 'Recalled 20 memories · 119 ms')
  assert.equal(dockChip(tz, { data: { activity: { capture: saved() } } }, NOW).full, '已保存 2 条新记忆')
  assert.equal(dockChip(tz, { data: { activity: { capture: saved(iso(-1), { add: 1, update: 2 }) } } }, NOW).full, '已保存 1 条新记忆 · 更新 2 条')
  const failed = { activity: { capture: { status: 'error', at: iso(-100) } }, failures: [{ kind: 'capture', cause: 'auth', at: iso(-100) }] }
  assert.equal(dockChip(tz, { data: failed }, NOW).full, '记忆失败：认证或额度')
  assert.equal(dockChip(te, { data: failed }, NOW).full, 'Memory failed: Auth or quota')
})

test('an in-progress state is not a notice; finished recall, save, failure and pause are', () => {
  for (const status of ['saving', 'queued', 'extracting']) assert.equal(dockNotices(tz, { activity: { capture: { status } } }, NOW).length, 0)
  assert.equal(dockNotices(tz, { activity: { recall: { status: 'searching' } } }, NOW).length, 0)
  const kinds = dockNotices(tz, { activity: { recall: recallOk(iso(-3000)), capture: saved(iso(-1000)) } }, NOW).map((notice) => notice.kind)
  assert.deepEqual(plain(kinds), ['capture', 'recall'], 'newest first')
  assert.equal(dockNotices(tz, { activity: { capture: { status: 'error', at: iso(0) } } }, NOW)[0].kind, 'error')
})

test('fake clock: a new notice stays 8 s, a newer one replaces it and restarts the 8 s', () => {
  const clock = fakeClock()
  const feed = createDockFeed(clock)
  const n = (key, at) => ({ key, at, full: `full ${key}`, short: key, tone: 'ok', lines: [] })
  // What happened before the page loaded fills the list but is not shown.
  assert.equal(feed.observe([n('old', 1)]), null)
  assert.equal(feed.snapshot().dwell, null)
  assert.equal(feed.snapshot().recent.length, 1)
  feed.observe([n('a', 2)])
  assert.equal(feed.snapshot().dwell.key, 'a')
  assert.equal(feed.snapshot().announce, 'full a')
  clock.tick(5000)
  feed.observe([n('b', 3), n('a', 2)])
  assert.equal(feed.snapshot().dwell.key, 'b')
  clock.tick(5000)
  assert.equal(feed.snapshot().dwell?.key, 'b', 'restarted: 5 s into the new 8 s')
  clock.tick(3000)
  assert.equal(feed.snapshot().dwell, null, 'folded after 8 s')
  assert.deepEqual(plain(feed.snapshot().recent.map((item) => item.key)), ['b', 'a', 'old'], 'the replaced one is kept in the list')
  // The same records polled again are not new.
  assert.equal(feed.observe([n('b', 3)]), null)
  assert.equal(feed.snapshot().dwell, null)
})

test('fake clock: hover pauses the countdown, leaving resumes what was left', () => {
  const clock = fakeClock()
  const feed = createDockFeed(clock)
  feed.prime()
  feed.observe([{ key: 'a', at: 1, full: 'A', tone: 'ok', lines: [] }])
  clock.tick(6000)
  feed.hover(true)
  clock.tick(60_000)
  assert.equal(feed.snapshot().dwell?.key, 'a', 'kept while hovered')
  feed.hover(false)
  clock.tick(1999)
  assert.equal(feed.snapshot().dwell?.key, 'a')
  clock.tick(1)
  assert.equal(feed.snapshot().dwell, null, 'the 2 s left ran out')
  // A notice that arrives during hover starts its 8 s on leave.
  feed.hover(true)
  feed.observe([{ key: 'b', at: 2, full: 'B', tone: 'ok', lines: [] }])
  clock.tick(20_000)
  assert.equal(feed.snapshot().dwell?.key, 'b')
  feed.hover(false)
  clock.tick(8000)
  assert.equal(feed.snapshot().dwell, null)
  assert.equal(clock.pending(), 0)
})

test('the panel keeps the last 5, newest first', () => {
  const clock = fakeClock()
  const feed = createDockFeed(clock)
  feed.prime()
  for (let i = 1; i <= 7; i += 1) feed.observe([{ key: `k${i}`, at: i, full: `F${i}`, tone: 'ok', lines: [] }])
  assert.deepEqual(plain(feed.snapshot().recent.map((item) => item.key)), ['k7', 'k6', 'k5', 'k4', 'k3'])
  // A record that arrives late is placed by its time, not its arrival.
  feed.observe([{ key: 'late', at: 4.5, full: 'L', tone: 'ok', lines: [] }])
  assert.deepEqual(plain(feed.snapshot().recent.map((item) => item.key)), ['k7', 'k6', 'k5', 'late', 'k4'])
  assert.equal(client.DOCK_RECENT_MAX, 5)
  assert.equal(client.DOCK_DWELL_MS, 8000)
})

test('switch off: short state, the 8 s notice, then short again; a failure is never folded', () => {
  const chip = dockChip(tz, { data: { activity: { recall: recallOk() } } }, NOW)
  const short = dockDisplay(chip, { dwell: null, details: false })
  assert.equal(short.text, '已召回 20')
  assert.equal(short.aria, '已召回记忆 20 · 119 ms', 'the accessible name is whole in short mode too')
  const dwell = dockDisplay(chip, { dwell: chip.notices[0], details: false })
  assert.equal(dwell.text, '已召回记忆 20 · 119 ms')
  assert.equal(dwell.mode, 'dwell')
  // In progress: only the short state changes, no dwell.
  const busy = dockChip(tz, { data: { activity: { recall: recallOk(), capture: { status: 'saving' } } } }, NOW)
  assert.equal(dockDisplay(busy, { dwell: chip.notices[0] }).text, '保存中')

  const failure = { kind: 'capture', cause: 'extraction', reason: 'truncated', detail: 'cut at its length', extract: { maxTokens: 2000 }, component: 'llm', at: iso(-3_600_000) }
  // An hour old: no 10-minute timeout, still red.
  const failedData = { activity: { capture: { status: 'error', at: iso(-3_600_000) } }, failures: [failure] }
  const failed = dockChip(tz, { data: failedData }, NOW)
  assert.equal(failed.sticky, true)
  const shown = dockDisplay(failed, { dwell: null, details: false })
  assert.equal(shown.mode, 'sticky')
  assert.equal(shown.tone, 'error')
  assert.match(shown.text, /^记忆失败：/)
  // A later successful recall clears it.
  const cleared = dockChip(tz, { data: { ...failedData, activity: { ...failedData.activity, recall: recallOk(iso(-1000)) } } }, NOW)
  assert.equal(cleared.sticky, false)
  assert.equal(cleared.short, '已召回 20')
  // An older success does not.
  assert.equal(dockChip(tz, { data: { ...failedData, activity: { ...failedData.activity, recall: recallOk(iso(-7_200_000)) } } }, NOW).sticky, true)
  // Paused also stays.
  const paused = dockChip(tz, { data: { activity: { capture: { status: 'skipped', reason: 'circuit-open', circuitUntil: iso(120_000), at: iso(-1) } } } }, NOW)
  assert.equal(dockDisplay(paused, {}).mode, 'sticky')
  assert.match(dockDisplay(paused, {}).text, /^记忆已暂停 · 2 min 0 s 后恢复$/)
})

test('switch on: the whole sentence always; the partition chip names the project', () => {
  const chip = dockChip(tz, { data: { activity: { recall: recallOk() } } }, NOW)
  const on = dockDisplay(chip, { dwell: null, details: true })
  assert.equal(on.text, '已召回记忆 20 · 119 ms')
  assert.equal(on.aria, on.text)
  const scope = { available: true, partitions: true, project: { id: 'p1', name: 'pocket-ledger' }, detail: { basis: 'git-origin' } }
  const view = scopeChipView(tz, scope)
  assert.equal(view.label, '项目')
  assert.equal(view.long, '项目 pocket-ledger')
  assert.equal(view.ariaLabel, 'Mem0 记忆分区：项目 pocket-ledger', 'aria unchanged by the switch')
  assert.equal(scopeChipView(te, scope).long, 'Project pocket-ledger')
  assert.equal(scopeChipView(tz, { ...scope, partitions: false }, false).long, '全局')
  const button = (details) => {
    let found
    walk(render(client.ScopeChip({ ctx: {}, t: tz, scope, details })), (node) => { if (node.type === 'button') found = node })
    return found
  }
  assert.equal(textOf(button(false)), '项目')
  assert.equal(textOf(button(true)), '项目 pocket-ledger')
  assert.equal(button(true).props['aria-label'], button(false).props['aria-label'])
})

test('the dock button: whole-sentence aria-label, an aria-live region, the switch read from the config form', () => {
  const form = (dockDetails) => ({ getSnapshot: () => ({ status: 'ready', value: { dockDetails } }), subscribe: () => () => {} })
  const ctx = (dockDetails) => ({ configForms: { get: () => form(dockDetails) }, get: () => null })
  for (const value of [false, true]) {
    const tree = render(client.MemoryDockStatus({ ctx: ctx(value), t: tz, sessionId: `s-${value}` }))
    let button
    let live
    walk(tree, (node) => {
      if (node.props.className === 'mem0-dock') button = node
      if (node.props['aria-live'] === 'polite') live = node
    })
    assert.ok(button.props['aria-label'], 'has a whole accessible name')
    assert.ok(live, 'announces new notices politely')
    assert.equal(live.props.role, 'status')
  }
})

test('the panel: title, current sentence, recent entries with times, details on click, footer link', () => {
  const failure = { kind: 'capture', cause: 'extraction', reason: 'truncated', detail: 'cut at its length (limit 2000)', extract: { maxTokens: 2000 }, component: 'llm', at: iso(-10) }
  const data = { activity: { recall: recallOk(iso(-60_000)), capture: { status: 'error', at: iso(-10) } }, failures: [failure] }
  const chip = dockChip(tz, { data }, NOW)
  const recent = chip.notices
  let opened = 0
  const panel = (expanded) => render(DockPanel({ t: tz, chip, recent, expanded, onExpand() {}, onSettings: () => { opened += 1 }, id: 'x', popRef: {}, style: {} }))
  const closed = panel(null)
  const text = textOf(closed)
  assert.ok(text.startsWith('Mem0 · 最近一轮'))
  assert.ok(text.includes(chip.full))
  assert.ok(text.includes('最近 5 条'))
  assert.ok(text.includes('点一条看详情 · 打开设置'))
  let items = 0
  walk(closed, (node) => { if (node.props.className === 'mem0-dock-item') items += 1 })
  assert.equal(items, 2)
  assert.match(text, /\d\d:\d\d已召回记忆 20 · 119 ms/)
  // Recall details: query, the first 3 results, the timing line.
  const recallKey = recent.find((notice) => notice.kind === 'recall').key
  const recallText = textOf(panel(recallKey))
  assert.ok(recallText.includes('查询：what does the user prefer for tests'))
  assert.ok(recallText.includes('Writes in Chinese'))
  assert.ok(!recallText.includes('Fourth'), 'only the first 3')
  assert.ok(recallText.includes('各步耗时'))
  // Failure details reuse failureMessage (the #43 output-limit advice).
  const errorKey = recent.find((notice) => notice.kind === 'error').key
  const errorText = textOf(panel(errorKey))
  assert.ok(errorText.includes(client.failureMessage(tz, failure)))
  assert.ok(errorText.includes('llmMaxTokens'))
  let link
  walk(closed, (node) => { if (node.props.className === 'mem0-dock-pop-link') link = node })
  link.props.onClick()
  assert.equal(opened, 1)
})

test('capture details list the stats and the first 3 preview rows', () => {
  const capture = saved(iso(-1), { add: 3, preview: [{ id: '1', memory: 'one', event: 'ADD' }, { id: '2', memory: 'two', event: 'ADD' }, { id: '3', memory: 'three', event: 'UPDATE', previous: 'x' }, { id: '4', memory: 'four', event: 'ADD' }] })
  const [notice] = dockNotices(tz, { activity: { capture } }, NOW)
  assert.ok(notice.lines.some((line) => line === '新增 · one'))
  assert.ok(notice.lines.some((line) => line.endsWith('three')))
  assert.ok(!notice.lines.some((line) => line.endsWith('four')))
})

test('reduced motion turns the fade off', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)\{\.mem0-dock-text\{animation:none\}\}/)
})

test('settings: "Show details in the status bar" is the 5th common switch, off by default', () => {
  assert.equal(client.SETTINGS_LAYOUT.common[4], 'dockDetails')
  assert.equal(client.SETTINGS_LAYOUT.common.length, 5)
  assert.equal(client.normalise({}).dockDetails, false)
  assert.equal(client.normalise({ dockDetails: true }).dockDetails, true)
  assert.ok(client.FIELD_ORDER.includes('dockDetails'))
  assert.equal(zh.dockDetails, '底部栏显示详情')
  assert.equal(en.dockDetails, 'Show details in the status bar')
  assert.equal(zh.dockDetailsHint, '打开后底部栏一直显示完整详情；关闭时只显示简短状态，新提示会先停留 8 秒，再收进悬停时的浮窗。只影响显示。立即生效。')
})

test('config: dockDetails defaults to false; MEM0_DOCK_DETAILS=on/off wins', (t) => {
  assert.equal(unwrapConfig(new Config({})).dockDetails, false)
  assert.equal(unwrapConfig(new Config({ dockDetails: true })).dockDetails, true)
  const saved = process.env.MEM0_DOCK_DETAILS
  t.after(() => {
    if (saved === undefined) delete process.env.MEM0_DOCK_DETAILS
    else process.env.MEM0_DOCK_DETAILS = saved
  })
  delete process.env.MEM0_DOCK_DETAILS
  assert.equal(resolveConfig({}).dockDetails, false)
  assert.equal(resolveConfig({ dockDetails: true }).dockDetails, true)
  assert.equal(resolveConfig({}).dockDetailsSource, 'config')
  process.env.MEM0_DOCK_DETAILS = 'on'
  assert.equal(resolveConfig({ dockDetails: false }).dockDetails, true)
  assert.equal(resolveConfig({}).dockDetailsSource, 'env')
  process.env.MEM0_DOCK_DETAILS = 'OFF'
  assert.equal(resolveConfig({ dockDetails: true }).dockDetails, false)
  process.env.MEM0_DOCK_DETAILS = 'maybe'
  assert.equal(resolveConfig({ dockDetails: true }).dockDetails, true, 'an unknown value leaves the setting')
  assert.equal(dockDetailsFromEnv({}), null)
  assert.equal(dockDetailsFromEnv({ MEM0_DOCK_DETAILS: 'on' }), true)
  assert.equal(dockDetailsFromEnv({ MEM0_DOCK_DETAILS: 'off' }), false)
})

test('MEM0_DOCK_DETAILS=on: /activity reports dockDetails true and the chip shows the whole sentence', async (t) => {
  const saved = process.env.MEM0_DOCK_DETAILS
  t.after(() => {
    if (saved === undefined) delete process.env.MEM0_DOCK_DETAILS
    else process.env.MEM0_DOCK_DETAILS = saved
  })
  const routes = new Map()
  let runtime
  registerGuiRoutes({
    inject(names, register) {
      register({ get: () => ({ requestRejection: () => undefined }), webServer: { register(route) { routes.set(route.path, route.handler); return () => {} } }, effect(fn) { fn() } })
    },
  }, () => runtime)
  const read = async () => {
    const res = { statusCode: 200, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value }, end(body = '') { this.body = body } }
    await routes.get(GUI_ACTIVITY_PATH)({ method: 'GET', url: '/?translate=0' }, res)
    return JSON.parse(res.body)
  }
  const activity = { recall: recallOk(new Date().toISOString()), capture: null }
  delete process.env.MEM0_DOCK_DETAILS
  runtime = { config: resolveConfig({ backend: 'oss', dockDetails: false }), activity, client: {} }
  assert.equal((await read()).dockDetails, false)
  process.env.MEM0_DOCK_DETAILS = 'on'
  runtime = { config: resolveConfig({ backend: 'oss', dockDetails: false }), activity, client: {} }
  const body = await read()
  assert.equal(body.dockDetails, true, 'the environment wins over the setting')

  // The dock prefers the server's value over the config form's.
  const ctx = { configForms: { get: () => ({ getSnapshot: () => ({ status: 'ready', value: { dockDetails: false } }), subscribe: () => () => {} }) }, get: () => null }
  const states = []
  const fakeReact = { ...react, useState: (value) => { const initial = typeof value === 'function' ? value() : value; states.push(initial); return [states.length === 1 ? body : initial, () => {}] } }
  let registered
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window })
  const withData = registered.factory((name) => (name === 'react' ? fakeReact : null)).__test__
  let button
  walk(render(withData.MemoryDockStatus({ ctx, t: tz, sessionId: 'env-on' })), (node) => { if (node.props.className === 'mem0-dock') button = node })
  assert.equal(button.props['data-dock-mode'], 'details')
  assert.match(textOf(button), /^已召回记忆 20 · 119 ms$/)
})

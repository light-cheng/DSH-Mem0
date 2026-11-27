// The capture card's "Last write" block: `activity.lastWrite` keeps the last
// capture round that wrote something (ADD, UPDATE or DELETE), in memory only,
// so a later round with nothing new, a skip or a failure does not hide it.
// Real lifecycle with the REST client over a stubbed fetch (no network).
// Test user only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { MemoryLifecycle, toLastWrite } from '../lib/memory-lifecycle.js'
import { Mem0RestClient } from '../lib/rest-client.js'
import { GUI_ACTIVITY_PATH, GUI_STATUS_PATH, registerGuiRoutes } from '../lib/gui-routes.js'

const USER = 'dsh-mem0-last-write-test-user'
const AGENT = 'dsh-test'
const session = { id: 'last-write-session', header: { origin: 'user' } }

function text(value) {
  return [{ type: 'text', text: value }]
}

/** A lifecycle whose REST backend answers `reply.answer` (or fails with `reply.status`). */
function setup(t) {
  const reply = { status: 200, answer: { results: [] } }
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(reply.answer), { status: reply.status, headers: { 'content-type': 'application/json' } })
  const activity = { recall: null, capture: null, lastWrite: null }
  const client = new Mem0RestClient({ mode: 'server', baseUrl: 'http://mem0.invalid', apiKey: 'x', authType: 'none', userId: USER, agentId: AGENT })
  const lifecycle = new MemoryLifecycle({
    client,
    config: { userId: USER, agentId: AGENT, backend: 'server', autoRecall: false, autoCapture: true, captureMaxChars: 450, captureFilter: 'heuristic' },
    logger: { debug() {}, warn() {} },
    breaker: { isOpen: () => false, recordSuccess() {}, recordFailure() {} },
    activity,
  })
  t.after(() => {
    lifecycle.dispose()
    globalThis.fetch = original
  })
  return { lifecycle, activity, reply }
}

let turnNo = 0
async function turn(ctx, user, reply = '好的，记住了：你下周去北京出差，会帮你安排。') {
  const before = ctx.activity.capture
  turnNo += 1
  ctx.lifecycle.onSessionEvent(session, { type: 'turn/start', data: { turn: turnNo } })
  ctx.lifecycle.onSessionEvent(session, { type: 'user/message', data: { role: 'user', content: text(user), source: { kind: 'user' } } })
  ctx.lifecycle.onSessionEvent(session, { type: 'assistant/message', data: { message: { role: 'assistant', content: text(reply) } } })
  ctx.lifecycle.onSessionEvent(session, { type: 'turn/end', data: { turn: turnNo, reason: { kind: 'completed' } } })
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const now = ctx.activity.capture
    if (now !== before && ['saved', 'extracting', 'error', 'skipped'].includes(now?.status)) break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  // Distinct `at` per round, even within one millisecond.
  await new Promise((resolve) => setTimeout(resolve, 3))
  return ctx.activity.capture
}

const WRITE = {
  results: [
    { id: 'a1', memory: '用户下周去北京出差', event: 'ADD' },
    { id: 'u1', memory: '用户住在杭州', event: 'UPDATE', previous_memory: '用户住在上海' },
    { id: 'n1', memory: 'unchanged', event: 'NONE' },
  ],
}

test('a write sets lastWrite; nothing new, a skip and a failure leave it alone', async (t) => {
  const ctx = setup(t)
  ctx.reply.answer = WRITE
  const first = await turn(ctx, '记住：我下周去北京出差，另外我搬到杭州了')
  assert.equal(first.status, 'saved')
  const lastWrite = ctx.activity.lastWrite
  assert.deepEqual(lastWrite, {
    at: first.at,
    add: 1,
    update: 1,
    delete: 0,
    preview: [
      { id: 'a1', memory: '用户下周去北京出差', event: 'ADD', partition: 'global' },
      { id: 'u1', memory: '用户住在杭州', event: 'UPDATE', previous: '用户住在上海' },
    ],
    scope: 'global',
  })

  // Nothing new: a saved round with 0 writes.
  ctx.reply.answer = { results: [{ id: 'n1', memory: 'unchanged', event: 'NONE' }] }
  const empty = await turn(ctx, '记住：我下周去北京出差，另外我搬到杭州了')
  assert.equal(empty.status, 'saved')
  assert.notEqual(empty.at, first.at)
  assert.equal(ctx.activity.lastWrite, lastWrite)

  ctx.reply.answer = { results: [] }
  await turn(ctx, '记住：我下周去北京出差，另外我搬到杭州了')
  assert.equal(ctx.activity.lastWrite, lastWrite)

  // A skipped round (low value).
  const skipped = await turn(ctx, '嗯')
  assert.equal(skipped.status, 'skipped')
  assert.equal(ctx.activity.lastWrite, lastWrite)

  // A failed round.
  ctx.reply.status = 500
  ctx.reply.answer = { detail: 'boom' }
  const failed = await turn(ctx, '记住：我下周去北京出差，另外我搬到杭州了')
  assert.equal(failed.status, 'error')
  assert.equal(ctx.activity.lastWrite, lastWrite)

  // A new write replaces it.
  ctx.reply.status = 200
  ctx.reply.answer = { results: [{ id: 'd1', memory: '用户不喝咖啡', event: 'DELETE' }] }
  const next = await turn(ctx, '记住：我现在开始喝咖啡了')
  assert.equal(next.status, 'saved')
  assert.equal(ctx.activity.lastWrite.at, next.at)
  assert.deepEqual(ctx.activity.lastWrite.preview, [{ id: 'd1', memory: '用户不喝咖啡', event: 'DELETE' }])
  assert.equal(ctx.activity.lastWrite.delete, 1)
})

test('toLastWrite: only a saved round with an ADD, UPDATE or DELETE counts', () => {
  assert.equal(toLastWrite(null), undefined)
  assert.equal(toLastWrite({ status: 'saved', at: 't', count: 0, add: 0, update: 0, delete: 0 }), undefined)
  assert.equal(toLastWrite({ status: 'saved', at: 't', preview: [{ id: 'n', memory: 'x', event: 'NONE' }] }), undefined)
  for (const status of ['skipped', 'queued', 'saving', 'extracting', 'error']) {
    assert.equal(toLastWrite({ status, at: 't', add: 1, preview: [{ id: 'a', memory: 'x', event: 'ADD' }] }), undefined, status)
  }
  // Counts without rows (a local round whose rows were dropped) still count.
  assert.deepEqual(toLastWrite({ status: 'saved', at: 't', add: 2, messages: 3, count: 2 }), { at: 't', add: 2 })
  // Only the card's fields, not the round's other details.
  const kept = toLastWrite({ status: 'saved', at: 't', messages: 4, via: { kind: 'x' }, memoryIds: ['a'], add: 1, preview: [{ id: 'a', memory: 'x', event: 'ADD' }], scope: 'project', project: 'demo' })
  assert.deepEqual(kept, { at: 't', add: 1, preview: [{ id: 'a', memory: 'x', event: 'ADD' }], scope: 'project', project: 'demo' })
})

// --- gui routes ---------------------------------------------------------

function harness(runtime) {
  const routes = new Map()
  registerGuiRoutes(
    {
      inject(names, register) {
        register({
          get: (name) => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
          webServer: { register: (route) => (routes.set(route.path, route.handler), () => {}) },
          effect: (fn) => fn(),
        })
      },
    },
    () => runtime,
  )
  return routes
}

async function get(handler, url) {
  const res = { statusCode: 200, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value }, end(body = '') { this.body = body } }
  await handler({ method: 'GET', url }, res)
  return JSON.parse(res.body)
}

const guiConfig = { backend: 'server', baseUrl: 'http://mem0.invalid', userId: USER, agentId: AGENT }
const guiClient = {
  async health() {
    return { ok: true, backend: 'server' }
  },
  async list() {
    return { results: [] }
  },
}

test('status and activity return lastWrite, sanitized like the capture rows', async () => {
  const lastWrite = {
    at: '2026-11-28T09:00:00.000Z',
    add: 1,
    update: 1,
    preview: [
      { id: 'a1', memory: `key sk-lastWriteFAKE0123456789 ${'x'.repeat(400)}`, event: 'ADD', partition: 'global' },
      { id: 'u1', memory: 'Lives in Hangzhou', event: 'UPDATE', previous: 'Lives in Shanghai' },
      { id: 'n1', memory: 'unknown', event: 'NONE' },
    ],
    secret: 'not returned',
  }
  const routes = harness({
    config: guiConfig,
    client: guiClient,
    activity: { recall: null, capture: { status: 'saved', at: '2026-11-28T09:01:00.000Z', count: 0 }, lastWrite },
  })
  for (const route of [GUI_STATUS_PATH, GUI_ACTIVITY_PATH]) {
    const body = await get(routes.get(route), '/?translate=0')
    const out = body.activity.lastWrite
    assert.equal(out.at, lastWrite.at, route)
    assert.equal(out.add, 1, route)
    assert.equal(out.secret, undefined, route)
    assert.deepEqual(out.preview.map((row) => row.event), ['ADD', 'UPDATE'], route)
    assert.equal(out.preview[0].memory.length, 240, route)
    assert.doesNotMatch(JSON.stringify(out), /sk-lastWriteFAKE/, route)
    assert.equal(out.preview[1].previous, 'Lives in Shanghai', route)
  }
  // No lastWrite yet, and no runtime: null.
  const fresh = harness({ config: guiConfig, client: guiClient, activity: { recall: null, capture: null } })
  assert.equal((await get(fresh.get(GUI_ACTIVITY_PATH), '/?translate=0')).activity.lastWrite, null)
  const none = harness(null)
  for (const route of [GUI_STATUS_PATH, GUI_ACTIVITY_PATH]) assert.equal((await get(none.get(route), '/')).activity.lastWrite, null, route)
})

test('with translation on, lastWrite rows are translated with the capture rows', async () => {
  const routes = harness({
    config: guiConfig,
    client: guiClient,
    localizer: { translate: async (texts, lang) => texts.map((value) => `[${lang}] ${value}`) },
    activity: {
      recall: null,
      capture: { status: 'skipped', at: '2026-11-28T09:01:00.000Z' },
      lastWrite: { at: '2026-11-28T09:00:00.000Z', update: 1, preview: [{ id: 'u1', memory: 'Lives in Hangzhou', event: 'UPDATE', previous: 'Lives in Shanghai' }] },
    },
  })
  const body = await get(routes.get(GUI_ACTIVITY_PATH), '/?lang=zh')
  assert.deepEqual(body.activity.lastWrite.preview, [{ id: 'u1', memory: '[zh] Lives in Hangzhou', event: 'UPDATE', previous: '[zh] Lives in Shanghai' }])
  assert.equal(body.activity.lastWrite.at, '2026-11-28T09:00:00.000Z')
})

// --- the settings page (client.js CapturePanel) -------------------------

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

function render(node) {
  if (Array.isArray(node)) return node.flat(Infinity).map(render)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return render(node.type(node.props))
  return { ...node, props: { ...node.props, children: render(node.props.children ?? []) } }
}

function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit))
  if (!node || typeof node !== 'object') return
  visit(node)
  walk(node.props?.children ?? [], visit)
}

function textOf(node) {
  const parts = []
  const collect = (value) => {
    if (Array.isArray(value)) return value.forEach(collect)
    if (value === null || value === undefined || value === false || value === true) return
    if (typeof value !== 'object') return parts.push(String(value))
    collect(value.props?.children ?? [])
  }
  collect(node)
  return parts.join(' ')
}

const translator = (table) => (key) => table[key] ?? key
const LAST = {
  at: '2026-11-28T09:00:00.000Z',
  add: 1,
  delete: 1,
  preview: [
    { id: 'a1', memory: '用户下周去北京出差', event: 'ADD' },
    { id: 'd1', memory: '用户不喝咖啡', event: 'DELETE' },
  ],
}
const NOTHING_NEW = { status: 'saved', at: '2026-11-28T09:01:00.000Z', messages: 2, count: 0 }

for (const lang of ['en', 'zh']) {
  test(`${lang}: nothing new keeps the last write below, tagged and jumpable`, () => {
    const t = translator(client[lang])
    const jumps = []
    const tree = render(client.CapturePanel({ t, capture: NOTHING_NEW, lastWrite: LAST, backend: 'server', onJump: (id) => jumps.push(id) }))
    const shown = textOf(tree)
    const time = new Date(LAST.at).toLocaleString()
    const heading = lang === 'zh' ? `上次写入 · ${time}` : `Last write · ${time}`
    assert.ok(shown.includes(heading), shown)
    assert.match(shown, lang === 'zh' ? /新增/ : /New/)
    assert.match(shown, lang === 'zh' ? /删除/ : /Removed/)
    assert.match(shown, /用户下周去北京出差/)
    // The latest round's own line is unchanged.
    assert.match(shown, lang === 'zh' ? /2 条消息 · 0 条写入/ : /2 messages · 0 written/)
    assert.doesNotMatch(shown, /[{}]/)
    const rows = []
    walk(tree, (node) => { if (node.props.className === 'mem0-act-item') rows.push(node) })
    assert.equal(rows.length, 2)
    assert.equal(rows[0].type, 'button')
    rows[0].props.onClick()
    assert.equal(rows[1].type, 'div', 'a removed memory is not a link')
    assert.deepEqual(jumps, ['a1'])
  })

  test(`${lang}: skipped, failed and in-progress rounds show the last write too`, () => {
    const t = translator(client[lang])
    for (const capture of [
      { status: 'skipped', at: '2026-11-28T09:02:00.000Z', messages: 1, reason: 'low-value' },
      { status: 'error', at: '2026-11-28T09:02:00.000Z', error: 'boom' },
      { status: 'saving', at: '2026-11-28T09:02:00.000Z', messages: 2 },
      { status: 'queued', at: '2026-11-28T09:02:00.000Z', messages: 2 },
    ]) {
      const shown = textOf(render(client.CapturePanel({ t, capture, lastWrite: LAST, backend: 'server', onJump() {} })))
      assert.match(shown, lang === 'zh' ? /上次写入/ : /Last write/, capture.status)
    }
  })

  test(`${lang}: a last write with counts only says how many`, () => {
    const t = translator(client[lang])
    const shown = textOf(render(client.CapturePanel({ t, capture: NOTHING_NEW, lastWrite: { at: LAST.at, add: 2 }, backend: 'oss', onJump() {} })))
    assert.match(shown, lang === 'zh' ? /写入 2 条/ : /2 written/)
    assert.doesNotMatch(shown, /[{}]/)
  })
}

test('the round that wrote is not shown twice, and without lastWrite the card is as before', () => {
  const t = (key) => key
  const writing = { status: 'saved', at: LAST.at, count: 2, preview: LAST.preview }
  const same = textOf(render(client.CapturePanel({ t, capture: writing, lastWrite: LAST, backend: 'server', onJump() {} })))
  assert.doesNotMatch(same, /captureLastWrite/)
  assert.equal(same.match(/用户下周去北京出差/g).length, 1)
  assert.equal(client.lastWriteView(writing, LAST, 'server'), null)

  const before = textOf(render(client.CapturePanel({ t, capture: NOTHING_NEW, backend: 'server', onJump() {} })))
  assert.doesNotMatch(before, /captureLastWrite/)
  assert.equal(textOf(render(client.CapturePanel({ t, capture: NOTHING_NEW, lastWrite: null, backend: 'server', onJump() {} }))), before)
  assert.equal(client.lastWriteView(NOTHING_NEW, null, 'server'), null)
  assert.equal(client.lastWriteView(NOTHING_NEW, { at: 'x', add: 0 }, 'server'), null)

  // The card passes activity.lastWrite down.
  const card = textOf(render(client.ActivityCard({ t, data: { backend: 'server', activity: { recall: null, capture: NOTHING_NEW, lastWrite: LAST } }, onRefresh() {}, onJump() {} })))
  assert.match(card, /captureLastWrite/)
})

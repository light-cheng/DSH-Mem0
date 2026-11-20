import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

import { BEGIN, COMMIT, END, build, clientBlock } from '../scripts/vendor-dissolve.mjs'

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function loadClient() {
  let registered
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
  vm.runInNewContext(read('../client.js'), { window })
  const react = { createElement: () => null, useCallback: (fn) => fn, useEffect() {}, useLayoutEffect() {}, useMemo: (fn) => fn(), useRef: () => ({}), useState: (v) => [v, () => {}] }
  return registered.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require ${name}`)
  })
}

test('client.js inlines vendor/dissolve/thinking-orb.js unchanged', () => {
  const vendored = read('../vendor/dissolve/thinking-orb.js')
  const client = read('../client.js')
  assert.ok(client.includes(clientBlock(vendored)), 'run node scripts/vendor-dissolve.mjs')
  assert.equal(client.split(BEGIN).length, 2)
  assert.equal(client.split(END).length, 2)
  assert.match(vendored, new RegExp(`commit ${COMMIT}`))
})

test('vendor/dissolve/thinking-orb.js is the stripped TypeScript of vendor/dissolve/src', async (t) => {
  const { stripTypeScriptTypes } = await import('node:module')
  if (typeof stripTypeScriptTypes !== 'function') return t.skip('no stripTypeScriptTypes in this Node.js')
  assert.equal(await build(), read('../vendor/dissolve/thinking-orb.js'))
})

test('vendor/dissolve keeps the MIT license and the pinned commit in NOTICE', () => {
  assert.match(read('../vendor/dissolve/LICENSE'), /^MIT License\n\nCopyright \(c\) 2026 Rayan Selmi/)
  const notice = read('../NOTICE')
  assert.match(notice, /dissolve/)
  assert.ok(notice.includes(COMMIT))
  const pkg = JSON.parse(read('../package.json'))
  assert.ok(pkg.files.includes('vendor/dissolve'))
})

test('dock states map to ThinkingOrb states', () => {
  const { dockView, en } = loadClient().__test__
  const t = (key) => en[key] ?? key
  const now = Date.parse('2026-11-20T10:00:00Z')
  const at = new Date(now - 1000).toISOString()
  const orb = (data, extra = {}) => dockView(t, { data, ...extra }, now).orb
  assert.equal(orb({ activity: {} }), 'idle')
  assert.equal(orb({ enabled: false }), 'idle')
  assert.equal(orb({ activity: { recall: { status: 'searching' } } }), 'searching')
  for (const status of ['saving', 'queued', 'extracting']) assert.equal(orb({ activity: { capture: { status } } }), 'thinking')
  assert.equal(orb({ activity: { capture: { status: 'saved', at, count: 2, add: 2, update: 0, delete: 0 } } }), 'done')
  assert.equal(orb({ activity: { recall: { status: 'ok', at, count: 1 } } }), 'done')
  assert.equal(orb({ activity: { capture: { status: 'saved', at, facts: 1, add: 0, update: 0, delete: 0, none: 1 } } }), 'idle')
  assert.equal(orb({ activity: { capture: { status: 'error' } } }), 'error')
  assert.equal(orb(null, { failed: true, fetchError: 'boom' }), 'error')
})

/** A minimal DOM: enough for createThinkingOrb, with the frames, observers and listeners counted. */
function fakeDom({ reduced = false } = {}) {
  let nextFrame = 1
  const frames = new Map()
  const observers = { mutation: 0, intersection: 0, media: 0 }
  const ctx2d = new Proxy({}, {
    get: (target, key) => key === 'getImageData' ? () => ({ data: [10, 20, 30, 255] }) : (key in target ? target[key] : () => {}),
    set: (target, key, value) => { target[key] = value; return true },
  })
  const node = (tag) => {
    const listeners = new Map()
    const element = {
      tagName: tag.toUpperCase(), style: { removeProperty() {} }, dataset: {}, attrs: {}, children: [], parent: null,
      width: 0, height: 0, className: '',
      setAttribute(name, value) { element.attrs[name] = String(value) },
      removeAttribute(name) { delete element.attrs[name] },
      append(child) { child.parent = element; element.children.push(child) },
      appendChild(child) { element.append(child) },
      remove() { if (element.parent) element.parent.children = element.parent.children.filter((c) => c !== element); element.parent = null },
      addEventListener(type, fn) { listeners.set(`${type}`, (listeners.get(type) ?? 0) + 1) },
      removeEventListener(type) { listeners.set(type, (listeners.get(type) ?? 1) - 1) },
      listenerCount: () => [...listeners.values()].reduce((sum, n) => sum + n, 0),
      getContext: () => ctx2d,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 18, height: 18 }),
    }
    return element
  }
  const head = node('head')
  const document = {
    head, documentElement: node('html'), body: node('body'),
    createElement: node,
    getElementById: (id) => head.children.find((child) => child.id === id) ?? null,
  }
  class MutationObserver { constructor() { observers.mutation += 1 } observe() {} disconnect() { observers.mutation -= 1 } }
  class IntersectionObserver { constructor() { observers.intersection += 1 } observe() {} disconnect() { observers.intersection -= 1 } }
  const matchMedia = (query) => ({
    matches: reduced && query.includes('reduced-motion'),
    addEventListener() { observers.media += 1 },
    removeEventListener() { observers.media -= 1 },
  })
  let clock = 0
  const context = {
    window: { devicePixelRatio: 2 }, document, navigator: {}, MutationObserver, IntersectionObserver, matchMedia,
    getComputedStyle: () => ({ getPropertyValue: () => '', color: 'rgb(10, 20, 30)' }),
    performance: { now: () => clock },
    requestAnimationFrame: (fn) => { const id = nextFrame++; frames.set(id, fn); return id },
    cancelAnimationFrame: (id) => { frames.delete(id) },
    Math, Float32Array, Promise, Set, Map, Object, Array, Number, String, Symbol, setTimeout, clearTimeout,
  }
  vm.runInNewContext(`${read('../vendor/dissolve/thinking-orb.js')}\nthis.kit = dissolveThinkingOrb()`, context)
  /** Runs the frames due now (frames they request wait for the next call). */
  const tick = (ms = 16) => {
    clock += ms
    const due = [...frames.entries()]
    frames.clear()
    for (const [, fn] of due) fn(clock)
    return due.length
  }
  return { kit: context.kit, document, frames, observers, tick, node, ctx2d }
}

test('ThinkingOrb destroy leaves no frame, canvas, observer or listener behind', () => {
  const dom = fakeDom()
  const host = dom.node('span')
  const orb = dom.kit.createThinkingOrb(host, { state: 'idle', size: 18, dots: 36, dotSize: 1.9, haptics: false })
  assert.equal(host.children.length, 1)
  assert.equal(host.children[0].tagName, 'CANVAS')
  assert.equal(host.children[0].width, 36)
  for (const state of ['searching', 'thinking', 'done', 'error', 'idle']) {
    orb.update({ state })
    for (let i = 0; i < 5; i += 1) dom.tick()
  }
  assert.ok(dom.frames.size > 0, 'the loop runs while mounted')
  orb.update({ state: 'done' })
  orb.destroy()
  // At most one frame of a running colour tween fires once more and stops.
  for (let i = 0; i < 3; i += 1) dom.tick()
  assert.equal(dom.frames.size, 0)
  assert.equal(host.children.length, 0)
  assert.equal(host.listenerCount(), 0)
  assert.deepEqual(dom.observers, { mutation: 0, intersection: 0, media: 0 })
  assert.equal(host.dataset.dissolve, undefined)
})

test('ThinkingOrb mounted and destroyed ten times keeps nothing', () => {
  const dom = fakeDom()
  for (let round = 0; round < 10; round += 1) {
    const host = dom.node('span')
    const orb = dom.kit.createThinkingOrb(host, { state: round % 2 ? 'searching' : 'thinking', size: 18, dots: 36, haptics: false })
    dom.tick()
    orb.update({ state: 'done' })
    dom.tick()
    orb.destroy()
  }
  for (let i = 0; i < 3; i += 1) dom.tick()
  assert.equal(dom.frames.size, 0)
  assert.deepEqual(dom.observers, { mutation: 0, intersection: 0, media: 0 })
  assert.equal(dom.document.head.children.filter((child) => child.id === 'dissolve-thinking-orb').length, 1)
})

test('ThinkingOrb under reduced motion draws the same frame every time', () => {
  const dom = fakeDom({ reduced: true })
  const host = dom.node('span')
  const arcs = []
  dom.ctx2d.arc = (x, y, r) => arcs.push(`${x.toFixed(3)},${y.toFixed(3)},${r.toFixed(3)}`)
  const orb = dom.kit.createThinkingOrb(host, { state: 'searching', size: 18, dots: 36, haptics: false })
  for (let i = 0; i < 20; i += 1) dom.tick(50)
  arcs.length = 0
  dom.tick(400)
  const first = arcs.splice(0)
  dom.tick(1300)
  assert.deepEqual(arcs, first)
  orb.destroy()
})

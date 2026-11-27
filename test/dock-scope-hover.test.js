// The composer status and the partition chip are siblings: hovering or
// focusing the "Project" / "Global" chip opens only its own card, hovering
// the status button opens only the status panel, and a click on the chip
// closes a pinned status panel while the switch still flips.
//
// client.js runs against a small React stand-in with real state, effects
// and refs; pointer and focus events follow the DOM's rules (mouseenter /
// mouseleave on each element entered or left, focus and blur bubble).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

/* ---------- a minimal hook renderer ---------- */

const FRAGMENT = 'fragment'
let current = null
const instances = new Map()
let dirty = false

function hook(init) {
  const slot = current.index++
  if (current.inst.hooks.length <= slot) current.inst.hooks.push(init())
  return current.inst.hooks[slot]
}
const changed = (a, b) => !a || !b || a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]))
function effectHook(list) {
  return (fn, deps) => {
    const inst = current.inst
    const state = hook(() => ({ deps: undefined, cleanup: undefined, first: true }))
    if (state.first || deps === undefined || changed(state.deps, deps)) {
      state.first = false
      state.deps = deps
      list.push(() => {
        if (typeof state.cleanup === 'function') state.cleanup()
        state.cleanup = fn()
      })
    }
    inst.effects.add(state)
  }
}
const layoutQueue = []
const effectQueue = []
const react = {
  Fragment: FRAGMENT,
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState(initial) {
    const state = hook(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    state.set ??= (next) => {
      const value = typeof next === 'function' ? next(state.value) : next
      if (!Object.is(value, state.value)) {
        state.value = value
        dirty = true
      }
    }
    return [state.value, state.set]
  },
  useRef: (value) => hook(() => ({ current: value })),
  useMemo(fn, deps) {
    const state = hook(() => ({ deps: undefined, value: undefined, first: true }))
    if (state.first || changed(state.deps, deps)) Object.assign(state, { first: false, deps, value: fn() })
    return state.value
  },
  useCallback(fn, deps) {
    return react.useMemo(() => fn, deps)
  },
  useEffect: effectHook(effectQueue),
  useLayoutEffect: effectHook(layoutQueue),
}

/** A host node: path is its identity across renders. */
function hostNode(type, props, path, parent) {
  return {
    type,
    props,
    path,
    parent,
    children: [],
    style: {},
    contains: (other) => Boolean(other?.path) && (other.path === path || other.path.startsWith(`${path}/`)),
    getBoundingClientRect: () => ({ left: 100, right: 160, top: 560, bottom: 580, width: 60, height: 20 }),
    removeAttribute() {},
  }
}

let seen = new Set()
function renderInto(element, path, parent) {
  if (Array.isArray(element)) {
    element.flat(Infinity).forEach((child, index) => renderInto(child, `${path}/${child?.props?.key ?? index}`, parent))
    return
  }
  if (element === null || element === undefined || element === false || element === true) return
  if (typeof element !== 'object') {
    parent.children.push(String(element))
    return
  }
  const { type, props } = element
  if (typeof type === 'function') {
    const id = `${path}<${type.name}>`
    if (!instances.has(id)) instances.set(id, { hooks: [], effects: new Set() })
    seen.add(id)
    const previous = current
    current = { inst: instances.get(id), index: 0 }
    const out = type(props)
    current = previous
    renderInto(out, `${id}`, parent)
    return
  }
  // A fragment adds no node: its children belong to the parent.
  if (type === FRAGMENT) return renderInto(props.children ?? [], `${path}/fragment`, parent)
  const node = hostNode(type, props, `${path}/${type}`, parent)
  parent.children.push(node)
  if (props.ref && typeof props.ref === 'object') props.ref.current = node
  renderInto(props.children ?? [], node.path, node)
}

function createRoot(element) {
  // One tree at a time: unmount whatever an earlier test left behind.
  for (const inst of instances.values()) {
    for (const state of inst.effects) if (typeof state.cleanup === 'function') state.cleanup()
  }
  instances.clear()
  dirty = false
  let tree = null
  const render = () => {
    seen = new Set()
    const root = hostNode('root', {}, 'root', null)
    renderInto(element(), 'root', root)
    for (const [id, inst] of instances) {
      if (seen.has(id)) continue
      for (const state of inst.effects) if (typeof state.cleanup === 'function') state.cleanup()
      instances.delete(id)
    }
    tree = root
    for (const queue of [layoutQueue, effectQueue]) {
      const run = queue.splice(0)
      for (const fn of run) fn()
    }
  }
  const flush = () => {
    for (let round = 0; round < 50; round++) {
      render()
      if (!dirty) return
      dirty = false
    }
    throw new Error('render loop did not settle')
  }
  return { flush, tree: () => tree }
}

function findAll(root, predicate, out = []) {
  for (const child of root.children) {
    if (typeof child !== 'object') continue
    if (predicate(child)) out.push(child)
    findAll(child, predicate, out)
  }
  return out
}
const byClass = (root, name) => findAll(root, (node) => String(node.props.className ?? '').split(' ').includes(name))
const one = (root, name) => {
  const found = byClass(root, name)
  assert.equal(found.length, 1, `exactly one .${name}`)
  return found[0]
}
const ancestors = (node) => {
  const out = []
  for (let at = node; at && at.type !== 'root'; at = at.parent) out.push(at)
  return out
}

/* ---------- a fake browser for client.js ---------- */

function fakeBrowser() {
  let now = 0
  let next = 1
  const timers = new Map()
  const listeners = new Map()
  const document = {
    baseURI: 'http://dsh.test/',
    addEventListener: (kind, fn) => {
      if (!listeners.has(kind)) listeners.set(kind, new Set())
      listeners.get(kind).add(fn)
    },
    removeEventListener: (kind, fn) => listeners.get(kind)?.delete(fn),
  }
  const window = { innerWidth: 1200, innerHeight: 800 }
  return {
    document,
    window,
    setTimeout: (fn, ms = 0) => { const id = next++; timers.set(id, { fn, at: now + ms }); return id },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => next++,
    clearInterval() {},
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
    fire: (kind, event) => [...(listeners.get(kind) ?? [])].forEach((fn) => fn(event)),
  }
}

const browser = fakeBrowser()
const ACTIVITY = {
  activity: { recall: { status: 'ok', at: new Date().toISOString(), count: 3, latencyMs: 90 } },
  memoryScope: { available: true, partitions: true, project: { id: 'p1', name: 'pocket-ledger' }, detail: { basis: 'git-origin' } },
}

function loadClient() {
  let registered
  const window = { ...browser.window, __ModuleLoader__: { load: (entry) => { registered = entry } } }
  browser.window = window
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window,
    document: browser.document,
    setTimeout: browser.setTimeout,
    clearTimeout: browser.clearTimeout,
    setInterval: browser.setInterval,
    clearInterval: browser.clearInterval,
    URL,
    fetch: async () => ({ ok: true, status: 200, json: async () => ACTIVITY }),
  })
  return registered.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require ${name}`)
  }).__test__
}

const client = loadClient()
const t = (key) => client.zh[key] ?? key

/** A config form whose partition switch flips when mutated. */
function fakeForm() {
  const value = { projectPartitions: true, dockDetails: false }
  const subscribers = new Set()
  const mutations = []
  return {
    mutations,
    getSnapshot: () => ({ status: 'ready', writable: true, revision: mutations.length, value: { ...value } }),
    subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn) },
    mutate: async (ops) => {
      mutations.push(ops)
      for (const op of ops) value[op.path[0]] = op.value
      subscribers.forEach((fn) => fn())
      return true
    },
  }
}

const settle = async (root) => {
  for (let round = 0; round < 5; round++) {
    await new Promise((resolve) => setImmediate(resolve))
    root.flush()
  }
}

/** Mounts the dock; returns helpers that act like a pointer and keyboard. */
async function mount(sessionId) {
  const form = fakeForm()
  const ctx = { configForms: { get: () => form }, get: () => null }
  const root = createRoot(() => react.createElement(client.MemoryDockStatus, { ctx, t, sessionId }))
  root.flush()
  await settle(root)
  let hovered = []
  let focused = null
  const tree = () => root.tree()
  const fresh = (node) => findAll(tree(), (other) => other.path === node.path)[0]
  const event = (target, currentTarget, extra = {}) => ({ target, currentTarget, ...extra })
  const ui = {
    form,
    tree,
    status: () => one(tree(), 'mem0-dock'),
    scope: () => one(tree(), 'mem0-scope'),
    panels: () => byClass(tree(), 'mem0-dock-panel'),
    scopeCards: () => byClass(tree(), 'mem0-scope-pop'),
    /** Moves the pointer onto `node` (null: off the dock). */
    hover(node) {
      const target = node ? fresh(node) : null
      const nextPath = target ? ancestors(target) : []
      const nextIds = new Set(nextPath.map((at) => at.path))
      const oldIds = new Set(hovered.map((at) => at.path))
      for (const at of hovered) if (!nextIds.has(at.path)) fresh(at)?.props.onMouseLeave?.(event(target, at))
      root.flush()
      for (const at of [...nextPath].reverse()) {
        if (oldIds.has(at.path)) continue
        const live = fresh(at)
        live?.props.onMouseEnter?.(event(target, live))
        root.flush()
      }
      hovered = nextPath
    },
    /** Moves keyboard focus onto `node` (null: off the dock). */
    focus(node) {
      const target = node ? fresh(node) : null
      if (focused) {
        for (const at of ancestors(fresh(focused) ?? focused)) fresh(at)?.props.onBlur?.(event(focused, fresh(at), { relatedTarget: target }))
        root.flush()
      }
      if (target) {
        for (const at of ancestors(target)) {
          const live = fresh(at)
          live?.props.onFocus?.(event(target, live, { relatedTarget: focused }))
          root.flush()
        }
      }
      focused = target
    },
    /** A full click: mousedown reaches the document, then click bubbles. */
    async click(node) {
      const target = fresh(node)
      browser.fire('mousedown', { target })
      root.flush()
      for (const at of ancestors(target)) {
        const live = fresh(at)
        live?.props.onClick?.(event(target, live))
        root.flush()
      }
      await settle(root)
    },
    tick(ms) {
      browser.tick(ms)
      root.flush()
    },
  }
  return ui
}

/* ---------- the tests ---------- */

test('structure: the partition chip is outside .mem0-dock-wrap, beside it in .mem0-dock-group', async () => {
  const ui = await mount('structure')
  const group = one(ui.tree(), 'mem0-dock-group')
  const wrap = one(ui.tree(), 'mem0-dock-wrap')
  const scope = ui.scope()
  assert.equal(wrap.contains(scope), false, 'the chip is not inside the status wrap')
  assert.equal(group.contains(wrap), true)
  assert.equal(group.contains(scope), true)
  assert.equal(wrap.parent, group)
  assert.equal(scope.parent, group, 'the chip is a direct child of the group')
  assert.equal(wrap.contains(ui.status()), true, 'the status button stays in the wrap')
  for (const name of ['onMouseEnter', 'onMouseLeave', 'onFocus', 'onBlur', 'onClick', 'ref']) {
    assert.equal(group.props[name], undefined, `the group has no ${name}`)
  }
  const css = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(css, /\.mem0-dock-group\{display:inline-flex;max-width:100%\}/)
  assert.match(css, /\.mem0-scope\{display:inline-flex;align-items:center;margin-left:4px;/, 'the chip keeps its spacing')
})

test('hovering the partition chip shows only its card, not the status panel', async () => {
  const ui = await mount('hover-scope')
  ui.hover(ui.scope())
  assert.equal(ui.scopeCards().length, 1, 'the partition card opens')
  assert.equal(ui.panels().length, 0, 'the status panel stays closed')
  ui.tick(1000)
  assert.equal(ui.panels().length, 0)
  ui.hover(null)
  assert.equal(ui.scopeCards().length, 0)
  assert.equal(ui.panels().length, 0)
})

test('focusing the partition chip shows only its card, not the status panel', async () => {
  const ui = await mount('focus-scope')
  ui.focus(ui.scope())
  assert.equal(ui.scopeCards().length, 1)
  assert.equal(ui.panels().length, 0)
  ui.focus(null)
  assert.equal(ui.scopeCards().length, 0)
  assert.equal(ui.panels().length, 0)
})

test('hovering the status button shows only the status panel; it closes 200 ms after leaving', async () => {
  const ui = await mount('hover-status')
  ui.hover(ui.status())
  assert.equal(ui.panels().length, 1, 'the status panel opens')
  assert.equal(ui.scopeCards().length, 0, 'no partition card')
  // Pointer moves from the button into the panel: the panel stays.
  ui.hover(ui.panels()[0])
  ui.tick(500)
  assert.equal(ui.panels().length, 1)
  // Then on to the partition chip: the status panel goes after the delay.
  ui.hover(ui.scope())
  assert.equal(ui.scopeCards().length, 1)
  ui.tick(199)
  assert.equal(ui.panels().length, 1)
  ui.tick(1)
  assert.equal(ui.panels().length, 0)
  assert.equal(ui.scopeCards().length, 1)
})

test('a pinned status panel closes on a click on the partition chip, and the switch still flips', async () => {
  const ui = await mount('pinned')
  await ui.click(ui.status())
  ui.hover(null)
  ui.tick(1000)
  assert.equal(ui.panels().length, 1, 'pinned by the click: stays after the pointer leaves')
  assert.equal(ui.scope().props['aria-pressed'], true)
  await ui.click(ui.scope())
  assert.equal(ui.panels().length, 0, 'the click on the chip closes the status panel')
  assert.deepEqual(JSON.parse(JSON.stringify(ui.form.mutations)), [[{ op: 'set', path: ['projectPartitions'], value: false }]])
  assert.equal(ui.scope().props['aria-pressed'], false, 'the chip now reads global')
  assert.equal(ui.scope().children.join(''), t('scopeChipGlobal'))
})

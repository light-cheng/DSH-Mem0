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

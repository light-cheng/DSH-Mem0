// Protection against DSH changing the profile patch on its own: the copy
// of the key settings in oss.json's dsh_mem0 block (written after a
// settings-page save), the crash-recovery backup notice, and the restore
// of the dsh-mem0 entry from that backup. Temp folders and test ids only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { resolveConfig, RETIRED_KEY_FIELDS } from '../lib/config.js'
import { MIRROR_FIELDS, mirrorBlock, mirrorSavedSettings, writeSettingsCopy } from '../lib/config-mirror.js'
import { ConfigGuard, describeConfigWarning } from '../lib/config-guard.js'
import { findPatchBackups, mem0EntryOf, parseYaml, readMem0Entry } from '../lib/patch-backup.js'
import { handleBackupHandled, handleSettingsSaved, readBackupForRestore, restorableSettings } from '../lib/settings-routes.js'
import { isSettingsCopyOnly, ossFallbacks } from '../lib/oss-config.js'
import { diagnosticLines } from '../lib/diagnostics.js'

const TEST_USER = 'dsh-mem0-protect-test-user'
const FAKE_KEY = 'sk-test-protect-0123456789abcdef'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-protect-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function logger() {
  const lines = { warn: [], debug: [] }
  return { lines, warn: (line) => lines.warn.push(line), debug: (line) => lines.debug.push(line), info() {} }
}

const SEED_OSS = {
  oss: { embedder: { provider: 'openai', config: { model: 'old-embed', api_key: 'keep-me-literal' } } },
  something_else: { a: 1 },
  dsh_mem0: { embedderModel: 'test-embed', embedderBaseUrl: 'http://127.0.0.1:18100/v1', llmProvider: 'dsh' },
}

// ---- 1. The copy in oss.json ----

test('settings copy: a save writes the key settings into dsh_mem0 and keeps the rest of oss.json', (t) => {
  const file = path.join(tempDir(t), 'oss.json')
  fs.writeFileSync(file, JSON.stringify(SEED_OSS, null, 2))
  const log = logger()
  const outcome = mirrorSavedSettings({
    values: { backend: 'oss', userId: TEST_USER, agentId: 'dsh-test-agent', translateMemories: true, captureStrataFolds: true, storePath: '/tmp/test-store.sqlite', recallTopK: 9, llmMaxTokens: 12000 },
    previous: { backend: 'auto' },
    changed: ['backend', 'userId'],
  }, { file, logger: log })
  assert.equal(outcome.ok, true)
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(after.oss, SEED_OSS.oss, 'the oss block is kept as it was')
  assert.deepEqual(after.something_else, { a: 1 })
  assert.deepEqual(after.dsh_mem0, {
    embedderModel: 'test-embed',
    embedderBaseUrl: 'http://127.0.0.1:18100/v1',
    llmProvider: 'dsh',
    backend: 'oss',
    userId: TEST_USER,
    agentId: 'dsh-test-agent',
    translateMemories: true,
    captureStrataFolds: true,
    storePath: '/tmp/test-store.sqlite',
    llmMaxTokens: 12000,
  })
  assert.ok(!('recallTopK' in after.dsh_mem0), 'only the key fields are copied')
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['oss.json'], 'atomic write: no temporary file left, no backup clutter')
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(log.lines.warn.length, 0)
})

test('settings copy: a write that fails never fails the save, one warning only', (t) => {
  const dir = tempDir(t)
  // Not valid JSON: the copy is not written, the file is left alone.
  const broken = path.join(dir, 'oss.json')
  fs.writeFileSync(broken, '{ "dsh_mem0": ')
  const log = logger()
  const outcome = handleSettingsSaved({ config: { ossConfigPath: broken } }, { action: 'saved', values: { userId: TEST_USER }, changed: ['userId'] }, { logger: log })
  assert.equal(outcome.ok, false)
  assert.equal(log.lines.warn.length, 1)
  assert.match(log.lines.warn[0], /settings were saved, but their copy in oss\.json \(dsh_mem0\) could not be written/)
  assert.equal(fs.readFileSync(broken, 'utf8'), '{ "dsh_mem0": ')

  // The rename fails: the temporary file is removed, nothing thrown.
  const file = path.join(dir, 'other', 'oss.json')
  const failing = { ...fs, renameSync() { const error = new Error('denied'); error.code = 'EACCES'; throw error } }
  const log2 = logger()
  const second = mirrorSavedSettings({ values: { userId: TEST_USER }, changed: ['userId'] }, { file, logger: log2, fsModule: failing })
  assert.equal(second.ok, false)
  assert.equal(log2.lines.warn.length, 1)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [], 'temporary file cleaned up')

  // No oss.json path at all: still only a warning.
  const log3 = logger()
  assert.equal(handleSettingsSaved({ config: {} }, { values: { userId: TEST_USER } }, { logger: log3 }).ok, false)
  assert.equal(log3.lines.warn.length, 1)
})

test('settings copy: never a key, only credential names', (t) => {
  const file = path.join(tempDir(t), 'oss.json')
  fs.writeFileSync(file, JSON.stringify({ dsh_mem0: { apiKey: FAKE_KEY, userId: TEST_USER } }))
  const outcome = handleSettingsSaved({ config: { ossConfigPath: file } }, {
    action: 'saved',
    values: {
      apiKey: FAKE_KEY,
      api_key: FAKE_KEY,
      apiKeyEnv: FAKE_KEY, // a key typed into the name field: not a name
      embedderApiKeyRef: 'DSH_MEM0_EMBEDDER_API_KEY',
      llmApiKeyRef: `${FAKE_KEY}!`,
      baseUrl: `https://user:${FAKE_KEY}@mem0.example.test`,
      backend: 'server',
      userId: TEST_USER,
    },
    changed: ['apiKey', 'apiKeyEnv', 'baseUrl', 'backend'],
  }, { logger: logger() })
  assert.equal(outcome.ok, true)
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(!text.includes(FAKE_KEY), text)
  const block = JSON.parse(text).dsh_mem0
  assert.deepEqual(block, { userId: TEST_USER, embedderApiKeyRef: 'DSH_MEM0_EMBEDDER_API_KEY', backend: 'server' })
  assert.ok(!MIRROR_FIELDS.includes('apiKey'))
})

test('settings copy: a reset removes only the value the profile had; a lost profile wipes nothing', () => {
  const block = { userId: TEST_USER, agentId: 'agent-from-wizard', embedderModel: 'wizard-embed', translateMemories: true }
  // The user set agentId back to the default: removed, it was our copy.
  const reset = mirrorBlock({ ...block, agentId: 'agent-x' }, { values: { agentId: 'dsh' }, previous: { agentId: 'agent-x' }, changed: ['agentId'] })
  assert.ok(!('agentId' in reset.block))
  assert.deepEqual(reset.removed, ['agentId'])
  // A profile field cleared while oss.json holds another value (set by the wizard): kept.
  const wizard = mirrorBlock(block, { values: { embedderModel: '' }, previous: { embedderModel: 'profile-embed' }, changed: ['embedderModel'] })
  assert.equal(wizard.block.embedderModel, 'wizard-embed')
  // After crash recovery the profile holds only backend: nothing is removed.
  const lost = mirrorBlock(block, { values: { backend: 'oss' }, previous: {}, changed: ['backend'] })
  assert.deepEqual(lost.block, { ...block, backend: 'oss' })
  assert.deepEqual(lost.removed, [])
})

// ---- 2. Reading: profile first, dsh_mem0 fills the gaps ----

test('a profile that lost its fields is filled from dsh_mem0; the profile wins where it sets one', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'oss.json')
  fs.writeFileSync(file, JSON.stringify({ dsh_mem0: { backend: 'oss', userId: TEST_USER, agentId: 'dsh-test-agent', translateMemories: true, captureStrataFolds: true, storePath: path.join(dir, 'm.sqlite'), embedderBaseUrl: 'http://127.0.0.1:18101/v1', embedderModel: 'test-embed', llmProvider: 'dsh', apiKeyEnv: 'DSH_MEM0_TEST_KEY', baseUrl: 'http://127.0.0.1:18102', authType: 'bearer' } }))
  // What DSH leaves after crash recovery: nothing (Config defaults only).
  const lost = resolveConfig({}, { ossConfigPath: file })
  assert.equal(lost.backend, 'oss')
  assert.equal(lost.backendSource, 'configured')
  assert.equal(lost.userId, TEST_USER)
  assert.equal(lost.agentId, 'dsh-test-agent')
  assert.equal(lost.translateMemories, true)
  assert.equal(lost.captureStrataFolds, true)
  assert.equal(lost.storePath, path.join(dir, 'm.sqlite'))
  assert.equal(lost.native.embedder.model, 'test-embed')
  assert.equal(lost.apiKeyEnv, 'DSH_MEM0_TEST_KEY')
  assert.deepEqual(lost.profileFields, [])
  assert.ok(lost.settingsFromOss.includes('userId') && lost.settingsFromOss.includes('backend'))
  // The profile still sets userId and backend: they win.
  const kept = resolveConfig({ backend: 'server', userId: 'profile-user' }, { ossConfigPath: file })
  assert.equal(kept.backend, 'server')
  assert.equal(kept.userId, 'profile-user')
  assert.equal(kept.baseUrl, 'http://127.0.0.1:18102', 'the server address comes from the copy')
  assert.equal(kept.authType, 'bearer')
  // Wrong types and choices in dsh_mem0 are ignored.
  assert.deepEqual(ossFallbacks({ dsh_mem0: { backend: 'auto', authType: 'magic', userId: 3, apiKeyEnv: 'has space' } }), {})
})

test('backend auto: an oss.json holding only a Platform user\'s settings copy does not switch to the local backend', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'oss.json')
  fs.writeFileSync(file, JSON.stringify({ dsh_mem0: { userId: TEST_USER, agentId: 'a' } }))
  assert.equal(isSettingsCopyOnly(JSON.parse(fs.readFileSync(file, 'utf8'))), true)
  const config = resolveConfig({ storePath: path.join(dir, 'none.sqlite') }, { ossConfigPath: file })
  assert.equal(config.backend, 'platform')
  assert.equal(config.backendSource, 'auto-default')
  // Local settings in the block (or an oss block) still mean local.
  fs.writeFileSync(file, JSON.stringify({ dsh_mem0: { userId: TEST_USER, embedderModel: 'e' } }))
  assert.equal(resolveConfig({ storePath: path.join(dir, 'none.sqlite') }, { ossConfigPath: file }).backend, 'oss')
  assert.equal(isSettingsCopyOnly({}), true)
  assert.equal(isSettingsCopyOnly({ oss: {} }), false)
})

// ---- 3. The crash-recovery backup notice ----

const BACKUP_TEXT = `# my profile
- {id: workspace-controller, config: {documentsDirectory: /tmp/fake/docs}}
- id: locale
  config: {preference: zh-CN}
- id: ui-theme
  config:
    preference: dark
# Mem0
- id: dsh-mem0
  config:
    backend: oss   # local
    userId: ${TEST_USER}
    agentId: 'dsh-test-agent'
    apiKey: ${FAKE_KEY}
    recallTopK: 7
    translateMemories: true
    embedderBaseUrl: http://127.0.0.1:18103/v1
    pythonPath: /old/venv/bin/python
    reproUnknownKey: x
    captureMaxChars: "not a number"
- id: strata-gate
  config:
    secretThing: other-plugin-secret
`

function seedProfile(t, { savedAt = '2026-11-20T00:00:00.000Z', backupAt = Date.parse('2026-11-25T10:00:00.000Z') } = {}) {
  const profileDir = tempDir(t)
  const dataDir = path.join(profileDir, 'dsh-mem0')
  fs.mkdirSync(dataDir)
  const fingerprint = path.join(dataDir, 'config-fingerprint.json')
  fs.writeFileSync(fingerprint, JSON.stringify({ version: 1, savedAt, fields: ['agentId', 'backend', 'translateMemories', 'userId'] }))
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n')
  const name = `cordis.patch.yml.bak-${backupAt}`
  fs.writeFileSync(path.join(profileDir, name), BACKUP_TEXT)
  return { profileDir, fingerprint, name }
}

test('notice: a backup newer than the last good run is named (file name only), in English and Chinese', async (t) => {
  const { profileDir, fingerprint, name } = seedProfile(t)
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml.bak-1600000000000'), '[]') // older than savedAt
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml.bak-notatime'), '[]') // not a backup name
  const guard = new ConfigGuard({ filePath: fingerprint, profileFields: [], retiredFields: RETIRED_KEY_FIELDS, profileDir })
  const status = guard.status()
  assert.equal(status.backup, name)
  assert.deepEqual(status.missing, ['agentId', 'backend', 'translateMemories', 'userId'])
  const text = describeConfigWarning(status)
  assert.ok(text.includes(name), text)
  assert.match(text, /crash recovery/)
  assert.match(text, /host settings \(language, theme\) and other plugins' settings are in that backup too/)
  assert.match(text, /Restore dsh-mem0 settings from the backup/)
  assert.doesNotMatch(text, /settings sync/)
  for (const secret of [FAKE_KEY, 'other-plugin-secret', TEST_USER, 'zh-CN']) assert.ok(!text.includes(secret), 'nothing of the backup content')
  assert.equal(JSON.parse(fs.readFileSync(fingerprint, 'utf8')).pendingBackup, name)
  assert.ok(diagnosticLines({ config: { backend: 'oss' }, configGuard: guard }).some((line) => line.includes(name)))

  // All fields covered by oss.json: the backup is still named (host and other plugins lost theirs).
  const covered = new ConfigGuard({ filePath: fingerprint, profileFields: [], fallbackFields: ['agentId', 'backend', 'translateMemories', 'userId'], retiredFields: RETIRED_KEY_FIELDS, profileDir })
  assert.deepEqual(covered.status().missing, [])
  assert.equal(covered.status().backup, name)
  covered.markWorking()
  const after = new ConfigGuard({ filePath: fingerprint, profileFields: [], fallbackFields: ['agentId', 'backend', 'translateMemories', 'userId'], retiredFields: RETIRED_KEY_FIELDS, profileDir })
  assert.equal(after.status().backup, name, 'stays pending after a good run')

  // The page, both languages.
  const client = loadClient()
  for (const [lang, dict] of [['en', client.en], ['zh', client.zh]]) {
    const items = client.bannerItems((key) => dict[key], { ok: true, configWarning: status }, { phase: 'ready' })
    assert.equal(items[0].code, 'configWarning')
    assert.equal(items[0].action, 'restore')
    assert.equal(items[0].secondary, 'dismiss')
    assert.ok(items[0].text.includes(name), `${lang}: ${items[0].text}`)
    assert.ok(!items[0].text.includes('{'), `${lang}: placeholders filled`)
    assert.ok(dict.bannerRestore && dict.bannerDismiss && dict.restoreDone && dict.restoreApiKey)
  }
  assert.match(client.zh.configWarningBackup, /宿主设置（语言、主题）和其他插件的设置也在这个备份里/)
  assert.match(client.en.configWarning, /crash recovery/)
  assert.doesNotMatch(client.zh.configWarning, /设置同步/)

  // Dismissed: not named again.
  assert.equal(after.handleBackup(name), true)
  assert.equal(after.status(), null)
  const later = new ConfigGuard({ filePath: fingerprint, profileFields: [], fallbackFields: ['agentId', 'backend', 'translateMemories', 'userId'], retiredFields: RETIRED_KEY_FIELDS, profileDir })
  assert.equal(later.status(), null)
})

test('notice: no backup, an older one, or no fingerprint yet: nothing named', (t) => {
  const { profileDir, fingerprint, name } = seedProfile(t, { savedAt: '2026-11-26T00:00:00.000Z' })
  const guard = new ConfigGuard({ filePath: fingerprint, profileFields: ['agentId', 'backend', 'translateMemories', 'userId'], profileDir })
  assert.equal(guard.status(), null, `${name} is older than the last good run`)
  fs.rmSync(fingerprint)
  assert.equal(new ConfigGuard({ filePath: fingerprint, profileFields: ['backend'], profileDir }).status(), null)
})

// ---- 4. Restore: only the dsh-mem0 entry ----

test('restore: reads only the dsh-mem0 entry, Config fields of the right type, never the key', (t) => {
  const { profileDir, fingerprint, name } = seedProfile(t)
  const before = fs.readFileSync(path.join(profileDir, name), 'utf8')
  const configGuard = new ConfigGuard({ filePath: fingerprint, profileFields: [], profileDir, retiredFields: RETIRED_KEY_FIELDS })
  const runtime = { profileDir, configGuard }
  const outcome = readBackupForRestore(runtime, name)
  assert.equal(outcome.status, 200)
  assert.equal(outcome.body.ok, true)
  assert.deepEqual(outcome.body.settings, {
    backend: 'oss',
    userId: TEST_USER,
    agentId: 'dsh-test-agent',
    recallTopK: 7,
    translateMemories: true,
    embedderBaseUrl: 'http://127.0.0.1:18103/v1',
  })
  assert.deepEqual(outcome.body.skipped, ['captureMaxChars', 'pythonPath', 'reproUnknownKey'])
  assert.equal(outcome.body.hadApiKey, true)
  const body = JSON.stringify(outcome.body)
  for (const secret of [FAKE_KEY, 'other-plugin-secret', 'zh-CN', 'dark', '/tmp/fake/docs']) assert.ok(!body.includes(secret), secret)
  assert.equal(fs.readFileSync(path.join(profileDir, name), 'utf8'), before, 'the backup is only read')

  // The page turns it into DSH settings operations on the dsh-mem0 form only.
  const client = loadClient()
  const ops = JSON.parse(JSON.stringify(client.restoreOps({ ...outcome.body.settings, apiKey: FAKE_KEY }, { backend: 'oss', userId: 'dsh-user' })))
  assert.deepEqual(ops.map((op) => op.path), [['userId'], ['agentId'], ['recallTopK'], ['translateMemories'], ['embedderBaseUrl']])
  assert.ok(ops.every((op) => op.op === 'set' && op.path.length === 1))

  // Only the backup the notice names; marked handled afterwards.
  assert.equal(readBackupForRestore(runtime, 'cordis.patch.yml.bak-1700000000000').status, 409)
  assert.equal(readBackupForRestore(runtime, '../../etc/passwd').status, 404)
  assert.equal(handleBackupHandled(runtime, { file: '../x' }).status, 400)
  const handled = handleBackupHandled(runtime, { file: name })
  assert.equal(handled.body.cleared, true)
  assert.equal(handled.body.configWarning.backup, null)
})

test('restore: a backup without a dsh-mem0 entry, and one that cannot be parsed', (t) => {
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml.bak-1764000000000'), '- id: locale\n  config: {preference: en}\n')
  assert.deepEqual(readMem0Entry(dir, 'cordis.patch.yml.bak-1764000000000'), { found: false, config: {} })
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml.bak-1764000000001'), `- id: dsh-mem0\n  config: &anchor\n    apiKey: ${FAKE_KEY}\n`)
  assert.throws(() => readMem0Entry(dir, 'cordis.patch.yml.bak-1764000000001'), (error) => error.code === 'BACKUP_PARSE' && !error.message.includes(FAKE_KEY))
  assert.throws(() => readMem0Entry(dir, 'oss.json'), /not a profile patch backup name/)
})

test('the YAML reader handles what DSH writes: flow and block style, comments, quotes, insert lists', () => {
  const doc = parseYaml(BACKUP_TEXT)
  assert.equal(doc.length, 5)
  assert.deepEqual(doc[0], { id: 'workspace-controller', config: { documentsDirectory: '/tmp/fake/docs' } })
  assert.equal(mem0EntryOf(doc).config.backend, 'oss')
  assert.deepEqual(parseYaml('[]'), [])
  assert.deepEqual(parseYaml('- insert:\n    - id: dsh-mem0\n      config:\n        userId: "a # b"\n        recallTopK: 3\n'), [{ insert: [{ id: 'dsh-mem0', config: { userId: 'a # b', recallTopK: 3 } }] }])
  assert.equal(mem0EntryOf(parseYaml('- insert:\n    - id: dsh-mem0\n      config: {userId: x}\n')).config.userId, 'x')
  assert.deepEqual(parseYaml("- {id: a, config: {u: 'it''s', v: [1, 2.5, true, null], w: \"x:y\"}}"), [{ id: 'a', config: { u: "it's", v: [1, 2.5, true, null], w: 'x:y' } }])
  assert.deepEqual(parseYaml('- id: a\r\n  config:\r\n    list:\r\n    - x\r\n    - y\r\n'), [{ id: 'a', config: { list: ['x', 'y'] } }], 'CRLF line ends (Windows)')
  assert.throws(() => parseYaml('- id: a\n  config: |\n    text\n'), /block scalars/)
})

// ---- 5. Windows paths ----

test('Windows paths: backups in C:\\ profile folders, and the copy written next to oss.json with a retried rename', () => {
  const win = path.win32
  const profileDir = 'C:\\Users\\tester\\.dsh\\profiles\\desktop'
  const listing = {
    readdirSync: (dir) => {
      assert.equal(dir, profileDir)
      return ['cordis.patch.yml', 'cordis.patch.yml.bak-1764064800000', 'cordis.patch.yml.bak-1764000000000', 'dsh-mem0', 'cordis.patch.yml.bak-99999999999']
    },
    statSync: (file) => {
      assert.equal(file, `${profileDir}\\cordis.patch.yml.bak-99999999999`)
      return { mtimeMs: 1764100000000 }
    },
  }
  const backups = findPatchBackups(profileDir, { fsModule: listing, pathModule: win })
  assert.deepEqual(backups.map((b) => b.name), ['cordis.patch.yml.bak-99999999999', 'cordis.patch.yml.bak-1764064800000', 'cordis.patch.yml.bak-1764000000000'])

  const file = 'C:\\Users\\tester\\.dsh\\mem0\\oss.json'
  const files = new Map([[file, JSON.stringify({ oss: { llm: { provider: 'deepseek' } } })]])
  const calls = []
  let renames = 0
  const memoryFs = {
    readFileSync: (name) => {
      if (!files.has(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return files.get(name)
    },
    mkdirSync: (dir) => calls.push(['mkdir', dir]),
    writeFileSync: (name, text) => {
      calls.push(['write', name])
      files.set(name, text)
    },
    renameSync: (from, to) => {
      renames += 1
      if (renames === 1) throw Object.assign(new Error('busy'), { code: 'EPERM' })
      files.set(to, files.get(from))
      files.delete(from)
    },
    rmSync: (name) => files.delete(name),
    chmodSync: () => calls.push(['chmod']),
  }
  const outcome = writeSettingsCopy({ values: { userId: TEST_USER, storePath: 'D:\\mem0\\memory.sqlite' }, changed: ['userId'] }, { file, fsModule: memoryFs, pathModule: win, platform: 'win32' })
  assert.equal(outcome.changed, true)
  assert.equal(renames, 2, 'an EPERM rename is retried on Windows')
  assert.deepEqual(calls[0], ['mkdir', 'C:\\Users\\tester\\.dsh\\mem0'])
  assert.ok(calls[1][1].startsWith(`${file}.tmp-`), 'temporary file next to oss.json')
  assert.ok(!calls.some((call) => call[0] === 'chmod'), 'no chmod on Windows')
  assert.deepEqual([...files.keys()], [file])
  const written = JSON.parse(files.get(file))
  assert.deepEqual(written.oss, { llm: { provider: 'deepseek' } })
  assert.deepEqual(written.dsh_mem0, { userId: TEST_USER, storePath: 'D:\\mem0\\memory.sqlite' })
})

// The settings page script, loaded the way client-layout.test.js does.
function loadClient() {
  let registered
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window })
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
  return registered.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require ${name}`)
  }).__test__
}

test('the page tells the plugin about a save without the API key', () => {
  const client = loadClient()
  const payload = JSON.parse(JSON.stringify(client.settingsCopyPayload({ backend: 'oss', apiKey: FAKE_KEY, userId: TEST_USER, recallTopK: 3 }, { backend: 'auto' }, ['backend', 'apiKey', 'recallTopK'])))
  assert.deepEqual(payload, { action: 'saved', values: { backend: 'oss', userId: TEST_USER }, previous: { backend: 'auto' }, changed: ['backend'] })
  assert.deepEqual([...client.COPY_FIELDS].sort(), [...MIRROR_FIELDS].sort(), 'the page and the plugin agree on the copied fields')
})

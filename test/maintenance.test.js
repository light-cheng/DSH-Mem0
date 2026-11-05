import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MemoryMaintenance,
  buildProfile,
  dedupeMemories,
  estimateTokens,
  memoryScore,
  rankMemories,
  selectForBudget,
  shouldCaptureConversation,
} from '../lib/memory-maintenance.js'
import { MaintenanceState } from '../lib/maintenance-state.js'
import { buildRecallBlock } from '../lib/memory-lifecycle.js'

function config(overrides = {}) {
  return {
    userId: 'dsh-user',
    profileEnabled: true,
    profileBudgetTokens: 200,
    memoryBudgetTokens: 2200,
    storeMaxMemories: 2,
    storeMaxTokens: 20_000,
    hygieneEnabled: true,
    hygieneIntervalDays: 7,
    ...overrides,
  }
}

function memory(id, text, extra = {}) {
  return { id, memory: text, created_at: '2026-11-01T00:00:00Z', metadata: { source: 'dsh' }, ...extra }
}

function foreignMemory(id, text, extra = {}) {
  return memory(id, text, { metadata: { source: 'other-app' }, ...extra })
}

function tempState(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return { dir, state: new MaintenanceState(path.join(dir, 'maintenance.json')) }
}

function fakeClient(results) {
  const removed = []
  return {
    removed,
    async list() {
      return { results }
    },
    async remove(id) {
      removed.push(id)
    },
  }
}

test('estimateTokens counts CJK and Latin text approximately', () => {
  assert.equal(estimateTokens('你好世界'), 4)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('你好 abcd'), 4)
})

test('capture filter skips acknowledgements and keeps durable preferences', () => {
  assert.equal(shouldCaptureConversation([{ role: 'user', content: 'ok' }, { role: 'assistant', content: 'Done.' }]), false)
  assert.equal(
    shouldCaptureConversation([
      { role: 'user', content: '以后默认用中文回答我' },
      { role: 'assistant', content: '好的。' },
    ]),
    true,
  )
  assert.equal(
    shouldCaptureConversation([{ role: 'user', content: 'ok' }, { role: 'assistant', content: 'Done.' }], { filter: 'off' }),
    true,
  )
})

test('dedupe and profile builder keep one copy and respect the profile budget', () => {
  const memories = [
    memory('a', 'Likes tea'),
    memory('b', 'likes tea.'),
    memory('c', 'Works on DSH plugins'),
  ]
  const { unique, duplicates } = dedupeMemories(memories)
  assert.equal(unique.length, 2)
  assert.equal(duplicates.length, 1)
  const profile = buildProfile(unique, 40)
  assert.match(profile.text, /likes tea/i)
  assert.match(profile.text, /^## /m)
  assert.ok(profile.tokens <= 40)
  assert.ok(profile.items >= 1)
})

test('budget selection removes the lowest-ranked items', () => {
  const memories = [
    memory('a', 'short'),
    memory('b', 'a much longer memory that costs more tokens to include'),
    memory('c', 'medium memory'),
  ]
  const result = selectForBudget(memories, { maxItems: 1, maxTokens: 1000 })
  assert.equal(result.keep.length, 1)
  assert.equal(result.remove.length, 2)
  // Same age: length only breaks the tie, and shorter wins.
  assert.equal(result.keep[0].id, 'a')
})

test('ranking prefers short recent facts over long old ones', () => {
  const now = Date.parse('2026-11-04T00:00:00Z')
  const fresh = memory('fresh', 'Prefers tea', { created_at: '2026-11-03T00:00:00Z' })
  const stale = memory('stale', `Old long note ${'x'.repeat(480)}`, { created_at: '2025-11-01T00:00:00Z' })
  assert.ok(memoryScore(fresh, now) > memoryScore(stale, now))
  assert.deepEqual(rankMemories([stale, fresh], now).map((m) => m.id), ['fresh', 'stale'])
  // Uses the real clock: both dates are relative to today.
  const day = 86_400_000
  const recent = memory('recent', 'Uses zsh', { created_at: new Date(Date.now() - day).toISOString() })
  const old = memory('old', `Long background ${'y'.repeat(400)}`, {
    created_at: new Date(Date.now() - 400 * day).toISOString(),
  })
  const budget = selectForBudget([old, recent], { maxItems: 1, maxTokens: 10_000 })
  assert.deepEqual(budget.keep.map((m) => m.id), ['recent'])
  assert.deepEqual(budget.remove.map((m) => m.id), ['old'])
  const profile = buildProfile([old, recent], 12)
  assert.deepEqual(profile.memoryIds, ['recent'])
  // pinned still beats freshness
  const pinned = memory('pinned', 'Pinned fact', { created_at: '2020-01-01T00:00:00Z', metadata: { source: 'dsh', pinned: true } })
  assert.equal(rankMemories([recent, pinned])[0].id, 'pinned')
})

test('hygiene never deletes memories without the dsh source tag', async () => {
  const { dir, state } = tempState('dsh-mem0-foreign-')
  try {
    const client = fakeClient([
      foreignMemory('f1', 'Likes tea'),
      memory('d1', 'likes tea.'),
      foreignMemory('f2', 'Foreign fact two'),
      foreignMemory('f3', 'Foreign fact three'),
      foreignMemory('f4', 'likes tea'),
      memory('d2', 'Own fact two'),
      memory('d3', 'Own fact three, a bit longer'),
      { id: 'legacy', memory: 'No metadata at all', created_at: '2026-11-01T00:00:00Z' },
    ])
    const maintenance = new MemoryMaintenance({
      client,
      config: config({ storeMaxMemories: 1 }),
      state,
      activity: {},
      logger: { warn() {}, debug() {} },
    })
    const report = await maintenance.run('manual')
    assert.equal(report.dryRun, false)
    assert.equal(report.own, 3)
    assert.equal(report.foreign, 5)
    // d1 duplicates a foreign memory; d3 is over the own-memory budget.
    assert.deepEqual(client.removed.sort(), ['d1', 'd3'])
    for (const id of client.removed) assert.match(id, /^d/)
    assert.match(maintenance.profileBlock(), /Foreign fact two/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('first automatic hygiene run is a preview and deletes nothing', async () => {
  const { dir, state } = tempState('dsh-mem0-first-run-')
  try {
    const client = fakeClient([memory('a', 'Likes tea'), memory('b', 'Likes tea.'), memory('c', 'Works on DSH plugins')])
    const maintenance = new MemoryMaintenance({
      client,
      config: config({ storeMaxMemories: 1 }),
      state,
      activity: {},
      logger: { warn() {}, debug() {} },
    })
    assert.equal(maintenance.isDue(), true)
    const report = await maintenance.maybeRun('startup')
    assert.equal(report.dryRun, true)
    assert.equal(report.deleted, 0)
    assert.equal(report.planned, 2)
    assert.deepEqual(report.plannedDetails.map((item) => item.id).sort(), ['b', 'c'])
    assert.deepEqual(client.removed, [])
    const saved = state.read()
    assert.equal(saved.hygiene.lastRunAt, null)
    assert.ok(saved.hygiene.previewAt)
    assert.equal(saved.hygiene.lastReport.dryRun, true)
    assert.match(maintenance.profileBlock(), /Likes tea/)
    const status = maintenance.status()
    assert.equal(status.previewOnly, true)
    assert.equal(status.lastRunAt, null)
    assert.ok(status.nextRunAt)
    // The preview counts as this interval's pass, so it does not loop hourly.
    assert.equal(maintenance.isDue(), false)
    // Later automatic passes stay previews until a confirmed manual run.
    const later = new Date(Date.now() + 8 * 86_400_000)
    assert.equal(maintenance.isDue(later), true)
    const confirmed = await maintenance.run('manual')
    assert.equal(confirmed.dryRun, false)
    assert.deepEqual(client.removed.sort(), ['b', 'c'])
    assert.ok(state.read().hygiene.lastRunAt)
    assert.equal(maintenance.status().previewOnly, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('manual dry run returns the plan without deleting or writing state', async () => {
  const { dir, state } = tempState('dsh-mem0-dry-run-')
  try {
    const client = fakeClient([memory('a', 'Likes tea'), memory('b', 'Likes tea.')])
    const maintenance = new MemoryMaintenance({
      client,
      config: config(),
      state,
      activity: {},
      logger: { warn() {}, debug() {} },
    })
    const before = JSON.stringify(state.read())
    const report = await maintenance.run('manual', { dryRun: true })
    assert.equal(report.dryRun, true)
    assert.equal(report.planned, 1)
    assert.equal(report.deleted, 0)
    assert.deepEqual(report.plannedDetails.map((item) => item.id), ['b'])
    assert.deepEqual(client.removed, [])
    assert.equal(JSON.stringify(state.read()), before)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('hygiene dedupes, prunes, writes profile state and exposes status', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-maintenance-'))
  try {
    const removed = []
    const client = {
      async list() {
        return {
          results: [
            memory('a', 'Likes tea'),
            memory('b', 'Likes tea.'),
            memory('c', 'Works on DSH plugins'),
            memory('d', 'Another fact'),
          ],
        }
      },
      async remove(id) {
        removed.push(id)
      },
    }
    const state = new MaintenanceState(path.join(dir, 'maintenance.json'))
    const activity = {}
    const maintenance = new MemoryMaintenance({
      client,
      config: config(),
      state,
      activity,
      logger: { warn() {}, debug() {} },
    })
    const report = await maintenance.run('manual')
    assert.equal(report.scanned, 4)
    assert.equal(report.duplicates, 1)
    assert.equal(report.deleted, 2)
    assert.equal(report.storeCount, 2)
    assert.equal(report.storeBefore, 4)
    assert.equal(report.duplicateDetails.length, 1)
    assert.equal(report.deletedDetails.length, 2)
    assert.deepEqual(report.failedDetails, [])
    assert.ok(report.durationMs >= 0)
    assert.ok(report.startedAt)
    assert.ok(report.finishedAt)
    // 'b' duplicates 'a'; of the rest, the longest same-age fact is pruned.
    assert.deepEqual(removed.sort(), ['b', 'c'])
    assert.match(maintenance.profileBlock(), /Another fact/)
    const status = maintenance.status()
    assert.equal(status.enabled, true)
    assert.ok(status.lastRunAt)
    assert.equal(status.profile.items, report.profileItems)
    assert.equal(activity.maintenance.status, 'ok')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('startup rebuilds a legacy flat generated profile without deleting memories', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-legacy-profile-'))
  try {
    const removed = []
    const client = {
      async list() {
        return { results: [memory('a', 'Likes tea'), memory('b', 'Works on DSH plugins')] }
      },
      async remove(id) {
        removed.push(id)
      },
    }
    const state = new MaintenanceState(path.join(dir, 'maintenance.json'))
    const oldLastRun = '2026-11-01T00:00:00.000Z'
    state.write({
      version: 1,
      userId: 'dsh-user',
      profile: {
        userId: 'dsh-user',
        text: '- Likes tea\n- Works on DSH plugins',
        tokens: 12,
        items: 2,
        updatedAt: '2026-11-01T00:00:00.000Z',
        manual: false,
        source: 'generated',
      },
      hygiene: { lastRunAt: oldLastRun, lastReport: { deleted: 0 } },
    })
    const maintenance = new MemoryMaintenance({
      client,
      config: config({ hygieneEnabled: true, profileEnabled: true, storageMaxMemories: 10 }),
      state,
      activity: {},
      logger: { warn() {}, debug() {} },
    })
    const report = await maintenance.maybeRun('startup')
    assert.ok(report)
    assert.equal(report.deleted, 0)
    assert.equal(report.pruned, 0)
    assert.equal(report.profileItems, 2)
    assert.deepEqual(removed, [])
    assert.match(maintenance.profileBlock(), /^## /m)
    assert.equal(state.read().hygiene.lastRunAt, oldLastRun)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('hygiene disabled still builds a profile without deleting memories', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-profile-only-'))
  try {
    const removed = []
    const client = {
      async list() {
        return { results: [memory('a', 'Likes tea'), memory('b', 'Works on DSH plugins')] }
      },
      async remove(id) {
        removed.push(id)
      },
    }
    const state = new MaintenanceState(path.join(dir, 'maintenance.json'))
    const maintenance = new MemoryMaintenance({
      client,
      config: config({ hygieneEnabled: false, profileEnabled: true }),
      state,
      activity: {},
      logger: { warn() {}, debug() {} },
    })
    const report = await maintenance.run('manual')
    assert.equal(report.deleted, 0)
    assert.equal(report.pruned, 0)
    assert.equal(report.profileItems, 2)
    assert.deepEqual(removed, [])
    assert.match(maintenance.profileBlock(), /Likes tea/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('recall block prepends the compact profile without breaking delimiters', () => {
  const block = buildRecallBlock(
    [memory('a', 'Likes tea')],
    new Set(),
    1000,
    '- Works on DSH plugins',
  )
  assert.match(block, /^<mem0-user-profile>/)
  assert.match(block, /<mem0-relevant-memories>/)
  assert.match(block, /Likes tea/)
  assert.ok(block.endsWith('</mem0-relevant-memories>'))
})

test('manual long-term memory persists across hygiene and can be rebuilt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem0-manual-profile-'))
  try {
    const client = {
      async list() {
        return { results: [memory('a', 'Likes tea'), memory('b', 'Works on DSH plugins')] }
      },
      async remove() {},
    }
    const state = new MaintenanceState(path.join(dir, 'maintenance.json'))
    const maintenance = new MemoryMaintenance({
      client,
      config: config({ storeMaxMemories: 10 }),
      state,
      activity: {},
      logger: { warn() {}, debug() {} },
    })
    await maintenance.run('manual')
    const saved = maintenance.setProfileText('- User likes oolong tea')
    assert.equal(saved.profile.manual, true)
    assert.equal(maintenance.profileBlock(), '- User likes oolong tea')
    await maintenance.run('manual')
    assert.equal(maintenance.profileBlock(), '- User likes oolong tea')
    assert.equal(maintenance.status().profile.manual, true)
    const reset = await maintenance.resetProfile()
    assert.equal(reset.profile.manual, false)
    assert.match(maintenance.profileBlock(), /Likes tea/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('stored hygiene reports keep ids and reasons but no memory text', async () => {
  const { dir, state } = tempState('dsh-mem0-report-privacy-')
  try {
    const client = fakeClient([
      memory('a', 'Likes tea'),
      memory('b', 'Likes tea.'),
      memory('c', 'Private fact about the user health'),
      memory('d', 'Another fact'),
    ])
    const forgotten = []
    const localizer = { async forget(texts) { forgotten.push(...texts) } }
    const activity = {}
    const maintenance = new MemoryMaintenance({
      client,
      config: config(),
      state,
      activity,
      localizer,
      logger: { warn() {}, debug() {} },
    })
    const preview = await maintenance.run('manual', { dryRun: true })
    // The live confirmation response may carry a short preview...
    assert.ok(preview.plannedDetails.every((item) => item.preview.length <= 60))
    // ...but the in-memory activity copy does not.
    assert.ok(activity.maintenance.plannedDetails.every((item) => !('preview' in item)))

    const report = await maintenance.run('manual')
    assert.equal(report.deleted, 2)
    for (const key of ['duplicateDetails', 'prunedDetails', 'deletedDetails']) {
      for (const item of report[key]) {
        assert.deepEqual(Object.keys(item).sort(), ['id', 'reason'])
        assert.ok(['duplicate', 'budget'].includes(item.reason))
      }
    }
    const raw = fs.readFileSync(path.join(dir, 'maintenance.json'), 'utf8')
    assert.equal(raw.includes('Private fact'), false)
    assert.equal(raw.includes('Likes tea.'), false)
    assert.equal(maintenance.status().lastReport.deletedDetails.length, 2)
    // Translation cache entries of deleted memories are dropped.
    assert.equal(forgotten.length, 2)
    assert.ok(forgotten.includes('Likes tea.'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('status strips previews from reports written by older versions', () => {
  const { dir, state } = tempState('dsh-mem0-legacy-report-')
  try {
    state.write({
      version: 1,
      userId: 'dsh-user',
      profile: null,
      hygiene: {
        lastRunAt: '2026-11-01T00:00:00Z',
        lastReport: { deleted: 1, deletedDetails: [{ id: 'x', preview: 'old secret text' }] },
      },
    })
    const maintenance = new MemoryMaintenance({ client: fakeClient([]), config: config(), state })
    assert.deepEqual(maintenance.status().lastReport.deletedDetails, [{ id: 'x' }])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

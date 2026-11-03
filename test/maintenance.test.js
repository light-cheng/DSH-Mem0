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
  return { id, memory: text, created_at: '2026-11-01T00:00:00Z', ...extra }
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
    assert.deepEqual(removed.sort(), ['a', 'b'])
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

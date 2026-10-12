import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanAll } from '../src/scan/index.js'
import { buildStats } from '../src/stats.js'
import { allTime, parseSince } from '../src/period.js'
import { makeFixture } from './fixtures.js'

const NOW = Date.parse('2026-10-12T12:00:00.000Z')

test('Claude Code counters: real prompts only, copies counted once', async () => {
  const fx = makeFixture('claude')
  const scan = await scanAll({ ...fx.locations, codexHome: fx.root + '/none', openCodeDb: fx.root + '/none.db' })
  const c = scan.collected['claude-code']
  assert.equal(c.prompts.length, 2)
  assert.equal(c.prompts.filter((p) => p.rage).length, 2)
  assert.equal(c.interrupts.length, 1)
  assert.equal(c.replies.length, 2)
  assert.equal(c.absolutelyRight.length, 2) // straight and curly apostrophe, any case
  assert.equal(c.perfect.length, 1)
  assert.deepEqual(c.tools.map((t) => t.name).sort(), ['Bash', 'Edit', 'MCP tools', 'Read'])
  assert.equal(new Set(c.edits.map((e) => e.file)).size, 1)
  // msg_1 (two lines + a resumed copy), msg_2, msg_3, the subagent's message.
  const records = scan.records.filter((r) => r.source === 'claude-code')
  assert.equal(records.length, 4)
  assert.equal(records.find((r) => r.id === 'claude-code:msg_1')?.output, 50)
})

test('Codex counters: user.text prompts, patches, interrupts', async () => {
  const fx = makeFixture('codex')
  const scan = await scanAll({ ...fx.locations, claudeRoots: [fx.root + '/none'], openCodeDb: fx.root + '/none.db' })
  const c = scan.collected['codex-cli']
  assert.equal(c.prompts.length, 1)
  assert.equal(c.prompts[0].rage, true)
  assert.equal(c.replies.length, 1)
  assert.equal(c.absolutelyRight.length, 1)
  assert.equal(c.perfect.length, 1)
  assert.deepEqual(c.tools.map((t) => t.name).sort(), ['Bash', 'Edit'])
  assert.equal(new Set(c.edits.map((e) => e.file)).size, 2)
  assert.equal(c.interrupts.length, 1)
  assert.equal(scan.records.filter((r) => r.source === 'codex-cli').length, 1)
})

test('OpenCode counters: root-session prompts, parts, aborts', async (t) => {
  const fx = makeFixture('opencode')
  if (!fx.hasOpenCode) {
    t.skip('node:sqlite is not available on this Node')
    return
  }
  const scan = await scanAll({ ...fx.locations, claudeRoots: [fx.root + '/none'], codexHome: fx.root + '/none' })
  const c = scan.collected.opencode
  assert.equal(c.prompts.length, 1)
  assert.equal(c.prompts[0].rage, true)
  assert.equal(c.replies.length, 1)
  assert.equal(c.perfect.length, 1)
  assert.deepEqual(c.tools.map((t) => t.name).sort(), ['Bash', 'Edit'])
  assert.equal(c.edits.length, 1)
  assert.equal(c.interrupts.length, 1)
  assert.equal(scan.records.filter((r) => r.source === 'opencode').length, 2)
})

test('stats over all three harnesses: exact cost, no-price kept apart', async () => {
  const fx = makeFixture('all')
  const scan = await scanAll(fx.locations)
  const stats = buildStats(scan, { period: allTime(NOW), now: NOW })
  const oc = fx.hasOpenCode
  assert.equal(stats.prompts, oc ? 4 : 3)
  assert.equal(stats.fun.rage, oc ? 4 : 3)
  assert.equal(stats.fun.interrupts, oc ? 3 : 2)
  assert.equal(stats.fun.absolutelyRight, 3)
  assert.equal(stats.fun.perfect, oc ? 3 : 2)
  assert.equal(stats.toolCalls, oc ? 8 : 6)
  assert.equal(stats.filesEdited, oc ? 4 : 3)
  assert.equal(stats.fun.nightOwl, 1) // tests run with TZ=UTC
  assert.deepEqual(stats.fun.busiestDay, { date: '2026-09-30', prompts: 1 })
  assert.equal(stats.fun.longestStreakDays, oc ? 4 : 3)
  assert.equal(stats.fun.longestSessionMs, 20 * 60_000 + 10_000)
  assert.equal(stats.sessions, oc ? 3 : 2)
  // Hand-computed: Claude 1.016e10 + Codex 6.65e9 (+ OpenCode's sonnet step 1.65e9) picodollars.
  assert.equal(stats.cost.pico, oc ? 18_460_000_000n : 16_810_000_000n)
  assert.equal(stats.cost.unpricedRequests, oc ? 1 : 0)
  assert.equal(stats.cost.unpricedTokens, oc ? 2150 : 0)
  assert.equal(stats.cashier, 'claude-opus-4-6')
  assert.equal(stats.harnesses.reduce((s, r) => s + r.pico, 0n), stats.cost.pico)
  assert.equal(stats.harnesses.reduce((s, r) => s + r.tokens, 0), stats.tokens.total)
  assert.equal(stats.models.reduce((s, r) => s + r.pico, 0n), stats.cost.pico)
})

test('period filter drops what is outside it', async () => {
  const fx = makeFixture('period')
  const scan = await scanAll(fx.locations)
  const stats = buildStats(scan, { period: parseSince('2026-10-02', NOW), now: NOW })
  assert.equal(stats.prompts, fx.hasOpenCode ? 2 : 1)
  assert.equal(stats.fun.nightOwl, 0)
  assert.equal(stats.requests, fx.hasOpenCode ? 3 : 1)
})

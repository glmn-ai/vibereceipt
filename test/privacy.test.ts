import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanAll } from '../src/scan/index.js'
import { buildStats, statsToJson } from '../src/stats.js'
import { allTime } from '../src/period.js'
import { parsePlan } from '../src/plan.js'
import { buildReceipt } from '../src/receipt/model.js'
import { receiptToText } from '../src/receipt/terminal.js'
import { makeFixture, SECRET_DIR, SECRET_FILE, SECRET_PROJECT, SECRET_PROMPT } from './fixtures.js'

const NOW = Date.parse('2026-10-12T12:00:00.000Z')
const SECRETS = [
  SECRET_PROJECT,
  SECRET_DIR,
  SECRET_FILE,
  SECRET_PROMPT,
  'alice',
  'private_server',
  'secret_tool',
  'make the tests pass',
  'Explore the code base',
  'explore the repo'
]

test('no project path, file name, tool name or prompt text reaches the output', async () => {
  const fx = makeFixture('privacy')
  const scan = await scanAll(fx.locations)
  const stats = buildStats(scan, { period: allTime(NOW), now: NOW, plan: parsePlan('max5') })
  const outputs = [
    receiptToText(buildReceipt(stats)),
    receiptToText(buildReceipt(stats), true),
    JSON.stringify(statsToJson(stats))
  ]
  for (const output of outputs) {
    for (const secret of SECRETS) assert.ok(!output.includes(secret), `output leaks "${secret}"`)
  }
  // The counters keep no text at all: only times, flags and counts.
  const collected = JSON.stringify(scan.collected)
  for (const secret of [SECRET_PROMPT, 'make the tests pass', 'Perfect']) {
    assert.ok(!collected.includes(secret), `counters keep "${secret}"`)
  }
})

test('--projects adds folder base names only', async () => {
  const fx = makeFixture('privacy-projects')
  const scan = await scanAll(fx.locations)
  const stats = buildStats(scan, { period: allTime(NOW), now: NOW, projects: true })
  assert.deepEqual(stats.projects, [SECRET_PROJECT])
  const text = receiptToText(buildReceipt(stats))
  assert.ok(text.includes(SECRET_PROJECT))
  assert.ok(!text.includes(SECRET_DIR))
})

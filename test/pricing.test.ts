import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listCost, PRICE_TABLE_VERSION } from '../src/vendor/neurosquad-core/pricing.js'
import type { UsageRecord } from '../src/vendor/neurosquad-core/types.js'

function record(model: string, tokens: Partial<UsageRecord>): UsageRecord {
  return {
    id: 'claude-code:x',
    source: 'claude-code',
    provider: 'anthropic',
    model,
    at: 0,
    sessionId: 's',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    webSearches: 0,
    ...tokens
  }
}

test('price table version', () => {
  assert.equal(PRICE_TABLE_VERSION, '2026-10-13')
})

test('claude-sonnet-5-5: $2 / $2.50 / $4 / $0.10 / $10, 1.1x for US geo', () => {
  const tokens = { input: 1000, output: 1000, cacheRead: 10_000, cacheWrite: 2000, cacheWrite1h: 500 }
  // 1000*2 + 1000*10 + 10000*0.10 + 1500*2.50 + 500*4 = 18,750 µ$·tok/MTok = 1.875e10 pico
  assert.equal(listCost(record('claude-sonnet-5-5', tokens)).pico, 18_750_000_000n)
  assert.equal(listCost(record('claude-sonnet-5-5-20261001', tokens)).pico, 18_750_000_000n)
  assert.equal(listCost(record('claude-sonnet-5-5', { ...tokens, geo: 'us' })).pico, 20_625_000_000n)
})

test('claude-haiku-5-5: base tier up to 100,000 prompt tokens, higher tier over it', () => {
  // Exactly 100,000 prompt tokens (cache reads count): base tier.
  const at = record('claude-haiku-5-5', { cacheRead: 100_000, output: 1000 })
  // 100000*0.01 + 1000*0.50 = 1,500 → 1.5e9 pico
  assert.equal(listCost(at).pico, 1_500_000_000n)
  // 100,001: the whole request at $0.50 / $0.05 read / $2.50 out.
  const over = record('claude-haiku-5-5', { input: 1, cacheRead: 100_000, output: 1000 })
  // 1*0.50 + 100000*0.05 + 1000*2.50 = 7,500.5 → 7.5005e9 pico
  assert.equal(listCost(over).pico, 7_500_500_000n)
  // Cache writes count toward the prompt and use the tier's write rates.
  const writes = record('claude-haiku-5-5', { cacheWrite: 120_000, cacheWrite1h: 20_000 })
  // 100000*0.625 + 20000*1 = 82,500 → 8.25e10 pico
  assert.equal(listCost(writes).pico, 82_500_000_000n)
  // US geo applies to both tiers.
  assert.equal(listCost({ ...over, geo: 'us' }).pico, 8_250_550_000n)
  assert.equal(listCost({ ...at, geo: 'us' }).pico, 1_650_000_000n)
})

test('GPT-6 Astra, Sol, 6.1 Sol and Luna from Codex; Codex-only models stay unpriced', () => {
  const tokens = { input: 100_000, cacheRead: 100_000, output: 10_000 }
  const codex = (model: string, extra = {}) => ({ ...record(model, { ...tokens, ...extra }), source: 'codex-cli', provider: 'openai' })
  // 100000*10 + 100000*1 + 10000*50 = $1.60
  assert.equal(listCost(codex('gpt-6-astra')).pico, 1_600_000_000_000n)
  assert.equal(listCost(codex('gpt-6-sol')).pico, 320_000_000_000n)
  assert.equal(listCost(codex('gpt-6.1-sol')).pico, 310_000_000_000n)
  assert.equal(listCost(codex('gpt-6-luna')).pico, 16_000_000_000n)
  // Over 272K prompt tokens: 2x input, 1.5x output for the whole request. 300000*20 + 10000*75 = $6.75
  assert.equal(listCost(codex('gpt-6-astra', { input: 300_000, cacheRead: 0 })).pico, 6_750_000_000_000n)
  for (const model of ['codex-auto-review', 'gpt-5.3-codex-spark']) assert.equal(listCost(codex(model)).pico, undefined)
})

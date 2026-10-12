import { test } from 'node:test'
import assert from 'node:assert/strict'
import { monthsLabel, monthsTouched, parsePlan, planMath, PlanError } from '../src/plan.js'
import { parseSince, thisMonth, PeriodError } from '../src/period.js'

const at = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 12).getTime()
const dollars = (n: number): bigint => BigInt(n) * 1_000_000_000_000n

test('plan presets and custom prices', () => {
  assert.equal(parsePlan('max20').monthlyCents, 20000)
  assert.equal(parsePlan('MAX5').monthlyCents, 10000)
  assert.equal(parsePlan('pro').monthlyCents, 2000)
  assert.equal(parsePlan('chatgpt-plus').monthlyCents, 2000)
  assert.equal(parsePlan('chatgpt-pro').monthlyCents, 20000)
  assert.equal(parsePlan('$49.99').monthlyCents, 4999)
  assert.equal(parsePlan('100').monthlyCents, 10000)
  assert.equal(parsePlan('7.5').monthlyCents, 750)
  assert.throws(() => parsePlan('gold'), PlanError)
  assert.throws(() => parsePlan('0'), PlanError)
})

test('calendar months touched', () => {
  assert.equal(monthsTouched(at(2026, 10, 1), at(2026, 10, 31)), 1)
  assert.equal(monthsTouched(at(2026, 9, 28), at(2026, 10, 3)), 2)
  assert.equal(monthsTouched(at(2025, 12, 31), at(2026, 1, 1)), 2)
  assert.equal(monthsTouched(at(2026, 7, 8), at(2026, 10, 12)), 4)
  assert.equal(monthsLabel(at(2026, 7, 8), at(2026, 10, 12)), 'Jul-Oct 2026')
  assert.equal(monthsLabel(at(2025, 12, 8), at(2026, 1, 2)), 'Dec 2025-Jan 2026')
  assert.equal(monthsLabel(at(2026, 10, 1), at(2026, 10, 2)), 'Oct 2026')
})

test('saved and overpaid, exactly', () => {
  const saved = planMath(parsePlan('max20'), dollars(1000), at(2026, 9, 1), at(2026, 10, 5))
  assert.equal(saved.months, 2)
  assert.equal(saved.subscriptionPico, dollars(400))
  assert.equal(saved.deltaPico, dollars(600))
  const over = planMath(parsePlan('$49.99'), dollars(10), at(2026, 10, 1), at(2026, 10, 2))
  assert.equal(over.subscriptionPico, 49_990_000_000_000n)
  assert.equal(over.deltaPico, -39_990_000_000_000n)
})

test('--since and --month', () => {
  const now = new Date(2026, 9, 12, 15).getTime()
  assert.equal(parseSince('7d', now).from, new Date(2026, 9, 6).getTime())
  assert.equal(parseSince('2026-09-01', now).from, new Date(2026, 8, 1).getTime())
  assert.equal(parseSince('30d', now).label, 'LAST 30 DAYS')
  assert.equal(thisMonth(now).from, new Date(2026, 9, 1).getTime())
  assert.throws(() => parseSince('2026-02-30', now), PeriodError)
  assert.throws(() => parseSince('soon', now), PeriodError)
})

// Vendored from @neurosquad/core (MIT) — https://github.com/glmn-ai/neurosquad-cli
// Source: packages/core/src/usage/money.ts at commit 1bc586c20593df20c4c5f9b8489226d06f617a7a
// Copyright (c) 2026 Stanislav Gelman and NeuroSquad contributors. MIT License (see LICENSE-neurosquad-core).
// Read-only copy: do not edit here; change it upstream and re-vendor.

// Exact money for usage reports.
//
// Every amount is an integer number of **picodollars** (1e-12 USD) held in a
// `bigint`, and crosses process boundaries as its base-10 string (JSON has
// no bigint). Why this unit: prices are quoted per million
// tokens with at most a few decimals, so a price in micro-dollars per million
// tokens is an integer, and `tokens × that price` is then *exactly* the cost
// in picodollars — no division, no rounding, no float drift however many
// requests are summed. Rounding happens once, when a number is displayed.

/** Picodollars per dollar. */
export const PICO_PER_DOLLAR = 1_000_000_000_000n

/** A base-10 integer string of picodollars (what travels in a report). */
export type PicoString = string

export const ZERO_PICO: PicoString = '0'

export function toPico(value: PicoString | bigint | undefined | null): bigint {
  if (value === undefined || value === null || value === '') return 0n
  return typeof value === 'bigint' ? value : BigInt(value)
}

/**
 * Dollars as a harness recorded them (a JS number from its JSON, or a
 * decimal string) → picodollars, rounded half away from zero at the 12th
 * decimal.
 *
 * Harnesses store cost as a float, so `0.0793275` arrives as
 * `0.07932750000000001`: the tail is binary noise ~1e-17, five orders below
 * a picodollar, and rounding at 1e-12 removes it without ever changing a real
 * digit. Parsing goes through the number's shortest decimal representation
 * (`String(n)`), not through float arithmetic, so nothing is lost on the way.
 */
export function dollarsToPico(value: number | string): bigint | undefined {
  const text = typeof value === 'number' ? numberToPlainString(value) : value.trim()
  if (text === undefined) return undefined
  const match = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text)
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) return undefined
  const negative = match[1] === '-'
  let digits = (match[2] || '') + (match[3] || '')
  // Position of the decimal point, counted from the left of `digits`.
  let point = (match[2] || '').length + Number(match[4] ?? 0)
  if (point < 0) {
    digits = '0'.repeat(-point) + digits
    point = 0
  }
  if (point > digits.length) digits = digits + '0'.repeat(point - digits.length)
  const whole = digits.slice(0, point) || '0'
  const fraction = digits.slice(point)
  // Keep 12 fractional digits, round on the 13th.
  const kept = (fraction + '0'.repeat(12)).slice(0, 12)
  const next = fraction.length > 12 ? Number(fraction[12]) : 0
  let pico = BigInt(whole) * PICO_PER_DOLLAR + BigInt(kept)
  if (next >= 5) pico += 1n
  return negative ? -pico : pico
}

function numberToPlainString(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined
  // Shortest round-trip form; may be exponential ("1e-7"), which the parser
  // above understands.
  return String(value)
}

/**
 * Picodollars → a dollar string rounded half away from zero to `decimals`
 * places (0…12). `formatDollars(1_234_565_000_000n, 2)` → "1.23".
 */
export function picoToDecimal(pico: bigint, decimals: number): string {
  const places = Math.max(0, Math.min(12, Math.floor(decimals)))
  const negative = pico < 0n
  const abs = negative ? -pico : pico
  const unit = 10n ** BigInt(12 - places)
  let scaled = abs / unit
  const remainder = abs % unit
  if (remainder * 2n >= unit && unit > 1n) scaled += 1n
  const text = scaled.toString().padStart(places + 1, '0')
  const whole = places === 0 ? text : text.slice(0, -places)
  const fraction = places === 0 ? '' : text.slice(-places)
  const body = places === 0 ? whole : `${whole}.${fraction}`
  return negative && scaled !== 0n ? `-${body}` : body
}

/** Every digit there is (trailing zeros trimmed): the exact value, for tooltips and CSV. */
export function picoToExactDollars(pico: bigint): string {
  const full = picoToDecimal(pico, 12)
  return full.includes('.') ? full.replace(/\.?0+$/, '') : full
}

/**
 * How a cost is shown in the UI: cents for anything from a dollar up, four
 * decimals below that (a few hundred tokens cost fractions of a cent, and
 * "$0.00" for real spend would read as "free").
 */
export function formatUsd(pico: bigint): string {
  const abs = pico < 0n ? -pico : pico
  const decimals = abs === 0n ? 2 : abs >= PICO_PER_DOLLAR ? 2 : 4
  const body = picoToDecimal(abs, decimals)
  // Thousands separators on the whole part only.
  const [whole, fraction] = body.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${pico < 0n ? '-' : ''}$${grouped}${fraction !== undefined ? `.${fraction}` : ''}`
}

/** `part / whole` as a percentage with one decimal, from exact integers. */
export function picoShare(part: bigint, whole: bigint): string {
  if (whole <= 0n) return '0%'
  // Tenths of a percent, rounded half up.
  const tenths = (part * 2000n + whole) / (2n * whole)
  const text = `${tenths / 10n}.${tenths % 10n}`
  return `${text.endsWith('.0') ? text.slice(0, -2) : text}%`
}

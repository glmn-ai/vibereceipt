// The receipt as a list of lines — one model, two printers (terminal, PNG).
import type { Stats } from '../stats.js'
import { count, duration, pad2, tokens, usd } from '../format.js'

export const WIDTH = 44
/** Width of the AMOUNT column (right-aligned). */
const AMOUNT = 11

export type Line =
  | { kind: 'text'; text: string; align?: 'left' | 'center' | 'right'; bold?: boolean; dim?: boolean; big?: boolean }
  | { kind: 'item'; name: string; qty: string; amount?: string; bold?: boolean; dim?: boolean; big?: boolean }
  | { kind: 'rule'; char: '-' | '=' | '.' }
  | { kind: 'blank' }
  | { kind: 'barcode'; seed: string }

export interface Receipt {
  lines: Line[]
  /** Short share text: "$X of tokens at API prices". */
  headline: string
  /** Built with `short`: the PNG gets a 4:5 canvas. */
  short: boolean
}

const STORE_LINES = [
  'localhost:3000, your machine',
  'open 24/7, like your agents'
]

/** "name ....... qty   amount", exactly `width` wide. */
export function itemText(name: string, qty: string, amount: string | undefined, width = WIDTH): string {
  const right = amount === undefined ? qty : `${qty}${' '.repeat(Math.max(2, AMOUNT - amount.length))}${amount}`
  const room = width - right.length - 1
  let left = name
  if (left.length > room - 2) left = `${left.slice(0, Math.max(1, room - 3))}~`
  const dots = Math.max(1, width - left.length - right.length - 2)
  return `${left} ${'.'.repeat(dots)} ${right}`.slice(0, width).padEnd(width)
}

/** Two short fields on one line, left and right. */
const split = (left: string, right: string, width = WIDTH): string =>
  `${left}${' '.repeat(Math.max(1, width - left.length - right.length))}${right}`

const shorten = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}~`)

export interface ReceiptOptions {
  /**
   * `--short`: a compact receipt for a timeline (roughly 4:5). Drops the
   * per-tool, token-breakdown and per-model sections and keeps the top 4 fun
   * counters.
   */
  short?: boolean
}

export function buildReceipt(stats: Stats, options: ReceiptOptions = {}): Receipt {
  const short = Boolean(options.short)
  const lines: Line[] = []
  const text = (t: string, extra: Partial<Extract<Line, { kind: 'text' }>> = {}): void => {
    lines.push({ kind: 'text', text: t, ...extra })
  }
  const item = (name: string, qty: string, amount?: string, extra: Partial<Extract<Line, { kind: 'item' }>> = {}): void => {
    lines.push({ kind: 'item', name, qty, amount, ...extra })
  }
  const rule = (char: '-' | '=' | '.' = '-'): void => {
    lines.push({ kind: 'rule', char })
  }
  const blank = (): void => {
    lines.push({ kind: 'blank' })
  }

  const when = new Date(stats.generatedAt)
  const date = `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`
  const time = `${pad2(when.getHours())}:${pad2(when.getMinutes())}`
  const receiptNo = stats.receiptNo

  // ---- Header --------------------------------------------------------------
  if (stats.demo) text('*** DEMO RECEIPT - SAMPLE DATA ***', { align: 'center', bold: true })
  text('VIBE RECEIPT', { align: 'center', big: true, bold: true })
  for (const line of short ? STORE_LINES.slice(0, 1) : STORE_LINES) text(line, { align: 'center', dim: true })
  blank()
  text(split(`DATE ${date}`, `TIME ${time}`))
  text(split(`RECEIPT #${receiptNo}`, stats.period.label))
  if (stats.cashier) text(`CASHIER: ${shorten(stats.cashier, WIDTH - 9)}`)
  rule('=')
  if (!short) {
    text(split('ITEM', 'QTY       AMOUNT'), { dim: true })
    rule('-')
  }

  // ---- Activity ------------------------------------------------------------
  item('SESSIONS', count(stats.sessions))
  if (stats.prompts > 0) item('PROMPTS YOU TYPED', count(stats.prompts))
  if (!short && stats.replies > 0) item('AGENT REPLIES', count(stats.replies))
  if (stats.toolCalls > 0) {
    item('TOOL CALLS', count(stats.toolCalls))
    if (!short) {
      for (const tool of stats.topTools.slice(0, 3)) item(`  ${tool.name}`, count(tool.count), undefined, { dim: true })
    }
  }
  if (short) item('TOKENS', tokens(stats.tokens.total), undefined, { bold: true })
  else {
    if (stats.filesEdited > 0) item('FILES EDITED', count(stats.filesEdited))
    item('MODEL REQUESTS', count(stats.requests))
  }
  rule('-')

  // ---- Tokens --------------------------------------------------------------
  if (!short) {
  text('TOKENS', { bold: true })
  item('  INPUT', tokens(stats.tokens.input))
  item('  OUTPUT', tokens(stats.tokens.output))
  item('  CACHE READ', tokens(stats.tokens.cacheRead))
  item('  CACHE WRITE', tokens(stats.tokens.cacheWrite))
  item('  TOTAL', tokens(stats.tokens.total), undefined, { bold: true })
  rule('-')
  }

  const amountOf = (row: { pico: bigint; requests: number; unpricedRequests: number }): string =>
    row.unpricedRequests === row.requests ? 'NO PRICE' : `${usd(row.pico)}${row.unpricedRequests > 0 ? '*' : ''}`

  text('BY HARNESS', { bold: true })
  for (const row of stats.harnesses) item(`  ${row.label}`, tokens(row.tokens), amountOf(row))
  if (!short && stats.models.length > 0) {
    text(stats.models.length > 3 ? 'BY MODEL (TOP 3)' : 'BY MODEL', { bold: true })
    for (const row of stats.models.slice(0, 3)) item(`  ${row.model}`, tokens(row.tokens), amountOf(row))
  }
  rule('=')

  // ---- Totals --------------------------------------------------------------
  const total = usd(stats.cost.pico)
  const priceNotes = (): void => {
    text(`  at API list prices, table ${stats.cost.priceTable}`, { dim: true })
    if (stats.cost.unpricedRequests > 0 && short) {
      text(`* ${count(stats.cost.unpricedRequests)} requests: no price (not $0)`, { dim: true })
    } else if (stats.cost.unpricedRequests > 0) {
      text(`* ${count(stats.cost.unpricedRequests)} requests have no price (not $0):`, { dim: true })
      text(`  ${tokens(stats.cost.unpricedTokens)} tokens left out of the total`, { dim: true })
    }
  }
  if (stats.plan) {
    const plan = stats.plan
    item('SUBTOTAL', '', total, { bold: true })
    priceNotes()
    item('SUBSCRIPTION', '', `-${usd(plan.subscriptionPico)}`, { bold: true })
    const months = plan.detail
    const oneLine = `  ${plan.plan.label}: ${months}`
    if (short && oneLine.length <= WIDTH) text(oneLine, { dim: true })
    else {
      text(`  ${plan.plan.label}`, { dim: true })
      text(`  ${months}`, { dim: true })
    }
    rule('=')
    const saved = plan.deltaPico >= 0n
    const abs = saved ? plan.deltaPico : -plan.deltaPico
    item(saved ? 'YOU SAVED' : 'YOU OVERPAID', '', usd(abs), { bold: true, big: true })
  } else {
    item('TOTAL', '', total, { bold: true, big: true })
    priceNotes()
    if (!short) {
      blank()
      text('Subscriptions are not billed per token.', { dim: true, align: 'center' })
      text('Compare yours: --plan max20', { dim: true, align: 'center' })
    }
  }

  // ---- Fun counters -------------------------------------------------------
  const fun = stats.fun
  const funLines: [string, string][] = []
  if (fun.absolutelyRight > 0) funLines.push(['"YOU\'RE ABSOLUTELY RIGHT"', count(fun.absolutelyRight)])
  if (fun.perfect > 0) funLines.push(['"PERFECT!"', count(fun.perfect)])
  if (fun.interrupts > 0) funLines.push(['TIMES YOU INTERRUPTED', count(fun.interrupts)])
  if (fun.rage > 0) funLines.push(['RAGE TAX (PROMPTS)', count(fun.rage)])
  if (fun.nightOwl > 0) funLines.push(['NIGHT-OWL PROMPTS 00-05', count(fun.nightOwl)])
  if (fun.busiestDay) funLines.push(['BUSIEST DAY', `${fun.busiestDay.date} (${count(fun.busiestDay.prompts)})`])
  if (fun.longestStreakDays > 1) funLines.push(['LONGEST STREAK', `${fun.longestStreakDays} DAYS`])
  if (fun.longestSessionMs >= 60_000) funLines.push(['LONGEST SESSION', duration(fun.longestSessionMs)])
  if (fun.peakHour) funLines.push(['PEAK HOUR', `${pad2(fun.peakHour.hour)}:00-${pad2((fun.peakHour.hour + 1) % 24)}:00`])
  if (funLines.length > 0) {
    rule('=')
    text('FUN COUNTERS', { align: 'center', bold: true })
    if (!short) rule('.')
    for (const [name, qty] of short ? funLines.slice(0, 4) : funLines) item(name, qty)
  }

  if (stats.projects && stats.projects.length > 0) {
    rule('-')
    text('TOP PROJECTS', { bold: true })
    stats.projects.forEach((name, i) => text(`  ${i + 1}. ${shorten(name, WIDTH - 5)}`))
  }

  // ---- Footer --------------------------------------------------------------
  rule('=')
  text('0 BYTES UPLOADED', { align: 'center', bold: true })
  if (!short) text('read locally, printed locally', { align: 'center', dim: true })
  blank()
  lines.push({ kind: 'barcode', seed: `${receiptNo}|${stats.cost.pico}` })
  if (!short) text(`#${receiptNo}`, { align: 'center', dim: true })
  blank()
  text('*** THANK YOU FOR VIBING ***', { align: 'center', bold: true })
  text('github.com/glmn-ai/vibereceipt', { align: 'center' })
  text('printed by nsq - neurosquad.ai', { align: 'center', dim: true })
  if (stats.demo) {
    blank()
    text('*** DEMO RECEIPT - SAMPLE DATA ***', { align: 'center', bold: true })
  }

  return { lines, headline: `${total} of tokens at API prices`, short }
}

/** A line as plain text, exactly WIDTH wide (barcode: a text stand-in). */
export function lineText(line: Line, barcodeText: (seed: string) => string): string {
  switch (line.kind) {
    case 'blank':
      return ''
    case 'rule':
      return line.char.repeat(WIDTH)
    case 'barcode':
      return barcodeText(line.seed)
    case 'item':
      return itemText(line.name, line.qty, line.amount)
    case 'text': {
      const t = line.text.slice(0, WIDTH)
      if (line.align === 'center') {
        const left = Math.floor((WIDTH - t.length) / 2)
        return ' '.repeat(left) + t
      }
      if (line.align === 'right') return t.padStart(WIDTH)
      return t
    }
  }
}

#!/usr/bin/env node
// vibereceipt — a thermal-printer receipt of your AI coding.
// 100% local: reads your agents' logs on this machine, makes no network calls.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

// node:sqlite (for OpenCode) prints an ExperimentalWarning on some Node
// versions; that is noise on a receipt.
const emitWarning = process.emitWarning.bind(process)
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message
  if (typeof text === 'string' && /sqlite/i.test(text)) return
  return (emitWarning as (...args: unknown[]) => void)(warning, ...rest)
}) as typeof process.emitWarning

// `vibereceipt | head`: a closed pipe ends the program quietly.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

const { allTime, parseSince, PeriodError, thisMonth, thisYear } = await import('./period.js')
const { parsePlan, PlanError } = await import('./plan.js')
const { buildStats, localDate, statsToJson } = await import('./stats.js')
const { buildReceipt } = await import('./receipt/model.js')
const { printReceipt } = await import('./receipt/terminal.js')
const { renderReceiptPng } = await import('./png/render.js')
const { scanAll, lookedIn, defaultLocations } = await import('./scan/index.js')
const { demoScan, DEMO_NOW } = await import('./demo.js')
const { HARNESS_LABEL } = await import('./stats.js')
type HarnessId = import('./scan/collector.js').HarnessId

const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version

const HELP = `vibereceipt ${VERSION}
A thermal-printer receipt of your AI coding: tokens, what they would cost at
API list prices, and funny-but-true counters. Reads Claude Code, Codex CLI and
OpenCode logs on this machine. No network, no account, nothing uploaded.

Usage: npx vibereceipt [options]

Period (default: all time)
  --since <when>     30d, 7d, 4w, 6m, 1y, or a date like 2026-09-01
  --month            this calendar month
  --year             this calendar year

Money
  --plan <plan>      compare with a subscription: pro, max5, max20,
                     chatgpt-plus, chatgpt-pro, or a monthly price (e.g. 100)

Output
  --out <path>       where to save the PNG (default ./vibereceipt-<date>.png)
  --no-png           do not save a PNG
  --no-anim          print instantly (non-TTY output never animates)
  --no-color         no ANSI styling (NO_COLOR is respected too)
  --json             print the stats as JSON instead of the receipt
  --projects         add your top 3 project folder names (off by default)
  --demo             print a clearly labelled DEMO receipt from sample data
  -h, --help         this help
  -v, --version      the version
`

interface Args {
  since?: string
  month: boolean
  year: boolean
  plan?: string
  out?: string
  png: boolean
  anim: boolean
  color: boolean
  json: boolean
  projects: boolean
  demo: boolean
  help: boolean
  version: boolean
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    month: false,
    year: false,
    png: true,
    anim: true,
    color: true,
    json: false,
    projects: false,
    demo: false,
    help: false,
    version: false
  }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    const eq = raw.indexOf('=')
    const flag = raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw
    const inline = raw.startsWith('--') && eq > 0 ? raw.slice(eq + 1) : undefined
    const value = (): string => {
      if (inline !== undefined) return inline
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} needs a value`)
      return next
    }
    switch (flag) {
      case '--since':
        args.since = value()
        break
      case '--month':
        args.month = true
        break
      case '--year':
        args.year = true
        break
      case '--plan':
        args.plan = value()
        break
      case '--out':
      case '-o':
        args.out = value()
        break
      case '--no-png':
        args.png = false
        break
      case '--no-anim':
        args.anim = false
        break
      case '--no-color':
        args.color = false
        break
      case '--json':
        args.json = true
        break
      case '--projects':
        args.projects = true
        break
      case '--demo':
        args.demo = true
        break
      case '-h':
      case '--help':
        args.help = true
        break
      case '-v':
      case '--version':
        args.version = true
        break
      default:
        throw new UsageError(`unknown option ${raw} (see --help)`)
    }
  }
  if ([args.since !== undefined, args.month, args.year].filter(Boolean).length > 1) {
    throw new UsageError('use only one of --since, --month, --year')
  }
  return args
}

/** A one-line spinner on stderr while the logs are read. */
function spinner(enabled: boolean): { update(text: string): void; stop(): void } {
  if (!enabled) return { update() {}, stop() {} }
  const frames = ['|', '/', '-', '\\']
  let frame = 0
  let text = 'looking for agent logs'
  const draw = (): void => {
    process.stderr.write(`\r\x1b[2K  ${frames[frame++ % frames.length]} ${text}`)
  }
  const timer = setInterval(draw, 90)
  draw()
  return {
    update(next) {
      text = next
    },
    stop() {
      clearInterval(timer)
      process.stderr.write('\r\x1b[2K')
    }
  }
}

function addDollars(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(addDollars)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    out[key] = addDollars(inner)
    if (/pico$/i.test(key) && typeof inner === 'string' && /^-?\d+$/.test(inner)) {
      const usdKey = key.replace(/pico$/i, (m) => (m[0] === 'P' ? 'Usd' : 'usd'))
      out[usdKey] = picoDollars(BigInt(inner))
    }
  }
  return out
}

function picoDollars(pico: bigint): string {
  const negative = pico < 0n
  const abs = negative ? -pico : pico
  const whole = abs / 1_000_000_000_000n
  const fraction = (abs % 1_000_000_000_000n).toString().padStart(12, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

async function main(): Promise<number> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`vibereceipt: ${(error as Error).message}\n`)
    return 2
  }
  if (args.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  const now = args.demo ? DEMO_NOW : Date.now()
  let period
  let plan
  try {
    period = args.since ? parseSince(args.since, now) : args.month ? thisMonth(now) : args.year ? thisYear(now) : allTime(now)
    plan = args.plan ? parsePlan(args.plan) : undefined
  } catch (error) {
    if (error instanceof PeriodError || error instanceof PlanError) {
      process.stderr.write(`vibereceipt: ${error.message}\n`)
      return 2
    }
    throw error
  }

  const stdoutTty = Boolean(process.stdout.isTTY)
  const color = args.color && stdoutTty && !process.env.NO_COLOR && process.env.TERM !== 'dumb'
  const animate = args.anim && stdoutTty && !args.json

  let scan
  if (args.demo) scan = demoScan()
  else {
    const spin = spinner(Boolean(process.stderr.isTTY) && !args.json)
    const started = Date.now()
    try {
      scan = await scanAll(defaultLocations(), (harness: HarnessId, done: number, total: number) => {
        const label = HARNESS_LABEL[harness]
        spin.update(total > 1 ? `reading ${label} logs  ${done}/${total} files` : `reading ${label} logs`)
      })
    } finally {
      spin.stop()
    }
    if (process.env.VIBERECEIPT_DEBUG) process.stderr.write(`scanned in ${Date.now() - started} ms\n`)
  }

  const nothingFound =
    scan.records.length === 0 && Object.values(scan.collected).every((c) => c.prompts.length === 0)
  if (nothingFound) {
    for (const source of scan.sources) if (source.note) process.stderr.write(`note: ${source.note}\n`)
    process.stdout.write(
      [
        '',
        '  No AI coding agent logs found on this machine. Looked in:',
        ...lookedIn().map((path) => `    ${path}`),
        '',
        '  Supported: Claude Code, Codex CLI, OpenCode.',
        '  Logs elsewhere? Set CLAUDE_CONFIG_DIR, CODEX_HOME or XDG_DATA_HOME.',
        '  Just curious? Try: npx vibereceipt --demo',
        ''
      ].join('\n') + '\n'
    )
    return 1
  }

  const stats = buildStats(scan, { period, plan, projects: args.projects, demo: args.demo, now })
  if (stats.requests === 0 && stats.prompts === 0) {
    process.stdout.write(`\n  Nothing in this period (${period.label.toLowerCase()}). Try without --since/--month/--year.\n\n`)
    return 1
  }

  const receipt = buildReceipt(stats)
  const pngWanted = args.png && (!args.json || args.out !== undefined)
  const defaultName = `vibereceipt-${args.demo ? 'demo-' : ''}${localDate(Date.now())}.png`
  const pngPath = resolve(args.out ?? defaultName)

  if (args.json) {
    process.stdout.write(`${JSON.stringify(addDollars(statsToJson(stats)), null, 2)}\n`)
  } else {
    await printReceipt(receipt, { color, animate })
    for (const note of stats.notes) process.stdout.write(`  note: ${note}\n`)
  }

  if (pngWanted) {
    try {
      writeFileSync(pngPath, renderReceiptPng(receipt))
    } catch (error) {
      process.stderr.write(`vibereceipt: could not save the PNG to ${pngPath}: ${(error as Error).message}\n`)
      return 1
    }
  }

  if (!args.json) {
    const share = `my AI coding receipt: ${receipt.headline} · npx vibereceipt`
    const url = `https://x.com/intent/post?text=${encodeURIComponent(share)}`
    const b = (t: string): string => (color ? `\x1b[1m${t}\x1b[0m` : t)
    if (pngWanted) process.stdout.write(`  ${b('Receipt saved:')} ${pngPath}\n`)
    process.stdout.write(`  ${b('Share on X:')} ${url}\n`)
    if (pngWanted) process.stdout.write('  Attach the PNG to your post - the link only fills in the text.\n')
    process.stdout.write('\n')
  } else if (pngWanted) {
    process.stderr.write(`Receipt saved: ${pngPath}\n`)
  }
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(`vibereceipt: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exitCode = 1
  }
)

// `--demo`: a believable, clearly labelled sample — generated from a fixed
// seed, run through the same stats and pricing code as real logs.
import type { UsageRecord } from './vendor/neurosquad-core/types.js'
import { emptyCollected, type Collected, type HarnessId } from './scan/collector.js'
import type { ScanResult } from './scan/index.js'

/** The demo receipt is "printed" at this local time, so it is the same every run. */
export const DEMO_NOW = new Date(2026, 9, 12, 21, 47).getTime()

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface ModelPlan {
  harness: HarnessId
  provider: string
  model: string
  weight: number
  /** OpenCode records its own cost; a local model records 0 (= no price). */
  recorded?: 'zero'
}

const MODELS: ModelPlan[] = [
  { harness: 'claude-code', provider: 'anthropic', model: 'claude-opus-4-6', weight: 0.5 },
  { harness: 'claude-code', provider: 'anthropic', model: 'claude-sonnet-4-5-20250929', weight: 0.14 },
  { harness: 'claude-code', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', weight: 0.08 },
  { harness: 'codex-cli', provider: 'openai', model: 'gpt-5.3-codex', weight: 0.18 },
  { harness: 'opencode', provider: 'anthropic', model: 'claude-sonnet-4-5', weight: 0.06 },
  { harness: 'opencode', provider: 'lmstudio', model: 'qwen3-coder-30b', weight: 0.04, recorded: 'zero' }
]

const TOOLS: [string, number][] = [
  ['Bash', 0.36],
  ['Read', 0.27],
  ['Edit', 0.17],
  ['Grep', 0.08],
  ['Write', 0.05],
  ['Glob', 0.04],
  ['TodoWrite', 0.03]
]

const HOURS = [1.4, 0.8, 0.5, 0.3, 0.2, 0, 0, 1, 3, 6, 8, 9, 7, 8, 10, 11, 10, 8, 6, 6, 7, 8, 7, 5]

function pick<T>(items: [T, number][], r: number): T {
  let acc = 0
  const total = items.reduce((s, [, w]) => s + w, 0)
  for (const [item, w] of items) {
    acc += w / total
    if (r < acc) return item
  }
  return items[items.length - 1][0]
}

export function demoScan(): ScanResult {
  const random = rng(20261012)
  const records: UsageRecord[] = []
  const collected: Record<HarnessId, Collected> = {
    'claude-code': emptyCollected(),
    'codex-cli': emptyCollected(),
    opencode: emptyCollected()
  }
  const end = new Date(DEMO_NOW)
  const days = 96
  let requestId = 0
  let fileId = 0
  for (let d = days; d >= 0; d--) {
    const day = new Date(end.getFullYear(), end.getMonth(), end.getDate() - d)
    // A long streak at the end, gappier before it.
    const active = d <= 26 || random() < 0.72
    if (!active) continue
    const sessionCount = 1 + Math.floor(random() * 4)
    for (let s = 0; s < sessionCount; s++) {
      const model = pick(MODELS.map((m) => [m, m.weight] as [ModelPlan, number]), random())
      const harness = model.harness
      const out = collected[harness]
      const session = `demo-${d}-${s}`
      const hour = pick(HOURS.map((w, h) => [h, w] as [number, number]), random())
      let at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, Math.floor(random() * 60)).getTime()
      if (at > DEMO_NOW) continue
      const prompts = 6 + Math.floor(random() * (d === 9 ? 70 : 34))
      for (let p = 0; p < prompts; p++) {
        at += Math.floor((2 + random() * 9) * 60_000)
        if (at > DEMO_NOW) break
        out.prompts.push({ at, session, rage: random() < 0.012 })
        if (random() < 0.035) out.interrupts.push(at + 30_000)
        const steps = 3 + Math.floor(random() * 9)
        let t = at
        for (let k = 0; k < steps; k++) {
          t += Math.floor((4 + random() * 40) * 1000)
          const opus = model.model.includes('opus')
          const cacheRead = Math.floor((opus ? 40_000 : 25_000) + random() * 120_000)
          const record: UsageRecord = {
            id: `${harness}:demo-${requestId++}`,
            source: harness,
            provider: model.provider,
            model: model.model,
            at: t,
            sessionId: session,
            input: Math.floor(random() * (harness === 'codex-cli' ? 6000 : 40)),
            output: Math.floor(120 + random() * 1400),
            cacheRead,
            cacheWrite: harness === 'codex-cli' ? 0 : Math.floor(random() * 6000),
            cacheWrite1h: 0,
            reasoning: 0,
            webSearches: 0
          }
          if (model.recorded === 'zero') record.recordedPico = undefined
          records.push(record)
          if (random() < 0.8) {
            const name = pick(TOOLS, random())
            out.tools.push({ at: t, name })
            if ((name === 'Edit' || name === 'Write') && random() < 0.6) {
              out.edits.push({ at: t, file: `demo/file-${fileId++ % 640}.ts` })
            }
          }
        }
        const replies = 1 + (random() < 0.35 ? 1 : 0)
        for (let r = 0; r < replies; r++) {
          out.replies.push(t)
          if (random() < 0.028) out.absolutelyRight.push(t)
          if (random() < 0.07) out.perfect.push(t)
        }
      }
    }
  }
  return {
    records,
    collected,
    sources: (['claude-code', 'codex-cli', 'opencode'] as HarnessId[]).map((harness) => ({
      harness,
      locations: [],
      found: true,
      files: 0
    }))
  }
}

// Reads every supported harness's local logs once: usage records through the
// vendored @neurosquad/core sources, fun counters from the same parsed lines.
// Everything is read-only; SQLite is opened with `readOnly: true`.
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageRecord } from '../vendor/neurosquad-core/types.js'
import { JsonlSource, type FileMeta, type LineFormat } from '../vendor/neurosquad-core/jsonlSource.js'
import { claudeCodeFormat } from '../vendor/neurosquad-core/sources/claudeCode.js'
import { codexFormat } from '../vendor/neurosquad-core/sources/codex.js'
import { OpenCodeSource } from '../vendor/neurosquad-core/sources/opencode.js'
import { append, emptyCollected, type Collected, type HarnessId } from './collector.js'
import { ClaudeCounters, type ClaudeFileContext } from './claude.js'
import { CodexCounters } from './codex.js'
import { loadSqlite, scanOpenCodeCounters } from './opencode.js'

export interface SourceInfo {
  harness: HarnessId
  /** Where it looked (shown only in the "no logs found" message, never on the receipt). */
  locations: string[]
  found: boolean
  files: number
  note?: string
}

export interface ScanResult {
  records: UsageRecord[]
  collected: Record<HarnessId, Collected>
  sources: SourceInfo[]
}

export interface ScanProgress {
  (harness: HarnessId, done: number, total: number): void
}

export interface ScanLocations {
  claudeRoots: string[]
  codexHome: string
  openCodeDb: string
}

/** Where each harness keeps its logs, honouring the same variables the harnesses do. */
export function defaultLocations(env: NodeJS.ProcessEnv = process.env): ScanLocations {
  const home = homedir()
  const claudeRoots: string[] = []
  if (env.CLAUDE_CONFIG_DIR) {
    // Claude Code takes one directory; a comma-separated list is accepted for several profiles.
    for (const dir of env.CLAUDE_CONFIG_DIR.split(',')) if (dir.trim()) claudeRoots.push(join(dir.trim(), 'projects'))
  } else {
    claudeRoots.push(join(home, '.claude', 'projects'))
    const xdgConfig = env.XDG_CONFIG_HOME || join(home, '.config')
    claudeRoots.push(join(xdgConfig, 'claude', 'projects'))
  }
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share')
  return {
    claudeRoots,
    codexHome: env.CODEX_HOME || join(home, '.codex'),
    openCodeDb: join(dataHome, 'opencode', 'opencode.db')
  }
}

function countFiles(roots: string[], accept: (relative: string) => boolean): number {
  let total = 0
  for (const root of roots) {
    try {
      for (const entry of readdirSync(root, { recursive: true }) as string[]) {
        if (accept(entry.replaceAll('\\', '/'))) total++
      }
    } catch {
      // Missing root.
    }
  }
  return total
}

const SUBAGENT_FILE = /[\\/]subagents[\\/]/

export async function scanAll(
  locations: ScanLocations = defaultLocations(),
  progress: ScanProgress = () => {}
): Promise<ScanResult> {
  const collected: Record<HarnessId, Collected> = {
    'claude-code': emptyCollected(),
    'codex-cli': emptyCollected(),
    opencode: emptyCollected()
  }
  const records: UsageRecord[] = []
  const sources: SourceInfo[] = []

  // ---- Claude Code ---------------------------------------------------------
  {
    const base = claudeCodeFormat()
    const roots = locations.claudeRoots.filter((root) => existsSync(root))
    const counters = new ClaudeCounters(collected['claude-code'])
    const contexts = new WeakMap<FileMeta, ClaudeFileContext>()
    const total = countFiles(roots, base.accept)
    let done = 0
    const format: LineFormat = {
      ...base,
      roots: () => roots,
      openFile(path, meta) {
        base.openFile?.(path, meta)
        contexts.set(meta, { subagentFile: SUBAGENT_FILE.test(path) })
        progress('claude-code', ++done, total)
      },
      parseLine(entry, meta, put) {
        base.parseLine(entry, meta, put)
        counters.line(entry, contexts.get(meta) ?? { subagentFile: false })
      }
    }
    const source = new JsonlSource(format)
    if (roots.length > 0) await source.scan()
    append(records, source.records())
    sources.push({ harness: 'claude-code', locations: locations.claudeRoots, found: total > 0, files: total })
  }

  // ---- Codex CLI -----------------------------------------------------------
  {
    const base = codexFormat(() => locations.codexHome)
    const roots = base.roots().filter((root) => existsSync(root))
    const counters = new CodexCounters(collected['codex-cli'])
    const total = countFiles(roots, base.accept)
    let done = 0
    const format: LineFormat = {
      ...base,
      roots: () => roots,
      openFile() {
        progress('codex-cli', ++done, total)
      },
      parseLine(entry, meta, put) {
        const before = Boolean(meta.inherited)
        base.parseLine(entry, meta, put)
        counters.line(entry, meta, before || Boolean(meta.inherited))
      }
    }
    const source = new JsonlSource(format)
    if (roots.length > 0) await source.scan()
    counters.finish()
    append(records, source.records())
    sources.push({ harness: 'codex-cli', locations: base.roots(), found: total > 0, files: total })
  }

  // ---- OpenCode ------------------------------------------------------------
  {
    const path = locations.openCodeDb
    const info: SourceInfo = { harness: 'opencode', locations: [path], found: false, files: 0 }
    if (existsSync(path)) {
      const sqlite = loadSqlite()
      if (!sqlite) {
        info.note = `OpenCode skipped: reading its database needs Node 22.13+ (node:sqlite). You have ${process.version}.`
      } else {
        progress('opencode', 0, 1)
        const source = new OpenCodeSource(() => path)
        await source.scan()
        const status = source.status()
        if (status.error) info.note = 'OpenCode database could not be read (skipped).'
        else {
          append(records, source.records())
          info.found = true
          info.files = status.files
          try {
            const db = new sqlite.DatabaseSync(path, { readOnly: true })
            try {
              scanOpenCodeCounters(db, collected.opencode)
            } finally {
              db.close()
            }
          } catch {
            // Counters are a bonus; usage already read.
          }
        }
        progress('opencode', 1, 1)
      }
    }
    sources.push(info)
  }

  return { records, collected, sources }
}

/** Where we looked, for the "no logs found" message. */
export function lookedIn(locations: ScanLocations = defaultLocations()): string[] {
  return [...locations.claudeRoots, join(locations.codexHome, 'sessions'), locations.openCodeDb].map((path) =>
    path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path
  )
}

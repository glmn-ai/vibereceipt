// Vendored from @neurosquad/core (MIT) — https://github.com/glmn-ai/neurosquad-cli
// Source: packages/core/src/usage/source.ts at commit 1bc586c20593df20c4c5f9b8489226d06f617a7a
// Copyright (c) 2026 Stanislav Gelman and NeuroSquad contributors. MIT License (see LICENSE-neurosquad-core).
// Read-only copy: do not edit here; change it upstream and re-vendor.

// The plug-in point for everything the Usage section reads.
//
// A source knows one harness's (or one provider's) log format and turns it
// into normalised, de-duplicated `UsageRecord`s. The index
// (usageIndex.ts) owns scheduling, the on-disk cache and attribution to
// agents; a source only answers "what requests are there".
//
// To add one (OpenRouter, a new harness): implement `UsageSource` and hand it
// to `registerUsageSource` in usageIndex.ts — or, for a provider that learns
// about requests as they happen rather than from a log, use `PushSource`
// below and call its `add`.
import type { UsageRecord, UsageSourceId, UsageSourceStatus } from './types.js'

export interface UsageSource {
  readonly id: UsageSourceId
  /** Reads whatever changed since the last scan. Resolves `true` if records changed. */
  scan(): Promise<boolean>
  /** Every request of this source, over all history, each exactly once. */
  records(): readonly UsageRecord[]
  status(): UsageSourceStatus
  /** JSON-safe state for the incremental cache. */
  exportState(): unknown
  /** Restores `exportState`'s output. Must tolerate garbage (start empty). */
  importState(state: unknown): void
}

/**
 * A source that is told about requests instead of reading a log — the shape
 * an OpenRouter integration has: it sees each generation (id, model, tokens,
 * `total_cost`) as it completes, and knows which agent made it.
 *
 * Records are keyed by `id`, so reporting the same generation twice (a retry,
 * a later lookup of `/generation?id=` with the final numbers) replaces rather
 * than double-counts it.
 */
export class PushSource implements UsageSource {
  private byId = new Map<string, UsageRecord>()
  private dirty = false
  private cachedList: UsageRecord[] | null = null

  constructor(readonly id: UsageSourceId) {}

  add(records: UsageRecord[]): void {
    for (const record of records) {
      if (record.source !== this.id) continue
      this.byId.set(record.id, record)
    }
    this.dirty = true
    this.cachedList = null
  }

  async scan(): Promise<boolean> {
    const changed = this.dirty
    this.dirty = false
    return changed
  }

  records(): readonly UsageRecord[] {
    this.cachedList ??= [...this.byId.values()]
    return this.cachedList
  }

  status(): UsageSourceStatus {
    return {
      source: this.id,
      available: this.byId.size > 0,
      files: 0,
      records: this.byId.size
    }
  }

  exportState(): unknown {
    return { records: [...this.byId.values()] }
  }

  importState(state: unknown): void {
    const records = (state as { records?: unknown } | null)?.records
    if (!Array.isArray(records)) return
    for (const record of records as UsageRecord[]) {
      if (record && typeof record.id === 'string' && record.source === this.id) {
        this.byId.set(record.id, record)
      }
    }
    this.cachedList = null
  }
}

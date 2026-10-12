// Vendored from @neurosquad/core (MIT) — https://github.com/glmn-ai/neurosquad-cli
// Source: packages/core/src/usage/source.ts at commit 1bc586c20593df20c4c5f9b8489226d06f617a7a
// Copyright (c) 2026 Stanislav Gelman and NeuroSquad contributors. MIT License (see LICENSE-neurosquad-core).
// Read-only copy: do not edit here; change it upstream and re-vendor.
/**
 * A source that is told about requests instead of reading a log — the shape
 * an OpenRouter integration has: it sees each generation (id, model, tokens,
 * `total_cost`) as it completes, and knows which agent made it.
 *
 * Records are keyed by `id`, so reporting the same generation twice (a retry,
 * a later lookup of `/generation?id=` with the final numbers) replaces rather
 * than double-counts it.
 */
export class PushSource {
    id;
    byId = new Map();
    dirty = false;
    cachedList = null;
    constructor(id) {
        this.id = id;
    }
    add(records) {
        for (const record of records) {
            if (record.source !== this.id)
                continue;
            this.byId.set(record.id, record);
        }
        this.dirty = true;
        this.cachedList = null;
    }
    async scan() {
        const changed = this.dirty;
        this.dirty = false;
        return changed;
    }
    records() {
        this.cachedList ??= [...this.byId.values()];
        return this.cachedList;
    }
    status() {
        return {
            source: this.id,
            available: this.byId.size > 0,
            files: 0,
            records: this.byId.size
        };
    }
    exportState() {
        return { records: [...this.byId.values()] };
    }
    importState(state) {
        const records = state?.records;
        if (!Array.isArray(records))
            return;
        for (const record of records) {
            if (record && typeof record.id === 'string' && record.source === this.id) {
                this.byId.set(record.id, record);
            }
        }
        this.cachedList = null;
    }
}

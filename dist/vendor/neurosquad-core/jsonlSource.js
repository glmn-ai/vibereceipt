// Vendored from @neurosquad/core (MIT) — https://github.com/glmn-ai/neurosquad-cli
// Source: packages/core/src/usage/jsonlSource.ts at commit 1bc586c20593df20c4c5f9b8489226d06f617a7a
// Copyright (c) 2026 Stanislav Gelman and NeuroSquad contributors. MIT License (see LICENSE-neurosquad-core).
// Read-only copy: do not edit here; change it upstream and re-vendor.
// A usage source over a directory of append-only JSONL session logs — the
// shape Claude Code, Codex and pi/omp all share. Each format supplies only a
// line parser (sources/*.ts); reading, caching and de-duplication live here,
// once.
//
// De-duplication, the part that decides whether the numbers are right:
// - Within a file, one request can be logged on several lines (Claude Code
//   writes one line per content block, and the usage on the early lines is a
//   streaming snapshot — `output_tokens` only reaches its final value on the
//   last one). Lines are merged by the request's own id taking the per-field
//   MAXIMUM, which is the final value because every field only grows. The
//   old indexer kept the first line: output was undercounted, and a request
//   whose lines were not adjacent was counted twice.
// - Across files, the same request can appear in several logs (a resumed or
//   forked session copies its history; the copy may even carry zeroed usage).
//   Copies are merged the same way and attributed to one owner file, chosen
//   deterministically (see `mergeCopies`).
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { recordTokens, requestSpan, requestTools } from './types.js';
import { newCursor, readNewLines } from './lineReader.js';
/** Tool call ids are kept only to de-duplicate sightings: a suffix is enough. */
const shortId = (id) => (id ? id.slice(-12) : null);
const compact = (r) => [
    r.nativeId,
    r.at,
    r.provider,
    r.model,
    r.input,
    r.output,
    r.cacheRead,
    r.cacheWrite,
    r.cacheWrite1h,
    r.reasoning,
    r.webSearches,
    `${r.speed === 'fast' ? 'f' : ''}${r.geo === 'us' ? 'u' : ''}`,
    r.recordedPico ?? null,
    r.sessionId ?? null,
    r.cwd ?? null,
    r.startedAt ?? null,
    r.endedAt ?? null,
    r.toolCalls?.length ? r.toolCalls.map((call) => [call.name, shortId(call.id)]) : null,
    r.subagent ? [r.subagent.id, r.subagent.name ?? null] : null
];
const expand = (c) => ({
    nativeId: c[0],
    at: c[1],
    provider: c[2],
    model: c[3],
    input: c[4],
    output: c[5],
    cacheRead: c[6],
    cacheWrite: c[7],
    cacheWrite1h: c[8],
    reasoning: c[9],
    webSearches: c[10],
    speed: c[11].includes('f') ? 'fast' : undefined,
    geo: c[11].includes('u') ? 'us' : undefined,
    recordedPico: c[12] ?? undefined,
    sessionId: c[13] ?? undefined,
    cwd: c[14] ?? undefined,
    startedAt: c[15] ?? undefined,
    endedAt: c[16] ?? undefined,
    toolCalls: c[17] ? c[17].map(([name, id]) => (id ? { name, id } : { name })) : undefined,
    subagent: c[18] ? { id: c[18][0], ...(c[18][1] ? { name: c[18][1] } : {}) } : undefined
});
const minDefined = (a, b) => a === undefined ? b : b === undefined ? a : Math.min(a, b);
const maxDefined = (a, b) => a === undefined ? b : b === undefined ? a : Math.max(a, b);
/**
 * Two sightings' tool calls → one list: a union in order, by call id where the
 * calls have ids (Claude Code logs each block on its own line, and a forked
 * session repeats them); without ids, the longer list (a message re-logged
 * with its calls added).
 */
export function mergeToolCalls(a, b) {
    if (!a?.length)
        return b?.length ? b : a;
    if (!b?.length)
        return a;
    const ids = new Set();
    for (const call of a)
        if (call.id)
            ids.add(call.id);
    if (ids.size === 0 && b.every((call) => !call.id))
        return b.length > a.length ? b : a;
    const out = [...a];
    for (const call of b) {
        if (!call.id || ids.has(call.id))
            continue;
        ids.add(call.id);
        out.push(call);
    }
    return out;
}
/**
 * Two sightings of the same request → one. Token fields take the maximum
 * (each only ever grows while a request streams); the time is the earliest
 * sighting; a recorded cost is kept if either has one (the larger, for the
 * same reason as the tokens). The request's span takes the earliest start and
 * the latest end; tool calls are merged (`mergeToolCalls`).
 */
export function mergeSightings(a, b) {
    const recorded = a.recordedPico === undefined
        ? b.recordedPico
        : b.recordedPico === undefined
            ? a.recordedPico
            : BigInt(a.recordedPico) >= BigInt(b.recordedPico)
                ? a.recordedPico
                : b.recordedPico;
    return {
        nativeId: a.nativeId,
        at: Math.min(a.at, b.at),
        provider: a.provider || b.provider,
        model: a.model !== 'unknown' ? a.model : b.model,
        input: Math.max(a.input, b.input),
        output: Math.max(a.output, b.output),
        cacheRead: Math.max(a.cacheRead, b.cacheRead),
        cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
        cacheWrite1h: Math.max(a.cacheWrite1h, b.cacheWrite1h),
        reasoning: Math.max(a.reasoning, b.reasoning),
        webSearches: Math.max(a.webSearches, b.webSearches),
        speed: a.speed ?? b.speed,
        geo: a.geo ?? b.geo,
        recordedPico: recorded,
        sessionId: a.sessionId ?? b.sessionId,
        cwd: a.cwd ?? b.cwd,
        startedAt: minDefined(a.startedAt, b.startedAt),
        endedAt: maxDefined(a.endedAt, b.endedAt),
        toolCalls: mergeToolCalls(a.toolCalls, b.toolCalls),
        subagent: a.subagent ?? b.subagent
    };
}
const parsedTokens = (r) => r.input + r.cacheRead + r.cacheWrite + r.output;
/**
 * The same request found in several files → one record, owned by one file.
 * Owner: the copy with the most tokens (a zeroed copy never wins), then the
 * file whose first request is earliest (the original session predates its
 * fork), then the path — so the choice is the same on every scan.
 */
export function mergeCopies(copies) {
    const sorted = [...copies].sort((x, y) => parsedTokens(y.request) - parsedTokens(x.request) ||
        x.fileFirstAt - y.fileFirstAt ||
        (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    const owner = sorted[0];
    let request = owner.request;
    for (const copy of sorted.slice(1))
        request = mergeSightings(request, copy.request);
    return {
        request: { ...request, sessionId: owner.request.sessionId, cwd: owner.request.cwd },
        owner
    };
}
/** Stats in flight at once while a scan looks for grown files. */
const STAT_CONCURRENCY = 16;
/** `items` mapped with at most `limit` calls in flight; results in input order. */
async function mapBounded(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}
const byTimeThenId = (a, b) => a.at - b.at || (a.id < b.id ? -1 : 1);
export class JsonlSource {
    format;
    id;
    files = new Map();
    merged = null;
    lastError;
    rootsSeen = [];
    rootsKey = null;
    // Incremental merge (records()): each file's finalized requests, every
    // request's copies across files and its record. Only files read since the
    // last records() are re-merged; the rest is reused.
    fileFinal = new Map();
    copiesById = new Map();
    recordById = new Map();
    dirty = new Set();
    rebuildAll = true;
    constructor(format) {
        this.format = format;
        this.id = format.source;
    }
    async scan() {
        let changed = false;
        const present = new Set();
        this.rootsSeen = [];
        const roots = this.format.roots();
        // A profile added or removed can change which account a file is (accountOf).
        const rootsKey = JSON.stringify(roots);
        if (this.rootsKey !== null && this.rootsKey !== rootsKey) {
            this.rebuildAll = true;
            changed = true;
        }
        this.rootsKey = rootsKey;
        for (const root of roots) {
            let entries;
            try {
                entries = this.format.listFiles
                    ? await this.format.listFiles(root)
                    : (await readdir(root, { recursive: true }));
            }
            catch {
                continue;
            }
            this.rootsSeen.push(root);
            const paths = [];
            for (const relative of entries) {
                const normalized = relative.replaceAll('\\', '/');
                if (!this.format.accept(normalized))
                    continue;
                const path = join(root, relative);
                present.add(path);
                paths.push(path);
            }
            // Sizes in parallel; the files themselves are still read one by one.
            const sizes = await mapBounded(paths, STAT_CONCURRENCY, (path) => stat(path).then((info) => info.size, () => null));
            for (let i = 0; i < paths.length; i++) {
                const path = paths[i];
                const size = sizes[i];
                if (size === null)
                    continue;
                const state = this.files.get(path);
                if (state && !state.gone && state.cursor.size === size)
                    continue;
                try {
                    if (await this.scanFile(path))
                        changed = true;
                }
                catch (error) {
                    this.lastError = `${path}: ${String(error)}`;
                    console.error(`usage: could not read ${path}`, error);
                }
            }
        }
        for (const [path, state] of this.files) {
            if (!present.has(path) && !state.gone) {
                state.gone = true;
            }
        }
        return changed;
    }
    /** Reads one file's new lines. Exposed for tests. */
    async scanFile(path) {
        let state = this.files.get(path);
        let size;
        try {
            size = (await stat(path)).size;
        }
        catch {
            return false;
        }
        // Same size as last time: nothing appended (an unfinished last line is
        // still the same unfinished line).
        if (state && !state.gone && state.cursor.size === size)
            return false;
        if (!state) {
            state = { cursor: newCursor(), meta: {}, requests: new Map() };
            this.files.set(path, state);
            this.format.openFile?.(path, state.meta);
        }
        state.gone = false;
        const current = state;
        const metaBefore = JSON.stringify(current.meta);
        let touched = false;
        const put = (request) => {
            const existing = current.requests.get(request.nativeId);
            current.requests.set(request.nativeId, existing ? mergeSightings(existing, request) : request);
            touched = true;
        };
        const result = await readNewLines(path, current.cursor, (line) => {
            if (line.charCodeAt(0) !== 123 /* { */)
                return;
            let entry;
            try {
                entry = JSON.parse(line);
            }
            catch {
                return;
            }
            this.format.parseLine(entry, current.meta, put);
        }, () => {
            current.meta = {};
            this.format.openFile?.(path, current.meta);
            current.requests.clear();
            touched = true;
        });
        // A line that only fills the file's meta (its session, its cwd) still
        // changes the records that file owns.
        const changed = touched || result.reset || JSON.stringify(current.meta) !== metaBefore;
        if (changed)
            this.dirty.add(path);
        return changed;
    }
    /** A file's requests as merged: finalized, with its earliest time. */
    finalOf(state) {
        const fileRequests = [...state.requests.values()];
        const requests = this.format.finalizeFile
            ? this.format.finalizeFile(fileRequests, state.meta)
            : fileRequests;
        let firstAt = Number.POSITIVE_INFINITY;
        for (const request of requests)
            firstAt = Math.min(firstAt, request.at);
        return { requests, firstAt };
    }
    addCopies(path, state, touchedIds) {
        const final = this.finalOf(state);
        this.fileFinal.set(path, final);
        for (const request of final.requests) {
            const list = this.copiesById.get(request.nativeId);
            const copy = { path, fileFirstAt: final.firstAt, request, meta: state.meta };
            if (list)
                list.push(copy);
            else
                this.copiesById.set(request.nativeId, [copy]);
            touchedIds.add(request.nativeId);
        }
    }
    removeCopies(path, touchedIds) {
        const final = this.fileFinal.get(path);
        if (!final)
            return;
        this.fileFinal.delete(path);
        for (const request of final.requests) {
            const id = request.nativeId;
            touchedIds.add(id);
            const list = this.copiesById.get(id);
            if (!list)
                continue;
            const rest = list.filter((copy) => copy.path !== path);
            if (rest.length > 0)
                this.copiesById.set(id, rest);
            else
                this.copiesById.delete(id);
        }
    }
    records() {
        if (this.merged && !this.rebuildAll && this.dirty.size === 0)
            return this.merged;
        if (this.rebuildAll || !this.merged) {
            this.rebuildAll = false;
            this.dirty.clear();
            this.fileFinal.clear();
            this.copiesById.clear();
            this.recordById.clear();
            const all = new Set();
            for (const [path, state] of this.files)
                this.addCopies(path, state, all);
            const out = [];
            for (const nativeId of all) {
                const record = this.recordOf(nativeId);
                if (record)
                    out.push(record);
            }
            out.sort(byTimeThenId);
            this.merged = out;
            return out;
        }
        // Only the requests of files read since: out of the list, re-merged, and
        // their new records merged back in order (both runs are sorted).
        const touchedIds = new Set();
        for (const path of this.dirty) {
            this.removeCopies(path, touchedIds);
            const state = this.files.get(path);
            if (state)
                this.addCopies(path, state, touchedIds);
        }
        this.dirty.clear();
        const replaced = new Set();
        const fresh = [];
        for (const nativeId of touchedIds) {
            const old = this.recordById.get(nativeId);
            if (old)
                replaced.add(old.id);
            this.recordById.delete(nativeId);
            const record = this.recordOf(nativeId);
            if (record)
                fresh.push(record);
        }
        fresh.sort(byTimeThenId);
        const out = [];
        let j = 0;
        for (const record of this.merged) {
            if (replaced.has(record.id))
                continue;
            while (j < fresh.length && byTimeThenId(fresh[j], record) < 0)
                out.push(fresh[j++]);
            out.push(record);
        }
        while (j < fresh.length)
            out.push(fresh[j++]);
        this.merged = out;
        return out;
    }
    /** One request's record from its copies (stored in recordById), or null if it is not one. */
    recordOf(nativeId) {
        const copies = this.copiesById.get(nativeId);
        if (!copies)
            return null;
        {
            const { request, owner } = copies.length === 1 ? { request: copies[0].request, owner: copies[0] } : mergeCopies(copies);
            const record = {
                id: `${this.id}:${nativeId}`,
                source: this.id,
                provider: request.provider,
                model: request.model,
                at: request.at,
                sessionId: request.sessionId ??
                    owner.meta.sessionId ??
                    this.format.sessionFromPath(owner.path),
                cwd: request.cwd ?? owner.meta.cwd,
                input: request.input,
                output: request.output,
                cacheRead: request.cacheRead,
                cacheWrite: request.cacheWrite,
                cacheWrite1h: request.cacheWrite1h,
                reasoning: request.reasoning,
                webSearches: request.webSearches,
                speed: request.speed,
                geo: request.geo,
                recordedPico: request.recordedPico,
                ...requestSpan(request.at, request.startedAt, request.endedAt)
            };
            const tools = requestTools(request.toolCalls?.map((call) => call.name));
            if (tools)
                record.tools = tools;
            const subagent = request.subagent ?? owner.meta.subagent;
            if (subagent)
                record.subagent = subagent;
            const account = this.format.accountOf?.(owner.path);
            if (account)
                record.account = account;
            // A request that carried no tokens at all (an API error the harness
            // logged as a synthetic message, an aborted local call) is not a request
            // anyone paid for.
            if (recordTokens(record) === 0 && record.webSearches === 0)
                return null;
            this.recordById.set(nativeId, record);
            return record;
        }
    }
    status() {
        return {
            source: this.id,
            available: this.rootsSeen.length > 0,
            location: this.rootsSeen[0] ?? this.format.roots()[0],
            files: [...this.files.values()].filter((state) => !state.gone).length,
            records: this.records().length,
            error: this.lastError
        };
    }
    exportState() {
        const files = {};
        for (const [path, state] of this.files) {
            files[path] = {
                cursor: state.cursor,
                meta: state.meta,
                gone: state.gone || undefined,
                requests: [...state.requests.values()].map(compact)
            };
        }
        return { files };
    }
    importState(raw) {
        const files = raw?.files;
        if (!files || typeof files !== 'object')
            return;
        try {
            for (const [path, value] of Object.entries(files)) {
                const saved = value;
                if (!saved?.cursor || !Array.isArray(saved.requests))
                    continue;
                this.files.set(path, {
                    cursor: saved.cursor,
                    meta: saved.meta ?? {},
                    gone: saved.gone,
                    requests: new Map(saved.requests.map((c) => [c[0], expand(c)]))
                });
            }
        }
        catch {
            this.files.clear();
        }
        this.merged = null;
    }
}

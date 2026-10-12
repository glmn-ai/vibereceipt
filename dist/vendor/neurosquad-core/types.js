// Vendored from @neurosquad/core (MIT) — https://github.com/glmn-ai/neurosquad-cli
// Source: packages/core/src/usage/types.ts at commit 1bc586c20593df20c4c5f9b8489226d06f617a7a
// Copyright (c) 2026 Stanislav Gelman and NeuroSquad contributors. MIT License (see LICENSE-neurosquad-core).
// Read-only copy: do not edit here; change it upstream and re-vendor.
/** Subagent names are labels: one line, at most this long. */
export const MAX_SUBAGENT_NAME = 64;
/** A subagent marker as a record carries it (clamped), or undefined. */
export function usageSubagent(id, name) {
    if (typeof id !== 'string' || !id)
        return undefined;
    const label = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
    return {
        id: id.slice(0, 128),
        ...(label ? { name: label.slice(0, MAX_SUBAGENT_NAME) } : {})
    };
}
/** A start further than this before the response's end is not trusted (dropped). */
export const MAX_REQUEST_LEAD_MS = 30 * 60_000;
export const MAX_REQUEST_TOOLS = 32;
export const MAX_TOOL_NAME = 64;
const finiteMs = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
/**
 * The request's span as a record carries it: a start later than the end (or
 * than `at`), or more than MAX_REQUEST_LEAD_MS before the end, is dropped.
 */
export function requestSpan(at, startedAt, endedAt) {
    const end = finiteMs(endedAt);
    const start = finiteMs(startedAt);
    const out = {};
    if (end !== undefined)
        out.endedAt = end;
    const ref = end ?? at;
    if (start !== undefined && start <= ref && start <= at && ref - start <= MAX_REQUEST_LEAD_MS) {
        out.startedAt = start;
    }
    return out;
}
/** Tool names as a record carries them (clamped), or undefined when there are none. */
export function requestTools(names) {
    if (!names || names.length === 0)
        return undefined;
    const out = [];
    for (const name of names) {
        if (out.length >= MAX_REQUEST_TOOLS)
            break;
        if (typeof name === 'string' && name)
            out.push(name.slice(0, MAX_TOOL_NAME));
    }
    return out.length > 0 ? out : undefined;
}
/** Everything that goes into a request's context window: input + both cache sides. */
export const contextTokens = (totals) => totals.input + totals.cacheRead + totals.cacheWrite;
export const totalTokens = (totals) => totals.input + totals.cacheRead + totals.cacheWrite + totals.output;
export const EMPTY_TOTALS = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    output: 0,
    thinking: 0,
    requests: 0,
    webSearches: 0
};
export function addTotals(target, source) {
    target.input += source.input;
    target.cacheRead += source.cacheRead;
    target.cacheWrite += source.cacheWrite;
    target.cacheWrite1h += source.cacheWrite1h;
    target.output += source.output;
    target.thinking += source.thinking;
    target.requests += source.requests;
    target.webSearches += source.webSearches;
}
export const EMPTY_COST = {
    total: '0',
    recordedRequests: 0,
    listRequests: 0,
    unpricedRequests: 0,
    unpricedTokens: 0,
    recordedOfBoth: '0',
    listOfBoth: '0'
};
/** Tokens of one record in the section's "total tokens" sense. */
export const recordTokens = (record) => record.input + record.cacheRead + record.cacheWrite + record.output;
/** A request's context: everything it sent. */
export const recordContext = (record) => record.input + record.cacheRead + record.cacheWrite;

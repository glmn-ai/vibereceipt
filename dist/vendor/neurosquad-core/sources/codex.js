// Vendored from @neurosquad/core (MIT) — https://github.com/glmn-ai/neurosquad-cli
// Source: packages/core/src/usage/sources/codex.ts at commit 1bc586c20593df20c4c5f9b8489226d06f617a7a
// Copyright (c) 2026 Stanislav Gelman and NeuroSquad contributors. MIT License (see LICENSE-neurosquad-core).
// Read-only copy: do not edit here; change it upstream and re-vendor.
// Codex CLI: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (and
// `archived_sessions/`), one file per session.
//
// Per request the log has a `token_usage_record` line keyed by the API's
// `response_id` — the exact unit to count. Older Codex builds only emit
// `event_msg` → `token_count`, which repeats (the same totals are re-sent),
// so for those the request is `last_token_usage`, taken only when the
// cumulative `total_token_usage` actually moved. A file that has real
// records drops its `token_count` fallbacks entirely (they describe the same
// requests).
//
// OpenAI counts cached tokens INSIDE `input_tokens` (and reasoning inside
// `output_tokens`), unlike Anthropic. Normalised here: `input` = input −
// cached − cache writes, so the four kinds stay disjoint.
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { usageSubagent } from '../types.js';
const n = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
export const RECORD_PREFIX = 'r:';
export const FALLBACK_PREFIX = 'tc:';
/** Pure: OpenAI-style usage → the disjoint token kinds. */
export function normaliseCodexUsage(usage) {
    const promptTotal = n(usage.input_tokens);
    const cacheRead = Math.min(promptTotal, n(usage.cached_input_tokens));
    const cacheWrite = Math.min(promptTotal - cacheRead, n(usage.cache_write_input_tokens));
    const output = n(usage.output_tokens);
    return {
        input: promptTotal - cacheRead - cacheWrite,
        output,
        cacheRead,
        cacheWrite,
        cacheWrite1h: 0,
        reasoning: Math.min(output, n(usage.reasoning_output_tokens)),
        webSearches: 0
    };
}
const usageKey = (usage) => usage
    ? [
        n(usage.input_tokens),
        n(usage.cached_input_tokens),
        n(usage.cache_write_input_tokens),
        n(usage.output_tokens),
        n(usage.reasoning_output_tokens)
    ].join(',')
    : '';
/** The input items a response answers: the user's message, a tool's output. */
const INPUT_ITEMS = new Set(['function_call_output', 'custom_tool_call_output']);
/** Items the model itself produced (they mean a response is under way). */
const OUTPUT_ITEMS = new Set(['message', 'reasoning', 'function_call', 'custom_tool_call']);
/**
 * The span and tool calls of the response under way, from the rollout's own
 * line times (measured on 0.13x rollouts): the input items are written before
 * the request, the model's items as they stream, then `token_usage_record`;
 * the tool outputs (and the legacy `token_count`) only after it. So the start
 * is the last input line before the response's first item — frozen there,
 * since the fallback `token_count` comes after the tool outputs — and the
 * tools are the calls written since.
 */
function trackResponse(entry, meta) {
    if (entry.type !== 'response_item')
        return;
    const payload = entry.payload ?? {};
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (Number.isNaN(at))
        return;
    const kind = payload.type ?? '';
    if (INPUT_ITEMS.has(kind) || (kind === 'message' && payload.role === 'user')) {
        meta.lastInputAt = at;
        return;
    }
    if (!OUTPUT_ITEMS.has(kind) || (kind === 'message' && payload.role !== 'assistant'))
        return;
    if (meta.responseStart === undefined && typeof meta.lastInputAt === 'number') {
        meta.responseStart = meta.lastInputAt;
    }
    meta.responseOpen = true;
    if ((kind === 'function_call' || kind === 'custom_tool_call') && payload.name) {
        const tools = meta.responseTools ?? [];
        tools.push(payload.call_id ? { name: payload.name, id: payload.call_id } : { name: payload.name });
        meta.responseTools = tools;
    }
}
/** The span and tools of the response that `at` closes; the state is reset for the next. */
function closeResponse(meta, at) {
    const start = meta.responseOpen ? meta.responseStart : meta.lastInputAt;
    const tools = meta.responseTools;
    delete meta.responseStart;
    delete meta.responseOpen;
    delete meta.responseTools;
    return {
        endedAt: at,
        ...(typeof start === 'number' ? { startedAt: start } : {}),
        ...(tools?.length ? { toolCalls: tools } : {})
    };
}
/**
 * Pure: the subagent a rollout's header describes, or undefined for a main
 * thread. Codex 0.157 (protocol SessionMeta): a spawned agent has
 * `parent_thread_id`, `agent_role` (its type) and `agent_nickname`, and
 * `source: { subagent: { thread_spawn: … } }`; the auto-reviewer and other
 * built-in ones only `source: { subagent: "review" | … }`.
 */
export function codexSubagent(payload) {
    const source = payload.source;
    const kind = source && typeof source === 'object' ? source.subagent : undefined;
    if (!payload.id || (!payload.parent_thread_id && kind === undefined))
        return undefined;
    const spawn = kind && typeof kind === 'object'
        ? (kind
            .thread_spawn ?? {})
        : {};
    const name = [payload.agent_role, spawn.agent_role, payload.agent_nickname, spawn.agent_nickname].find((value) => typeof value === 'string' && value.trim() !== '') ?? (typeof kind === 'string' ? kind : undefined);
    return usageSubagent(payload.id, name);
}
/** Pure: one rollout line, with the file's running state, → a request or nothing. */
export function parseCodexEntry(entry, meta) {
    const payload = entry?.payload;
    if (!payload)
        return null;
    meta.lines = (meta.lines ?? 0) + 1;
    // A forked subagent's rollout copies its parent's history right after its
    // own header (core session `InitialHistory::Forked`, ForkPersistence::Copied:
    // the parent's session_meta, turn contexts, items and `token_count` events —
    // agent/control/spawn.rs drops only `token_usage_record`), closed by a
    // `thread_settings_applied` event. That block is the parent's, not this
    // file's: skipped, so its `token_count` totals are never counted again here
    // and its header never replaces this one.
    if (meta.inherited) {
        const closes = (entry.type === 'event_msg' && payload.type === 'thread_settings_applied') ||
            entry.type === 'token_usage_record';
        if (!closes)
            return null;
        delete meta.inherited;
        delete meta.lastInputAt;
        delete meta.responseStart;
        delete meta.responseOpen;
        delete meta.responseTools;
        if (entry.type !== 'token_usage_record')
            return null;
    }
    if (entry.type === 'session_meta' && meta.subagent) {
        meta.inherited = true;
        return null;
    }
    trackResponse(entry, meta);
    if (entry.type === 'session_meta') {
        meta.sessionId = payload.id ?? payload.session_id ?? meta.sessionId;
        // A thread-spawned subagent (or the auto-reviewer) has its own file, but
        // `session_id` names the root thread (protocol SessionMeta: "equal to the
        // root thread's ID") — its requests are the agent's, as Claude's sidechains,
        // marked as the subagent's (`meta.subagent`).
        if (payload.session_id && payload.id && payload.session_id !== payload.id) {
            meta.rootSessionId = payload.session_id;
        }
        const subagent = codexSubagent(payload);
        if (subagent)
            meta.subagent = subagent;
        if (payload.cwd)
            meta.cwd = payload.cwd;
        if (payload.model_provider)
            meta.provider = payload.model_provider;
        return null;
    }
    if (entry.type === 'turn_context') {
        if (payload.model)
            meta.model = payload.model;
        if (payload.cwd && meta.cwd === undefined)
            meta.cwd = payload.cwd;
        return null;
    }
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (Number.isNaN(at))
        return null;
    const root = meta.rootSessionId;
    const common = {
        at,
        provider: meta.provider ?? 'openai',
        model: meta.model ?? 'unknown',
        ...(root ? { sessionId: root } : {})
    };
    if (entry.type === 'token_usage_record' && payload.usage) {
        const id = payload.response_id ?? `${payload.turn_id ?? 'turn'}:${entry.ordinal ?? meta.lines}`;
        return {
            nativeId: `${RECORD_PREFIX}${id}`,
            ...common,
            ...normaliseCodexUsage(payload.usage),
            ...closeResponse(meta, at)
        };
    }
    if (entry.type === 'event_msg' && payload.type === 'token_count' && payload.info) {
        const key = usageKey(payload.info.total_token_usage);
        if (!key || key === meta.lastTotal)
            return null;
        meta.lastTotal = key;
        const last = payload.info.last_token_usage;
        if (!last)
            return null;
        return {
            // Ordinals restart in every file: scoped by session so two sessions'
            // fallbacks are never mistaken for copies of one request.
            nativeId: `${FALLBACK_PREFIX}${String(meta.sessionId ?? 'session')}:${entry.ordinal ?? meta.lines}`,
            ...common,
            ...normaliseCodexUsage(last),
            ...closeResponse(meta, at)
        };
    }
    return null;
}
export function codexHome() {
    return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}
export const codexFormat = (home = codexHome) => ({
    source: 'codex-cli',
    roots: () => [join(home(), 'sessions'), join(home(), 'archived_sessions')],
    accept: (relative) => /(^|\/)rollout-[^/]*\.jsonl$/.test(relative),
    sessionFromPath: (path) => {
        const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path);
        return match ? match[1] : basename(path, '.jsonl');
    },
    parseLine(entry, meta, put) {
        const request = parseCodexEntry(entry, meta);
        if (request)
            put(request);
    },
    finalizeFile(requests) {
        const hasRecords = requests.some((request) => request.nativeId.startsWith(RECORD_PREFIX));
        return hasRecords
            ? requests.filter((request) => request.nativeId.startsWith(RECORD_PREFIX))
            : requests;
    }
});

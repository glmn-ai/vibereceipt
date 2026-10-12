// Vendored from @neurosquad/core (MIT) — https://github.com/glmn-ai/neurosquad-cli
// Source: packages/core/src/usage/sources/claudeCode.ts at commit 1bc586c20593df20c4c5f9b8489226d06f617a7a
// Copyright (c) 2026 Stanislav Gelman and NeuroSquad contributors. MIT License (see LICENSE-neurosquad-core).
// Read-only copy: do not edit here; change it upstream and re-vendor.

// Claude Code: `~/.claude/projects/<cwd slug>/<session id>.jsonl`, plus the
// sub-agents' own logs under `<session id>/subagents/agent-*.jsonl`.
//
// Every assistant line carries the API's `usage` for its message. What was
// verified on real transcripts:
// - one message is logged once per content block, and those lines repeat the
//   usage with `output_tokens` still streaming on all but the last — merged
//   by message id taking the maximum (jsonlSource.ts);
// - those lines are not always adjacent;
// - a resumed/forked session copies earlier messages into its own file, one
//   copy sometimes with all top-level counts zeroed and the real ones only in
//   `usage.iterations` — merged across files by message id;
// - sub-agent lines carry the PARENT session's id in `sessionId`, so a
//   sub-agent's spend lands on the agent that spawned it (the old indexer
//   never read these files at all). Each such request is marked with its
//   subagent (`UsageRecord.subagent`: the file's agent id, and the
//   `agentType` of the `agent-<id>.meta.json` beside it — measured on
//   2.1.289). Nothing a subagent did is repeated in the
//   main file: the parent only gets summaries (the Agent tool result's
//   `toolUseResult.usage`, a `<task-notification>`'s <usage>), on user
//   lines, which are never read as requests.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { usageSubagent, type UsageSubagent } from '../types.js'
import type { FileMeta, LineFormat, ParsedRequest, ToolCall } from '../jsonlSource.js'

interface ClaudeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null
  output_tokens_details?: { thinking_tokens?: number } | null
  server_tool_use?: { web_search_requests?: number } | null
  speed?: string | null
  inference_geo?: string | null
  iterations?: ClaudeUsage[] | null
}

interface ClaudeEntry {
  type?: string
  timestamp?: string
  sessionId?: string
  cwd?: string
  uuid?: string
  requestId?: string
  isSidechain?: boolean
  /** A subagent's own lines (its file, or older builds' inline sidechain). */
  agentId?: string
  message?: {
    id?: string
    model?: string
    usage?: ClaudeUsage
    content?: unknown
  }
}

/** The `tool_use` blocks of one assistant line. */
function toolCallsOf(content: unknown): ToolCall[] | undefined {
  if (!Array.isArray(content)) return undefined
  const calls: ToolCall[] = []
  for (const block of content as { type?: unknown; name?: unknown; id?: unknown }[]) {
    if (block?.type !== 'tool_use' || typeof block.name !== 'string' || !block.name) continue
    calls.push(
      typeof block.id === 'string' && block.id
        ? { name: block.name, id: block.id }
        : { name: block.name }
    )
  }
  return calls.length > 0 ? calls : undefined
}

const n = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

function topLevel(usage: ClaudeUsage): [number, number, number, number] {
  return [
    n(usage.input_tokens),
    n(usage.output_tokens),
    n(usage.cache_read_input_tokens),
    n(usage.cache_creation_input_tokens)
  ]
}

/** Pure: one parsed transcript line → a request, or nothing. */
export function parseClaudeEntry(entry: ClaudeEntry): ParsedRequest | null {
  if (entry?.type !== 'assistant') return null
  const message = entry.message
  const usage = message?.usage
  if (!usage || typeof usage !== 'object') return null
  const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  if (Number.isNaN(at)) return null
  const nativeId = message?.id ?? entry.requestId ?? entry.uuid
  if (!nativeId) return null

  let [input, output, cacheRead, cacheWrite] = topLevel(usage)
  let source: ClaudeUsage = usage
  // A copied message can carry zeroed top-level counts with the real ones
  // left in `iterations` — use them only then, never on top of real ones.
  if (input + output + cacheRead + cacheWrite === 0 && Array.isArray(usage.iterations)) {
    for (const iteration of usage.iterations) {
      const [i, o, r, w] = topLevel(iteration ?? {})
      input += i
      output += o
      cacheRead += r
      cacheWrite += w
    }
    if (usage.iterations.length === 1 && usage.iterations[0]) source = usage.iterations[0]
  }
  const write1h = Math.min(cacheWrite, n(source.cache_creation?.ephemeral_1h_input_tokens))
  const toolCalls = toolCallsOf(message?.content)
  return {
    nativeId,
    at,
    provider: 'anthropic',
    model: message?.model ?? 'unknown',
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheWrite1h: write1h,
    reasoning: Math.min(output, n(usage.output_tokens_details?.thinking_tokens)),
    webSearches: n(usage.server_tool_use?.web_search_requests),
    speed: usage.speed === 'fast' ? 'fast' : undefined,
    geo: usage.inference_geo === 'us' ? 'us' : undefined,
    sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : undefined,
    endedAt: at,
    ...(toolCalls ? { toolCalls } : {})
  }
}

/**
 * The input a request answered — kept per file (and per side of a sidechain,
 * which older Claude Code logged inline): the time of the last `user` (a
 * prompt or a tool result) or `system` line. Every line of the next assistant
 * message is stamped with it as `startedAt`; merging the lines keeps the
 * earliest (a tool result can land between two blocks of one message).
 */
function inputKey(entry: ClaudeEntry): string {
  return entry.isSidechain === true ? 'lastSidechainInputAt' : 'lastInputAt'
}

export function claudeProjectsRoot(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
}

/** `…/<session>/subagents/[<subdir>/]agent-<id>.jsonl` → the id. */
const SUBAGENT_FILE = /[\\/]subagents[\\/](?:[^\\/]+[\\/])*agent-([^\\/]+)\.jsonl$/

/**
 * The subagent a transcript file belongs to: its id from the name, its type
 * from the `.meta.json` beside it (`agentType`). Not a subagent file: undefined.
 */
export function claudeSubagentOfFile(path: string): UsageSubagent | undefined {
  const match = SUBAGENT_FILE.exec(path)
  if (!match) return undefined
  let type: unknown
  try {
    const meta = JSON.parse(readFileSync(path.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
    type = meta?.agentType
  } catch {
    // No sidecar (older builds): the id alone.
  }
  return usageSubagent(match[1], type)
}

export const claudeCodeFormat = (root: () => string = claudeProjectsRoot): LineFormat => ({
  source: 'claude-code',
  roots: () => [root()],
  accept: (relative) => relative.endsWith('.jsonl'),
  sessionFromPath: (path) => basename(path, '.jsonl'),
  openFile(path, meta) {
    const subagent = claudeSubagentOfFile(path)
    if (subagent) meta.subagent = subagent
  },
  parseLine(entry: unknown, meta: FileMeta, put): void {
    const typed = entry as ClaudeEntry
    if (meta.cwd === undefined && typeof typed?.cwd === 'string') meta.cwd = typed.cwd
    if (meta.sessionId === undefined && typeof typed?.sessionId === 'string') {
      meta.sessionId = typed.sessionId
    }
    const type = typed?.type
    if (type === 'user' || type === 'system') {
      const at = typeof typed.timestamp === 'string' ? Date.parse(typed.timestamp) : NaN
      if (!Number.isNaN(at)) meta[inputKey(typed)] = at
      return
    }
    const request = parseClaudeEntry(typed)
    if (!request) return
    const startedAt = meta[inputKey(typed)]
    if (typeof startedAt === 'number') request.startedAt = startedAt
    // Older builds logged a subagent inline, as sidechain lines of the main file.
    if (!meta.subagent && typed.isSidechain === true) {
      request.subagent = usageSubagent(typed.agentId ?? 'sidechain')
    }
    put(request)
  }
})

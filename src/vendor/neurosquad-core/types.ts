// Vendored from @neurosquad/core (MIT) — https://github.com/glmn-ai/neurosquad-cli
// Source: packages/core/src/usage/types.ts at commit 1bc586c20593df20c4c5f9b8489226d06f617a7a
// Copyright (c) 2026 Stanislav Gelman and NeuroSquad contributors. MIT License (see LICENSE-neurosquad-core).
// Read-only copy: do not edit here; change it upstream and re-vendor.

// Usage data: how much every agent has actually spent, read out of the
// harnesses' own logs.
//
// Exactness rules every producer and consumer here follows:
// - Token counts are integers and are only ever added, never scaled.
// - Money is integer picodollars (usageMoney.ts), carried as decimal strings.
// - A period is [from, to): inclusive start, exclusive end, in epoch ms. A
//   request exactly at local midnight belongs to the day that starts there.
// - Every request lands in exactly one row of every breakdown, so each
//   breakdown's rows sum to the report's totals — asserted in the tests.
import type { PicoString } from './money.js'

/**
 * Where usage was read from. A harness id where the harness keeps its own
 * log; `openrouter` for generations billed through OpenRouter.
 */
export type UsageSourceId =
  | 'claude-code'
  | 'codex-cli'
  | 'opencode'
  | 'kilo-code'
  | 'mimo-code'
  | 'pi'
  | 'omp'
  | 'hermes-agent'
  | 'openrouter'
  | (string & {})

/**
 * One billed model request, normalised across harnesses. Token kinds are
 * disjoint except `cacheWrite1h ⊆ cacheWrite` and `reasoning ⊆ output`:
 * - `input`      — prompt tokens neither read from nor written to a cache
 * - `cacheRead`  — prompt tokens served from the prompt cache
 * - `cacheWrite` — prompt tokens written into it (all TTLs)
 * - `cacheWrite1h` — the part of `cacheWrite` with a 1-hour TTL (Anthropic)
 * - `output`     — every billed output token, reasoning included
 * - `reasoning`  — the part of `output` spent thinking
 */
export interface UsageRecord {
  /** Unique across all sources: `<source>:<the harness's own id>`. */
  id: string
  source: UsageSourceId
  /** Who served it: `anthropic`, `openai`, `lmstudio`, `openrouter`… */
  provider: string
  model: string
  /** When the harness recorded the request (ms). */
  at: number
  /** The harness's session the request belongs to. */
  sessionId: string
  /** Working directory of that session, when the harness records one. */
  cwd?: string
  /** Set by a source that knows the agent directly (OpenRouter keys per agent). */
  agentId?: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h: number
  reasoning: number
  webSearches: number
  /** Anthropic fast mode — priced differently. */
  speed?: 'fast'
  /** Anthropic `inference_geo: "us"` — 1.1x. */
  geo?: 'us'
  /** The harness's own cost for this request, if it records one (picodollars). */
  recordedPico?: PicoString
  /**
   * The CLI account profile whose folder the log lies in (shared/cliProfiles.ts)
   * — only for harnesses with profiles; absent = the user's own login.
   */
  account?: string
  /**
   * When the request was sent (ms) — only where the harness's log really says
   * (the previous input line, a span's start…); never estimated. Always
   * ≤ `endedAt ?? at` and at most MAX_REQUEST_LEAD_MS before it.
   */
  startedAt?: number
  /** When the response completed (ms), where the log says; may equal `at`. */
  endedAt?: number
  /**
   * Names of the tool calls the model asked for in this response, in order,
   * duplicates kept (≤ MAX_REQUEST_TOOLS names of ≤ MAX_TOOL_NAME chars).
   * Absent when the log does not record them or the response called none.
   */
  tools?: string[]
  /**
   * The request was made by a subagent the session spawned (Claude Code's
   * Agent tool, an OpenCode `task` child session…), not
   * by the session's own loop. It still belongs to the parent's session (and
   * agent): `sessionId` is the parent's. `id`: the harness's own id for the
   * subagent; `name`: its type, when the log says.
   */
  subagent?: UsageSubagent
}

/** Who made a subagent's request (UsageRecord.subagent). */
export interface UsageSubagent {
  id: string
  name?: string
}

/** Subagent names are labels: one line, at most this long. */
export const MAX_SUBAGENT_NAME = 64

/** A subagent marker as a record carries it (clamped), or undefined. */
export function usageSubagent(id: unknown, name?: unknown): UsageSubagent | undefined {
  if (typeof id !== 'string' || !id) return undefined
  const label = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
  return {
    id: id.slice(0, 128),
    ...(label ? { name: label.slice(0, MAX_SUBAGENT_NAME) } : {})
  }
}

/** A start further than this before the response's end is not trusted (dropped). */
export const MAX_REQUEST_LEAD_MS = 30 * 60_000
export const MAX_REQUEST_TOOLS = 32
export const MAX_TOOL_NAME = 64

const finiteMs = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

/**
 * The request's span as a record carries it: a start later than the end (or
 * than `at`), or more than MAX_REQUEST_LEAD_MS before the end, is dropped.
 */
export function requestSpan(
  at: number,
  startedAt: unknown,
  endedAt: unknown
): Pick<UsageRecord, 'startedAt' | 'endedAt'> {
  const end = finiteMs(endedAt)
  const start = finiteMs(startedAt)
  const out: Pick<UsageRecord, 'startedAt' | 'endedAt'> = {}
  if (end !== undefined) out.endedAt = end
  const ref = end ?? at
  if (start !== undefined && start <= ref && start <= at && ref - start <= MAX_REQUEST_LEAD_MS) {
    out.startedAt = start
  }
  return out
}

/** Tool names as a record carries them (clamped), or undefined when there are none. */
export function requestTools(names: readonly unknown[] | undefined): string[] | undefined {
  if (!names || names.length === 0) return undefined
  const out: string[] = []
  for (const name of names) {
    if (out.length >= MAX_REQUEST_TOOLS) break
    if (typeof name === 'string' && name) out.push(name.slice(0, MAX_TOOL_NAME))
  }
  return out.length > 0 ? out : undefined
}

/**
 * Tokens of one slice. Kept apart rather than pre-summed because they are
 * different things (see UsageRecord). `thinking` is the part of `output`
 * spent on reasoning (already included in it — never add the two), and
 * `cacheWrite1h` is part of `cacheWrite`.
 */
export interface UsageTotals {
  input: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h: number
  output: number
  thinking: number
  /** Model requests (one per API message, not per line of a log). */
  requests: number
  /** Server-side web searches (Anthropic bills them per search). */
  webSearches: number
}

/**
 * Money of one slice, exact.
 *
 * `total` is the best-known cost: what the harness itself recorded where it
 * records cost (OpenCode, pi/omp, OpenRouter), the list price otherwise. When
 * neither exists (a local model, a model missing from the price table) the
 * request is counted in `unpriced*` — never silently as zero.
 */
export interface UsageCost {
  total: PicoString
  /** Requests whose cost came from the harness's own record. */
  recordedRequests: number
  /** Requests priced from the list-price table. */
  listRequests: number
  /** Requests with no cost at all. */
  unpricedRequests: number
  /** All tokens of those requests. */
  unpricedTokens: number
  /**
   * Over the requests that have BOTH a recorded and a list-price cost: the
   * two sums, so a disagreement can be shown rather than hidden.
   */
  recordedOfBoth: PicoString
  listOfBoth: PicoString
}

/** Everything that goes into a request's context window: input + both cache sides. */
export const contextTokens = (totals: UsageTotals): number =>
  totals.input + totals.cacheRead + totals.cacheWrite

export const totalTokens = (totals: UsageTotals): number =>
  totals.input + totals.cacheRead + totals.cacheWrite + totals.output

/** Shared by every row kind. */
export interface UsageRowBase {
  totals: UsageTotals
  cost: UsageCost
  /** Largest single request context (input + cache read + cache write) in the range. */
  peakContext: number
  /** Exact timestamps of the first and last request in the range. */
  firstAt?: number
  lastAt?: number
}

export interface UsageBucket {
  /** Start of the bucket (ms, local hour or local midnight). */
  start: number
  totals: UsageTotals
  cost: PicoString
  /** Total tokens per agent row key in this bucket — the stacked columns' segments. */
  byAgent: Record<string, number>
  /** The largest single request context in this bucket, and whose it was. */
  peakContext: number
  peakContextAgentId?: string
}

/**
 * How a row of "By agent" relates to an agent:
 * - `card`    — an agent of the host (the value keeps the desktop app's name) (by session id, worktree, or the only agent
 *               of that harness working in that folder at the time)
 * - `folder`  — ran in a workspace's folder but belongs to no agent
 * - `outside` — ran anywhere else; not NeuroSquad usage at all
 */
export type UsageAttribution = 'card' | 'folder' | 'outside'

export interface UsageAgentRow extends UsageRowBase {
  /** A agent's id; for `folder`/`outside` rows a synthetic key (`folder:<ws>:<source>`, `outside:<source>`). */
  agentId: string
  attribution: UsageAttribution
  /** The agent's display name; empty for synthetic rows. */
  name: string
  /** Agent harness, or the source for synthetic rows. */
  harness: string
  /** `outside` for usage outside every workspace. */
  workspaceId: string
  workspaceName: string
  /** The agent's color tag, if it has one. */
  color?: string
  /**
   * The part of this row its subagents made (requests marked
   * `UsageRecord.subagent`) — already included in the row's totals and cost.
   * Absent when none in the range (or the harness's log does not tell them apart).
   */
  subagents?: { totals: UsageTotals; cost: UsageCost; count: number }
}

export interface UsageWorkspaceRow extends UsageRowBase {
  /** `outside` = not in any workspace. */
  workspaceId: string
  name: string
  color?: string
  /** Agent rows of this workspace that have usage in the range. */
  agents: number
}

export interface UsageHarnessRow extends UsageRowBase {
  source: UsageSourceId
  /** Distinct agent rows with usage from this source. */
  agents: number
}

/**
 * Who served (and bills) the requests: `anthropic`, `openai`, `openrouter`,
 * a local `lmstudio`… A agent set to run on OpenRouter has all its requests
 * here under `openrouter`, whatever harness logged them.
 */
export interface UsageProviderRow extends UsageRowBase {
  provider: string
  agents: number
}

export interface UsageModelRow extends UsageRowBase {
  model: string
  /** Providers that served it (a model can come through several). */
  providers: string[]
  sources: UsageSourceId[]
}

/**
 * Which CLI login paid (shared/cliProfiles.ts): a harness's own account
 * (`account: 'default'`) or one of its account profiles. Every request has
 * one, so the rows sum to the totals like every other breakdown.
 */
export interface UsageAccountRow extends UsageRowBase {
  source: UsageSourceId
  /** `default` or a profile id. */
  account: string
  agents: number
}

/** One cell of the day × hour heatmap: local weekday/hour, summed over the range. */
export interface UsageHeatCell {
  /** 0 = Monday … 6 = Sunday. */
  weekday: number
  /** Local hour, 0–23. */
  hour: number
  tokens: number
}

export interface UsageSourceStatus {
  source: UsageSourceId
  /** The log exists on this machine. */
  available: boolean
  /** Where it was read from. */
  location?: string
  /** Files (or database rows' sessions) read. */
  files: number
  /** Distinct requests after de-duplication, over all history. */
  records: number
  error?: string
}

export interface UsageCoverage {
  /** Agent harnesses whose usage can be read at all. */
  readable: number
  /** …of which actually have data in the whole history. */
  withData: number
  /** Agents whose harness keeps no readable usage log, by harness. */
  unreadable: Record<string, number>
  /** A scan is still running: numbers may still grow. */
  scanning: boolean
  sources: UsageSourceStatus[]
}

export interface UsageReport {
  scannedAt: number
  range: { from: number; to: number }
  granularity: UsageGranularity
  totals: UsageTotals
  cost: UsageCost
  peakContext: number
  /** First and last request in the range. */
  firstAt?: number
  lastAt?: number
  buckets: UsageBucket[]
  agents: UsageAgentRow[]
  workspaces: UsageWorkspaceRow[]
  harnesses: UsageHarnessRow[]
  providers: UsageProviderRow[]
  models: UsageModelRow[]
  accounts: UsageAccountRow[]
  heatmap: UsageHeatCell[]
  coverage: UsageCoverage
  /** All of history (within the query's scope), for the range picker and the empty state. */
  history: { firstAt?: number; lastAt?: number }
  /** Which price table computed the list prices (usagePricing.ts). */
  priceTable: string
  /** When OpenRouter's catalogue prices were fetched (absent = never; OpenRouter requests then stay unpriced). */
  openRouterPricesAt?: string
}

export type UsageGranularity = 'hour' | 'day'

export interface UsageQuery {
  /** Inclusive start (ms). Omitted = everything there is. */
  from?: number
  /** Exclusive end (ms). Omitted = now. */
  to?: number
  granularity?: UsageGranularity
  /** Only this workspace (`outside` = usage outside every workspace). */
  workspaceId?: string
  /** Only these agent rows (agent ids or synthetic keys). */
  agentIds?: string[]
  /** Only these sources. */
  sources?: string[]
  /**
   * Also count usage that belongs to no agent (`folder` and `outside` rows).
   * Off by default so agents that ask "what did my agents spend" (Budget)
   * keep getting only agents.
   */
  includeUnattributed?: boolean
  /** Re-read the logs before answering — throttled to one scan per 15 s. */
  rescan?: boolean
  /** An explicit "Refresh": scan now, whatever the throttle says. */
  forceRescan?: boolean
}

export const EMPTY_TOTALS: UsageTotals = {
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  output: 0,
  thinking: 0,
  requests: 0,
  webSearches: 0
}

export function addTotals(target: UsageTotals, source: UsageTotals): void {
  target.input += source.input
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.cacheWrite1h += source.cacheWrite1h
  target.output += source.output
  target.thinking += source.thinking
  target.requests += source.requests
  target.webSearches += source.webSearches
}

export const EMPTY_COST: UsageCost = {
  total: '0',
  recordedRequests: 0,
  listRequests: 0,
  unpricedRequests: 0,
  unpricedTokens: 0,
  recordedOfBoth: '0',
  listOfBoth: '0'
}

/** Tokens of one record in the section's "total tokens" sense. */
export const recordTokens = (record: UsageRecord): number =>
  record.input + record.cacheRead + record.cacheWrite + record.output

/** A request's context: everything it sent. */
export const recordContext = (record: UsageRecord): number =>
  record.input + record.cacheRead + record.cacheWrite

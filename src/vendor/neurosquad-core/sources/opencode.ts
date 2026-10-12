// Vendored from @neurosquad/core (MIT) — https://github.com/glmn-ai/neurosquad-cli
// Source: packages/core/src/usage/sources/opencode.ts at commit 1bc586c20593df20c4c5f9b8489226d06f617a7a
// Copyright (c) 2026 Stanislav Gelman and NeuroSquad contributors. MIT License (see LICENSE-neurosquad-core).
// Read-only copy: do not edit here; change it upstream and re-vendor.

// OpenCode: a SQLite database, `<XDG data>/opencode/opencode.db` (on Windows
// too: `%USERPROFILE%\.local\share\opencode`). Every assistant row of
// `message` is one model step with its tokens and the cost OpenCode itself
// computed; verified on real data that each assistant message has exactly
// one `step-finish` part and the two agree, so the message row is the unit.
//
// OpenCode reports `reasoning` NEXT TO `output` (its `total` = input +
// output + reasoning + cache read + cache write), whereas this section counts
// reasoning INSIDE output (as the APIs bill it) — so output here = output +
// reasoning. `input` is already uncached.
//
// Subagents (OpenCode's `task` tool) run in child sessions (`session.parent_id`);
// their requests carry the ROOT session's id here, exactly as Claude Code's
// sub-agent lines carry the parent session's id — so a agent's usage includes
// the subagents it started. Which agent a root session belongs to is known to
// the agent's plugin (opencode/opencodeSessions.ts) and applied as `agentId`.
// A child session's requests are marked `subagent` (the child session's id and
// its agent, e.g. `general` / `explore`).
//
// Kilo (7.5.14, kilocode/session/cost-propagation.ts + tool/task.ts) also ADDS
// each child session's cost onto the parent's assistant message that called
// `task`: on every exit of the tool (and when a background task ends) the
// growth of the child's summed assistant cost — which already holds its own
// children's, propagated the same way — goes into that message's `cost`
// (tokens are not touched). Counted as recorded, the child's spend would be
// there twice; `kiloOwnCosts` takes it back out (see there).
//
// Read-only: the database is opened with `readOnly: true` through Node's
// built-in SQLite (no native dependency); a scan after a change reads only the
// rows updated since the last one (a whole re-read every few minutes) — a few
// thousand small rows, never the 1 GB of message parts.
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageRecord, UsageSourceStatus } from '../types.js'
import { recordTokens, requestSpan, usageSubagent } from '../types.js'
import { dollarsToPico } from '../money.js'
import type { UsageSource } from '../source.js'

export interface OpenCodeRow {
  id: string
  session_id: string
  time_created: number
  data: string
  directory: string | null
  /** The top of the session's parent chain (itself for a main session). */
  root_session_id?: string | null
  /** The message's own `agent` (a subagent's type in a child session). */
  agent?: string | null
  /**
   * MiMo Code: the in-session subagent ("actor") that wrote the row —
   * `main` for the conversation itself (`message.agent_id`).
   */
  actor_id?: string | null
  /** 1 for a row of OpenCode 2's `session_message` (an assistant step or a compaction). */
  v2?: number | null
}

interface OpenCodeMessage {
  role?: string
  providerID?: string
  modelID?: string
  /** OpenCode 2: `{ id, providerID }` instead of the two fields above. */
  model?: { id?: string; providerID?: string }
  cost?: number | string
  path?: { cwd?: string }
  time?: { created?: number; completed?: number }
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

const n = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

/**
 * Pure: one `message` row → a record, or nothing. `source` is the harness
 * whose database it is — Kilo Code's CLI keeps the very same schema in its
 * kilo.db (opencode/flavor.ts).
 */
export function parseOpenCodeRow(row: OpenCodeRow, source = 'opencode'): UsageRecord | null {
  let data: OpenCodeMessage
  try {
    data = JSON.parse(row.data) as OpenCodeMessage
  } catch {
    return null
  }
  if ((row.v2 ? false : data.role !== 'assistant') || !data.tokens) return null
  const providerID = data.providerID ?? data.model?.providerID
  const modelID = data.modelID ?? data.model?.id
  const reasoning = n(data.tokens.reasoning)
  const parsed =
    typeof data.cost === 'number' || typeof data.cost === 'string'
      ? dollarsToPico(data.cost)
      : undefined
  // OpenCode records 0 whenever it has no price for a model (a local model,
  // a custom provider, a model missing from its catalogue): that is "no price
  // known", not "free" — never shown as $0. Priced from the list table if it
  // knows the model, else unpriced.
  const recorded = parsed === 0n ? undefined : parsed
  const at = n(data.time?.completed) || n(data.time?.created) || row.time_created
  // A child session's step (a `task` subagent): still the root session's.
  const subagent =
    row.root_session_id && row.root_session_id !== row.session_id
      ? usageSubagent(row.session_id, row.agent)
      : // A MiMo Code actor: same session, its own agent_id (explore-1…).
        row.actor_id && row.actor_id !== 'main'
        ? usageSubagent(`${row.session_id}:${row.actor_id}`, row.agent)
        : undefined
  const record: UsageRecord = {
    id: `${source}:${row.id}`,
    source,
    provider: providerID ?? 'unknown',
    model: modelID ?? 'unknown',
    at,
    sessionId: row.root_session_id || row.session_id,
    cwd: data.path?.cwd ?? row.directory ?? undefined,
    input: n(data.tokens.input),
    output: n(data.tokens.output) + reasoning,
    cacheRead: n(data.tokens.cache?.read),
    cacheWrite: n(data.tokens.cache?.write),
    cacheWrite1h: 0,
    reasoning,
    webSearches: 0,
    recordedPico: recorded === undefined ? undefined : recorded.toString(),
    // The step's own span: created when OpenCode starts the request, completed
    // when the response ends. Tool calls live in `part` rows (the 1 GB table
    // this source never reads), so they are not reported here.
    ...requestSpan(at, n(data.time?.created) || undefined, n(data.time?.completed) || undefined),
    ...(subagent ? { subagent } : {})
  }
  return recordTokens(record) === 0 ? null : record
}

export const OPENCODE_QUERY = `
  SELECT m.id AS id, m.session_id AS session_id, m.time_created AS time_created,
         m.data AS data, s.directory AS directory
  FROM message m LEFT JOIN session s ON s.id = m.session_id
  WHERE json_extract(m.data, '$.role') = 'assistant'`

/** The same rows with each session's root (a subagent's main session) resolved. */
export const OPENCODE_ROOTED_QUERY = `
  WITH RECURSIVE chain(id, root_id) AS (
    SELECT id, id FROM session WHERE parent_id IS NULL
    UNION ALL
    SELECT s.id, c.root_id FROM session s JOIN chain c ON s.parent_id = c.id
  )
  SELECT m.id AS id, m.session_id AS session_id, m.time_created AS time_created,
         m.data AS data, s.directory AS directory, c.root_id AS root_session_id,
         json_extract(m.data, '$.agent') AS agent
  FROM message m LEFT JOIN session s ON s.id = m.session_id
  LEFT JOIN chain c ON c.id = m.session_id
  WHERE json_extract(m.data, '$.role') = 'assistant'`

/**
 * OpenCode 2 (npm `@opencode/cli`, opencode/opencodeDb.ts): its own tables in
 * the same file — `session_v2` (with `parent_id`) and `session_message`, one
 * row per message with `type` a column. A model request is an `assistant`
 * row, or a `compaction` row (the summary request carries its own usage).
 * Message ids of the sessions 2.x copied over from 1.x are kept, so a
 * request read from both tables is one record.
 */
export const OPENCODE_V2_ROOTED_QUERY = `
  WITH RECURSIVE chain(id, root_id) AS (
    SELECT id, id FROM session_v2 WHERE parent_id IS NULL
    UNION ALL
    SELECT s.id, c.root_id FROM session_v2 s JOIN chain c ON s.parent_id = c.id
  )
  SELECT m.id AS id, m.session_id AS session_id, m.time_created AS time_created,
         m.data AS data, s.directory AS directory, c.root_id AS root_session_id,
         COALESCE(json_extract(m.data, '$.agent'), s.agent) AS agent, 1 AS v2
  FROM session_message m LEFT JOIN session_v2 s ON s.id = m.session_id
  LEFT JOIN chain c ON c.id = m.session_id
  WHERE m.type IN ('assistant', 'compaction')`

/**
 * MiMo Code: the rooted rows plus the in-session subagent each one belongs to
 * (`message.agent_id`: `main`, or an actor id such as `explore-1`).
 */
export const MIMO_ROOTED_QUERY = OPENCODE_ROOTED_QUERY.replace(
  "json_extract(m.data, '$.agent') AS agent",
  "json_extract(m.data, '$.agent') AS agent, m.agent_id AS actor_id"
)

/**
 * Kilo: the `task` tool calls of sessions that have children — which child
 * session each one ran (`state.metadata.sessionId`), from which assistant
 * message, and whether it finished. Only sessions with a child are looked at,
 * and `LIKE` filters before any JSON is parsed: the part table is the big one.
 */
export const KILO_TASK_PARTS_QUERY = `
  SELECT p.message_id AS message_id,
         json_extract(p.data, '$.state.status') AS status,
         json_extract(p.data, '$.state.metadata.sessionId') AS child_session_id,
         json_extract(p.data, '$.state.metadata.background') AS background
  FROM part p
  WHERE p.session_id IN (SELECT parent_id FROM session WHERE parent_id IS NOT NULL)
    AND p.data LIKE '%"task"%'
    AND json_extract(p.data, '$.type') = 'tool'
    AND json_extract(p.data, '$.tool') = 'task'`

export interface KiloTaskPart {
  message_id: string
  status: string | null
  child_session_id: string | null
  background: number | boolean | null
}

/**
 * Pure (Kilo only): each assistant message's OWN cost — the recorded cost
 * minus what Kilo propagated into it from the child sessions its `task` calls
 * ran (kilocode/session/cost-propagation.ts). Kilo adds a child's cost growth
 * over each task run onto the calling message, and a child's messages already
 * hold their own children's, so a call that ran once and finished moved
 * exactly the child's summed recorded cost: that is taken back out, and the
 * child's own requests keep theirs.
 *
 * Where the amount is not known exactly — the call is still running (the
 * propagation happens when it ends), it ran in the background (the cost lands
 * when the background job ends, with no trace in the part), the child session
 * was resumed from another message (`task_id`: each message got only its
 * run's share), or the subtraction would go below zero (the propagation did
 * not happen, e.g. Kilo was killed mid-task) — the message's recorded cost is
 * dropped instead: it is priced from its own tokens by the list (or shown
 * unpriced), never counted twice and never a made-up $0.
 */
export function kiloOwnCosts(
  records: readonly UsageRecord[],
  parts: readonly KiloTaskPart[],
  source = 'kilo-code'
): UsageRecord[] {
  // Raw recorded cost per Kilo session (a record's own session: the child's
  // for a subagent's step, else the root's — which is its own).
  const sessionCost = new Map<string, bigint>()
  for (const record of records) {
    if (record.recordedPico === undefined) continue
    const session = record.subagent?.id ?? record.sessionId
    sessionCost.set(session, (sessionCost.get(session) ?? 0n) + BigInt(record.recordedPico))
  }
  const childrenOf = new Map<string, Set<string>>()
  const callersOf = new Map<string, Set<string>>()
  const inexact = new Set<string>()
  for (const part of parts) {
    if (typeof part.message_id !== 'string' || !part.child_session_id) continue
    const message = `${source}:${part.message_id}`
    const children = childrenOf.get(message) ?? new Set<string>()
    children.add(part.child_session_id)
    childrenOf.set(message, children)
    const callers = callersOf.get(part.child_session_id) ?? new Set<string>()
    callers.add(message)
    callersOf.set(part.child_session_id, callers)
    const finished = part.status === 'completed' || part.status === 'error'
    if (!finished || part.background === true || part.background === 1) inexact.add(message)
  }
  if (childrenOf.size === 0) return [...records]
  for (const callers of callersOf.values()) {
    if (callers.size > 1) for (const message of callers) inexact.add(message)
  }
  return records.map((record) => {
    const children = childrenOf.get(record.id)
    if (!children || record.recordedPico === undefined) return record
    let own: bigint | undefined
    if (!inexact.has(record.id)) {
      let propagated = 0n
      for (const child of children) propagated += sessionCost.get(child) ?? 0n
      own = BigInt(record.recordedPico) - propagated
    }
    // Zero left: OpenCode's "no price" zero (parseOpenCodeRow).
    const unknown = own === 0n
    if (own === undefined || own < 0n || unknown) {
      const unpriced = { ...record }
      delete unpriced.recordedPico
      return unpriced
    }
    return { ...record, recordedPico: own.toString() }
  })
}

function readKiloTaskParts(path: string): KiloTaskPart[] {
  const sqlite = loadSqlite()
  if (!sqlite) return []
  const db = new sqlite.DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare(KILO_TASK_PARTS_QUERY).all() as KiloTaskPart[]
  } catch {
    // No part table or no parent_id (an older schema): no task calls to undo.
    return []
  } finally {
    db.close()
  }
}

export function openCodeDatabase(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  return join(dataHome, 'opencode', 'opencode.db')
}

interface SqliteModule {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean }
  ) => {
    prepare(sql: string): {
      all(...params: unknown[]): unknown[]
      get(...params: unknown[]): unknown
    }
    close(): void
  }
}

function loadSqlite(): SqliteModule | null {
  try {
    // Through getBuiltinModule so the bundler never has to resolve it.
    return (process as unknown as { getBuiltinModule(id: string): unknown }).getBuiltinModule(
      'node:sqlite'
    ) as SqliteModule
  } catch {
    return null
  }
}

export function readOpenCodeRows(path: string): OpenCodeRow[] {
  return readOpenCodeRowsSince(path).rows
}

/** `query` limited to rows updated at or after `since` (filter first: it skips the JSON). */
const updatedSince = (query: string): string =>
  query.replace(
    "WHERE json_extract(m.data, '$.role') = 'assistant'",
    "WHERE m.time_updated >= ? AND json_extract(m.data, '$.role') = 'assistant'"
  )

/** OPENCODE_V2_ROOTED_QUERY limited to rows updated at or after `since`. */
const v2UpdatedSince = (query: string): string =>
  query.replace(
    "WHERE m.type IN ('assistant', 'compaction')",
    "WHERE m.time_updated >= ? AND m.type IN ('assistant', 'compaction')"
  )

/**
 * The assistant rows — all of them, or (with `since`) only those updated at or
 * after it — plus what an incremental reader needs to trust the result: the
 * newest `time_updated` and the table's row count (a shrink means a deletion).
 * `since` on a schema without `time_updated` throws: read everything instead.
 */
export function readOpenCodeRowsSince(
  path: string,
  since?: number,
  /** MiMo Code's schema: read each row's actor (`message.agent_id`) too. */
  actors = false,
  /** OpenCode itself: its 2.x tables too (the forks have none). */
  v2Tables = false
): { rows: OpenCodeRow[]; maxUpdated: number | null; messageCount: number | null } {
  const sqlite = loadSqlite()
  if (!sqlite) throw new Error('node:sqlite is not available in this runtime')
  const db = new sqlite.DatabaseSync(path, { readOnly: true })
  try {
    const has = (table: string): boolean =>
      Boolean(
        db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
      )
    // OpenCode 2's tables next to (or, in a database it created, instead of)
    // 1.x's; a database with neither reads as before (and fails as before).
    // (1.18 already has an unused session_message of its own: session_v2 is 2.x's.)
    const v2 = v2Tables && has('session_v2') && has('session_message')
    const v1 = !v2 || has('message')
    let count = 0
    let max: number | null = null
    let counted = false
    const tally = (table: string): void => {
      try {
        const stats = db
          .prepare(`SELECT count(*) AS n, max(time_updated) AS m FROM ${table}`)
          .get() as { n: number; m: number | null }
        counted = true
        count += typeof stats.n === 'number' ? stats.n : 0
        if (typeof stats.m === 'number') max = Math.max(max ?? 0, stats.m)
      } catch {
        // No time_updated (an old schema): full reads only.
        if (since !== undefined) throw new Error(`no ${table}.time_updated`)
      }
    }
    if (v1) tally('message')
    if (v2) tally('session_message')
    const run = (query: string, filter = updatedSince): OpenCodeRow[] =>
      (since === undefined
        ? db.prepare(query).all()
        : db.prepare(filter(query)).all(since)) as OpenCodeRow[]
    let rows: OpenCodeRow[] = []
    if (v1) {
      try {
        rows = run(actors ? MIMO_ROOTED_QUERY : OPENCODE_ROOTED_QUERY)
      } catch {
        // A database without `parent_id` (older OpenCode): no subagents to fold.
        rows = run(OPENCODE_QUERY)
      }
    }
    if (v2) rows = rows.concat(run(OPENCODE_V2_ROOTED_QUERY, v2UpdatedSince))
    return {
      rows,
      maxUpdated: max,
      messageCount: counted ? count : null
    }
  } finally {
    db.close()
  }
}

/**
 * v2: subagent requests carry their root session's id. v3: startedAt/endedAt.
 * v4: child-session requests are marked `subagent`; Kilo's task-calling
 * messages carry only their own cost (`kiloOwnCosts`). v5: OpenCode 2's tables.
 */
const STATE_VERSION = 5

/**
 * Between scans only rows with a newer `time_updated` are read (OpenCode and
 * Kilo bump it on every write of a message); a whole re-read at least this
 * often catches what that cannot see — a session moved, a clock stepped back.
 */
const FULL_RESYNC_MS = 10 * 60_000

export class OpenCodeSource implements UsageSource {
  private list: UsageRecord[] = []
  private stamp = ''
  private error?: string
  private sessions = 0
  private withOwners: UsageRecord[] | null = null
  // Incremental reads: every parsed row by record id (before Kilo's cost
  // correction, which needs them all), the newest `time_updated` seen, the
  // table's row count then, and when the last full read was.
  private raw: Map<string, UsageRecord> | null = null
  private seenUpdated: number | null = null
  private messageCount = 0
  private fullAt = 0

  constructor(
    private readonly dbPath: () => string = openCodeDatabase,
    /** OpenCode root session id → agent id (opencode/opencodeSessions.ts). */
    private readonly owners: () => ReadonlyMap<string, string> = () => new Map(),
    /** `opencode`, `kilo-code` for Kilo's kilo.db, `mimo-code` for MiMo Code's mimocode.db (same schema). */
    readonly id: string = 'opencode'
  ) {}

  /** mtime+size of the database and its WAL: unchanged → nothing to read. */
  private currentStamp(): string | null {
    const path = this.dbPath()
    try {
      const main = statSync(path)
      let wal = ''
      try {
        const walStat = statSync(`${path}-wal`)
        wal = `${walStat.mtimeMs}:${walStat.size}`
      } catch {
        // No WAL file is normal.
      }
      return `${main.mtimeMs}:${main.size}|${wal}`
    } catch {
      return null
    }
  }

  /** Rows updated since `since`, or null when only a full read can be trusted. */
  private readSince(since: number): ReturnType<typeof readOpenCodeRowsSince> | null {
    try {
      return readOpenCodeRowsSince(
        this.dbPath(),
        since,
        this.id === 'mimo-code',
        this.id === 'opencode'
      )
    } catch {
      return null
    }
  }

  async scan(): Promise<boolean> {
    const stamp = this.currentStamp()
    if (stamp === null) return false
    if (stamp === this.stamp) {
      // The agent owning a session can become known after its rows were read.
      this.withOwners = null
      return false
    }
    try {
      const now = Date.now()
      const incremental =
        this.raw !== null && this.seenUpdated !== null && now - this.fullAt < FULL_RESYNC_MS
      let read = incremental ? this.readSince(this.seenUpdated as number) : null
      // A smaller table than last time: something was deleted — read it all.
      if (read && read.messageCount !== null && read.messageCount < this.messageCount) read = null
      let raw: Map<string, UsageRecord>
      if (read) {
        raw = this.raw as Map<string, UsageRecord>
        for (const row of read.rows) {
          const record = parseOpenCodeRow(row, this.id)
          if (record) raw.set(record.id, record)
          else raw.delete(`${this.id}:${row.id}`)
        }
      } else {
        read = readOpenCodeRowsSince(
          this.dbPath(),
          undefined,
          this.id === 'mimo-code',
          this.id === 'opencode'
        )
        raw = new Map()
        for (const row of read.rows) {
          const record = parseOpenCodeRow(row, this.id)
          if (record) raw.set(record.id, record)
        }
        this.fullAt = now
      }
      this.raw = raw
      this.seenUpdated = read.maxUpdated
      this.messageCount = read.messageCount ?? 0
      let next: UsageRecord[] = []
      const sessions = new Set<string>()
      for (const record of raw.values()) {
        next.push(record)
        sessions.add(record.sessionId)
      }
      if (this.id === 'kilo-code' && next.some((record) => record.subagent)) {
        next = kiloOwnCosts(next, readKiloTaskParts(this.dbPath()), this.id)
      }
      next.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
      this.list = next
      this.withOwners = null
      this.sessions = sessions.size
      this.stamp = stamp
      this.error = undefined
      return true
    } catch (error) {
      // The next scan starts over from a full read.
      this.raw = null
      this.error = String(error)
      console.error(`usage: could not read the ${this.id} database`, error)
      return false
    }
  }

  records(): readonly UsageRecord[] {
    if (!this.withOwners) {
      const owners = this.owners()
      this.withOwners =
        owners.size === 0
          ? this.list
          : this.list.map((record) => {
              const agentId = owners.get(record.sessionId)
              return agentId && record.agentId !== agentId ? { ...record, agentId } : record
            })
    }
    return this.withOwners
  }

  status(): UsageSourceStatus {
    return {
      source: this.id,
      available: this.currentStamp() !== null,
      location: this.dbPath(),
      files: this.sessions,
      records: this.list.length,
      error: this.error
    }
  }

  exportState(): unknown {
    return { v: STATE_VERSION, stamp: this.stamp, records: this.list }
  }

  importState(state: unknown): void {
    const saved = state as { v?: number; stamp?: string; records?: UsageRecord[] } | null
    if (!saved || typeof saved.stamp !== 'string' || !Array.isArray(saved.records)) return
    // Records cached before subagent sessions were folded into their root.
    if (saved.v !== STATE_VERSION) return
    // A damaged cache: only well-formed records are kept.
    const records = saved.records.filter(
      (record): record is UsageRecord =>
        Boolean(record) &&
        typeof record === 'object' &&
        typeof record.id === 'string' &&
        typeof record.sessionId === 'string' &&
        typeof record.at === 'number'
    )
    this.stamp = saved.stamp
    this.list = records
    this.raw = null
    this.withOwners = null
    this.sessions = new Set(records.map((record) => record.sessionId)).size
  }
}

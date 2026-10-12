// Small synthetic logs for Claude Code, Codex CLI and OpenCode, written into
// a throwaway folder. Every private-looking string is a marker the privacy
// test hunts for in the output.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScanLocations } from '../src/scan/index.js'
import { loadSqlite } from '../src/scan/opencode.js'

export const SECRET_PROJECT = 'secret-project-xyz'
export const SECRET_DIR = `/home/alice/${SECRET_PROJECT}`
export const SECRET_PROMPT = 'SECRET_PROMPT_TEXT_42'
export const SECRET_FILE = 'hidden-module-file.ts'

const jsonl = (lines: unknown[]): string => lines.map((line) => JSON.stringify(line)).join('\n') + '\n'

function claudeUsage(output: number) {
  return {
    input_tokens: 10,
    output_tokens: output,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 200,
    cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 }
  }
}

/** Claude Code: one main session, a resumed copy of it, and a subagent log. */
function claudeLines() {
  const base = { sessionId: 'sess-a', cwd: SECRET_DIR }
  return [
    { type: 'file-history-snapshot', messageId: 'x' },
    // 1) a real prompt at 01:30 UTC (night owl), with rage
    { ...base, type: 'user', uuid: 'u1', timestamp: '2026-09-30T01:30:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: `please fix ${SECRET_PROMPT}, wtf` } },
    // 2) one assistant message logged as two lines (text, then tool_use) — usage streams
    { ...base, type: 'assistant', uuid: 'a1', timestamp: '2026-09-30T01:30:05.000Z', message: { id: 'msg_1', model: 'claude-opus-4-6', content: [{ type: 'text', text: "You're absolutely right! Perfect! Also you’re ABSOLUTELY right." }], usage: claudeUsage(5) } },
    { ...base, type: 'assistant', uuid: 'a2', timestamp: '2026-09-30T01:30:06.000Z', message: { id: 'msg_1', model: 'claude-opus-4-6', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: `${SECRET_DIR}/${SECRET_FILE}`, old_string: SECRET_PROMPT } }], usage: claudeUsage(50) } },
    // 3) the tool result: not a prompt
    { ...base, type: 'user', uuid: 'u2', timestamp: '2026-09-30T01:30:07.000Z', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: SECRET_PROMPT }] } },
    // 4) an interrupt marker
    { ...base, type: 'user', uuid: 'u3', timestamp: '2026-09-30T01:31:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    // 5) slash-command plumbing and meta lines: not prompts
    { ...base, type: 'user', uuid: 'u4', timestamp: '2026-09-30T01:32:00.000Z', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { ...base, type: 'user', uuid: 'u5', timestamp: '2026-09-30T01:32:00.000Z', isMeta: true, message: { role: 'user', content: 'Caveat: meta' } },
    { ...base, type: 'user', uuid: 'u6', timestamp: '2026-09-30T01:33:00.000Z', origin: { kind: 'task-notification' }, message: { role: 'user', content: 'background task done' } },
    // 6) a second real prompt the next day, at 14:00 UTC
    { ...base, type: 'user', uuid: 'u7', timestamp: '2026-10-01T14:00:00.000Z', message: { role: 'user', content: 'damn, make the tests pass' } },
    { ...base, type: 'assistant', uuid: 'a3', timestamp: '2026-10-01T14:00:10.000Z', message: { id: 'msg_2', model: 'claude-opus-4-6', content: [{ type: 'text', text: 'Done.' }, { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'npm test' } }], usage: claudeUsage(100) } },
    { ...base, type: 'assistant', uuid: 'a4', timestamp: '2026-10-01T14:20:10.000Z', message: { id: 'msg_3', model: 'claude-opus-4-6', content: [{ type: 'tool_use', id: 'toolu_3', name: 'mcp__private_server__secret_tool', input: {} }], usage: claudeUsage(20) } }
  ]
}

function codexLines() {
  const meta = { type: 'session_meta', timestamp: '2026-10-02T09:00:00.000Z', payload: { id: '0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee', session_id: '0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd: SECRET_DIR, model_provider: 'openai', source: 'cli' } }
  const turn = { type: 'turn_context', timestamp: '2026-10-02T09:00:00.000Z', payload: { cwd: SECRET_DIR, model: 'gpt-5.3-codex' } }
  const msg = (role: string, kinds: string[] | undefined, type: string, text: string, ts: string) => ({
    type: 'response_item',
    timestamp: ts,
    payload: { type: 'message', id: `m-${ts}`, role, content: [{ type, text }], ...(kinds ? { internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } : {}) }
  })
  return [
    meta,
    turn,
    msg('user', ['environments.environment_context'], 'input_text', `<environment_context><cwd>${SECRET_DIR}</cwd></environment_context>`, '2026-10-02T09:00:01.000Z'),
    msg('user', ['user.text'], 'input_text', `shit, ${SECRET_PROMPT} is broken`, '2026-10-02T09:00:02.000Z'),
    { type: 'response_item', timestamp: '2026-10-02T09:00:05.000Z', payload: { type: 'custom_tool_call', id: 'ct1', call_id: 'call_1', name: 'apply_patch', input: `*** Begin Patch\n*** Update File: ${SECRET_DIR}/${SECRET_FILE}\n@@\n-a\n+b\n*** Add File: ${SECRET_DIR}/new.ts\n+x\n*** End Patch` } },
    { type: 'response_item', timestamp: '2026-10-02T09:00:06.000Z', payload: { type: 'function_call', id: 'fc1', call_id: 'call_2', name: 'exec_command', arguments: '{"cmd":"ls"}' } },
    msg('assistant', undefined, 'output_text', 'Perfect! You’re absolutely right.', '2026-10-02T09:00:08.000Z'),
    { type: 'token_usage_record', timestamp: '2026-10-02T09:00:09.000Z', payload: { response_id: 'resp_1', usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 5300 } } },
    { type: 'event_msg', timestamp: '2026-10-02T09:05:00.000Z', payload: { type: 'turn_aborted', reason: 'interrupted' } }
  ]
}

function writeOpenCode(path: string): boolean {
  const sqlite = loadSqlite()
  if (!sqlite) return false
  const Db = sqlite.DatabaseSync as unknown as new (p: string) => {
    exec(sql: string): void
    prepare(sql: string): { run(...args: unknown[]): unknown }
    close(): void
  }
  const db = new Db(path)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`)
  const t0 = Date.parse('2026-10-03T10:00:00.000Z')
  const session = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)')
  session.run('ses_root', null, SECRET_DIR, t0, t0)
  session.run('ses_child', 'ses_root', SECRET_DIR, t0, t0)
  const message = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)')
  const part = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)')
  const tokens = { input: 100, output: 40, reasoning: 10, cache: { read: 2000, write: 0 } }
  // A real prompt in the root session.
  message.run('msg_u1', 'ses_root', t0, t0, JSON.stringify({ role: 'user', time: { created: t0 } }))
  part.run('prt_1', 'msg_u1', 'ses_root', t0, t0, JSON.stringify({ type: 'text', text: `fuck, ${SECRET_PROMPT}` }))
  part.run('prt_2', 'msg_u1', 'ses_root', t0, t0, JSON.stringify({ type: 'text', text: 'synthetic context', synthetic: true }))
  // Its answer: priced from the list (anthropic), with a text and an edit.
  message.run('msg_a1', 'ses_root', t0 + 1000, t0 + 1000, JSON.stringify({ role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet-4-5', cost: 0.0123, tokens, time: { created: t0 + 1000, completed: t0 + 5000 }, path: { cwd: SECRET_DIR } }))
  part.run('prt_3', 'msg_a1', 'ses_root', t0 + 2000, t0 + 2000, JSON.stringify({ type: 'text', text: 'Perfect! Done.' }))
  part.run('prt_4', 'msg_a1', 'ses_root', t0 + 3000, t0 + 3000, JSON.stringify({ type: 'tool', tool: 'edit', callID: 'c1', state: { status: 'completed', input: { filePath: `${SECRET_DIR}/${SECRET_FILE}` } } }))
  // A subagent's "prompt" (from the parent agent) and its step on a local model: no price.
  message.run('msg_u2', 'ses_child', t0 + 6000, t0 + 6000, JSON.stringify({ role: 'user', time: { created: t0 + 6000 } }))
  part.run('prt_5', 'msg_u2', 'ses_child', t0 + 6000, t0 + 6000, JSON.stringify({ type: 'text', text: 'explore the repo' }))
  message.run('msg_a2', 'ses_child', t0 + 7000, t0 + 7000, JSON.stringify({ role: 'assistant', providerID: 'lmstudio', modelID: 'qwen3-coder-30b', cost: 0, tokens, time: { created: t0 + 7000, completed: t0 + 9000 } }))
  part.run('prt_6', 'msg_a2', 'ses_child', t0 + 8000, t0 + 8000, JSON.stringify({ type: 'tool', tool: 'bash', callID: 'c2', state: { status: 'completed', input: { command: 'ls' } } }))
  // An aborted turn.
  message.run('msg_a3', 'ses_root', t0 + 20000, t0 + 20000, JSON.stringify({ role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet-4-5', error: { name: 'MessageAbortedError' }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: t0 + 20000 } }))
  db.close()
  return true
}

export interface Fixture {
  root: string
  locations: ScanLocations
  hasOpenCode: boolean
}

export function makeFixture(name: string): Fixture {
  const root = join(process.cwd(), '.test-dist', 'fixtures', name)
  rmSync(root, { recursive: true, force: true })
  const claudeRoot = join(root, 'claude', 'projects')
  const project = join(claudeRoot, `-home-alice-${SECRET_PROJECT}`)
  mkdirSync(join(project, 'sess-a', 'subagents'), { recursive: true })
  const lines = claudeLines()
  writeFileSync(join(project, 'sess-a.jsonl'), jsonl(lines))
  // A resumed session copies the history (same uuids, same message ids) and adds nothing.
  writeFileSync(join(project, 'sess-b.jsonl'), jsonl(lines.slice(1, 4).map((line) => ({ ...line, sessionId: 'sess-b' }))))
  writeFileSync(
    join(project, 'sess-a', 'subagents', 'agent-x1.jsonl'),
    jsonl([
      { type: 'user', uuid: 's1', sessionId: 'sess-a', isSidechain: true, timestamp: '2026-10-01T14:05:00.000Z', message: { role: 'user', content: 'Explore the code base' } },
      { type: 'assistant', uuid: 's2', sessionId: 'sess-a', isSidechain: true, timestamp: '2026-10-01T14:05:10.000Z', message: { id: 'msg_sub', model: 'claude-haiku-4-5-20251001', content: [{ type: 'tool_use', id: 'toolu_s1', name: 'Read', input: { file_path: `${SECRET_DIR}/x.ts` } }], usage: claudeUsage(30) } }
    ])
  )
  const codexHome = join(root, 'codex')
  const day = join(codexHome, 'sessions', '2026', '10', '02')
  mkdirSync(day, { recursive: true })
  writeFileSync(join(day, 'rollout-2026-10-02T09-00-00-0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'), jsonl(codexLines()))
  const ocDir = join(root, 'data', 'opencode')
  mkdirSync(ocDir, { recursive: true })
  const openCodeDb = join(ocDir, 'opencode.db')
  const hasOpenCode = writeOpenCode(openCodeDb)
  return { root, locations: { claudeRoots: [claudeRoot], codexHome, openCodeDb }, hasOpenCode }
}

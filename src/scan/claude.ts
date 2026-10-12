// Fun counters from Claude Code transcripts (`~/.claude/projects/**.jsonl`).
//
// Lines arrive already parsed (the usage reader parses each line once and
// hands it here too). Copies of a line in resumed or forked sessions keep
// their `uuid` (measured), so every line is counted once by it; tool calls
// once by their `tool_use` id.
import type { Collected } from './collector.js'
import { displayTool, fileKey, isRage, scanReplyText } from './collector.js'

interface ClaudeLine {
  type?: string
  uuid?: string
  timestamp?: string
  sessionId?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  isVisibleInTranscriptOnly?: boolean
  toolUseResult?: unknown
  origin?: { kind?: string } | null
  message?: { id?: string; content?: unknown }
}

interface Block {
  type?: string
  text?: unknown
  name?: unknown
  id?: unknown
  input?: { file_path?: unknown; notebook_path?: unknown } | null
}

/**
 * Tags Claude Code wraps around lines that sit in the user's turn but were
 * not typed as a prompt: slash-command plumbing, `!` shell output, hook and
 * task notifications, system reminders.
 */
const NOT_A_PROMPT_TAG =
  /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification|system-reminder|user-memory-input|fork-boilerplate|tool-use-error|teammate-message|channel)\b/

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export interface ClaudeFileContext {
  /** The file is a subagent's own log: its "user" turns come from the parent agent. */
  subagentFile: boolean
}

export class ClaudeCounters {
  private seenLines = new Set<string>()
  private seenTools = new Set<string>()
  private repliedMessages = new Set<string>()

  constructor(private readonly out: Collected) {}

  line(entry: unknown, file: ClaudeFileContext): void {
    const line = entry as ClaudeLine
    if (line?.type !== 'user' && line?.type !== 'assistant') return
    const at = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN
    if (Number.isNaN(at)) return
    if (typeof line.uuid === 'string') {
      if (this.seenLines.has(line.uuid)) return
      this.seenLines.add(line.uuid)
    }
    if (line.type === 'user') this.user(line, at, file)
    else this.assistant(line, at)
  }

  private user(line: ClaudeLine, at: number, file: ClaudeFileContext): void {
    if (file.subagentFile || line.isSidechain === true) return
    if (line.isMeta || line.isCompactSummary || line.isVisibleInTranscriptOnly) return
    if (line.toolUseResult !== undefined) return
    if (line.origin && typeof line.origin === 'object' && line.origin.kind !== 'human') return
    const content = line.message?.content
    let text: string
    let hasImage = false
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      const blocks = content as Block[]
      if (blocks.some((block) => block?.type === 'tool_result')) return
      text = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('\n')
      hasImage = blocks.some((block) => block?.type === 'image')
    } else return
    const trimmed = text.trim()
    if (trimmed.startsWith('[Request interrupted by user')) {
      this.out.interrupts.push(at)
      return
    }
    if (NOT_A_PROMPT_TAG.test(trimmed)) return
    if (!trimmed && !hasImage) return
    this.out.prompts.push({
      at,
      session: typeof line.sessionId === 'string' ? line.sessionId : '',
      rage: isRage(trimmed)
    })
  }

  private assistant(line: ClaudeLine, at: number): void {
    const content = line.message?.content
    if (!Array.isArray(content)) return
    for (const block of content as Block[]) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        const id = line.message?.id ?? line.uuid
        if (id && !this.repliedMessages.has(id)) {
          this.repliedMessages.add(id)
          this.out.replies.push(at)
        }
        scanReplyText(this.out, at, block.text)
      } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
        if (typeof block.id === 'string') {
          if (this.seenTools.has(block.id)) continue
          this.seenTools.add(block.id)
        }
        this.out.tools.push({ at, name: displayTool('claude-code', block.name) })
        if (EDIT_TOOLS.has(block.name)) {
          const path = block.input?.file_path ?? block.input?.notebook_path
          if (typeof path === 'string' && path) this.out.edits.push({ at, file: fileKey(path) })
        }
      }
    }
  }
}

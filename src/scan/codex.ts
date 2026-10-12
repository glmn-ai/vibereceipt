// Fun counters from Codex CLI rollouts (`~/.codex/sessions/**/rollout-*.jsonl`).
//
// Two generations of the format are handled:
// - current builds log the user's prompt as a `response_item` user message
//   tagged `content_item_kinds: ["user.text"]` (injected context such as
//   `<environment_context>` carries other kinds), and replies as assistant
//   `response_item` messages;
// - older builds also (or only) log `event_msg` → `user_message` /
//   `agent_message`. A file that has those uses them instead, so the two are
//   never added up.
// A forked subagent's rollout starts with a copy of its parent's history (the
// vendored usage parser marks it `meta.inherited`): skipped here as well, and a
// subagent's "user" turns come from its parent agent, not from you.
import type { FileMeta } from '../vendor/neurosquad-core/jsonlSource.js'
import type { Collected, PromptEvent } from './collector.js'
import { displayTool, emptyCollected, fileKey, isRage, scanReplyText } from './collector.js'

/** A reply reduced to its counts at once (no text is buffered). */
function replyOf(at: number, text: string): Collected {
  const one = emptyCollected()
  one.replies.push(at)
  scanReplyText(one, at, text)
  return one
}

interface CodexLine {
  timestamp?: string
  type?: string
  payload?: {
    type?: string
    id?: string
    role?: string
    name?: string
    call_id?: string
    input?: unknown
    arguments?: unknown
    message?: unknown
    reason?: unknown
    content?: { type?: string; text?: unknown }[]
    internal_chat_message_metadata_passthrough?: { content_item_kinds?: unknown }
  }
}

interface FileBuffer {
  itemPrompts: PromptEvent[]
  eventPrompts: PromptEvent[]
  itemReplies: Collected[]
  eventReplies: Collected[]
}

const PATCH_FILE = /^\*\*\* (?:Update|Add) File: (.+)$/gm

export class CodexCounters {
  private seenTools = new Set<string>()
  private files = new Map<FileMeta, FileBuffer>()

  constructor(private readonly out: Collected) {}

  private buffer(meta: FileMeta): FileBuffer {
    let buffer = this.files.get(meta)
    if (!buffer) {
      buffer = { itemPrompts: [], eventPrompts: [], itemReplies: [], eventReplies: [] }
      this.files.set(meta, buffer)
    }
    return buffer
  }

  /** `inherited`: the line is part of a forked parent's copied history. */
  line(entry: unknown, meta: FileMeta, inherited: boolean): void {
    if (inherited) return
    const line = entry as CodexLine
    const payload = line?.payload
    if (!payload) return
    const at = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN
    if (Number.isNaN(at)) return
    const session = String(meta.rootSessionId ?? meta.sessionId ?? '')
    const subagent = Boolean(meta.subagent)
    if (line.type === 'response_item') {
      const kind = payload.type
      if (kind === 'message' && payload.role === 'user') {
        if (subagent) return
        const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds
        const text = textOf(payload.content, 'input_text')
        const typed = Array.isArray(kinds)
          ? kinds.includes('user.text')
          : text.trim() !== '' && !text.trimStart().startsWith('<')
        if (typed) this.buffer(meta).itemPrompts.push({ at, session, rage: isRage(text) })
      } else if (kind === 'message' && payload.role === 'assistant') {
        const text = textOf(payload.content, 'output_text')
        if (text.trim()) this.buffer(meta).itemReplies.push(replyOf(at, text))
      } else if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'local_shell_call') {
        const id = payload.call_id ?? payload.id
        if (typeof id === 'string') {
          if (this.seenTools.has(id)) return
          this.seenTools.add(id)
        }
        const name = typeof payload.name === 'string' ? payload.name : kind === 'local_shell_call' ? 'local_shell' : ''
        this.out.tools.push({ at, name: displayTool('codex-cli', name) })
        const body = typeof payload.input === 'string' ? payload.input : typeof payload.arguments === 'string' ? payload.arguments : ''
        if (body.includes('*** ')) {
          // Arguments may be JSON with the patch inside a string: unescape newlines first.
          const patch = body.includes('\\n') ? body.replace(/\\n/g, '\n') : body
          PATCH_FILE.lastIndex = 0
          let match: RegExpExecArray | null
          while ((match = PATCH_FILE.exec(patch))) {
            const file = match[1].replace(/["\\]+$/, '').trim()
            if (file) this.out.edits.push({ at, file: fileKey(file) })
          }
        }
      }
      return
    }
    if (line.type === 'event_msg') {
      if (payload.type === 'user_message' && typeof payload.message === 'string') {
        if (subagent) return
        const text = payload.message
        if (text.trim() && !text.trimStart().startsWith('<')) {
          this.buffer(meta).eventPrompts.push({ at, session, rage: isRage(text) })
        }
      } else if (payload.type === 'agent_message' && typeof payload.message === 'string') {
        if (payload.message.trim()) {
          this.buffer(meta).eventReplies.push(replyOf(at, payload.message))
        }
      } else if (payload.type === 'turn_aborted' && payload.reason === 'interrupted') {
        this.out.interrupts.push(at)
      }
    }
  }

  /** After every file is read: one representation per file. */
  finish(): void {
    for (const buffer of this.files.values()) {
      const prompts = buffer.eventPrompts.length > 0 ? buffer.eventPrompts : buffer.itemPrompts
      this.out.prompts.push(...prompts)
      const replies = buffer.itemReplies.length > 0 ? buffer.itemReplies : buffer.eventReplies
      for (const reply of replies) {
        this.out.replies.push(...reply.replies)
        this.out.absolutelyRight.push(...reply.absolutelyRight)
        this.out.perfect.push(...reply.perfect)
      }
    }
    this.files.clear()
  }
}

function textOf(content: unknown, type: string): string {
  if (!Array.isArray(content)) return ''
  return (content as { type?: string; text?: unknown }[])
    .filter((item) => item?.type === type && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('\n')
}

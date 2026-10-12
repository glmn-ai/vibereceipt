// What the transcript scanners collect, on top of the vendored usage records.
//
// Privacy: nothing here keeps prompt or reply text. A prompt is reduced to
// its time, its session and two booleans the moment it is read; a reply to
// two phrase counts. Edited file paths are kept only as a set (to count
// distinct ones) and never leave this module.

export type HarnessId = 'claude-code' | 'codex-cli' | 'opencode'

export interface PromptEvent {
  at: number
  session: string
  rage: boolean
}

export interface ToolEvent {
  at: number
  name: string
}

export interface Collected {
  prompts: PromptEvent[]
  /** Assistant messages with visible text. */
  replies: number[]
  tools: ToolEvent[]
  /** Interrupt times. */
  interrupts: number[]
  /** Per occurrence. */
  absolutelyRight: number[]
  perfect: number[]
  /** Edit time per edited file (key = normalised path, kept in memory only). */
  edits: { at: number; file: string }[]
}

export const emptyCollected = (): Collected => ({
  prompts: [],
  replies: [],
  tools: [],
  interrupts: [],
  absolutelyRight: [],
  perfect: [],
  edits: []
})

const ABSOLUTELY_RIGHT = /you(?:'|’|ʼ)?re absolutely right|you are absolutely right/gi
const PERFECT = /\bperfect!/gi
const RAGE = /\b(?:wtf+|fuck\w*|f\*+k\w*|shit\w*|damn\w*|goddamn\w*)\b/i

export function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0
  let count = 0
  while (re.exec(text)) count++
  return count
}

/** Phrase counters of one assistant text. */
export function scanReplyText(target: Collected, at: number, text: string): void {
  if (!text) return
  for (let i = countMatches(text, ABSOLUTELY_RIGHT); i > 0; i--) target.absolutelyRight.push(at)
  for (let i = countMatches(text, PERFECT); i > 0; i--) target.perfect.push(at)
}

export const isRage = (text: string): boolean => RAGE.test(text)

/** A file path as a set key: forward slashes, case-folded on Windows-style paths. */
export function fileKey(path: string): string {
  const slashed = path.trim().replace(/\\/g, '/')
  return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed
}

/**
 * Tool names as the receipt shows them. Shell tools of every harness read
 * "Bash", file edits "Edit" etc.; MCP and unknown tools are grouped so a
 * private server's or tool's name never shows up.
 */
export function displayTool(harness: HarnessId, raw: string): string {
  const name = raw.trim()
  if (!name) return 'Other tools'
  if (name.startsWith('mcp__') || name.includes('__')) return 'MCP tools'
  if (harness === 'claude-code') {
    if (name === 'Task') return 'Agent'
    return /^[A-Z][A-Za-z0-9]*$/.test(name) ? name : 'Other tools'
  }
  const lower = name.toLowerCase()
  const map: Record<string, string> = {
    shell: 'Bash',
    bash: 'Bash',
    exec: 'Bash',
    exec_command: 'Bash',
    local_shell: 'Bash',
    container_exec: 'Bash',
    shell_command: 'Bash',
    write_stdin: 'Bash',
    apply_patch: 'Edit',
    patch: 'Edit',
    edit: 'Edit',
    multiedit: 'MultiEdit',
    write: 'Write',
    read: 'Read',
    read_file: 'Read',
    view_image: 'Read',
    list: 'LS',
    list_dir: 'LS',
    grep: 'Grep',
    grep_files: 'Grep',
    glob: 'Glob',
    webfetch: 'WebFetch',
    websearch: 'WebSearch',
    web_search: 'WebSearch',
    codesearch: 'CodeSearch',
    task: 'Agent',
    spawn_agent: 'Agent',
    todowrite: 'TodoWrite',
    todoread: 'TodoRead',
    update_plan: 'TodoWrite',
    question: 'Question',
    skill: 'Skill',
    lsp: 'LSP',
    batch: 'Batch'
  }
  if (map[lower]) return map[lower]
  // OpenCode names MCP tools `<server>_<tool>`: anything unknown is grouped,
  // so no private tool or server name reaches the receipt.
  return 'Other tools'
}

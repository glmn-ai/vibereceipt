import { displayTool, fileKey, isRage, scanReplyText } from './collector.js';
/**
 * Tags Claude Code wraps around lines that sit in the user's turn but were
 * not typed as a prompt: slash-command plumbing, `!` shell output, hook and
 * task notifications, system reminders.
 */
const NOT_A_PROMPT_TAG = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification|system-reminder|user-memory-input|fork-boilerplate|tool-use-error|teammate-message|channel)\b/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export class ClaudeCounters {
    out;
    seenLines = new Set();
    seenTools = new Set();
    repliedMessages = new Set();
    constructor(out) {
        this.out = out;
    }
    line(entry, file) {
        const line = entry;
        if (line?.type !== 'user' && line?.type !== 'assistant')
            return;
        const at = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN;
        if (Number.isNaN(at))
            return;
        if (typeof line.uuid === 'string') {
            if (this.seenLines.has(line.uuid))
                return;
            this.seenLines.add(line.uuid);
        }
        if (line.type === 'user')
            this.user(line, at, file);
        else
            this.assistant(line, at);
    }
    user(line, at, file) {
        if (file.subagentFile || line.isSidechain === true)
            return;
        if (line.isMeta || line.isCompactSummary || line.isVisibleInTranscriptOnly)
            return;
        if (line.toolUseResult !== undefined)
            return;
        if (line.origin && typeof line.origin === 'object' && line.origin.kind !== 'human')
            return;
        const content = line.message?.content;
        let text;
        let hasImage = false;
        if (typeof content === 'string')
            text = content;
        else if (Array.isArray(content)) {
            const blocks = content;
            if (blocks.some((block) => block?.type === 'tool_result'))
                return;
            text = blocks
                .filter((block) => block?.type === 'text' && typeof block.text === 'string')
                .map((block) => block.text)
                .join('\n');
            hasImage = blocks.some((block) => block?.type === 'image');
        }
        else
            return;
        const trimmed = text.trim();
        if (trimmed.startsWith('[Request interrupted by user')) {
            this.out.interrupts.push(at);
            return;
        }
        if (NOT_A_PROMPT_TAG.test(trimmed))
            return;
        if (!trimmed && !hasImage)
            return;
        this.out.prompts.push({
            at,
            session: typeof line.sessionId === 'string' ? line.sessionId : '',
            rage: isRage(trimmed)
        });
    }
    assistant(line, at) {
        const content = line.message?.content;
        if (!Array.isArray(content))
            return;
        for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                const id = line.message?.id ?? line.uuid;
                if (id && !this.repliedMessages.has(id)) {
                    this.repliedMessages.add(id);
                    this.out.replies.push(at);
                }
                scanReplyText(this.out, at, block.text);
            }
            else if (block?.type === 'tool_use' && typeof block.name === 'string') {
                if (typeof block.id === 'string') {
                    if (this.seenTools.has(block.id))
                        continue;
                    this.seenTools.add(block.id);
                }
                this.out.tools.push({ at, name: displayTool('claude-code', block.name) });
                if (EDIT_TOOLS.has(block.name)) {
                    const path = block.input?.file_path ?? block.input?.notebook_path;
                    if (typeof path === 'string' && path)
                        this.out.edits.push({ at, file: fileKey(path) });
                }
            }
        }
    }
}

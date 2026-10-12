import { displayTool, fileKey, isRage, scanReplyText } from './collector.js';
let sqliteModule;
/** `node:sqlite`, or null on runtimes without it (Node < 22.13 without the flag). */
export function loadSqlite() {
    if (sqliteModule !== undefined)
        return sqliteModule;
    sqliteModule = null;
    try {
        const get = process.getBuiltinModule;
        const mod = typeof get === 'function' ? get.call(process, 'node:sqlite') : undefined;
        if (mod && typeof mod.DatabaseSync === 'function')
            sqliteModule = mod;
    }
    catch {
        // Not available.
    }
    return sqliteModule;
}
const PROMPT_PARTS = `
  SELECT m.id AS message_id, m.session_id AS session_id, m.time_created AS at,
         json_extract(p.data, '$.text') AS text,
         json_extract(p.data, '$.synthetic') AS synthetic,
         json_extract(p.data, '$.ignored') AS ignored
  FROM message m
  JOIN session s ON s.id = m.session_id
  JOIN part p ON p.message_id = m.id
  WHERE s.parent_id IS NULL
    AND json_extract(m.data, '$.role') = 'user'
    AND json_extract(p.data, '$.type') = 'text'`;
const REPLY_PARTS = `
  SELECT p.message_id AS message_id, p.time_created AS at,
         json_extract(p.data, '$.text') AS text
  FROM part p
  JOIN message m ON m.id = p.message_id
  WHERE json_extract(p.data, '$.type') = 'text'
    AND json_extract(m.data, '$.role') = 'assistant'`;
const TOOL_PARTS = `
  SELECT p.time_created AS at,
         json_extract(p.data, '$.tool') AS tool,
         json_extract(p.data, '$.state.input.filePath') AS file
  FROM part p
  WHERE json_extract(p.data, '$.type') = 'tool'`;
const ABORTED = `
  SELECT m.time_created AS at FROM message m
  WHERE json_extract(m.data, '$.error.name') = 'MessageAbortedError'`;
const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'patch']);
/** Reads the counters out of `path`. Returns false when the schema is not one it knows. */
export function scanOpenCodeCounters(db, out) {
    const has = (table) => Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    if (!has('message') || !has('part') || !has('session'))
        return false;
    try {
        const prompts = new Map();
        for (const row of db.prepare(PROMPT_PARTS).all()) {
            if (row.synthetic === 1 || row.synthetic === true || row.ignored === 1 || row.ignored === true)
                continue;
            if (typeof row.text !== 'string' || !row.text.trim())
                continue;
            const prompt = prompts.get(row.message_id) ?? { at: row.at, session: row.session_id, texts: [] };
            prompt.texts.push(row.text);
            prompts.set(row.message_id, prompt);
        }
        for (const prompt of prompts.values()) {
            out.prompts.push({ at: prompt.at, session: prompt.session, rage: isRage(prompt.texts.join('\n')) });
        }
    }
    catch {
        // An older schema without parent_id: no prompts rather than wrong ones.
    }
    try {
        const replied = new Set();
        for (const row of db.prepare(REPLY_PARTS).all()) {
            if (typeof row.text !== 'string' || !row.text.trim())
                continue;
            if (!replied.has(row.message_id)) {
                replied.add(row.message_id);
                out.replies.push(row.at);
            }
            scanReplyText(out, row.at, row.text);
        }
    }
    catch {
        // Unknown schema.
    }
    try {
        for (const row of db.prepare(TOOL_PARTS).all()) {
            if (typeof row.tool !== 'string')
                continue;
            out.tools.push({ at: row.at, name: displayTool('opencode', row.tool) });
            if (EDIT_TOOLS.has(row.tool) && typeof row.file === 'string' && row.file) {
                out.edits.push({ at: row.at, file: fileKey(row.file) });
            }
        }
    }
    catch {
        // Unknown schema.
    }
    try {
        for (const row of db.prepare(ABORTED).all())
            out.interrupts.push(row.at);
    }
    catch {
        // Unknown schema.
    }
    return true;
}

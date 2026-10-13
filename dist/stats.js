// Scan result + period → the numbers on the receipt.
//
// Money: integer picodollars (bigint) end to end, from the vendored exact
// pricing. A request's cost is its API list price; where the price table has
// no entry, the cost the harness itself recorded (OpenCode computes one from
// its provider catalogue); with neither, the request is "no price" — counted
// separately, never as $0.
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { canonicalModel, listCost, PRICE_TABLE_VERSION } from './vendor/neurosquad-core/pricing.js';
import { inPeriod } from './period.js';
import { planMath } from './plan.js';
export const HARNESS_LABEL = {
    'claude-code': 'Claude Code',
    'codex-cli': 'Codex CLI',
    opencode: 'OpenCode'
};
/** A gap longer than this ends a session's continuous stretch. */
export const SESSION_GAP_MS = 60 * 60_000;
const pad = (n) => String(n).padStart(2, '0');
export const localDate = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** A request's price: list first, the harness's own record second, else undefined. */
export function recordPrice(record) {
    const list = listCost(record);
    if (list.pico !== undefined)
        return { pico: list.pico, via: 'list' };
    if (record.recordedPico !== undefined)
        return { pico: BigInt(record.recordedPico), via: 'recorded' };
    return {};
}
const emptyRow = () => ({ tokens: 0, requests: 0, pico: 0n, unpricedRequests: 0 });
function longestStreak(days) {
    let best = 0;
    for (const day of days) {
        const [y, m, d] = day.split('-').map(Number);
        if (days.has(localDate(new Date(y, m - 1, d - 1).getTime())))
            continue; // not a run's start
        let length = 1;
        let cursor = new Date(y, m - 1, d + 1);
        while (days.has(localDate(cursor.getTime()))) {
            length++;
            cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
        }
        best = Math.max(best, length);
    }
    return best;
}
function longestSession(times) {
    let best = 0;
    for (const list of times.values()) {
        if (list.length < 2)
            continue;
        list.sort((a, b) => a - b);
        let start = list[0];
        for (let i = 1; i < list.length; i++) {
            if (list[i] - list[i - 1] > SESSION_GAP_MS)
                start = list[i];
            else
                best = Math.max(best, list[i] - start);
        }
    }
    return best;
}
export function buildStats(scan, options) {
    const { period } = options;
    const records = scan.records.filter((record) => inPeriod(period, record.at));
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const harnessRows = new Map();
    const modelRows = new Map();
    const cost = { pico: 0n, listRequests: 0, recordedRequests: 0, unpricedRequests: 0, unpricedTokens: 0 };
    const sessions = new Set();
    const sessionTimes = new Map();
    const activeDays = new Set();
    const projects = new Map();
    let firstAt;
    let lastAt;
    const touch = (session, at) => {
        sessions.add(session);
        const list = sessionTimes.get(session);
        if (list)
            list.push(at);
        else
            sessionTimes.set(session, [at]);
        activeDays.add(localDate(at));
        firstAt = firstAt === undefined ? at : Math.min(firstAt, at);
        lastAt = lastAt === undefined ? at : Math.max(lastAt, at);
    };
    for (const record of records) {
        const harness = record.source;
        const recordTokens = record.input + record.output + record.cacheRead + record.cacheWrite;
        tokens.input += record.input;
        tokens.output += record.output;
        tokens.cacheRead += record.cacheRead;
        tokens.cacheWrite += record.cacheWrite;
        tokens.total += recordTokens;
        const price = recordPrice(record);
        const model = canonicalModel(record.model);
        for (const row of [
            harnessRows.get(harness) ?? harnessRows.set(harness, emptyRow()).get(harness),
            modelRows.get(model) ?? modelRows.set(model, emptyRow()).get(model)
        ]) {
            row.tokens += recordTokens;
            row.requests += 1;
            if (price.pico === undefined)
                row.unpricedRequests += 1;
            else
                row.pico += price.pico;
        }
        if (price.pico === undefined) {
            cost.unpricedRequests += 1;
            cost.unpricedTokens += recordTokens;
        }
        else {
            cost.pico += price.pico;
            if (price.via === 'list')
                cost.listRequests += 1;
            else
                cost.recordedRequests += 1;
        }
        const session = `${harness}:${record.sessionId}`;
        touch(session, record.startedAt ?? record.at);
        if (record.startedAt !== undefined)
            touch(session, record.at);
        if (options.projects && record.cwd) {
            const name = basename(record.cwd.replace(/[\\/]+$/, ''));
            if (name)
                projects.set(name, (projects.get(name) ?? 0) + 1);
        }
    }
    // Counters, period-filtered.
    const harnessIds = Object.keys(scan.collected);
    const prompts = [];
    let replies = 0;
    const toolCounts = new Map();
    let toolCalls = 0;
    const edited = new Set();
    const fun = {
        absolutelyRight: 0,
        perfect: 0,
        interrupts: 0,
        rage: 0,
        nightOwl: 0,
        longestStreakDays: 0,
        longestSessionMs: 0
    };
    for (const harness of harnessIds) {
        const c = scan.collected[harness];
        for (const prompt of c.prompts) {
            if (!inPeriod(period, prompt.at))
                continue;
            prompts.push(prompt);
            if (prompt.session)
                touch(`${harness}:${prompt.session}`, prompt.at);
            else {
                activeDays.add(localDate(prompt.at));
                firstAt = firstAt === undefined ? prompt.at : Math.min(firstAt, prompt.at);
                lastAt = lastAt === undefined ? prompt.at : Math.max(lastAt, prompt.at);
            }
        }
        replies += c.replies.filter((at) => inPeriod(period, at)).length;
        for (const tool of c.tools) {
            if (!inPeriod(period, tool.at))
                continue;
            toolCalls++;
            toolCounts.set(tool.name, (toolCounts.get(tool.name) ?? 0) + 1);
        }
        for (const edit of c.edits)
            if (inPeriod(period, edit.at))
                edited.add(`${harness}:${edit.file}`);
        fun.interrupts += c.interrupts.filter((at) => inPeriod(period, at)).length;
        fun.absolutelyRight += c.absolutelyRight.filter((at) => inPeriod(period, at)).length;
        fun.perfect += c.perfect.filter((at) => inPeriod(period, at)).length;
    }
    const byDay = new Map();
    const byHour = new Array(24).fill(0);
    for (const prompt of prompts) {
        if (prompt.rage)
            fun.rage++;
        const hour = new Date(prompt.at).getHours();
        if (hour < 5)
            fun.nightOwl++;
        byHour[hour]++;
        const day = localDate(prompt.at);
        byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    for (const [date, count] of byDay) {
        if (!fun.busiestDay || count > fun.busiestDay.prompts || (count === fun.busiestDay.prompts && date < fun.busiestDay.date)) {
            fun.busiestDay = { date, prompts: count };
        }
    }
    byHour.forEach((count, hour) => {
        if (count > 0 && (!fun.peakHour || count > fun.peakHour.prompts))
            fun.peakHour = { hour, prompts: count };
    });
    fun.longestStreakDays = longestStreak(activeDays);
    fun.longestSessionMs = longestSession(sessionTimes);
    const harnesses = [...harnessRows.entries()]
        .map(([harness, row]) => ({ harness, label: HARNESS_LABEL[harness] ?? harness, ...row }))
        .sort((a, b) => (b.pico > a.pico ? 1 : b.pico < a.pico ? -1 : b.tokens - a.tokens));
    const models = [...modelRows.entries()]
        .map(([model, row]) => ({ model, ...row }))
        .sort((a, b) => (b.pico > a.pico ? 1 : b.pico < a.pico ? -1 : b.tokens - a.tokens));
    const topTools = [...toolCounts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
    const cashier = models.find((row) => row.model !== 'unknown')?.model;
    const stats = {
        demo: Boolean(options.demo),
        generatedAt: options.now,
        period,
        firstAt,
        lastAt,
        receiptNo: '',
        cashier,
        sessions: sessions.size,
        prompts: prompts.length,
        replies,
        toolCalls,
        topTools,
        filesEdited: edited.size,
        requests: records.length,
        tokens,
        harnesses,
        models,
        cost: { ...cost, priceTable: PRICE_TABLE_VERSION },
        fun,
        found: scan.sources.filter((source) => source.found).map((source) => source.harness),
        notes: scan.sources.map((source) => source.note).filter((note) => Boolean(note))
    };
    if (options.plan && firstAt !== undefined && lastAt !== undefined) {
        stats.plan = planMath(options.plan, cost.pico, firstAt, lastAt, options.period.planLength);
    }
    if (options.projects) {
        stats.projects = [...projects.entries()]
            .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
            .slice(0, 3)
            .map(([name]) => name);
    }
    stats.receiptNo = receiptNumber(stats);
    return stats;
}
/** A stable receipt number from the numbers on it. */
export function receiptNumber(stats) {
    const digest = createHash('sha256')
        .update(JSON.stringify([
        stats.period.label,
        stats.requests,
        stats.tokens,
        stats.cost.pico.toString(),
        stats.prompts,
        stats.sessions,
        stats.firstAt ?? 0
    ]))
        .digest();
    const n = digest.readUInt32BE(0) % 100_000_000;
    const text = String(n).padStart(8, '0');
    return `${text.slice(0, 4)}-${text.slice(4)}`;
}
/** JSON-safe stats (bigints as decimal strings of picodollars, plus dollars). */
export function statsToJson(stats) {
    return JSON.parse(JSON.stringify(stats, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)));
}

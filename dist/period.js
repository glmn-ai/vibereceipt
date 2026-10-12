// The receipt's period: [from, to) in epoch ms, local time.
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const startOfDay = (ms) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};
export class PeriodError extends Error {
}
/**
 * `--since` value → period ending now. Accepts `30d`, `2w`, `6m` (calendar
 * months), `1y`, or a date `YYYY-MM-DD` (local midnight).
 */
export function parseSince(value, now) {
    const text = value.trim().toLowerCase();
    const relative = /^(\d{1,4})\s*([dwmy])$/.exec(text);
    if (relative) {
        const count = Number(relative[1]);
        if (count < 1)
            throw new PeriodError(`--since needs a positive amount, got "${value}"`);
        const unit = relative[2];
        const today = startOfDay(now);
        let from;
        if (unit === 'd')
            from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (count - 1));
        else if (unit === 'w')
            from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (count * 7 - 1));
        else if (unit === 'm')
            from = new Date(today.getFullYear(), today.getMonth() - count, today.getDate() + 1);
        else
            from = new Date(today.getFullYear() - count, today.getMonth(), today.getDate() + 1);
        const word = { d: 'DAY', w: 'WEEK', m: 'MONTH', y: 'YEAR' }[unit];
        return { from: from.getTime(), to: now + 1, label: `LAST ${count} ${word}${count === 1 ? '' : 'S'}` };
    }
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (date) {
        const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
        const from = new Date(y, m - 1, d);
        if (from.getFullYear() !== y || from.getMonth() !== m - 1 || from.getDate() !== d) {
            throw new PeriodError(`--since: "${value}" is not a real date`);
        }
        if (from.getTime() > now)
            throw new PeriodError(`--since: ${value} is in the future`);
        return { from: from.getTime(), to: now + 1, label: `SINCE ${date[1]}-${date[2]}-${date[3]}` };
    }
    throw new PeriodError(`--since: use 30d, 7d, 4w, 6m, 1y or a date like 2026-09-01 (got "${value}")`);
}
export function thisMonth(now) {
    const d = new Date(now);
    const from = new Date(d.getFullYear(), d.getMonth(), 1);
    return { from: from.getTime(), to: now + 1, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` };
}
export function thisYear(now) {
    const d = new Date(now);
    return { from: new Date(d.getFullYear(), 0, 1).getTime(), to: now + 1, label: `YEAR ${d.getFullYear()}` };
}
export const allTime = (now) => ({ to: now + 1, label: 'ALL TIME' });
export const inPeriod = (period, at) => at < period.to && (period.from === undefined || at >= period.from);
export const monthName = (index) => MONTHS[index];

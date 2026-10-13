// `--plan`: what your subscription cost over the period, next to what the
// same tokens would have cost at API list prices.
//
// A fixed-length period is charged for its length: `--since 30d` is one
// 30-day month of subscription, `--since 7d` is 7/30 of one, `--since 6m` is
// six. All time and `--year` are counted per calendar month touched: from the
// month of your first request to the month of your last, inclusive, which is
// how monthly billing works. The receipt prints which one it used.
import { monthName } from './period.js';
import { PICO_PER_DOLLAR } from './vendor/neurosquad-core/money.js';
export const PLAN_PRESETS = {
    pro: { label: 'Claude Pro', monthlyCents: 2000 },
    max5: { label: 'Claude Max 5x', monthlyCents: 10000 },
    max20: { label: 'Claude Max 20x', monthlyCents: 20000 },
    'chatgpt-plus': { label: 'ChatGPT Plus', monthlyCents: 2000 },
    'chatgpt-pro': { label: 'ChatGPT Pro', monthlyCents: 20000 }
};
export class PlanError extends Error {
}
export function parsePlan(value) {
    const key = value.trim().toLowerCase();
    const preset = PLAN_PRESETS[key];
    if (preset)
        return preset;
    const money = /^\$?(\d{1,6})(?:\.(\d{1,2}))?$/.exec(key);
    if (money) {
        const cents = Number(money[1]) * 100 + Number((money[2] ?? '').padEnd(2, '0') || 0);
        if (cents <= 0)
            throw new PlanError('--plan: the monthly price must be more than $0');
        return { label: `$${formatCents(cents)}/mo plan`, monthlyCents: cents };
    }
    throw new PlanError(`--plan: use one of ${Object.keys(PLAN_PRESETS).join(', ')} or a monthly price like 100 or $49.99 (got "${value}")`);
}
export function formatCents(cents) {
    const whole = Math.floor(cents / 100);
    const rest = cents % 100;
    const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return rest === 0 ? grouped : `${grouped}.${String(rest).padStart(2, '0')}`;
}
/** Calendar months from `firstAt`'s month to `lastAt`'s month, inclusive (local time). */
export function monthsTouched(firstAt, lastAt) {
    const a = new Date(Math.min(firstAt, lastAt));
    const b = new Date(Math.max(firstAt, lastAt));
    return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + 1;
}
const titleMonth = (index) => {
    const name = monthName(index);
    return name[0] + name.slice(1).toLowerCase();
};
export function monthsLabel(firstAt, lastAt) {
    const a = new Date(Math.min(firstAt, lastAt));
    const b = new Date(Math.max(firstAt, lastAt));
    const sameMonth = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
    if (sameMonth)
        return `${titleMonth(a.getMonth())} ${a.getFullYear()}`;
    if (a.getFullYear() === b.getFullYear()) {
        return `${titleMonth(a.getMonth())}-${titleMonth(b.getMonth())} ${a.getFullYear()}`;
    }
    return `${titleMonth(a.getMonth())} ${a.getFullYear()}-${titleMonth(b.getMonth())} ${b.getFullYear()}`;
}
/** Days in the month a `--since 30d`-style period is charged against. */
export const PLAN_MONTH_DAYS = 30;
const trimDecimals = (n) => String(Math.round(n * 100) / 100);
export function planMath(plan, listPico, firstAt, lastAt, length) {
    // cents → picodollars: 1 cent = 1e10 pico.
    const centPico = PICO_PER_DOLLAR / 100n;
    const price = `$${formatCents(plan.monthlyCents)}`;
    let months;
    let subscriptionPico;
    let detail;
    if (length && 'days' in length) {
        months = length.days / PLAN_MONTH_DAYS;
        subscriptionPico = (BigInt(plan.monthlyCents) * centPico * BigInt(length.days)) / BigInt(PLAN_MONTH_DAYS);
        const share = length.days % PLAN_MONTH_DAYS === 0 ? `${length.days / PLAN_MONTH_DAYS}` : `${length.days}/${PLAN_MONTH_DAYS}`;
        detail = `${length.days} days = ${share} mo x ${price}`;
    }
    else if (length) {
        months = length.months;
        subscriptionPico = BigInt(plan.monthlyCents) * BigInt(months) * centPico;
        detail = `${months} mo x ${price}`;
    }
    else {
        months = monthsTouched(firstAt, lastAt);
        subscriptionPico = BigInt(plan.monthlyCents) * BigInt(months) * centPico;
        detail = `${months} mo x ${price} (${monthsLabel(firstAt, lastAt)})`;
    }
    return {
        plan,
        months: Number(trimDecimals(months)),
        detail,
        monthsLabel: monthsLabel(firstAt, lastAt),
        subscriptionPico,
        deltaPico: listPico - subscriptionPico
    };
}

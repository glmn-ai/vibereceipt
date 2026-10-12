// Number formatting for the receipt. Abbreviations round to 3 significant
// digits; `--json` carries every exact value.
import { formatUsd } from './vendor/neurosquad-core/money.js';
export const usd = (pico) => formatUsd(pico);
export function count(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
/** 1,234 → "1,234"; 12,345 → "12.3K"; 1.5e9 → "1.50B". */
export function tokens(n) {
    if (n < 10_000)
        return count(n);
    const units = [
        [1e12, 'T'],
        [1e9, 'B'],
        [1e6, 'M'],
        [1e3, 'K']
    ];
    const fmt = (value) => value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2);
    for (let i = 0; i < units.length; i++) {
        const [size, suffix] = units[i];
        if (n < size)
            continue;
        const text = fmt(n / size);
        // 999,950 rounds to "1000K": that is "1.00M".
        if (Number(text) >= 1000 && i > 0)
            return `${fmt(n / units[i - 1][0])}${units[i - 1][1]}`;
        return `${text}${suffix}`;
    }
    return count(n);
}
export function duration(ms) {
    const minutes = Math.round(ms / 60_000);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0)
        return `${m}M`;
    return `${h}H ${String(m).padStart(2, '0')}M`;
}
export const pad2 = (n) => String(n).padStart(2, '0');

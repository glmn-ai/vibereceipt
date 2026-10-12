// Vendored from @neurosquad/core (MIT) — https://github.com/glmn-ai/neurosquad-cli
// Source: packages/core/src/usage/pricing.ts at commit 1bc586c20593df20c4c5f9b8489226d06f617a7a
// Copyright (c) 2026 Stanislav Gelman and NeuroSquad contributors. MIT License (see LICENSE-neurosquad-core).
// LOCAL DIVERGENCE (vibereceipt, 2026-10-12): this file is NOT byte-identical
// to upstream. Added claude-sonnet-5-5 and claude-haiku-5-5 (two prompt-size
// tiers) from the Anthropic pricing page fetched 2026-10-12, and bumped
// PRICE_TABLE_VERSION to 2026-10-12. Send the same change upstream and drop
// this note on the next re-vendor. Every other vendored file is an unedited copy.
export const PRICE_TABLE_VERSION = '2026-10-12';
export const PRICE_SOURCES = [
    'https://platform.claude.com/docs/en/about-claude/pricing',
    'https://developers.openai.com/api/docs/pricing'
];
/** $10 per 1,000 searches = $0.01 each, in picodollars. */
export const WEB_SEARCH_PICO = 10000000000n;
const M = (dollars) => Math.round(dollars * 1_000_000);
/** Anthropic rows are all "input, 5m write = 1.25x, 1h write = 2x, read, output" straight off the table. */
function claude(model, input, write5m, write1h, read, output, extra = {}) {
    return {
        vendor: 'anthropic',
        model,
        standard: {
            input: M(input),
            cacheWrite5m: M(write5m),
            cacheWrite1h: M(write1h),
            cacheRead: M(read),
            output: M(output)
        },
        ...extra
    };
}
function openai(model, rates, long) {
    const toRates = (r) => ({
        input: M(r.input),
        cacheRead: r.cached === undefined ? undefined : M(r.cached),
        cacheWrite5m: r.write === undefined ? undefined : M(r.write),
        output: M(r.output)
    });
    return {
        vendor: 'openai',
        model,
        standard: toRates(rates),
        longContext: long ? { aboveInputTokens: 272_000, rates: toRates(long) } : undefined
    };
}
/** Fast mode: the table's input/output, with the standard cache multipliers applied on top. */
function fastRates(input, output, readMultiplier) {
    return {
        input: M(input),
        output: M(output),
        cacheWrite5m: M(input * 1.25),
        cacheWrite1h: M(input * 2),
        cacheRead: M(input * readMultiplier)
    };
}
const US = { usGeoMultiplier: true };
export const MODEL_PRICES = [
    // ---- Anthropic -----------------------------------------------------------
    claude('claude-fable-5-1', 10, 12.5, 20, 0.25, 50, US),
    claude('claude-mythos-5-1', 10, 12.5, 20, 0.25, 50, US),
    claude('claude-fable-5', 10, 12.5, 20, 1, 50, US),
    claude('claude-mythos-5', 10, 12.5, 20, 1, 50, US),
    claude('claude-opus-5-5', 4, 5, 8, 0.2, 20, { ...US, fast: fastRates(8, 40, 0.05) }),
    claude('claude-opus-5', 5, 6.25, 10, 0.5, 25, { ...US, fast: fastRates(10, 50, 0.1) }),
    claude('claude-opus-4-8', 5, 6.25, 10, 0.5, 25, { ...US, fast: fastRates(10, 50, 0.1) }),
    claude('claude-opus-4-7', 5, 6.25, 10, 0.5, 25, US),
    claude('claude-opus-4-6', 5, 6.25, 10, 0.5, 25, US),
    claude('claude-opus-4-5', 5, 6.25, 10, 0.5, 25),
    claude('claude-opus-4-1', 15, 18.75, 30, 1.5, 75),
    claude('claude-opus-4', 15, 18.75, 30, 1.5, 75),
    claude('claude-sonnet-5-5', 2, 2.5, 4, 0.1, 10, US),
    claude('claude-sonnet-5', 2, 2.5, 4, 0.2, 10, US),
    claude('claude-sonnet-4-6', 3, 3.75, 6, 0.3, 15, US),
    claude('claude-sonnet-4-5', 3, 3.75, 6, 0.3, 15),
    claude('claude-sonnet-4', 3, 3.75, 6, 0.3, 15),
    // "Over 100,000" is strictly more: `longContext` compares with `>`.
    claude('claude-haiku-5-5', 0.1, 0.125, 0.2, 0.01, 0.5, {
        ...US,
        longContext: {
            aboveInputTokens: 100_000,
            rates: {
                input: M(0.5),
                cacheWrite5m: M(0.625),
                cacheWrite1h: M(1),
                cacheRead: M(0.05),
                output: M(2.5)
            }
        }
    }),
    claude('claude-haiku-4-5', 1, 1.25, 2, 0.1, 5),
    claude('claude-haiku-3-5', 0.8, 1, 1.6, 0.08, 4),
    // ---- OpenAI (standard tier) ---------------------------------------------
    openai('gpt-5.6-sol', { input: 4, cached: 0.4, write: 5, output: 20 }, { input: 8, cached: 0.8, write: 10, output: 30 }),
    openai('gpt-5.6-terra', { input: 2, cached: 0.2, write: 2.5, output: 12 }, { input: 4, cached: 0.4, write: 5, output: 18 }),
    openai('gpt-5.6-luna', { input: 0.2, cached: 0.02, write: 0.25, output: 1.2 }, { input: 0.4, cached: 0.04, write: 0.5, output: 1.8 }),
    openai('gpt-5.5', { input: 5, cached: 0.5, output: 30 }, { input: 10, cached: 1, output: 45 }),
    openai('gpt-5.5-pro', { input: 30, output: 180 }, { input: 60, output: 270 }),
    openai('gpt-5.4', { input: 2.5, cached: 0.25, output: 15 }, { input: 5, cached: 0.5, output: 22.5 }),
    openai('gpt-5.4-mini', { input: 0.75, cached: 0.075, output: 4.5 }),
    openai('gpt-5.4-nano', { input: 0.2, cached: 0.02, output: 1.25 }),
    openai('gpt-5.4-pro', { input: 30, output: 180 }, { input: 60, output: 270 }),
    openai('gpt-5.3-codex', { input: 1.75, cached: 0.175, output: 14 }),
    openai('gpt-5.2', { input: 1.75, cached: 0.175, output: 14 }),
    openai('gpt-5.2-pro', { input: 21, output: 168 }),
    openai('gpt-5.1', { input: 1.25, cached: 0.125, output: 10 }),
    openai('gpt-5', { input: 1.25, cached: 0.125, output: 10 }),
    openai('gpt-5-mini', { input: 0.25, cached: 0.025, output: 2 }),
    openai('gpt-5-nano', { input: 0.05, cached: 0.005, output: 0.4 }),
    openai('gpt-5-pro', { input: 15, output: 120 })
];
const BY_MODEL = new Map(MODEL_PRICES.map((price) => [price.model, price]));
/** Old-style ids that name the same model as a table row. */
const ALIASES = {
    'claude-3-5-haiku': 'claude-haiku-3-5',
    'claude-opus-4-0': 'claude-opus-4',
    'claude-sonnet-4-0': 'claude-sonnet-4'
};
/**
 * A model id as harnesses write it → the table's id. Strips a vendor prefix
 * (`anthropic/…`, `openai/…`), Claude Code's `[1m]` context tag and a dated
 * snapshot suffix (`-20250929`, `-2025-08-07`) — a snapshot is billed as its
 * model. Anything else is left alone: an unknown id must stay unknown, not
 * be guessed onto a neighbour's price.
 */
export function canonicalModel(model) {
    let id = model.trim().toLowerCase();
    id = id.replace(/^(anthropic|openai)[/.]/, '');
    id = id.replace(/\[[^\]]*\]$/, '');
    id = id.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
    return ALIASES[id] ?? id;
}
/** Vendors whose list price is meaningful for a record's provider. */
const PROVIDER_VENDOR = {
    anthropic: 'anthropic',
    openai: 'openai'
};
/**
 * The list price for a model, when the record went to that model's own
 * vendor. A provider we do not know the billing of (a local LM Studio, a
 * reseller) yields `undefined` rather than the vendor's price.
 */
export function priceFor(model, provider) {
    const price = BY_MODEL.get(canonicalModel(model));
    if (!price)
        return undefined;
    if (provider !== undefined) {
        const vendor = PROVIDER_VENDOR[provider.toLowerCase()];
        if (vendor !== price.vendor)
            return undefined;
    }
    return price;
}
/**
 * A record's cost at list price, exact, in picodollars.
 *
 * Every token kind is billed separately at its own rate: uncached input,
 * cache reads, 5-minute and 1-hour cache writes, output (which already
 * contains reasoning — never billed twice), plus Anthropic web searches.
 * A kind the vendor publishes no rate for, used with a non-zero count, makes
 * the whole record unpriced rather than silently free.
 */
export function listCost(record, openRouter) {
    if (record.provider.toLowerCase() === 'openrouter') {
        // OpenRouter's own per-model price (fetched from its public catalogue,
        // supplied by the caller) — never the vendor's direct price, and
        // never a guess when the catalogue has no such model or rate.
        const rates = openRouter?.(record);
        if (!rates)
            return { reason: 'unknown-model' };
        if (record.webSearches > 0)
            return { reason: 'unpublished-rate' };
        return costAtRates(record, rates);
    }
    const price = priceFor(record.model, record.provider);
    if (!price)
        return { reason: 'unknown-model' };
    let rates = price.standard;
    if (record.speed === 'fast') {
        if (!price.fast)
            return { reason: 'unpublished-rate' };
        rates = price.fast;
    }
    else if (price.longContext &&
        record.input + record.cacheRead + record.cacheWrite > price.longContext.aboveInputTokens) {
        rates = price.longContext.rates;
    }
    const base = costAtRates(record, rates);
    if (base.pico === undefined)
        return base;
    let pico = base.pico;
    if (record.geo === 'us' && price.usGeoMultiplier) {
        // 1.1x on every token category. Applied to the exact integer total; the
        // division by 10 is exact whenever the rates are multiples of 10 µ$,
        // which every published rate is — asserted in the tests.
        pico = (pico * 11n) / 10n;
    }
    if (record.webSearches > 0 && price.vendor === 'anthropic') {
        pico += BigInt(record.webSearches) * WEB_SEARCH_PICO;
    }
    return { pico };
}
/** Tokens × rates, exact; a used token kind without a rate → unpriced. */
function costAtRates(record, rates) {
    const write1h = record.cacheWrite1h;
    const write5m = record.cacheWrite - write1h;
    const parts = [
        [record.input, rates.input],
        [record.output, rates.output],
        [record.cacheRead, rates.cacheRead],
        [write5m, rates.cacheWrite5m],
        [write1h, rates.cacheWrite1h]
    ];
    let pico = 0n;
    for (const [tokens, rate] of parts) {
        if (tokens === 0)
            continue;
        if (rate === undefined || !Number.isSafeInteger(rate) || rate < 0) {
            return { reason: 'unpublished-rate' };
        }
        pico += BigInt(tokens) * BigInt(rate);
    }
    return { pico };
}

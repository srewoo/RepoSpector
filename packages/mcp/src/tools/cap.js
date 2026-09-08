/**
 * Response size limits for tool output.
 *
 * A tool result lands directly in the client's context window and the client
 * cannot undo it, so a helpful `search_code` that returns forty whole files
 * poisons the conversation it was meant to inform. Every tool caps its output,
 * truncates at a boundary that cannot be mistaken for whole content, and states
 * what it dropped so the caller can decide to re-query. Silent truncation is
 * worse than a smaller answer: it makes the caller reason confidently from a
 * partial picture.
 */

/** Four characters per token — the standard approximation. */
export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / 4);
}

function tokensToChars(tokens) {
    return Math.max(0, tokens) * 4;
}

/**
 * Truncate at a line boundary.
 *
 * @returns {{text: string, truncated: boolean, note: string}}
 */
export function capText(text, maxTokens) {
    const body = String(text ?? '');
    if (estimateTokens(body) <= maxTokens) {
        return { text: body, truncated: false, note: '' };
    }

    const budget = tokensToChars(maxTokens);
    const lines = body.split('\n');
    const kept = [];
    let used = 0;
    for (const line of lines) {
        if (used + line.length + 1 > budget) break;
        kept.push(line);
        used += line.length + 1;
    }
    // Always keep at least one line, even an over-long one: an empty result
    // would be indistinguishable from "no match".
    if (kept.length === 0 && lines.length > 0) kept.push(lines[0]);

    const dropped = lines.length - kept.length;
    return {
        text: kept.join('\n'),
        truncated: true,
        note: `truncated at the token limit — ${dropped} of ${lines.length} lines not shown; `
            + 'narrow the query or raise --max-tool-tokens',
    };
}

/**
 * Render as many whole items as fit.
 *
 * Whole items only: half a search result is not a search result.
 *
 * @param {Array} items
 * @param {(item: any, index: number) => string} renderFn
 * @param {number} maxTokens
 * @returns {{text: string, shown: number, total: number, truncated: boolean}}
 */
export function capList(items, renderFn, maxTokens) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
        return { text: 'No results.', shown: 0, total: 0, truncated: false };
    }

    const budget = tokensToChars(maxTokens);
    const parts = [];
    let used = 0;
    for (let i = 0; i < list.length; i += 1) {
        const rendered = renderFn(list[i], i);
        if (used + rendered.length > budget && parts.length > 0) break;
        parts.push(rendered);
        used += rendered.length;
    }

    const truncated = parts.length < list.length;
    const header = truncated
        ? `Showing ${parts.length} of ${list.length} results (token limit) — `
            + 'narrow the query or raise --max-tool-tokens.\n\n'
        : '';

    return {
        text: header + parts.join('\n\n'),
        shown: parts.length,
        total: list.length,
        truncated,
    };
}

/**
 * Split a token budget across sections so no single one starves the rest.
 *
 * The review bundle used to be joined and capped once, in order. A large diff
 * meant `hunks` consumed the entire budget and every section after it —
 * graph_context, covering_tests, static_analysis — vanished from the output,
 * which reads as "those checks found nothing" rather than "those checks were
 * cut". On this repo's own HEAD~1..HEAD an 8-section bundle came back with 3.
 *
 * Water-filling: everything that fits in an equal share gets exactly what it
 * asked for, and whatever it leaves unused is redistributed to the sections
 * still over the line. Small sections are never truncated to make room for a
 * large one, and a large one is capped rather than dropped.
 *
 * ## Floors
 *
 * Equal shares are the right default for sections of equal standing, and wrong
 * when one section IS the evidence. `hunks` received the same 1/8 as seven
 * summaries, and on a 22-file review that left room for one window — of a
 * prose file. A floor reserves a share up front (never more than the section
 * actually wants) and the remainder water-fills as before, so a floor cannot
 * starve the other sections to zero.
 *
 * @param {number[]} desired Tokens each section would use uncapped.
 * @param {number} total Tokens available across all of them.
 * @param {{floors?: number[]}} [opts] Per-section minimum grants.
 * @returns {number[]} Tokens granted per section, aligned with `desired`.
 */
export function allocateTokens(desired, total, opts = {}) {
    const n = desired.length;
    const granted = new Array(n).fill(0);
    if (n === 0 || !(total > 0)) return granted;

    const floors = Array.isArray(opts.floors) ? opts.floors : null;
    if (floors) {
        // Reserve the floors, then water-fill the remainder over what is left
        // of each section's appetite. Reserving more than `total` is not
        // possible: the floors are scaled down together if they would.
        const reserved = desired.map((d, i) => Math.max(0, Math.min(d, floors[i] || 0)));
        const reservedTotal = reserved.reduce((a, b) => a + b, 0);
        // Leave at least a quarter of the budget for everything else, so a
        // large floor cannot silently delete the other sections.
        const cap = Math.floor(total * 0.75);
        const scale = reservedTotal > cap && reservedTotal > 0 ? cap / reservedTotal : 1;
        const floorGrant = reserved.map((r) => Math.floor(r * scale));
        const spent = floorGrant.reduce((a, b) => a + b, 0);

        const rest = allocateTokens(
            desired.map((d, i) => Math.max(0, d - floorGrant[i])),
            total - spent,
        );
        return floorGrant.map((f, i) => f + rest[i]);
    }

    let remaining = total;
    let open = desired.map((_, i) => i);

    while (open.length > 0) {
        const fair = Math.floor(remaining / open.length);
        if (fair <= 0) break; // Budget exhausted; the rest get nothing.

        const fits = open.filter((i) => desired[i] <= fair);
        if (fits.length === 0) {
            // Everyone still open wants more than an equal share: split evenly.
            for (const i of open) granted[i] = fair;
            break;
        }
        for (const i of fits) {
            granted[i] = desired[i];
            remaining -= desired[i];
        }
        open = open.filter((i) => desired[i] > fair);
    }

    return granted;
}

/**
 * Render an object whose bulk is one or more lists, shedding list tails until
 * it fits — never slicing the JSON mid-structure.
 *
 * The third instance of one bug. `static_analysis` overran and `capText` cut it
 * at a line boundary: 8494 of 9995 lines gone and the remainder unparseable.
 * `graph_context` then did the same once its symbol cap scaled with the budget.
 * Both have the same shape — a small head of facts that must always survive,
 * plus long lists — so shedding is expressible once here rather than bespoke
 * per section.
 *
 * Lists shed from the LAST one first: they are given in priority order, so a
 * section can keep `removed` while dropping `symbols`, or keep deleted test
 * files while dropping repo-wide background.
 *
 * @param {object} head Fields that always survive.
 * @param {Array<{key: string, items: Array}>} lists In priority order.
 * @param {number} maxTokens
 */
export function renderJsonSection(head, lists = [], maxTokens) {
    const kept = lists.map((l) => (Array.isArray(l.items) ? l.items.length : 0));

    const build = () => {
        const out = { ...head };
        lists.forEach((list, i) => {
            const items = Array.isArray(list.items) ? list.items : [];
            out[list.key] = items.slice(0, kept[i]);
            const dropped = items.length - kept[i];
            if (dropped > 0) {
                out[`${list.key}Note`] = `${dropped} of ${items.length} not shown, to fit the `
                    + 'token limit — raise --max-tool-tokens for all of them';
            }
        });
        return JSON.stringify(out, null, 2);
    };

    let text = build();
    // Halve the longest remaining list, last-first, until it fits. The head is
    // never touched: a section that cannot state its own basis is worse than a
    // short one.
    for (let guard = 0; guard < 200 && estimateTokens(text) > maxTokens; guard += 1) {
        let target = -1;
        for (let i = kept.length - 1; i >= 0; i -= 1) {
            if (kept[i] > 0) { target = i; break; }
        }
        if (target < 0) break;
        kept[target] = Math.floor(kept[target] / 2);
        text = build();
    }
    return text;
}

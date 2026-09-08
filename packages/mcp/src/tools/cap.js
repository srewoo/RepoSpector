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
 * @param {number[]} desired Tokens each section would use uncapped.
 * @param {number} total Tokens available across all of them.
 * @returns {number[]} Tokens granted per section, aligned with `desired`.
 */
export function allocateTokens(desired, total) {
    const n = desired.length;
    const granted = new Array(n).fill(0);
    if (n === 0 || !(total > 0)) return granted;

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

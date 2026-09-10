/**
 * callSiteCheck — does this call site actually break under the new signature?
 * P1-3.
 *
 * `GraphImpactFindingsService._signatureRule` asserted, in the reviewer's own
 * voice and at severity `high`, that every caller outside the PR "still passes
 * the old argument list". It never looked at a single call expression. The
 * inputs were a signature diff and a set of graph edges, and `CallGraphBuilder`
 * resolves some of those edges by name — so an unrelated same-named symbol, a
 * stale index, or a call that was already passing the new argument list all
 * produced the same confident assertion of breakage.
 *
 * An unchanged caller FILE is not proof that its invocation became invalid.
 * This module is the difference between the two: given the caller's source, it
 * reads the actual call expression and reports what it found — including, and
 * this is the important case, that it could not tell.
 */

/** What we were able to establish about one call site. */
export const CALL_SITE = Object.freeze({
    /** The call passes an argument list the new signature cannot accept. */
    INCOMPATIBLE: 'incompatible',
    /** The call is already valid under the new signature. */
    COMPATIBLE: 'compatible',
    /** A call expression was found but its arguments cannot be counted. */
    DYNAMIC: 'dynamic',
    /** No call to this symbol was found at the recorded location. */
    NOT_FOUND: 'not-found',
    /** No source was available to look at. */
    UNKNOWN: 'unknown',
});

/**
 * Count the arguments of the first call to `symbol` at or after `line`.
 *
 * Deliberately a balanced scan rather than a regex: `f(g(a, b), c)` has two
 * arguments and a regex counting commas says three. Strings and template
 * literals are skipped for the same reason.
 *
 * @returns {{count: number, text: string, spread: boolean}|null}
 */
export function callArgumentsAt(source, symbol, line) {
    if (typeof source !== 'string' || !symbol) return null;
    const lines = source.split('\n');
    const start = Number.isFinite(Number(line)) ? Math.max(0, Number(line) - 1) : 0;

    // The recorded line can be off by a little (formatters, stale index), so a
    // small window is searched rather than the exact line only. Wider than this
    // and we would be finding a different call.
    for (let i = start; i < Math.min(lines.length, start + 3); i++) {
        const found = scanCall(lines.slice(i, i + 20).join('\n'), symbol);
        if (found) return found;
    }
    return null;
}

const IDENT_TAIL = /[A-Za-z0-9_$]/;

function scanCall(text, symbol) {
    let idx = -1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        idx = text.indexOf(symbol, idx + 1);
        if (idx === -1) return null;

        const before = text[idx - 1];
        const after = text[idx + symbol.length];
        // Whole-identifier match only: `getUser` must not match `resetGetUser`.
        if (before && IDENT_TAIL.test(before)) continue;
        if (after && IDENT_TAIL.test(after)) continue;

        let j = idx + symbol.length;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] !== '(') continue;

        const args = readArgs(text, j);
        if (args) return args;
    }
}

/** Read a balanced argument list starting at the `(` at `open`. */
function readArgs(text, open) {
    let depth = 0;
    let quote = null;
    let current = '';
    const parts = [];

    for (let i = open; i < text.length; i++) {
        const ch = text[i];

        if (quote) {
            if (ch === '\\') { current += ch + (text[++i] ?? ''); continue; }
            if (ch === quote) quote = null;
            current += ch;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; current += ch; continue; }

        if (ch === '(' || ch === '[' || ch === '{') {
            depth++;
            if (depth === 1) continue; // the opening paren itself
            current += ch;
            continue;
        }
        if (ch === ')' || ch === ']' || ch === '}') {
            depth--;
            if (depth === 0) {
                if (current.trim()) parts.push(current.trim());
                const text_ = `(${parts.join(', ')})`;
                return {
                    count: parts.length,
                    text: text_,
                    spread: parts.some((p) => p.startsWith('...')),
                };
            }
            current += ch;
            continue;
        }
        if (ch === ',' && depth === 1) {
            if (current.trim()) parts.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    return null; // unbalanced — the window cut the call in half
}

/** Parameters that must be supplied: not optional, not defaulted, not rest. */
function requiredCount(params = []) {
    return params.filter((p) => {
        const s = String(p ?? '');
        return !s.includes('=') && !s.trim().startsWith('...') && !s.trim().endsWith('?');
    }).length;
}

/**
 * Classify one call site against a signature change.
 *
 * @param {{before: string[], after: string[]}} change
 * @param {{filePath: string, line: number}} caller
 * @param {string} symbol
 * @param {string|null} source - the caller file's contents, or null
 * @returns {{status: string, reason: string, call: string|null}}
 */
export function checkCallSite(change, caller, symbol, source) {
    if (typeof source !== 'string' || !source) {
        return {
            status: CALL_SITE.UNKNOWN,
            reason: 'the caller\'s source was not available to this review',
            call: null,
        };
    }

    const call = callArgumentsAt(source, symbol, caller?.line);
    if (!call) {
        return {
            status: CALL_SITE.NOT_FOUND,
            reason: `no call to \`${symbol}\` was found at ${caller?.filePath}:${caller?.line ?? '?'} `
                + '(the graph edge may be name-resolved, stale, or point at a different symbol)',
            call: null,
        };
    }
    if (call.spread) {
        return {
            status: CALL_SITE.DYNAMIC,
            reason: 'the call spreads an array, so its argument count cannot be read statically',
            call: call.text,
        };
    }

    const after = change?.after ?? [];
    const requiredAfter = requiredCount(after);
    const maxAfter = after.some((p) => String(p).trim().startsWith('...'))
        ? Infinity
        : after.length;

    if (call.count >= requiredAfter && call.count <= maxAfter) {
        return {
            status: CALL_SITE.COMPATIBLE,
            reason: `the call passes ${call.count} argument(s), which the new signature accepts`,
            call: call.text,
        };
    }

    return {
        status: CALL_SITE.INCOMPATIBLE,
        reason: `the call passes ${call.count} argument(s); the new signature requires `
            + `${requiredAfter}${maxAfter === Infinity ? ' or more' : maxAfter === requiredAfter ? '' : `–${maxAfter}`}`,
        call: call.text,
    };
}

/**
 * Check every caller, and report what the set as a whole establishes.
 *
 * @returns {{incompatible: Array, compatible: Array, unverified: Array,
 *            verified: boolean}}
 */
export function checkCallers(change, callers = [], symbol, readSource) {
    const incompatible = [];
    const compatible = [];
    const unverified = [];

    for (const caller of callers) {
        let source = null;
        try {
            source = typeof readSource === 'function' ? readSource(caller.filePath) : null;
        } catch {
            source = null;
        }
        const result = { ...caller, ...checkCallSite(change, caller, symbol, source) };
        if (result.status === CALL_SITE.INCOMPATIBLE) incompatible.push(result);
        else if (result.status === CALL_SITE.COMPATIBLE) compatible.push(result);
        else unverified.push(result);
    }

    return {
        incompatible,
        compatible,
        unverified,
        // "Verified" means every caller was actually read. A partial check can
        // still prove a specific breakage; it cannot prove the absence of one.
        verified: unverified.length === 0,
    };
}

export default { CALL_SITE, callArgumentsAt, checkCallSite, checkCallers };

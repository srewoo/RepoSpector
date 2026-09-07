/**
 * signatureDiff — did this diff change a symbol's parameter list, and is the
 * change something existing callers survive?
 *
 * Pure text over the unified diff: the "-" and "+" declaration lines for one
 * symbol are compared parameter-by-parameter. Deliberately conservative about
 * "compatible": only appending defaulted/optional/rest parameters qualifies.
 * Anything else — removal, reorder, a new required parameter — is a change a
 * caller outside the diff can break on.
 */
import { declaresSymbol } from './declaredSymbols.js';

const PARAM_LIST = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)/;

/** Parameter names from a declaration line, or null when it has no list. */
export function extractParams(line) {
    if (!line) return null;
    const m = PARAM_LIST.exec(line);
    if (!m) return null;
    if (!m[1].trim()) return [];
    return m[1]
        .split(',')
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => p.replace(/\s*=.*$/, '').replace(/\s*:.*$/, '').replace(/\?$/, '').trim())
        .filter(Boolean);
}

/** The "-" and "+" lines in `patch` that declare `symbol`. */
export function declarationLinesFor(patch, symbol) {
    let removed = null;
    let added = null;
    for (const raw of (patch || '').split('\n')) {
        if (raw.startsWith('@@')) continue;
        if (raw.startsWith('-') && removed == null && declaresSymbol(raw.slice(1), symbol)) removed = raw.slice(1);
        else if (raw.startsWith('+') && added == null && declaresSymbol(raw.slice(1), symbol)) added = raw.slice(1);
        if (removed != null && added != null) break;
    }
    return { removed, added };
}

function isOptional(rawParamsLine, name) {
    // Look at the raw text for `name = ...`, `name?` or `...name`.
    const esc = name.replace(/^\.\.\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return name.startsWith('...')
        || new RegExp(`(^|[,(\\s])${esc}\\s*(\\?|=)`).test(rawParamsLine);
}

/** null when `symbol` is not declared on BOTH sides of the diff. */
export function signatureChange(patch, symbol) {
    const { removed, added } = declarationLinesFor(patch, symbol);
    if (removed == null || added == null) return null;
    const before = extractParams(removed);
    const after = extractParams(added);
    if (before == null || after == null) return null;

    const changed = before.join(',') !== after.join(',');
    if (!changed) return { changed: false, before, after, compatible: true };

    const prefixKept = before.every((p, i) => after[i] === p);
    const addedParams = after.slice(before.length);
    const compatible = prefixKept && addedParams.every(p => isOptional(added, p));
    return { changed: true, before, after, compatible };
}

export default { extractParams, declarationLinesFor, signatureChange };

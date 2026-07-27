/**
 * Finding de-duplication for the multi-finder pass.
 *
 * The specialist finders will inevitably re-surface some issues the baseline pass
 * (or each other) already reported. We keep only genuinely new findings.
 *
 * Two findings are "the same" when they sit on the same file within a few lines
 * AND describe the same thing (same type, or strongly overlapping title tokens).
 */

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'in', 'on', 'of', 'to', 'and', 'or', 'for', 'this', 'that', 'with', 'without', 'not', 'no']);

function normTitle(f) {
    return String(f.title || f.message || f.description || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w && !STOP.has(w));
}

function tokenOverlap(a, b) {
    if (!a.length || !b.length) return 0;
    const setB = new Set(b);
    const common = a.filter(w => setB.has(w)).length;
    return common / Math.min(a.length, b.length);
}

/**
 * A coarse key for exact-ish matches.
 * @param {Object} f
 * @returns {string}
 */
export function findingKey(f) {
    return `${f.file || ''}:${f.line ?? ''}:${String(f.type || '').toLowerCase()}`;
}

/**
 * Is `candidate` a duplicate of anything in `existing`?
 * @param {Array<Object>} existing
 * @param {Object} candidate
 * @param {Object} [opts] - { lineTolerance=3, titleOverlap=0.6 }
 * @returns {boolean}
 */
export function isDuplicate(existing, candidate, opts = {}) {
    const { lineTolerance = 3, titleOverlap = 0.6 } = opts;
    const cTokens = normTitle(candidate);
    for (const e of existing) {
        if ((e.file || '') !== (candidate.file || '')) continue;
        const eLine = e.line ?? null;
        const cLine = candidate.line ?? null;
        const lineClose = eLine == null || cLine == null
            ? true
            : Math.abs(eLine - cLine) <= lineTolerance;
        if (!lineClose) continue;
        const sameType = String(e.type || '').toLowerCase() === String(candidate.type || '').toLowerCase();
        const overlap = tokenOverlap(normTitle(e), cTokens);
        if (sameType || overlap >= titleOverlap) return true;
    }
    return false;
}

/**
 * Return only the candidates not already present in `existing` and not duplicated
 * among themselves.
 * @param {Array<Object>} existing
 * @param {Array<Object>} candidates
 * @param {Object} [opts]
 * @returns {Array<Object>}
 */
export function freshFindings(existing, candidates, opts = {}) {
    const kept = [];
    const running = [...existing];
    for (const c of candidates) {
        if (!isDuplicate(running, c, opts)) {
            kept.push(c);
            running.push(c);
        }
    }
    return kept;
}

export default { findingKey, isDuplicate, freshFindings };

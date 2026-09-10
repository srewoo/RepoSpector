/**
 * requiredEvidence — what a claim of this shape needs before it can be
 * believed. P1-6.
 *
 * Derived from the claim rather than configured, so a candidate that names its
 * consumer asks for that consumer and one that names a contract asks for the
 * contract. Split out of `HypothesisValidationService` because it is a pure
 * function of the finding and the service is about orchestration and budgets.
 */

import { toStructuredClaim, claimTextOf } from './findingClaim.js';

/**
 * What a claim of this shape needs before it can be believed.
 *
 * Derived from the claim rather than configured, so a candidate that names its
 * consumer asks for that consumer and one that names a contract asks for the
 * contract. The generic fallback — the enclosing function and its callers — is
 * what almost every cross-function claim actually turns on.
 */
export function requiredEvidenceFor(finding) {
    const structured = toStructuredClaim(finding);
    const claim = claimTextOf(finding).toLowerCase();
    const file = finding?.file ?? finding?.filePath ?? null;
    const wants = [];

    if (structured?.affectedConsumer) {
        wants.push({ kind: 'consumer', target: structured.affectedConsumer });
    }
    if (structured?.expectedContract) {
        wants.push({ kind: 'contract', target: structured.expectedContract });
    }

    if (/\bcaller|call site|breaks? the caller|no longer accepts?\b/.test(claim)) {
        wants.push({ kind: 'callers', target: finding?.symbol ?? finding?.rule ?? file });
    }
    if (/\bguard|check|validat|authoriz|permission\b/.test(claim)) {
        wants.push({ kind: 'enclosing-function', target: file, line: finding?.line ?? null });
    }
    if (/\btest|coverage\b/.test(claim)) {
        wants.push({ kind: 'tests', target: file });
    }
    if (/\bconfig|env|flag|setting\b/.test(claim)) {
        wants.push({ kind: 'configuration', target: file });
    }

    if (wants.length === 0 && file) {
        // The default is not "nothing": a claim about a line is a claim about
        // the function that contains it and about whoever calls that function.
        wants.push({ kind: 'enclosing-function', target: file, line: finding?.line ?? null });
        wants.push({ kind: 'callers', target: finding?.symbol ?? file });
    }

    // Dedupe by kind+target; the same evidence requested twice costs twice.
    const seen = new Set();
    return wants.filter((w) => {
        const key = `${w.kind}:${w.target}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}


export default { requiredEvidenceFor };

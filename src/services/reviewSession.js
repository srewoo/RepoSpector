/**
 * reviewSession — the versioned contract between RepoSpector's candidates and
 * whoever verifies them. P1-8.
 *
 * RepoSpector generates candidates; an assistant connected to its MCP server
 * investigates them with evidence RepoSpector does not have; RepoSpector
 * validates what comes back and applies posting policy. That only works if both
 * sides agree on what a candidate IS, which snapshot it was made against, and
 * what a verdict on it must carry.
 *
 * Two design decisions worth stating, because both are load-bearing:
 *
 *   Candidates are exported BEFORE model-based confidence and value
 *   suppression. The point of the stage is to rescue a real bug the pipeline
 *   under-investigated, and a bug already deleted for scoring 6 cannot be
 *   rescued. Deterministic rejections are exported too, with their reasons, so
 *   the audit record shows what was withheld and why.
 *
 *   Nothing here establishes truth. The checks are mechanical — the ids exist,
 *   the snapshot matches, the citations point at real lines — and a result that
 *   passes them is a well-formed opinion, not a verified one. Saying so in the
 *   module that performs the checks is the only way that stays true after
 *   someone reads only the function names.
 */

import { hashParts } from '../utils/reviewFingerprint.js';

export const SESSION_SCHEMA_VERSION = 1;

export const VERIFICATION_STATUS = Object.freeze({
    CONFIRMED: 'confirmed',
    REFUTED: 'refuted',
    UNRESOLVED: 'unresolved',
});

/** A candidate's content hash: changing the claim changes the id it answers to. */
export function candidateHash(candidate) {
    return hashParts([
        candidate?.file ?? '',
        candidate?.line ?? '',
        candidate?.title ?? '',
        candidate?.description ?? '',
        candidate?.evidence ?? '',
    ]);
}

/**
 * Build the exported session.
 *
 * @param {object} input
 * @param {string} input.reviewId
 * @param {object} input.repository     { host, owner, repo, url }
 * @param {string|null} input.baseSha
 * @param {string|null} input.headSha
 * @param {Array<object>} input.candidates    pre-suppression candidates
 * @param {Array<object>} [input.withheld]    deterministically rejected, with reasons
 * @param {object|null} [input.completeness]  the P0-1 contract for this run
 * @param {string|number|null} [input.pipelineVersion]
 */
export function buildReviewSession({
    reviewId,
    repository = null,
    baseSha = null,
    headSha = null,
    candidates = [],
    withheld = [],
    completeness = null,
    pipelineVersion = null,
} = {}) {
    if (!reviewId) throw new Error('a review session needs a reviewId');

    return {
        schemaVersion: SESSION_SCHEMA_VERSION,
        reviewId: String(reviewId),
        repository: repository ? { ...repository } : null,
        snapshot: { baseSha, headSha },
        pipelineVersion: pipelineVersion ?? null,
        // The completeness contract travels with the session: a verifier that
        // does not know half the diff was unread cannot judge what "no other
        // problems" would mean.
        completeness: completeness ?? null,
        candidates: candidates.map((c, i) => normalizeCandidate(c, i)),
        // Exported, not silently dropped. A finding the gate rejected for a
        // deterministic reason is auditable; one that vanished is not.
        withheld: withheld.map((c, i) => ({
            ...normalizeCandidate(c, `w${i}`),
            withheldBecause: c?._precisionDrop ?? c?.filteredBecause ?? c?._admissionDrop ?? 'unspecified',
        })),
        exportedAt: new Date().toISOString(),
    };
}

function normalizeCandidate(raw, index) {
    const candidateId = raw?.candidateId ?? raw?.id ?? `c${index}`;
    return {
        candidateId: String(candidateId),
        contentHash: candidateHash(raw),
        file: raw?.file ?? raw?.filePath ?? null,
        line: raw?.line ?? null,
        severity: raw?.severity ?? null,
        category: raw?.category ?? raw?.type ?? null,
        source: raw?.source ?? null,
        title: raw?.title ?? null,
        description: raw?.description ?? null,
        // The structured claim, so a verifier is investigating a proposition
        // rather than parsing prose back into one.
        claim: {
            trigger: raw?.trigger ?? raw?.claim?.trigger ?? null,
            expectedContract: raw?.expectedContract ?? raw?.claim?.expectedContract ?? null,
            actualBehavior: raw?.actualBehavior ?? raw?.claim?.actualBehavior ?? null,
            introducedChange: raw?.introducedChange ?? raw?.claim?.introducedChange ?? null,
            affectedConsumer: raw?.affectedConsumer ?? raw?.claim?.affectedConsumer ?? null,
        },
        evidence: raw?.evidence ?? raw?.codeSnippet ?? null,
        validationStatus: raw?.validationStatus ?? null,
        assertionLevel: raw?.assertionLevel ?? null,
    };
}

/**
 * Mechanically check one submitted verification result against the session.
 *
 * What this establishes: the result is about a candidate this session exported,
 * that candidate has not changed since, the snapshot is the one it was made
 * against, and every citation points at a line that exists in a file the review
 * covered. What it does NOT establish: that the verdict is correct. Provenance,
 * not truth.
 *
 * @returns {{ok: boolean, errors: string[], result: object|null}}
 */
export function validateVerificationResult(session, submitted, { fileLines = null } = {}) {
    const errors = [];
    if (!session) return { ok: false, errors: ['no session'], result: null };
    if (!submitted || typeof submitted !== 'object') {
        return { ok: false, errors: ['result is not an object'], result: null };
    }

    if (String(submitted.reviewId ?? '') !== session.reviewId) {
        errors.push(`reviewId ${JSON.stringify(submitted.reviewId)} does not match this session`);
    }

    const candidate = session.candidates.find(
        (c) => c.candidateId === String(submitted.candidateId ?? ''),
    );
    if (!candidate) {
        errors.push(`unknown candidateId ${JSON.stringify(submitted.candidateId)}`);
    } else if (submitted.candidateHash && submitted.candidateHash !== candidate.contentHash) {
        // The claim was edited between export and verification. A verdict on a
        // different claim is not a verdict on this one.
        errors.push('candidate contents changed since export — the verdict does not apply');
    }

    const snapshot = submitted.snapshot ?? {};
    if (snapshot.headSha && session.snapshot.headSha
        && snapshot.headSha !== session.snapshot.headSha) {
        errors.push('the result was produced against a different head; re-verify at the reviewed head');
    }

    const status = String(submitted.status ?? '');
    if (!Object.values(VERIFICATION_STATUS).includes(status)) {
        errors.push(`status must be one of ${Object.values(VERIFICATION_STATUS).join(' | ')}`);
    }
    if (status === VERIFICATION_STATUS.CONFIRMED && !(submitted.citations ?? []).length) {
        errors.push('a confirmed result must cite the source that supports it');
    }
    if (status === VERIFICATION_STATUS.REFUTED && !submitted.rationale) {
        errors.push('a refuted result must say what the counterevidence was');
    }
    if (!submitted.verifier?.name) {
        errors.push('the verifier must identify itself (model or workflow version)');
    }

    for (const citation of submitted.citations ?? []) {
        if (!citation?.path) { errors.push('a citation has no path'); continue; }
        if (fileLines) {
            const total = fileLines.get(citation.path);
            if (total == null) {
                errors.push(`citation points at ${citation.path}, which this review did not cover`);
            } else if (citation.line != null && (citation.line < 1 || citation.line > total)) {
                errors.push(`citation ${citation.path}:${citation.line} is outside that file`);
            }
        }
    }

    if (errors.length) return { ok: false, errors, result: null };

    return {
        ok: true,
        errors: [],
        result: {
            reviewId: session.reviewId,
            candidateId: candidate.candidateId,
            candidateHash: candidate.contentHash,
            snapshot: { ...session.snapshot },
            status,
            rationale: submitted.rationale ?? null,
            trigger: submitted.trigger ?? null,
            impact: submitted.impact ?? null,
            citations: [...(submitted.citations ?? [])],
            checkedCounterevidence: [...(submitted.checkedCounterevidence ?? [])],
            missingEvidence: [...(submitted.missingEvidence ?? [])],
            validationArtifacts: [...(submitted.validationArtifacts ?? [])],
            verifier: { ...submitted.verifier },
            acceptedAt: new Date().toISOString(),
            // The one thing a reader must not infer from `ok: true`.
            note: 'schema, session binding and citations checked mechanically; '
                + 'this establishes provenance, not correctness',
        },
    };
}

/**
 * Fold accepted results into the candidate set, and say what may be posted.
 *
 * `shadow` records decisions without changing anything — the rollout mode P1-8
 * asks for. In shadow mode `postable` is what the pipeline would have posted
 * anyway, and the verification outcome is carried alongside for comparison.
 */
export function applyVerification(session, results = [], { shadow = false } = {}) {
    const byCandidate = new Map();
    for (const r of results) {
        const existing = byCandidate.get(r.candidateId);
        if (existing && existing.status !== r.status) {
            // Conflicting verdicts on one candidate settle nothing. Repeated
            // identical submissions are idempotent; contradictory ones are not
            // a majority vote.
            byCandidate.set(r.candidateId, { ...r, status: VERIFICATION_STATUS.UNRESOLVED,
                rationale: 'conflicting verdicts were submitted for this candidate' });
            continue;
        }
        byCandidate.set(r.candidateId, r);
    }

    const decided = session.candidates.map((c) => ({
        ...c,
        verification: byCandidate.get(c.candidateId) ?? null,
    }));

    const confirmed = decided.filter((c) => c.verification?.status === VERIFICATION_STATUS.CONFIRMED);
    const refuted = decided.filter((c) => c.verification?.status === VERIFICATION_STATUS.REFUTED);
    const unresolved = decided.filter((c) => (
        !c.verification || c.verification.status === VERIFICATION_STATUS.UNRESOLVED
    ));

    return {
        shadow,
        candidates: decided,
        // In live mode only confirmed candidates are eligible; in shadow mode
        // the decision is recorded and the pipeline's own output is unchanged.
        postable: shadow ? session.candidates : confirmed,
        confirmed,
        refuted,
        unresolved,
        // An unresolved MATERIAL candidate blocks an automatic approval: the
        // review has an open question about a consequential claim, which is
        // exactly what "needs discussion" means.
        blocksApproval: unresolved.some((c) => isMaterial(c)),
        stats: {
            total: decided.length,
            confirmed: confirmed.length,
            refuted: refuted.length,
            unresolved: unresolved.length,
            unreturned: decided.filter((c) => !c.verification).length,
        },
    };
}

const MATERIAL_SEVERITIES = new Set(['critical', 'high', 'blocking', 'blocker', 'error']);
function isMaterial(candidate) {
    return MATERIAL_SEVERITIES.has(String(candidate?.severity ?? '').toLowerCase());
}

export default {
    SESSION_SCHEMA_VERSION,
    VERIFICATION_STATUS,
    buildReviewSession,
    candidateHash,
    validateVerificationResult,
    applyVerification,
};

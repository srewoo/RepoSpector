/**
 * HypothesisValidationService — try to disprove a promising candidate. P1-6.
 *
 * Everything upstream of this asks "does this look like a defect?". Gates check
 * that a cited line exists, a scorer ranks how worth saying it is, and an
 * optional refuter asks the same model the same question about the same diff —
 * which, measured, kept 42 of 42 findings human adjudication then rejected.
 * None of that is an attempt to REFUTE the claim, and none of it fetches
 * anything the first pass did not already have.
 *
 * This stage does two things the others do not:
 *
 *   1. It names the evidence the claim actually needs — the caller, the guard,
 *      the default, the contract, the test — and goes and gets it.
 *   2. Where a trusted runner is available and the user has authorized
 *      execution, it runs a focused check at PINNED revisions, and treats
 *      "fails at head, passes at base" as the only thing that demonstrates the
 *      change introduced the failure.
 *
 * Bounded on purpose: per-review and per-candidate ceilings on evidence
 * requests, tokens and executions, spent on the most consequential candidates
 * first. Hitting a ceiling is not an error; it produces `unresolved`, which is
 * a real answer and must never be reported as a passed check.
 *
 * Execution is optional in every direction. There is no runner in a browser
 * extension, so the default path is source-based and the record says so. A
 * runner that IS supplied must declare itself authorized and isolated — this
 * service never assumes ambient credentials are acceptable to use.
 */

import {
    VALIDATION_STATUS,
    VALIDATION_BASIS,
    validationRecord,
    executionRecord,
    classifyReproduction,
} from '../utils/validationRecord.js';
import { requiredEvidenceFor } from '../utils/requiredEvidence.js';

export { requiredEvidenceFor };

/** Ceilings. Deliberately small: this runs while a user waits, on their key. */
export const VALIDATION_DEFAULTS = Object.freeze({
    maxCandidates: 8,
    maxEvidenceRequestsPerCandidate: 3,
    maxExecutionsPerReview: 4,
    /** Only candidates at or above this severity are worth the round trips. */
    severities: ['critical', 'high', 'blocking', 'blocker', 'error'],
});

export class HypothesisValidationService {
    /**
     * @param {object} deps
     * @param {{fetch: (request: object) => Promise<object|null>}} [deps.evidenceProvider]
     *   Resolves one evidence request into `{text, location}` or null.
     * @param {object} [deps.runner] An execution runner. Must expose
     *   `authorized === true`, `isolated === true` and
     *   `run({command, revision}) => {exitStatus, output, environment, durationMs}`.
     *   Anything else is treated as no runner at all — an unauthorized or
     *   non-isolated runner is not a fallback, it is a refusal.
     */
    constructor({ evidenceProvider = null, runner = null } = {}) {
        this.evidence = evidenceProvider;
        this.runner = runner;
    }

    /** Is a runner present AND willing to say it is authorized and isolated? */
    canExecute() {
        return !!this.runner
            && this.runner.authorized === true
            && this.runner.isolated === true
            && typeof this.runner.run === 'function';
    }

    /**
     * @param {Array<object>} findings
     * @param {object} opts
     * @param {string|null} opts.revision      the reviewed head
     * @param {string|null} opts.baseRevision  the effective base
     * @param {object} [opts.limits]
     * @returns {Promise<{findings: Array, stats: object}>}
     */
    async validate(findings = [], opts = {}) {
        const limits = { ...VALIDATION_DEFAULTS, ...(opts.limits || {}) };
        const severities = new Set(limits.severities.map((s) => String(s).toLowerCase()));

        const stats = {
            considered: 0,
            validated: 0,
            confirmed: 0,
            refuted: 0,
            unresolved: 0,
            evidenceRequests: 0,
            executions: 0,
            executionAvailable: this.canExecute(),
            skippedForBudget: 0,
        };

        // Consequential first. A budget spent on nitpicks is a budget not spent
        // on the finding that would have blocked the merge.
        const ranked = [...(findings || [])]
            .map((f, index) => ({ f, index }))
            .filter(({ f }) => severities.has(String(f?.severity ?? '').toLowerCase()))
            .sort((a, b) => (Number(b.f.score ?? 0) - Number(a.f.score ?? 0)) || (a.index - b.index));

        const chosen = new Set(ranked.slice(0, limits.maxCandidates).map((r) => r.index));
        stats.considered = ranked.length;
        stats.skippedForBudget = Math.max(0, ranked.length - chosen.size);

        let executionsLeft = this.canExecute() ? limits.maxExecutionsPerReview : 0;
        const out = [];

        for (let i = 0; i < (findings || []).length; i++) {
            const finding = findings[i];
            if (!chosen.has(i)) {
                out.push(finding);
                continue;
            }

            const record = await this._validateOne(finding, {
                ...opts,
                limits,
                executionsLeft,
            });
            executionsLeft -= record.executions.filter((e) => e.available).length;
            stats.evidenceRequests += record.evidenceRequested.length;
            stats.executions += record.executions.filter((e) => e.available).length;
            stats.validated++;
            stats[record.status]++;

            out.push({ ...finding, validation: record });
        }

        return { findings: out, stats };
    }

    async _validateOne(finding, opts) {
        const limits = opts.limits;
        const wants = requiredEvidenceFor(finding).slice(0, limits.maxEvidenceRequestsPerCandidate);
        const obtained = [];
        const missing = [];
        const counterevidence = [];

        for (const want of wants) {
            if (!this.evidence?.fetch) {
                missing.push(`${want.kind} (no evidence provider is wired)`);
                continue;
            }
            let got = null;
            try {
                got = await this.evidence.fetch({ ...want, finding });
            } catch (e) {
                got = null;
                missing.push(`${want.kind} (lookup failed: ${e?.message || 'unknown'})`);
                continue;
            }
            if (!got || !got.text) {
                // Absence from a lookup is not absence from the repository —
                // the same mistake `_findTest` used to make. Record it as
                // missing evidence, never as evidence of correctness.
                missing.push(`${want.kind} for ${want.target ?? 'this finding'}`);
                continue;
            }
            obtained.push({ kind: want.kind, target: want.target, location: got.location ?? null });
            if (got.refutes) {
                counterevidence.push({
                    kind: want.kind,
                    location: got.location ?? null,
                    reason: got.refutes,
                });
            }
        }

        // Counterevidence settles it without spending an execution.
        if (counterevidence.length) {
            return validationRecord({
                status: VALIDATION_STATUS.REFUTED,
                basis: VALIDATION_BASIS.SOURCE,
                rationale: counterevidence[0].reason,
                evidenceRequested: wants,
                evidenceObtained: obtained,
                missingEvidence: missing,
                counterevidence,
                revision: opts.revision ?? null,
                baseRevision: opts.baseRevision ?? null,
            });
        }

        // A reproduction, when one is offered and a runner will take it.
        const reproduction = finding?.reproduction ?? null;
        if (reproduction?.command) {
            if (!this.canExecute()) {
                return validationRecord({
                    status: VALIDATION_STATUS.UNRESOLVED,
                    basis: VALIDATION_BASIS.NONE,
                    rationale: 'a reproduction was proposed but no authorized, isolated runner is '
                        + 'available — this is not a passed check',
                    evidenceRequested: wants,
                    evidenceObtained: obtained,
                    missingEvidence: [...missing, 'execution of the proposed reproduction'],
                    executions: [executionRecord({
                        command: reproduction.command,
                        available: false,
                        reason: 'no authorized isolated runner',
                    })],
                    revision: opts.revision ?? null,
                    baseRevision: opts.baseRevision ?? null,
                });
            }
            if (opts.executionsLeft <= 1) {
                return validationRecord({
                    status: VALIDATION_STATUS.UNRESOLVED,
                    basis: VALIDATION_BASIS.NONE,
                    rationale: 'the review\'s execution budget was exhausted before this candidate',
                    evidenceRequested: wants,
                    evidenceObtained: obtained,
                    missingEvidence: [...missing, 'execution at head and base'],
                    revision: opts.revision ?? null,
                    baseRevision: opts.baseRevision ?? null,
                });
            }

            const atHead = await this._run(reproduction.command, opts.revision);
            const atBase = await this._run(reproduction.command, opts.baseRevision);
            const verdict = classifyReproduction(atHead, atBase);

            return validationRecord({
                ...verdict,
                evidenceRequested: wants,
                evidenceObtained: obtained,
                missingEvidence: missing,
                executions: [atHead, atBase],
                revision: opts.revision ?? null,
                baseRevision: opts.baseRevision ?? null,
            });
        }

        // Source-only. Confirming from source is legitimate — running a test is
        // not mandatory for every candidate — but it requires that the evidence
        // the claim needed actually came back.
        if (obtained.length && missing.length === 0) {
            return validationRecord({
                status: VALIDATION_STATUS.CONFIRMED,
                basis: VALIDATION_BASIS.SOURCE,
                rationale: `every piece of evidence this claim depends on was read (${
                    obtained.map((o) => o.kind).join(', ')}) and none of it contradicts the claim`,
                evidenceRequested: wants,
                evidenceObtained: obtained,
                revision: opts.revision ?? null,
                baseRevision: opts.baseRevision ?? null,
            });
        }

        return validationRecord({
            status: VALIDATION_STATUS.UNRESOLVED,
            basis: VALIDATION_BASIS.NONE,
            rationale: 'the evidence this claim depends on could not be retrieved',
            evidenceRequested: wants,
            evidenceObtained: obtained,
            missingEvidence: missing,
            revision: opts.revision ?? null,
            baseRevision: opts.baseRevision ?? null,
        });
    }

    async _run(command, revision) {
        if (!revision) {
            return executionRecord({
                command,
                available: false,
                reason: 'no pinned revision to run against',
            });
        }
        const started = Date.now();
        try {
            const result = await this.runner.run({ command, revision });
            return executionRecord({
                command,
                revision,
                environment: result?.environment ?? null,
                exitStatus: result?.exitStatus ?? null,
                output: result?.output ?? null,
                durationMs: result?.durationMs ?? (Date.now() - started),
            });
        } catch (e) {
            return executionRecord({
                command,
                revision,
                available: false,
                reason: `runner failed: ${e?.message || 'unknown'}`,
                durationMs: Date.now() - started,
            });
        }
    }
}

export default HypothesisValidationService;

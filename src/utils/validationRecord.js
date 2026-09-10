/**
 * validationRecord — the shape of "we tried to disprove this, and here is what
 * happened". P1-6.
 *
 * The pipeline had two ways to say a finding was good: it cleared some gates,
 * or a model scored it highly. Neither is an attempt to REFUTE the claim, and
 * neither produces anything a reader can inspect. This is the third: a record
 * of what evidence was sought, what came back, what was executed if anything,
 * and what that settles.
 *
 * Three statuses, and the third one is the reason this module exists.
 * `unresolved` is a real answer — most claims about real code cannot be settled
 * from a diff, and a pipeline that only knows "confirmed" and "refuted" will
 * report one of them anyway. An unavailable check must never read as a passed
 * one.
 */

export const VALIDATION_STATUS = Object.freeze({
    /** Evidence was obtained and supports the claim, including its introduction. */
    CONFIRMED: 'confirmed',
    /** Specific counterevidence disproves premise, reachability or consequence. */
    REFUTED: 'refuted',
    /** Missing or contradictory evidence, exhausted budget, or no runner. */
    UNRESOLVED: 'unresolved',
});

/** How the status was reached. Kept separate from the status itself. */
export const VALIDATION_BASIS = Object.freeze({
    /** Source was read and it settles the question. */
    SOURCE: 'source',
    /** A command was run at a pinned revision. */
    EXECUTION: 'execution',
    /** A reproduction failed at head and passed at base. */
    REGRESSION: 'regression',
    /** Nothing was established. */
    NONE: 'none',
});

function str(value) {
    return value == null ? null : String(value);
}

/**
 * One execution attempt, recorded whether it succeeded or not.
 *
 * Command, environment, exit status and output are all kept: a validation whose
 * provenance cannot be inspected is indistinguishable from an assertion, which
 * is the failure mode this whole stage exists to avoid.
 */
export function executionRecord({
    command = null,
    revision = null,
    environment = null,
    exitStatus = null,
    output = null,
    durationMs = null,
    available = true,
    reason = null,
} = {}) {
    return {
        command: str(command),
        revision: str(revision),
        environment: str(environment),
        // `Number(null)` is 0 and `Number('')` is 0, both finite — so coercing
        // first turns "the runner never ran" into "the command exited 0", i.e.
        // a check that did not happen reads as a check that passed. Reject the
        // empty forms before touching Number().
        exitStatus: (exitStatus === null || exitStatus === undefined || exitStatus === ''
            || !Number.isFinite(Number(exitStatus)))
            ? null
            : Number(exitStatus),
        // Bounded: a failing test suite can emit megabytes, and none of it after
        // the first screenful helps a reviewer.
        output: output == null ? null : String(output).slice(0, 4000),
        durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
        available: available !== false,
        reason: str(reason),
    };
}

/**
 * @param {object} input
 * @returns {object} a complete, normalized validation record
 */
export function validationRecord({
    status = VALIDATION_STATUS.UNRESOLVED,
    basis = VALIDATION_BASIS.NONE,
    rationale = null,
    evidenceRequested = [],
    evidenceObtained = [],
    missingEvidence = [],
    counterevidence = [],
    executions = [],
    revision = null,
    baseRevision = null,
    budget = null,
} = {}) {
    const known = new Set(Object.values(VALIDATION_STATUS));
    return {
        status: known.has(status) ? status : VALIDATION_STATUS.UNRESOLVED,
        basis: Object.values(VALIDATION_BASIS).includes(basis) ? basis : VALIDATION_BASIS.NONE,
        rationale: str(rationale),
        evidenceRequested: [...evidenceRequested],
        evidenceObtained: [...evidenceObtained],
        missingEvidence: [...missingEvidence],
        counterevidence: [...counterevidence],
        executions: executions.map((e) => executionRecord(e)),
        revision: str(revision),
        baseRevision: str(baseRevision),
        budget: budget ? { ...budget } : null,
    };
}

/**
 * Did a reproduction demonstrate that THIS change introduced the failure?
 *
 * Failing at head is not enough: a test that fails at head and also fails at
 * base is describing a pre-existing defect, which is a true statement about the
 * code and a false one about the merge request. Reporting the second as the
 * first is how a reviewer manufactures regressions.
 *
 * @param {{exitStatus: number|null}} atHead
 * @param {{exitStatus: number|null}} atBase
 */
export function classifyReproduction(atHead, atBase) {
    const headFailed = Number(atHead?.exitStatus) !== 0;
    const baseFailed = Number(atBase?.exitStatus) !== 0;

    if (atHead?.exitStatus == null || atBase?.exitStatus == null) {
        return {
            status: VALIDATION_STATUS.UNRESOLVED,
            basis: VALIDATION_BASIS.NONE,
            rationale: 'the reproduction did not run at both revisions, so nothing about '
                + 'introduction was established',
        };
    }
    if (headFailed && !baseFailed) {
        return {
            status: VALIDATION_STATUS.CONFIRMED,
            basis: VALIDATION_BASIS.REGRESSION,
            rationale: 'the reproduction fails at the reviewed head and passes at the base, '
                + 'so this change introduces the failure',
        };
    }
    if (headFailed && baseFailed) {
        return {
            status: VALIDATION_STATUS.REFUTED,
            basis: VALIDATION_BASIS.REGRESSION,
            rationale: 'the reproduction fails at the base too, so the failure is pre-existing '
                + 'and is not introduced by this change',
        };
    }
    return {
        status: VALIDATION_STATUS.REFUTED,
        basis: VALIDATION_BASIS.EXECUTION,
        rationale: 'the reproduction passes at the reviewed head, so the claimed failure does '
            + 'not occur',
    };
}

/** One sentence for the report. Never says "passed" about something unavailable. */
export function describeValidationRecord(record) {
    if (!record) return 'not validated';
    switch (record.status) {
        case VALIDATION_STATUS.CONFIRMED:
            return `confirmed (${record.basis})${record.rationale ? `: ${record.rationale}` : ''}`;
        case VALIDATION_STATUS.REFUTED:
            return `refuted${record.rationale ? `: ${record.rationale}` : ''}`;
        default:
            return `unresolved${record.rationale ? `: ${record.rationale}` : ''}`
                + (record.missingEvidence.length
                    ? ` (missing: ${record.missingEvidence.slice(0, 3).join(', ')})`
                    : '');
    }
}

export default {
    VALIDATION_STATUS,
    VALIDATION_BASIS,
    validationRecord,
    executionRecord,
    classifyReproduction,
    describeValidationRecord,
};

import {
    scoreFindings,
    filterByRubric,
    validateRubricResult,
    applyHostRubricResults,
    DEFAULT_MIN_RUBRIC_SCORE,
} from '../../../../src/review-core/rubricScorer.js';
import { createRubricContextFor } from '../../../../src/review-core/rubricContext.js';
import { createSamplingModelPort } from '../adapters/samplingModelPort.js';

/**
 * The rubric scorer's half of the delegated exchange (spec §1.2, §2.3).
 *
 * Findings the host submits are scored here — through the client's model when
 * it offers sampling, otherwise by handing each rubric prompt back to the host
 * as a `rubric_requests` entry. An answer is checked against the same schema a
 * sampled answer is, and the same deterministic caps apply. The server checks
 * the shape and the caps; it cannot check that the host scored honestly.
 */

export const RUBRIC_SCORES_SCHEMA = {
    type: 'array',
    description: 'Answers to the `rubric_requests` an earlier findings submission returned. '
        + 'Send them in their own call, after findings. One entry per request you scored.',
    items: {
        type: 'object',
        properties: {
            /* eslint-disable-next-line camelcase */
            request_id: { type: 'string' },
            score: { type: 'integer', minimum: 0, maximum: 100 },
            preExisting: { type: 'boolean' },
            quotedRule: { type: ['string', 'null'] },
            reason: { type: 'string' },
        },
        required: ['request_id', 'score', 'preExisting', 'reason'],
    },
};

const rulesTextsOf = (session) => (session.rulesFiles ?? []).map((r) => r.text);

/**
 * Score freshly submitted findings. Delegated requests replace any earlier ones.
 * Ids carry the submission number, so an answer to a request from an earlier
 * submission is refused as unknown rather than landing on a different finding.
 */
export async function scoreSubmitted(session, findings, server) {
    const submissionSeq = (session.delegation?.submissionSeq ?? 0) + 1;
    const result = await scoreFindings(findings, {
        modelPort: createSamplingModelPort({ server }),
        contextFor: createRubricContextFor({
            files: session.parsedFiles ?? [],
            rulesFiles: session.rulesFiles ?? [],
        }),
        rulesTexts: rulesTextsOf(session),
        requestIdFor: (f, i) => `rubric-${submissionSeq}-${i}`,
    });
    return { findings: result.findings, requests: result.delegatedRequests ?? [], submissionSeq };
}

/**
 * Apply the host's answers. Only ids this session issued are accepted, and each
 * answer must pass the rubric schema; anything else is reported, not applied.
 *
 * @returns {{accepted: string[], rejected: Array<{request_id: string|null, errors: string[]}>}}
 */
export function applyRubricScores(session, submitted = []) {
    const known = new Set((session.delegation.rubricRequests ?? []).map((r) => r.id));
    const accepted = [];
    const rejected = [];
    for (const s of submitted) {
        const id = String(s?.request_id ?? '');
        if (!known.has(id)) {
            rejected.push({
                request_id: id || null,
                errors: [`unknown request_id ${JSON.stringify(id)}; answer only ids listed in rubric_requests`],
            });
            continue;
        }
        const check = validateRubricResult({
            score: s.score,
            preExisting: s.preExisting,
            quotedRule: s.quotedRule ?? null,
            reason: s.reason,
        });
        if (!check.ok) {
            rejected.push({ request_id: id, errors: [check.error] });
            continue;
        }
        accepted.push({ requestId: id, result: check.value });
    }

    if (accepted.length) {
        session.delegation.findings = applyHostRubricResults(
            session.delegation.findings, accepted, { rulesTexts: rulesTextsOf(session) },
        );
        const answered = new Set(accepted.map((a) => a.requestId));
        session.delegation.rubricRequests = session.delegation.rubricRequests
            .filter((r) => !answered.has(r.id));
    }
    return { accepted: accepted.map((a) => a.requestId), rejected };
}

/** One line per finding — what a reader needs to see why it landed where it did. */
export function briefRubric(f) {
    return {
        file: f.file ?? null,
        line: f.line ?? null,
        title: f.title ?? null,
        ...(f.lens ? { lens: f.lens } : {}),
        score: f.rubric?.score ?? null,
        reason: f.rubric?.capReason || f.rubric?.reason || null,
        ...(f.rubric?.status === 'unscored' ? { awaiting: Boolean(f.rubric?.requestId) } : {}),
    };
}

export function rubricSummary(session) {
    const minRubricScore = session.minRubricScore ?? DEFAULT_MIN_RUBRIC_SCORE;
    const gate = filterByRubric(session.delegation.findings ?? [], { minRubricScore });
    return {
        minRubricScore,
        postable: gate.postable.map(briefRubric),
        notVerified: gate.notVerified.map(briefRubric),
        dropped: gate.dropped.map(briefRubric),
    };
}

export function pendingRequests(session) {
    return (session.delegation.rubricRequests ?? []).map((r) => ({
        /* eslint-disable-next-line camelcase */
        request_id: r.id,
        stage: r.stage,
        messages: r.messages,
        schema: r.schema,
    }));
}

export function rubricInstruction(reviewId) {
    return `Score each rubric_requests entry by running its messages as a prompt (system first), `
        + `then call submit_review_findings({ review_id: "${reviewId}", reviewer, rubric_scores: `
        + '[{ request_id, score, preExisting, quotedRule, reason }] }). Score honestly against the '
        + 'rubric in the prompt — a finding you cannot verify scores low. Unanswered requests leave '
        + 'their findings NOT VERIFIED.';
}

export default {
    RUBRIC_SCORES_SCHEMA, scoreSubmitted, applyRubricScores, rubricSummary, pendingRequests,
    briefRubric, rubricInstruction,
};

import { PRIORITY } from '../utils/callBudget.js';
import { isDeterministicSource } from '../utils/findingSources.js';
import { mapPool } from '../utils/boundedPool.js';
import { MODEL_STATUS } from './modelPort.js';
import {
    RUBRIC_SYSTEM_PROMPT,
    RUBRIC_RESULT_SCHEMA,
    buildRubricMessages,
    validateRubricResult,
    parseRubricText,
} from './rubricPrompt.js';

/**
 * rubricScorer — an independent 0-100 judgement of each surviving finding.
 *
 * The reviewer's self-reported confidence is the number this replaces: the
 * model that wrote a finding is the worst judge of it. Here a separate call
 * scores each finding against a fixed rubric (rubricPrompt.js), code then
 * applies two hard caps the model cannot talk its way past, and the precision
 * gate keeps only `score >= minRubricScore`.
 *
 * Completeness contract: a finding that could not be scored is `unscored` with
 * a reason, and is reported under "Not verified" — never posted as verified,
 * never silently dropped.
 */

export { RUBRIC_SYSTEM_PROMPT, RUBRIC_RESULT_SCHEMA, buildRubricMessages, validateRubricResult };

export const RUBRIC_STATUS = Object.freeze({ SCORED: 'scored', UNSCORED: 'unscored', BYPASSED: 'bypassed' });
export const DEFAULT_MIN_RUBRIC_SCORE = 80;
export const RUBRIC_STAGE = 'rubric';
const RULE_CAP = 25;

const normalizeWs = (s) => String(s).replace(/\s+/g, ' ').trim();
const stripQuotes = (s) => String(s).trim().replace(/^["'`“‘]+|["'`”’]+$/g, '');

/** Does this finding say it violates a repository rule? */
export function claimsRule(finding = {}) {
    return finding.lens === 'rulesCompliance'
        || Boolean(finding.citation?.rule)
        || (Boolean(finding.rule) && finding.category === 'conventions');
}

function quoteFound(quotedRule, rulesTexts = []) {
    if (!quotedRule) return false;
    const quote = normalizeWs(stripQuotes(quotedRule));
    if (!quote) return false;
    return rulesTexts.some(t => normalizeWs(t || '').includes(quote));
}

/**
 * Deterministic caps, applied after the model.
 *   preExisting            -> 0
 *   claims a rule but the quote is missing or not verbatim in a rules file -> <= 25
 *
 * @returns {{score:number, capReason:string|null}}
 */
export function applyCaps(value, finding, { rulesTexts = [] } = {}) {
    if (value.preExisting === true && value.score > 0) {
        return { score: 0, capReason: 'pre-existing issue (capped to 0)' };
    }
    if (claimsRule(finding) && !quoteFound(value.quotedRule, rulesTexts) && value.score > RULE_CAP) {
        return { score: RULE_CAP, capReason: `rule violation without a verbatim quote from a rules file (capped to ${RULE_CAP})` };
    }
    return { score: value.score, capReason: null };
}

function scoredRubric(value, finding, rulesTexts, requestId) {
    const { score, capReason } = applyCaps(value, finding, { rulesTexts });
    return {
        status: RUBRIC_STATUS.SCORED, score, rawScore: value.score, preExisting: value.preExisting,
        quotedRule: value.quotedRule, reason: value.reason, capReason, ...(requestId ? { requestId } : {}),
    };
}

function unscoredRubric(reason, requestId) {
    return {
        status: RUBRIC_STATUS.UNSCORED, score: null, rawScore: null, preExisting: null,
        quotedRule: null, reason, capReason: null, ...(requestId ? { requestId } : {}),
    };
}

const BYPASSED = Object.freeze({
    status: RUBRIC_STATUS.BYPASSED, score: null, rawScore: null, preExisting: null,
    quotedRule: null, reason: 'deterministic source — not model-scored', capReason: null,
});

async function scoreOne(finding, index, { modelPort, contextFor, rulesTexts, delegatedRequests, requestIdFor }) {
    const requestId = requestIdFor(finding, index);
    const opts = { stage: RUBRIC_STAGE, priority: PRIORITY.IMPORTANT, schema: RUBRIC_RESULT_SCHEMA, requestId };

    try {
        const ctx = (contextFor ? await contextFor(finding) : null) || {};
        const messages = buildRubricMessages(finding, ctx);
        const first = await modelPort(messages, opts);
        if (first.status === MODEL_STATUS.DELEGATED) {
            delegatedRequests.push(first.request);
            return unscoredRubric('delegated to the host; awaiting its rubric score', requestId);
        }
        if (first.status !== MODEL_STATUS.OK) return unscoredRubric(first.reason);

        const parsed = parseRubricText(first.text);
        if (parsed.ok) return scoredRubric(parsed.value, finding, rulesTexts);

        // One retry, with the validation error, then give up.
        const retry = await modelPort([
            ...messages,
            { role: 'assistant', content: first.text },
            { role: 'user', content: `Your reply was invalid: ${parsed.error}. Reply with ONLY the JSON object.` },
        ], opts);
        if (retry.status !== MODEL_STATUS.OK) return unscoredRubric(retry.reason || 'retry not answered');
        const reparsed = parseRubricText(retry.text);
        return reparsed.ok
            ? scoredRubric(reparsed.value, finding, rulesTexts)
            : unscoredRubric(`malformed rubric output after one retry: ${reparsed.error}`);
    } catch (e) {
        return unscoredRubric(`rubric scoring failed: ${e?.message || e}`);
    }
}

/**
 * Score every finding. Deterministic findings are bypassed (no model call).
 *
 * @param {Array<Object>} findings
 * @param {Object} opts
 * @param {import('./modelPort.js').ModelPort} opts.modelPort
 * @param {(finding:Object) => ({hunk?:string, preChangeLines?:string, rulesText?:string}|Promise<Object>)} [opts.contextFor]
 * @param {string[]} [opts.rulesTexts] - every loaded rules file's text, for the quote cap
 * @param {number} [opts.concurrency=4]
 * @param {(finding:Object) => boolean} [opts.isDeterministic]
 * @param {(finding:Object, index:number) => string} [opts.requestIdFor] - id for a delegated request;
 *   a caller that rescores across submissions passes one unique per submission so a stale answer cannot land
 * @returns {Promise<{findings:Array<Object>, delegatedRequests:Array<Object>, stats:{scored:number, unscored:number, bypassed:number, capped:number}}>}
 */
export async function scoreFindings(findings = [], {
    modelPort,
    contextFor = null,
    rulesTexts = [],
    concurrency = 4,
    isDeterministic = (f) => isDeterministicSource(f?.source),
    requestIdFor = (f, i) => `rubric-${i}`,
} = {}) {
    const delegatedRequests = [];
    const deps = { modelPort, contextFor, rulesTexts, delegatedRequests, requestIdFor };

    const rubrics = await mapPool(findings, concurrency, (f, i) => (
        isDeterministic(f) ? { ...BYPASSED } : scoreOne(f, i, deps)
    ));

    const out = findings.map((f, i) => ({ ...f, rubric: rubrics[i] }));
    const stats = { scored: 0, unscored: 0, bypassed: 0, capped: 0 };
    for (const r of rubrics) {
        stats[r.status] += 1;
        if (r.capReason) stats.capped += 1;
    }
    return { findings: out, delegatedRequests, stats };
}

/**
 * Split by the precision gate.
 *   postable    — scored and score >= min, or bypassed
 *   notVerified — unscored (or no rubric at all): kept, shown with the reason, never posted inline
 *   dropped     — scored below the threshold
 */
export function filterByRubric(findings = [], { minRubricScore = DEFAULT_MIN_RUBRIC_SCORE } = {}) {
    const min = Number.isFinite(minRubricScore) ? minRubricScore : DEFAULT_MIN_RUBRIC_SCORE;
    const postable = [];
    const notVerified = [];
    const dropped = [];
    for (const f of findings) {
        const r = f?.rubric;
        if (r?.status === RUBRIC_STATUS.BYPASSED) postable.push(f);
        else if (r?.status === RUBRIC_STATUS.SCORED) (r.score >= min ? postable : dropped).push(f);
        else notVerified.push(f);
    }
    return { postable, notVerified, dropped };
}

/**
 * MCP delegated path: the host answered some `delegated` requests. Fill those
 * findings in; an invalid host answer leaves the finding unscored with the
 * validation error as its reason.
 *
 * @param {Array<Object>} findings - output of scoreFindings
 * @param {Array<{requestId:string, result:Object}>} results
 * @returns {Array<Object>} new array
 */
export function applyHostRubricResults(findings = [], results = [], { rulesTexts = [] } = {}) {
    const byId = new Map((results || []).map(r => [r?.requestId, r?.result]));
    return findings.map((f) => {
        const id = f?.rubric?.requestId;
        if (f?.rubric?.status !== RUBRIC_STATUS.UNSCORED || !id || !byId.has(id)) return f;
        const checked = validateRubricResult(byId.get(id));
        const rubric = checked.ok
            ? scoredRubric(checked.value, f, rulesTexts, id)
            : unscoredRubric(`host rubric result invalid: ${checked.error}`, id);
        return { ...f, rubric };
    });
}

export default {
    RUBRIC_STATUS, DEFAULT_MIN_RUBRIC_SCORE, RUBRIC_SYSTEM_PROMPT, RUBRIC_RESULT_SCHEMA,
    buildRubricMessages, validateRubricResult, applyCaps, scoreFindings, filterByRubric, applyHostRubricResults,
};

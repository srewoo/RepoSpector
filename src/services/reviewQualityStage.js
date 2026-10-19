/**
 * reviewQualityStage — the extension's glue between the PR review handler and
 * the shared review-core (new lenses, rubric scorer, permalinks).
 *
 * Kept out of prReviewHandlers.js (3.8k lines) so every decision here is
 * unit-testable without a browser. No chrome APIs, no LLMService, no storage:
 * the model arrives as a ModelPort, the files as plain data.
 */

import { NEW_LENSES, LENS_SWITCHES, LENS_LIMITS } from '../review-core/lenses/index.js';
import { scoreFindings, RUBRIC_STATUS, DEFAULT_MIN_RUBRIC_SCORE } from '../review-core/rubricScorer.js';
import { createRubricContextFor } from '../review-core/rubricContext.js';
import { attachPermalinks, parseRepoUrl } from '../review-core/permalink.js';
import { renderRepoRulesText } from '../review-core/repoRulesText.js';
import { isDeterministicSource } from '../utils/findingSources.js';

/** Spec §2.6: one call per finding, concurrency 4. */
const RUBRIC_CONCURRENCY = 4;

/** `value` as a finite number clamped to [lo, hi], else `fallback`. '' and null are not 0. */
function clampedOr(value, lo, hi, fallback) {
    if (value === null || value === undefined || String(value).trim() === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/**
 * The numeric review settings from org/user/repo config and call options,
 * validated: a NaN must not silently drop the rubric gate to the legacy one.
 */
export function resolveReviewNumbers(cfg = {}, options = {}) {
    return {
        minRubricScore: clampedOr(cfg?.minRubricScore ?? options?.minRubricScore, 0, 100, DEFAULT_MIN_RUBRIC_SCORE),
        priorPrLimit: Math.round(clampedOr(cfg?.priorPrLimit, 1, 20, LENS_LIMITS.priorPrLimit)),
    };
}

export function lensNotRun(lenses, reason) {
    return (lenses || []).map((l) => ({ lens: l.key, status: 'not-run', reason }));
}

/**
 * Which of the four new lenses run this review. A lens that will not run is
 * reported, never silently omitted (completeness contract).
 */
export function selectNewLenses(cfg = {}, { multiFinderEnabled = true } = {}) {
    if (!multiFinderEnabled) {
        return { lenses: [], lensReport: lensNotRun(NEW_LENSES, 'multiFinder is off') };
    }
    const lenses = [];
    const lensReport = [];
    for (const lens of NEW_LENSES) {
        const key = LENS_SWITCHES[lens.key];
        if (key && cfg[key] === false) {
            lensReport.push({ lens: lens.key, status: 'not-run', reason: `${key} is false` });
        } else {
            lenses.push(lens);
        }
    }
    return { lenses, lensReport };
}

/**
 * The repository's rules files as `{path, text}`: scoped AGENTS.md/CLAUDE.md
 * (deduped across changed paths), else the flat instruction text, plus the
 * `.repospector.yaml` custom rules rendered as a bullet list.
 */
export function collectRulesFiles({ instructionScopes = null, repoInstructions = '', repoRules = [] } = {}) {
    const byPath = new Map();
    for (const entries of instructionScopes?.byPath?.values?.() ?? []) {
        for (const e of entries || []) {
            if (e?.path && e.text && !byPath.has(e.path)) byPath.set(e.path, e.text);
        }
    }
    if (!byPath.size && repoInstructions) byPath.set('AGENTS.md / CLAUDE.md', repoInstructions);

    const yamlRules = renderRepoRulesText({ rules: repoRules });
    if (yamlRules) byPath.set('.repospector.yaml', yamlRules);

    return [...byPath].map(([path, text]) => ({ path, text }));
}

/** The linked issue as prompt text for the lenses. */
export function issueText(issue) {
    if (!issue) return '';
    return [`${issue.key}: ${issue.summary}`, issue.description].filter(Boolean).join('\n');
}

/**
 * Per-finding scorer context (spec §2.1): the hunk around the line, the
 * pre-change lines at the same place, and the rules text when the finding
 * claims a rule.
 */
export function buildRubricContext(finding, { files = [], rulesFiles = [] } = {}) {
    // The shared builder (T3) — the extension, MCP and eval score from the same view.
    return createRubricContextFor({ files, rulesFiles })(finding);
}

function unscoredAll(findings, reason) {
    return findings.map((f) => (isDeterministicSource(f?.source)
        ? { ...f, rubric: { status: RUBRIC_STATUS.BYPASSED, score: null, rawScore: null, preExisting: null, quotedRule: null, reason: 'deterministic source', capReason: null } }
        : { ...f, rubric: { status: RUBRIC_STATUS.UNSCORED, score: null, rawScore: null, preExisting: null, quotedRule: null, reason, capReason: null } }));
}

/**
 * The rubric stage (spec §2). Replaces the LLM refuter in the default path.
 * Never throws: a scorer that cannot run leaves every model finding
 * `unscored`, which the precision gate keeps but never posts inline.
 */
export async function runRubricStage(findings = [], {
    modelPort, files = [], rulesFiles = [], concurrency = RUBRIC_CONCURRENCY, onProgress = null,
} = {}) {
    onProgress?.({ phase: 'rubric', message: `Scoring ${findings.length} finding(s) against the rubric...` });
    try {
        const out = await scoreFindings(findings, {
            modelPort,
            rulesTexts: (rulesFiles || []).map((r) => r.text),
            concurrency,
            contextFor: (f) => buildRubricContext(f, { files, rulesFiles }),
            isDeterministic: (f) => isDeterministicSource(f?.source),
        });
        return { ...out, error: null };
    } catch (e) {
        const reason = `rubric scorer failed: ${e?.message || e}`;
        const out = unscoredAll(findings, reason);
        const count = (s) => out.filter((f) => f.rubric.status === s).length;
        return {
            findings: out,
            delegatedRequests: [],
            stats: { scored: 0, unscored: count(RUBRIC_STATUS.UNSCORED), bypassed: count(RUBRIC_STATUS.BYPASSED), capped: 0 },
            error: reason,
        };
    }
}

/** `{[path]: lineCount}` for permalink clamping; file context wins. */
export function fileLengthsFrom(prData, fileContext) {
    const out = {};
    for (const f of prData?.files || []) {
        if (f?.filename && typeof f.fullContent === 'string') out[f.filename] = f.fullContent.split('\n').length;
    }
    if (fileContext instanceof Map) {
        for (const [name, ctx] of fileContext) {
            if (typeof ctx?.fullContent === 'string') out[name] = ctx.fullContent.split('\n').length;
        }
    }
    return out;
}

/** Full-SHA permalinks (spec §4.4). Unparseable URL or non-40-hex SHA → unchanged. */
export function attachReviewPermalinks(findings, { prUrl, headSha, fileLengths = {} } = {}) {
    const repo = parseRepoUrl(prUrl);
    if (!repo || !/^[0-9a-f]{40}$/i.test(String(headSha ?? ''))) return findings;
    return attachPermalinks(findings, { ...repo, headSha, fileLengths });
}

export default {
    resolveReviewNumbers, selectNewLenses, lensNotRun, collectRulesFiles, issueText, buildRubricContext,
    runRubricStage, fileLengthsFrom, attachReviewPermalinks,
};

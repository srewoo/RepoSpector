/**
 * Flatten helpers for the multi-pass review post-processing pipeline
 * (citation → verification → fix recommendation → verdict).
 *
 * The multi-pass engine returns `perFileFindings`: an array of per-file result
 * objects, each with a nested `.findings` array. Static analysis returns its own
 * flat findings. Both must be flattened into one canonical list before the
 * post-processing stages can operate uniformly.
 */

import { liftEngineFindings } from '../services/engineContract.js';

/**
 * Flatten engine findings into a single flat findings array.
 *
 * Handles BOTH engine shapes by delegating the shape decision to
 * `liftEngineFindings` — the single source of truth for the engine contract:
 *
 *   - per-file containers  `[{ file, language, findings: [...] }]`  (MultiPassReviewEngine)
 *   - already-flat findings `[{ file, line, severity, ... }]`       (ReviewOrchestrator adapter,
 *                                                                    BackendDeepEngine, stubs)
 *
 * This used to only understand the nested shape, which silently dropped EVERY
 * finding produced by the orchestrator path (its adapter emits the flat shape) —
 * leaving the verified set, the UI list, and the merge verdict built from static
 * analysis alone. Keep this delegating; do not re-implement the shape check.
 *
 * @param {Array<Object>} perFileFindings
 * @returns {Array<Object>}
 */
export function flattenPerFileFindings(perFileFindings = []) {
    return liftEngineFindings(perFileFindings).map(f => ({
        ...f,
        source: f.source || 'llm'
    }));
}

/**
 * Normalize a static-analysis finding into the flat finding shape.
 * @param {Object} f
 * @returns {Object}
 */
export function normalizeStaticFinding(f) {
    return {
        ...f,
        file: f.file || f.filePath || null,
        line: f.line ?? null,
        severity: (f.severity || 'medium').toLowerCase(),
        type: f.type || f.category || 'quality',
        title: f.title || f.message || '',
        description: f.description || f.message || '',
        suggestion: f.suggestion || f.recommendation || '',
        rule: f.rule || (f.ruleId ? `static/${f.ruleId}` : null),
        source: 'static'
    };
}

/**
 * Build one canonical flat list from per-file LLM findings + static findings.
 * @param {Array<Object>} perFileFindings
 * @param {Array<Object>} staticFindings
 * @returns {Array<Object>}
 */
export function buildCanonicalFindings(perFileFindings = [], staticFindings = []) {
    return [
        ...flattenPerFileFindings(perFileFindings),
        ...(staticFindings || []).map(normalizeStaticFinding)
    ];
}

/**
 * Severities that mean "this must not merge as-is".
 *
 * Three vocabularies reach this function and they must all be understood here:
 *   - legacy/display  `critical` | `high`   (static analysis, adaptOrchestratorReport)
 *   - canonical       `blocking`            (reviewSchema, ReviewCrossRepoService.toFindings)
 *   - LLM prose       `error` | `blocker`   (some provider paths)
 *
 * Only `critical|high` used to count. Cross-repo impact findings — a symbol this
 * PR removed that a linked repo still calls, the single highest-confidence
 * blocking signal the pipeline produces — are emitted as canonical `blocking`,
 * so a breaking change could not flip the verdict to CHANGES_REQUESTED.
 */
const BLOCKING_SEVERITIES = new Set(['critical', 'high', 'blocking', 'blocker', 'error']);

/**
 * Count blocking findings across every producer's severity vocabulary.
 * @param {Array<Object>} findings
 * @returns {number}
 */
export function countBlocking(findings = []) {
    return findings.filter(
        f => BLOCKING_SEVERITIES.has(String(f?.severity ?? '').toLowerCase()),
    ).length;
}

export default { flattenPerFileFindings, normalizeStaticFinding, buildCanonicalFindings, countBlocking, BLOCKING_SEVERITIES };
export { BLOCKING_SEVERITIES };

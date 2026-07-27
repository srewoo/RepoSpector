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
 * Count blocking (critical/high) findings.
 * @param {Array<Object>} findings
 * @returns {number}
 */
export function countBlocking(findings = []) {
    return findings.filter(f => f.severity === 'critical' || f.severity === 'high').length;
}

export default { flattenPerFileFindings, normalizeStaticFinding, buildCanonicalFindings, countBlocking };

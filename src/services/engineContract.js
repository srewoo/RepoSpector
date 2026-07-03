/**
 * engineContract — the shared boundary between a "deep review engine" and the
 * ReviewOrchestrator, owned by @repospector/review-core so the Chrome
 * extension's MultiPassReviewEngine and the Aegis backend's BackendDeepEngine
 * cannot drift apart.
 *
 * Both engines implement `execute(prData, context, settings, options, onProgress)`
 * and must return an EngineResult. The orchestrator consumes that result through
 * `liftEngineFindings` below, which is the ONE place that understands both the
 * per-file-object shape (extension engine) and the flat-findings shape (backend
 * engine / stubs). Keeping it here means a change to the contract updates both
 * consumers at once.
 *
 * @typedef {Object} RawFinding
 * @property {string} [severity]  - free-form; normalized by reviewSchema.toCanonicalFinding
 * @property {string} [category]
 * @property {string} [file]
 * @property {number|string} [line]
 * @property {string} [title]
 * @property {string} [message]
 * @property {string} [suggestion]
 * @property {string} [rule]
 * @property {string} [source]
 *
 * @typedef {Object} PerFileResult
 * @property {string} [file]
 * @property {string} [language]
 * @property {string} [fileVerdict]
 * @property {string} [riskLevel]
 * @property {RawFinding[]} findings   - the presence of this array marks the per-file shape
 *
 * @typedef {Object} EngineResult
 * @property {string} [analysis]                      - deep-phase narrative
 * @property {(PerFileResult[]|RawFinding[])} perFileFindings
 * @property {Array} [failedFiles]
 * @property {{input:number, output:number}} [tokenUsage]
 */

/**
 * Normalize an engine's `perFileFindings` into a flat list of RawFinding.
 *
 * - Per-file-object shape (MultiPassReviewEngine): each element has a nested
 *   `findings` array; those are lifted out, inheriting the parent `file` when a
 *   finding omits it.
 * - Flat shape (BackendDeepEngine / stub engines): each element is already a
 *   finding and is passed through unchanged.
 *
 * @param {(PerFileResult[]|RawFinding[]|undefined)} perFileFindings
 * @returns {RawFinding[]}
 */
export function liftEngineFindings(perFileFindings) {
    const out = [];
    for (const item of perFileFindings ?? []) {
        if (!item || typeof item !== 'object') continue;
        if (Array.isArray(item.findings)) {
            for (const f of item.findings) {
                if (!f || typeof f !== 'object') continue;
                out.push({ ...f, file: f.file ?? item.file ?? null });
            }
        } else {
            out.push(item);
        }
    }
    return out;
}

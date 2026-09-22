/**
 * OffscreenLintService — service-worker-side client for AST linting.
 *
 * The tree-sitter WASM runtime can't load in the MV3 service worker, so the real
 * py/go lint engine runs in the shared offscreen document (same place as the code
 * graph and embeddings). This client ensures that document exists, ships file
 * contents in batches, and returns findings per file.
 *
 * Best-effort: any failure still lets review continue on the regex layer — the
 * AST lint is a progressive enhancement, never required.
 *
 * But "it ran and found nothing" and "it never ran" are different facts, and
 * returning a bare empty map for both made them indistinguishable to the caller.
 * That is the failure this project exists to stop: an unavailable check reading
 * as a clean one. So every abandonment path now names itself in `unavailable`,
 * and the caller reports it instead of inferring silence.
 */

const BATCH_SIZE = 30;
const MESSAGE_TIMEOUT_MS = 120000;
// Extended to the JS family once TreeSitterLintEngine gained JavaScript queries.
// The acorn engine in the worker cannot parse Flow or TypeScript annotations and
// returns `ok: false` for them, which the caller could not distinguish from a
// clean file — a planted `==` in a @flow-annotated .js went unreported although
// the eqeqeq rule was written and working.
const PY_GO = /\.(py|pyw|go|ts|tsx|js|jsx|mjs|cjs)$/i;

export class OffscreenLintService {
    constructor() {
        this.messageId = 300000; // distinct id space from embeddings/graph parser
    }

    /** True for files this engine handles (Python, Go, TypeScript, JavaScript). */
    static handles(filename) {
        return PY_GO.test(filename || '');
    }

    /**
     * @param {Array<{path:string, content:string}>} files
     * @returns {Promise<{findingsByFile: Map<string, Array>, unavailable: string|null, filesSubmitted: number}>}
     *   `unavailable` is null when the pass actually ran. When it is set, an empty
     *   `findingsByFile` means the check did not happen — never that the files are clean.
     */
    async lintFiles(files) {
        const out = new Map();
        const done = (unavailable = null, filesSubmitted = 0) =>
            ({ findingsByFile: out, unavailable, filesSubmitted });

        if (typeof chrome === 'undefined' || !chrome.offscreen) {
            return done('no offscreen API available in this context');
        }

        const parseable = (files || []).filter(f => f && f.content && OffscreenLintService.handles(f.path));
        // Nothing to do is not an outage: there was no work for this engine.
        if (parseable.length === 0) return done(null, 0);

        try {
            await this._ensureOffscreenDocument();
        } catch (e) {
            return done(`offscreen document could not be created: ${e?.message || 'unknown error'}`, parseable.length);
        }

        for (let i = 0; i < parseable.length; i += BATCH_SIZE) {
            const batch = parseable.slice(i, i + BATCH_SIZE);
            let response;
            try {
                response = await this._sendMessage({
                    type: 'TS_LINT_FILES',
                    files: batch.map(f => ({ path: f.path, content: f.content }))
                });
            } catch (e) {
                // Give up — the regex layer already covered these files — but say
                // which files were left unparsed rather than returning silence.
                return done(
                    `offscreen lint failed after ${i} of ${parseable.length} file(s): ${e?.message || 'unknown error'}`,
                    parseable.length,
                );
            }
            if (!response || !response.success) {
                return done(
                    `offscreen lint returned no result after ${i} of ${parseable.length} file(s)`,
                    parseable.length,
                );
            }
            for (const [path, findings] of Object.entries(response.findingsByFile || {})) {
                out.set(path, findings);
            }
        }
        return done(null, parseable.length);
    }

    async _ensureOffscreenDocument() {
        const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        if (existing.length > 0) return;
        try {
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['WORKERS'],
                justification: 'Run tree-sitter WASM for Python/Go AST lint'
            });
        } catch (err) {
            if (!String(err?.message).includes('single offscreen document')) throw err;
        }
    }

    _sendMessage(message) {
        return new Promise((resolve, reject) => {
            const messageId = this.messageId++;
            const timeout = setTimeout(() => reject(new Error('Offscreen lint timeout')), MESSAGE_TIMEOUT_MS);
            chrome.runtime.sendMessage({ ...message, messageId }, (response) => {
                clearTimeout(timeout);
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(response);
            });
        });
    }
}

export default OffscreenLintService;

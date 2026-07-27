/**
 * OffscreenLintService — service-worker-side client for Python/Go AST linting.
 *
 * The tree-sitter WASM runtime can't load in the MV3 service worker, so the real
 * py/go lint engine runs in the shared offscreen document (same place as the code
 * graph and embeddings). This client ensures that document exists, ships file
 * contents in batches, and returns findings per file.
 *
 * Best-effort: any failure resolves to an empty map so review continues on the
 * regex layer — the AST lint is a progressive enhancement, never required.
 */

const BATCH_SIZE = 30;
const MESSAGE_TIMEOUT_MS = 120000;
const PY_GO = /\.(py|pyw|go|ts|tsx)$/i;

export class OffscreenLintService {
    constructor() {
        this.messageId = 300000; // distinct id space from embeddings/graph parser
    }

    /** True for files this engine handles (Python/Go). */
    static handles(filename) {
        return PY_GO.test(filename || '');
    }

    /**
     * @param {Array<{path:string, content:string}>} files
     * @returns {Promise<Map<string, Array>>} filePath → findings (empty map on any failure)
     */
    async lintFiles(files) {
        const out = new Map();
        if (typeof chrome === 'undefined' || !chrome.offscreen) return out;

        const parseable = (files || []).filter(f => f && f.content && OffscreenLintService.handles(f.path));
        if (parseable.length === 0) return out;

        try {
            await this._ensureOffscreenDocument();
        } catch {
            return out;
        }

        for (let i = 0; i < parseable.length; i += BATCH_SIZE) {
            const batch = parseable.slice(i, i + BATCH_SIZE);
            let response;
            try {
                response = await this._sendMessage({
                    type: 'TS_LINT_FILES',
                    files: batch.map(f => ({ path: f.path, content: f.content }))
                });
            } catch {
                return out; // give up → regex fallback already covered the files
            }
            if (!response || !response.success) return out;
            for (const [path, findings] of Object.entries(response.findingsByFile || {})) {
                out.set(path, findings);
            }
        }
        return out;
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

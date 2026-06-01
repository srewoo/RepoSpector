/**
 * OffscreenGraphParser — service-worker-side client for tree-sitter parsing.
 *
 * MV3 service workers can't load the tree-sitter WASM runtime (classic worker,
 * no import.meta / dynamic import), so parsing runs in the shared offscreen
 * document (the same one used for embeddings). This client ensures that document
 * exists, ships file contents over in batches, and returns plain-JS analyses.
 *
 * Everything here is best-effort: any failure resolves to null so CodeGraphPipeline
 * transparently falls back to the regex extraction path.
 */

const BATCH_SIZE = 40;
const MESSAGE_TIMEOUT_MS = 120000;

export class OffscreenGraphParser {
    constructor() {
        this.messageId = 100000; // offset from OffscreenEmbeddingService's id space
        this.available = false;
    }

    /**
     * Analyse all files and return Map<filePath, {symbols, imports, calls, heritage}>,
     * or null if tree-sitter is unavailable in this environment.
     * @param {Array<{path: string, content: string}>} files
     * @param {(info: {done: number, total: number}) => void} [onProgress]
     */
    async analyzeFiles(files, onProgress) {
        if (typeof chrome === 'undefined' || !chrome.offscreen) return null;

        const parseable = files.filter(f => f && f.content);
        if (parseable.length === 0) return new Map();

        try {
            await this._ensureOffscreenDocument();
        } catch (_e) {
            return null;
        }

        const analyses = new Map();
        let anyAvailable = false;

        for (let i = 0; i < parseable.length; i += BATCH_SIZE) {
            const batch = parseable.slice(i, i + BATCH_SIZE);
            let response;
            try {
                response = await this._sendMessage({
                    type: 'TS_ANALYZE_FILES',
                    files: batch.map(f => ({ path: f.path, content: f.content }))
                });
            } catch (_e) {
                return analyses.size > 0 ? analyses : null; // partial or give up → regex fallback
            }

            if (!response || !response.success) {
                return analyses.size > 0 ? analyses : null;
            }
            if (response.available) anyAvailable = true;
            for (const [path, analysis] of Object.entries(response.analyses || {})) {
                analyses.set(path, analysis);
            }
            onProgress?.({ done: Math.min(i + BATCH_SIZE, parseable.length), total: parseable.length });
        }

        this.available = anyAvailable;
        return analyses;
    }

    async _ensureOffscreenDocument() {
        const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        if (existing.length > 0) return;
        try {
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['WORKERS'],
                justification: 'Run tree-sitter WASM for code graph parsing'
            });
        } catch (err) {
            // Race: another caller created it first — that's fine.
            if (!String(err?.message).includes('single offscreen document')) throw err;
        }
    }

    _sendMessage(message) {
        return new Promise((resolve, reject) => {
            const messageId = this.messageId++;
            const timeout = setTimeout(() => reject(new Error('Tree-sitter offscreen timeout')), MESSAGE_TIMEOUT_MS);
            chrome.runtime.sendMessage({ ...message, messageId }, (response) => {
                clearTimeout(timeout);
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(response);
            });
        });
    }
}

export default OffscreenGraphParser;

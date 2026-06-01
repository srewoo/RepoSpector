/**
 * GraphAnalysisCache for RepoSpector
 *
 * Persists, per repo, the inputs needed for incremental graph rebuilds:
 *   - fileHashes: { [filePath]: contentHash }  — to detect which files changed
 *   - tsAnalyses: { [filePath]: { symbols, imports, calls, heritage } }
 *       the (expensive) tree-sitter analyses, so unchanged files are NOT re-parsed
 *       in the offscreen document on the next build.
 *
 * Lives in its own IndexedDB database so it doesn't perturb the knowledge-graph
 * store's schema/version. Degrades gracefully (returns null / no-ops) when
 * IndexedDB is unavailable, so the pipeline simply does a full rebuild.
 */

const DB_NAME = 'repospector_graph_analysis';
const DB_VERSION = 1;
const STORE = 'analysis';

export class GraphAnalysisCache {
    constructor() {
        this.db = null;
    }

    async _open() {
        if (this.db) return this.db;
        if (typeof indexedDB === 'undefined') return null;
        this.db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'repoId' });
                }
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = () => reject(req.error);
        }).catch(() => null);
        return this.db;
    }

    /** @returns {Promise<{fileHashes: Object, tsAnalyses: Object}|null>} */
    async get(repoId) {
        try {
            const db = await this._open();
            if (!db) return null;
            return await new Promise((resolve, reject) => {
                const tx = db.transaction([STORE], 'readonly');
                const req = tx.objectStore(STORE).get(repoId);
                req.onsuccess = () => resolve(req.result ? { fileHashes: req.result.fileHashes || {}, tsAnalyses: req.result.tsAnalyses || {} } : null);
                req.onerror = () => reject(req.error);
            });
        } catch (_e) {
            return null;
        }
    }

    async set(repoId, { fileHashes, tsAnalyses }) {
        try {
            const db = await this._open();
            if (!db) return false;
            return await new Promise((resolve, reject) => {
                const tx = db.transaction([STORE], 'readwrite');
                tx.objectStore(STORE).put({ repoId, fileHashes: fileHashes || {}, tsAnalyses: tsAnalyses || {}, updatedAt: Date.now() });
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => reject(tx.error);
            });
        } catch (_e) {
            return false;
        }
    }

    async delete(repoId) {
        try {
            const db = await this._open();
            if (!db) return false;
            return await new Promise((resolve, reject) => {
                const tx = db.transaction([STORE], 'readwrite');
                tx.objectStore(STORE).delete(repoId);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => reject(tx.error);
            });
        } catch (_e) {
            return false;
        }
    }
}

export default GraphAnalysisCache;

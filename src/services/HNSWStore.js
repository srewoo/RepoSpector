/**
 * HNSWStore - IndexedDB persistence for HNSW graph indices
 *
 * Stores serialized HNSW graphs per repo to survive service worker restarts.
 * Follows the same pattern as BM25Store.
 */

import { HNSWIndex } from './HNSWIndex.js';

export class HNSWStore {
    constructor(dbName = 'RepoSpectorHNSW') {
        this.dbName = dbName;
        this.storeName = 'hnsw_graphs';
        this.db = null;
    }

    /**
     * Initialize the database
     */
    async init() {
        if (this.db) return this.db;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onerror = () => reject(request.error);

            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'repoId' });
                }
            };
        });
    }

    /**
     * Save an HNSW index for a repo
     */
    async save(repoId, hnswIndex) {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);

            const data = {
                repoId,
                graph: hnswIndex.toJSON(),
                size: hnswIndex.size,
                savedAt: Date.now()
            };

            const request = store.put(data);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                console.log(`💾 HNSW graph saved for ${repoId} (${hnswIndex.size} vectors)`);
                resolve();
            };
        });
    }

    /**
     * Load an HNSW index for a repo
     * @returns {HNSWIndex|null}
     */
    async load(repoId) {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(repoId);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                if (request.result?.graph) {
                    try {
                        const index = HNSWIndex.fromJSON(request.result.graph);
                        console.log(`📦 HNSW graph loaded for ${repoId} (${index.size} vectors, saved ${new Date(request.result.savedAt).toLocaleString()})`);
                        resolve(index);
                    } catch (e) {
                        console.warn('Failed to deserialize HNSW graph:', e);
                        resolve(null);
                    }
                } else {
                    resolve(null);
                }
            };
        });
    }

    /**
     * Delete an HNSW index
     */
    async delete(repoId) {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.delete(repoId);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(true);
        });
    }
}

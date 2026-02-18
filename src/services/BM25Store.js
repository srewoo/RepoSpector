/**
 * BM25Store - IndexedDB persistence for BM25 indices
 *
 * Stores serialized BM25 indices per repo to survive service worker restarts.
 * Follows the same pattern as ManifestStore in IndexManifest.js.
 */

import { BM25Index } from './BM25Index.js';

export class BM25Store {
    constructor(dbName = 'RepoSpectorBM25') {
        this.dbName = dbName;
        this.storeName = 'bm25_indices';
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
     * Save a BM25 index for a repo
     */
    async save(repoId, bm25Index) {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);

            const data = {
                repoId,
                index: bm25Index.toJSON(),
                savedAt: Date.now()
            };

            const request = store.put(data);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    /**
     * Load a BM25 index for a repo
     * @returns {BM25Index|null}
     */
    async load(repoId) {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(repoId);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                if (request.result?.index) {
                    try {
                        resolve(BM25Index.fromJSON(request.result.index));
                    } catch (e) {
                        console.warn('Failed to deserialize BM25 index:', e);
                        resolve(null);
                    }
                } else {
                    resolve(null);
                }
            };
        });
    }

    /**
     * Delete a BM25 index
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

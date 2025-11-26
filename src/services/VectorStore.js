/**
 * VectorStore service for storing and retrieving embeddings using IndexedDB
 */
export class VectorStore {
    constructor(storeName = 'repo_vectors') {
        this.dbName = 'RepoSpectorDB';
        this.storeName = storeName;
        this.version = 1;
        this.db = null;
    }

    /**
     * Initialize the database
     */
    async init() {
        if (this.db) return;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = (event) => {
                console.error('VectorStore DB error:', event.target.error);
                reject(event.target.error);
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
                    store.createIndex('repoId', 'repoId', { unique: false });
                    store.createIndex('filePath', 'filePath', { unique: false });
                }
            };
        });
    }

    /**
     * Add vectors to the store
     * @param {Array} vectors - Array of vector objects { id, repoId, filePath, content, embedding, metadata }
     */
    async addVectors(vectors) {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);

            transaction.oncomplete = () => resolve();
            transaction.onerror = (event) => reject(event.target.error);

            vectors.forEach(vector => {
                store.put(vector);
            });
        });
    }

    /**
     * Clear vectors for a specific repository
     * @param {string} repoId - Repository identifier (e.g., "owner/repo")
     */
    async clearRepo(repoId) {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('repoId');
            const request = index.getAllKeys(repoId);

            request.onsuccess = () => {
                const keys = request.result;
                if (keys.length === 0) {
                    resolve();
                    return;
                }

                let count = 0;
                keys.forEach(key => {
                    const deleteReq = store.delete(key);
                    deleteReq.onsuccess = () => {
                        count++;
                        if (count === keys.length) resolve();
                    };
                });
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Search for similar vectors using cosine similarity
     * Note: This is a naive implementation doing a full scan. 
     * For large datasets, we'd need a more efficient index or HNSW.
     * Given browser limits, this is acceptable for < 10k chunks.
     * @param {string} repoId - Repository to search in
     * @param {Array} queryEmbedding - Embedding vector of the query
     * @param {number} limit - Max results to return
     */
    async search(repoId, queryEmbedding, limit = 5) {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('repoId');
            const request = index.getAll(repoId);

            request.onsuccess = () => {
                const results = request.result;

                // Calculate similarity for each item
                const scoredResults = results.map(item => ({
                    ...item,
                    score: this.cosineSimilarity(queryEmbedding, item.embedding)
                }));

                // Sort by score descending
                scoredResults.sort((a, b) => b.score - a.score);

                // Return top N
                resolve(scoredResults.slice(0, limit));
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Calculate cosine similarity between two vectors
     */
    cosineSimilarity(vecA, vecB) {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }

        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /**
     * Check if a repository is indexed
     * @param {string} repoId
     * @returns {Promise<boolean>}
     */
    async isIndexed(repoId) {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('repoId');
            const countReq = index.count(repoId);

            countReq.onsuccess = () => {
                resolve(countReq.result > 0);
            };

            countReq.onerror = (e) => reject(e);
        });
    }

    /**
     * Get stats about the store
     */
    async getStats() {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const countReq = store.count();

            countReq.onsuccess = () => {
                resolve({
                    totalVectors: countReq.result
                });
            };

            countReq.onerror = (e) => reject(e);
        });
    }
}

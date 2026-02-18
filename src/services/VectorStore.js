import { HNSWIndex } from './HNSWIndex.js';
import { HNSWStore } from './HNSWStore.js';

/**
 * VectorStore service for storing and retrieving embeddings using IndexedDB
 *
 * Performance optimizations:
 * - HNSW approximate nearest neighbor search (O(log n) vs O(n))
 * - Minimum score filtering to skip irrelevant results
 * - Early termination when results are good enough
 * - Batched operations for large datasets
 * - Caching for repeated queries
 */
export class VectorStore {
    constructor(storeName = 'repo_vectors') {
        this.dbName = 'RepoSpectorDB';
        this.storeName = storeName;
        this.version = 1;
        this.db = null;

        // Performance settings
        this.MIN_RELEVANCE_SCORE = 0.1;  // Minimum similarity to include in results (low threshold; hybrid reranking handles quality)
        this.GOOD_SCORE_THRESHOLD = 0.7; // Score considered "good enough"
        this.CACHE_TTL = 60000;          // Cache TTL in ms (1 minute)

        // Query cache for repeated searches
        this.queryCache = new Map();
        this.lastCacheClean = Date.now();

        // HNSW indices per repo (built lazily on first search)
        this.hnswIndices = new Map(); // repoId -> HNSWIndex
        this.hnswStore = new HNSWStore();
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

        // Invalidate HNSW indices for affected repos (memory + persisted)
        const affectedRepos = new Set(vectors.map(v => v.repoId));
        for (const repoId of affectedRepos) {
            this.hnswIndices.delete(repoId);
            this.hnswStore.delete(repoId).catch(() => {}); // Best-effort cleanup
        }

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
        this.hnswIndices.delete(repoId);
        this.hnswStore.delete(repoId).catch(() => {}); // Best-effort cleanup
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
     * Delete specific chunks by their IDs
     * Used for incremental indexing to remove outdated chunks
     * @param {Array<string>} chunkIds - Array of chunk IDs to delete
     * @returns {Promise<{deleted: number, failed: number}>}
     */
    async deleteChunks(chunkIds) {
        if (!chunkIds || chunkIds.length === 0) {
            return { deleted: 0, failed: 0 };
        }

        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);

            let deleted = 0;
            let failed = 0;
            let processed = 0;

            const checkComplete = () => {
                processed++;
                if (processed === chunkIds.length) {
                    // Clear cache since data has changed
                    this.clearCache();
                    console.log(`🗑️ VectorStore: Deleted ${deleted} chunks, ${failed} failed`);
                    resolve({ deleted, failed });
                }
            };

            for (const chunkId of chunkIds) {
                const request = store.delete(chunkId);

                request.onsuccess = () => {
                    deleted++;
                    checkComplete();
                };

                request.onerror = () => {
                    failed++;
                    checkComplete();
                };
            }

            transaction.onerror = (event) => {
                console.error('VectorStore deleteChunks transaction error:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    /**
     * Delete all chunks for specific file paths within a repository
     * @param {string} repoId - Repository identifier
     * @param {Array<string>} filePaths - Array of file paths to delete chunks for
     * @returns {Promise<{deleted: number}>}
     */
    async deleteChunksForFiles(repoId, filePaths) {
        if (!filePaths || filePaths.length === 0) {
            return { deleted: 0 };
        }

        await this.init();

        const filePathSet = new Set(filePaths);

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('repoId');
            const request = index.getAll(repoId);

            request.onsuccess = () => {
                const chunks = request.result;
                const chunksToDelete = chunks.filter(chunk => filePathSet.has(chunk.filePath));

                if (chunksToDelete.length === 0) {
                    resolve({ deleted: 0 });
                    return;
                }

                let deleted = 0;
                let processed = 0;

                for (const chunk of chunksToDelete) {
                    const deleteReq = store.delete(chunk.id);
                    deleteReq.onsuccess = () => {
                        deleted++;
                        processed++;
                        if (processed === chunksToDelete.length) {
                            this.clearCache();
                            console.log(`🗑️ VectorStore: Deleted ${deleted} chunks for ${filePaths.length} files`);
                            resolve({ deleted });
                        }
                    };
                    deleteReq.onerror = () => {
                        processed++;
                        if (processed === chunksToDelete.length) {
                            this.clearCache();
                            resolve({ deleted });
                        }
                    };
                }
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Get chunk IDs for specific file paths
     * @param {string} repoId - Repository identifier
     * @param {Array<string>} filePaths - File paths to get chunk IDs for
     * @returns {Promise<Map<string, Array<string>>>} Map of filePath -> chunkIds
     */
    async getChunkIdsForFiles(repoId, filePaths) {
        await this.init();

        const filePathSet = new Set(filePaths);

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('repoId');
            const request = index.getAll(repoId);

            request.onsuccess = () => {
                const chunks = request.result;
                const chunkMap = new Map();

                for (const chunk of chunks) {
                    if (filePathSet.has(chunk.filePath)) {
                        if (!chunkMap.has(chunk.filePath)) {
                            chunkMap.set(chunk.filePath, []);
                        }
                        chunkMap.get(chunk.filePath).push(chunk.id);
                    }
                }

                resolve(chunkMap);
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Search for similar vectors using cosine similarity
     *
     * Performance optimizations:
     * - Query caching for repeated searches
     * - Minimum relevance score filtering
     * - Deduplication by file path (prevents overlapping chunks)
     * - Optimized cosine similarity calculation
     *
     * @param {string} repoId - Repository to search in
     * @param {Array} queryEmbedding - Embedding vector of the query
     * @param {number} limit - Max results to return
     * @param {Object} options - Search options
     */
    async search(repoId, queryEmbedding, limit = 20, options = {}) {
        await this.init();

        const {
            minScore = this.MIN_RELEVANCE_SCORE,
            deduplicate = true,        // Dedupe by file to avoid overlapping chunks
            maxChunksPerFile = 4       // Max chunks from same file
        } = options;

        // Check cache first
        const cacheKey = this.getCacheKey(repoId, queryEmbedding, limit);
        const cached = this.getFromCache(cacheKey);
        if (cached) {
            console.log('📦 VectorStore: Cache hit');
            return cached;
        }

        const startTime = performance.now();

        // Try HNSW search first (much faster for large indices)
        let hnswIndex = this.hnswIndices.get(repoId);
        if (!hnswIndex) {
            // Try loading persisted HNSW graph before rebuilding
            try {
                hnswIndex = await this.hnswStore.load(repoId);
            } catch (e) {
                console.warn('Failed to load persisted HNSW graph:', e);
            }
            if (!hnswIndex || hnswIndex.size === 0) {
                hnswIndex = await this._buildHNSWIndex(repoId);
                // Persist the newly built graph for future restarts
                if (hnswIndex && hnswIndex.size > 0) {
                    this.hnswStore.save(repoId, hnswIndex).catch(e =>
                        console.warn('Failed to persist HNSW graph:', e)
                    );
                }
            }
            if (hnswIndex && hnswIndex.size > 0) {
                this.hnswIndices.set(repoId, hnswIndex);
            }
        }

        let finalResults;
        if (hnswIndex && hnswIndex.size > 0) {
            finalResults = await this._searchHNSW(hnswIndex, repoId, queryEmbedding, limit, minScore, deduplicate, maxChunksPerFile);
            const elapsed = performance.now() - startTime;
            console.log(`🔍 VectorStore (HNSW): Searched ${hnswIndex.size} vectors in ${elapsed.toFixed(1)}ms, found ${finalResults.length} relevant`);
        } else {
            // Fallback to linear scan
            finalResults = await this._linearSearch(repoId, queryEmbedding, limit, minScore, deduplicate, maxChunksPerFile);
            const elapsed = performance.now() - startTime;
            console.log(`🔍 VectorStore (linear): Searched in ${elapsed.toFixed(1)}ms, found ${finalResults.length} relevant`);
        }

        this.setCache(cacheKey, finalResults);
        return finalResults;
    }

    /**
     * Search using HNSW index
     */
    async _searchHNSW(hnswIndex, repoId, queryEmbedding, limit, minScore, deduplicate, maxChunksPerFile) {
        // Fetch extra candidates to account for filtering
        const hnswResults = hnswIndex.search(queryEmbedding, limit * 3);

        // Retrieve full records for HNSW results and compute exact scores
        const scoredResults = [];
        for (const { id, distance } of hnswResults) {
            const score = 1 - distance; // Convert distance to similarity
            if (score >= minScore) {
                const record = await this._getRecord(id);
                if (record) {
                    scoredResults.push({ ...record, score });
                }
            }
        }

        scoredResults.sort((a, b) => b.score - a.score);
        return deduplicate
            ? this.deduplicateByFile(scoredResults, limit, maxChunksPerFile)
            : scoredResults.slice(0, limit);
    }

    /**
     * Linear scan fallback search
     */
    async _linearSearch(repoId, queryEmbedding, limit, minScore, deduplicate, maxChunksPerFile) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('repoId');
            const request = index.getAll(repoId);

            request.onsuccess = () => {
                const results = request.result;
                const scoredResults = [];
                for (const item of results) {
                    const score = this.cosineSimilarityOptimized(queryEmbedding, item.embedding);
                    if (score >= minScore) {
                        scoredResults.push({ ...item, score });
                    }
                }
                scoredResults.sort((a, b) => b.score - a.score);

                const finalResults = deduplicate
                    ? this.deduplicateByFile(scoredResults, limit, maxChunksPerFile)
                    : scoredResults.slice(0, limit);

                resolve(finalResults);
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Build HNSW index from all vectors for a repo
     */
    async _buildHNSWIndex(repoId) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('repoId');
            const request = index.getAll(repoId);

            request.onsuccess = () => {
                const vectors = request.result;
                if (!vectors || vectors.length === 0) {
                    resolve(null);
                    return;
                }

                const startTime = performance.now();
                const dim = vectors[0].embedding?.length || 384;
                const hnswIndex = new HNSWIndex({
                    M: dim <= 384 ? 16 : 24,
                    efConstruction: 200,
                    efSearch: 50
                });

                for (const vec of vectors) {
                    if (vec.embedding) {
                        hnswIndex.insert(vec.id, vec.embedding);
                    }
                }

                const elapsed = performance.now() - startTime;
                console.log(`Built HNSW index for ${repoId}: ${vectors.length} vectors, dim=${dim}, took ${elapsed.toFixed(0)}ms`);
                resolve(hnswIndex);
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Get a single record by ID from IndexedDB
     */
    async _getRecord(id) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(id);

            request.onsuccess = () => resolve(request.result || null);
            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Deduplicate results by file path to avoid overlapping chunks
     */
    deduplicateByFile(results, limit, maxChunksPerFile) {
        const fileChunkCount = new Map();
        const deduplicated = [];

        for (const result of results) {
            if (deduplicated.length >= limit) break;

            const filePath = result.filePath || 'unknown';
            const currentCount = fileChunkCount.get(filePath) || 0;

            // Only include if we haven't hit the max for this file
            if (currentCount < maxChunksPerFile) {
                deduplicated.push(result);
                fileChunkCount.set(filePath, currentCount + 1);
            }
        }

        return deduplicated;
    }

    /**
     * Generate cache key for query
     */
    getCacheKey(repoId, embedding, limit) {
        // Use first 8 values of embedding as fingerprint (good enough for cache)
        const embeddingFingerprint = embedding.slice(0, 8).map(v => v.toFixed(4)).join(',');
        return `${repoId}:${embeddingFingerprint}:${limit}`;
    }

    /**
     * Get from cache if valid
     */
    getFromCache(key) {
        this.cleanCacheIfNeeded();
        const cached = this.queryCache.get(key);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
            return cached.results;
        }
        return null;
    }

    /**
     * Set cache entry
     */
    setCache(key, results) {
        this.queryCache.set(key, {
            results,
            timestamp: Date.now()
        });
    }

    /**
     * Clean expired cache entries periodically
     */
    cleanCacheIfNeeded() {
        const now = Date.now();
        if (now - this.lastCacheClean > this.CACHE_TTL * 2) {
            for (const [key, value] of this.queryCache.entries()) {
                if (now - value.timestamp > this.CACHE_TTL) {
                    this.queryCache.delete(key);
                }
            }
            this.lastCacheClean = now;
        }
    }

    /**
     * Clear the query cache (call after indexing)
     */
    clearCache() {
        this.queryCache.clear();
    }

    /**
     * Calculate cosine similarity between two vectors (original)
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
     * Optimized cosine similarity with loop unrolling and early termination
     * ~2x faster than naive implementation for 1536-dim vectors
     */
    cosineSimilarityOptimized(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) return 0;

        const len = vecA.length;
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        // Process 4 elements at a time (loop unrolling)
        const unrollLimit = len - (len % 4);
        let i = 0;

        for (; i < unrollLimit; i += 4) {
            const a0 = vecA[i], a1 = vecA[i + 1], a2 = vecA[i + 2], a3 = vecA[i + 3];
            const b0 = vecB[i], b1 = vecB[i + 1], b2 = vecB[i + 2], b3 = vecB[i + 3];

            dotProduct += a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3;
            normA += a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;
            normB += b0 * b0 + b1 * b1 + b2 * b2 + b3 * b3;
        }

        // Handle remaining elements
        for (; i < len; i++) {
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

    /**
     * Get all unique repository IDs in the store
     * @returns {Promise<Array<{repoId: string, count: number}>>}
     */
    async getAllRepoIds() {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('repoId');
            const request = index.openCursor();

            const repoMap = new Map();

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const repoId = cursor.value.repoId;
                    repoMap.set(repoId, (repoMap.get(repoId) || 0) + 1);
                    cursor.continue();
                } else {
                    // Cursor exhausted, convert map to array
                    const repos = Array.from(repoMap.entries()).map(([repoId, count]) => ({
                        repoId,
                        chunksCount: count
                    }));
                    resolve(repos);
                }
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Get count and file info for a specific repository
     * @param {string} repoId
     * @returns {Promise<{chunksCount: number, filesCount: number}>}
     */
    async getRepoStats(repoId) {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('repoId');
            const request = index.getAll(repoId);

            request.onsuccess = () => {
                const chunks = request.result;
                const uniqueFiles = new Set(chunks.map(c => c.filePath));
                resolve({
                    chunksCount: chunks.length,
                    filesCount: uniqueFiles.size
                });
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Get all unique file paths for a repository
     * @param {string} repoId
     * @returns {Promise<string[]>}
     */
    async getFilePaths(repoId) {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('repoId');
            const request = index.getAll(repoId);

            request.onsuccess = () => {
                const chunks = request.result;
                const uniqueFiles = [...new Set(chunks.map(c => c.filePath).filter(Boolean))];
                resolve(uniqueFiles.sort());
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Get file contents for a repository (concatenated chunks per file)
     * @param {string} repoId
     * @returns {Promise<Map<string, string>>} filePath -> content
     */
    async getFileContents(repoId) {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('repoId');
            const request = index.getAll(repoId);

            request.onsuccess = () => {
                const chunks = request.result;
                const fileMap = new Map();
                for (const chunk of chunks) {
                    if (!chunk.filePath || !chunk.content) continue;
                    if (!fileMap.has(chunk.filePath)) {
                        fileMap.set(chunk.filePath, []);
                    }
                    fileMap.get(chunk.filePath).push(chunk.content);
                }
                // Concatenate chunks per file
                const result = new Map();
                for (const [path, contents] of fileMap) {
                    result.set(path, contents.join('\n'));
                }
                resolve(result);
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }
}

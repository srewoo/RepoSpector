/**
 * Hybrid Searcher for RepoSpector
 *
 * Combines BM25 keyword search with vector semantic search
 * using Reciprocal Rank Fusion (RRF) for optimal results.
 */

import { BM25Index } from './BM25Index.js';

/**
 * Default configuration
 */
const DEFAULT_CONFIG = {
    // RRF parameters
    rrfK: 60,                    // Ranking constant (standard is 60)
    semanticWeight: 0.6,         // Weight for semantic search
    keywordWeight: 0.4,          // Weight for keyword search

    // Search parameters
    defaultLimit: 10,
    expandedLimit: 50,           // Fetch more from each source for better fusion

    // Scoring boosts
    exactMatchBoost: 1.5,        // Boost for exact query match
    filenameMatchBoost: 1.3,     // Boost for filename matches
    recentBoost: 1.1,            // Boost for recently modified files
    codeStructureBoost: 1.2,     // Boost for class/function definitions

    // Filtering
    minScore: 0.01,
    diversityRadius: 0.85        // Minimum cosine distance for diversity
};

/**
 * Hybrid Searcher class
 */
export class HybridSearcher {
    constructor(options = {}) {
        this.config = { ...DEFAULT_CONFIG, ...options };

        // BM25 index (keyword search)
        this.bm25Index = new BM25Index(options.bm25Config);

        // Vector store reference (set via setVectorStore)
        this.vectorStore = null;

        // Cache for recent searches
        this.searchCache = new Map();
        this.cacheMaxSize = 100;
        this.cacheTTL = 5 * 60 * 1000; // 5 minutes
    }

    /**
     * Set the vector store for semantic search
     */
    setVectorStore(vectorStore) {
        this.vectorStore = vectorStore;
    }

    /**
     * Index a document for both keyword and semantic search
     */
    async indexDocument(docId, content, metadata = {}) {
        // Add to BM25 index
        this.bm25Index.addDocument(docId, content, metadata);

        // Vector indexing is handled separately by VectorStore
        // This method assumes the document is already in the vector store
    }

    /**
     * Remove a document from the index
     */
    removeDocument(docId) {
        return this.bm25Index.removeDocument(docId);
    }

    /**
     * Perform hybrid search
     */
    async search(query, repoId, options = {}) {
        const {
            limit = this.config.defaultLimit,
            useSemanticSearch = true,
            useKeywordSearch = true,
            filters = null,
            boostFactors = {}
        } = options;

        // Check cache
        const cacheKey = this.getCacheKey(query, repoId, options);
        const cached = this.getFromCache(cacheKey);
        if (cached) {
            return cached;
        }

        const results = [];
        const expandedLimit = this.config.expandedLimit;

        // Perform keyword search (BM25)
        let keywordResults = [];
        if (useKeywordSearch) {
            keywordResults = this.bm25Index.search(query, {
                limit: expandedLimit,
                filters
            });
        }

        // Perform semantic search (Vector)
        let semanticResults = [];
        if (useSemanticSearch && this.vectorStore) {
            try {
                semanticResults = await this.vectorStore.search(
                    repoId,
                    query,
                    expandedLimit,
                    { filters }
                );
            } catch (error) {
                console.warn('Semantic search failed, falling back to keyword only:', error);
            }
        }

        // Fuse results using RRF
        const fusedResults = this.fuseResults(
            keywordResults,
            semanticResults,
            query,
            boostFactors
        );

        // Apply diversity filter
        const diverseResults = this.applyDiversityFilter(fusedResults);

        // Limit and format results
        const finalResults = diverseResults.slice(0, limit).map(result => ({
            docId: result.docId,
            score: result.fusedScore,
            content: result.content,
            metadata: result.metadata,
            matchInfo: {
                keywordRank: result.keywordRank,
                semanticRank: result.semanticRank,
                keywordScore: result.keywordScore,
                semanticScore: result.semanticScore,
                boosts: result.boosts
            }
        }));

        // Cache results
        this.addToCache(cacheKey, finalResults);

        return finalResults;
    }

    /**
     * Fuse keyword and semantic results using RRF
     */
    fuseResults(keywordResults, semanticResults, query, boostFactors = {}) {
        const { rrfK, semanticWeight, keywordWeight } = this.config;
        const fusedMap = new Map();

        // Process keyword results
        keywordResults.forEach((result, rank) => {
            const docId = result.docId;
            const doc = this.bm25Index.getDocument(docId);

            if (!fusedMap.has(docId)) {
                fusedMap.set(docId, {
                    docId,
                    content: doc?.content || '',
                    metadata: doc?.metadata || result.metadata || {},
                    keywordRank: null,
                    semanticRank: null,
                    keywordScore: 0,
                    semanticScore: 0,
                    fusedScore: 0,
                    boosts: []
                });
            }

            const entry = fusedMap.get(docId);
            entry.keywordRank = rank + 1;
            entry.keywordScore = result.score;
        });

        // Process semantic results
        semanticResults.forEach((result, rank) => {
            const docId = result.id || result.docId;

            if (!fusedMap.has(docId)) {
                fusedMap.set(docId, {
                    docId,
                    content: result.content || result.text || '',
                    metadata: result.metadata || {},
                    keywordRank: null,
                    semanticRank: null,
                    keywordScore: 0,
                    semanticScore: 0,
                    fusedScore: 0,
                    boosts: []
                });
            }

            const entry = fusedMap.get(docId);
            entry.semanticRank = rank + 1;
            entry.semanticScore = result.similarity || result.score || 0;
        });

        // Calculate RRF scores
        for (const [docId, entry] of fusedMap) {
            // RRF formula: 1 / (k + rank)
            const keywordRRF = entry.keywordRank
                ? keywordWeight / (rrfK + entry.keywordRank)
                : 0;
            const semanticRRF = entry.semanticRank
                ? semanticWeight / (rrfK + entry.semanticRank)
                : 0;

            entry.fusedScore = keywordRRF + semanticRRF;

            // Apply boosts
            const boosts = this.calculateBoosts(entry, query, boostFactors);
            entry.boosts = boosts;

            for (const { factor, reason } of boosts) {
                entry.fusedScore *= factor;
            }
        }

        // Sort by fused score
        return Array.from(fusedMap.values())
            .sort((a, b) => b.fusedScore - a.fusedScore);
    }

    /**
     * Calculate boost factors for a result
     */
    calculateBoosts(entry, query, customBoosts = {}) {
        const boosts = [];
        const content = entry.content?.toLowerCase() || '';
        const queryLower = query.toLowerCase();
        const metadata = entry.metadata || {};

        // Exact match boost
        if (content.includes(queryLower) ||
            content.includes(query)) {
            boosts.push({
                factor: customBoosts.exactMatch || this.config.exactMatchBoost,
                reason: 'exact_match'
            });
        }

        // Filename match boost
        const filePath = metadata.filePath || '';
        const fileName = filePath.split('/').pop()?.toLowerCase() || '';
        const queryTerms = queryLower.split(/\s+/);

        if (queryTerms.some(term => fileName.includes(term))) {
            boosts.push({
                factor: customBoosts.filenameMatch || this.config.filenameMatchBoost,
                reason: 'filename_match'
            });
        }

        // Code structure boost (class/function definitions)
        if (metadata.type === 'class' || metadata.type === 'function' ||
            /^(class|function|def|const|export)\s/.test(content)) {
            boosts.push({
                factor: customBoosts.codeStructure || this.config.codeStructureBoost,
                reason: 'code_structure'
            });
        }

        // Recency boost
        if (metadata.lastModified) {
            const age = Date.now() - new Date(metadata.lastModified).getTime();
            const oneWeek = 7 * 24 * 60 * 60 * 1000;
            if (age < oneWeek) {
                boosts.push({
                    factor: customBoosts.recent || this.config.recentBoost,
                    reason: 'recently_modified'
                });
            }
        }

        return boosts;
    }

    /**
     * Apply diversity filter to remove near-duplicate results
     */
    applyDiversityFilter(results) {
        if (results.length <= 1) return results;

        const diverse = [results[0]];
        const seen = new Set([results[0].docId]);

        for (let i = 1; i < results.length; i++) {
            const candidate = results[i];

            // Check if too similar to existing results
            let isDiverse = true;

            for (const existing of diverse) {
                // Simple content similarity check
                const similarity = this.calculateContentSimilarity(
                    candidate.content,
                    existing.content
                );

                if (similarity > this.config.diversityRadius) {
                    isDiverse = false;
                    break;
                }
            }

            if (isDiverse && !seen.has(candidate.docId)) {
                diverse.push(candidate);
                seen.add(candidate.docId);
            }
        }

        return diverse;
    }

    /**
     * Calculate simple content similarity (Jaccard-like)
     */
    calculateContentSimilarity(content1, content2) {
        if (!content1 || !content2) return 0;

        const tokens1 = new Set(content1.toLowerCase().split(/\s+/));
        const tokens2 = new Set(content2.toLowerCase().split(/\s+/));

        const intersection = new Set([...tokens1].filter(t => tokens2.has(t)));
        const union = new Set([...tokens1, ...tokens2]);

        return intersection.size / union.size;
    }

    /**
     * Get cache key
     */
    getCacheKey(query, repoId, options) {
        return `${repoId}:${query}:${JSON.stringify(options)}`;
    }

    /**
     * Get from cache
     */
    getFromCache(key) {
        const entry = this.searchCache.get(key);
        if (!entry) return null;

        if (Date.now() - entry.timestamp > this.cacheTTL) {
            this.searchCache.delete(key);
            return null;
        }

        return entry.results;
    }

    /**
     * Add to cache
     */
    addToCache(key, results) {
        // Evict oldest if at capacity
        if (this.searchCache.size >= this.cacheMaxSize) {
            const oldestKey = this.searchCache.keys().next().value;
            this.searchCache.delete(oldestKey);
        }

        this.searchCache.set(key, {
            results,
            timestamp: Date.now()
        });
    }

    /**
     * Clear cache
     */
    clearCache() {
        this.searchCache.clear();
    }

    /**
     * Get BM25 index stats
     */
    getKeywordIndexStats() {
        return this.bm25Index.getStats();
    }

    /**
     * Export BM25 index for persistence
     */
    exportBM25Index() {
        return this.bm25Index.toJSON();
    }

    /**
     * Import BM25 index from persistence
     */
    importBM25Index(json) {
        this.bm25Index = BM25Index.fromJSON(json);
    }

    /**
     * Clear all indices
     */
    clear() {
        this.bm25Index.clear();
        this.clearCache();
    }
}

/**
 * Create a configured hybrid searcher
 */
export function createHybridSearcher(options = {}) {
    return new HybridSearcher(options);
}

export default HybridSearcher;

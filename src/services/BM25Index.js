/**
 * BM25 Index for RepoSpector
 *
 * Implements BM25 (Best Match 25) ranking algorithm for keyword-based search.
 * Uses an inverted index for efficient term lookup.
 */

/**
 * Default BM25 parameters
 */
const DEFAULT_CONFIG = {
    k1: 1.5,      // Term frequency saturation parameter
    b: 0.75,      // Length normalization parameter
    delta: 0.5,   // BM25+ delta for handling short documents
    minTokenLength: 2,
    maxTokenLength: 50,
    stopWords: new Set([
        'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
        'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the',
        'to', 'was', 'were', 'will', 'with', 'the', 'this', 'but', 'they',
        'have', 'had', 'what', 'when', 'where', 'who', 'which', 'why', 'how',
        'or', 'if', 'then', 'else', 'do', 'does', 'did', 'can', 'could',
        'would', 'should', 'may', 'might', 'must', 'shall', 'will', 'not',
        'no', 'yes', 'all', 'any', 'both', 'each', 'few', 'more', 'most',
        'other', 'some', 'such', 'only', 'own', 'same', 'so', 'than', 'too',
        'very', 'just', 'also', 'now', 'here', 'there', 'new', 'old'
    ])
};

/**
 * Code-specific stop words
 */
const CODE_STOP_WORDS = new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for',
    'while', 'do', 'switch', 'case', 'break', 'continue', 'default',
    'try', 'catch', 'finally', 'throw', 'class', 'extends', 'new',
    'this', 'super', 'import', 'export', 'from', 'async', 'await',
    'true', 'false', 'null', 'undefined', 'typeof', 'instanceof',
    'void', 'delete', 'in', 'of', 'with', 'yield', 'static', 'public',
    'private', 'protected', 'interface', 'type', 'enum', 'implements'
]);

/**
 * BM25 Index class
 */
export class BM25Index {
    constructor(options = {}) {
        this.config = { ...DEFAULT_CONFIG, ...options };

        // Document store: Map<docId, { content, tokens, length, metadata }>
        this.documents = new Map();

        // Inverted index: Map<term, Map<docId, { tf, positions }>>
        this.invertedIndex = new Map();

        // Document frequency: Map<term, count>
        this.documentFrequency = new Map();

        // Statistics
        this.totalDocuments = 0;
        this.averageDocumentLength = 0;
        this.totalTokens = 0;
    }

    /**
     * Tokenize text into terms
     */
    tokenize(text, options = {}) {
        const { isCode = false, preserveCase = false } = options;

        if (!text || typeof text !== 'string') {
            return [];
        }

        let processed = text;

        // Handle code-specific tokenization
        if (isCode) {
            // Split on camelCase and snake_case
            processed = processed
                .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase
                .replace(/_/g, ' ')                     // snake_case
                .replace(/\./g, ' ')                    // dot notation
                .replace(/[{}()\[\];:,]/g, ' ');       // punctuation
        }

        // Convert to lowercase unless preserving case
        if (!preserveCase) {
            processed = processed.toLowerCase();
        }

        // Split into tokens
        const tokens = processed
            .split(/\s+/)
            .filter(token => {
                // Filter by length
                if (token.length < this.config.minTokenLength) return false;
                if (token.length > this.config.maxTokenLength) return false;

                // Filter pure numbers (but keep alphanumeric)
                if (/^\d+$/.test(token)) return false;

                // Filter stop words
                const lowerToken = token.toLowerCase();
                if (this.config.stopWords.has(lowerToken)) return false;
                if (isCode && CODE_STOP_WORDS.has(lowerToken)) return false;

                return true;
            })
            .map(token => {
                // Stem simple suffixes
                return this.simpleStem(token.toLowerCase());
            });

        return tokens;
    }

    /**
     * Simple stemming (Porter-like, simplified)
     */
    simpleStem(word) {
        // Handle common suffixes
        if (word.length > 7 && word.endsWith('ization')) {
            return word.slice(0, -7) + 'ize';
        }
        if (word.length > 5 && word.endsWith('ation')) {
            return word.slice(0, -5) + 'ate';
        }
        if (word.length > 4 && word.endsWith('ing')) {
            const stem = word.slice(0, -3);
            if (stem.length >= 3) return stem;
        }
        if (word.length > 4 && word.endsWith('ies')) {
            return word.slice(0, -3) + 'y';
        }
        if (word.length > 3 && word.endsWith('es')) {
            const stem = word.slice(0, -2);
            if (stem.length >= 2 && !/[sxz]$/.test(stem) && !/[cs]h$/.test(stem)) {
                return stem;
            }
        }
        if (word.length > 3 && word.endsWith('ed')) {
            const stem = word.slice(0, -2);
            if (stem.length >= 2) return stem;
        }
        if (word.length > 3 && word.endsWith('ly')) {
            return word.slice(0, -2);
        }
        if (word.length > 4 && word.endsWith('ness')) {
            return word.slice(0, -4);
        }
        if (word.length > 4 && word.endsWith('ment')) {
            return word.slice(0, -4);
        }
        if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) {
            return word.slice(0, -1);
        }

        return word;
    }

    /**
     * Add a document to the index
     */
    addDocument(docId, content, metadata = {}) {
        const isCode = metadata.isCode !== false;
        const tokens = this.tokenize(content, { isCode });

        if (tokens.length === 0) {
            return;
        }

        // Store document
        this.documents.set(docId, {
            content,
            tokens,
            length: tokens.length,
            metadata
        });

        // Build term frequency map with positions
        const termFrequency = new Map();
        tokens.forEach((token, position) => {
            if (!termFrequency.has(token)) {
                termFrequency.set(token, { tf: 0, positions: [] });
            }
            const entry = termFrequency.get(token);
            entry.tf++;
            entry.positions.push(position);
        });

        // Update inverted index
        for (const [term, data] of termFrequency) {
            if (!this.invertedIndex.has(term)) {
                this.invertedIndex.set(term, new Map());
            }
            this.invertedIndex.get(term).set(docId, data);

            // Update document frequency
            this.documentFrequency.set(
                term,
                (this.documentFrequency.get(term) || 0) + 1
            );
        }

        // Update statistics
        this.totalDocuments++;
        this.totalTokens += tokens.length;
        this.averageDocumentLength = this.totalTokens / this.totalDocuments;
    }

    /**
     * Remove a document from the index
     */
    removeDocument(docId) {
        const doc = this.documents.get(docId);
        if (!doc) return false;

        // Update inverted index
        const tokens = new Set(doc.tokens);
        for (const token of tokens) {
            const postings = this.invertedIndex.get(token);
            if (postings) {
                postings.delete(docId);

                // Update document frequency
                const df = this.documentFrequency.get(token) - 1;
                if (df <= 0) {
                    this.documentFrequency.delete(token);
                    this.invertedIndex.delete(token);
                } else {
                    this.documentFrequency.set(token, df);
                }
            }
        }

        // Update statistics
        this.totalDocuments--;
        this.totalTokens -= doc.length;
        this.averageDocumentLength = this.totalDocuments > 0
            ? this.totalTokens / this.totalDocuments
            : 0;

        // Remove from document store
        this.documents.delete(docId);
        return true;
    }

    /**
     * Calculate IDF (Inverse Document Frequency)
     */
    calculateIDF(term) {
        const df = this.documentFrequency.get(term) || 0;
        if (df === 0) return 0;

        // IDF with smoothing
        return Math.log((this.totalDocuments - df + 0.5) / (df + 0.5) + 1);
    }

    /**
     * Calculate BM25 score for a document
     */
    calculateBM25Score(docId, queryTerms) {
        const doc = this.documents.get(docId);
        if (!doc) return 0;

        const { k1, b, delta } = this.config;
        let score = 0;

        for (const term of queryTerms) {
            const postings = this.invertedIndex.get(term);
            if (!postings || !postings.has(docId)) continue;

            const { tf } = postings.get(docId);
            const idf = this.calculateIDF(term);

            // BM25+ formula
            const lengthNorm = 1 - b + b * (doc.length / this.averageDocumentLength);
            const tfNorm = ((k1 + 1) * tf) / (k1 * lengthNorm + tf);

            score += idf * (tfNorm + delta);
        }

        return score;
    }

    /**
     * Search the index
     */
    search(query, options = {}) {
        const {
            limit = 10,
            minScore = 0,
            includePositions = false,
            filters = null
        } = options;

        // Tokenize query
        const queryTerms = this.tokenize(query, { isCode: true });

        if (queryTerms.length === 0) {
            return [];
        }

        // Find candidate documents (documents containing at least one query term)
        const candidateDocs = new Set();
        for (const term of queryTerms) {
            const postings = this.invertedIndex.get(term);
            if (postings) {
                for (const docId of postings.keys()) {
                    candidateDocs.add(docId);
                }
            }
        }

        // Score candidates
        const results = [];
        for (const docId of candidateDocs) {
            const doc = this.documents.get(docId);

            // Apply filters
            if (filters) {
                if (filters.language && doc.metadata.language !== filters.language) {
                    continue;
                }
                if (filters.filePath && !doc.metadata.filePath?.includes(filters.filePath)) {
                    continue;
                }
            }

            const score = this.calculateBM25Score(docId, queryTerms);

            if (score >= minScore) {
                const result = {
                    docId,
                    score,
                    metadata: doc.metadata
                };

                // Include term positions if requested
                if (includePositions) {
                    result.termPositions = {};
                    for (const term of queryTerms) {
                        const postings = this.invertedIndex.get(term);
                        if (postings && postings.has(docId)) {
                            result.termPositions[term] = postings.get(docId).positions;
                        }
                    }
                }

                results.push(result);
            }
        }

        // Sort by score (descending) and limit
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, limit);
    }

    /**
     * Get document by ID
     */
    getDocument(docId) {
        return this.documents.get(docId);
    }

    /**
     * Get all terms in the index
     */
    getTerms() {
        return Array.from(this.invertedIndex.keys());
    }

    /**
     * Get term statistics
     */
    getTermStats(term) {
        const postings = this.invertedIndex.get(term);
        if (!postings) return null;

        return {
            term,
            documentFrequency: this.documentFrequency.get(term) || 0,
            idf: this.calculateIDF(term),
            documentCount: postings.size
        };
    }

    /**
     * Get index statistics
     */
    getStats() {
        return {
            totalDocuments: this.totalDocuments,
            totalTokens: this.totalTokens,
            uniqueTerms: this.invertedIndex.size,
            averageDocumentLength: this.averageDocumentLength
        };
    }

    /**
     * Export index to JSON (for persistence)
     */
    toJSON() {
        return {
            config: this.config,
            documents: Array.from(this.documents.entries()).map(([id, doc]) => ({
                id,
                content: doc.content,
                tokens: doc.tokens,
                length: doc.length,
                metadata: doc.metadata
            })),
            invertedIndex: Array.from(this.invertedIndex.entries()).map(([term, postings]) => ({
                term,
                postings: Array.from(postings.entries()).map(([docId, data]) => ({
                    docId,
                    tf: data.tf,
                    positions: data.positions
                }))
            })),
            documentFrequency: Array.from(this.documentFrequency.entries()),
            stats: {
                totalDocuments: this.totalDocuments,
                averageDocumentLength: this.averageDocumentLength,
                totalTokens: this.totalTokens
            }
        };
    }

    /**
     * Import index from JSON
     */
    static fromJSON(json) {
        const index = new BM25Index(json.config);

        // Restore documents
        for (const doc of json.documents) {
            index.documents.set(doc.id, {
                content: doc.content,
                tokens: doc.tokens,
                length: doc.length,
                metadata: doc.metadata
            });
        }

        // Restore inverted index
        for (const { term, postings } of json.invertedIndex) {
            const postingsMap = new Map();
            for (const { docId, tf, positions } of postings) {
                postingsMap.set(docId, { tf, positions });
            }
            index.invertedIndex.set(term, postingsMap);
        }

        // Restore document frequency
        for (const [term, count] of json.documentFrequency) {
            index.documentFrequency.set(term, count);
        }

        // Restore stats
        index.totalDocuments = json.stats.totalDocuments;
        index.averageDocumentLength = json.stats.averageDocumentLength;
        index.totalTokens = json.stats.totalTokens;

        return index;
    }

    /**
     * Clear the index
     */
    clear() {
        this.documents.clear();
        this.invertedIndex.clear();
        this.documentFrequency.clear();
        this.totalDocuments = 0;
        this.averageDocumentLength = 0;
        this.totalTokens = 0;
    }
}

export default BM25Index;

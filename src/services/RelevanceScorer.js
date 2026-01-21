/**
 * Relevance Scorer for RepoSpector
 *
 * Multi-signal scoring system for ranking search results
 * based on semantic similarity, keyword match, recency,
 * code structure, and other contextual factors.
 */

/**
 * Default scoring weights
 */
const DEFAULT_WEIGHTS = {
    semantic: 0.35,           // Semantic/vector similarity
    keyword: 0.25,            // BM25/keyword match
    exactMatch: 0.15,         // Exact string match
    structure: 0.10,          // Code structure (class, function, etc.)
    recency: 0.05,            // Recently modified
    fileRelevance: 0.05,      // Filename/path relevance
    popularity: 0.05          // Usage/reference count
};

/**
 * Code structure type scores
 */
const STRUCTURE_SCORES = {
    'class': 1.0,
    'interface': 0.9,
    'function': 0.85,
    'method': 0.8,
    'constant': 0.6,
    'variable': 0.4,
    'import': 0.3,
    'comment': 0.2,
    'other': 0.1
};

/**
 * File type relevance scores
 */
const FILE_TYPE_SCORES = {
    // Source code
    'js': 1.0,
    'ts': 1.0,
    'jsx': 1.0,
    'tsx': 1.0,
    'py': 1.0,
    'java': 1.0,
    'go': 1.0,
    'rs': 1.0,
    'cpp': 1.0,
    'c': 1.0,

    // Web
    'vue': 0.9,
    'svelte': 0.9,
    'html': 0.7,
    'css': 0.6,
    'scss': 0.6,

    // Config/Data
    'json': 0.5,
    'yaml': 0.5,
    'yml': 0.5,
    'toml': 0.4,
    'xml': 0.4,

    // Documentation
    'md': 0.3,
    'txt': 0.2
};

/**
 * Relevance Scorer class
 */
export class RelevanceScorer {
    constructor(options = {}) {
        this.weights = { ...DEFAULT_WEIGHTS, ...options.weights };
        this.normalizeWeights();
    }

    /**
     * Normalize weights to sum to 1
     */
    normalizeWeights() {
        const sum = Object.values(this.weights).reduce((a, b) => a + b, 0);
        if (sum > 0 && sum !== 1) {
            for (const key of Object.keys(this.weights)) {
                this.weights[key] /= sum;
            }
        }
    }

    /**
     * Calculate comprehensive relevance score
     */
    score(result, query, context = {}) {
        const scores = {
            semantic: this.scoreSemanticSimilarity(result),
            keyword: this.scoreKeywordMatch(result, query),
            exactMatch: this.scoreExactMatch(result, query),
            structure: this.scoreCodeStructure(result),
            recency: this.scoreRecency(result),
            fileRelevance: this.scoreFileRelevance(result, query),
            popularity: this.scorePopularity(result)
        };

        // Calculate weighted score
        let totalScore = 0;
        for (const [signal, weight] of Object.entries(this.weights)) {
            totalScore += (scores[signal] || 0) * weight;
        }

        // Apply context-based adjustments
        totalScore = this.applyContextBoosts(totalScore, result, query, context);

        return {
            totalScore,
            breakdown: scores,
            weights: this.weights
        };
    }

    /**
     * Score semantic similarity (0-1)
     */
    scoreSemanticSimilarity(result) {
        // Semantic similarity should already be provided by vector search
        const similarity = result.similarity || result.semanticScore || 0;

        // Normalize to 0-1 range
        return Math.max(0, Math.min(1, similarity));
    }

    /**
     * Score keyword/BM25 match (0-1)
     */
    scoreKeywordMatch(result, query) {
        const keywordScore = result.keywordScore || result.bm25Score || 0;

        // BM25 scores can be unbounded, normalize
        // Typical BM25 scores range from 0-20 for good matches
        const normalized = Math.min(keywordScore / 15, 1);

        return Math.max(0, normalized);
    }

    /**
     * Score exact match (0-1)
     */
    scoreExactMatch(result, query) {
        if (!result.content || !query) return 0;

        const content = result.content.toLowerCase();
        const queryLower = query.toLowerCase();

        // Check for exact phrase match
        if (content.includes(queryLower)) {
            // Bonus for exact case match
            const exactCaseMatch = result.content.includes(query);
            return exactCaseMatch ? 1.0 : 0.8;
        }

        // Check for all query terms present
        const queryTerms = queryLower.split(/\s+/);
        const matchedTerms = queryTerms.filter(term =>
            content.includes(term) || this.hasCamelCaseMatch(content, term)
        );

        return matchedTerms.length / queryTerms.length;
    }

    /**
     * Check for camelCase match
     */
    hasCamelCaseMatch(content, term) {
        // Convert term to camelCase pattern
        const camelPattern = term.replace(/[_-](\w)/g, (_, c) => c.toUpperCase());
        return content.toLowerCase().includes(camelPattern.toLowerCase());
    }

    /**
     * Score code structure relevance (0-1)
     */
    scoreCodeStructure(result) {
        const structureType = result.metadata?.type ||
            result.structureType ||
            this.detectStructureType(result.content);

        return STRUCTURE_SCORES[structureType] || STRUCTURE_SCORES.other;
    }

    /**
     * Detect code structure type from content
     */
    detectStructureType(content) {
        if (!content) return 'other';

        const trimmed = content.trim();

        // Class definition
        if (/^(export\s+)?(abstract\s+)?class\s+\w+/m.test(trimmed)) {
            return 'class';
        }

        // Interface (TypeScript)
        if (/^(export\s+)?interface\s+\w+/m.test(trimmed)) {
            return 'interface';
        }

        // Function definition
        if (/^(export\s+)?(async\s+)?function\s+\w+/m.test(trimmed) ||
            /^(export\s+)?const\s+\w+\s*=\s*(async\s+)?\([^)]*\)\s*=>/m.test(trimmed)) {
            return 'function';
        }

        // Method (in class)
        if (/^\s*(public|private|protected|async)?\s*\w+\s*\([^)]*\)\s*[:{]/m.test(trimmed)) {
            return 'method';
        }

        // Constant
        if (/^(export\s+)?const\s+[A-Z_]+\s*=/m.test(trimmed)) {
            return 'constant';
        }

        // Import
        if (/^import\s+/m.test(trimmed)) {
            return 'import';
        }

        // Comment
        if (/^(\/\/|\/\*|\*|#)/m.test(trimmed)) {
            return 'comment';
        }

        return 'other';
    }

    /**
     * Score recency (0-1)
     */
    scoreRecency(result) {
        const lastModified = result.metadata?.lastModified ||
            result.lastModified ||
            result.timestamp;

        if (!lastModified) return 0.5; // Neutral if no timestamp

        const age = Date.now() - new Date(lastModified).getTime();
        const oneDay = 24 * 60 * 60 * 1000;

        // Decay function: recent files score higher
        if (age < oneDay) return 1.0;
        if (age < 7 * oneDay) return 0.9;
        if (age < 30 * oneDay) return 0.7;
        if (age < 90 * oneDay) return 0.5;
        if (age < 365 * oneDay) return 0.3;

        return 0.1;
    }

    /**
     * Score file relevance based on path and type (0-1)
     */
    scoreFileRelevance(result, query) {
        const filePath = result.metadata?.filePath || result.filePath || '';
        const fileName = filePath.split('/').pop() || '';
        const ext = fileName.split('.').pop()?.toLowerCase() || '';

        let score = 0;

        // File type score
        const typeScore = FILE_TYPE_SCORES[ext] || 0.2;
        score += typeScore * 0.4;

        // Filename match
        const queryTerms = query.toLowerCase().split(/\s+/);
        const fileNameLower = fileName.toLowerCase();

        let nameMatchScore = 0;
        for (const term of queryTerms) {
            if (fileNameLower.includes(term)) {
                nameMatchScore += 1 / queryTerms.length;
            }
        }
        score += nameMatchScore * 0.4;

        // Path relevance (avoid node_modules, dist, etc.)
        const pathLower = filePath.toLowerCase();
        if (pathLower.includes('node_modules') ||
            pathLower.includes('dist/') ||
            pathLower.includes('build/') ||
            pathLower.includes('.min.')) {
            score *= 0.3; // Penalty for build artifacts
        }

        if (pathLower.includes('/src/') ||
            pathLower.includes('/lib/') ||
            pathLower.includes('/app/')) {
            score += 0.2; // Bonus for source directories
        }

        return Math.min(1, score);
    }

    /**
     * Score popularity/usage (0-1)
     */
    scorePopularity(result) {
        // If reference count or import count is available
        const refCount = result.metadata?.referenceCount || 0;
        const importCount = result.metadata?.importCount || 0;

        const popularity = refCount + importCount;

        if (popularity === 0) return 0.5; // Neutral
        if (popularity >= 20) return 1.0;
        if (popularity >= 10) return 0.9;
        if (popularity >= 5) return 0.8;
        if (popularity >= 1) return 0.7;

        return 0.5;
    }

    /**
     * Apply context-based boosts
     */
    applyContextBoosts(score, result, query, context) {
        let boostedScore = score;

        // Boost for matching language
        if (context.language && result.metadata?.language === context.language) {
            boostedScore *= 1.1;
        }

        // Boost for test files when searching for tests
        const queryLower = query.toLowerCase();
        const filePath = (result.metadata?.filePath || '').toLowerCase();

        if ((queryLower.includes('test') || queryLower.includes('spec')) &&
            (filePath.includes('.test.') || filePath.includes('.spec.') || filePath.includes('__tests__'))) {
            boostedScore *= 1.2;
        }

        // Boost for component files when searching for components
        if (queryLower.includes('component') &&
            (filePath.includes('component') || filePath.endsWith('.jsx') || filePath.endsWith('.tsx'))) {
            boostedScore *= 1.15;
        }

        // Boost for matching file type
        if (context.preferredFileTypes) {
            const ext = filePath.split('.').pop();
            if (context.preferredFileTypes.includes(ext)) {
                boostedScore *= 1.1;
            }
        }

        // Cap at 1.0
        return Math.min(1, boostedScore);
    }

    /**
     * Re-rank results by relevance score
     */
    rerank(results, query, context = {}) {
        const scoredResults = results.map(result => {
            const scoreData = this.score(result, query, context);
            return {
                ...result,
                relevanceScore: scoreData.totalScore,
                scoreBreakdown: scoreData.breakdown
            };
        });

        // Sort by relevance score (descending)
        scoredResults.sort((a, b) => b.relevanceScore - a.relevanceScore);

        return scoredResults;
    }

    /**
     * Update weights
     */
    setWeights(newWeights) {
        this.weights = { ...this.weights, ...newWeights };
        this.normalizeWeights();
    }

    /**
     * Get current weights
     */
    getWeights() {
        return { ...this.weights };
    }
}

/**
 * Create a configured relevance scorer
 */
export function createRelevanceScorer(options = {}) {
    return new RelevanceScorer(options);
}

export default {
    RelevanceScorer,
    createRelevanceScorer,
    DEFAULT_WEIGHTS,
    STRUCTURE_SCORES,
    FILE_TYPE_SCORES
};

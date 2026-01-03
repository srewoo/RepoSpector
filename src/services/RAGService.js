import { VectorStore } from './VectorStore';
import { CodeChunker } from '../utils/chunking';
import { OffscreenEmbeddingService } from './OffscreenEmbeddingService';

export class RAGService {
    constructor(options = {}) {
        this.vectorStore = new VectorStore();
        this.chunker = new CodeChunker();

        // Support for multiple embedding providers
        this.provider = options.provider || 'local'; // 'openai' or 'local'
        this.apiKey = options.apiKey; // Only needed for OpenAI
        this.baseUrl = 'https://api.openai.com/v1';

        // Initialize embedding service based on provider
        if (this.provider === 'local') {
            this.embeddingService = new OffscreenEmbeddingService();
            console.log('✅ Using local embeddings (free, 100% private)');
        } else {
            console.log('✅ Using OpenAI embeddings (requires API key)');
        }
    }

    /**
     * Initialize the service
     * @param {Function} onProgress - Progress callback for model loading
     */
    async init(onProgress) {
        await this.vectorStore.init();

        // Initialize local embedding model if using that provider
        if (this.provider === 'local' && this.embeddingService) {
            try {
                console.log('🔄 Initializing local embedding model...');
                await this.embeddingService.init(onProgress);
                console.log('✅ Local embedding model ready!');
            } catch (error) {
                console.error('❌ Failed to initialize local embedding service:', error);
                console.warn('⚠️ Falling back to manual embedding provider selection required');

                // Don't throw immediately - allow graceful degradation
                // User will need to configure OpenAI provider instead
                this.embeddingService = null;

                // Provide helpful error message - safely extract original error
                const errMsg = error?.message || error?.toString?.() || String(error) || 'Unknown error';
                const helpfulError = new Error(
                    `Local embedding initialization failed. This is likely because:\n` +
                    `1. You're in a service worker context (Transformers.js requires DOM)\n` +
                    `2. The model download failed\n\n` +
                    `To fix: Go to Settings and configure OpenAI embedding provider instead.\n\n` +
                    `Original error: ${errMsg}`
                );
                helpfulError.isRecoverable = true;
                throw helpfulError;
            }
        }
    }

    /**
     * Index a repository
     * @param {string} repoId - "owner/repo"
     * @param {Array} files - Array of file objects { path, content }
     * @param {function} onProgress - Callback for progress updates
     */
    async indexRepository(repoId, files, onProgress) {
        await this.init();

        // 1. Clear existing index for this repo
        if (onProgress) onProgress({ status: 'clearing', message: 'Clearing old index...' });
        await this.vectorStore.clearRepo(repoId);

        // 2. Chunk files
        if (onProgress) onProgress({ status: 'chunking', message: 'Chunking files...' });
        let allChunks = [];

        for (const file of files) {
            const chunks = this.chunker.createSemanticChunks(file.content, 'gpt-4o-mini');
            chunks.forEach((chunk, idx) => {
                allChunks.push({
                    id: `${repoId}:${file.path}:${idx}`,
                    repoId,
                    filePath: file.path,
                    content: chunk.content,
                    chunkIndex: idx,
                    metadata: {
                        tokens: chunk.tokens,
                        type: chunk.type
                    }
                });
            });
        }

        // 3. Generate embeddings in batches
        if (onProgress) onProgress({ status: 'embedding', message: `Generating embeddings for ${allChunks.length} chunks...`, total: allChunks.length, current: 0 });

        const BATCH_SIZE = 20; // OpenAI batch limit
        for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
            const batch = allChunks.slice(i, i + BATCH_SIZE);
            const texts = batch.map(c => c.content);

            try {
                const embeddings = await this.generateEmbeddings(texts);

                // Assign embeddings to chunks
                batch.forEach((chunk, idx) => {
                    chunk.embedding = embeddings[idx];
                });

                // Store batch
                await this.vectorStore.addVectors(batch);

                if (onProgress) onProgress({
                    status: 'embedding',
                    message: `Indexed ${Math.min(i + BATCH_SIZE, allChunks.length)}/${allChunks.length} chunks`,
                    total: allChunks.length,
                    current: Math.min(i + BATCH_SIZE, allChunks.length)
                });
            } catch (error) {
                console.error('Error generating embeddings batch:', error);
                // Continue with next batch or throw? For now, log and continue
            }
        }

        if (onProgress) onProgress({ status: 'complete', message: 'Indexing complete!' });
        return { success: true, chunksIndexed: allChunks.length };
    }

    /**
     * Retrieve relevant context for a query
     * IMPROVED: Better relevance filtering and context formatting
     *
     * @param {string} repoId
     * @param {string} query
     * @param {number} limit
     * @param {Object} options - Search options
     */
    async retrieveContext(repoId, query, limit = 5, options = {}) {
        await this.init();

        const {
            minScore = 0.3,           // Minimum relevance score
            maxChunksPerFile = 2,     // Prevent one file from dominating
            formatOutput = false      // Return formatted string vs raw chunks
        } = options;

        try {
            // 1. Generate embedding for query
            const startTime = performance.now();
            const [queryEmbedding] = await this.generateEmbeddings([query]);
            const embedTime = performance.now() - startTime;

            // 2. Search vector store with improved options
            const results = await this.vectorStore.search(repoId, queryEmbedding, limit, {
                minScore,
                deduplicate: true,
                maxChunksPerFile
            });

            const searchTime = performance.now() - startTime - embedTime;
            console.log(`🔍 RAG: Retrieved ${results.length} chunks in ${searchTime.toFixed(0)}ms (embed: ${embedTime.toFixed(0)}ms)`);

            // Log relevance scores for debugging
            if (results.length > 0) {
                const scores = results.map(r => r.score.toFixed(3)).join(', ');
                console.log(`📊 RAG scores: [${scores}]`);
            }

            // 3. Format output if requested
            if (formatOutput && results.length > 0) {
                return this.formatRetrievedContext(results);
            }

            return results;
        } catch (error) {
            console.error('❌ RAG retrieval failed:', error);
            // Return empty results on error (graceful degradation)
            return formatOutput ? { chunks: '', sources: [] } : [];
        }
    }

    /**
     * Format retrieved chunks into a clean context string
     * Groups by file and includes relevance indicators
     */
    formatRetrievedContext(results) {
        if (!results || results.length === 0) {
            return { chunks: '', sources: [] };
        }

        // Group chunks by file
        const fileGroups = new Map();
        for (const result of results) {
            const filePath = result.filePath || 'unknown';
            if (!fileGroups.has(filePath)) {
                fileGroups.set(filePath, []);
            }
            fileGroups.get(filePath).push(result);
        }

        // Format each file's chunks
        const formattedChunks = [];
        const sources = [];

        for (const [filePath, chunks] of fileGroups) {
            sources.push(filePath);

            // Sort chunks by their position in the file (if available)
            chunks.sort((a, b) => (a.chunkIndex || 0) - (b.chunkIndex || 0));

            // Add relevance indicator
            const avgScore = chunks.reduce((sum, c) => sum + c.score, 0) / chunks.length;
            const relevance = avgScore > 0.7 ? '🟢 HIGH' : avgScore > 0.5 ? '🟡 MEDIUM' : '🟠 LOW';

            formattedChunks.push(`// File: ${filePath} (Relevance: ${relevance})`);
            for (const chunk of chunks) {
                formattedChunks.push(chunk.content);
            }
            formattedChunks.push(''); // Empty line between files
        }

        return {
            chunks: formattedChunks.join('\n'),
            sources,
            totalChunks: results.length,
            avgScore: results.reduce((sum, r) => sum + r.score, 0) / results.length
        };
    }

    /**
     * Check if a repository has good quality index
     * RELIABILITY: Helps user understand if re-indexing is needed
     */
    async checkIndexQuality(repoId) {
        await this.init();

        try {
            const stats = await this.vectorStore.getRepoStats(repoId);
            const isIndexed = stats.chunksCount > 0;

            return {
                isIndexed,
                chunksCount: stats.chunksCount,
                filesCount: stats.filesCount,
                quality: stats.chunksCount > 50 ? 'good' : stats.chunksCount > 10 ? 'fair' : 'limited',
                recommendation: stats.chunksCount < 10 ? 'Consider re-indexing for better results' : null
            };
        } catch (error) {
            return {
                isIndexed: false,
                chunksCount: 0,
                filesCount: 0,
                quality: 'none',
                error: error.message
            };
        }
    }

    /**
     * Generate embeddings using the configured provider
     * PERFORMANCE: Includes caching for repeated queries
     * RELIABILITY: Includes retry logic for API calls
     *
     * @param {Array<string>} texts
     */
    async generateEmbeddings(texts) {
        // Check cache first for single text queries (common for search)
        if (texts.length === 1 && this.embeddingCache) {
            const cached = this.getCachedEmbedding(texts[0]);
            if (cached) {
                console.log('📦 Embedding cache hit');
                return [cached];
            }
        }

        let embeddings;
        if (this.provider === 'local') {
            // Use local embeddings via offscreen document (free, 100% private)
            console.log(`🔢 Generating ${texts.length} embeddings locally...`);
            embeddings = await this.embeddingService.generateEmbeddings(texts);
        } else {
            // Use OpenAI API (requires API key) with retry logic
            console.log(`🔢 Generating ${texts.length} embeddings via OpenAI...`);
            embeddings = await this.generateOpenAIEmbeddingsWithRetry(texts);
        }

        // Cache single text queries
        if (texts.length === 1 && embeddings[0]) {
            this.setCachedEmbedding(texts[0], embeddings[0]);
        }

        return embeddings;
    }

    /**
     * Call OpenAI API to generate embeddings with retry logic
     * RELIABILITY: Retries up to 3 times with exponential backoff
     *
     * @param {Array<string>} texts
     * @param {number} maxRetries
     */
    async generateOpenAIEmbeddingsWithRetry(texts, maxRetries = 3) {
        if (!this.apiKey) {
            throw new Error('OpenAI API key is required for embeddings');
        }

        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await fetch(`${this.baseUrl}/embeddings`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.apiKey}`
                    },
                    body: JSON.stringify({
                        model: 'text-embedding-3-small',
                        input: texts
                    })
                });

                if (!response.ok) {
                    const error = await response.json().catch(() => ({}));

                    // Don't retry on authentication errors
                    if (response.status === 401 || response.status === 403) {
                        throw new Error(`OpenAI API Error: ${error.error?.message || 'Authentication failed'}`);
                    }

                    // Retry on rate limit or server errors
                    if (response.status === 429 || response.status >= 500) {
                        throw new Error(`OpenAI API Error (${response.status}): ${error.error?.message || response.statusText}`);
                    }

                    throw new Error(`OpenAI API Error: ${error.error?.message || response.statusText}`);
                }

                const data = await response.json();
                return data.data.map(item => item.embedding);
            } catch (error) {
                lastError = error;

                // Don't retry on auth errors
                if (error.message?.includes('Authentication') || error.message?.includes('401') || error.message?.includes('403')) {
                    throw error;
                }

                if (attempt < maxRetries) {
                    const delay = Math.pow(2, attempt - 1) * 500; // 500ms, 1s, 2s
                    console.log(`⏳ Embedding retry ${attempt}/${maxRetries} in ${delay}ms`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        throw lastError;
    }

    /**
     * Simple in-memory embedding cache
     * PERFORMANCE: Caches query embeddings to avoid repeated API calls
     */
    getCachedEmbedding(text) {
        if (!this.embeddingCache) {
            this.embeddingCache = new Map();
            this.embeddingCacheTimestamps = new Map();
        }

        const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
        const cacheKey = this.hashString(text);
        const timestamp = this.embeddingCacheTimestamps.get(cacheKey);

        if (timestamp && Date.now() - timestamp < CACHE_TTL) {
            return this.embeddingCache.get(cacheKey);
        }

        // Clean expired entry
        if (timestamp) {
            this.embeddingCache.delete(cacheKey);
            this.embeddingCacheTimestamps.delete(cacheKey);
        }

        return null;
    }

    setCachedEmbedding(text, embedding) {
        if (!this.embeddingCache) {
            this.embeddingCache = new Map();
            this.embeddingCacheTimestamps = new Map();
        }

        const cacheKey = this.hashString(text);
        this.embeddingCache.set(cacheKey, embedding);
        this.embeddingCacheTimestamps.set(cacheKey, Date.now());

        // Limit cache size
        if (this.embeddingCache.size > 100) {
            const oldestKey = this.embeddingCache.keys().next().value;
            this.embeddingCache.delete(oldestKey);
            this.embeddingCacheTimestamps.delete(oldestKey);
        }
    }

    /**
     * Simple string hash for cache keys
     */
    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return hash.toString();
    }

    /**
     * Call OpenAI API to generate embeddings (legacy, use WithRetry version)
     * @param {Array<string>} texts
     */
    async generateOpenAIEmbeddings(texts) {
        return this.generateOpenAIEmbeddingsWithRetry(texts);
    }

    /**
     * Get provider info
     */
    getProviderInfo() {
        if (this.provider === 'transformers') {
            return {
                provider: 'transformers',
                ...this.embeddingService.getModelInfo()
            };
        } else {
            return {
                provider: 'openai',
                model: 'text-embedding-3-small',
                dimension: 1536
            };
        }
    }
}

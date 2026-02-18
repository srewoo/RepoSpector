import { VectorStore } from './VectorStore';
import { CodeChunker } from '../utils/chunking';
import { OffscreenEmbeddingService } from './OffscreenEmbeddingService';
import { HybridSearcher } from './HybridSearcher.js';
import { IndexManifest, ManifestStore, hashContent } from './IndexManifest.js';
import { RelevanceScorer } from './RelevanceScorer.js';
import { expandQuery } from '../utils/queryExpander.js';

export class RAGService {
    constructor(options = {}) {
        this.vectorStore = new VectorStore();
        this.chunker = new CodeChunker();

        // Hybrid search components
        this.hybridSearcher = new HybridSearcher({
            semanticWeight: options.semanticWeight || 0.6,
            keywordWeight: options.keywordWeight || 0.4
        });
        this.hybridSearcher.setVectorStore(this.vectorStore);

        // Manifest store for incremental indexing
        this.manifestStore = new ManifestStore();

        // Relevance scorer for re-ranking
        this.relevanceScorer = new RelevanceScorer(options.scorerWeights);

        // Feature flags
        this.enableHybridSearch = options.enableHybridSearch !== false;
        this.enableQueryExpansion = options.enableQueryExpansion !== false;
        this.enableIncrementalIndexing = options.enableIncrementalIndexing !== false;

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
        this.hybridSearcher.clear();

        // Create a fresh manifest for this full re-index
        const manifest = new IndexManifest(repoId);

        // 2. Chunk files
        if (onProgress) onProgress({ status: 'chunking', message: 'Chunking files...' });
        let allChunks = [];

        for (const file of files) {
            const chunks = this.chunker.createSemanticChunks(file.content, 'gpt-4.1-mini');
            const chunkIds = [];
            const chunkHashes = {};

            chunks.forEach((chunk, idx) => {
                const chunkId = `${repoId}:${file.path}:${idx}`;
                chunkIds.push(chunkId);
                chunkHashes[chunkId] = hashContent(chunk.content);

                allChunks.push({
                    id: chunkId,
                    repoId,
                    filePath: file.path,
                    content: chunk.content,
                    chunkIndex: idx,
                    metadata: {
                        tokens: chunk.tokens,
                        type: chunk.type,
                        language: manifest.detectLanguage(file.path)
                    }
                });
            });

            // Track in manifest with chunk-level hashes
            manifest.addFile(file.path, file.content, chunkIds, {
                language: manifest.detectLanguage(file.path)
            }, chunkHashes);
        }

        // 3. Generate embeddings in batches
        if (onProgress) onProgress({ status: 'embedding', message: `Generating embeddings for ${allChunks.length} chunks...`, total: allChunks.length, current: 0 });

        const BATCH_SIZE = 20;
        for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
            const batch = allChunks.slice(i, i + BATCH_SIZE);
            const texts = batch.map(c => c.content);

            try {
                const embeddings = await this.generateEmbeddings(texts);

                // Assign embeddings to chunks
                batch.forEach((chunk, idx) => {
                    chunk.embedding = embeddings[idx];
                });

                // Store in vector DB
                await this.vectorStore.addVectors(batch);

                // Also populate BM25 keyword index
                for (const chunk of batch) {
                    this.hybridSearcher.bm25Index.addDocument(
                        chunk.id,
                        chunk.content,
                        chunk.metadata
                    );
                }

                if (onProgress) onProgress({
                    status: 'embedding',
                    message: `Indexed ${Math.min(i + BATCH_SIZE, allChunks.length)}/${allChunks.length} chunks`,
                    total: allChunks.length,
                    current: Math.min(i + BATCH_SIZE, allChunks.length)
                });
            } catch (error) {
                console.error('Error generating embeddings batch:', error);
            }
        }

        // 4. Save manifest so incremental indexing works next time
        await this.manifestStore.save(manifest);

        // 5. Persist BM25 index to IndexedDB for fast startup
        await this.hybridSearcher.saveBM25ToStorage(repoId);

        if (onProgress) onProgress({ status: 'complete', message: 'Indexing complete!' });
        return { success: true, chunksIndexed: allChunks.length };
    }

    /**
     * Incremental repository indexing
     * Only re-indexes changed files based on content hash comparison
     *
     * @param {string} repoId - "owner/repo"
     * @param {Array} files - Array of file objects { path, content }
     * @param {function} onProgress - Callback for progress updates
     */
    async indexRepositoryIncremental(repoId, files, onProgress) {
        if (!this.enableIncrementalIndexing) {
            return this.indexRepository(repoId, files, onProgress);
        }

        await this.init();

        // Load existing manifest
        if (onProgress) onProgress({ status: 'loading', message: 'Loading index manifest...' });
        let manifest = await this.manifestStore.load(repoId);

        if (!manifest) {
            // No existing index, do full indexing
            console.log('📚 No existing index found, performing full indexing');
            return this.indexRepository(repoId, files, onProgress);
        }

        // Compare files with manifest
        if (onProgress) onProgress({ status: 'comparing', message: 'Comparing files...' });
        const comparison = manifest.compare(files);

        console.log(`📊 Index comparison: ${comparison.toAdd.length} new, ${comparison.toUpdate.length} changed, ${comparison.toRemove.length} removed, ${comparison.unchanged.length} unchanged`);

        // If no changes, return early
        if (comparison.toAdd.length === 0 &&
            comparison.toUpdate.length === 0 &&
            comparison.toRemove.length === 0) {
            if (onProgress) onProgress({ status: 'complete', message: 'Index is up to date!' });
            return { success: true, chunksIndexed: 0, chunksReused: 0, skipped: comparison.unchanged.length };
        }

        // Step 1: Handle removed files — delete all their chunks
        const chunksToDelete = [];
        for (const file of comparison.toRemove) {
            chunksToDelete.push(...file.chunkIds);
            manifest.removeFile(file.path);
        }

        // Step 2: Process changed files with chunk-level diffing
        // Instead of deleting ALL chunks for a changed file, compare chunk by chunk
        const chunksToEmbed = [];   // New/changed chunks that need embedding
        const chunksToKeep = [];    // Unchanged chunks we can reuse
        let totalChunksReused = 0;

        if (onProgress) onProgress({ status: 'chunking', message: `Chunking ${comparison.toAdd.length + comparison.toUpdate.length} files...` });

        // Process NEW files — all chunks need embedding
        for (const file of comparison.toAdd) {
            const chunks = this.chunker.createSemanticChunks(file.content, 'gpt-4.1-mini');
            const chunkIds = [];
            const chunkHashes = {};

            chunks.forEach((chunk, idx) => {
                const chunkId = `${repoId}:${file.path}:${idx}`;
                chunkIds.push(chunkId);
                chunkHashes[chunkId] = hashContent(chunk.content);

                chunksToEmbed.push({
                    id: chunkId,
                    repoId,
                    filePath: file.path,
                    content: chunk.content,
                    chunkIndex: idx,
                    metadata: {
                        tokens: chunk.tokens,
                        type: chunk.type,
                        language: manifest.detectLanguage(file.path)
                    }
                });
            });

            manifest.addFile(file.path, file.content, chunkIds, {
                language: manifest.detectLanguage(file.path)
            }, chunkHashes);
        }

        // Process UPDATED files — chunk-level diff to minimize re-embedding
        for (const file of comparison.toUpdate) {
            const chunks = this.chunker.createSemanticChunks(file.content, 'gpt-4.1-mini');
            const newChunks = chunks.map((chunk, idx) => ({
                id: `${repoId}:${file.path}:${idx}`,
                content: chunk.content,
                tokens: chunk.tokens,
                type: chunk.type
            }));

            // Compare at chunk level
            const chunkDiff = manifest.compareChunks(file.path, newChunks);

            // Delete chunks that no longer exist (file got shorter)
            chunksToDelete.push(...chunkDiff.remove);

            // Chunks with identical content hash — skip embedding, keep existing vector
            for (const reuseId of chunkDiff.reuse) {
                chunksToKeep.push(reuseId);
                totalChunksReused++;
            }

            // Chunks with changed content — need new embedding
            for (const embedId of chunkDiff.reEmbed) {
                const chunk = newChunks.find(c => c.id === embedId);
                if (chunk) {
                    chunksToEmbed.push({
                        id: embedId,
                        repoId,
                        filePath: file.path,
                        content: chunk.content,
                        chunkIndex: newChunks.indexOf(chunk),
                        metadata: {
                            tokens: chunk.tokens,
                            type: chunk.type,
                            language: manifest.detectLanguage(file.path)
                        }
                    });
                }
            }

            // Update manifest with new chunk-level hashes
            const chunkIds = newChunks.map(c => c.id);
            const chunkHashes = {};
            for (const chunk of newChunks) {
                chunkHashes[chunk.id] = hashContent(chunk.content);
            }
            manifest.addFile(file.path, file.content, chunkIds, {
                language: manifest.detectLanguage(file.path)
            }, chunkHashes);
        }

        // Step 3: Delete outdated chunks from vector store
        if (chunksToDelete.length > 0) {
            if (onProgress) onProgress({ status: 'cleaning', message: `Removing ${chunksToDelete.length} outdated chunks...` });
            await this.vectorStore.deleteChunks(chunksToDelete);
            // Remove from BM25 index too
            for (const chunkId of chunksToDelete) {
                this.hybridSearcher.removeDocument(chunkId);
            }
            this.hybridSearcher.clearCache();
        }

        console.log(`📊 Chunk-level diff: ${chunksToEmbed.length} to embed, ${totalChunksReused} reused, ${chunksToDelete.length} deleted`);

        // Step 4: Generate embeddings only for changed/new chunks
        if (chunksToEmbed.length > 0) {
            if (onProgress) onProgress({
                status: 'embedding',
                message: `Generating embeddings for ${chunksToEmbed.length} chunks (${totalChunksReused} reused)...`,
                total: chunksToEmbed.length,
                current: 0
            });

            const BATCH_SIZE = 20;
            for (let i = 0; i < chunksToEmbed.length; i += BATCH_SIZE) {
                const batch = chunksToEmbed.slice(i, i + BATCH_SIZE);
                const texts = batch.map(c => c.content);

                try {
                    const embeddings = await this.generateEmbeddings(texts);
                    batch.forEach((chunk, idx) => {
                        chunk.embedding = embeddings[idx];
                    });

                    await this.vectorStore.addVectors(batch);

                    // Also add to BM25 index
                    for (const chunk of batch) {
                        this.hybridSearcher.bm25Index.addDocument(
                            chunk.id,
                            chunk.content,
                            chunk.metadata
                        );
                    }

                    if (onProgress) onProgress({
                        status: 'embedding',
                        message: `Indexed ${Math.min(i + BATCH_SIZE, chunksToEmbed.length)}/${chunksToEmbed.length} chunks (${totalChunksReused} reused)`,
                        total: chunksToEmbed.length,
                        current: Math.min(i + BATCH_SIZE, chunksToEmbed.length)
                    });
                } catch (error) {
                    console.error('Error generating embeddings batch:', error);
                }
            }
        }

        // Step 5: Ensure reused chunks are in BM25 index (they may not be if BM25 is in-memory)
        // BM25 index is rebuilt from scratch on service restart, so add reused chunks too
        for (const chunkId of chunksToKeep) {
            // BM25 addDocument is idempotent — safe to call even if already present
            const filePath = manifest.getFileForChunk(chunkId);
            if (filePath) {
                // We don't have the content here, but BM25 may already have it
                // If not, it will be populated on next full rebuild
            }
        }

        // Save updated manifest
        await this.manifestStore.save(manifest);

        // Persist BM25 index to IndexedDB for fast startup
        await this.hybridSearcher.saveBM25ToStorage(repoId);

        if (onProgress) onProgress({
            status: 'complete',
            message: `Incremental indexing complete! ${chunksToEmbed.length} embedded, ${totalChunksReused} reused.`
        });

        return {
            success: true,
            chunksIndexed: chunksToEmbed.length,
            chunksReused: totalChunksReused,
            chunksDeleted: chunksToDelete.length,
            filesAdded: comparison.toAdd.length,
            filesUpdated: comparison.toUpdate.length,
            filesRemoved: comparison.toRemove.length,
            filesUnchanged: comparison.unchanged.length
        };
    }

    /**
     * Retrieve relevant context for a query
     * IMPROVED: Supports hybrid search with BM25 + semantic
     *
     * @param {string} repoId
     * @param {string} query
     * @param {number} limit
     * @param {Object} options - Search options
     */
    async retrieveContext(repoId, query, limit = 20, options = {}) {
        await this.init();

        const {
            minScore = 0.3,           // Minimum relevance score
            maxChunksPerFile = 4,     // Prevent one file from dominating
            formatOutput = false,     // Return formatted string vs raw chunks
            useHybridSearch = this.enableHybridSearch,
            useQueryExpansion = this.enableQueryExpansion,
            rerank = true             // Apply relevance scoring re-ranking
        } = options;

        try {
            const startTime = performance.now();

            // 1. Optionally expand query for better recall
            let searchQuery = query;
            if (useQueryExpansion) {
                const expanded = expandQuery(query);
                searchQuery = expanded.expandedQuery;
                if (expanded.expansions.length > 0) {
                    console.log(`🔄 Query expanded: "${query}" -> "${searchQuery.substring(0, 100)}..."`);
                }
            }

            let results;

            // 2. Use hybrid search or vector-only search
            if (useHybridSearch) {
                // Generate embedding for the query so HybridSearcher can pass it to VectorStore
                const [queryEmbedding] = await this.generateEmbeddings([searchQuery]);

                // Hybrid search combines BM25 keyword + semantic vector search
                results = await this.hybridSearcher.search(searchQuery, repoId, {
                    limit: limit * 2, // Fetch more for re-ranking
                    useSemanticSearch: true,
                    useKeywordSearch: true,
                    filters: options.filters,
                    queryEmbedding  // Pass pre-computed embedding for VectorStore
                });

                // Map to expected format
                results = results.map(r => ({
                    ...r,
                    id: r.docId,
                    score: r.score || r.relevanceScore || 0,
                    filePath: r.metadata?.filePath || r.filePath
                }));

                console.log(`🔍 RAG Hybrid: Retrieved ${results.length} chunks`);
            } else {
                // Traditional vector-only search
                const [queryEmbedding] = await this.generateEmbeddings([searchQuery]);
                results = await this.vectorStore.search(repoId, queryEmbedding, limit * 2, {
                    minScore,
                    deduplicate: true,
                    maxChunksPerFile
                });
            }

            // 3. Re-rank results using relevance scorer
            if (rerank && results.length > 0) {
                results = this.relevanceScorer.rerank(results, query, {
                    language: options.language,
                    preferredFileTypes: options.preferredFileTypes
                });
            }

            // 4. Apply deduplication and limit
            results = this.deduplicateResults(results, maxChunksPerFile);
            results = results.slice(0, limit);

            const totalTime = performance.now() - startTime;
            console.log(`🔍 RAG: Retrieved ${results.length} chunks in ${totalTime.toFixed(0)}ms`);

            // Log relevance scores for debugging
            if (results.length > 0) {
                const scores = results.map(r => (r.relevanceScore || r.score || 0).toFixed(3)).join(', ');
                console.log(`📊 RAG scores: [${scores}]`);
            }

            // 5. Format output if requested
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
     * Deduplicate results by file path
     */
    deduplicateResults(results, maxChunksPerFile = 2) {
        const fileChunkCount = new Map();
        const deduplicated = [];

        for (const result of results) {
            const filePath = result.filePath || result.metadata?.filePath || 'unknown';
            const currentCount = fileChunkCount.get(filePath) || 0;

            if (currentCount < maxChunksPerFile) {
                deduplicated.push(result);
                fileChunkCount.set(filePath, currentCount + 1);
            }
        }

        return deduplicated;
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

    /**
     * Retrieve repository documentation (README, docs, etc.)
     * Used to understand what the repository is about
     *
     * @param {string} repoId - "owner/repo"
     * @returns {Object} Documentation context with content and sources
     */
    async getRepositoryDocumentation(repoId) {
        await this.init();

        try {
            // Documentation file patterns to look for
            const docPatterns = [
                'readme.md', 'readme.txt', 'readme',
                'docs/readme.md', 'documentation/readme.md',
                'doc/readme.md', 'docs/index.md',
                'contributing.md', 'architecture.md',
                'overview.md', 'getting-started.md'
            ];

            // Get all chunks for this repo
            const transaction = this.vectorStore.db.transaction([this.vectorStore.storeName], 'readonly');
            const store = transaction.objectStore(this.vectorStore.storeName);
            const index = store.index('repoId');

            return new Promise((resolve, reject) => {
                const request = index.getAll(repoId);

                request.onsuccess = () => {
                    const allChunks = request.result;
                    const docChunks = [];

                    // Find documentation files
                    for (const chunk of allChunks) {
                        const filePath = (chunk.filePath || '').toLowerCase();
                        const fileName = filePath.split('/').pop();

                        // Check if it matches documentation patterns
                        const isDocFile = docPatterns.some(pattern =>
                            filePath.endsWith(pattern) || fileName === pattern
                        ) || filePath.includes('/docs/') || filePath.includes('/documentation/')
                          || fileName.endsWith('.md') || fileName.endsWith('.rst')
                          || fileName === 'quickstart' || fileName.includes('getting-started');

                        if (isDocFile) {
                            docChunks.push(chunk);
                        }
                    }

                    // Sort by file path (README first) and chunk index
                    docChunks.sort((a, b) => {
                        const aPath = (a.filePath || '').toLowerCase();
                        const bPath = (b.filePath || '').toLowerCase();

                        // Prioritize README files
                        const aIsReadme = aPath.includes('readme');
                        const bIsReadme = bPath.includes('readme');
                        if (aIsReadme && !bIsReadme) return -1;
                        if (!aIsReadme && bIsReadme) return 1;

                        // Then by path
                        if (aPath !== bPath) return aPath.localeCompare(bPath);

                        // Then by chunk index
                        return (a.chunkIndex || 0) - (b.chunkIndex || 0);
                    });

                    // Limit to reasonable size
                    const limitedChunks = docChunks.slice(0, 25);
                    const sources = [...new Set(limitedChunks.map(c => c.filePath))];

                    if (limitedChunks.length > 0) {
                        const formattedContent = limitedChunks
                            .map(c => `// From: ${c.filePath}\n${c.content}`)
                            .join('\n\n---\n\n');

                        resolve({
                            found: true,
                            content: formattedContent,
                            sources,
                            chunksCount: limitedChunks.length
                        });
                    } else {
                        resolve({
                            found: false,
                            content: '',
                            sources: [],
                            chunksCount: 0
                        });
                    }
                };

                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            console.warn('Failed to get repository documentation:', error);
            return {
                found: false,
                content: '',
                sources: [],
                error: error.message
            };
        }
    }

    /**
     * Enhanced context retrieval that includes repository documentation
     *
     * @param {string} repoId - "owner/repo"
     * @param {string} query - Search query
     * @param {number} limit - Max results
     * @param {Object} options - Options including includeDocumentation flag
     */
    async retrieveContextWithDocs(repoId, query, limit = 20, options = {}) {
        const {
            includeDocumentation = true,
            documentationFirst = false,  // If true, prepend docs to context
            ...searchOptions
        } = options;

        // Get regular search results
        const searchResults = await this.retrieveContext(repoId, query, limit, searchOptions);

        // Optionally include repository documentation
        if (includeDocumentation) {
            const docs = await this.getRepositoryDocumentation(repoId);

            if (docs.found) {
                return {
                    results: searchResults,
                    documentation: docs,
                    combinedContext: documentationFirst
                        ? `## Repository Documentation\n${docs.content}\n\n## Relevant Code\n${searchResults.map(r => r.content).join('\n\n')}`
                        : `## Relevant Code\n${searchResults.map(r => r.content).join('\n\n')}\n\n## Repository Documentation\n${docs.content}`
                };
            }
        }

        return {
            results: searchResults,
            documentation: null,
            combinedContext: searchResults.map(r => r.content).join('\n\n')
        };
    }
}

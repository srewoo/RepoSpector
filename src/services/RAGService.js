import { VectorStore } from './VectorStore';
import { CodeChunker } from '../utils/chunking';
import { TransformersEmbeddingService } from './TransformersEmbeddingService';

export class RAGService {
    constructor(options = {}) {
        this.vectorStore = new VectorStore();
        this.chunker = new CodeChunker();

        // Support for multiple embedding providers
        this.provider = options.provider || 'openai'; // 'openai' or 'transformers'
        this.apiKey = options.apiKey; // Only needed for OpenAI
        this.baseUrl = 'https://api.openai.com/v1';

        // Initialize embedding service based on provider
        if (this.provider === 'transformers') {
            this.embeddingService = new TransformersEmbeddingService();
        }
    }

    /**
     * Initialize the service
     * @param {Function} onProgress - Progress callback for model loading
     */
    async init(onProgress) {
        await this.vectorStore.init();

        // Initialize Transformers.js model if using that provider
        if (this.provider === 'transformers' && this.embeddingService) {
            try {
                await this.embeddingService.init(onProgress);
            } catch (error) {
                console.error('Failed to initialize Transformers.js embedding service:', error);
                throw new Error(`Embedding service initialization failed: ${error.message}. Please use OpenAI embedding provider in service worker context.`);
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
     * @param {string} repoId 
     * @param {string} query 
     * @param {number} limit 
     */
    async retrieveContext(repoId, query, limit = 5) {
        await this.init();

        // 1. Generate embedding for query
        const [queryEmbedding] = await this.generateEmbeddings([query]);

        // 2. Search vector store
        const results = await this.vectorStore.search(repoId, queryEmbedding, limit);

        return results;
    }

    /**
     * Generate embeddings using the configured provider
     * @param {Array<string>} texts 
     */
    async generateEmbeddings(texts) {
        if (this.provider === 'transformers') {
            // Use Transformers.js (free, client-side)
            return await this.embeddingService.generateEmbeddings(texts);
        } else {
            // Use OpenAI API (requires API key)
            return await this.generateOpenAIEmbeddings(texts);
        }
    }

    /**
     * Call OpenAI API to generate embeddings
     * @param {Array<string>} texts 
     */
    async generateOpenAIEmbeddings(texts) {
        if (!this.apiKey) {
            throw new Error('OpenAI API key is required for embeddings');
        }

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
            const error = await response.json();
            throw new Error(`OpenAI API Error: ${error.error?.message || response.statusText}`);
        }

        const data = await response.json();
        return data.data.map(item => item.embedding);
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

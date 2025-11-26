/**
 * TransformersEmbeddingService - Free, client-side embedding generation using Transformers.js
 * Uses sentence-transformers models that run directly in the browser
 *
 * IMPORTANT: Uses lazy loading to avoid blocking extension startup
 */

export class TransformersEmbeddingService {
    constructor() {
        this.model = null;
        this.pipeline = null;
        this.isLoading = false;
        this.isLoaded = false;
        this.initializationError = null;
        this.modelName = 'Xenova/all-MiniLM-L6-v2'; // 384-dimensional embeddings
        this.embeddingDimension = 384;
    }

    /**
     * Initialize and load the embedding model with dynamic import
     * @param {Function} onProgress - Optional progress callback
     */
    async init(onProgress = null) {
        if (this.isLoaded) {
            return;
        }

        if (this.isLoading) {
            // Wait for existing load to complete
            while (this.isLoading) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return;
        }

        this.isLoading = true;

        try {
            // Check if we're in a service worker context (no DOM)
            if (typeof document === 'undefined' && typeof window === 'undefined') {
                throw new Error('Transformers.js requires DOM context. Service workers are not supported. Please use OpenAI embedding provider instead.');
            }

            // LAZY LOAD: Only import Transformers.js when needed
            console.log('Loading Transformers.js library...');
            if (onProgress) {
                onProgress({
                    status: 'loading_library',
                    progress: 0.1,
                    message: 'Loading Transformers.js...'
                });
            }

            const transformers = await import('@xenova/transformers');
            this.pipeline = transformers.pipeline;

            console.log(`Loading embedding model: ${this.modelName}...`);
            if (onProgress) {
                onProgress({
                    status: 'loading_model',
                    progress: 0.2,
                    message: 'Loading embedding model...'
                });
            }

            // Load the feature extraction pipeline
            this.model = await this.pipeline('feature-extraction', this.modelName, {
                progress_callback: onProgress ? (progress) => {
                    onProgress({
                        status: progress.status || 'downloading',
                        file: progress.file,
                        progress: 0.2 + ((progress.progress || 0) * 0.8), // Scale to 20-100%
                        loaded: progress.loaded || 0,
                        total: progress.total || 0,
                        message: `Downloading ${progress.file}...`
                    });
                } : undefined
            });

            this.isLoaded = true;
            this.initializationError = null;
            console.log('Embedding model loaded successfully!');

            if (onProgress) {
                onProgress({
                    status: 'ready',
                    progress: 1.0,
                    message: 'Model ready!'
                });
            }
        } catch (error) {
            this.initializationError = error;
            console.error('Failed to load embedding model:', error);

            // Provide helpful error messages based on the error type
            if (error.message.includes('fetch') || error.message.includes('network')) {
                throw new Error('Cannot download model. Check internet connection and CSP settings.');
            } else if (error.message.includes('WebAssembly') || error.message.includes('WASM')) {
                throw new Error('WebAssembly not supported in this context. Use OpenAI embedding provider instead.');
            } else if (error.message.includes('import')) {
                throw new Error('Failed to load Transformers.js library. Extension may need to be reinstalled.');
            } else {
                throw new Error(`Transformers.js initialization failed: ${error.message}`);
            }
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Generate embeddings for a batch of texts
     * @param {string[]} texts - Array of text strings to embed
     * @returns {Promise<number[][]>} Array of embedding vectors
     */
    async generateEmbeddings(texts) {
        if (!this.isLoaded) {
            await this.init();
        }

        if (!this.model) {
            throw new Error('Model not initialized');
        }

        try {
            const embeddings = [];

            // Process texts one at a time to avoid memory issues
            for (const text of texts) {
                const output = await this.model(text, {
                    pooling: 'mean',
                    normalize: true
                });

                // Convert tensor to array
                const embedding = Array.from(output.data);
                embeddings.push(embedding);
            }

            return embeddings;
        } catch (error) {
            console.error('Error generating embeddings:', error);
            throw new Error(`Failed to generate embeddings: ${error.message}`);
        }
    }

    /**
     * Generate a single embedding
     * @param {string} text - Text to embed
     * @returns {Promise<number[]>} Embedding vector
     */
    async generateEmbedding(text) {
        const embeddings = await this.generateEmbeddings([text]);
        return embeddings[0];
    }

    /**
     * Get embedding dimension
     */
    getDimension() {
        return this.embeddingDimension;
    }

    /**
     * Check if model is ready
     */
    isReady() {
        return this.isLoaded;
    }

    /**
     * Get model info
     */
    getModelInfo() {
        return {
            name: this.modelName,
            dimension: this.embeddingDimension,
            isLoaded: this.isLoaded,
            isLoading: this.isLoading
        };
    }
}

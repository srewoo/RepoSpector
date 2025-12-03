/**
 * OffscreenEmbeddingService - Local embeddings for Manifest V3 service workers
 * Uses Chrome's offscreen document API to run Transformers.js in a DOM context
 *
 * This solves the problem: Service workers can't use WebAssembly/DOM APIs,
 * but offscreen documents can!
 */

export class OffscreenEmbeddingService {
    constructor() {
        this.isReady = false;
        this.isInitializing = false;
        this.initPromise = null;
        this.offscreenDocumentCreated = false;
        this.pendingMessages = new Map();
        this.messageId = 0;
        this.modelName = 'Xenova/all-MiniLM-L6-v2';
        this.embeddingDimension = 384;
    }

    /**
     * Initialize the offscreen document
     */
    async init(onProgress = null) {
        // If already ready, return immediately
        if (this.isReady) {
            return;
        }

        // If currently initializing, wait for existing initialization
        if (this.isInitializing && this.initPromise) {
            console.log('⏳ Already initializing, waiting for completion...');
            return await this.initPromise;
        }

        // Mark as initializing and create promise
        this.isInitializing = true;
        this.initPromise = this._doInit(onProgress);

        try {
            await this.initPromise;
        } finally {
            this.isInitializing = false;
        }
    }

    /**
     * Internal initialization logic
     */
    async _doInit(onProgress = null) {

        try {
            // Check if offscreen document already exists
            const existingContexts = await chrome.runtime.getContexts({
                contextTypes: ['OFFSCREEN_DOCUMENT']
            });

            if (existingContexts.length === 0) {
                // Create offscreen document
                console.log('📄 Creating offscreen document for embeddings...');

                try {
                    await chrome.offscreen.createDocument({
                        url: 'offscreen.html',
                        reasons: ['WORKERS'],
                        justification: 'Run Transformers.js ML model for local embeddings'
                    });
                    this.offscreenDocumentCreated = true;
                    console.log('✅ Offscreen document created');
                } catch (err) {
                    if (err.message.includes('Only a single offscreen document may be created')) {
                        console.log('⚠️ Offscreen document already exists (race condition handled)');
                        this.offscreenDocumentCreated = true;
                    } else {
                        throw err;
                    }
                }
            } else {
                console.log('✅ Offscreen document already exists');
                this.offscreenDocumentCreated = true;
            }

            // Initialize the model in the offscreen document
            if (onProgress) {
                onProgress({
                    status: 'loading_model',
                    message: 'Loading local embedding model...',
                    progress: 0.1
                });
            }

            const response = await this.sendMessage({
                type: 'INIT_MODEL',
                modelName: this.modelName
            });

            if (!response.success) {
                throw new Error(response.error || 'Failed to initialize model');
            }

            this.isReady = true;
            console.log('✅ Local embedding model ready!');

            if (onProgress) {
                onProgress({
                    status: 'ready',
                    message: 'Model ready!',
                    progress: 1.0
                });
            }
        } catch (error) {
            console.error('❌ Failed to initialize offscreen embedding service:', error);
            // Safely extract error message
            const errMsg = error?.message || error?.toString?.() || String(error) || 'Unknown error';
            throw new Error(`Offscreen embedding service failed: ${errMsg}`);
        }
    }

    /**
     * Send message to offscreen document and wait for response
     */
    async sendMessage(message) {
        return new Promise((resolve, reject) => {
            const messageId = this.messageId++;
            const messageWithId = { ...message, messageId };

            // Store resolver for this message
            this.pendingMessages.set(messageId, { resolve, reject });

            // Set timeout
            const timeout = setTimeout(() => {
                this.pendingMessages.delete(messageId);
                reject(new Error('Offscreen message timeout'));
            }, 300000); // 5 minutes for model loading

            // Send message to offscreen document
            chrome.runtime.sendMessage(messageWithId, (response) => {
                clearTimeout(timeout);
                this.pendingMessages.delete(messageId);

                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(response);
                }
            });
        });
    }

    /**
     * Generate embeddings for a batch of texts
     * @param {string[]} texts - Array of text strings
     * @returns {Promise<number[][]>} Array of embedding vectors
     */
    async generateEmbeddings(texts) {
        if (!this.isReady) {
            await this.init();
        }

        try {
            const response = await this.sendMessage({
                type: 'GENERATE_EMBEDDINGS',
                texts: texts
            });

            if (!response.success) {
                throw new Error(response.error || 'Failed to generate embeddings');
            }

            return response.embeddings;
        } catch (error) {
            console.error('Error generating embeddings:', error);
            throw error;
        }
    }

    /**
     * Generate a single embedding
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
     * Get model info
     */
    getModelInfo() {
        return {
            name: this.modelName,
            dimension: this.embeddingDimension,
            isReady: this.isReady,
            provider: 'local'
        };
    }

    /**
     * Cleanup offscreen document
     */
    async cleanup() {
        if (this.offscreenDocumentCreated) {
            try {
                await chrome.offscreen.closeDocument();
                console.log('🗑️ Offscreen document closed');
            } catch (error) {
                console.warn('Failed to close offscreen document:', error);
            }
        }
    }
}

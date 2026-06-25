/**
 * Offscreen Document Script - Runs Transformers.js in DOM context
 * This allows local embeddings to work with Manifest V3 service workers
 */

import { pipeline, env } from '@xenova/transformers';
import * as TreeSitter from 'web-tree-sitter';
import { TreeSitterParser } from '../services/TreeSitterParser.js';

// Tree-sitter runs here (module context) for the same reason embeddings do:
// MV3 service workers can't load the WASM runtime, but offscreen documents can.
// The parser instance is module-scoped so loaded grammars persist across batches.
//
// Created lazily inside a guard: if TreeSitterParser construction throws, it must
// NOT abort module evaluation — otherwise the onMessage listener below never
// registers and every embedding request fails with "message port closed".
let _tsParser = null;
function getTsParser() {
    if (!_tsParser) {
        _tsParser = new TreeSitterParser({ module: TreeSitter });
    }
    return _tsParser;
}

async function handleTreeSitterAnalyze(files) {
    const parser = getTsParser();
    await parser.preloadFromFiles(files);
    const analyses = {};
    for (const file of files) {
        if (!file.content || !parser.isReadyForPath(file.path)) continue;
        const a = parser._analyze(file.content, file.path);
        if (a) analyses[file.path] = a;
    }
    return { available: parser.available, analyses };
}

// Configure Transformers.js for Chrome extension environment.
// The model weights + tokenizer AND the ONNX WASM runtime are bundled inside
// the extension (see vite.config.js copyAssets + manifest web_accessible_resources).
// This makes local embeddings work fully offline / behind corporate firewalls —
// the previous `allowLocalModels = false` forced a HuggingFace CDN download that
// failed with "Failed to fetch" on any network where huggingface.co is blocked.
env.allowLocalModels = true;                                  // Load model from bundled /models/
env.allowRemoteModels = false;                                // Never fall back to the HF CDN
env.localModelPath = chrome.runtime.getURL('models/');        // chrome-extension://<id>/models/
env.backends.onnx.wasm.numThreads = 1;                        // Avoid blob: URL CSP violations from ONNX workers
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('wasm/'); // Bundled ONNX runtime, no jsdelivr fetch

class OffscreenEmbeddingWorker {
    constructor() {
        this.model = null;
        this.isLoading = false;
        this.isLoaded = false;
        this.modelName = 'Xenova/all-MiniLM-L6-v2';

        // Listen for messages from service worker
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            this.handleMessage(message, sender, sendResponse);
            return true; // Keep channel open for async response
        });

        this.updateStatus('Ready to load model');
        console.log('✅ Offscreen embedding worker initialized');
    }

    /**
     * Handle messages from service worker
     */
    async handleMessage(message, sender, sendResponse) {
        // Only handle messages with a messageId (from OffscreenEmbeddingService)
        // Ignore all other messages (they're meant for background script, not us)
        if (!message.messageId && message.messageId !== 0) {
            // Not our message, don't respond
            return;
        }

        try {
            switch (message.type) {
                case 'OFFSCREEN_PING':
                    // Readiness handshake: the service worker polls this before
                    // sending INIT_MODEL, because createDocument() resolves before
                    // this 1.5MB module finishes evaluating and registers its
                    // listener. Answering proves the listener is live.
                    sendResponse({ success: true, ready: true, messageId: message.messageId });
                    break;

                case 'INIT_MODEL':
                    await this.initModel(message.modelName);
                    sendResponse({ success: true, messageId: message.messageId });
                    break;

                case 'GENERATE_EMBEDDINGS': {
                    const embeddings = await this.generateEmbeddings(message.texts);
                    sendResponse({
                        success: true,
                        embeddings,
                        messageId: message.messageId
                    });
                    break;
                }

                case 'GET_STATUS':
                    sendResponse({
                        success: true,
                        isLoaded: this.isLoaded,
                        isLoading: this.isLoading,
                        modelName: this.modelName,
                        messageId: message.messageId
                    });
                    break;

                case 'TS_ANALYZE_FILES': {
                    const result = await handleTreeSitterAnalyze(message.files || []);
                    sendResponse({ success: true, ...result, messageId: message.messageId });
                    break;
                }

                default:
                    // Unknown message type for offscreen worker
                    sendResponse({
                        success: false,
                        error: `Unknown offscreen message type: ${message.type}`,
                        messageId: message.messageId
                    });
            }
        } catch (error) {
            console.error('❌ Offscreen worker error:', error);
            // Safely extract error message
            const errMsg = error?.message || error?.toString?.() || String(error) || 'Unknown error';
            sendResponse({
                success: false,
                error: errMsg,
                messageId: message.messageId
            });
        }
    }

    /**
     * Initialize the embedding model
     */
    async initModel(modelName) {
        if (this.isLoaded) {
            console.log('✅ Model already loaded');
            return;
        }

        if (this.isLoading) {
            console.log('⏳ Model is already loading, waiting...');
            while (this.isLoading) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return;
        }

        this.isLoading = true;
        this.updateStatus('Loading model...');

        try {
            console.log(`📥 Loading embedding model: ${modelName || this.modelName}...`);

            if (modelName) {
                this.modelName = modelName;
            }

            // Load the feature extraction pipeline
            this.model = await pipeline('feature-extraction', this.modelName, {
                progress_callback: (progress) => {
                    const message = `Downloading ${progress.file}: ${Math.round((progress.loaded / progress.total) * 100)}%`;
                    console.log(message);
                    this.updateStatus(message);
                }
            });

            this.isLoaded = true;
            this.updateStatus('Model loaded successfully!');
            console.log('✅ Embedding model loaded successfully!');
        } catch (error) {
            // Safely extract error message
            const errMsg = error?.message || error?.toString?.() || String(error) || 'Unknown error';
            this.updateStatus(`Error: ${errMsg}`);
            console.error('❌ Failed to load model:', error);
            throw error;
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Generate embeddings for texts
     */
    async generateEmbeddings(texts) {
        if (!this.isLoaded) {
            await this.initModel();
        }

        if (!this.model) {
            throw new Error('Model not initialized');
        }

        console.log(`🔢 Generating embeddings for ${texts.length} texts...`);
        const embeddings = [];

        try {
            // Process texts one at a time to avoid memory issues
            for (let i = 0; i < texts.length; i++) {
                const text = texts[i];

                // Update status every 10 items
                if (i % 10 === 0) {
                    this.updateStatus(`Processing ${i + 1}/${texts.length}...`);
                }

                const output = await this.model(text, {
                    pooling: 'mean',
                    normalize: true
                });

                // Convert tensor to array
                const embedding = Array.from(output.data);
                embeddings.push(embedding);
            }

            this.updateStatus(`Generated ${embeddings.length} embeddings`);
            console.log(`✅ Generated ${embeddings.length} embeddings`);

            return embeddings;
        } catch (error) {
            console.error('❌ Error generating embeddings:', error);
            throw error;
        }
    }

    /**
     * Update status display
     */
    updateStatus(message) {
        const statusEl = document.getElementById('status');
        if (statusEl) {
            statusEl.textContent = message;
        }
    }
}

// Initialize the worker
const _worker = new OffscreenEmbeddingWorker();

console.log('🚀 Offscreen embedding worker ready');

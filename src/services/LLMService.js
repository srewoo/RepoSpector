/**
 * LLMService - Multi-provider LLM abstraction layer
 * Supports: OpenAI, Anthropic (Claude), Google (Gemini), Groq, Mistral, and Ollama (local)
 */

import { LLM_PROVIDERS, API_ENDPOINTS, MODELS } from '../utils/constants.js';

export class LLMService {
    constructor() {
        this.activeRequests = new Map();
        this.maxRetries = 3;
        this.baseDelay = 1000; // 1 second
    }

    /**
     * Check if an error is retryable (transient)
     */
    isRetryableError(error) {
        const msg = (error.message || '').toLowerCase();
        // Retry on rate limits, server errors, and network failures
        if (/429|rate.?limit|too many requests/i.test(msg)) return true;
        if (/5\d{2}|502|503|504|internal server|bad gateway|service unavailable|gateway timeout/i.test(msg)) return true;
        if (/network|fetch|timeout|econnreset|econnrefused|socket/i.test(msg)) return true;
        return false;
    }

    /**
     * Execute a function with exponential backoff retry
     */
    async withRetry(fn, context = 'LLM call') {
        let lastError;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                if (attempt < this.maxRetries && this.isRetryableError(error)) {
                    const delay = this.baseDelay * Math.pow(2, attempt) + Math.random() * 500;
                    console.warn(`⚠️ ${context} failed (attempt ${attempt + 1}/${this.maxRetries + 1}): ${error.message}. Retrying in ${Math.round(delay)}ms...`);
                    await new Promise(r => setTimeout(r, delay));
                } else {
                    throw error;
                }
            }
        }
        throw lastError;
    }

    /**
     * Stream chat method - wrapper for callLLM with simplified interface
     * @param {Array} messages - Array of { role, content } message objects
     * @param {Object} options - Options including provider, model, apiKey, stream
     * @returns {Promise<Object>} Response with content property
     */
    async streamChat(messages, options = {}) {
        const { provider, model, apiKey, stream = false, onChunk, tabId } = options;

        const requestData = {
            model: model || 'openai:gpt-4.1-mini',
            messages
        };

        const response = await this.callLLM(requestData, apiKey, {
            streaming: stream,
            onChunk,
            tabId
        });

        // Normalize response format
        if (typeof response === 'string') {
            return { content: response };
        }
        return response;
    }

    /**
     * Get provider from model identifier (e.g., "openai:gpt-4.1-mini" -> "openai")
     * @param {string} modelIdentifier - Full model identifier with provider prefix
     * @returns {string} Provider name
     */
    getProvider(modelIdentifier) {
        if (!modelIdentifier || typeof modelIdentifier !== 'string') return LLM_PROVIDERS.OPENAI;
        if (!modelIdentifier.includes(':')) return LLM_PROVIDERS.OPENAI;
        return modelIdentifier.split(':')[0] || LLM_PROVIDERS.OPENAI;
    }

    /**
     * Get model ID from model identifier (e.g., "openai:gpt-4.1-mini" -> "gpt-4.1-mini")
     * @param {string} modelIdentifier - Full model identifier
     * @returns {string} Model ID for API calls
     */
    getModelId(modelIdentifier) {
        if (!modelIdentifier || typeof modelIdentifier !== 'string') return 'gpt-4.1-mini';

        const modelConfig = MODELS[modelIdentifier];
        if (modelConfig?.modelId) {
            return modelConfig.modelId;
        }

        if (!modelIdentifier.includes(':')) return modelIdentifier;
        return modelIdentifier.split(':')[1] || modelIdentifier;
    }

    /**
     * Main LLM call method - routes to appropriate provider
     * @param {Object} requestData - Request data (messages, model, temperature, etc.)
     * @param {string} apiKey - API key for the provider
     * @param {Object} options - Additional options (streaming, timeout, etc.)
     * @returns {Promise<string>} LLM response
     */
    async callLLM(requestData, apiKey, options = {}) {
        const provider = this.getProvider(requestData.model);
        const modelId = this.getModelId(requestData.model);

        console.log(`🤖 LLMService: Routing to provider '${provider}' with model '${modelId}'`);

        // Update request data with actual model ID
        const normalizedRequest = {
            ...requestData,
            model: modelId
        };

        // Skip retry for streaming requests (can't replay partial chunks)
        if (options.streaming) {
            return this._dispatchToProvider(provider, normalizedRequest, apiKey, options);
        }

        // Wrap non-streaming calls with retry logic
        return this.withRetry(
            () => this._dispatchToProvider(provider, normalizedRequest, apiKey, options),
            `${provider}:${modelId}`
        );
    }

    /**
     * Dispatch request to the appropriate provider
     */
    _dispatchToProvider(provider, normalizedRequest, apiKey, options) {
        switch (provider) {
            case LLM_PROVIDERS.OPENAI:
                return this.callOpenAI(normalizedRequest, apiKey, options);

            case LLM_PROVIDERS.ANTHROPIC:
                return this.callAnthropic(normalizedRequest, apiKey, options);

            case LLM_PROVIDERS.GOOGLE:
                return this.callGoogle(normalizedRequest, apiKey, options);

            case LLM_PROVIDERS.GROQ:
                return this.callGroq(normalizedRequest, apiKey, options);

            case LLM_PROVIDERS.MISTRAL:
                return this.callMistral(normalizedRequest, apiKey, options);

            case LLM_PROVIDERS.LOCAL:
                return this.callOllama(normalizedRequest, options);

            default:
                console.warn(`Unknown provider '${provider}', falling back to OpenAI`);
                return this.callOpenAI(normalizedRequest, apiKey, options);
        }
    }

    /**
     * OpenAI API call
     */
    async callOpenAI(requestData, apiKey, options = {}) {
        const { streaming = false, onChunk = null, tabId = null, timeout = 120000 } = options;
        const endpoint = API_ENDPOINTS[LLM_PROVIDERS.OPENAI].chat;

        console.log('📡 OpenAI API call:', { model: requestData.model, streaming });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        if (options.requestId) {
            this.activeRequests.set(options.requestId, controller);
        }

        try {
            const requestBody = {
                ...requestData,
                stream: streaming
            };

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
            }

            if (streaming) {
                return this.handleStreamingResponse(response, onChunk, tabId, options);
            }

            const data = await response.json();
            return data.choices[0]?.message?.content || '';
        } finally {
            if (options.requestId) {
                this.activeRequests.delete(options.requestId);
            }
        }
    }

    /**
     * Anthropic Claude API call
     */
    async callAnthropic(requestData, apiKey, options = {}) {
        const { streaming = false, onChunk = null, tabId = null, timeout = 120000 } = options;
        const endpoint = API_ENDPOINTS[LLM_PROVIDERS.ANTHROPIC].chat;

        console.log('📡 Anthropic API call:', { model: requestData.model, streaming });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        if (options.requestId) {
            this.activeRequests.set(options.requestId, controller);
        }

        try {
            // Convert OpenAI format to Anthropic format
            const messages = requestData.messages || [];
            let systemPrompt = '';
            const anthropicMessages = [];

            for (const msg of messages) {
                if (msg.role === 'system') {
                    systemPrompt += (systemPrompt ? '\n\n' : '') + msg.content;
                } else {
                    anthropicMessages.push({
                        role: msg.role === 'user' ? 'user' : 'assistant',
                        content: msg.content
                    });
                }
            }

            const requestBody = {
                model: requestData.model,
                max_tokens: requestData.max_tokens || 4096,
                messages: anthropicMessages,
                stream: streaming
            };

            if (systemPrompt) {
                requestBody.system = systemPrompt;
            }

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
            }

            if (streaming) {
                return this.handleAnthropicStreaming(response, onChunk, tabId, options);
            }

            const data = await response.json();
            // Anthropic returns content as an array of content blocks
            const textBlocks = data.content?.filter(block => block.type === 'text') || [];
            return textBlocks.map(block => block.text).join('') || '';
        } finally {
            if (options.requestId) {
                this.activeRequests.delete(options.requestId);
            }
        }
    }

    /**
     * Google Gemini API call
     */
    async callGoogle(requestData, apiKey, options = {}) {
        const { streaming = false, onChunk = null, tabId = null, timeout = 120000 } = options;
        const modelId = requestData.model;
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

        console.log('📡 Google Gemini API call:', { model: modelId, streaming });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        if (options.requestId) {
            this.activeRequests.set(options.requestId, controller);
        }

        try {
            // Convert OpenAI format to Gemini format
            const messages = requestData.messages || [];
            const contents = [];
            let systemInstruction = null;

            for (const msg of messages) {
                if (msg.role === 'system') {
                    systemInstruction = { parts: [{ text: msg.content }] };
                } else {
                    contents.push({
                        role: msg.role === 'user' ? 'user' : 'model',
                        parts: [{ text: msg.content }]
                    });
                }
            }

            const requestBody = {
                contents: contents,
                generationConfig: {
                    temperature: requestData.temperature || 0.3,
                    maxOutputTokens: requestData.max_tokens || 4096
                }
            };

            if (systemInstruction) {
                requestBody.systemInstruction = systemInstruction;
            }

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Google Gemini API error (${response.status}): ${errorText}`);
            }

            const data = await response.json();
            const candidates = data.candidates || [];
            if (candidates.length > 0 && candidates[0].content) {
                const parts = candidates[0].content.parts || [];
                return parts.map(part => part.text || '').join('');
            }
            return '';
        } finally {
            if (options.requestId) {
                this.activeRequests.delete(options.requestId);
            }
        }
    }

    /**
     * Groq API call (OpenAI-compatible)
     */
    async callGroq(requestData, apiKey, options = {}) {
        const { streaming = false, onChunk = null, tabId = null, timeout = 120000 } = options;
        const endpoint = API_ENDPOINTS[LLM_PROVIDERS.GROQ].chat;

        console.log('📡 Groq API call:', { model: requestData.model, streaming });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        if (options.requestId) {
            this.activeRequests.set(options.requestId, controller);
        }

        try {
            const requestBody = {
                ...requestData,
                stream: streaming
            };

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Groq API error (${response.status}): ${errorText}`);
            }

            if (streaming) {
                return this.handleStreamingResponse(response, onChunk, tabId, options);
            }

            const data = await response.json();
            return data.choices[0]?.message?.content || '';
        } finally {
            if (options.requestId) {
                this.activeRequests.delete(options.requestId);
            }
        }
    }

    /**
     * Mistral API call (OpenAI-compatible)
     */
    async callMistral(requestData, apiKey, options = {}) {
        const { streaming = false, onChunk = null, tabId = null, timeout = 120000 } = options;
        const endpoint = API_ENDPOINTS[LLM_PROVIDERS.MISTRAL].chat;

        console.log('📡 Mistral API call:', { model: requestData.model, streaming });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        if (options.requestId) {
            this.activeRequests.set(options.requestId, controller);
        }

        try {
            const requestBody = {
                ...requestData,
                stream: streaming
            };

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Mistral API error (${response.status}): ${errorText}`);
            }

            if (streaming) {
                return this.handleStreamingResponse(response, onChunk, tabId, options);
            }

            const data = await response.json();
            return data.choices[0]?.message?.content || '';
        } finally {
            if (options.requestId) {
                this.activeRequests.delete(options.requestId);
            }
        }
    }

    /**
     * Ollama (local) API call
     */
    async callOllama(requestData, options = {}) {
        const { streaming = false, onChunk = null, tabId = null, timeout = 300000 } = options; // 5 min timeout for local
        const endpoint = API_ENDPOINTS[LLM_PROVIDERS.LOCAL].chat;

        console.log('📡 Ollama (local) API call:', { model: requestData.model, streaming });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        if (options.requestId) {
            this.activeRequests.set(options.requestId, controller);
        }

        try {
            // Convert OpenAI format to Ollama format
            const messages = requestData.messages || [];
            const ollamaMessages = messages.map(msg => ({
                role: msg.role,
                content: msg.content
            }));

            const requestBody = {
                model: requestData.model,
                messages: ollamaMessages,
                stream: streaming,
                options: {
                    temperature: requestData.temperature || 0.3
                }
            };

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                if (response.status === 0 || errorText.includes('Failed to fetch')) {
                    throw new Error('Ollama server not running. Start it with: ollama serve');
                }
                throw new Error(`Ollama API error (${response.status}): ${errorText}`);
            }

            if (streaming) {
                return this.handleOllamaStreaming(response, onChunk, tabId, options);
            }

            const data = await response.json();
            return data.message?.content || '';
        } catch (error) {
            if (error.name === 'TypeError' && error.message.includes('Failed to fetch')) {
                throw new Error('Ollama server not running. Start it with: ollama serve');
            }
            throw error;
        } finally {
            if (options.requestId) {
                this.activeRequests.delete(options.requestId);
            }
        }
    }

    /**
     * Handle OpenAI-style streaming response (works for OpenAI, Groq, Mistral)
     */
    async handleStreamingResponse(response, onChunk, tabId, options = {}) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        let chunkCount = 0;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') continue;

                        try {
                            const parsed = JSON.parse(data);
                            const content = parsed.choices?.[0]?.delta?.content || '';
                            if (content) {
                                fullContent += content;
                                chunkCount++;

                                if (onChunk) {
                                    onChunk(content);
                                }

                                if (tabId) {
                                    this.sendChunkToTab(tabId, content, options.requestId, false);
                                }
                            }
                        } catch (e) {
                            // Ignore parse errors for malformed chunks
                        }
                    }
                }
            }

            // Send final chunk
            if (tabId) {
                this.sendChunkToTab(tabId, '', options.requestId, true);
            }

            console.log(`✅ Streaming complete: ${chunkCount} chunks, ${fullContent.length} chars`);
            return fullContent;
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Handle Anthropic streaming response
     */
    async handleAnthropicStreaming(response, onChunk, tabId, options = {}) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        let chunkCount = 0;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.type === 'content_block_delta') {
                                const content = parsed.delta?.text || '';
                                if (content) {
                                    fullContent += content;
                                    chunkCount++;

                                    if (onChunk) {
                                        onChunk(content);
                                    }

                                    if (tabId) {
                                        this.sendChunkToTab(tabId, content, options.requestId, false);
                                    }
                                }
                            }
                        } catch (e) {
                            // Ignore parse errors
                        }
                    }
                }
            }

            if (tabId) {
                this.sendChunkToTab(tabId, '', options.requestId, true);
            }

            console.log(`✅ Anthropic streaming complete: ${chunkCount} chunks, ${fullContent.length} chars`);
            return fullContent;
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Handle Ollama streaming response (NDJSON format)
     */
    async handleOllamaStreaming(response, onChunk, tabId, options = {}) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        let chunkCount = 0;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter(line => line.trim());

                for (const line of lines) {
                    try {
                        const parsed = JSON.parse(line);
                        const content = parsed.message?.content || '';
                        if (content) {
                            fullContent += content;
                            chunkCount++;

                            if (onChunk) {
                                onChunk(content);
                            }

                            if (tabId) {
                                this.sendChunkToTab(tabId, content, options.requestId, false);
                            }
                        }

                        if (parsed.done) {
                            break;
                        }
                    } catch (e) {
                        // Ignore parse errors
                    }
                }
            }

            if (tabId) {
                this.sendChunkToTab(tabId, '', options.requestId, true);
            }

            console.log(`✅ Ollama streaming complete: ${chunkCount} chunks, ${fullContent.length} chars`);
            return fullContent;
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Send streaming chunk to tab
     */
    sendChunkToTab(tabId, content, requestId, isLastChunk) {
        chrome.tabs.sendMessage(tabId, {
            action: 'TEST_CHUNK',
            requestId: requestId,
            tabId: tabId,
            data: {
                chunk: content,
                isLastChunk: isLastChunk,
                isComplete: isLastChunk
            }
        }).catch(() => {
            // Tab might be closed
        });
    }

    /**
     * Cancel an active request
     */
    cancelRequest(requestId) {
        const controller = this.activeRequests.get(requestId);
        if (controller) {
            console.log('🛑 Cancelling request:', requestId);
            controller.abort();
            this.activeRequests.delete(requestId);
        }
    }

    /**
     * Check if Ollama is running
     */
    async checkOllamaStatus() {
        try {
            const response = await fetch('http://localhost:11434/api/tags', {
                method: 'GET'
            });

            if (response.ok) {
                const data = await response.json();
                return {
                    running: true,
                    models: data.models || []
                };
            }
            return { running: false, models: [] };
        } catch (error) {
            return { running: false, models: [], error: error.message };
        }
    }

    /**
     * Get available Ollama models
     */
    async getOllamaModels() {
        const status = await this.checkOllamaStatus();
        if (!status.running) {
            return [];
        }
        return status.models.map(model => ({
            id: `local:${model.name}`,
            name: model.name,
            size: model.size,
            modifiedAt: model.modified_at
        }));
    }
}

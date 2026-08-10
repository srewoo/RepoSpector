/**
 * LLMService - Multi-provider LLM abstraction layer
 * Supports: OpenAI, Anthropic (Claude), Google (Gemini), Groq, Mistral, and Ollama (local)
 */

import { LLM_PROVIDERS, API_ENDPOINTS } from '../utils/constants.js';
import { resolveModel } from '../utils/modelResolver.js';
import {
    buildAnthropicSystem,
    extractCacheUsage,
    flattenContent,
    toAnthropicContent,
} from '../utils/promptCache.js';
import {
    normalizeAnthropicToolCalls,
    normalizeOpenAIToolCalls,
} from '../utils/toolProtocol.js';

export class LLMService {
    constructor() {
        this.activeRequests = new Map();
        this.maxRetries = 3;
        this.baseDelay = 1000; // 1 second
    }

    /**
     * Can this provider drive a tool-use loop?
     *
     * Deliberately a short allow-list rather than a best-effort attempt
     * everywhere. Google's function-calling uses a different request and
     * response shape, and Ollama's support varies by model — a loop that
     * half-works there would fail as "the model ignored the tools", which is
     * indistinguishable from the model choosing not to call one. Callers check
     * this and fall back to the ordinary single-shot path.
     *
     * @param {string} provider
     * @returns {boolean}
     */
    static supportsTools(provider) {
        return provider === LLM_PROVIDERS.OPENAI
            || provider === LLM_PROVIDERS.ANTHROPIC
            || provider === LLM_PROVIDERS.GROQ
            || provider === LLM_PROVIDERS.MISTRAL;
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
        const { provider, model, apiKey, stream = false, onChunk, tabId, context } = options;

        // No fallback. This previously read `model || 'openai:gpt-4.1-mini'`, so a
        // caller that forgot to pass a model silently billed the user's OpenAI key
        // for a model they never selected — and the resulting review was attributed
        // to the wrong model. Resolve strictly, or fail.
        //
        // `provider` used to be destructured as `_provider` and thrown away, which
        // made the Settings provider field decorative. It is now honoured: it
        // disambiguates an unprefixed model and must agree with any prefix.
        const resolved = resolveModel(model, {
            explicitProvider: provider,
            context: context || 'an LLM call',
        });

        const requestData = {
            model: resolved.modelIdentifier,
            messages
        };
        // Tool definitions travel in the OpenAI shape; each provider adapter
        // translates. Omitted entirely when absent so non-tool calls are
        // byte-identical to what they were.
        if (Array.isArray(options.tools) && options.tools.length > 0) {
            requestData.tools = options.tools;
        }

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
        // Strict: never assume OpenAI. The old default meant any identifier
        // without a "provider:" prefix — including "claude-sonnet-4" — was routed
        // to api.openai.com with the user's OpenAI key.
        return resolveModel(modelIdentifier, { context: 'provider lookup' }).provider;
    }

    /**
     * Get model ID from model identifier (e.g., "openai:gpt-4.1-mini" -> "gpt-4.1-mini")
     * @param {string} modelIdentifier - Full model identifier
     * @returns {string} Model ID for API calls
     */
    getModelId(modelIdentifier) {
        // Strict: no 'gpt-4.1-mini' default. A missing identifier is a bug in the
        // caller, not a reason to spend the user's budget on an arbitrary model.
        return resolveModel(modelIdentifier, { context: 'model id lookup' }).modelId;
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

        // Update request data with actual model ID.
        //
        // A message's `content` may be an array of `{ text, cache }` parts so a
        // caller can mark where its cacheable prefix ends. Only Anthropic has a
        // wire format for that; for every other provider the parts are joined
        // back into the exact string they would otherwise have sent, so those
        // request bodies are byte-identical to before.
        const normalizedRequest = {
            ...requestData,
            model: modelId,
            messages: provider === LLM_PROVIDERS.ANTHROPIC
                ? (requestData.messages || [])
                : (requestData.messages || []).map(m => ({
                    ...m,
                    content: flattenContent(m.content),
                })),
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
                // Never fall back to OpenAI. Doing so sent a request intended for
                // another provider to api.openai.com using whatever key was to hand
                // — wrong model, wrong bill, and the user's code shipped to a
                // provider they did not choose.
                throw new Error(
                    `Unknown LLM provider '${provider}'. RepoSpector will not substitute a `
                    + `different provider. Re-select your provider and model in Settings.`
                );
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
            const message = data.choices[0]?.message || {};
            return {
                content: message.content || '',
                // Normalized so a caller driving a tool loop does not have to
                // know which provider answered. Empty array when the model made
                // no calls, so `.length` is always safe.
                toolCalls: normalizeOpenAIToolCalls(message.tool_calls),
                raw: message,
                usage: {
                    input: data.usage?.prompt_tokens ?? 0,
                    output: data.usage?.completion_tokens ?? 0,
                    // OpenAI caches automatically on a stable prefix — there is
                    // no marker to send, only a result to read back. Surfaced
                    // so a prefix that drifts shows up as cacheRead flatlining
                    // at 0 rather than as a quiet cost increase.
                    ...extractCacheUsage(data.usage, LLM_PROVIDERS.OPENAI),
                },
            };
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
            const cache = options.cachePrompt !== false;

            // System messages become the `system` field. Blocks with a
            // `cache_control` breakpoint when they clear the provider's
            // minimum, a plain string when they do not — in which case a marker
            // would be silently ignored anyway.
            const system = buildAnthropicSystem(messages, { cache });

            // Anthropic renders tools → system → messages, and caching matches
            // on that whole prefix. So the system text counts toward the
            // minimum for a breakpoint placed in the first user message, and
            // has to be carried in rather than measured per-message. In this
            // codebase that is what makes user-turn caching viable at all: the
            // system prompts run a few hundred tokens each, well under the bar
            // on their own.
            let rendered = typeof system === 'string'
                ? system
                : (system || []).map(b => b.text).join('');

            const anthropicMessages = [];
            for (const msg of messages) {
                if (msg.role === 'system') continue;
                const content = toAnthropicContent(msg.content, {
                    cache,
                    prefixText: rendered,
                });
                rendered += flattenContent(msg.content);
                anthropicMessages.push({
                    role: msg.role === 'user' ? 'user' : 'assistant',
                    content,
                });
            }

            const requestBody = {
                model: requestData.model,
                max_tokens: requestData.max_tokens || 4096,
                messages: anthropicMessages,
                stream: streaming
            };

            if (system) {
                requestBody.system = system;
            }

            // Tools arrive in the OpenAI shape (one shape for every caller) and
            // are translated here. Anthropic nests the schema under
            // `input_schema` rather than `function.parameters`.
            if (Array.isArray(requestData.tools) && requestData.tools.length > 0) {
                requestBody.tools = requestData.tools.map(t => ({
                    name: t.function?.name ?? t.name,
                    description: t.function?.description ?? t.description ?? '',
                    input_schema: t.function?.parameters ?? t.input_schema ?? { type: 'object', properties: {} },
                }));
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
            const cacheUsage = extractCacheUsage(data.usage, LLM_PROVIDERS.ANTHROPIC);
            return {
                content: textBlocks.map(block => block.text).join('') || '',
                toolCalls: normalizeAnthropicToolCalls(data.content),
                // The assistant turn must be echoed back verbatim on the next
                // request of a tool loop, tool_use blocks included — rebuilding
                // it from `content` alone would drop them and orphan the results.
                raw: { role: 'assistant', content: data.content || [] },
                stopReason: data.stop_reason || null,
                usage: {
                    // `input` is the TOTAL prompt size, matching what it means
                    // on every other provider and what it meant here before
                    // caching existed. Anthropic's own `input_tokens` counts
                    // only the uncached remainder, so reporting it directly
                    // would have made every caller that sums `usage.input`
                    // under-report by exactly the amount caching saved — the
                    // token totals would have appeared to fall for a reason
                    // that has nothing to do with how much work was done.
                    input: cacheUsage.promptTotal,
                    output: data.usage?.output_tokens ?? 0,
                    // The uncached remainder, kept under its own name for
                    // anyone reasoning about spend rather than prompt size.
                    inputUncached: data.usage?.input_tokens ?? 0,
                    ...cacheUsage,
                },
            };
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
        const { streaming = false, _onChunk = null, _tabId = null, timeout = 120000 } = options;
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
            // Accumulate system parts rather than assigning. This used to be a
            // plain assignment, so a request with more than one system message
            // silently kept only the LAST — the instructions in the first were
            // dropped with no error. Callers now split stable instructions and
            // large stable context across two system messages to form a
            // cacheable prefix, which would have hit that bug every time.
            const systemParts = [];

            for (const msg of messages) {
                if (msg.role === 'system') {
                    systemParts.push({ text: String(msg.content ?? '') });
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

            if (systemParts.length > 0) {
                requestBody.systemInstruction = { parts: systemParts };
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
            const usage = {
                input: data.usageMetadata?.promptTokenCount ?? 0,
                output: data.usageMetadata?.candidatesTokenCount ?? 0,
            };
            if (candidates.length > 0 && candidates[0].content) {
                const parts = candidates[0].content.parts || [];
                return {
                    content: parts.map(part => part.text || '').join(''),
                    usage,
                };
            }
            return { content: '', usage };
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
            return {
                content: data.choices[0]?.message?.content || '',
                usage: {
                    input: data.usage?.prompt_tokens ?? 0,
                    output: data.usage?.completion_tokens ?? 0,
                    ...extractCacheUsage(data.usage, LLM_PROVIDERS.OPENAI),
                },
            };
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
            return {
                content: data.choices[0]?.message?.content || '',
                usage: {
                    input: data.usage?.prompt_tokens ?? 0,
                    output: data.usage?.completion_tokens ?? 0,
                    ...extractCacheUsage(data.usage, LLM_PROVIDERS.OPENAI),
                },
            };
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
            // eslint-disable-next-line no-constant-condition -- SSE reader loop, exits via break/return
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

                                if (tabId || options.isFromPopup) {
                                    this.sendChunk(tabId, content, fullContent, options.requestId, false, options.isFromPopup);
                                }
                            }
                        } catch (e) {
                            // Ignore parse errors for malformed chunks
                        }
                    }
                }
            }

            // Send final chunk
            if (tabId || options.isFromPopup) {
                this.sendChunk(tabId, '', fullContent, options.requestId, true, options.isFromPopup);
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
            // eslint-disable-next-line no-constant-condition -- SSE reader loop, exits via break/return
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

                                    if (tabId || options.isFromPopup) {
                                        this.sendChunk(tabId, content, fullContent, options.requestId, false, options.isFromPopup);
                                    }
                                }
                            }
                        } catch (e) {
                            // Ignore parse errors
                        }
                    }
                }
            }

            if (tabId || options.isFromPopup) {
                this.sendChunk(tabId, '', fullContent, options.requestId, true, options.isFromPopup);
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
            // eslint-disable-next-line no-constant-condition -- SSE reader loop, exits via break/return
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

                            if (tabId || options.isFromPopup) {
                                this.sendChunk(tabId, content, fullContent, options.requestId, false, options.isFromPopup);
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

            if (tabId || options.isFromPopup) {
                this.sendChunk(tabId, '', fullContent, options.requestId, true, options.isFromPopup);
            }

            console.log(`✅ Ollama streaming complete: ${chunkCount} chunks, ${fullContent.length} chars`);
            return fullContent;
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Send streaming chunk to the appropriate destination (popup or tab)
     */
    sendChunk(tabId, chunk, fullContent, requestId, isLastChunk, isFromPopup = false) {
        const payload = {
            action: 'TEST_CHUNK',
            requestId: requestId,
            tabId: tabId,
            data: {
                chunk: chunk,
                fullContent: fullContent,
                isLastChunk: isLastChunk,
                isComplete: isLastChunk
            }
        };

        if (isFromPopup) {
            chrome.runtime.sendMessage(payload).catch(() => {
                // Popup might be closed
            });
        } else if (tabId) {
            chrome.tabs.sendMessage(tabId, payload).catch(() => {
                // Tab might be closed
            });
        }
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

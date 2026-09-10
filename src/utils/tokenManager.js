/**
 * Token Management Utility
 * Manages token counting and context window management for LLM requests
 */

import { MODELS } from './constants.js';

/**
 * Context windows straight from the model catalogue, indexed by BOTH shapes a
 * caller can hand us: the catalogue key (`groq:mixtral-8x7b`, what
 * MultiPassReviewEngine/MultiFinderService pass) and the RESOLVED provider
 * model id (`mixtral-8x7b-32768`, what getModelId(settings.model) returns and
 * what src/background/index.js passes).
 *
 * This exists because the resolved-id shape matched none of the hand-written
 * tables below and fell through to the 128000 default — reporting a 128k
 * window for a 32k model, which turns an over-chunking annoyance into a
 * provider 400. Making the catalogue the fallback also means a model added to
 * constants.js is right here automatically, with no second table to update.
 */
const CATALOGUE_CONTEXT_WINDOWS = (() => {
    const map = Object.create(null);
    for (const [key, spec] of Object.entries(MODELS || {})) {
        const ctx = Number(spec?.contextWindow);
        if (!Number.isFinite(ctx) || ctx <= 0) continue;
        map[key.toLowerCase()] = ctx;
        if (spec.modelId) map[String(spec.modelId).toLowerCase()] = ctx;
    }
    return Object.freeze(map);
})();

export class TokenManager {
    constructor(options = {}) {
        // Context windows. Exact names first; `familyLimits` below resolves
        // anything with a version suffix. Keep the exact table small — the
        // family table is what actually fires for dated model ids.
        this.modelLimits = {
            'gpt-4.1': 128000, 'gpt-4.1-mini': 128000, 'gpt-4-turbo': 128000,
            'gpt-4o': 128000, 'gpt-4o-mini': 128000,
            'gpt-4': 8192, 'gpt-3.5-turbo': 16385,
            'claude-3.5-sonnet': 200000, 'claude-3-haiku': 200000, 'claude-3-opus': 200000,
            'gemini-2.0-flash': 1000000, 'gemini-1.5-pro': 2000000, 'gemini-1.5-flash': 1000000,
            'llama-3.3-70b': 128000, 'llama3-70b': 8192,
            'mistral-large-latest': 128000, 'mixtral-8x7b': 32768,
            // An unknown model in 2026 is far more likely to have 128k than 8k.
            // 8000 silently cut the diff budget to ~2400 tokens per review unit.
            'default': 128000,
        };

        // Longest prefix wins. Order does not matter.
        this.familyLimits = {
            'gpt-5': 400000, 'o3': 200000, 'o4': 200000, 'o1': 200000,
            'gpt-4o': 128000, 'gpt-4.1': 128000,
            'claude-sonnet-4': 200000, 'claude-opus-4': 200000, 'claude-haiku-4': 200000,
            'claude-3': 200000, 'claude-sonnet-5': 200000, 'claude-opus-5': 200000, 'claude-fable-5': 200000,
            'gemini-2.5': 1000000, 'gemini-2.0': 1000000, 'gemini-1.5': 1000000,
            'llama-3.3': 128000, 'llama-3.1': 128000, 'llama-4': 128000,
            // No `codestral` entry: it used to claim 256000 while the
            // catalogue (constants.js, 'mistral:codestral') says 32000, and a
            // maintainer had no way to tell which was right. The catalogue is
            // authoritative, and `codestral-latest` now resolves through it.
            'mistral-large': 128000,
        };

        this.outputLimits = {
            'gpt-4.1': 16384, 'gpt-4.1-mini': 16384, 'gpt-4-turbo': 4096,
            'claude-3.5-sonnet': 8192, 'claude-3-haiku': 4096,
            'gemini-2.0-flash': 8192, 'gemini-1.5-pro': 8192,
            'llama-3.3-70b': 8192, 'mistral-large-latest': 8192,
            'default': 8192,
        };
        this.familyOutputLimits = {
            'gpt-5': 16384, 'o3': 16384, 'o4': 16384, 'gpt-4o': 16384,
            'claude-sonnet-4': 8192, 'claude-opus-4': 8192, 'claude-haiku-4': 8192,
            'claude-sonnet-5': 8192, 'claude-opus-5': 8192, 'claude-fable-5': 8192,
            'gemini-2.5': 8192,
        };

        // Reserve tokens for system prompt and output
        this.reservedTokens = options.reservedTokens || 4000;

        // Approximate tokens per character (OpenAI uses ~4 chars/token)
        this.tokensPerChar = 0.25;
    }

    /**
     * Estimate token count for text using character-based approximation
     * More accurate than simple char/4 - accounts for code patterns
     */
    estimateTokens(text) {
        if (!text) return 0;

        // Handle case where text is just a length object (from getTokenBudget)
        if (typeof text !== 'string') {
            const len = text.length || 0;
            return Math.ceil(len * this.tokensPerChar);
        }

        // More accurate estimation for different content types
        let chars = text.length;

        // Code typically has more tokens per character due to syntax
        const codePatterns = /[{}()[\];,.]|function|const|let|var|class|import|export/g;
        const codeMatches = text.match(codePatterns);
        if (codeMatches && codeMatches.length > chars * 0.05) {
            // Likely code - use higher token ratio
            return Math.ceil(chars * 0.3);
        }

        // Standard text
        return Math.ceil(chars * this.tokensPerChar);
    }

    /**
     * Resolve a model identifier against an exact-name table, then a
     * longest-matching-family-prefix table, then `catalogue` (an optional
     * id → value map consulted with the RAW identifier as well, since
     * extractModelName mangles ids that legitimately contain a colon such as
     * `qwen2.5-coder:32b`), then that table's default.
     */
    _resolve(table, familyTable, modelIdentifier, catalogue = null) {
        const name = this.extractModelName(modelIdentifier).toLowerCase();
        if (table[name] != null) return table[name];
        // Strip a vendor path ("anthropic/claude-sonnet-4") that gateways add.
        const bare = name.includes('/') ? name.split('/').pop() : name;
        if (table[bare] != null) return table[bare];
        let best = null;
        for (const prefix of Object.keys(familyTable)) {
            if (bare.startsWith(prefix) && (best === null || prefix.length > best.length)) best = prefix;
        }
        if (best !== null) return familyTable[best];
        if (catalogue) {
            const raw = String(modelIdentifier || '').toLowerCase();
            // Ollama ids carry a `:tag` the catalogue does not key on
            // (`local:qwen2.5-coder` covers every tag of that model), and
            // extractModelName reduces `qwen2.5-coder:32b` to `32b`, so try the
            // id with its provider prefix and tag stripped as well.
            const noProvider = raw.startsWith('local:') ? raw.slice('local:'.length) : raw;
            const untagged = noProvider.split(':')[0];
            for (const key of [raw, name, bare, noProvider, untagged, `local:${untagged}`]) {
                if (catalogue[key] != null) return catalogue[key];
            }
        }
        return table.default;
    }

    /**
     * Get maximum context tokens for a model. Falls back to the model
     * catalogue before the generous 128000 default, so a resolved provider
     * model id (`mixtral-8x7b-32768`, `mistral-small-latest`,
     * `codestral-latest`, `qwen2.5-coder:32b`) reports its REAL window
     * instead of one four times too large.
     */
    getModelLimit(modelIdentifier) {
        return this._resolve(
            this.modelLimits, this.familyLimits, modelIdentifier, CATALOGUE_CONTEXT_WINDOWS,
        );
    }

    /**
     * Get maximum output tokens for a model
     */
    getOutputLimit(modelIdentifier) {
        return this._resolve(this.outputLimits, this.familyOutputLimits, modelIdentifier);
    }

    /**
     * Extract model name from full identifier
     */
    extractModelName(modelIdentifier) {
        if (!modelIdentifier) return 'default';

        // Handle "provider:model" format
        if (modelIdentifier.includes(':')) {
            const parts = modelIdentifier.split(':');
            return parts[parts.length - 1];
        }

        return modelIdentifier;
    }

    /**
     * Calculate available tokens for input
     */
    getAvailableTokens(modelIdentifier) {
        const modelLimit = this.getModelLimit(modelIdentifier);
        const outputLimit = this.getOutputLimit(modelIdentifier);

        // Available = Total - Reserved for output - Safety buffer
        const safetyBuffer = 1000;
        return modelLimit - outputLimit - safetyBuffer;
    }

    /**
     * Count tokens in a messages array (for chat)
     */
    countMessagesTokens(messages) {
        let totalTokens = 0;

        for (const message of messages) {
            // Account for message structure overhead (~4 tokens per message)
            totalTokens += 4;

            // Count role tokens
            totalTokens += this.estimateTokens(message.role || '');

            // Count content tokens
            totalTokens += this.estimateTokens(message.content || '');

            // Account for name if present
            if (message.name) {
                totalTokens += this.estimateTokens(message.name);
            }
        }

        return totalTokens;
    }

    /**
     * Prune messages to fit within token limit
     * Keeps system messages and recent conversation
     */
    pruneMessages(messages, modelIdentifier, targetTokens = null) {
        const maxTokens = targetTokens || this.getAvailableTokens(modelIdentifier);

        if (!messages || messages.length === 0) return [];

        // Separate system messages from conversation
        const systemMessages = messages.filter(m => m.role === 'system');
        const conversationMessages = messages.filter(m => m.role !== 'system');

        // Always keep system messages
        let prunedMessages = [...systemMessages];
        let currentTokens = this.countMessagesTokens(systemMessages);

        // Add conversation messages from most recent, working backwards
        for (let i = conversationMessages.length - 1; i >= 0; i--) {
            const message = conversationMessages[i];
            const messageTokens = this.countMessagesTokens([message]);

            if (currentTokens + messageTokens <= maxTokens) {
                // Add message at the beginning of conversation (maintaining order)
                prunedMessages.splice(systemMessages.length, 0, message);
                currentTokens += messageTokens;
            } else {
                // Stop if we can't fit more messages
                console.log(`⚠️ Pruned ${i + 1} older messages to fit token limit`);
                break;
            }
        }

        // Restore chronological order for conversation
        const systemPart = prunedMessages.filter(m => m.role === 'system');
        const conversationPart = prunedMessages.filter(m => m.role !== 'system');

        return [...systemPart, ...conversationPart];
    }

    /**
     * Truncate code content to fit within token budget
     */
    truncateCode(code, targetTokens) {
        const currentTokens = this.estimateTokens(code);

        if (currentTokens <= targetTokens) {
            return code;
        }

        // Calculate how much to keep (with 10% safety buffer)
        const ratio = (targetTokens * 0.9) / currentTokens;
        const targetLength = Math.floor(code.length * ratio);

        // Try to truncate at a sensible boundary
        const truncated = code.substring(0, targetLength);

        // Find last complete line
        const lastNewline = truncated.lastIndexOf('\n');
        if (lastNewline > targetLength * 0.8) {
            return truncated.substring(0, lastNewline) + '\n\n// ... (code truncated to fit token limit)';
        }

        return truncated + '\n\n// ... (code truncated to fit token limit)';
    }

    /**
     * Split large code into chunks that fit within token limits
     */
    chunkCode(code, modelIdentifier) {
        const maxTokens = this.getAvailableTokens(modelIdentifier);
        const codeTokens = this.estimateTokens(code);

        // If code fits, return as single chunk
        if (codeTokens <= maxTokens) {
            return [{
                content: code,
                index: 0,
                total: 1,
                tokens: codeTokens
            }];
        }

        // Calculate chunk size (with overlap for context)
        const overlapTokens = 500;
        const chunkTokens = maxTokens - overlapTokens;
        const chunkSize = Math.floor(chunkTokens / this.tokensPerChar);

        const chunks = [];
        let startIndex = 0;

        while (startIndex < code.length) {
            let endIndex = Math.min(startIndex + chunkSize, code.length);

            // Try to break at a natural boundary (function, class, newline)
            if (endIndex < code.length) {
                // Look for good break points in the last 20% of chunk
                const searchStart = endIndex - Math.floor(chunkSize * 0.2);
                const searchRegion = code.substring(searchStart, endIndex);

                // Find natural boundaries
                const boundaries = [
                    searchRegion.lastIndexOf('\nfunction '),
                    searchRegion.lastIndexOf('\nclass '),
                    searchRegion.lastIndexOf('\nexport '),
                    searchRegion.lastIndexOf('\n\n'),
                    searchRegion.lastIndexOf('}\n')
                ];

                const bestBoundary = Math.max(...boundaries);
                if (bestBoundary > 0) {
                    endIndex = searchStart + bestBoundary + 1;
                }
            }

            const chunkContent = code.substring(startIndex, endIndex);
            chunks.push({
                content: chunkContent,
                index: chunks.length,
                total: 0, // Will be updated after loop
                tokens: this.estimateTokens(chunkContent),
                startChar: startIndex,
                endChar: endIndex
            });

            // Move to next chunk with overlap
            const overlapChars = Math.floor(overlapTokens / this.tokensPerChar);
            startIndex = endIndex - overlapChars;
        }

        // Update total count
        chunks.forEach(chunk => chunk.total = chunks.length);

        console.log(`📦 Split code into ${chunks.length} chunks (total: ${codeTokens} tokens, limit: ${maxTokens})`);
        return chunks;
    }

    /**
     * Get token budget summary
     */
    getTokenBudget(modelIdentifier, codeLength, messageCount = 0) {
        const modelLimit = this.getModelLimit(modelIdentifier);
        const availableTokens = this.getAvailableTokens(modelIdentifier);
        const codeTokens = this.estimateTokens({ length: codeLength });
        const messageOverhead = messageCount * 10; // Approximate overhead per message

        return {
            modelLimit,
            availableTokens,
            codeTokens,
            messageOverhead,
            remainingTokens: availableTokens - codeTokens - messageOverhead,
            needsChunking: codeTokens > availableTokens * 0.8,
            utilizationPercent: Math.round((codeTokens / availableTokens) * 100)
        };
    }

    /**
     * Validate token count before sending request
     */
    validateTokenCount(messages, modelIdentifier) {
        const totalTokens = this.countMessagesTokens(messages);
        const modelLimit = this.getModelLimit(modelIdentifier);

        if (totalTokens > modelLimit) {
            return {
                valid: false,
                totalTokens,
                modelLimit,
                excessTokens: totalTokens - modelLimit,
                recommendation: `Reduce message length by ${totalTokens - modelLimit} tokens. Consider enabling chunking or removing older messages.`
            };
        }

        return {
            valid: true,
            totalTokens,
            modelLimit,
            remainingTokens: modelLimit - totalTokens,
            utilizationPercent: Math.round((totalTokens / modelLimit) * 100)
        };
    }
}

// Export singleton instance
export const tokenManager = new TokenManager();

import { encodingForModel } from 'js-tiktoken';

/**
 * Conversation History Manager
 * Manages conversation context and history for continuous conversations
 */

const MAX_HISTORY_LENGTH = 20; // Maximum messages to keep in history
const MAX_CONTEXT_TOKENS = 8000; // Approximate token limit for context
const STORAGE_KEY = 'repospector_conversation_history';
const SESSION_KEY = 'repospector_session_id';

export class ConversationHistoryManager {
    constructor() {
        this.currentHistory = [];
        this.sessionId = null;
        this.codeContext = null;
        this.initialized = false;
        this.tokenizer = encodingForModel('gpt-4o-mini');
    }

    /**
     * Initialize conversation history manager
     */
    async initialize() {
        if (this.initialized) return;

        try {
            // Clean up old sessions first
            await this.cleanupOldSessions();

            // Get or create session ID
            const stored = await this.getFromStorage(SESSION_KEY);
            if (stored && stored.sessionId && this.isSessionValid(stored)) {
                this.sessionId = stored.sessionId;
                this.codeContext = stored.codeContext;
                console.log(`📝 Resuming session: ${this.sessionId}`);
            } else {
                this.sessionId = this.generateSessionId();
                await this.saveSessionInfo();
                console.log(`📝 New session created: ${this.sessionId}`);
            }

            // Load conversation history
            await this.loadHistory();
            this.initialized = true;

        } catch (error) {
            console.error('Failed to initialize conversation history:', error);
            this.sessionId = this.generateSessionId();
            this.initialized = true;
        }
    }

    /**
     * Clean up old sessions and expired history
     */
    async cleanupOldSessions() {
        try {
            const MAX_STORAGE_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
            const stored = await this.getFromStorage(STORAGE_KEY);

            if (stored && stored.timestamp) {
                const age = Date.now() - stored.timestamp;

                if (age > MAX_STORAGE_AGE) {
                    console.log(`🗑️ Cleaning up old conversation history (age: ${Math.round(age / (24 * 60 * 60 * 1000))} days)`);
                    await this.saveToStorage(STORAGE_KEY, null);
                }
            }

            // Also check and clean session info
            const sessionStored = await this.getFromStorage(SESSION_KEY);
            if (sessionStored && !this.isSessionValid(sessionStored)) {
                console.log('🗑️ Cleaning up expired session');
                await this.saveToStorage(SESSION_KEY, null);
            }
        } catch (error) {
            console.warn('Failed to cleanup old sessions:', error);
        }
    }

    /**
     * Generate unique session ID
     */
    generateSessionId() {
        return `session_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    }

    /**
     * Check if session is still valid (not expired)
     */
    isSessionValid(sessionData) {
        const MAX_SESSION_AGE = 24 * 60 * 60 * 1000; // 24 hours
        const age = Date.now() - (sessionData.timestamp || 0);
        return age < MAX_SESSION_AGE;
    }

    /**
     * Save session information
     */
    async saveSessionInfo() {
        try {
            await this.saveToStorage(SESSION_KEY, {
                sessionId: this.sessionId,
                codeContext: this.codeContext,
                timestamp: Date.now()
            });
        } catch (error) {
            console.error('Failed to save session info:', error);
        }
    }

    /**
     * Set code context for the conversation
     */
    async setCodeContext(codeContext) {
        this.codeContext = {
            filePath: codeContext.filePath,
            language: codeContext.language,
            repository: codeContext.repository,
            lastUpdated: Date.now()
        };
        await this.saveSessionInfo();
    }

    /**
     * Get code context
     */
    getCodeContext() {
        return this.codeContext;
    }

    /**
     * Add message to history
     */
    async addMessage(message) {
        if (!this.initialized) {
            await this.initialize();
        }

        const historyMessage = {
            id: message.id,
            role: message.role,
            content: message.content,
            type: message.type || 'text',
            timestamp: Date.now()
        };

        this.currentHistory.push(historyMessage);

        // Trim history if it exceeds max length
        if (this.currentHistory.length > MAX_HISTORY_LENGTH) {
            // Keep system message and recent messages
            const systemMessages = this.currentHistory.filter(m => m.role === 'system');
            const recentMessages = this.currentHistory.slice(-MAX_HISTORY_LENGTH + systemMessages.length);
            this.currentHistory = [...systemMessages, ...recentMessages];
        }

        // Save to storage
        await this.saveHistory();
    }

    /**
     * Get conversation history formatted for LLM
     */
    getFormattedHistory(includeCodeContext = true) {
        const messages = [];

        // Add code context as system message if available
        if (includeCodeContext && this.codeContext) {
            messages.push({
                role: 'system',
                content: `Current code context:\nFile: ${this.codeContext.filePath || 'unknown'}\nLanguage: ${this.codeContext.language || 'unknown'}\nRepository: ${this.codeContext.repository || 'unknown'}`
            });
        }

        // Add conversation history with token management
        const relevantHistory = this.pruneHistoryByTokens(this.currentHistory);
        messages.push(...relevantHistory.map(msg => ({
            role: msg.role,
            content: msg.content
        })));

        return messages;
    }

    /**
     * Prune history to fit within token limits
     */
    pruneHistoryByTokens(history) {
        let totalTokens = 0;
        const pruned = [];

        // Process from most recent to oldest
        for (let i = history.length - 1; i >= 0; i--) {
            const msg = history[i];
            const msgTokens = this.countTokens(msg.content);

            if (totalTokens + msgTokens <= MAX_CONTEXT_TOKENS) {
                pruned.unshift(msg);
                totalTokens += msgTokens;
            } else {
                // Skip this message if adding it would exceed token limit
                console.log(`⚠️ Pruning message ${msg.id} to stay within token limit`);
            }
        }

        return pruned;
    }

    /**
     * Count tokens using tiktoken
     */
    countTokens(text) {
        if (!text) return 0;
        try {
            return this.tokenizer.encode(text).length;
        } catch (e) {
            console.warn('Token counting failed, falling back to estimation', e);
            return Math.ceil(text.length / 4);
        }
    }

    /**
     * Get recent conversation summary
     */
    getSummary(messageCount = 5) {
        const recent = this.currentHistory.slice(-messageCount);
        return {
            messageCount: recent.length,
            totalMessages: this.currentHistory.length,
            sessionId: this.sessionId,
            codeContext: this.codeContext,
            messages: recent.map(m => ({
                role: m.role,
                preview: m.content.substring(0, 100) + (m.content.length > 100 ? '...' : ''),
                timestamp: m.timestamp
            }))
        };
    }

    /**
     * Clear conversation history
     */
    async clearHistory() {
        this.currentHistory = [];
        await this.saveHistory();
        console.log('📝 Conversation history cleared');
    }

    /**
     * Start new session (clears history and creates new session ID)
     */
    async startNewSession() {
        await this.clearHistory();
        this.sessionId = this.generateSessionId();
        this.codeContext = null;
        await this.saveSessionInfo();
        console.log(`📝 New session started: ${this.sessionId}`);
    }

    /**
     * Load history from storage
     */
    async loadHistory() {
        try {
            const stored = await this.getFromStorage(STORAGE_KEY);
            if (stored && stored.sessionId === this.sessionId) {
                this.currentHistory = stored.history || [];
                console.log(`📝 Loaded ${this.currentHistory.length} messages from history`);
            } else {
                this.currentHistory = [];
                console.log('📝 Starting with empty history');
            }
        } catch (error) {
            console.error('Failed to load history:', error);
            this.currentHistory = [];
        }
    }

    /**
     * Save history to storage
     */
    async saveHistory() {
        try {
            await this.saveToStorage(STORAGE_KEY, {
                sessionId: this.sessionId,
                history: this.currentHistory,
                timestamp: Date.now()
            });
        } catch (error) {
            console.error('Failed to save history:', error);
        }
    }

    /**
     * Get data from chrome.storage.local
     */
    async getFromStorage(key) {
        if (typeof chrome !== 'undefined' && chrome.storage) {
            return new Promise((resolve) => {
                chrome.storage.local.get([key], (result) => {
                    resolve(result[key]);
                });
            });
        } else {
            // Fallback to localStorage for non-extension environments
            const item = localStorage.getItem(key);
            return item ? JSON.parse(item) : null;
        }
    }

    /**
     * Save data to chrome.storage.local
     */
    async saveToStorage(key, value) {
        if (typeof chrome !== 'undefined' && chrome.storage) {
            return new Promise((resolve) => {
                chrome.storage.local.set({ [key]: value }, () => {
                    resolve();
                });
            });
        } else {
            // Fallback to localStorage for non-extension environments
            localStorage.setItem(key, JSON.stringify(value));
        }
    }

    /**
     * Get conversation statistics
     */
    getStats() {
        return {
            sessionId: this.sessionId,
            messageCount: this.currentHistory.length,
            hasCodeContext: !!this.codeContext,
            estimatedTokens: this.currentHistory.reduce((sum, msg) =>
                sum + Math.ceil((msg.content || '').length / 4), 0
            ),
            maxTokens: MAX_CONTEXT_TOKENS,
            maxMessages: MAX_HISTORY_LENGTH
        };
    }
}

// Export singleton instance
export const conversationHistory = new ConversationHistoryManager();

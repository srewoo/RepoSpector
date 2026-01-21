/**
 * PR Thread Manager for RepoSpector
 *
 * Manages threaded conversations on PR findings using IndexedDB storage.
 * Supports creating, updating, and retrieving conversation threads for
 * specific findings within a PR review session.
 */

export class PRThreadManager {
    constructor(options = {}) {
        this.dbName = 'RepoSpectorDB';
        this.storeName = 'pr_threads';
        this.version = 2; // Increment version to trigger upgrade
        this.db = null;

        this.options = {
            maxMessagesPerThread: options.maxMessagesPerThread ?? 50,
            maxThreadsPerSession: options.maxThreadsPerSession ?? 100,
            retentionDays: options.retentionDays ?? 30,
            ...options
        };

        // In-memory cache for active threads
        this.threadCache = new Map();
    }

    /**
     * Initialize the database
     */
    async init() {
        if (this.db) return;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = (event) => {
                console.error('PRThreadManager DB error:', event.target.error);
                reject(event.target.error);
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                console.log('📝 PRThreadManager initialized');
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Create pr_threads store if it doesn't exist
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'threadId' });
                    store.createIndex('sessionId', 'sessionId', { unique: false });
                    store.createIndex('prUrl', 'prIdentifier.url', { unique: false });
                    store.createIndex('updatedAt', 'updatedAt', { unique: false });
                    store.createIndex('status', 'status', { unique: false });
                    console.log('📝 Created pr_threads object store');
                }
            };
        });
    }

    /**
     * Create a new thread for a finding
     * @param {Object} params - Thread parameters
     * @returns {Object} Created thread
     */
    async createThread(params) {
        await this.init();

        const {
            sessionId,
            prIdentifier,
            finding,
            initialQuestion = null
        } = params;

        const threadId = this.generateThreadId();
        const now = Date.now();

        const thread = {
            threadId,
            sessionId,
            prIdentifier: {
                url: prIdentifier.url,
                platform: prIdentifier.platform || this.detectPlatform(prIdentifier.url),
                owner: prIdentifier.owner,
                repo: prIdentifier.repo,
                prNumber: prIdentifier.prNumber
            },
            finding: {
                id: finding.id || this.generateFindingId(finding),
                type: finding.type || finding.category,
                severity: finding.severity,
                file: finding.filePath || finding.file,
                lineNumber: finding.line || finding.lineNumber,
                originalText: finding.message,
                codeSnippet: finding.codeSnippet || null,
                ruleId: finding.ruleId || null
            },
            messages: [],
            status: 'active',
            createdAt: now,
            updatedAt: now,
            metadata: {
                tool: finding.tool,
                confidence: finding.confidence,
                isCorroborated: finding.isCorroborated || false
            }
        };

        // Add initial question if provided
        if (initialQuestion) {
            thread.messages.push({
                id: this.generateMessageId(),
                role: 'user',
                content: initialQuestion,
                timestamp: now,
                metadata: { type: 'initial_question' }
            });
        }

        // Store in IndexedDB
        await this.saveThread(thread);

        // Update cache
        this.threadCache.set(threadId, thread);

        console.log(`📝 Created thread ${threadId} for finding in ${finding.filePath}`);

        return thread;
    }

    /**
     * Add a message to an existing thread
     * @param {string} threadId - Thread identifier
     * @param {Object} message - Message to add { role, content, metadata }
     * @returns {Object} Updated thread
     */
    async addMessage(threadId, message) {
        await this.init();

        const thread = await this.getThread(threadId);
        if (!thread) {
            throw new Error(`Thread ${threadId} not found`);
        }

        const now = Date.now();

        const newMessage = {
            id: this.generateMessageId(),
            role: message.role,
            content: message.content,
            timestamp: now,
            metadata: message.metadata || {}
        };

        // Enforce max messages limit
        if (thread.messages.length >= this.options.maxMessagesPerThread) {
            // Remove oldest messages (keep first and last N)
            const keep = Math.floor(this.options.maxMessagesPerThread * 0.8);
            thread.messages = [
                thread.messages[0],
                ...thread.messages.slice(-keep + 1)
            ];
        }

        thread.messages.push(newMessage);
        thread.updatedAt = now;

        // Save and update cache
        await this.saveThread(thread);
        this.threadCache.set(threadId, thread);

        return thread;
    }

    /**
     * Get a thread by ID
     */
    async getThread(threadId) {
        // Check cache first
        if (this.threadCache.has(threadId)) {
            return this.threadCache.get(threadId);
        }

        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(threadId);

            request.onsuccess = () => {
                const thread = request.result;
                if (thread) {
                    this.threadCache.set(threadId, thread);
                }
                resolve(thread || null);
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Get all threads for a session
     */
    async getThreadsBySession(sessionId) {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('sessionId');
            const request = index.getAll(sessionId);

            request.onsuccess = () => {
                const threads = request.result || [];
                // Update cache
                threads.forEach(t => this.threadCache.set(t.threadId, t));
                resolve(threads);
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Get all threads for a PR URL
     */
    async getThreadsByPR(prUrl) {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('prUrl');
            const request = index.getAll(prUrl);

            request.onsuccess = () => {
                resolve(request.result || []);
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Update thread status
     */
    async updateThreadStatus(threadId, status) {
        const thread = await this.getThread(threadId);
        if (!thread) {
            throw new Error(`Thread ${threadId} not found`);
        }

        thread.status = status;
        thread.updatedAt = Date.now();

        await this.saveThread(thread);
        this.threadCache.set(threadId, thread);

        return thread;
    }

    /**
     * Get conversation context for follow-up
     * Returns formatted message history for LLM prompt
     */
    async getConversationContext(threadId, maxMessages = 10) {
        const thread = await this.getThread(threadId);
        if (!thread) return null;

        const recentMessages = thread.messages.slice(-maxMessages);

        return {
            finding: thread.finding,
            messages: recentMessages.map(m => ({
                role: m.role,
                content: m.content,
                timestamp: m.timestamp
            })),
            formattedHistory: this.formatConversationHistory(recentMessages)
        };
    }

    /**
     * Format conversation history for LLM prompt
     */
    formatConversationHistory(messages) {
        if (!messages || messages.length === 0) return '';

        return messages.map(m => {
            const role = m.role === 'user' ? 'User' : 'Assistant';
            return `${role}: ${m.content}`;
        }).join('\n\n');
    }

    /**
     * Save thread to IndexedDB
     */
    async saveThread(thread) {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);

            const request = store.put(thread);

            request.onsuccess = () => resolve();
            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Delete a thread
     */
    async deleteThread(threadId) {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.delete(threadId);

            request.onsuccess = () => {
                this.threadCache.delete(threadId);
                resolve();
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Delete all threads for a session
     */
    async deleteSessionThreads(sessionId) {
        const threads = await this.getThreadsBySession(sessionId);

        for (const thread of threads) {
            await this.deleteThread(thread.threadId);
        }

        return threads.length;
    }

    /**
     * Clean up old threads based on retention policy
     */
    async cleanupOldThreads() {
        await this.init();

        const cutoffTime = Date.now() - (this.options.retentionDays * 24 * 60 * 60 * 1000);

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('updatedAt');

            // Get all threads older than cutoff
            const range = IDBKeyRange.upperBound(cutoffTime);
            const request = index.openCursor(range);

            let deleted = 0;

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    store.delete(cursor.primaryKey);
                    this.threadCache.delete(cursor.value.threadId);
                    deleted++;
                    cursor.continue();
                } else {
                    console.log(`🧹 Cleaned up ${deleted} old threads`);
                    resolve(deleted);
                }
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Get thread statistics
     */
    async getStats() {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);

            const stats = {
                total: 0,
                byStatus: { active: 0, resolved: 0, dismissed: 0 },
                bySeverity: {}
            };

            const request = store.openCursor();

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const thread = cursor.value;
                    stats.total++;
                    stats.byStatus[thread.status] = (stats.byStatus[thread.status] || 0) + 1;

                    if (thread.finding?.severity) {
                        stats.bySeverity[thread.finding.severity] =
                            (stats.bySeverity[thread.finding.severity] || 0) + 1;
                    }

                    cursor.continue();
                } else {
                    resolve(stats);
                }
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Generate unique thread ID
     */
    generateThreadId() {
        return `thread_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Generate unique message ID
     */
    generateMessageId() {
        return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    }

    /**
     * Generate finding ID from finding properties
     */
    generateFindingId(finding) {
        const parts = [
            finding.filePath || finding.file || 'unknown',
            finding.line || finding.lineNumber || 0,
            finding.ruleId || finding.type || 'general'
        ];
        return parts.join(':');
    }

    /**
     * Detect platform from PR URL
     */
    detectPlatform(url) {
        if (!url) return 'unknown';
        if (url.includes('github.com')) return 'github';
        if (url.includes('gitlab.com') || url.includes('gitlab')) return 'gitlab';
        if (url.includes('bitbucket')) return 'bitbucket';
        if (url.includes('azure')) return 'azure';
        return 'unknown';
    }

    /**
     * Export thread data (for backup)
     */
    async exportThreads(sessionId = null) {
        const threads = sessionId
            ? await this.getThreadsBySession(sessionId)
            : await this.getAllThreads();

        return {
            exportedAt: Date.now(),
            count: threads.length,
            threads
        };
    }

    /**
     * Get all threads
     */
    async getAllThreads() {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Clear cache
     */
    clearCache() {
        this.threadCache.clear();
    }
}

export default PRThreadManager;

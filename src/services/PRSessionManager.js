/**
 * PR Session Manager for RepoSpector
 *
 * Manages PR review session lifecycle with 30-day retention.
 * Tracks session state, findings, and associated threads.
 */

export class PRSessionManager {
    constructor(options = {}) {
        this.dbName = 'RepoSpectorDB';
        this.storeName = 'pr_sessions';
        this.version = 2;
        this.db = null;

        this.options = {
            retentionDays: options.retentionDays ?? 30,
            maxSessionsPerRepo: options.maxSessionsPerRepo ?? 50,
            ...options
        };

        // Active session cache
        this.sessionCache = new Map();
    }

    /**
     * Initialize the database
     */
    async init() {
        if (this.db) return;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = (event) => {
                console.error('PRSessionManager DB error:', event.target.error);
                reject(event.target.error);
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                console.log('📋 PRSessionManager initialized');
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'sessionId' });
                    store.createIndex('prUrl', 'prUrl', { unique: false });
                    store.createIndex('repoId', 'repoId', { unique: false });
                    store.createIndex('createdAt', 'createdAt', { unique: false });
                    store.createIndex('updatedAt', 'updatedAt', { unique: false });
                    console.log('📋 Created pr_sessions object store');
                }
            };
        });
    }

    /**
     * Create a new PR review session
     */
    async createSession(params) {
        await this.init();

        const {
            prUrl,
            prData,
            analysisResult = null,
            staticAnalysisResult = null
        } = params;

        const sessionId = this.generateSessionId();
        const now = Date.now();

        const session = {
            sessionId,
            prUrl,
            repoId: this.extractRepoId(prUrl, prData),
            prData: {
                title: prData.title,
                author: prData.author?.login || prData.author,
                state: prData.state,
                branches: prData.branches,
                stats: prData.stats,
                filesCount: prData.files?.length || 0
            },
            analysis: {
                llmAnalysis: analysisResult,
                staticAnalysis: staticAnalysisResult ? {
                    findings: staticAnalysisResult.findings,
                    summary: staticAnalysisResult.summary,
                    riskScore: staticAnalysisResult.riskScore
                } : null,
                analyzedAt: now
            },
            findings: this.extractFindings(analysisResult, staticAnalysisResult),
            threads: [],
            status: 'active',
            createdAt: now,
            updatedAt: now,
            expiresAt: now + (this.options.retentionDays * 24 * 60 * 60 * 1000),
            metadata: {
                platform: this.detectPlatform(prUrl),
                reviewCount: 0
            }
        };

        await this.saveSession(session);
        this.sessionCache.set(sessionId, session);

        console.log(`📋 Created session ${sessionId} for PR: ${prData.title}`);

        return session;
    }

    /**
     * Get session by ID
     */
    async getSession(sessionId) {
        if (this.sessionCache.has(sessionId)) {
            return this.sessionCache.get(sessionId);
        }

        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(sessionId);

            request.onsuccess = () => {
                const session = request.result;
                if (session) {
                    this.sessionCache.set(sessionId, session);
                }
                resolve(session || null);
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Get sessions for a PR URL
     */
    async getSessionsByPR(prUrl) {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('prUrl');
            const request = index.getAll(prUrl);

            request.onsuccess = () => {
                const sessions = (request.result || [])
                    .filter(s => s.expiresAt > Date.now())
                    .sort((a, b) => b.createdAt - a.createdAt);
                resolve(sessions);
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Get most recent session for a PR
     */
    async getLatestSession(prUrl) {
        const sessions = await this.getSessionsByPR(prUrl);
        return sessions[0] || null;
    }

    /**
     * Update session with new analysis
     */
    async updateAnalysis(sessionId, analysisResult, staticAnalysisResult = null) {
        const session = await this.getSession(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId} not found`);
        }

        const now = Date.now();

        session.analysis = {
            llmAnalysis: analysisResult,
            staticAnalysis: staticAnalysisResult ? {
                findings: staticAnalysisResult.findings,
                summary: staticAnalysisResult.summary,
                riskScore: staticAnalysisResult.riskScore
            } : session.analysis.staticAnalysis,
            analyzedAt: now
        };

        session.findings = this.extractFindings(analysisResult, staticAnalysisResult || session.analysis.staticAnalysis);
        session.updatedAt = now;
        session.metadata.reviewCount++;

        await this.saveSession(session);
        this.sessionCache.set(sessionId, session);

        return session;
    }

    /**
     * Add thread reference to session
     */
    async addThread(sessionId, threadId, findingId) {
        const session = await this.getSession(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId} not found`);
        }

        session.threads.push({
            threadId,
            findingId,
            addedAt: Date.now()
        });
        session.updatedAt = Date.now();

        await this.saveSession(session);
        this.sessionCache.set(sessionId, session);

        return session;
    }

    /**
     * Update finding status in session
     */
    async updateFindingStatus(sessionId, findingId, status, resolution = null) {
        const session = await this.getSession(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId} not found`);
        }

        const finding = session.findings.find(f => f.id === findingId);
        if (finding) {
            finding.status = status;
            finding.resolution = resolution;
            finding.resolvedAt = status !== 'active' ? Date.now() : null;
        }

        session.updatedAt = Date.now();

        await this.saveSession(session);
        this.sessionCache.set(sessionId, session);

        return session;
    }

    /**
     * Extract structured findings from analysis results
     */
    extractFindings(llmAnalysis, staticAnalysis) {
        const findings = [];

        // Extract from static analysis
        if (staticAnalysis?.findings) {
            for (const finding of staticAnalysis.findings) {
                findings.push({
                    id: `static_${finding.filePath}:${finding.line}:${finding.ruleId || 'unknown'}`,
                    source: 'static',
                    type: finding.category,
                    severity: finding.severity,
                    message: finding.message,
                    file: finding.filePath,
                    line: finding.line,
                    confidence: finding.confidence,
                    tool: finding.tool,
                    status: 'active',
                    codeSnippet: finding.codeSnippet
                });
            }
        }

        return findings;
    }

    /**
     * Get session summary
     */
    async getSessionSummary(sessionId) {
        const session = await this.getSession(sessionId);
        if (!session) return null;

        const activeFindingsCount = session.findings.filter(f => f.status === 'active').length;
        const resolvedCount = session.findings.filter(f => f.status === 'resolved').length;
        const dismissedCount = session.findings.filter(f => f.status === 'dismissed').length;

        return {
            sessionId,
            prTitle: session.prData.title,
            prUrl: session.prUrl,
            status: session.status,
            findingsTotal: session.findings.length,
            findingsActive: activeFindingsCount,
            findingsResolved: resolvedCount,
            findingsDismissed: dismissedCount,
            threadsCount: session.threads.length,
            riskScore: session.analysis?.staticAnalysis?.riskScore,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            expiresAt: session.expiresAt,
            reviewCount: session.metadata.reviewCount
        };
    }

    /**
     * Save session to IndexedDB
     */
    async saveSession(session) {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.put(session);

            request.onsuccess = () => resolve();
            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Delete session
     */
    async deleteSession(sessionId) {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.delete(sessionId);

            request.onsuccess = () => {
                this.sessionCache.delete(sessionId);
                resolve();
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Cleanup expired sessions
     */
    async cleanupExpiredSessions() {
        await this.init();

        const now = Date.now();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.openCursor();

            let deleted = 0;

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    if (cursor.value.expiresAt < now) {
                        store.delete(cursor.primaryKey);
                        this.sessionCache.delete(cursor.value.sessionId);
                        deleted++;
                    }
                    cursor.continue();
                } else {
                    console.log(`🧹 Cleaned up ${deleted} expired sessions`);
                    resolve(deleted);
                }
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Get all active sessions
     */
    async getActiveSessions(limit = 20) {
        await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('updatedAt');
            const request = index.openCursor(null, 'prev');

            const sessions = [];
            const now = Date.now();

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor && sessions.length < limit) {
                    if (cursor.value.expiresAt > now) {
                        sessions.push(cursor.value);
                    }
                    cursor.continue();
                } else {
                    resolve(sessions);
                }
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    /**
     * Generate session ID
     */
    generateSessionId() {
        return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Extract repo ID from URL and PR data
     */
    extractRepoId(prUrl, prData) {
        if (prData?.branches?.targetRepo) {
            return prData.branches.targetRepo;
        }

        // Try to extract from URL
        const match = prUrl.match(/(?:github|gitlab)\.com\/([^/]+\/[^/]+)/);
        return match ? match[1] : 'unknown';
    }

    /**
     * Detect platform from URL
     */
    detectPlatform(url) {
        if (!url) return 'unknown';
        if (url.includes('github.com')) return 'github';
        if (url.includes('gitlab')) return 'gitlab';
        if (url.includes('bitbucket')) return 'bitbucket';
        return 'unknown';
    }

    /**
     * Clear cache
     */
    clearCache() {
        this.sessionCache.clear();
    }
}

export default PRSessionManager;

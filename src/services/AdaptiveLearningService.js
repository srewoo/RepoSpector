/**
 * Adaptive Learning Service for RepoSpector
 *
 * Tracks user actions on findings (dismiss/resolve) and adjusts
 * confidence scores based on historical patterns. Rules that are
 * repeatedly dismissed in a repo get reduced confidence.
 */

export class AdaptiveLearningService {
    constructor(options = {}) {
        this.dbName = 'repospector_learning';
        this.storeName = 'finding_actions';
        this.dbVersion = 1;
        this.db = null;

        this.dismissalThreshold = options.dismissalThreshold || 3;
        this.confidenceReduction = options.confidenceReduction || 0.2;
        this.maxAge = options.maxAgeDays || 90;
    }

    /**
     * Initialize IndexedDB
     */
    async initialize() {
        if (this.db) return;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, {
                        keyPath: 'id',
                        autoIncrement: true
                    });
                    store.createIndex('ruleId', 'ruleId', { unique: false });
                    store.createIndex('repoId', 'repoId', { unique: false });
                    store.createIndex('ruleRepo', ['ruleId', 'repoId'], { unique: false });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                    store.createIndex('action', 'action', { unique: false });
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve();
            };

            request.onerror = (event) => {
                console.error('AdaptiveLearning DB error:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    /**
     * Record a user action on a finding
     * @param {Object} action - { ruleId, repoId, action, filePath, findingMessage }
     */
    async recordAction(action) {
        await this.initialize();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);

            store.add({
                ruleId: action.ruleId,
                repoId: action.repoId,
                action: action.action, // 'dismissed' | 'resolved'
                filePath: action.filePath || null,
                findingMessage: action.findingMessage || null,
                timestamp: Date.now()
            });

            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Get count of dismissals for a rule in a repo
     */
    async getDismissalCount(ruleId, repoId) {
        await this.initialize();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const index = store.index('ruleRepo');
            const range = IDBKeyRange.only([ruleId, repoId]);

            let count = 0;
            const request = index.openCursor(range);

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    if (cursor.value.action === 'dismissed') {
                        count++;
                    }
                    cursor.continue();
                } else {
                    resolve(count);
                }
            };

            request.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Get confidence adjustment for a rule in a repo
     * @returns {number} Negative adjustment (e.g., -0.2) or 0
     */
    async getConfidenceAdjustment(ruleId, repoId) {
        const dismissals = await this.getDismissalCount(ruleId, repoId);

        if (dismissals >= this.dismissalThreshold) {
            // Progressive reduction: more dismissals = more reduction, capped at -0.5
            const multiplier = Math.min(
                Math.floor(dismissals / this.dismissalThreshold),
                3
            );
            return -(this.confidenceReduction * multiplier);
        }

        return 0;
    }

    /**
     * Apply adaptive scoring to findings based on historical actions
     * @param {Array} findings - Findings array
     * @param {string} repoId - Repository identifier
     * @returns {Array} Findings with adjusted confidence
     */
    async applyAdaptiveScoring(findings, repoId) {
        if (!findings || findings.length === 0 || !repoId) return findings;

        await this.initialize();

        // Collect unique ruleIds
        const ruleIds = [...new Set(findings.map(f => f.ruleId).filter(Boolean))];

        // Get adjustments for all rules in batch
        const adjustments = new Map();
        for (const ruleId of ruleIds) {
            const adj = await this.getConfidenceAdjustment(ruleId, repoId);
            if (adj !== 0) {
                adjustments.set(ruleId, adj);
            }
        }

        if (adjustments.size === 0) return findings;

        // Apply adjustments
        return findings.map(finding => {
            const adj = adjustments.get(finding.ruleId);
            if (adj) {
                const newConfidence = Math.max(0.1, (finding.confidence || 0.5) + adj);
                return {
                    ...finding,
                    confidence: Math.round(newConfidence * 100) / 100,
                    adaptiveAdjustment: adj,
                    originalConfidence: finding.confidence
                };
            }
            return finding;
        });
    }

    /**
     * Get statistics for a repo
     */
    async getStats(repoId) {
        await this.initialize();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const index = store.index('repoId');
            const range = IDBKeyRange.only(repoId);

            const stats = {
                totalActions: 0,
                dismissed: 0,
                resolved: 0,
                topDismissedRules: {}
            };

            const request = index.openCursor(range);

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    stats.totalActions++;
                    if (cursor.value.action === 'dismissed') {
                        stats.dismissed++;
                        const rule = cursor.value.ruleId;
                        stats.topDismissedRules[rule] = (stats.topDismissedRules[rule] || 0) + 1;
                    } else if (cursor.value.action === 'resolved') {
                        stats.resolved++;
                    }
                    cursor.continue();
                } else {
                    resolve(stats);
                }
            };

            request.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Clean up old records
     */
    async cleanup(olderThanDays) {
        const maxAge = (olderThanDays || this.maxAge) * 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - maxAge;

        await this.initialize();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const index = store.index('timestamp');
            const range = IDBKeyRange.upperBound(cutoff);

            let deleted = 0;
            const request = index.openCursor(range);

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    deleted++;
                    cursor.continue();
                } else {
                    console.log(`AdaptiveLearning: cleaned up ${deleted} old records`);
                    resolve(deleted);
                }
            };

            request.onerror = (e) => reject(e.target.error);
        });
    }
}

export default AdaptiveLearningService;

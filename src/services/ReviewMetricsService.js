/**
 * Review Metrics Service for RepoSpector
 *
 * Tracks PR review metrics over time:
 * - Findings count by severity and category
 * - Review frequency and trends
 * - Common issue patterns
 */
import { getDatabase } from './Database.js';

export class ReviewMetricsService {
    constructor() {
        this.dbName = 'RepoSpectorDB';
        this.storeName = 'review_metrics';
        this.version = 3;
        this.db = null;
    }

    async init() {
        if (this.db) return;
        this.db = await getDatabase();
    }

    /**
     * Record a review event
     * @param {Object} data - { repoId, prUrl, findings, staticFindings, reviewType }
     */
    async recordReview(data) {
        await this.init();

        const { repoId, prUrl, findings = [], staticFindings = [], reviewType = 'full' } = data;

        // Categorize findings
        const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
        const byCategory = {};

        for (const f of [...findings, ...staticFindings]) {
            const severity = (f.severity || 'info').toLowerCase();
            bySeverity[severity] = (bySeverity[severity] || 0) + 1;

            const category = f.category || f.ruleId || 'general';
            byCategory[category] = (byCategory[category] || 0) + 1;
        }

        const record = {
            repoId,
            prUrl,
            timestamp: Date.now(),
            reviewType,
            totalFindings: findings.length + staticFindings.length,
            bySeverity,
            byCategory,
            filesReviewed: data.filesReviewed || 0
        };

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            store.add(record);
            tx.oncomplete = () => resolve(record);
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Get metrics summary for a repo
     * @param {string} repoId
     * @param {number} days - Number of days to look back (default 30)
     * @returns {Promise<Object>} Metrics summary
     */
    async getMetrics(repoId, days = 30) {
        await this.init();

        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const index = store.index('repoId');
            const request = index.getAll(repoId);

            request.onsuccess = () => {
                const allRecords = request.result.filter(r => r.timestamp >= cutoff);

                if (allRecords.length === 0) {
                    resolve({
                        totalReviews: 0,
                        totalFindings: 0,
                        bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                        byCategory: {},
                        trend: [],
                        avgFindingsPerReview: 0,
                        topIssues: []
                    });
                    return;
                }

                // Aggregate
                const totalFindings = allRecords.reduce((sum, r) => sum + r.totalFindings, 0);
                const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
                const byCategory = {};

                for (const r of allRecords) {
                    for (const [sev, count] of Object.entries(r.bySeverity || {})) {
                        bySeverity[sev] = (bySeverity[sev] || 0) + count;
                    }
                    for (const [cat, count] of Object.entries(r.byCategory || {})) {
                        byCategory[cat] = (byCategory[cat] || 0) + count;
                    }
                }

                // Trend data (group by week)
                const weeklyBuckets = {};
                for (const r of allRecords) {
                    const weekStart = new Date(r.timestamp);
                    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
                    const key = weekStart.toISOString().split('T')[0];
                    if (!weeklyBuckets[key]) {
                        weeklyBuckets[key] = { reviews: 0, findings: 0, date: key };
                    }
                    weeklyBuckets[key].reviews += 1;
                    weeklyBuckets[key].findings += r.totalFindings;
                }

                const trend = Object.values(weeklyBuckets).sort((a, b) => a.date.localeCompare(b.date));

                // Top issues
                const topIssues = Object.entries(byCategory)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 10)
                    .map(([category, count]) => ({ category, count }));

                resolve({
                    totalReviews: allRecords.length,
                    totalFindings,
                    bySeverity,
                    byCategory,
                    trend,
                    avgFindingsPerReview: Math.round(totalFindings / allRecords.length * 10) / 10,
                    topIssues
                });
            };

            request.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Format metrics for display in chat
     * @param {Object} metrics
     * @param {string} repoId
     * @returns {string} Formatted markdown
     */
    static formatMetrics(metrics, repoId) {
        if (metrics.totalReviews === 0) {
            return `No review metrics found for **${repoId}**. Run a PR review to start tracking.`;
        }

        let md = `## Review Metrics for ${repoId}\n\n`;
        md += `### Overview (Last 30 days)\n`;
        md += `- **Total Reviews**: ${metrics.totalReviews}\n`;
        md += `- **Total Findings**: ${metrics.totalFindings}\n`;
        md += `- **Avg Findings/Review**: ${metrics.avgFindingsPerReview}\n\n`;

        md += `### Findings by Severity\n`;
        md += `| Severity | Count |\n|----------|-------|\n`;
        for (const [sev, count] of Object.entries(metrics.bySeverity)) {
            if (count > 0) {
                const emoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪' }[sev] || '';
                md += `| ${emoji} ${sev} | ${count} |\n`;
            }
        }

        if (metrics.topIssues.length > 0) {
            md += `\n### Top Issues\n`;
            for (const issue of metrics.topIssues.slice(0, 5)) {
                md += `- **${issue.category}**: ${issue.count} occurrences\n`;
            }
        }

        if (metrics.trend.length > 1) {
            md += `\n### Trend\n`;
            for (const week of metrics.trend.slice(-4)) {
                md += `- Week of ${week.date}: ${week.reviews} reviews, ${week.findings} findings\n`;
            }
        }

        return md;
    }
}

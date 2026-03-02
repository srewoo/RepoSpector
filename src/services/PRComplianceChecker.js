/**
 * PR Compliance Checker for RepoSpector
 *
 * Validates PR descriptions against configurable rules:
 * - Required sections (Summary, Testing, etc.)
 * - Minimum description length
 * - Linked issue requirement
 * - Checklist completion
 * - Custom rules from .repospector.yaml
 */

export class PRComplianceChecker {
    constructor(options = {}) {
        this.defaultRules = {
            minDescriptionLength: 50,
            requiredSections: ['Summary', 'Changes', 'Testing'],
            requireLinkedIssue: false,
            requireChecklist: false,
            maxTitleLength: 72,
            titlePrefixPattern: null, // e.g. /^(feat|fix|docs|chore|refactor|test|ci)/
            ...options
        };
    }

    /**
     * Check PR description compliance
     * @param {Object} prData - PR data from PullRequestService
     * @param {Object} customRules - Optional custom rules from .repospector.yaml
     * @returns {Object} Compliance report
     */
    check(prData, customRules = null) {
        const rules = { ...this.defaultRules, ...(customRules?.compliance || {}) };
        const results = [];
        let score = 100;

        // Title checks
        const title = prData.title || '';
        if (title.length > rules.maxTitleLength) {
            results.push({
                rule: 'title-length',
                severity: 'warning',
                message: `Title exceeds ${rules.maxTitleLength} characters (${title.length})`,
                passed: false
            });
            score -= 5;
        } else {
            results.push({ rule: 'title-length', severity: 'info', message: 'Title length OK', passed: true });
        }

        if (rules.titlePrefixPattern) {
            const pattern = new RegExp(rules.titlePrefixPattern);
            if (!pattern.test(title)) {
                results.push({
                    rule: 'title-prefix',
                    severity: 'warning',
                    message: `Title should match pattern: ${rules.titlePrefixPattern}`,
                    passed: false
                });
                score -= 10;
            }
        }

        // Description checks
        const description = prData.description || '';
        if (description.length < rules.minDescriptionLength) {
            results.push({
                rule: 'description-length',
                severity: 'error',
                message: `Description too short (${description.length}/${rules.minDescriptionLength} chars)`,
                passed: false
            });
            score -= 20;
        } else {
            results.push({ rule: 'description-length', severity: 'info', message: 'Description length OK', passed: true });
        }

        // Required sections
        for (const section of rules.requiredSections) {
            const sectionRegex = new RegExp(`##?\\s*${section}`, 'i');
            if (sectionRegex.test(description)) {
                results.push({
                    rule: `section-${section.toLowerCase()}`,
                    severity: 'info',
                    message: `Section "${section}" found`,
                    passed: true
                });
            } else {
                results.push({
                    rule: `section-${section.toLowerCase()}`,
                    severity: 'warning',
                    message: `Missing required section: "${section}"`,
                    passed: false
                });
                score -= 15;
            }
        }

        // Linked issue check
        if (rules.requireLinkedIssue) {
            const hasIssueRef = /#\d+/.test(description) ||
                /closes?\s+#\d+/i.test(description) ||
                /fixes?\s+#\d+/i.test(description) ||
                /resolves?\s+#\d+/i.test(description) ||
                /JIRA-\d+/i.test(description);

            if (!hasIssueRef) {
                results.push({
                    rule: 'linked-issue',
                    severity: 'warning',
                    message: 'No linked issue found (expected #number or JIRA-number reference)',
                    passed: false
                });
                score -= 10;
            } else {
                results.push({ rule: 'linked-issue', severity: 'info', message: 'Linked issue found', passed: true });
            }
        }

        // Checklist check
        if (rules.requireChecklist) {
            const hasChecklist = /- \[[ x]\]/i.test(description);
            if (!hasChecklist) {
                results.push({
                    rule: 'checklist',
                    severity: 'warning',
                    message: 'No checklist found in description',
                    passed: false
                });
                score -= 10;
            } else {
                // Check if all items are checked
                const unchecked = (description.match(/- \[ \]/g) || []).length;
                const checked = (description.match(/- \[x\]/gi) || []).length;
                if (unchecked > 0) {
                    results.push({
                        rule: 'checklist',
                        severity: 'info',
                        message: `Checklist: ${checked} checked, ${unchecked} unchecked`,
                        passed: true
                    });
                } else {
                    results.push({
                        rule: 'checklist',
                        severity: 'info',
                        message: `Checklist complete (${checked} items)`,
                        passed: true
                    });
                }
            }
        }

        // Change size warning
        const totalChanges = (prData.stats?.additions || 0) + (prData.stats?.deletions || 0);
        if (totalChanges > 1000) {
            results.push({
                rule: 'change-size',
                severity: 'warning',
                message: `Large PR: ${totalChanges} lines changed. Consider splitting into smaller PRs.`,
                passed: false
            });
            score -= 5;
        }

        // Files count warning
        const filesCount = prData.files?.length || prData.stats?.changedFiles || 0;
        if (filesCount > 20) {
            results.push({
                rule: 'files-count',
                severity: 'warning',
                message: `${filesCount} files changed. Large PRs are harder to review.`,
                passed: false
            });
            score -= 5;
        }

        return {
            score: Math.max(0, score),
            grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F',
            results,
            passed: results.filter(r => r.passed).length,
            failed: results.filter(r => !r.passed).length,
            total: results.length
        };
    }

    /**
     * Format compliance report for chat display
     * @param {Object} report
     * @returns {string} Markdown formatted report
     */
    static formatReport(report) {
        const gradeEmojis = { A: '🟢', B: '🔵', C: '🟡', D: '🟠', F: '🔴' };
        const emoji = gradeEmojis[report.grade] || '⚪';

        let md = `## PR Compliance Check ${emoji}\n\n`;
        md += `**Score**: ${report.score}/100 (Grade: ${report.grade})\n`;
        md += `**Checks**: ${report.passed} passed, ${report.failed} failed\n\n`;

        const failed = report.results.filter(r => !r.passed);
        if (failed.length > 0) {
            md += `### Issues Found\n`;
            for (const r of failed) {
                const icon = r.severity === 'error' ? '❌' : '⚠️';
                md += `- ${icon} ${r.message}\n`;
            }
            md += '\n';
        }

        const passed = report.results.filter(r => r.passed);
        if (passed.length > 0) {
            md += `### Passed\n`;
            for (const r of passed) {
                md += `- ✅ ${r.message}\n`;
            }
        }

        return md;
    }
}

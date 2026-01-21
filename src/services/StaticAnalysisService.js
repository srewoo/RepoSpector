/**
 * Static Analysis Service for RepoSpector
 *
 * Main orchestrator coordinating ESLint, Semgrep, and Dependency analyzers
 * with confidence scoring and result aggregation.
 */

import { ESLintAnalyzer } from './ESLintAnalyzer.js';
import { SemgrepAnalyzer } from './SemgrepAnalyzer.js';
import { DependencyAnalyzer } from './DependencyAnalyzer.js';
import { ConfidenceScorer } from './ConfidenceScorer.js';

export class StaticAnalysisService {
    constructor(options = {}) {
        // Initialize analyzers
        this.eslintAnalyzer = new ESLintAnalyzer(options.eslint || {});
        this.semgrepAnalyzer = new SemgrepAnalyzer(options.semgrep || {});
        this.dependencyAnalyzer = new DependencyAnalyzer(options.dependency || {});
        this.confidenceScorer = new ConfidenceScorer(options.confidence || {});

        this.options = {
            enableESLint: options.enableESLint ?? true,
            enableSemgrep: options.enableSemgrep ?? true,
            enableDependency: options.enableDependency ?? true,
            enableConfidenceAggregation: options.enableConfidenceAggregation ?? true,
            parallelAnalysis: options.parallelAnalysis ?? true,
            minConfidenceThreshold: options.minConfidenceThreshold ?? 0.4,
            maxFindingsPerFile: options.maxFindingsPerFile ?? 50,
            ...options
        };

        // Statistics tracking
        this.stats = {
            totalAnalyses: 0,
            totalFindings: 0,
            totalFilesAnalyzed: 0,
            avgAnalysisTime: 0
        };
    }

    /**
     * Analyze a single file
     * @param {string} code - Source code content
     * @param {Object} context - Analysis context { filePath, language }
     * @returns {Object} Combined analysis results
     */
    async analyzeFile(code, context = {}) {
        const startTime = performance.now();
        const { filePath = 'unknown' } = context;

        console.log(`🔍 StaticAnalysis: Analyzing ${filePath}`);

        const results = {
            eslint: null,
            semgrep: null,
            dependency: null
        };

        try {
            if (this.options.parallelAnalysis) {
                // Run analyzers in parallel
                const [eslintResult, semgrepResult, depResult] = await Promise.all([
                    this.options.enableESLint ?
                        Promise.resolve(this.eslintAnalyzer.analyze(code, context)) :
                        Promise.resolve(null),
                    this.options.enableSemgrep ?
                        Promise.resolve(this.semgrepAnalyzer.analyze(code, context)) :
                        Promise.resolve(null),
                    this.options.enableDependency && this.isDependencyFile(filePath) ?
                        Promise.resolve(this.dependencyAnalyzer.analyze(code, context)) :
                        Promise.resolve(null)
                ]);

                results.eslint = eslintResult;
                results.semgrep = semgrepResult;
                results.dependency = depResult;
            } else {
                // Run sequentially
                if (this.options.enableESLint) {
                    results.eslint = this.eslintAnalyzer.analyze(code, context);
                }
                if (this.options.enableSemgrep) {
                    results.semgrep = this.semgrepAnalyzer.analyze(code, context);
                }
                if (this.options.enableDependency && this.isDependencyFile(filePath)) {
                    results.dependency = this.dependencyAnalyzer.analyze(code, context);
                }
            }

            // Aggregate and score findings
            let aggregatedResult;
            if (this.options.enableConfidenceAggregation) {
                aggregatedResult = this.confidenceScorer.aggregateFindings(results);
            } else {
                aggregatedResult = this.combineResultsSimple(results);
            }

            // Apply max findings limit
            if (aggregatedResult.findings.length > this.options.maxFindingsPerFile) {
                aggregatedResult.findings = aggregatedResult.findings.slice(0, this.options.maxFindingsPerFile);
                aggregatedResult.truncated = true;
                aggregatedResult.originalCount = aggregatedResult.summary.total;
            }

            const elapsed = performance.now() - startTime;

            // Update stats
            this.stats.totalAnalyses++;
            this.stats.totalFindings += aggregatedResult.findings.length;
            this.stats.totalFilesAnalyzed++;
            this.stats.avgAnalysisTime =
                (this.stats.avgAnalysisTime * (this.stats.totalAnalyses - 1) + elapsed) /
                this.stats.totalAnalyses;

            console.log(`✅ StaticAnalysis: Found ${aggregatedResult.findings.length} issues in ${elapsed.toFixed(1)}ms`);

            return {
                success: true,
                filePath,
                ...aggregatedResult,
                individualResults: results,
                analysisTime: elapsed,
                riskScore: this.confidenceScorer.calculateRiskScore(aggregatedResult.findings)
            };
        } catch (error) {
            console.error('❌ StaticAnalysis error:', error);
            return {
                success: false,
                filePath,
                error: error.message,
                findings: [],
                summary: { total: 0, bySeverity: {}, byCategory: {} }
            };
        }
    }

    /**
     * Analyze multiple files (e.g., PR diff files)
     * @param {Array<{path: string, content: string}>} files
     * @param {Object} options - Analysis options
     * @returns {Object} Combined results for all files
     */
    async analyzeFiles(files, options = {}) {
        const startTime = performance.now();

        console.log(`🔍 StaticAnalysis: Analyzing ${files.length} files`);

        const fileResults = [];
        const allFindings = [];

        // Process files (in parallel if enabled)
        if (this.options.parallelAnalysis && files.length > 1) {
            const promises = files.map(file =>
                this.analyzeFile(file.content, { filePath: file.path, ...options })
            );
            const results = await Promise.all(promises);
            fileResults.push(...results);
        } else {
            for (const file of files) {
                const result = await this.analyzeFile(file.content, { filePath: file.path, ...options });
                fileResults.push(result);
            }
        }

        // Collect all findings
        for (const result of fileResults) {
            if (result.success && result.findings) {
                allFindings.push(...result.findings);
            }
        }

        // Generate combined summary
        const summary = this.generateCombinedSummary(fileResults);
        const riskScore = this.confidenceScorer.calculateRiskScore(allFindings);

        const elapsed = performance.now() - startTime;

        console.log(`✅ StaticAnalysis: Completed analysis of ${files.length} files in ${elapsed.toFixed(1)}ms`);

        return {
            success: true,
            files: fileResults,
            totalFindings: allFindings.length,
            findings: allFindings.sort((a, b) => {
                // Sort by confidence then severity
                const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
                if (b.confidence !== a.confidence) {
                    return b.confidence - a.confidence;
                }
                return severityOrder[a.severity] - severityOrder[b.severity];
            }),
            summary,
            riskScore,
            analysisTime: elapsed
        };
    }

    /**
     * Analyze a PR (pull request) for issues
     * @param {Object} prData - PR data with files array
     * @param {Object} options - Analysis options
     * @returns {Object} PR analysis results
     */
    async analyzePullRequest(prData, options = {}) {
        console.log(`📋 StaticAnalysis: Analyzing PR with ${prData.files?.length || 0} files`);

        // Prepare files for analysis
        const filesToAnalyze = [];

        for (const file of (prData.files || [])) {
            // Skip deleted files
            if (file.status === 'removed') continue;

            // Only analyze files with patches (changed content)
            if (file.patch) {
                // Extract added/modified code from patch
                const addedCode = this.extractAddedCode(file.patch);

                if (addedCode.trim()) {
                    filesToAnalyze.push({
                        path: file.filename,
                        content: addedCode,
                        fullPatch: file.patch,
                        additions: file.additions,
                        deletions: file.deletions,
                        status: file.status
                    });
                }
            }
        }

        // Check for dependency files
        const depFiles = (prData.files || []).filter(f =>
            this.isDependencyFile(f.filename)
        );

        // Add dependency files if we have their full content
        for (const depFile of depFiles) {
            if (depFile.content) {
                filesToAnalyze.push({
                    path: depFile.filename,
                    content: depFile.content
                });
            }
        }

        // Run analysis
        const analysisResult = await this.analyzeFiles(filesToAnalyze, options);

        // Enhance with PR-specific context
        return {
            ...analysisResult,
            prContext: {
                title: prData.title,
                author: prData.author?.login,
                filesChanged: prData.files?.length || 0,
                additions: prData.stats?.additions || 0,
                deletions: prData.stats?.deletions || 0
            },
            // Group findings by file for easier review
            findingsByFile: this.groupFindingsByFile(analysisResult.findings),
            // High-level recommendation
            recommendation: this.generatePRRecommendation(analysisResult)
        };
    }

    /**
     * Extract only added/modified code from a diff patch
     */
    extractAddedCode(patch) {
        if (!patch) return '';

        const lines = patch.split('\n');
        const addedLines = [];

        for (const line of lines) {
            // Lines starting with + (but not ++ for header)
            if (line.startsWith('+') && !line.startsWith('++')) {
                addedLines.push(line.substring(1));
            }
        }

        return addedLines.join('\n');
    }

    /**
     * Check if file is a dependency manifest
     */
    isDependencyFile(filePath) {
        if (!filePath) return false;
        return /(?:package\.json|requirements\.txt|Pipfile|pyproject\.toml|Gemfile|composer\.json|Cargo\.toml|go\.mod)$/i.test(filePath);
    }

    /**
     * Simple combination of results (without confidence aggregation)
     */
    combineResultsSimple(results) {
        const findings = [];

        for (const [tool, result] of Object.entries(results)) {
            if (result?.findings) {
                for (const finding of result.findings) {
                    findings.push({ ...finding, tool });
                }
            }
        }

        // Sort by severity
        const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
        findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

        return {
            findings,
            summary: this.generateSimpleSummary(findings)
        };
    }

    /**
     * Generate simple summary
     */
    generateSimpleSummary(findings) {
        const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
        const byCategory = {};
        const byTool = {};

        for (const finding of findings) {
            bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
            byCategory[finding.category] = (byCategory[finding.category] || 0) + 1;
            byTool[finding.tool] = (byTool[finding.tool] || 0) + 1;
        }

        return { total: findings.length, bySeverity, byCategory, byTool };
    }

    /**
     * Generate combined summary for multiple files
     */
    generateCombinedSummary(fileResults) {
        const summary = {
            filesAnalyzed: fileResults.length,
            filesWithIssues: 0,
            totalFindings: 0,
            bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
            byCategory: {},
            byTool: {},
            byFile: {}
        };

        for (const result of fileResults) {
            if (!result.success) continue;

            const findingsCount = result.findings?.length || 0;
            summary.totalFindings += findingsCount;

            if (findingsCount > 0) {
                summary.filesWithIssues++;
            }

            summary.byFile[result.filePath] = findingsCount;

            // Aggregate from individual summaries
            if (result.summary) {
                for (const [severity, count] of Object.entries(result.summary.bySeverity || {})) {
                    summary.bySeverity[severity] = (summary.bySeverity[severity] || 0) + count;
                }
                for (const [category, count] of Object.entries(result.summary.byCategory || {})) {
                    summary.byCategory[category] = (summary.byCategory[category] || 0) + count;
                }
                for (const [tool, count] of Object.entries(result.summary.byTool || {})) {
                    summary.byTool[tool] = (summary.byTool[tool] || 0) + count;
                }
            }
        }

        return summary;
    }

    /**
     * Group findings by file for easier review
     */
    groupFindingsByFile(findings) {
        const grouped = {};

        for (const finding of findings) {
            const file = finding.filePath || 'unknown';
            if (!grouped[file]) {
                grouped[file] = [];
            }
            grouped[file].push(finding);
        }

        // Sort findings within each file by line number
        for (const file of Object.keys(grouped)) {
            grouped[file].sort((a, b) => (a.line || 0) - (b.line || 0));
        }

        return grouped;
    }

    /**
     * Generate PR recommendation based on analysis
     */
    generatePRRecommendation(analysisResult) {
        const { summary, riskScore } = analysisResult;

        if (!summary) {
            return {
                action: 'review',
                verdict: 'Unable to analyze',
                reason: 'Analysis did not complete successfully'
            };
        }

        const criticalCount = summary.bySeverity?.critical || 0;
        const highCount = summary.bySeverity?.high || 0;
        const mediumCount = summary.bySeverity?.medium || 0;

        if (criticalCount > 0) {
            return {
                action: 'block',
                verdict: '🔴 Changes Requested',
                reason: `${criticalCount} critical issue(s) must be addressed before merging`,
                priority: ['Fix critical security vulnerabilities', 'Review all flagged code paths']
            };
        }

        if (highCount > 3) {
            return {
                action: 'review',
                verdict: '🟠 Needs Review',
                reason: `${highCount} high-severity issues detected`,
                priority: ['Review high-severity findings', 'Consider security implications']
            };
        }

        if (highCount > 0 || mediumCount > 5) {
            return {
                action: 'caution',
                verdict: '🟡 Approve with Caution',
                reason: `${highCount} high and ${mediumCount} medium issues found`,
                priority: ['Address high-severity issues', 'Consider medium issues for future']
            };
        }

        if (riskScore?.level === 'low') {
            return {
                action: 'approve',
                verdict: '🟢 Safe to Merge',
                reason: 'No significant issues detected',
                priority: []
            };
        }

        return {
            action: 'review',
            verdict: '🟡 Review Recommended',
            reason: `${summary.totalFindings} issue(s) found - review recommended`,
            priority: ['Review all findings before merging']
        };
    }

    /**
     * Get analysis statistics
     */
    getStats() {
        return { ...this.stats };
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.stats = {
            totalAnalyses: 0,
            totalFindings: 0,
            totalFilesAnalyzed: 0,
            avgAnalysisTime: 0
        };
    }

    /**
     * Configure analyzers
     */
    configure(options = {}) {
        if (options.eslint) {
            this.eslintAnalyzer = new ESLintAnalyzer(options.eslint);
        }
        if (options.semgrep) {
            this.semgrepAnalyzer = new SemgrepAnalyzer(options.semgrep);
        }
        if (options.dependency) {
            this.dependencyAnalyzer = new DependencyAnalyzer(options.dependency);
        }
        if (options.confidence) {
            this.confidenceScorer = new ConfidenceScorer(options.confidence);
        }

        // Update options
        this.options = { ...this.options, ...options };
    }

    /**
     * Format findings for LLM prompt injection
     * Returns a structured string that can be added to PR analysis prompts
     */
    formatFindingsForPrompt(findings, maxFindings = 15) {
        if (!findings || findings.length === 0) {
            return null;
        }

        const topFindings = findings.slice(0, maxFindings);

        let formatted = `## Static Analysis Results

The following issues were detected by automated static analysis tools:

`;

        for (const finding of topFindings) {
            const confidence = Math.round((finding.confidence || 0.5) * 100);
            const tools = finding.toolsDetected?.join(', ') || finding.tool || 'unknown';

            formatted += `### ${finding.severity.toUpperCase()}: ${finding.ruleId || finding.category}
- **File**: ${finding.filePath}:${finding.line || '?'}
- **Message**: ${finding.message}
- **Confidence**: ${confidence}% (detected by: ${tools})
${finding.cwe ? `- **CWE**: ${finding.cwe}` : ''}
${finding.owasp || finding.owaspCategory ? `- **OWASP**: ${finding.owasp || finding.owaspCategory}` : ''}

`;
        }

        if (findings.length > maxFindings) {
            formatted += `\n*...and ${findings.length - maxFindings} more findings*\n`;
        }

        formatted += `
Please incorporate these findings into your review. For each finding:
1. Verify if it's a true positive or false positive
2. Explain the security/quality implications
3. Suggest specific fixes if appropriate
`;

        return formatted;
    }
}

export default StaticAnalysisService;

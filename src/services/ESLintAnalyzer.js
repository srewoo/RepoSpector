/**
 * ESLint-style Analyzer for RepoSpector
 *
 * Performs rule-based JS/TS pattern matching for security, bugs, performance,
 * and code quality issues without requiring the full ESLint toolchain.
 */

import { ESLINT_RULES, SEVERITY_WEIGHTS } from '../utils/staticAnalysisPatterns.js';

export class ESLintAnalyzer {
    constructor(options = {}) {
        this.rules = { ...ESLINT_RULES };
        this.enabledRules = new Set(Object.keys(this.rules));

        // Configuration
        this.options = {
            includeInfo: options.includeInfo ?? false,  // Include info-level findings
            maxFindingsPerRule: options.maxFindingsPerRule ?? 10,
            ignorePatterns: options.ignorePatterns ?? [],
            ...options
        };

        // Language detection patterns
        this.languagePatterns = {
            javascript: /\.(js|jsx|mjs|cjs)$/,
            typescript: /\.(ts|tsx)$/
        };
    }

    /**
     * Enable or disable specific rules
     * @param {string[]} rules - Rule IDs to enable
     * @param {boolean} enable - Whether to enable or disable
     */
    configureRules(rules, enable = true) {
        for (const ruleId of rules) {
            if (enable) {
                this.enabledRules.add(ruleId);
            } else {
                this.enabledRules.delete(ruleId);
            }
        }
    }

    /**
     * Analyze code for ESLint-style rule violations
     * @param {string} code - Source code to analyze
     * @param {Object} context - Analysis context { filePath, language }
     * @returns {Object} Analysis results
     */
    analyze(code, context = {}) {
        const { filePath = 'unknown', language = this.detectLanguage(context.filePath) } = context;

        // Skip non-JS/TS files
        if (!['javascript', 'typescript'].includes(language)) {
            return this.createEmptyResult(filePath);
        }

        const findings = [];
        const lines = code.split('\n');

        for (const ruleId of this.enabledRules) {
            const rule = this.rules[ruleId];
            if (!rule) continue;

            // Skip info-level rules if not enabled
            if (rule.severity === 'info' && !this.options.includeInfo) continue;

            // Check if rule should be ignored for this file
            if (this.shouldIgnoreRule(ruleId, filePath)) continue;

            // Run the rule pattern against the code
            const ruleFindings = this.runRule(rule, code, lines, filePath);
            findings.push(...ruleFindings.slice(0, this.options.maxFindingsPerRule));
        }

        // Sort by severity (critical first) then by line number
        findings.sort((a, b) => {
            const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
            const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
            return severityDiff !== 0 ? severityDiff : a.line - b.line;
        });

        return {
            tool: 'eslint',
            filePath,
            language,
            findings,
            summary: this.generateSummary(findings),
            confidence: this.calculateOverallConfidence(findings)
        };
    }

    /**
     * Run a single rule against the code
     */
    runRule(rule, code, lines, filePath) {
        const findings = [];
        const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);

        let match;
        while ((match = pattern.exec(code)) !== null) {
            // Find line number and column
            const position = this.getPosition(code, match.index);

            // Get code snippet context
            const lineContent = lines[position.line - 1] || '';
            const codeSnippet = this.getCodeSnippet(lines, position.line, 2);

            // Calculate confidence based on context
            const confidence = this.calculateRuleConfidence(rule, match, lineContent, code);

            findings.push({
                ruleId: rule.id,
                severity: rule.severity,
                category: rule.category,
                message: rule.message,
                line: position.line,
                column: position.column,
                endLine: position.line,
                endColumn: position.column + match[0].length,
                codeSnippet,
                matchedText: match[0],
                confidence,
                cwe: rule.cwe || null,
                owasp: rule.owasp || null,
                filePath,
                tool: 'eslint'
            });
        }

        return findings;
    }

    /**
     * Calculate confidence score for a specific finding
     */
    calculateRuleConfidence(rule, match, lineContent, fullCode) {
        let confidence = SEVERITY_WEIGHTS[rule.severity] || 0.5;

        // Reduce confidence if in a comment
        if (this.isInComment(lineContent, match[0])) {
            confidence *= 0.1;
        }

        // Reduce confidence if in a string (for some rules)
        if (this.isInString(lineContent, match.index)) {
            if (!['no-hardcoded-credentials'].includes(rule.id)) {
                confidence *= 0.3;
            }
        }

        // Increase confidence for certain patterns
        if (rule.category === 'security') {
            // Check if the match involves user input
            if (/(?:req\.|request\.|params\.|query\.|body\.)/i.test(lineContent)) {
                confidence = Math.min(1.0, confidence + 0.2);
            }
        }

        // Context-specific adjustments
        if (rule.id === 'no-eval') {
            // eval() in test files is less concerning
            if (/(?:test|spec|__tests__)/i.test(lineContent)) {
                confidence *= 0.5;
            }
        }

        return Math.max(0, Math.min(1, confidence));
    }

    /**
     * Check if match is inside a comment
     */
    isInComment(lineContent, matchedText) {
        const matchIndex = lineContent.indexOf(matchedText);
        const singleLineComment = lineContent.indexOf('//');
        const blockCommentStart = lineContent.indexOf('/*');

        if (singleLineComment >= 0 && singleLineComment < matchIndex) {
            return true;
        }

        if (blockCommentStart >= 0 && blockCommentStart < matchIndex) {
            const blockCommentEnd = lineContent.indexOf('*/');
            if (blockCommentEnd < 0 || blockCommentEnd > matchIndex) {
                return true;
            }
        }

        return false;
    }

    /**
     * Check if match might be inside a string
     */
    isInString(lineContent, position) {
        let inString = false;
        let stringChar = '';

        for (let i = 0; i < Math.min(position, lineContent.length); i++) {
            const char = lineContent[i];
            if ((char === '"' || char === "'" || char === '`') && lineContent[i - 1] !== '\\') {
                if (!inString) {
                    inString = true;
                    stringChar = char;
                } else if (char === stringChar) {
                    inString = false;
                }
            }
        }

        return inString;
    }

    /**
     * Get position (line, column) from character index
     */
    getPosition(code, index) {
        const lines = code.substring(0, index).split('\n');
        return {
            line: lines.length,
            column: lines[lines.length - 1].length + 1
        };
    }

    /**
     * Get code snippet around a line
     */
    getCodeSnippet(lines, lineNum, context = 2) {
        const startLine = Math.max(0, lineNum - context - 1);
        const endLine = Math.min(lines.length, lineNum + context);

        return lines
            .slice(startLine, endLine)
            .map((line, i) => {
                const num = startLine + i + 1;
                const marker = num === lineNum ? '>' : ' ';
                return `${marker} ${num.toString().padStart(4)} | ${line}`;
            })
            .join('\n');
    }

    /**
     * Check if a rule should be ignored for a file
     */
    shouldIgnoreRule(ruleId, filePath) {
        // Check ignore patterns
        for (const pattern of this.options.ignorePatterns) {
            if (typeof pattern === 'string') {
                if (filePath.includes(pattern)) return true;
            } else if (pattern instanceof RegExp) {
                if (pattern.test(filePath)) return true;
            }
        }

        // Rule-specific ignores
        if (ruleId === 'no-console' && /(?:test|spec|__tests__|\.test\.|\.spec\.)/i.test(filePath)) {
            return true; // Allow console in test files
        }

        return false;
    }

    /**
     * Detect language from file path
     */
    detectLanguage(filePath) {
        if (!filePath) return 'javascript';

        if (this.languagePatterns.typescript.test(filePath)) {
            return 'typescript';
        }
        if (this.languagePatterns.javascript.test(filePath)) {
            return 'javascript';
        }

        return 'unknown';
    }

    /**
     * Generate summary of findings
     */
    generateSummary(findings) {
        const bySeverity = {
            critical: 0,
            high: 0,
            medium: 0,
            low: 0,
            info: 0
        };

        const byCategory = {};

        for (const finding of findings) {
            bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
            byCategory[finding.category] = (byCategory[finding.category] || 0) + 1;
        }

        return {
            total: findings.length,
            bySeverity,
            byCategory,
            hasSecurityIssues: bySeverity.critical > 0 || bySeverity.high > 0,
            hasBugs: byCategory.bug > 0,
            highestSeverity: this.getHighestSeverity(bySeverity)
        };
    }

    /**
     * Get highest severity present
     */
    getHighestSeverity(bySeverity) {
        if (bySeverity.critical > 0) return 'critical';
        if (bySeverity.high > 0) return 'high';
        if (bySeverity.medium > 0) return 'medium';
        if (bySeverity.low > 0) return 'low';
        if (bySeverity.info > 0) return 'info';
        return 'none';
    }

    /**
     * Calculate overall confidence score for the analysis
     */
    calculateOverallConfidence(findings) {
        if (findings.length === 0) return 1.0;

        const avgConfidence = findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length;
        return Math.round(avgConfidence * 100) / 100;
    }

    /**
     * Create empty result for non-applicable files
     */
    createEmptyResult(filePath) {
        return {
            tool: 'eslint',
            filePath,
            language: 'unknown',
            findings: [],
            summary: {
                total: 0,
                bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                byCategory: {},
                hasSecurityIssues: false,
                hasBugs: false,
                highestSeverity: 'none'
            },
            confidence: 1.0,
            skipped: true,
            skipReason: 'Not a JavaScript/TypeScript file'
        };
    }

    /**
     * Analyze multiple files
     * @param {Array<{path: string, content: string}>} files
     * @returns {Object} Combined analysis results
     */
    analyzeFiles(files) {
        const results = {
            tool: 'eslint',
            files: [],
            totalFindings: 0,
            summary: {
                bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
                byCategory: {},
                byFile: {}
            }
        };

        for (const file of files) {
            const fileResult = this.analyze(file.content, { filePath: file.path });
            results.files.push(fileResult);
            results.totalFindings += fileResult.findings.length;

            // Aggregate summary
            for (const [severity, count] of Object.entries(fileResult.summary.bySeverity)) {
                results.summary.bySeverity[severity] += count;
            }
            for (const [category, count] of Object.entries(fileResult.summary.byCategory)) {
                results.summary.byCategory[category] = (results.summary.byCategory[category] || 0) + count;
            }
            results.summary.byFile[file.path] = fileResult.findings.length;
        }

        results.summary.filesAnalyzed = files.length;
        results.summary.filesWithIssues = results.files.filter(f => f.findings.length > 0).length;

        return results;
    }
}

export default ESLintAnalyzer;

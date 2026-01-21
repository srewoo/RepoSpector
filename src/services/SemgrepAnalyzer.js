/**
 * Semgrep-style Security Analyzer for RepoSpector
 *
 * Performs security-focused pattern detection aligned with OWASP Top 10 2021.
 * Uses pattern matching without requiring external Semgrep installation.
 */

import { SEMGREP_RULES, SEVERITY_WEIGHTS } from '../utils/staticAnalysisPatterns.js';

export class SemgrepAnalyzer {
    constructor(options = {}) {
        this.rules = { ...SEMGREP_RULES };
        this.enabledCategories = new Set([
            'A01:2021-Broken Access Control',
            'A02:2021-Cryptographic Failures',
            'A03:2021-Injection',
            'A04:2021-Insecure Design',
            'A05:2021-Security Misconfiguration',
            'A06:2021-Vulnerable Components',
            'A07:2021-Identification and Authentication Failures',
            'A08:2021-Software and Data Integrity Failures',
            'A09:2021-Security Logging Failures',
            'A10:2021-SSRF',
            'Prototype Pollution',
            'Path Traversal'
        ]);

        this.options = {
            minConfidence: options.minConfidence ?? 0.3,
            includeDataFlow: options.includeDataFlow ?? true,
            maxFindingsPerRule: options.maxFindingsPerRule ?? 15,
            ...options
        };

        // Supported languages
        this.supportedLanguages = new Set([
            'javascript', 'typescript', 'python', 'java', 'go', 'ruby'
        ]);

        // Language detection patterns
        this.languageExtensions = {
            '.js': 'javascript',
            '.jsx': 'javascript',
            '.mjs': 'javascript',
            '.ts': 'typescript',
            '.tsx': 'typescript',
            '.py': 'python',
            '.java': 'java',
            '.go': 'go',
            '.rb': 'ruby'
        };
    }

    /**
     * Enable or disable OWASP categories
     * @param {string[]} categories - Category names
     * @param {boolean} enable - Enable or disable
     */
    configureCategories(categories, enable = true) {
        for (const category of categories) {
            if (enable) {
                this.enabledCategories.add(category);
            } else {
                this.enabledCategories.delete(category);
            }
        }
    }

    /**
     * Analyze code for security vulnerabilities
     * @param {string} code - Source code to analyze
     * @param {Object} context - Analysis context
     * @returns {Object} Security analysis results
     */
    analyze(code, context = {}) {
        const { filePath = 'unknown', language = this.detectLanguage(context.filePath) } = context;

        if (!this.supportedLanguages.has(language)) {
            return this.createEmptyResult(filePath, 'Unsupported language');
        }

        const findings = [];
        const lines = code.split('\n');

        // Run each enabled rule
        for (const [ruleId, rule] of Object.entries(this.rules)) {
            if (!this.enabledCategories.has(rule.category)) continue;

            const ruleFindings = this.runSecurityRule(rule, code, lines, filePath, language);
            findings.push(...ruleFindings.slice(0, this.options.maxFindingsPerRule));
        }

        // Filter by minimum confidence
        const filteredFindings = findings.filter(f => f.confidence >= this.options.minConfidence);

        // Sort by severity then confidence
        filteredFindings.sort((a, b) => {
            const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
            const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
            return severityDiff !== 0 ? severityDiff : b.confidence - a.confidence;
        });

        // Data flow analysis to enhance findings
        if (this.options.includeDataFlow) {
            this.enhanceWithDataFlow(filteredFindings, code, lines);
        }

        return {
            tool: 'semgrep',
            filePath,
            language,
            findings: filteredFindings,
            summary: this.generateSummary(filteredFindings),
            confidence: this.calculateOverallConfidence(filteredFindings),
            owaspCoverage: this.calculateOwaspCoverage(filteredFindings)
        };
    }

    /**
     * Run a security rule against the code
     */
    runSecurityRule(rule, code, lines, filePath, language) {
        const findings = [];

        for (const patternDef of rule.patterns) {
            const pattern = new RegExp(patternDef.pattern.source, patternDef.pattern.flags || 'gi');

            let match;
            while ((match = pattern.exec(code)) !== null) {
                const position = this.getPosition(code, match.index);
                const lineContent = lines[position.line - 1] || '';

                // Skip if in comment
                if (this.isInComment(code, match.index)) continue;

                // Calculate confidence
                const confidence = this.calculateSecurityConfidence(
                    rule, patternDef, match, lineContent, code, language
                );

                // Get surrounding context for taint tracking
                const taintInfo = this.analyzeTaint(code, match.index, lines, position.line);

                findings.push({
                    ruleId: rule.id,
                    severity: rule.severity,
                    category: rule.category,
                    owaspCategory: this.extractOwaspId(rule.category),
                    message: patternDef.message,
                    line: position.line,
                    column: position.column,
                    codeSnippet: this.getCodeSnippet(lines, position.line, 3),
                    matchedText: match[0],
                    confidence,
                    taint: taintInfo,
                    remediation: this.getRemediation(rule.id, patternDef.message),
                    filePath,
                    tool: 'semgrep'
                });
            }
        }

        return findings;
    }

    /**
     * Calculate security-specific confidence score
     */
    calculateSecurityConfidence(rule, patternDef, match, lineContent, fullCode, language) {
        let confidence = SEVERITY_WEIGHTS[rule.severity] || 0.5;

        // Taint analysis: check for user input sources
        const userInputPatterns = [
            /(?:req\.|request\.|params\.|query\.|body\.)/i,
            /(?:getParameter|getQueryString|getHeader)/i,
            /(?:user_input|form_data|request\.form)/i,
            /(?:os\.environ|process\.env)/i
        ];

        const hasUserInput = userInputPatterns.some(p => p.test(lineContent));
        if (hasUserInput) {
            confidence = Math.min(1.0, confidence + 0.25);
        }

        // Check for sanitization nearby
        const sanitizationPatterns = [
            /(?:escape|sanitize|encode|validate|filter|clean)/i,
            /(?:htmlspecialchars|addslashes|mysqli_real_escape)/i,
            /(?:DOMPurify|xss|bleach)/i
        ];

        const hasSanitization = sanitizationPatterns.some(p => {
            const context = this.getSurroundingContext(fullCode, match.index, 200);
            return p.test(context);
        });

        if (hasSanitization) {
            confidence *= 0.5; // Reduce if sanitization detected
        }

        // Check for known secure patterns
        if (this.hasSecurePattern(lineContent, rule.id)) {
            confidence *= 0.3;
        }

        // Boost for multiple vulnerability indicators
        const vulnIndicators = [
            /(?:exec|eval|spawn|shell)/i,
            /(?:innerHTML|outerHTML|document\.write)/i,
            /(?:SELECT|INSERT|UPDATE|DELETE).*\+/i,
            /(?:redirect|location\.href)/i
        ];

        const vulnCount = vulnIndicators.filter(p => p.test(lineContent)).length;
        if (vulnCount > 1) {
            confidence = Math.min(1.0, confidence + (vulnCount - 1) * 0.1);
        }

        return Math.max(0, Math.min(1, confidence));
    }

    /**
     * Analyze potential taint flow
     */
    analyzeTaint(code, matchIndex, lines, lineNum) {
        const taint = {
            hasUserInput: false,
            sources: [],
            sinks: [],
            hasSanitization: false,
            dataFlowPath: []
        };

        // Get context around the match (10 lines before and after)
        const startLine = Math.max(0, lineNum - 10);
        const endLine = Math.min(lines.length, lineNum + 10);
        const context = lines.slice(startLine, endLine).join('\n');

        // Identify sources (user input)
        const sourcePatterns = [
            { pattern: /(?:req|request)\.(?:body|query|params|headers)\[?\w*/gi, type: 'HTTP Request' },
            { pattern: /(?:getParameter|getQueryString|getHeader)\s*\(/gi, type: 'HTTP Parameter' },
            { pattern: /process\.env\.\w+/gi, type: 'Environment Variable' },
            { pattern: /(?:fs\.read|readFile)\s*\(/gi, type: 'File Read' },
            { pattern: /(?:prompt|readline)/gi, type: 'User Input' }
        ];

        for (const { pattern, type } of sourcePatterns) {
            const matches = context.match(pattern);
            if (matches) {
                taint.hasUserInput = true;
                taint.sources.push({ type, matches: [...new Set(matches)] });
            }
        }

        // Identify sinks (dangerous operations)
        const sinkPatterns = [
            { pattern: /(?:exec|execSync|spawn|spawnSync)\s*\(/gi, type: 'Command Execution' },
            { pattern: /(?:query|execute)\s*\(/gi, type: 'Database Query' },
            { pattern: /\.innerHTML\s*=/gi, type: 'DOM Manipulation' },
            { pattern: /(?:redirect|location\.href|window\.location)\s*=/gi, type: 'Redirect' },
            { pattern: /(?:eval|Function)\s*\(/gi, type: 'Code Evaluation' }
        ];

        for (const { pattern, type } of sinkPatterns) {
            if (pattern.test(context)) {
                taint.sinks.push(type);
            }
        }

        // Check for sanitization
        const sanitizers = [
            /(?:escape|sanitize|encode|validate|filter|clean)\s*\(/gi,
            /(?:DOMPurify|xss|he\.encode|htmlEntities)/gi,
            /(?:parameterized|prepared\s*statement|placeholder)/gi
        ];

        taint.hasSanitization = sanitizers.some(p => p.test(context));

        return taint;
    }

    /**
     * Enhance findings with data flow information
     */
    enhanceWithDataFlow(findings, code, lines) {
        for (const finding of findings) {
            if (finding.taint.hasUserInput && finding.taint.sinks.length > 0) {
                // Increase confidence for tainted data reaching sinks
                finding.confidence = Math.min(1.0, finding.confidence + 0.15);
                finding.dataFlowConfirmed = true;
            }

            if (finding.taint.hasSanitization) {
                finding.sanitizationDetected = true;
                finding.message += ' (sanitization detected - verify effectiveness)';
            }
        }
    }

    /**
     * Check for secure patterns that reduce confidence
     */
    hasSecurePattern(lineContent, ruleId) {
        const securePatterns = {
            'injection': /(?:parameterized|prepared|placeholder|binding)/i,
            'weak-crypto': /(?:sha256|sha512|aes-256|argon2|bcrypt)/i,
            'auth-failures': /(?:RS256|RS512|ES256|expiresIn:\s*['"](?:1h|30m|15m)['"])/i
        };

        const pattern = securePatterns[ruleId];
        return pattern ? pattern.test(lineContent) : false;
    }

    /**
     * Get remediation advice for a finding
     */
    getRemediation(ruleId, message) {
        const remediations = {
            'broken-access-control': 'Implement server-side authorization checks. Never trust client-side access control.',
            'weak-crypto': 'Use SHA-256 or better for hashing. Use AES-256-GCM for encryption. Use crypto.randomBytes() for random values.',
            'injection': 'Use parameterized queries for SQL. Escape/encode output for XSS. Avoid shell commands or use safer alternatives.',
            'insecure-design': 'Enable rate limiting and input validation. Follow security design patterns.',
            'security-misconfiguration': 'Restrict CORS origins. Disable debug mode in production. Enable security headers.',
            'vulnerable-components': 'Update to the latest patched version. Monitor security advisories.',
            'auth-failures': 'Use bcrypt/argon2 for passwords. Use strong JWT algorithms (RS256). Set reasonable token expiration.',
            'integrity-failures': 'Validate and sanitize all untrusted input. Use JSON schema validation.',
            'logging-failures': 'Log all security events. Never log sensitive data. Implement monitoring alerts.',
            'ssrf': 'Validate and whitelist allowed URLs. Implement URL parsing and validation.',
            'prototype-pollution': 'Validate object keys. Use Object.create(null) for dictionaries. Freeze prototypes.',
            'path-traversal': 'Validate file paths. Use path.resolve() and check against base directory.'
        };

        return remediations[ruleId] || 'Review and remediate according to security best practices.';
    }

    /**
     * Extract OWASP ID from category
     */
    extractOwaspId(category) {
        const match = category.match(/A\d{2}:2021/);
        return match ? match[0] : null;
    }

    /**
     * Get surrounding context
     */
    getSurroundingContext(code, index, chars) {
        const start = Math.max(0, index - chars);
        const end = Math.min(code.length, index + chars);
        return code.substring(start, end);
    }

    /**
     * Check if position is inside a comment
     */
    isInComment(code, index) {
        // Check for single-line comment
        const lineStart = code.lastIndexOf('\n', index) + 1;
        const lineBeforeMatch = code.substring(lineStart, index);
        if (lineBeforeMatch.includes('//')) return true;

        // Check for multi-line comment
        const beforeMatch = code.substring(0, index);
        const lastCommentStart = beforeMatch.lastIndexOf('/*');
        const lastCommentEnd = beforeMatch.lastIndexOf('*/');

        if (lastCommentStart > lastCommentEnd) {
            return true;
        }

        return false;
    }

    /**
     * Get position from character index
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
    getCodeSnippet(lines, lineNum, context = 3) {
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
     * Detect language from file path
     */
    detectLanguage(filePath) {
        if (!filePath) return 'javascript';

        for (const [ext, lang] of Object.entries(this.languageExtensions)) {
            if (filePath.endsWith(ext)) {
                return lang;
            }
        }

        return 'javascript';
    }

    /**
     * Generate summary of findings
     */
    generateSummary(findings) {
        const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
        const byCategory = {};
        const byOwasp = {};

        for (const finding of findings) {
            bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
            byCategory[finding.category] = (byCategory[finding.category] || 0) + 1;

            if (finding.owaspCategory) {
                byOwasp[finding.owaspCategory] = (byOwasp[finding.owaspCategory] || 0) + 1;
            }
        }

        return {
            total: findings.length,
            bySeverity,
            byCategory,
            byOwasp,
            criticalCount: bySeverity.critical,
            highCount: bySeverity.high,
            taintedFindings: findings.filter(f => f.taint?.hasUserInput).length,
            sanitizedFindings: findings.filter(f => f.taint?.hasSanitization).length
        };
    }

    /**
     * Calculate overall confidence
     */
    calculateOverallConfidence(findings) {
        if (findings.length === 0) return 1.0;
        const avgConfidence = findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length;
        return Math.round(avgConfidence * 100) / 100;
    }

    /**
     * Calculate OWASP Top 10 coverage
     */
    calculateOwaspCoverage(findings) {
        const owaspCategories = new Set([
            'A01:2021', 'A02:2021', 'A03:2021', 'A04:2021', 'A05:2021',
            'A06:2021', 'A07:2021', 'A08:2021', 'A09:2021', 'A10:2021'
        ]);

        const foundCategories = new Set(
            findings.map(f => f.owaspCategory).filter(Boolean)
        );

        return {
            covered: foundCategories.size,
            total: owaspCategories.size,
            percentage: Math.round((foundCategories.size / owaspCategories.size) * 100),
            categories: [...foundCategories]
        };
    }

    /**
     * Create empty result
     */
    createEmptyResult(filePath, reason = 'No findings') {
        return {
            tool: 'semgrep',
            filePath,
            findings: [],
            summary: {
                total: 0,
                bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
                byCategory: {},
                byOwasp: {}
            },
            confidence: 1.0,
            owaspCoverage: { covered: 0, total: 10, percentage: 0, categories: [] },
            skipped: true,
            skipReason: reason
        };
    }

    /**
     * Analyze multiple files
     */
    analyzeFiles(files) {
        const results = {
            tool: 'semgrep',
            files: [],
            totalFindings: 0,
            summary: {
                bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
                byCategory: {},
                byOwasp: {}
            }
        };

        for (const file of files) {
            const fileResult = this.analyze(file.content, { filePath: file.path });
            results.files.push(fileResult);
            results.totalFindings += fileResult.findings.length;

            // Aggregate summaries
            for (const [severity, count] of Object.entries(fileResult.summary.bySeverity)) {
                results.summary.bySeverity[severity] += count;
            }
            for (const [category, count] of Object.entries(fileResult.summary.byCategory)) {
                results.summary.byCategory[category] = (results.summary.byCategory[category] || 0) + count;
            }
            for (const [owasp, count] of Object.entries(fileResult.summary.byOwasp)) {
                results.summary.byOwasp[owasp] = (results.summary.byOwasp[owasp] || 0) + count;
            }
        }

        results.summary.filesAnalyzed = files.length;
        results.summary.filesWithVulnerabilities = results.files.filter(f => f.findings.length > 0).length;

        return results;
    }
}

export default SemgrepAnalyzer;

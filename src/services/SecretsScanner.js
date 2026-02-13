/**
 * Secrets Scanner for RepoSpector
 *
 * Detects exposed secrets, API keys, tokens, passwords, and private keys
 * in PR diffs using regex patterns. Inspired by detect-secrets and Whispers.
 */

export class SecretsScanner {
    constructor() {
        this.patterns = [
            // AWS
            { id: 'aws-access-key', pattern: /(?:AKIA|A3T[A-Z0-9])[A-Z0-9]{16}/g, severity: 'critical', label: 'AWS Access Key ID' },
            { id: 'aws-secret-key', pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/g, severity: 'critical', label: 'AWS Secret Access Key' },

            // GitHub
            { id: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,255}/g, severity: 'critical', label: 'GitHub Token' },
            { id: 'github-fine-grained', pattern: /github_pat_[A-Za-z0-9_]{22,255}/g, severity: 'critical', label: 'GitHub Fine-grained Token' },

            // GitLab
            { id: 'gitlab-token', pattern: /glpat-[A-Za-z0-9\-_]{20,}/g, severity: 'critical', label: 'GitLab Personal Access Token' },

            // Google
            { id: 'google-api-key', pattern: /AIza[0-9A-Za-z\-_]{35}/g, severity: 'high', label: 'Google API Key' },
            { id: 'google-oauth', pattern: /[0-9]+-[a-z0-9_]{32}\.apps\.googleusercontent\.com/g, severity: 'high', label: 'Google OAuth Client ID' },
            { id: 'gcp-service-account', pattern: /"type"\s*:\s*"service_account"/g, severity: 'critical', label: 'GCP Service Account JSON' },

            // OpenAI
            { id: 'openai-key', pattern: /sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/g, severity: 'critical', label: 'OpenAI API Key' },
            { id: 'openai-key-v2', pattern: /sk-proj-[A-Za-z0-9\-_]{40,}/g, severity: 'critical', label: 'OpenAI Project API Key' },

            // Anthropic
            { id: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9\-_]{80,}/g, severity: 'critical', label: 'Anthropic API Key' },

            // Stripe
            { id: 'stripe-secret', pattern: /sk_live_[0-9a-zA-Z]{24,}/g, severity: 'critical', label: 'Stripe Secret Key' },
            { id: 'stripe-restricted', pattern: /rk_live_[0-9a-zA-Z]{24,}/g, severity: 'critical', label: 'Stripe Restricted Key' },

            // Slack
            { id: 'slack-token', pattern: /xox[bporas]-[0-9]{10,}-[a-zA-Z0-9-]+/g, severity: 'critical', label: 'Slack Token' },
            { id: 'slack-webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/T[a-zA-Z0-9_]+\/B[a-zA-Z0-9_]+\/[a-zA-Z0-9_]+/g, severity: 'high', label: 'Slack Webhook URL' },

            // Twilio
            { id: 'twilio-key', pattern: /SK[0-9a-fA-F]{32}/g, severity: 'high', label: 'Twilio API Key' },

            // SendGrid
            { id: 'sendgrid-key', pattern: /SG\.[a-zA-Z0-9\-_]{22}\.[a-zA-Z0-9\-_]{43}/g, severity: 'critical', label: 'SendGrid API Key' },

            // NPM
            { id: 'npm-token', pattern: /npm_[A-Za-z0-9]{36}/g, severity: 'critical', label: 'NPM Access Token' },

            // Private Keys
            { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, severity: 'critical', label: 'Private Key' },

            // Generic patterns
            { id: 'generic-secret', pattern: /(?:secret|password|passwd|pwd|token|api_key|apikey|api-key|access_token|auth_token|credentials)\s*[:=]\s*['"`]([^'"`\s]{8,})['"` ]/gi, severity: 'high', label: 'Hardcoded Secret' },
            { id: 'bearer-token', pattern: /['"]Bearer\s+[A-Za-z0-9\-._~+/]+=*['"]/g, severity: 'high', label: 'Hardcoded Bearer Token' },
            { id: 'basic-auth', pattern: /['"]Basic\s+[A-Za-z0-9+/]+=*['"]/g, severity: 'high', label: 'Hardcoded Basic Auth' },

            // Database connection strings
            { id: 'db-connection', pattern: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/gi, severity: 'critical', label: 'Database Connection String with Credentials' },

            // JWT
            { id: 'jwt-token', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, severity: 'high', label: 'JWT Token' },

            // Hex-encoded secrets (32+ chars, likely keys)
            { id: 'hex-secret', pattern: /(?:secret|key|token|password)\s*[:=]\s*['"]([0-9a-fA-F]{32,})['"] /gi, severity: 'medium', label: 'Possible Hex-encoded Secret' }
        ];

        // Files to skip (test fixtures, lockfiles, etc.)
        this.skipPatterns = [
            /\.lock$/,
            /package-lock\.json$/,
            /yarn\.lock$/,
            /\.min\.js$/,
            /\.min\.css$/,
            /\.map$/,
            /\.test\.[jt]sx?$/,
            /\.spec\.[jt]sx?$/,
            /__tests__\//,
            /test\/fixtures\//,
            /\.snap$/
        ];
    }

    /**
     * Scan added lines in a PR diff for secrets
     * @param {Array} files - PR files with patches
     * @returns {Array} Findings
     */
    scanPRFiles(files) {
        const findings = [];

        for (const file of files) {
            if (!file.patch || file.status === 'removed') continue;
            if (this.shouldSkipFile(file.filename)) continue;

            const addedLines = this.extractAddedLines(file.patch);

            for (const { line, lineNumber } of addedLines) {
                const lineFindings = this.scanLine(line, file.filename, lineNumber);
                findings.push(...lineFindings);
            }
        }

        return this.deduplicateFindings(findings);
    }

    /**
     * Scan a single line for secrets
     */
    scanLine(line, filePath, lineNumber) {
        const findings = [];

        // Skip comments that are just explaining patterns
        if (this.isDocumentation(line)) return findings;

        for (const rule of this.patterns) {
            // Reset regex lastIndex
            rule.pattern.lastIndex = 0;
            let match;

            while ((match = rule.pattern.exec(line)) !== null) {
                // Verify it's not a placeholder
                if (this.isPlaceholder(match[0])) continue;

                const secret = match[0];
                const masked = this.maskSecret(secret);

                findings.push({
                    tool: 'secrets',
                    ruleId: rule.id,
                    severity: rule.severity,
                    category: 'security',
                    message: `${rule.label} detected: ${masked}`,
                    filePath,
                    line: lineNumber,
                    confidence: this.calculateConfidence(rule, line, filePath),
                    remediation: `Remove the secret and rotate it immediately. Use environment variables or a secrets manager instead.`,
                    cwe: 'CWE-798',
                    owasp: 'A07:2021 - Identification and Authentication Failures',
                    secretType: rule.id
                });
            }
        }

        return findings;
    }

    /**
     * Extract added lines from a diff patch with line numbers
     */
    extractAddedLines(patch) {
        const lines = patch.split('\n');
        const added = [];
        let currentLine = 0;

        for (const line of lines) {
            // Parse hunk header for line numbers
            const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (hunkMatch) {
                currentLine = parseInt(hunkMatch[1], 10) - 1;
                continue;
            }

            if (line.startsWith('+') && !line.startsWith('+++')) {
                currentLine++;
                added.push({ line: line.substring(1), lineNumber: currentLine });
            } else if (!line.startsWith('-')) {
                currentLine++;
            }
        }

        return added;
    }

    /**
     * Check if line is documentation/comment explaining a pattern
     */
    isDocumentation(line) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            // Allow if it contains actual key patterns (someone may have pasted a key in a comment)
            if (/(?:AKIA|ghp_|glpat-|sk-|sk_live_)/.test(trimmed)) return false;
            return true;
        }
        return false;
    }

    /**
     * Check if a matched string is a placeholder
     */
    isPlaceholder(value) {
        const placeholders = [
            /^[xX]+$/, /^[*]+$/, /^\.{3,}$/, /^<.*>$/,
            /YOUR[_-]?(?:KEY|TOKEN|SECRET)/i,
            /REPLACE[_-]?ME/i,
            /INSERT[_-]?(?:HERE|YOUR)/i,
            /EXAMPLE/i,
            /PLACEHOLDER/i,
            /^sk-[xX.]+$/,
            /^0{8,}$/,
            /^1{8,}$/,
            /test/i
        ];
        return placeholders.some(p => p.test(value));
    }

    /**
     * Mask a secret for display
     */
    maskSecret(secret) {
        if (secret.length <= 8) return '***';
        return secret.substring(0, 4) + '...' + secret.substring(secret.length - 4);
    }

    /**
     * Calculate confidence based on context
     */
    calculateConfidence(rule, line, filePath) {
        let confidence = 0.85;

        // Higher confidence for specific patterns
        if (['aws-access-key', 'github-token', 'private-key', 'stripe-secret'].includes(rule.id)) {
            confidence = 0.95;
        }

        // Lower confidence for generic patterns
        if (['generic-secret', 'hex-secret'].includes(rule.id)) {
            confidence = 0.6;
        }

        // Lower confidence in test files
        if (/test|spec|mock|fixture/i.test(filePath)) {
            confidence *= 0.7;
        }

        // Higher confidence in config/env files
        if (/\.env|config|settings|credentials/i.test(filePath)) {
            confidence = Math.min(confidence + 0.1, 1.0);
        }

        return Math.round(confidence * 100) / 100;
    }

    /**
     * Check if file should be skipped
     */
    shouldSkipFile(filename) {
        return this.skipPatterns.some(p => p.test(filename));
    }

    /**
     * Deduplicate findings (same secret in same file)
     */
    deduplicateFindings(findings) {
        const seen = new Set();
        return findings.filter(f => {
            const key = `${f.ruleId}:${f.filePath}:${f.line}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
}

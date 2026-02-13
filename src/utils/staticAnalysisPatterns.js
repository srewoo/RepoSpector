/**
 * Static Analysis Patterns for RepoSpector
 *
 * Defines rule definitions for ESLint-style analysis, Semgrep-style security patterns,
 * and dependency vulnerability detection.
 */

/**
 * ESLint-style code quality and bug detection rules
 */
export const ESLINT_RULES = {
    // Security Rules
    'no-eval': {
        id: 'no-eval',
        severity: 'critical',
        category: 'security',
        message: 'Avoid using eval() as it can execute arbitrary code',
        pattern: /\beval\s*\(/g,
        cwe: 'CWE-95',
        owasp: 'A03:2021-Injection'
    },
    'no-new-function': {
        id: 'no-new-function',
        severity: 'high',
        category: 'security',
        message: 'Avoid using new Function() as it can execute arbitrary code',
        pattern: /new\s+Function\s*\(/g,
        cwe: 'CWE-95',
        owasp: 'A03:2021-Injection'
    },
    'no-implied-eval': {
        id: 'no-implied-eval',
        severity: 'high',
        category: 'security',
        message: 'Avoid using setTimeout/setInterval with string arguments',
        pattern: /(?:setTimeout|setInterval)\s*\(\s*["'`]/g,
        cwe: 'CWE-95',
        owasp: 'A03:2021-Injection'
    },
    'no-document-write': {
        id: 'no-document-write',
        severity: 'medium',
        category: 'security',
        message: 'Avoid document.write() as it can lead to XSS vulnerabilities',
        pattern: /document\.write\s*\(/g,
        cwe: 'CWE-79',
        owasp: 'A03:2021-Injection'
    },
    'no-innerhtml': {
        id: 'no-innerhtml',
        severity: 'medium',
        category: 'security',
        message: 'Avoid innerHTML with user input - use textContent or sanitize',
        pattern: /\.innerHTML\s*=/g,
        cwe: 'CWE-79',
        owasp: 'A03:2021-Injection'
    },
    'no-hardcoded-credentials': {
        id: 'no-hardcoded-credentials',
        severity: 'critical',
        category: 'security',
        message: 'Potential hardcoded credentials detected',
        pattern: /(?:password|passwd|pwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
        cwe: 'CWE-798',
        owasp: 'A07:2021-Identification and Authentication Failures'
    },
    'no-sql-injection': {
        id: 'no-sql-injection',
        severity: 'critical',
        category: 'security',
        message: 'Potential SQL injection - use parameterized queries',
        pattern: /(?:query|execute|exec)\s*\(\s*['"`](?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\s+.*?\$\{|['"`]\s*\+\s*\w+/gi,
        cwe: 'CWE-89',
        owasp: 'A03:2021-Injection'
    },
    'no-command-injection': {
        id: 'no-command-injection',
        severity: 'critical',
        category: 'security',
        message: 'Potential command injection - sanitize user input',
        pattern: /(?:exec|spawn|execSync|spawnSync|execFile|fork)\s*\([^)]*\$\{/g,
        cwe: 'CWE-78',
        owasp: 'A03:2021-Injection'
    },

    // Bug Detection Rules
    'no-unreachable': {
        id: 'no-unreachable',
        severity: 'medium',
        category: 'bug',
        message: 'Code after return/throw/break is unreachable',
        pattern: /(?:return|throw|break|continue)\s*[^;]*;\s*(?![\s}]|$)[^}\s]/g,
        cwe: 'CWE-561'
    },
    'no-constant-condition': {
        id: 'no-constant-condition',
        severity: 'medium',
        category: 'bug',
        message: 'Constant condition in control flow statement',
        pattern: /(?:if|while)\s*\(\s*(?:true|false|0|1|null|undefined)\s*\)/g,
        cwe: 'CWE-570'
    },
    'no-self-assign': {
        id: 'no-self-assign',
        severity: 'low',
        category: 'bug',
        message: 'Self-assignment has no effect',
        pattern: /(\w+)\s*=\s*\1(?:\s*;|$)/g,
        cwe: 'CWE-480'
    },
    'no-dupe-keys': {
        id: 'no-dupe-keys',
        severity: 'medium',
        category: 'bug',
        message: 'Duplicate keys in object literal',
        pattern: /\{[^}]*(['"`]?\w+['"`]?)\s*:[^}]*\1\s*:/g,
        cwe: 'CWE-561'
    },
    'use-isnan': {
        id: 'use-isnan',
        severity: 'medium',
        category: 'bug',
        message: 'Use Number.isNaN() instead of direct NaN comparison',
        pattern: /(?:===?|!==?)\s*NaN|NaN\s*(?:===?|!==?)/g,
        cwe: 'CWE-480'
    },
    'no-sparse-arrays': {
        id: 'no-sparse-arrays',
        severity: 'low',
        category: 'bug',
        message: 'Sparse arrays can cause unexpected behavior',
        pattern: /\[\s*,\s*,|\[\s*,|,\s*,\s*\]/g,
        cwe: 'CWE-665'
    },

    // Performance Rules
    'no-await-in-loop': {
        id: 'no-await-in-loop',
        severity: 'medium',
        category: 'performance',
        message: 'Consider using Promise.all() for concurrent async operations',
        pattern: /(?:for|while)\s*\([^)]*\)\s*\{[^}]*await\s+/gs,
        cwe: null
    },
    'no-sync-methods': {
        id: 'no-sync-methods',
        severity: 'low',
        category: 'performance',
        message: 'Synchronous methods can block the event loop',
        pattern: /(?:readFileSync|writeFileSync|existsSync|accessSync|readdirSync|statSync|mkdirSync|unlinkSync)\s*\(/g,
        cwe: null
    },
    'no-console': {
        id: 'no-console',
        severity: 'info',
        category: 'quality',
        message: 'Console statements should be removed in production',
        pattern: /console\.(?:log|debug|info|warn|error|trace)\s*\(/g,
        cwe: null
    },

    // Error Handling Rules
    'no-empty-catch': {
        id: 'no-empty-catch',
        severity: 'medium',
        category: 'error-handling',
        message: 'Empty catch blocks can hide errors',
        pattern: /catch\s*\([^)]*\)\s*\{\s*\}/g,
        cwe: 'CWE-390'
    },
    'no-throw-literal': {
        id: 'no-throw-literal',
        severity: 'low',
        category: 'error-handling',
        message: 'Throw Error objects instead of literals',
        pattern: /throw\s+(?:['"`][^'"`]+['"`]|\d+|true|false|null)/g,
        cwe: 'CWE-397'
    },

    // Best Practices
    'eqeqeq': {
        id: 'eqeqeq',
        severity: 'low',
        category: 'quality',
        message: 'Use strict equality (=== or !==) instead of loose equality',
        pattern: /[^!=]==[^=]|[^!]!=[^=]/g,
        cwe: 'CWE-480'
    },
    'no-var': {
        id: 'no-var',
        severity: 'info',
        category: 'quality',
        message: 'Use let or const instead of var',
        pattern: /\bvar\s+\w+/g,
        cwe: null
    },
    'no-magic-numbers': {
        id: 'no-magic-numbers',
        severity: 'info',
        category: 'quality',
        message: 'Consider extracting magic numbers into named constants',
        pattern: /[^0-9a-zA-Z_]((?:[2-9]\d{2,}|\d{4,}))[^0-9a-zA-Z_]/g,
        cwe: null
    }
};

/**
 * Semgrep-style security patterns (OWASP Top 10 focused)
 */
export const SEMGREP_RULES = {
    // A01:2021 - Broken Access Control
    'broken-access-control': {
        id: 'broken-access-control',
        severity: 'high',
        category: 'A01:2021-Broken Access Control',
        patterns: [
            {
                pattern: /(?:\.params\.|\.query\.|\.body\.)\w+.*(?:admin|role|permission|access)/gi,
                message: 'User-controlled access control parameter - verify authorization'
            },
            {
                pattern: /(?:isAdmin|hasRole|canAccess)\s*=\s*(?:req\.|request\.)/gi,
                message: 'Access control derived from user input - use server-side verification'
            }
        ]
    },

    // A02:2021 - Cryptographic Failures
    'weak-crypto': {
        id: 'weak-crypto',
        severity: 'high',
        category: 'A02:2021-Cryptographic Failures',
        patterns: [
            {
                pattern: /createHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)/gi,
                message: 'Weak hash algorithm (MD5/SHA1) - use SHA-256 or better'
            },
            {
                pattern: /createCipher(?:iv)?\s*\(\s*['"](?:des|rc4|blowfish)['"]/gi,
                message: 'Weak encryption algorithm - use AES-256-GCM'
            },
            {
                pattern: /Math\.random\s*\(/g,
                message: 'Math.random() is not cryptographically secure - use crypto.randomBytes()'
            }
        ]
    },

    // A03:2021 - Injection
    'injection': {
        id: 'injection',
        severity: 'critical',
        category: 'A03:2021-Injection',
        patterns: [
            {
                pattern: /\$\{[^}]*(?:req|request|params|query|body|user)[^}]*\}.*(?:SELECT|INSERT|UPDATE|DELETE)/gi,
                message: 'SQL Injection - use parameterized queries'
            },
            {
                pattern: /(?:exec|execSync|spawn)\s*\(\s*(?:`[^`]*\$\{|['"][^'"]*['"]\s*\+)/g,
                message: 'Command Injection - sanitize input or use safer alternatives'
            },
            {
                pattern: /\.innerHTML\s*=\s*(?:\w+\.(?:value|textContent)|[^'"]+\$\{)/g,
                message: 'XSS via innerHTML - use textContent or sanitize input'
            },
            {
                pattern: /document\.write\s*\([^)]*(?:\+|\$\{)/g,
                message: 'XSS via document.write - avoid or sanitize input'
            }
        ]
    },

    // A04:2021 - Insecure Design
    'insecure-design': {
        id: 'insecure-design',
        severity: 'medium',
        category: 'A04:2021-Insecure Design',
        patterns: [
            {
                pattern: /(?:rate[_-]?limit|throttle)\s*[:=]\s*(?:false|0|null)/gi,
                message: 'Rate limiting disabled - consider enabling to prevent abuse'
            },
            {
                pattern: /(?:validate|validation|verify)\s*[:=]\s*false/gi,
                message: 'Input validation disabled - always validate user input'
            }
        ]
    },

    // A05:2021 - Security Misconfiguration
    'security-misconfiguration': {
        id: 'security-misconfiguration',
        severity: 'high',
        category: 'A05:2021-Security Misconfiguration',
        patterns: [
            {
                pattern: /cors\s*\(\s*\{[^}]*origin\s*:\s*(?:true|['"]?\*['"]?)/gi,
                message: 'CORS allows all origins - restrict to trusted domains'
            },
            {
                pattern: /debug\s*[:=]\s*true/gi,
                message: 'Debug mode enabled - disable in production'
            },
            {
                pattern: /NODE_ENV\s*(?:===?|!==?)\s*['"]development['"]/g,
                message: 'Development-only code path - verify production handling'
            },
            {
                pattern: /helmet\s*\(\s*\{[^}]*(?:contentSecurityPolicy|frameguard|xssFilter)\s*:\s*false/gi,
                message: 'Security header disabled - enable unless absolutely necessary'
            }
        ]
    },

    // A06:2021 - Vulnerable Components
    'vulnerable-components': {
        id: 'vulnerable-components',
        severity: 'high',
        category: 'A06:2021-Vulnerable Components',
        patterns: [
            {
                pattern: /require\s*\(\s*['"](?:serialize-javascript|node-serialize|js-yaml)['"]\s*\)/g,
                message: 'Potentially vulnerable library - check for security updates'
            }
        ]
    },

    // A07:2021 - Identification and Authentication Failures
    'auth-failures': {
        id: 'auth-failures',
        severity: 'critical',
        category: 'A07:2021-Identification and Authentication Failures',
        patterns: [
            {
                pattern: /(?:jwt\.sign|createToken)\s*\([^)]*(?:expiresIn\s*:\s*['"](?:\d+d|\d{6,})|algorithm\s*:\s*['"](?:none|HS256)['"])/gi,
                message: 'Weak JWT configuration - use strong algorithm and reasonable expiration'
            },
            {
                pattern: /bcrypt\.(?:hash|compare)Sync/g,
                message: 'Synchronous bcrypt blocks event loop - use async version'
            },
            {
                pattern: /password.*(?:md5|sha1|sha256)\s*\(/gi,
                message: 'Plain hashing for passwords - use bcrypt, argon2, or scrypt'
            }
        ]
    },

    // A08:2021 - Software and Data Integrity Failures
    'integrity-failures': {
        id: 'integrity-failures',
        severity: 'high',
        category: 'A08:2021-Software and Data Integrity Failures',
        patterns: [
            {
                pattern: /JSON\.parse\s*\(\s*(?:req|request|user)/g,
                message: 'Parsing untrusted JSON - validate schema first'
            },
            {
                pattern: /(?:deserialize|unserialize|unpickle)\s*\(/g,
                message: 'Deserializing untrusted data - validate input first'
            }
        ]
    },

    // A09:2021 - Security Logging and Monitoring Failures
    'logging-failures': {
        id: 'logging-failures',
        severity: 'medium',
        category: 'A09:2021-Security Logging Failures',
        patterns: [
            {
                pattern: /catch\s*\([^)]*\)\s*\{\s*(?:\/\/|return|throw)/g,
                message: 'Error not logged - add logging for security monitoring'
            },
            {
                pattern: /console\.(?:log|error)\s*\([^)]*(?:password|token|secret|key)/gi,
                message: 'Sensitive data in logs - redact before logging'
            }
        ]
    },

    // A10:2021 - Server-Side Request Forgery (SSRF)
    'ssrf': {
        id: 'ssrf',
        severity: 'high',
        category: 'A10:2021-SSRF',
        patterns: [
            {
                pattern: /(?:fetch|axios|request|got|http\.get)\s*\(\s*(?:\w+\.(?:url|uri|href)|`[^`]*\$\{)/g,
                message: 'SSRF risk - validate and whitelist URLs before requesting'
            },
            {
                pattern: /(?:redirect|location)\s*=\s*(?:req\.|request\.)/g,
                message: 'Open redirect - validate redirect URLs against whitelist'
            }
        ]
    },

    // Prototype Pollution
    'prototype-pollution': {
        id: 'prototype-pollution',
        severity: 'high',
        category: 'Prototype Pollution',
        patterns: [
            {
                pattern: /(?:Object\.assign|_\.merge|_\.extend|_\.defaultsDeep)\s*\([^)]*(?:req|request|body|params)/g,
                message: 'Prototype pollution risk - validate keys before merging'
            },
            {
                pattern: /\[(?:req|request|body|params)[^\]]*\]\s*=/g,
                message: 'Dynamic property assignment - check for __proto__ and constructor'
            }
        ]
    },

    // Path Traversal
    'path-traversal': {
        id: 'path-traversal',
        severity: 'high',
        category: 'Path Traversal',
        patterns: [
            {
                pattern: /(?:readFile|writeFile|createReadStream|createWriteStream)\s*\([^)]*(?:req|request|params|query)/g,
                message: 'Path traversal risk - validate and sanitize file paths'
            },
            {
                pattern: /path\.(?:join|resolve)\s*\([^)]*(?:req|request|params|query)/g,
                message: 'Path traversal risk - ensure path stays within allowed directory'
            }
        ]
    }
};

/**
 * Known vulnerable package patterns
 */
export const VULNERABLE_PACKAGES = {
    // Critical severity
    'event-stream': {
        vulnerableVersions: '<3.3.6',
        severity: 'critical',
        cve: 'CVE-2018-16487',
        description: 'Malicious code injection'
    },
    'lodash': {
        vulnerableVersions: '<4.17.21',
        severity: 'high',
        cve: 'CVE-2021-23337',
        description: 'Command Injection'
    },
    'minimist': {
        vulnerableVersions: '<1.2.6',
        severity: 'high',
        cve: 'CVE-2021-44906',
        description: 'Prototype Pollution'
    },
    'glob-parent': {
        vulnerableVersions: '<5.1.2',
        severity: 'high',
        cve: 'CVE-2020-28469',
        description: 'Regular Expression Denial of Service'
    },
    'axios': {
        vulnerableVersions: '<0.21.2',
        severity: 'high',
        cve: 'CVE-2021-3749',
        description: 'Server-Side Request Forgery'
    },
    'node-fetch': {
        vulnerableVersions: '<2.6.7',
        severity: 'high',
        cve: 'CVE-2022-0235',
        description: 'Exposure of Sensitive Information'
    },
    'express': {
        vulnerableVersions: '<4.17.3',
        severity: 'medium',
        cve: 'CVE-2022-24999',
        description: 'Open Redirect'
    },
    'moment': {
        vulnerableVersions: '<2.29.4',
        severity: 'high',
        cve: 'CVE-2022-31129',
        description: 'Path Traversal'
    },
    'shelljs': {
        vulnerableVersions: '<0.8.5',
        severity: 'high',
        cve: 'CVE-2022-0144',
        description: 'Improper Privilege Management'
    },
    'serialize-javascript': {
        vulnerableVersions: '<3.1.0',
        severity: 'critical',
        cve: 'CVE-2020-7660',
        description: 'Remote Code Execution'
    },
    'js-yaml': {
        vulnerableVersions: '<3.13.1',
        severity: 'critical',
        cve: 'CVE-2019-7609',
        description: 'Code Injection'
    },
    'tar': {
        vulnerableVersions: '<6.1.11',
        severity: 'high',
        cve: 'CVE-2021-37713',
        description: 'Arbitrary File Creation/Overwrite'
    },
    'path-parse': {
        vulnerableVersions: '<1.0.7',
        severity: 'medium',
        cve: 'CVE-2021-23343',
        description: 'Regular Expression Denial of Service'
    },
    'ansi-regex': {
        vulnerableVersions: '<5.0.1',
        severity: 'high',
        cve: 'CVE-2021-3807',
        description: 'Regular Expression Denial of Service'
    },
    'qs': {
        vulnerableVersions: '<6.10.3',
        severity: 'high',
        cve: 'CVE-2022-24999',
        description: 'Prototype Pollution'
    },
    'jsonwebtoken': {
        vulnerableVersions: '<9.0.0',
        severity: 'high',
        cve: 'CVE-2022-23529',
        description: 'Authentication Bypass'
    }
};

/**
 * Python-specific vulnerable packages
 */
export const VULNERABLE_PYTHON_PACKAGES = {
    'pyyaml': {
        vulnerableVersions: '<5.4',
        severity: 'critical',
        cve: 'CVE-2020-14343',
        description: 'Arbitrary Code Execution'
    },
    'django': {
        vulnerableVersions: '<3.2.12',
        severity: 'high',
        cve: 'CVE-2022-22818',
        description: 'SQL Injection'
    },
    'flask': {
        vulnerableVersions: '<2.2.5',
        severity: 'high',
        cve: 'CVE-2023-30861',
        description: 'Cookie Parsing Vulnerability'
    },
    'requests': {
        vulnerableVersions: '<2.31.0',
        severity: 'medium',
        cve: 'CVE-2023-32681',
        description: 'Information Disclosure'
    },
    'pillow': {
        vulnerableVersions: '<9.3.0',
        severity: 'high',
        cve: 'CVE-2022-45198',
        description: 'Denial of Service'
    },
    'cryptography': {
        vulnerableVersions: '<39.0.1',
        severity: 'high',
        cve: 'CVE-2023-23931',
        description: 'Memory Corruption'
    },
    'numpy': {
        vulnerableVersions: '<1.22.0',
        severity: 'medium',
        cve: 'CVE-2021-41496',
        description: 'Buffer Overflow'
    },
    'jinja2': {
        vulnerableVersions: '<3.1.2',
        severity: 'high',
        cve: 'CVE-2024-22195',
        description: 'Cross-site Scripting'
    }
};

/**
 * Severity weights for confidence scoring
 */
export const SEVERITY_WEIGHTS = {
    critical: 1.0,
    high: 0.8,
    medium: 0.5,
    low: 0.3,
    info: 0.1
};

/**
 * Tool weights for confidence aggregation
 */
export const TOOL_WEIGHTS = {
    eslint: 0.22,
    semgrep: 0.28,
    dependency: 0.18,
    eol: 0.12,
    llm: 0.20
};

/**
 * Correlation bonuses for multi-tool agreement
 */
export const CORRELATION_BONUSES = {
    twoTools: 0.15,
    threeTools: 0.25,
    llmCorroboration: 0.10
};

export default {
    ESLINT_RULES,
    SEMGREP_RULES,
    VULNERABLE_PACKAGES,
    VULNERABLE_PYTHON_PACKAGES,
    SEVERITY_WEIGHTS,
    TOOL_WEIGHTS,
    CORRELATION_BONUSES
};

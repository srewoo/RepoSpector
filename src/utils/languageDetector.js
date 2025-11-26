// Language Detection Utility
// Detects programming language from file extension, URL, or code patterns

import { SUPPORTED_LANGUAGES } from './constants.js';

export class LanguageDetector {
    constructor() {
        this.languageMap = SUPPORTED_LANGUAGES;

        // Additional patterns for detecting language from code
        this.codePatterns = {
            python: [
                /def\s+\w+\s*\(/,
                /import\s+\w+/,
                /from\s+\w+\s+import/,
                /if\s+__name__\s*==\s*['"]__main__['"]/,
                /class\s+\w+.*:/
            ],
            javascript: [
                /function\s+\w+\s*\(/,
                /const\s+\w+\s*=/,
                /let\s+\w+\s*=/,
                /var\s+\w+\s*=/,
                /=>\s*{/,
                /require\s*\(/,
                /export\s+(default|const|function)/
            ],
            typescript: [
                /interface\s+\w+/,
                /type\s+\w+\s*=/,
                /:\s*string|number|boolean/,
                /<.*>.*\(/,
                /enum\s+\w+/,
                /import.*from.*['"];/
            ],
            java: [
                /public\s+class\s+\w+/,
                /private\s+\w+\s+\w+/,
                /package\s+\w+/,
                /import\s+java\./,
                /public\s+static\s+void\s+main/
            ],
            csharp: [
                /using\s+System/,
                /namespace\s+\w+/,
                /public\s+class\s+\w+/,
                /private\s+\w+\s+\w+/,
                /\[.*Attribute\]/
            ],
            ruby: [
                /def\s+\w+/,
                /class\s+\w+\s*</,
                /require\s+['"].*['"]/,
                /end$/m,
                /@\w+\s*=/
            ],
            php: [
                /<\?php/,
                /function\s+\w+\s*\(/,
                /\$\w+\s*=/,
                /namespace\s+\w+/,
                /use\s+\w+/
            ],
            go: [
                /package\s+\w+/,
                /func\s+\w+\s*\(/,
                /import\s+\(/,
                /type\s+\w+\s+struct/,
                /:\s*=\s*/
            ]
        };

        // Framework mapping from language
        this.frameworkMap = {
            javascript: ['jest', 'mocha', 'jasmine', 'vitest'],
            typescript: ['jest', 'mocha', 'jasmine', 'vitest'],
            python: ['pytest', 'unittest', 'nose2'],
            java: ['junit', 'testng'],
            csharp: ['nunit', 'xunit', 'mstest'],
            ruby: ['rspec', 'minitest'],
            php: ['phpunit', 'codeception'],
            go: ['testing']
        };

        // Default framework per language
        this.defaultFramework = {
            javascript: 'jest',
            typescript: 'jest',
            python: 'pytest',
            java: 'junit',
            csharp: 'nunit',
            ruby: 'rspec',
            php: 'phpunit',
            go: 'testing'
        };
    }

    /**
     * Detect language from file URL
     * @param {string} url - File URL from code hosting platform
     * @returns {string|null} Detected language or null
     */
    detectFromURL(url) {
        if (!url) return null;

        try {
            // Extract file path from URL
            let filePath = '';

            // GitHub pattern: /blob/branch/path/to/file.ext
            let match = url.match(/\/blob\/[^/]+\/(.+)/);
            if (match) {
                filePath = match[1];
            }

            // GitLab pattern: /-/blob/branch/path/to/file.ext
            if (!filePath) {
                match = url.match(/\/-\/blob\/[^/]+\/(.+)/);
                if (match) {
                    filePath = match[1];
                }
            }

            // BitBucket pattern: /src/branch/path/to/file.ext
            if (!filePath) {
                match = url.match(/\/src\/[^/]+\/(.+)/);
                if (match) {
                    filePath = match[1];
                }
            }

            // Azure DevOps pattern: ?path=/path/to/file.ext
            if (!filePath) {
                match = url.match(/path=(.+?)(&|$)/);
                if (match) {
                    filePath = match[1];
                }
            }

            // Generic fallback - just get the last part of the URL
            if (!filePath) {
                filePath = url.split('/').pop();
            }

            return this.detectFromFilePath(filePath);
        } catch (error) {
            console.warn('Error detecting language from URL:', error);
            return null;
        }
    }

    /**
     * Detect language from file path
     * @param {string} filePath - File path or filename
     * @returns {string|null} Detected language or null
     */
    detectFromFilePath(filePath) {
        if (!filePath) return null;

        // Remove query parameters if present
        const cleanPath = filePath.split('?')[0].split('#')[0];

        // Get file extension
        const extension = cleanPath.match(/(\.[^.]+)$/);
        if (!extension) return null;

        const ext = extension[1].toLowerCase();

        // Find language by extension
        for (const [language, config] of Object.entries(this.languageMap)) {
            if (config.extensions.includes(ext)) {
                return language;
            }
        }

        return null;
    }

    /**
     * Detect language from code patterns
     * @param {string} code - Source code to analyze
     * @returns {string|null} Detected language or null
     */
    detectFromCode(code) {
        if (!code || typeof code !== 'string') return null;

        const scores = {};

        // Test each language's patterns
        for (const [language, patterns] of Object.entries(this.codePatterns)) {
            let score = 0;
            for (const pattern of patterns) {
                if (pattern.test(code)) {
                    score++;
                }
            }
            if (score > 0) {
                scores[language] = score;
            }
        }

        // Return language with highest score
        if (Object.keys(scores).length === 0) return null;

        return Object.entries(scores).reduce((a, b) =>
            scores[a[0]] > scores[b[0]] ? a : b
        )[0];
    }

    /**
     * Comprehensive language detection
     * @param {Object} options - Detection options
     * @param {string} options.url - File URL
     * @param {string} options.filePath - File path
     * @param {string} options.code - Source code
     * @param {string} options.platform - Code hosting platform
     * @returns {Object} Detection result with language and confidence
     */
    detect(options = {}) {
        const { url, filePath, code, platform } = options;

        let detectedLanguage = null;
        let confidence = 0;
        let method = 'unknown';

        // Try URL detection first (most reliable)
        if (url) {
            detectedLanguage = this.detectFromURL(url);
            if (detectedLanguage) {
                confidence = 95;
                method = 'url';
            }
        }

        // Try file path detection
        if (!detectedLanguage && filePath) {
            detectedLanguage = this.detectFromFilePath(filePath);
            if (detectedLanguage) {
                confidence = 90;
                method = 'filepath';
            }
        }

        // Try code pattern detection (least reliable but better than nothing)
        if (!detectedLanguage && code) {
            detectedLanguage = this.detectFromCode(code);
            if (detectedLanguage) {
                confidence = 60;
                method = 'code-patterns';
            }
        }

        // Default to JavaScript if nothing detected (most common)
        if (!detectedLanguage) {
            detectedLanguage = 'javascript';
            confidence = 30;
            method = 'default';
        }

        return {
            language: detectedLanguage,
            confidence,
            method,
            platform,
            frameworks: this.getFrameworksForLanguage(detectedLanguage),
            defaultFramework: this.getDefaultFramework(detectedLanguage)
        };
    }

    /**
     * Get supported test frameworks for a language
     * @param {string} language - Programming language
     * @returns {Array<string>} Array of supported frameworks
     */
    getFrameworksForLanguage(language) {
        return this.frameworkMap[language] || [];
    }

    /**
     * Get default test framework for a language
     * @param {string} language - Programming language
     * @returns {string} Default framework name
     */
    getDefaultFramework(language) {
        return this.defaultFramework[language] || 'jest';
    }

    /**
     * Check if a framework is supported for a language
     * @param {string} language - Programming language
     * @param {string} framework - Test framework
     * @returns {boolean} Whether the framework is supported
     */
    isFrameworkSupported(language, framework) {
        const frameworks = this.getFrameworksForLanguage(language);
        return frameworks.includes(framework);
    }

    /**
     * Get recommended framework based on code analysis
     * @param {string} language - Programming language
     * @param {string} code - Source code
     * @returns {string} Recommended framework
     */
    recommendFramework(language, code) {
        const frameworks = this.getFrameworksForLanguage(language);

        if (!frameworks || frameworks.length === 0) {
            return this.getDefaultFramework(language);
        }

        // Check code for framework-specific patterns
        if (code) {
            // Python framework detection
            if (language === 'python') {
                if (code.includes('import pytest') || code.includes('from pytest')) {
                    return 'pytest';
                }
                if (code.includes('import unittest') || code.includes('from unittest')) {
                    return 'unittest';
                }
            }

            // JavaScript/TypeScript framework detection
            if (language === 'javascript' || language === 'typescript') {
                // Check for Cypress first (more specific patterns)
                if (code.includes('cy.') ||
                    code.includes('cypress') ||
                    code.includes("from 'cypress'") ||
                    code.includes('cy.visit') ||
                    code.includes('cy.get') ||
                    code.includes('Cypress.')) {
                    return 'cypress';
                }
                if (code.includes("from 'jest'") || code.includes("require('jest')") || code.includes('jest.config')) {
                    return 'jest';
                }
                if (code.includes("from 'vitest'") || code.includes('vitest.config')) {
                    return 'vitest';
                }
                if (code.includes("from 'mocha'") || code.includes("require('mocha')")) {
                    return 'mocha';
                }
                if (code.includes('@playwright/test')) {
                    return 'playwright';
                }
            }

            // Java framework detection
            if (language === 'java') {
                if (code.includes('org.junit') || code.includes('@Test')) {
                    return 'junit';
                }
                if (code.includes('org.testng') || code.includes('@Test')) {
                    return 'testng';
                }
            }

            // C# framework detection
            if (language === 'csharp') {
                if (code.includes('NUnit.Framework') || code.includes('[Test]')) {
                    return 'nunit';
                }
                if (code.includes('Xunit') || code.includes('[Fact]')) {
                    return 'xunit';
                }
            }

            // Ruby framework detection
            if (language === 'ruby') {
                if (code.includes('RSpec') || code.includes('describe')) {
                    return 'rspec';
                }
                if (code.includes('Minitest') || code.includes('class.*< Minitest')) {
                    return 'minitest';
                }
            }
        }

        // Return default for language
        return this.getDefaultFramework(language);
    }

    /**
     * Get language-specific test file extension
     * @param {string} language - Programming language
     * @param {string} framework - Test framework
     * @returns {string} Test file extension
     */
    getTestFileExtension(language, framework) {
        const extensionMap = {
            python: { pytest: '_test.py', unittest: '_test.py', nose2: '_test.py' },
            javascript: { jest: '.test.js', mocha: '.test.js', jasmine: '.spec.js', vitest: '.test.js' },
            typescript: { jest: '.test.ts', mocha: '.test.ts', jasmine: '.spec.ts', vitest: '.test.ts' },
            java: { junit: 'Test.java', testng: 'Test.java' },
            csharp: { nunit: 'Tests.cs', xunit: 'Tests.cs', mstest: 'Tests.cs' },
            ruby: { rspec: '_spec.rb', minitest: '_test.rb' },
            php: { phpunit: 'Test.php', codeception: 'Cest.php' },
            go: { testing: '_test.go' }
        };

        return extensionMap[language]?.[framework] || '.test';
    }
}

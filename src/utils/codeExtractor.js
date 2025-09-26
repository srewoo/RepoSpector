/**
 * CodeExtractor - Utility for extracting code from web pages
 * Consolidates code extraction logic from various sources
 */

import { Sanitizer } from './sanitizer.js';

export class CodeExtractor {
    constructor() {
        this.sanitizer = new Sanitizer();
        this.customSelectors = [];
        this.loadCustomSelectors();
    }

    /**
     * Load custom selectors from Chrome storage
     */
    async loadCustomSelectors() {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage) {
                const result = await chrome.storage.sync.get('customSelectors');
                this.customSelectors = result.customSelectors || [];
            }
        } catch (error) {
            console.warn('Failed to load custom selectors:', error);
        }
    }

    /**
     * Extract code from the current page
     * @param {Object} options - Extraction options
     * @returns {Object} Extraction result
     */
    async extractCode(_options = {}) {
        try {
            // Try different extraction methods in order of preference
            let result = this.extractFromSelection();
            if (result.success) return result;

            result = this.extractFromKnownSelectors();
            if (result.success) return result;

            result = this.extractFromCustomSelectors();
            if (result.success) return result;

            result = this.extractFromContentAnalysis();
            if (result.success) return result;

            return {
                success: false,
                error: 'No code found on this page'
            };
        } catch (error) {
            return {
                success: false,
                error: `Code extraction failed: ${error.message}`
            };
        }
    }

    /**
     * Extract code from user selection
     */
    extractFromSelection() {
        try {
            const selection = window.getSelection();
            if (!selection) {
                return { success: false, reason: 'No selection API' };
            }

            const selectedText = selection.toString().trim();
            if (!selectedText || selectedText.length < 10) {
                return { success: false, reason: 'Selection too short' };
            }

            // Check if selection looks like code
            if (this.looksLikeCode(selectedText)) {
                return {
                    success: true,
                    code: this.cleanCode(selectedText),
                    source: 'selection',
                    metadata: {
                        length: selectedText.length,
                        lines: selectedText.split('\n').length
                    }
                };
            }

            return { success: false, reason: 'Selection does not look like code' };
        } catch (error) {
            return { success: false, reason: `Selection error: ${error.message}` };
        }
    }

    /**
     * Extract code from known selectors
     */
    extractFromKnownSelectors() {
        const selectors = [
            // GitHub
            '[data-testid="blob-viewer-file-content"]',
            '.blob-code-content',
            '.blob-code',
            
            // GitLab
            '.file-content',
            '.code-viewer',
            
            // Bitbucket
            '.file-source',
            '.source-view',
            
            // Diff views
            '.diffs.tab-pane.active',                  // Git diff view
            '#diffs',
            '#fileHolder',
            '[id^="diff-content-"]',                    // IDs starting with 'diff-content-'
            
            // Generic code blocks
            'pre code',
            'code pre',
            '.highlight',
            '.codehilite',
            
            // Language-specific
            '.language-javascript',
            '.language-python',
            '.language-java',
            '.language-cpp',
            '.language-c',
            '.language-go',
            '.language-rust',
            '.language-php',
            '.language-ruby',
            '.language-typescript',
            
            // Editors
            '.CodeMirror-code',
            '.monaco-editor',
            '.ace_editor',
            
            // Form elements
            'textarea[name*="code"]',
            'textarea[id*="code"]',
            'textarea[class*="code"]',
            
            // Documentation sites
            '.gatsby-highlight',
            '.prism-code',
            '.hljs'
        ];

        for (const selector of selectors) {
            try {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    let code = '';
                    
                    for (const element of elements) {
                        const text = this.extractTextFromElement(element);
                        if (text && this.looksLikeCode(text)) {
                            code += text + '\n\n';
                        }
                    }
                    
                    if (code.trim()) {
                        return {
                            success: true,
                            code: this.cleanCode(code),
                            source: selector,
                            metadata: {
                                elements: elements.length,
                                selector: selector
                            }
                        };
                    }
                }
            } catch (error) {
                // Skip invalid selectors
                continue;
            }
        }

        return { success: false, reason: 'No code found with known selectors' };
    }

    /**
     * Extract code from custom selectors
     */
    extractFromCustomSelectors() {
        if (!this.customSelectors || this.customSelectors.length === 0) {
            return { success: false, reason: 'No custom selectors configured' };
        }

        for (const selector of this.customSelectors) {
            try {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    let code = '';
                    
                    for (const element of elements) {
                        const text = this.extractTextFromElement(element);
                        if (text) {
                            code += text + '\n\n';
                        }
                    }
                    
                    if (code.trim()) {
                        return {
                            success: true,
                            code: this.cleanCode(code),
                            source: `custom:${selector}`,
                            metadata: {
                                elements: elements.length,
                                selector: selector
                            }
                        };
                    }
                }
            } catch (error) {
                // Skip invalid custom selectors
                continue;
            }
        }

        return { success: false, reason: 'No code found with custom selectors' };
    }

    /**
     * Extract code using content analysis
     */
    extractFromContentAnalysis() {
        try {
            const allElements = document.querySelectorAll('*');
            let bestMatch = null;
            let bestScore = 0;

            for (const element of allElements) {
                // Skip certain elements
                if (this.shouldSkipElement(element)) continue;

                const text = element.textContent || '';
                if (text.length < 50) continue; // Too short to be meaningful code

                const score = this.calculateCodeScore(text);
                if (score > bestScore && score > 0.3) { // Threshold for considering it code
                    bestScore = score;
                    bestMatch = {
                        element,
                        text,
                        score
                    };
                }
            }

            if (bestMatch) {
                return {
                    success: true,
                    code: this.cleanCode(bestMatch.text),
                    source: 'analysis',
                    metadata: {
                        score: bestMatch.score,
                        element: bestMatch.element.tagName.toLowerCase()
                    }
                };
            }

            return { success: false, reason: 'No code-like content found through analysis' };
        } catch (error) {
            return { success: false, reason: `Analysis error: ${error.message}` };
        }
    }

    /**
     * Extract text from an element
     */
    extractTextFromElement(element) {
        if (!element) return '';

        // Handle different element types
        if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
            return element.value || '';
        }

        // For code elements, prefer textContent over innerHTML
        return element.textContent || element.innerText || '';
    }

    /**
     * Check if text looks like code
     */
    looksLikeCode(text) {
        if (!text || typeof text !== 'string') return false;

        const codeIndicators = [
            /function\s+\w+\s*\(/,
            /class\s+\w+/,
            /\bif\s*\(/,
            /\bfor\s*\(/,
            /\bwhile\s*\(/,
            /\breturn\s+/,
            /\bimport\s+/,
            /\bexport\s+/,
            /\bconst\s+\w+\s*=/,
            /\blet\s+\w+\s*=/,
            /\bvar\s+\w+\s*=/,
            /\bdef\s+\w+\s*\(/,
            /\bpublic\s+\w+/,
            /\bprivate\s+\w+/,
            /\bprotected\s+\w+/,
            /\bstatic\s+\w+/,
            /\bstruct\s+\w+/,
            /\benum\s+\w+/,
            /\binterface\s+\w+/,
            /\bnamespace\s+\w+/,
            /\bpackage\s+\w+/,
            /\busing\s+\w+/,
            /\binclude\s*[<"]/,
            /#include\s*[<"]/,
            /\bfrom\s+\w+\s+import/,
            /\brequire\s*\(/,
            /\bmodule\.exports/,
            /\bexports\./,
            /\bconsole\./,
            /\bprint\s*\(/,
            /\bprintf\s*\(/,
            /\becho\s+/,
            /\$\w+/,
            /\{\s*\w+:\s*\w+/,
            /\[\s*\w+\s*\]/,
            /\w+\s*\(\s*\w*\s*\)\s*\{/,
            /\w+\s*=\s*\w+\s*=>/,
            /\w+\.\w+\(/,
            /\w+::\w+/,
            /\w+->\w+/,
            /\w+\[\w+\]/,
            /\w+<\w+>/,
            /\w+\s*\?\s*\w+\s*:/,
            /\w+\s*&&\s*\w+/,
            /\w+\s*\|\|\s*\w+/,
            /\w+\s*===?\s*\w+/,
            /\w+\s*!==?\s*\w+/,
            /\w+\s*[<>]=?\s*\w+/
        ];

        const lines = text.split('\n');
        let codeLines = 0;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Check for code patterns
            for (const pattern of codeIndicators) {
                if (pattern.test(trimmed)) {
                    codeLines++;
                    break;
                }
            }

            // Check for bracket patterns
            if (trimmed.includes('{') || trimmed.includes('}') || 
                trimmed.includes('[') || trimmed.includes(']') ||
                trimmed.includes('(') || trimmed.includes(')')) {
                codeLines += 0.5;
            }

            // Check for indentation patterns
            if (line.match(/^\s{2,}/)) {
                codeLines += 0.3;
            }
        }

        const totalLines = lines.filter(line => line.trim()).length;
        return totalLines > 0 && (codeLines / totalLines) > 0.3;
    }

    /**
     * Calculate a score for how code-like the text is
     */
    calculateCodeScore(text) {
        if (!text || typeof text !== 'string') return 0;

        let score = 0;
        const lines = text.split('\n');
        const totalLines = lines.filter(line => line.trim()).length;

        if (totalLines === 0) return 0;

        // Check various code indicators
        const indicators = {
            functions: /function\s+\w+|def\s+\w+|\w+\s*\(\s*\w*\s*\)\s*\{/g,
            classes: /class\s+\w+|struct\s+\w+/g,
            keywords: /\b(if|for|while|return|import|export|const|let|var|public|private|static)\b/g,
            brackets: /[{}[\]()]/g,
            operators: /[=+\-*/%<>!&|^~]/g,
            semicolons: /;/g,
            comments: /\/\/|\/\*|\*\/|#|<!--/g
        };

        for (const [type, pattern] of Object.entries(indicators)) {
            const matches = (text.match(pattern) || []).length;
            switch (type) {
                case 'functions':
                    score += matches * 0.3;
                    break;
                case 'classes':
                    score += matches * 0.25;
                    break;
                case 'keywords':
                    score += matches * 0.1;
                    break;
                case 'brackets':
                    score += matches * 0.05;
                    break;
                case 'operators':
                    score += matches * 0.02;
                    break;
                case 'semicolons':
                    score += matches * 0.05;
                    break;
                case 'comments':
                    score += matches * 0.1;
                    break;
            }
        }

        // Normalize by text length
        score = score / (text.length / 1000);

        // Check for indentation patterns
        let indentedLines = 0;
        for (const line of lines) {
            if (line.match(/^\s{2,}/)) {
                indentedLines++;
            }
        }
        score += (indentedLines / totalLines) * 0.5;

        return Math.min(score, 1.0); // Cap at 1.0
    }

    /**
     * Clean extracted code
     */
    cleanCode(code) {
        if (!code || typeof code !== 'string') return '';

        let cleaned = code;

        // Remove line numbers
        cleaned = cleaned.replace(/^\s*\d+\s+/gm, '');

        // Remove "Copy code" artifacts
        cleaned = cleaned.replace(/Copy code/gi, '');

        // Remove other common artifacts
        cleaned = cleaned.replace(/Show more/gi, '');
        cleaned = cleaned.replace(/Show less/gi, '');
        cleaned = cleaned.replace(/Expand/gi, '');
        cleaned = cleaned.replace(/Collapse/gi, '');

        // Clean up whitespace
        cleaned = cleaned.replace(/\r\n/g, '\n');
        cleaned = cleaned.replace(/\r/g, '\n');
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        cleaned = cleaned.trim();

        // Sanitize using the sanitizer
        return this.sanitizer.sanitizeJsonInput(cleaned);
    }

    /**
     * Check if element should be skipped during analysis
     */
    shouldSkipElement(element) {
        if (!element || !element.tagName) return true;

        const skipTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'TITLE', 'HEAD'];
        if (skipTags.includes(element.tagName)) return true;

        const skipClasses = ['nav', 'menu', 'header', 'footer', 'sidebar', 'ad', 'advertisement'];
        const className = element.className || '';
        for (const skipClass of skipClasses) {
            if (className.toLowerCase().includes(skipClass)) return true;
        }

        return false;
    }

    /**
     * Extract code with additional context information
     */
    async extractCodeWithContext(contextLevel = 'smart') {
        const result = await this.extractCode();
        
        if (!result.success) {
            return result;
        }

        // Add context based on the page
        const context = this.gatherPageContext(contextLevel);
        
        return {
            ...result,
            context,
            contextLevel
        };
    }

    /**
     * Gather context information about the page
     */
    gatherPageContext(level) {
        const context = {
            url: window.location.href,
            title: document.title,
            platform: this.detectPlatform(),
            language: this.detectLanguage(),
            timestamp: new Date().toISOString()
        };

        if (level === 'minimal') {
            return { url: context.url, platform: context.platform };
        }

        if (level === 'full' || level === 'smart') {
            // Add more context for full/smart levels
            context.metadata = {
                pathname: window.location.pathname,
                repository: this.extractRepositoryInfo(),
                fileInfo: this.extractFileInfo(),
                breadcrumbs: this.extractBreadcrumbs()
            };
        }

        return context;
    }

    /**
     * Detect the platform (GitHub, GitLab, etc.)
     */
    detectPlatform() {
        const hostname = window.location.hostname.toLowerCase();
        
        if (hostname.includes('github')) return 'github';
        if (hostname.includes('gitlab')) return 'gitlab';
        if (hostname.includes('bitbucket')) return 'bitbucket';
        if (hostname.includes('azure') || hostname.includes('visualstudio')) return 'azure';
        if (hostname.includes('sourceforge')) return 'sourceforge';
        if (hostname.includes('codeberg')) return 'codeberg';
        
        return 'unknown';
    }

    /**
     * Detect programming language
     */
    detectLanguage() {
        // Try to detect from URL
        const path = window.location.pathname;
        const extension = path.split('.').pop()?.toLowerCase();
        
        const extensionMap = {
            'js': 'javascript',
            'ts': 'typescript',
            'py': 'python',
            'java': 'java',
            'cpp': 'cpp',
            'c': 'c',
            'go': 'go',
            'rs': 'rust',
            'php': 'php',
            'rb': 'ruby',
            'cs': 'csharp',
            'swift': 'swift',
            'kt': 'kotlin',
            'scala': 'scala',
            'html': 'html',
            'css': 'css',
            'scss': 'scss',
            'sass': 'sass',
            'less': 'less',
            'json': 'json',
            'xml': 'xml',
            'yaml': 'yaml',
            'yml': 'yaml',
            'sql': 'sql',
            'sh': 'bash',
            'bash': 'bash',
            'zsh': 'zsh',
            'fish': 'fish'
        };

        if (extension && extensionMap[extension]) {
            return extensionMap[extension];
        }

        // Try to detect from page elements
        const languageElements = document.querySelectorAll('[class*="language-"]');
        if (languageElements.length > 0) {
            const className = languageElements[0].className;
            const match = className.match(/language-(\w+)/);
            if (match) return match[1];
        }

        return 'unknown';
    }

    /**
     * Extract repository information
     */
    extractRepositoryInfo() {
        const path = window.location.pathname;
        const parts = path.split('/').filter(p => p);
        
        if (parts.length >= 2) {
            return {
                owner: parts[0],
                name: parts[1],
                branch: parts[3] || 'main',
                path: parts.slice(4).join('/')
            };
        }
        
        return null;
    }

    /**
     * Extract file information
     */
    extractFileInfo() {
        const path = window.location.pathname;
        const filename = path.split('/').pop();
        
        if (filename && filename.includes('.')) {
            return {
                name: filename,
                extension: filename.split('.').pop(),
                path: path
            };
        }
        
        return null;
    }

    /**
     * Extract breadcrumb information
     */
    extractBreadcrumbs() {
        const breadcrumbs = [];
        
        // Try common breadcrumb selectors
        const selectors = [
            '.breadcrumb',
            '.breadcrumbs',
            '[role="navigation"] a',
            '.file-navigation a',
            '.repository-content a'
        ];
        
        for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            if (elements.length > 0) {
                for (const element of elements) {
                    const text = element.textContent?.trim();
                    const href = element.href;
                    if (text && href) {
                        breadcrumbs.push({ text, href });
                    }
                }
                break;
            }
        }
        
        return breadcrumbs;
    }
} 
// Content script for RepoSpector Chrome Extension
// Modern ES6 module-based implementation with enhanced features

import { ContextAnalyzer } from '../utils/contextAnalyzer.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { CodeChunker } from '../utils/chunking.js';
import { DiffParser } from '../utils/diffParser.js';
import { CODE_SELECTORS, SUPPORTED_LANGUAGES as _SUPPORTED_LANGUAGES } from '../utils/constants.js';
import { Sanitizer } from '../utils/sanitizer.js';

// Note: Services are now initialized as instance properties in the ContentExtractor class

class ContentExtractor {
    constructor() {
        // Initialize service instances as class properties
        this.contextAnalyzer = new ContextAnalyzer();
        this.errorHandler = new ErrorHandler();
        this.codeChunker = new CodeChunker();
        this.diffParser = new DiffParser();
        this.sanitizer = new Sanitizer();
        
        this.selectors = [...CODE_SELECTORS];
        this.isDiffPageFlag = this.detectDiffPage();
        this.loadCustomSelectors();
        
        this.isExtracting = false;
        this.lastExtractionTime = 0;
        this.extractionThrottle = 500; // ms
        
        this.setupMessageHandler();
        this.setupPageObserver();
    }

    async loadCustomSelectors() {
        try {
            const result = await chrome.storage.sync.get(['customSelectors']);
            if (result.customSelectors) {
                this.selectors = [...this.selectors, ...result.customSelectors];
            }
        } catch (error) {
            console.error('Failed to load custom selectors:', error);
        }
    }

    detectDiffPage() {
        const url = window.location.href;
        const diffIndicators = [
            '/pull/',
            '/merge_requests/',
            '/compare/',
            '/commit/',
            '/diff',
            'pull-request',
            'merge-request'
        ];
        
        return diffIndicators.some(indicator => url.includes(indicator)) ||
               document.querySelector('.diff-table, .diff-content, [data-testid="diff-view"]') !== null;
    }

    setupMessageHandler() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            this.handleMessage(message, sender, sendResponse);
            return true; // Keep message channel open
        });
    }

    setupPageObserver() {
        // Observe page changes for dynamic content
        const observer = new MutationObserver(() => {
            this.debouncePageChange();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: false
        });
    }

    debouncePageChange() {
        const now = Date.now();
        if (now - this.lastExtractionTime > this.extractionThrottle) {
            this.lastExtractionTime = now;
            this.detectPageType();
        }
    }

    async handleMessage(message, sender, sendResponse) {
        try {
            // Handle both new type-based messages and legacy action-based messages
            if (message.type) {
                switch (message.type) {
                    case 'EXTRACT_CODE':
                        await this.handleExtractCode(message, sendResponse);
                        break;
                        
                    case 'DETECT_PAGE_TYPE':
                        this.handleDetectPageType(message, sendResponse);
                        break;
                        
                    case 'EXTRACT_DIFF':
                        await this.handleExtractDiff(message, sendResponse);
                        break;
                        
                    case 'GET_PAGE_CONTEXT':
                        await this.handleGetPageContext(message, sendResponse);
                        break;
                        
                    case 'PROGRESS_UPDATE':
                        this.handleProgressUpdate(message);
                        break;
                        
                    default:
                        sendResponse({ 
                            success: false, 
                            error: `Unknown message type: ${message.type}` 
                        });
                }
            } else if (message.action) {
                // Handle legacy action-based messages for compatibility
                switch (message.action) {
                    case 'extractCode':
                        await this.handleLegacyExtractCode(message, sendResponse);
                        break;
                        
                    case 'detectCodeType':
                        this.handleDetectPageType(message, sendResponse);
                        break;
                        
                    default:
                        sendResponse({ 
                            success: false, 
                            error: `Unknown action: ${message.action}` 
                        });
                }
            } else {
                sendResponse({ 
                    success: false, 
                    error: 'Message must have either type or action property' 
                });
            }
        } catch (error) {
            this.errorHandler.logError('Content script message handler', error);
            sendResponse({ 
                success: false, 
                error: error.message 
            });
        }
    }

    async handleExtractCode(message, sendResponse) {
        if (this.isExtracting) {
            sendResponse({ 
                success: false, 
                error: 'Extraction already in progress' 
            });
            return;
        }

        this.isExtracting = true;

        try {
            const { options = {} } = message;
            
            // Detect page type first
            const pageType = this.detectPageType();
            
            let result;
            switch (pageType.type) {
                case 'diff':
                case 'pull_request':
                case 'merge_request':
                case 'commit':
                    result = await this.extractDiffPage(options);
                    break;
                    
                case 'file':
                    result = await this.extractFilePage(options);
                    break;
                    
                case 'repository':
                    result = await this.extractRepositoryPage(options);
                    break;
                    
                default:
                    result = await this.extractGenericPage(options);
            }

            // Enhance with context if needed
            if (options.contextLevel !== 'minimal') {
                result = await this.enhanceWithRepositoryContext(result, options);
            }

            sendResponse({ 
                success: true, 
                data: result 
            });

        } catch (error) {
            this.errorHandler.logError('Code extraction', error);
            sendResponse({ 
                success: false, 
                error: error.message 
            });
        } finally {
            this.isExtracting = false;
        }
    }

    async handleLegacyExtractCode(message, sendResponse) {
        try {
            // Simple extraction for legacy compatibility (like the simple version)
            const selectors = [
                '#fileHolder',                              // Specific GitHub/GitLab element
                '#read-only-cursor-text-area',              // GitHub editor
                '[data-testid="blob-viewer-file-content"]', // GitHub's code view
                '[data-testid="blob-content"]',             // GitLab code view
                '.diffs.tab-pane.active',                  // Git diff view
                '#diffs',
                'pre code',                                 // Common code block in web pages
                '[id^="diff-content-"]'                    // IDs starting with 'diff-content-'
            ];

            let codeElement = null;
            for (let selector of selectors) {
                codeElement = document.querySelector(selector);
                if (codeElement) break;
            }

            if (codeElement) {
                const rawCode = codeElement.textContent || codeElement.innerText;
                const code = this.cleanupExtractedCode(rawCode);
                sendResponse({ success: true, code });
            } else {
                console.error("No code element found.");
                sendResponse({ success: false, error: "No code element found" });
            }
        } catch (error) {
            console.error("Error extracting code:", error);
            sendResponse({ success: false, error: error.message });
        }
    }

    handleDetectPageType(message, sendResponse) {
        const pageType = this.detectPageType();
        sendResponse({ 
            success: true, 
            detection: pageType  // Use 'detection' instead of 'data' for compatibility
        });
    }

    async handleExtractDiff(message, sendResponse) {
        try {
            const { options = {} } = message;
            const diffData = await this.diffParser.extractDiffFromDOM(options);
            
            sendResponse({ 
                success: true, 
                data: diffData 
            });
        } catch (error) {
            this.errorHandler.logError('Diff extraction', error);
            sendResponse({ 
                success: false, 
                error: error.message 
            });
        }
    }

    async handleGetPageContext(message, sendResponse) {
        try {
            const context = await this.getPageContext();
            sendResponse({ 
                success: true, 
                data: context 
            });
        } catch (error) {
            this.errorHandler.logError('Page context extraction', error);
            sendResponse({ 
                success: false, 
                error: error.message 
            });
        }
    }

    handleProgressUpdate(message) {
        // Update any progress indicators on the page
        const progressIndicator = document.querySelector('#repospector-progress');
        if (progressIndicator && message.data) {
            const { processed, total, percentage } = message.data;
            progressIndicator.textContent = `Processing: ${processed}/${total} (${percentage}%)`;
        }
    }

    /**
     * Detect the type of page we're on
     */
    detectPageType() {
        const url = window.location.href;
        const platform = this.diffParser.detectPlatform(url);
        
        // Check for diff/PR/MR/commit pages
        if (this.isDiffPage(url)) {
            if (url.includes('/pull/') || url.includes('/merge_requests/')) {
                return {
                    type: url.includes('/pull/') ? 'pull_request' : 'merge_request',
                    platform,
                    url,
                    supportsDiff: true
                };
            } else if (url.includes('/commit/')) {
                return {
                    type: 'commit',
                    platform,
                    url,
                    supportsDiff: true
                };
            } else {
                return {
                    type: 'diff',
                    platform,
                    url,
                    supportsDiff: true
                };
            }
        }
        
        // Check for file pages
        if (this.isFilePage(url)) {
            return {
                type: 'file',
                platform,
                url,
                supportsDiff: false
            };
        }
        
        // Check for repository pages
        if (this.isRepositoryPage(url)) {
            return {
                type: 'repository',
                platform,
                url,
                supportsDiff: false
            };
        }
        
        return {
            type: 'unknown',
            platform,
            url,
            supportsDiff: false
        };
    }

    isDiffPage(url) {
        const diffIndicators = [
            '/pull/', '/pulls/',
            '/merge_requests/', '/merge_request/',
            '/compare/', '/commit/',
            '/diff', '/diffs',
            'pull-request', 'merge-request'
        ];
        
        return diffIndicators.some(indicator => url.includes(indicator)) ||
               document.querySelector('.diff-table, .diff-content, [data-testid="diff-view"], .file-diff-split') !== null;
    }

    isFilePage(url) {
        const fileIndicators = [
            '/blob/', '/tree/', '/src/',
            '/browse/', '/source/'
        ];
        
        return fileIndicators.some(indicator => url.includes(indicator)) ||
               document.querySelector('.blob-wrapper, .file-content, .source-view') !== null;
    }

    isRepositoryPage(url) {
        // Repository root or main pages
        const pathSegments = new URL(url).pathname.split('/').filter(Boolean);
        
        // GitHub: /owner/repo, GitLab: /owner/repo, BitBucket: /owner/repo
        if (pathSegments.length === 2) {
            return true;
        }
        
        // Repository sub-pages
        const repoIndicators = [
            '/tree/main', '/tree/master',
            '/src/main', '/src/master',
            '/-/tree/', '/-/blob/'
        ];
        
        return repoIndicators.some(indicator => url.includes(indicator));
    }

    /**
     * Extract diff page content
     */
    async extractDiffPage(options = {}) {
        try {
            // Use DiffParser to extract diff content
            const diffData = await this.diffParser.extractDiffFromDOM(options);
            
            if (!diffData || !diffData.files || diffData.files.length === 0) {
                throw new Error('No diff content found on page');
            }

            // Get relevant changes for test generation
            const relevantChanges = this.diffParser.getRelevantChanges(diffData, {
                includeContext: options.includeContext !== false,
                maxLines: options.maxLines || 1000,
                preferAdditions: options.preferAdditions !== false,
                languageFilter: options.languageFilter
            });

            // Extract additional page context
            const pageContext = await this.getPageContext();

            // Build combined code for analysis
            const combinedCode = this.buildCombinedCodeFromDiff(relevantChanges, options);

            return {
                type: 'diff',
                code: combinedCode,
                diffData,
                relevantChanges,
                context: {
                    ...pageContext,
                    isDiff: true,
                    platform: diffData.platform,
                    summary: diffData.summary
                }
            };

        } catch (error) {
            this.errorHandler.logError('Diff page extraction', error);
            throw error;
        }
    }

    /**
     * Extract single file page content
     */
    async extractFilePage(_options = {}) {
        try {
            const platform = this.diffParser.detectPlatform(window.location.href);
            
            let code;
            switch (platform) {
                case 'github':
                    code = this.extractGitHubFileContent();
                    break;
                case 'gitlab':
                    code = this.extractGitLabFileContent();
                    break;
                case 'bitbucket':
                    code = this.extractBitbucketFileContent();
                    break;
                default:
                    code = this.extractGenericFileContent();
            }

            if (!code || code.trim().length === 0) {
                throw new Error('No code content found on page');
            }

            // Sanitize the extracted code
            const sanitizedCode = this.sanitizer.sanitizeJsonInput(code);

            // Get page context
            const pageContext = await this.getPageContext();

            return {
                type: 'file',
                code: sanitizedCode,
                context: {
                    ...pageContext,
                    isDiff: false,
                    platform
                }
            };

        } catch (error) {
            this.errorHandler.logError('File page extraction', error);
            throw error;
        }
    }

    /**
     * Extract repository page content
     */
    async extractRepositoryPage(options = {}) {
        try {
            const platform = this.diffParser.detectPlatform(window.location.href);
            
            // For repository pages, we might extract multiple files or README
            const files = await this.extractRepositoryFiles(platform, options);
            
            if (!files || files.length === 0) {
                throw new Error('No extractable content found on repository page');
            }

            // Combine files into a single code block
            const combinedCode = files.map(file => 
                `// File: ${file.path}\n${file.content}`
            ).join('\n\n' + '='.repeat(50) + '\n\n');

            // Get page context
            const pageContext = await this.getPageContext();

            return {
                type: 'repository',
                code: combinedCode,
                files,
                context: {
                    ...pageContext,
                    isDiff: false,
                    platform
                }
            };

        } catch (error) {
            this.errorHandler.logError('Repository page extraction', error);
            throw error;
        }
    }

    /**
     * Extract generic page content
     */
    async extractGenericPage(_options = {}) {
        try {
            // Try the new selectors first (including the ones you requested)
            const primarySelectors = [
                '[data-testid="blob-viewer-file-content"]', // GitHub's code view
                '.diffs.tab-pane.active',                  // Git diff view
                '#diffs',
                '#fileHolder',
                'pre code',                                 // Common code block in web pages
                '[id^="diff-content-"]'                    // IDs starting with 'diff-content-'
            ];

            // Try primary selectors first
            for (const selector of primarySelectors) {
                try {
                    const elements = document.querySelectorAll(selector);
                    if (elements.length > 0) {
                        const code = Array.from(elements)
                            .map(el => el.textContent || el.innerText || '')
                            .join('\n\n');
                        
                        if (code.trim().length > 10) {
                            console.log(`Code extracted using selector: ${selector}`);
                            return {
                                type: 'generic',
                                code: this.sanitizer.sanitizeJsonInput(code),
                                context: {
                                    ...(await this.getPageContext()),
                                    isDiff: false,
                                    platform: 'generic',
                                    selector: selector
                                }
                            };
                        }
                    }
                } catch (error) {
                    console.warn(`Error with selector "${selector}":`, error);
                    continue;
                }
            }

            // Fallback to broader search
            const codeElements = document.querySelectorAll(
                'pre, code, .highlight, .code-block, .source-code, [class*="code"], [class*="source"]'
            );

            let extractedCode = '';
            
            for (const element of codeElements) {
                const text = element.textContent || element.innerText || '';
                if (text.trim().length > 10) { // Ignore very short code snippets
                    extractedCode += text + '\n\n';
                }
            }

            if (!extractedCode.trim()) {
                // Last resort: try to extract any meaningful text that looks like code
                const allElements = document.querySelectorAll('*');
                let bestCode = '';
                let bestScore = 0;

                for (const element of allElements) {
                    const text = element.textContent || '';
                    if (text.length < 50) continue;

                    // Calculate code-likeness score
                    let score = 0;
                    if (text.includes('{') && text.includes('}')) score += 2;
                    if (text.includes('function')) score += 3;
                    if (text.includes('const') || text.includes('let') || text.includes('var')) score += 2;
                    if (text.includes('import') || text.includes('export')) score += 2;
                    if (text.includes('class')) score += 2;
                    if (text.includes('=') || text.includes('=>')) score += 1;

                    if (score > bestScore && score > 3) {
                        bestScore = score;
                        bestCode = text;
                    }
                }

                if (bestCode) {
                    extractedCode = bestCode;
                } else {
                    throw new Error('No code content found on page');
                }
            }

            // Sanitize the extracted code
            const sanitizedCode = this.sanitizer.sanitizeJsonInput(extractedCode);

            // Get page context
            const pageContext = await this.getPageContext();

            return {
                type: 'generic',
                code: sanitizedCode,
                context: {
                    ...pageContext,
                    isDiff: false,
                    platform: 'generic'
                }
            };

        } catch (error) {
            this.errorHandler.logError('Generic page extraction', error);
            throw error;
        }
    }

    /**
     * Extract GitHub file content
     */
    extractGitHubFileContent() {
        console.log('Attempting to extract GitHub file content...');

        // Comprehensive GitHub selectors (most specific first)
        const selectors = [
            // Specific ID selectors
            '#fileHolder',
            '#read-only-cursor-text-area',

            // Modern GitHub file view selectors
            '[data-testid="blob-viewer-file-content"]',
            '[data-testid="blob-content"]',
            '[data-testid="blob-code-content"]',

            // Classic GitHub selectors
            '.blob-wrapper .blob-code-inner',
            '.blob-wrapper .blob-code-content',
            '.file-content .blob-code-inner',
            '.file-content .blob-code-content',
            '.highlight .blob-code-inner',
            '.highlight .blob-code-content',
            '.blob-code-inner',
            '.blob-code-content',
            'td.blob-code',
            '.js-file-line-container',

            // React-based GitHub
            '.react-code-text',
            '.react-code-lines',

            // Generic code containers
            '.highlight table td',
            '.highlight pre',
            '.file-content pre',
            '.blob-wrapper pre'
        ];

        // Try each selector in order of preference
        for (const selector of selectors) {
            try {
                const elements = document.querySelectorAll(selector);
                console.log(`Trying GitHub selector "${selector}": found ${elements.length} elements`);

                if (elements.length > 0) {
                    const content = Array.from(elements)
                        .map(el => el.textContent || el.innerText || '')
                        .join('\n');

                    if (content.trim().length > 10) { // Ensure we have meaningful content
                        console.log(`GitHub content extracted using selector: ${selector} (${content.length} chars)`);
                        // Clean up line numbers and other artifacts
                        return this.cleanupExtractedCode(content);
                    }
                }
            } catch (error) {
                console.warn(`Error with GitHub selector "${selector}":`, error);
            }
        }

        // Enhanced fallback for GitHub
        console.log('Trying GitHub fallback selectors...');
        const fallbackSelectors = [
            '.file-content',
            '.blob-content',
            '.highlight',
            'main pre',
            'main code',
            '[role="main"] pre',
            '[role="main"] code',
            'pre code',
            'pre',
            'code'
        ];

        for (const selector of fallbackSelectors) {
            try {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    const longestCode = Array.from(elements)
                        .map(el => el.textContent || el.innerText || '')
                        .filter(text => text.trim().length > 10)
                        .reduce((longest, current) =>
                            current.length > longest.length ? current : longest, '');

                    if (longestCode.trim().length > 10) {
                        console.log(`GitHub content extracted using fallback selector: ${selector} (${longestCode.length} chars)`);
                        return this.cleanupExtractedCode(longestCode);
                    }
                }
            } catch (error) {
                console.warn(`Error with GitHub fallback selector "${selector}":`, error);
            }
        }

        console.warn('No GitHub file content could be extracted');
        return '';
    }

    /**
     * Extract GitLab file content
     */
    extractGitLabFileContent() {
        console.log('Attempting to extract GitLab file content...');
        
        // Updated selectors for modern GitLab interface (2025)
        const selectors = [
            // Modern GitLab file view selectors (most specific first)
            '[data-testid="blob-content"] pre code',
            '[data-testid="blob-content"] .line',
            '[data-testid="blob-content"] pre',
            '[data-testid="blob-content"] code',
            '[data-testid="source-viewer"] pre',
            '[data-testid="source-viewer"] code',
            '[data-testid="source-viewer"] .line',
            '.blob-content pre code',
            '.blob-content .line',
            '.blob-content pre',
            '.file-content pre code',
            '.file-content .line',
            '.file-content pre',
            '.source-viewer pre',
            '.source-viewer code',
            '.source-viewer .line',
            // More specific GitLab selectors
            'div[class*="blob-viewer"] pre',
            'div[class*="blob-viewer"] code',
            'div[class*="source-code"] pre',
            'div[class*="source-code"] code',
            '.highlight pre code',
            '.highlight .line',
            '.file-holder .line',
            '.file-holder pre',
            // Fallback selectors
            '[data-testid="blob-viewer"] pre',
            '[data-testid="blob-viewer"] .line',
            '[data-testid="blob-viewer"] code',
            '[data-testid="blob-viewer-file-content"]', // GitHub's code view
            '.blob-viewer pre',
            '.blob-viewer .line',
            '.blob-viewer code',
            '.diffs.tab-pane.active',                  // Git diff view
            '#diffs',
            '#fileHolder',
            'pre code',                                 // Common code block in web pages
            '[id^="diff-content-"]',                    // IDs starting with 'diff-content-'
            // Legacy selectors
            '.code.highlight pre',
            '.code.highlight .line'
        ];

        // Try each selector in order of preference
        for (const selector of selectors) {
            try {
                const elements = document.querySelectorAll(selector);
                console.log(`Trying selector "${selector}": found ${elements.length} elements`);
                
                if (elements.length > 0) {
                    const content = Array.from(elements)
                        .map(el => el.textContent || el.innerText || '')
                        .join('\n');
                    
                    if (content.trim().length > 10) { // Ensure we have meaningful content
                        console.log(`GitLab content extracted using selector: ${selector} (${content.length} chars)`);
                        // Clean up line numbers and other artifacts
                        return this.cleanupExtractedCode(content);
                    }
                }
            } catch (error) {
                console.warn(`Error with selector "${selector}":`, error);
            }
        }

        // Enhanced fallback for GitLab with more comprehensive selectors
        const fallbackSelectors = [
            // Specific ID selectors (works on both GitLab and GitHub)
            '#fileHolder',
            '#read-only-cursor-text-area',

            // More specific fallbacks
            '.file-content',
            '.blob-content',
            'main pre',
            'main code',
            '[role="main"] pre',
            '[role="main"] code',

            // Additional code view selectors
            '[data-testid="blob-viewer-file-content"]', // GitHub's code view
            '.diffs.tab-pane.active',                  // Git diff view
            '#diffs',
            '[id^="diff-content-"]',                    // IDs starting with 'diff-content-'

            // Generic fallbacks
            'pre code',
            '.file-content pre',
            '.blob-viewer',
            '.file-holder',
            'pre',
            'code'
        ];

        console.log('Trying fallback selectors...');
        for (const selector of fallbackSelectors) {
            try {
                const elements = document.querySelectorAll(selector);
                console.log(`Trying fallback selector "${selector}": found ${elements.length} elements`);
                
                if (elements.length > 0) {
                    const longestCode = Array.from(elements)
                        .map(el => el.textContent || el.innerText || '')
                        .filter(text => text.trim().length > 10)
                        .reduce((longest, current) => 
                            current.length > longest.length ? current : longest, '');
                    
                    if (longestCode.trim().length > 10) {
                        console.log(`GitLab content extracted using fallback selector: ${selector} (${longestCode.length} chars)`);
                        return this.cleanupExtractedCode(longestCode);
                    }
                }
            } catch (error) {
                console.warn(`Error with fallback selector "${selector}":`, error);
            }
        }

        // Last resort: try to get any visible code content with improved detection
        console.log('Trying last resort method...');
        const allElements = document.querySelectorAll('*');
        let bestContent = '';
        let bestScore = 0;
        
        for (const element of allElements) {
            try {
                const text = element.textContent || element.innerText || '';
                if (text.length < 50) continue; // Skip very short content
                
                // Calculate a "code-likeness" score
                let score = 0;
                // JavaScript/C-style languages
                if (text.includes('{') || text.includes('}')) score += 2;
                if (text.includes(';')) score += 2;
                if (text.includes('function')) score += 3;
                if (text.includes('const') || text.includes('let') || text.includes('var')) score += 3;
                if (text.includes('import') || text.includes('export')) score += 3;
                if (text.includes('//') || text.includes('/*')) score += 1;
                if (text.includes('=>')) score += 1;

                // Python-specific patterns
                if (text.includes('def ')) score += 3;
                if (text.includes('class ')) score += 3;
                if (text.includes('import ') || text.includes('from ')) score += 3;
                if (text.includes('if __name__')) score += 4;
                if (text.includes(':') && text.includes('\n    ')) score += 2; // Python indentation
                if (text.includes('#')) score += 1; // Python comments

                // General programming patterns
                if (text.includes('return')) score += 2;
                if (text.includes('if') || text.includes('for') || text.includes('while')) score += 2;
                if (text.includes('=')) score += 1;
                
                // Bonus for proper indentation
                const lines = text.split('\n');
                const indentedLines = lines.filter(line => line.match(/^\s{2,}/)).length;
                if (indentedLines > lines.length * 0.3) score += 2;
                
                if (score > bestScore && text.length > bestContent.length) {
                    bestScore = score;
                    bestContent = text;
                }
            } catch (error) {
                // Skip elements that cause errors
                continue;
            }
        }

        if (bestContent.trim().length > 50 && bestScore > 5) {
            console.log(`GitLab content extracted using last resort method (score: ${bestScore}, ${bestContent.length} chars)`);
            return this.cleanupExtractedCode(bestContent);
        }

        console.warn('No GitLab file content could be extracted');
        console.log('Available elements on page:', document.querySelectorAll('*').length);
        console.log('Page URL:', window.location.href);
        console.log('Page title:', document.title);
        
        return '';
    }

    /**
     * Clean up extracted code by removing line numbers and other artifacts
     */
    cleanupExtractedCode(code) {
        if (!code) return code;

        let cleaned = code;

        // Remove line numbers at the beginning of lines (common in GitLab/GitHub)
        // Matches: "1  some code" or "123  some code"
        cleaned = cleaned.replace(/^\d+\s{2,}/gm, '');

        // Remove line numbers with tabs or multiple spaces
        cleaned = cleaned.replace(/^\d+\t/gm, '');

        // Remove copy button text or other UI elements that might be included
        cleaned = cleaned.replace(/^\s*Copy\s*$/gm, '');
        cleaned = cleaned.replace(/^\s*View\s*$/gm, '');
        cleaned = cleaned.replace(/^\s*Raw\s*$/gm, '');
        cleaned = cleaned.replace(/^\s*Blame\s*$/gm, '');

        // Remove excessive empty lines
        cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n\n');

        // Trim whitespace from start and end
        cleaned = cleaned.trim();

        return cleaned;
    }

    /**
     * Extract Bitbucket file content
     */
    extractBitbucketFileContent() {
        const selectors = [
            '.file-source .line',
            '.source-view .line',
            '.code-container .line'
        ];

        for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            if (elements.length > 0) {
                return Array.from(elements)
                    .map(el => el.textContent || el.innerText || '')
                    .join('\n');
            }
        }

        // Fallback
        const codeElements = document.querySelectorAll('pre, code');
        const longestCode = Array.from(codeElements)
            .map(el => el.textContent || el.innerText || '')
            .reduce((longest, current) => 
                current.length > longest.length ? current : longest, '');

        return longestCode;
    }

    /**
     * Extract generic file content
     */
    extractGenericFileContent() {
        console.log('Attempting to extract generic file content...');

        // Comprehensive generic selectors that should work on most code hosting platforms
        const selectors = [
            // Specific ID selectors
            '#fileHolder',
            '#read-only-cursor-text-area',

            // Common data attributes
            '[data-testid="blob-content"]',
            '[data-testid="blob-viewer-file-content"]',
            '[data-testid="source-viewer"]',

            // Common class-based selectors
            '.blob-content',
            '.file-content',
            '.source-code',
            '.highlight',
            '.code-container',

            // Generic code elements
            'pre code',
            'pre.highlight',
            'div.highlight pre',
            'pre',
            'code'
        ];

        // Try each selector in order of preference
        for (const selector of selectors) {
            try {
                const elements = document.querySelectorAll(selector);
                console.log(`Trying generic selector "${selector}": found ${elements.length} elements`);

                if (elements.length > 0) {
                    const content = Array.from(elements)
                        .map(el => el.textContent || el.innerText || '')
                        .join('\n');

                    if (content.trim().length > 10) {
                        console.log(`Generic content extracted using selector: ${selector} (${content.length} chars)`);
                        return this.cleanupExtractedCode(content);
                    }
                }
            } catch (error) {
                console.warn(`Error with generic selector "${selector}":`, error);
            }
        }

        // Last resort: get all text from elements that might contain code
        console.log('Using last resort generic extraction...');
        const allCodeElements = document.querySelectorAll('pre, code, .highlight, .source-code, .file-content, .blob-content');

        const longestCode = Array.from(allCodeElements)
            .map(el => el.textContent || el.innerText || '')
            .filter(text => text.trim().length > 10)
            .reduce((longest, current) =>
                current.length > longest.length ? current : longest, '');

        if (longestCode.trim()) {
            console.log(`Generic content extracted using last resort (${longestCode.length} chars)`);
            return this.cleanupExtractedCode(longestCode);
        }

        console.warn('No generic file content could be extracted');
        return '';
    }

    /**
     * Extract repository files
     */
    async extractRepositoryFiles(platform, options = {}) {
        const files = [];
        const maxFiles = options.maxFiles || 5;

        // Look for file tree and README
        try {
            switch (platform) {
                case 'github':
                    files.push(...await this.extractGitHubRepositoryFiles(maxFiles));
                    break;
                case 'gitlab':
                    files.push(...await this.extractGitLabRepositoryFiles(maxFiles));
                    break;
                case 'bitbucket':
                    files.push(...await this.extractBitbucketRepositoryFiles(maxFiles));
                    break;
                default:
                    files.push(...await this.extractGenericRepositoryFiles(maxFiles));
            }
        } catch (error) {
            console.warn('Failed to extract repository files:', error);
        }

        return files.slice(0, maxFiles);
    }

    async extractGitHubRepositoryFiles(_maxFiles) {
        const files = [];
        
        // Look for README
        const readmeElement = document.querySelector('#readme, .readme, [data-testid="readme"]');
        if (readmeElement) {
            const content = readmeElement.textContent || readmeElement.innerText || '';
            if (content.trim()) {
                files.push({
                    path: 'README.md',
                    content: content.trim(),
                    type: 'documentation'
                });
            }
        }

        // Look for file tree links (limited to avoid too many requests)
        const fileLinks = document.querySelectorAll('.js-navigation-item a[href*="/blob/"]');
        for (let i = 0; i < Math.min(fileLinks.length, 10 - files.length); i++) {
            const link = fileLinks[i];
            const href = link.getAttribute('href');
            const filename = link.textContent?.trim();
            
            if (href && filename && this.isCodeFile(filename)) {
                // Note: In a real implementation, we'd need to fetch these files
                // For now, we'll just record them as potential files
                files.push({
                    path: filename,
                    content: '// Content would be fetched from: ' + href,
                    type: 'code'
                });
            }
        }

        return files;
    }

    async extractGitLabRepositoryFiles(_maxFiles) {
        const files = [];
        
        // Look for README in various GitLab locations
        const readmeSelectors = [
            '.readme-holder',
            '.wiki',
            '.file-content',
            '[data-testid="readme"]',
            '.blob-viewer'
        ];
        
        for (const selector of readmeSelectors) {
            const readmeElement = document.querySelector(selector);
            if (readmeElement) {
                const content = readmeElement.textContent || readmeElement.innerText || '';
                if (content.trim().length > 100) { // Ensure meaningful README content
                    files.push({
                        path: 'README.md',
                        content: content.trim(),
                        type: 'documentation'
                    });
                    break;
                }
            }
        }
        
        // Look for file tree items with improved selectors
        const fileTreeSelectors = [
            '.tree-item-file-name a',
            '.file-row-name a',
            '.tree-item .str-truncated a',
            '[data-testid="file-tree-item"] a',
            '.tree-table tbody tr td:first-child a',
            '.js-tree-browser-file a'
        ];
        
        let fileLinks = [];
        for (const selector of fileTreeSelectors) {
            fileLinks = document.querySelectorAll(selector);
            if (fileLinks.length > 0) {
                console.log(`GitLab file tree found using selector: ${selector}`);
                break;
            }
        }
        
        // Extract file information from the tree
        if (fileLinks.length > 0) {
            for (let i = 0; i < Math.min(fileLinks.length, 10 - files.length); i++) {
                const link = fileLinks[i];
                const href = link.getAttribute('href');
                const filename = link.textContent?.trim();
                
                if (href && filename && this.isCodeFile(filename)) {
                    // Extract relative path from href
                    const pathMatch = href.match(/\/-\/blob\/[^/]+\/(.+)/);
                    const relativePath = pathMatch ? pathMatch[1] : filename;
                    
                    files.push({
                        path: relativePath,
                        content: `// File: ${relativePath}\n// GitLab URL: ${href}\n// Content would be fetched in a real implementation`,
                        type: 'code',
                        url: href
                    });
                }
            }
        }
        
        // Look for package.json or other config files specifically
        const configFileSelectors = [
            'a[href*="package.json"]',
            'a[href*="tsconfig.json"]',
            'a[href*="jest.config"]',
            'a[href*="cypress.config"]',
            'a[href*="playwright.config"]'
        ];
        
        for (const selector of configFileSelectors) {
            const configLinks = document.querySelectorAll(selector);
            for (const link of configLinks) {
                const href = link.getAttribute('href');
                const filename = link.textContent?.trim();
                
                if (href && filename && !files.some(f => f.path === filename)) {
                    files.push({
                        path: filename,
                        content: `// Configuration file: ${filename}\n// GitLab URL: ${href}`,
                        type: 'config',
                        url: href
                    });
                }
            }
        }
        
        // If we're on a specific file page, try to navigate to parent directories
        const currentUrl = window.location.href;
        if (currentUrl.includes('/-/blob/')) {
            const pathMatch = currentUrl.match(/\/-\/blob\/([^/]+)\/(.+)/);
            if (pathMatch) {
                const [, branch, filePath] = pathMatch;
                const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
                
                // Add context about the current file's directory
                files.push({
                    path: `${dirPath}/DIRECTORY_CONTEXT.md`,
                    content: `# Directory Context\n\nCurrent file: ${filePath}\nBranch: ${branch}\nDirectory: ${dirPath}\n\nThis file represents the directory context for better test generation.`,
                    type: 'context'
                });
            }
        }

        return files;
    }

    async extractBitbucketRepositoryFiles(_maxFiles) {
        // Similar to GitHub but with Bitbucket-specific selectors
        const files = [];
        
        const readmeElement = document.querySelector('.readme, .overview');
        if (readmeElement) {
            const content = readmeElement.textContent || readmeElement.innerText || '';
            if (content.trim()) {
                files.push({
                    path: 'README.md',
                    content: content.trim(),
                    type: 'documentation'
                });
            }
        }

        return files;
    }

    async extractGenericRepositoryFiles(maxFiles) {
        // Generic repository file extraction
        const files = [];
        
        const codeElements = document.querySelectorAll('pre, code, .readme, .documentation');
        for (let i = 0; i < Math.min(codeElements.length, maxFiles); i++) {
            const element = codeElements[i];
            const content = element.textContent || element.innerText || '';
            if (content.trim().length > 50) {
                files.push({
                    path: `extracted-${i + 1}.txt`,
                    content: content.trim(),
                    type: 'unknown'
                });
            }
        }

        return files;
    }

    /**
     * Check if filename indicates a code file
     */
    isCodeFile(filename) {
        const codeExtensions = [
            '.js', '.jsx', '.ts', '.tsx',
            '.py', '.java', '.cpp', '.c', '.cs',
            '.go', '.rb', '.php', '.swift', '.kt',
            '.rs', '.scala', '.clj', '.hs'
        ];
        
        return codeExtensions.some(ext => filename.toLowerCase().endsWith(ext));
    }

    /**
     * Build combined code from diff changes
     */
    buildCombinedCodeFromDiff(relevantChanges, options = {}) {
        if (!relevantChanges || relevantChanges.length === 0) {
            return '';
        }

        const groupedByFile = {};
        
        // Group changes by file
        relevantChanges.forEach(change => {
            if (!groupedByFile[change.file]) {
                groupedByFile[change.file] = {
                    added: [],
                    deleted: [],
                    context: []
                };
            }
            groupedByFile[change.file][change.type].push(change);
        });

        // Build combined code
        let combinedCode = '';
        
        Object.keys(groupedByFile).forEach(filename => {
            const fileChanges = groupedByFile[filename];
            
            combinedCode += `// File: ${filename}\n`;
            combinedCode += `// Language: ${fileChanges.added[0]?.language || fileChanges.deleted[0]?.language || 'unknown'}\n`;
            combinedCode += '// ===== CHANGES =====\n\n';
            
            if (fileChanges.added.length > 0) {
                combinedCode += '// ADDED LINES:\n';
                fileChanges.added.forEach(change => {
                    combinedCode += `// + ${change.content}\n`;
                });
                combinedCode += '\n';
            }
            
            if (fileChanges.deleted.length > 0) {
                combinedCode += '// DELETED LINES:\n';
                fileChanges.deleted.forEach(change => {
                    combinedCode += `// - ${change.content}\n`;
                });
                combinedCode += '\n';
            }
            
            if (options.includeContext && fileChanges.context.length > 0) {
                combinedCode += '// CONTEXT:\n';
                fileChanges.context.forEach(change => {
                    combinedCode += `//   ${change.content}\n`;
                });
                combinedCode += '\n';
            }
            
            combinedCode += '='.repeat(50) + '\n\n';
        });

        return combinedCode;
    }

    /**
     * Get general page context
     */
    async getPageContext() {
        const url = window.location.href;
        const platform = this.diffParser.detectPlatform(url);
        
        // Extract repository info
        const repository = this.diffParser.extractRepositoryInfo(platform);
        
        // Extract commit info
        const commit = this.diffParser.extractCommitInfo(platform);
        
        // Extract PR/MR info
        const pullRequest = this.diffParser.extractPullRequestInfo(platform);
        
        // Extract page title and description
        const title = document.title || '';
        const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
        
        return {
            url,
            platform,
            repository,
            commit,
            pullRequest,
            title,
            description: metaDescription,
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Enhance result with repository context
     */
    async enhanceWithRepositoryContext(result, options = {}) {
        try {
            if (options.contextLevel === 'minimal') {
                return result;
            }

            // Ensure we have valid context and URL before proceeding
            if (!result || !result.context) {
                console.warn('Result or result.context is missing');
                return result;
            }

            // Use current page URL if result.context.url is null/undefined
            const contextUrl = result.context.url || window.location.href;
            if (!contextUrl) {
                console.warn('No URL available for context enhancement');
                return result;
            }

            // Use ContextAnalyzer for enhanced context
            const enhancedContext = await this.contextAnalyzer.analyzeWithContext(result.code, {
                url: contextUrl,
                level: options.contextLevel || 'smart',
                platform: result.context.platform
            });

            // Merge contexts
            result.context = {
                ...result.context,
                ...enhancedContext
            };

            return result;

        } catch (error) {
            console.warn('Failed to enhance with repository context:', error);
            return result;
        }
    }

    /**
     * Extract code with context (for compatibility with existing calls)
     */
    async extractCodeWithContext(contextLevel = 'smart') {
        try {
            const pageType = this.detectPageType();
            const options = { contextLevel };

            let result;
            switch (pageType.type) {
                case 'diff':
                case 'pull_request':
                case 'merge_request':
                case 'commit':
                    result = await this.extractDiffPage(options);
                    break;
                case 'file':
                    result = await this.extractFilePage(options);
                    break;
                case 'repository':
                    result = await this.extractRepositoryPage(options);
                    break;
                default:
                    result = await this.extractGenericPage(options);
            }

            return {
                success: true,
                data: result
            };

        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
}

// Initialize the content extractor
const _extractor = new ContentExtractor();

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    console.log('RepoSpector content script loaded');
});

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ContentExtractor };
}

// Mark that content script is loaded
window.repoSpectorContentLoaded = true; 
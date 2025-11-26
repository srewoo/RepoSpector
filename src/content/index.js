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
        // Defer detectDiffPage until window is fully available
        this.isDiffPageFlag = false;
        this.loadCustomSelectors();

        this.isExtracting = false;
        this.lastExtractionTime = 0;
        this.extractionThrottle = 500; // ms

        this.setupMessageHandler();
        // Initialize diff page detection after setup
        this.initDiffPageDetection();
        this.setupPageObserver();
    }

    initDiffPageDetection() {
        // Check if window and document are available
        if (typeof window !== 'undefined' && typeof document !== 'undefined') {
            this.isDiffPageFlag = this.detectDiffPage();
        } else {
            // Retry after a short delay if not available yet
            setTimeout(() => this.initDiffPageDetection(), 100);
        }
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
        // Guard against undefined window or document
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return false;
        }

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
        // Silent initialization - reduce console spam
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            // Add a ping/pong mechanism for initialization check
            if (message.type === 'PING') {
                sendResponse({ success: true, message: 'Content script ready' });
                return false;
            }

            // Forward TEST_CHUNK messages to iframe
            if (message.action === 'TEST_CHUNK' && this.panel && this.panel.querySelector('iframe')) {
                const iframe = this.panel.querySelector('iframe');
                if (iframe && iframe.contentWindow) {
                    console.log('🔄 Forwarding TEST_CHUNK to iframe:', message.requestId);
                    iframe.contentWindow.postMessage(message, '*');
                }
            }

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

            // TRY SIMPLE EXTRACTION FIRST (like original codeExtractor.js)
            // This is more reliable than complex page type detection
            console.log('🔍 Attempting simple selector-based extraction...');
            const simpleResult = this.extractFromKnownSelectors();

            if (simpleResult.success && simpleResult.code && simpleResult.code.trim().length > 0) {
                console.log('✅ Simple extraction succeeded with:', simpleResult.source);
                const pageContext = await this.getPageContext();
                const platform = this.diffParser.detectPlatform(window.location.href);

                const result = {
                    type: 'file',
                    code: simpleResult.code,
                    context: {
                        ...pageContext,
                        isDiff: false,
                        platform,
                        extractionMethod: 'simple-selectors',
                        selector: simpleResult.source
                    }
                };

                // Debug logging
                console.log('📤 Sending extraction result to background:');
                console.log('  - Code length:', result.code?.length || 0);
                console.log('  - Code preview:', result.code?.substring(0, 100) || 'NO CODE');
                console.log('  - Platform:', platform);

                // Enhance with context if needed
                if (options.contextLevel !== 'minimal') {
                    await this.enhanceWithRepositoryContext(result, options);
                }

                sendResponse({
                    success: true,
                    data: result
                });
                return;
            } else if (simpleResult.success && (!simpleResult.code || simpleResult.code.trim().length === 0)) {
                console.warn('⚠️ Simple extraction succeeded but code is empty, falling back to complex detection');
            }

            // FALLBACK: Complex page type detection
            console.log('⚠️ Simple extraction failed, trying complex page type detection...');
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
     * Universal code extraction method
     * Works across GitHub, GitLab, and other platforms
     * Based on proven DOM selectors
     */
    extractCodeFromRepoPage() {
        // Silent extraction - only log errors
        let codeLines = [];

        // ============================================
        // NEW GITHUB (2024+)
        // Entire file is inside a hidden textarea
        // ============================================
        const ghTextarea = document.querySelector("#read-only-cursor-text-area");
        if (ghTextarea && ghTextarea.value) {
            return ghTextarea.value;   // Full file text
        }

        // ============================================
        // OLD GitHub UI (per-line DOM)
        // ============================================
        const ghNew = document.querySelectorAll("td.blob-code-inner");
        if (ghNew.length > 0) {
            ghNew.forEach(el => codeLines.push(el.innerText));
            return codeLines.join("\n");
        }

        const ghOld = document.querySelectorAll("table.js-file-line-container td.blob-code");
        if (ghOld.length > 0) {
            ghOld.forEach(el => codeLines.push(el.innerText));
            return codeLines.join("\n");
        }

        // ============================================
        // GITLAB Modern (2024+) - Multiple selectors
        // ============================================
        // Try modern GitLab code viewer first
        const glModernCode = document.querySelector('[data-testid="blob-content-holder"] code, #fileHolder code');
        if (glModernCode && glModernCode.innerText) {
            // Silent - Found GitLab modern code block:', glModernCode.innerText.length, 'chars');
            return glModernCode.innerText;
        }

        // Try line-based rendering (common in GitLab)
        const glLines = document.querySelectorAll('.line .content, .line-content, span.line');
        if (glLines.length > 0) {
            // Silent - Found GitLab line elements:', glLines.length, 'lines');
            glLines.forEach(el => {
                const text = el.innerText || el.textContent;
                if (text && !el.classList.contains('line-numbers')) {
                    codeLines.push(text);
                }
            });
            if (codeLines.length > 0) {
                return codeLines.join("\n");
            }
        }

        // Standard GitLab table cells
        const gl = document.querySelectorAll("td.line_content");
        if (gl.length > 0) {
            // Silent - Found GitLab line_content:', gl.length, 'lines');
            gl.forEach(el => codeLines.push(el.innerText));
            return codeLines.join("\n");
        }

        // ============================================
        // GITLAB fallback (<pre><code>)
        // ============================================
        // Try to find code blocks within file holders
        const fileHolder = document.querySelector('.file-holder, #fileHolder, [data-testid="blob-content-holder"]');
        if (fileHolder) {
            // Look for code blocks within the file holder
            const codeElements = fileHolder.querySelectorAll('code, pre');
            if (codeElements.length > 0) {
                // Silent - Found code in file holder:', codeElements.length, 'elements');
                let combinedCode = '';
                codeElements.forEach(el => {
                    // Skip if it's a line number element
                    if (!el.classList.contains('line-numbers') && !el.classList.contains('diff-line-num')) {
                        const text = el.innerText || el.textContent;
                        if (text && text.trim()) {
                            combinedCode += text + '\n';
                        }
                    }
                });
                if (combinedCode.trim()) {
                    return combinedCode.trim();
                }
            }
        }

        // Generic pre/code fallback
        const glPre = document.querySelectorAll("pre code, pre");
        if (glPre.length > 0) {
            // Silent - Found GitLab pre/code:', glPre.length, 'elements');
            glPre.forEach(el => codeLines.push(el.innerText));
            return codeLines.join("\n");
        }

        // ============================================
        // ADDITIONAL FALLBACKS
        // ============================================
        // Try .line class (common in modern GitLab)
        const lines = document.querySelectorAll(".line");
        if (lines.length > 0) {
            // Silent - Found .line elements:', lines.length, 'lines');
            lines.forEach(el => {
                // Skip line numbers
                const codeContent = el.querySelector('.line-content, .line-code, [class*="content"]');
                const text = codeContent ? codeContent.innerText : el.innerText;
                if (text && text.trim()) {
                    codeLines.push(text);
                }
            });
            if (codeLines.length > 0) {
                return codeLines.join("\n");
            }
        }

        // No code found with universal selectors - return empty string to trigger fallback
        return "";
    }

    /**
     * Extract using simple known selectors (from original codeExtractor.js)
     * This is more reliable than platform-specific methods
     * Uses broad, proven selectors that work across multiple platforms
     */
    extractFromKnownSelectors() {
        const selectors = [
            // IDs - highest priority
            '#fileHolder',
            '#read-only-cursor-text-area',

            // GitLab modern (2024-2025) - blob viewer
            '[data-testid="blob-content-holder"]',
            '[data-testid="blob-viewer-file-content"]',
            '.blob-viewer .file-content',
            '.gl-tab-content',

            // GitLab/GitHub specific
            '.file-content',
            '.blob-content',
            '[data-testid="blob-content"]',

            // Generic code blocks
            'pre code',
            '.highlight pre',
            '.code-viewer',
            '.source-view',

            // Common syntax highlighters
            '.hljs',
            '.codehilite',
            '.syntaxhighlighter',
        ];

        for (const selector of selectors) {
            try {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    let code = '';

                    // Special handling for container elements
                    if (selector === '#fileHolder' ||
                        selector === '.file-content' ||
                        selector === '[data-testid="blob-content-holder"]' ||
                        selector === '.gl-tab-content') {
                        // GitLab puts code inside containers
                        const container = elements[0];

                        // Try to find code blocks inside the container
                        const codeBlocks = container.querySelectorAll('pre code, code, pre, .line');

                        if (codeBlocks.length > 0) {
                            code = Array.from(codeBlocks)
                                .map(el => {
                                    // Skip line numbers
                                    if (el.classList.contains('line-numbers') ||
                                        el.classList.contains('diff-line-num')) {
                                        return '';
                                    }
                                    return el.textContent || el.innerText || '';
                                })
                                .filter(text => text.trim().length > 0)
                                .join('\n');
                        } else {
                            // Fallback: get all text from container
                            code = container.textContent || container.innerText || '';
                        }
                    } else {
                        // For other selectors, use direct text extraction
                        code = Array.from(elements)
                            .map(el => {
                                // For textarea elements, use .value
                                if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                                    return el.value || '';
                                }
                                // For other elements, use textContent or innerText
                                return el.textContent || el.innerText || '';
                            })
                            .join('\n\n');
                    }

                    if (code.trim().length > 10) {
                        console.log(`✅ Code extracted using simple selector: ${selector}`);
                        console.log(`   Raw code length: ${code.length}`);
                        const sanitizedCode = this.sanitizer.sanitizeCode(code);
                        console.log(`   Sanitized code length: ${sanitizedCode.length}`);
                        return {
                            success: true,
                            code: sanitizedCode,
                            source: selector
                        };
                    } else {
                        console.log(`⚠️  Selector ${selector} found but code too short (${code.trim().length} chars)`);
                    }
                }
            } catch (error) {
                // Skip invalid selectors
                console.warn(`Error with selector ${selector}:`, error);
                continue;
            }
        }

        return { success: false };
    }

    /**
     * Extract single file page content
     */
    async extractFilePage(_options = {}) {
        try {
            // Detect platform at the beginning so it's available throughout the function
            const platform = this.diffParser.detectPlatform(window.location.href);

            // Try universal extraction first (most reliable)
            // Attempting universal code extraction
            let code = this.extractCodeFromRepoPage();

            // If universal extraction fails, try platform-specific
            if (!code || code.trim().length === 0 || code.includes('❌')) {
                // Universal extraction failed, trying platform-specific
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
            } else {
                // Silent - Universal extraction succeeded!');
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
        console.log('🔍 Attempting to extract GitLab file content...');
        console.log('📍 Page URL:', window.location.href);
        console.log('📄 Page title:', document.title);

        // First, try to find the main code container
        const mainContainers = [
            '.file-holder',
            '.file-content',
            '.blob-viewer',
            '[data-blob-path]'
        ];

        let mainContainer = null;
        for (const selector of mainContainers) {
            const el = document.querySelector(selector);
            if (el) {
                console.log(`✅ Found main container "${selector}":`, {
                    textLength: (el.textContent || '').length,
                    children: el.children.length,
                    classes: el.className,
                    tagName: el.tagName
                });
                mainContainer = el;
                break;
            }
        }

        if (!mainContainer) {
            console.warn('⚠️ No main container found');
        }

        // Updated selectors for modern GitLab interface (2025)
        // Ordered from most specific to most generic
        const selectors = [
            // GitLab line-based rendering (most common in 2025)
            '.file-content .gl-tab-content .line',
            '.blob-viewer .line',
            '.file-holder .line',

            // Table-based rendering
            '.file-content table.code tbody tr td:not(.line-numbers):not(.diff-line-num)',
            '.blob-content table tbody tr td:last-child',

            // Direct code containers
            '.file-content .blob-viewer',
            '.file-holder .blob-viewer',
            '.file-content',
            '.blob-content',

            // Code elements within containers
            '.file-holder pre.code',
            '.blob-viewer pre',
            '.file-content pre',

            // Data attributes
            '[data-testid="blob-content"]',
            '[data-testid="source-viewer"]',
            '[data-blob-path]',

            // Generic fallbacks
            '.highlight pre',
            '.highlight code',
            'pre.code',
            '.file-holder',
            '#fileHolder'
        ];

        // Try each selector in order of preference
        for (const selector of selectors) {
            try {
                const elements = document.querySelectorAll(selector);
                console.log(`🔍 Trying selector "${selector}": found ${elements.length} elements`);

                if (elements.length > 0) {
                    let content;

                    // Special handling for .line elements (common in modern GitLab)
                    if (selector.includes('.line')) {
                        // For line elements, extract only the code content, skip line numbers
                        content = Array.from(elements)
                            .map(el => {
                                // Try to get only the code part, excluding line numbers
                                const codeContent = el.querySelector('.line-content, .line-code, [class*="content"]');
                                return codeContent ?
                                    (codeContent.textContent || codeContent.innerText || '') :
                                    (el.textContent || el.innerText || '');
                            })
                            .filter(line => line.trim().length > 0)
                            .join('\n');
                    } else {
                        // For other selectors, join all content
                        content = Array.from(elements)
                            .map(el => el.textContent || el.innerText || '')
                            .join('\n');
                    }

                    if (content.trim().length > 10) { // Ensure we have meaningful content
                        console.log(`✅ GitLab content extracted using selector: ${selector}`);
                        console.log(`📊 Content length: ${content.length} characters`);
                        console.log(`📝 First 200 chars: ${content.substring(0, 200)}...`);
                        // Clean up line numbers and other artifacts
                        return this.cleanupExtractedCode(content);
                    }
                }
            } catch (error) {
                console.warn(`❌ Error with selector "${selector}":`, error);
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

        // Remove line numbers with single space (more aggressive for GitLab)
        // Only remove if followed by typical code characters
        cleaned = cleaned.replace(/^(\d+)\s+([a-zA-Z_#@"'$])/gm, '$2');

        // Remove GitLab-specific UI elements
        cleaned = cleaned.replace(/^\s*Copy\s*$/gm, '');
        cleaned = cleaned.replace(/^\s*View\s*$/gm, '');
        cleaned = cleaned.replace(/^\s*Raw\s*$/gm, '');
        cleaned = cleaned.replace(/^\s*Blame\s*$/gm, '');
        cleaned = cleaned.replace(/^\s*Edit\s*$/gm, '');
        cleaned = cleaned.replace(/^\s*Open in Web IDE\s*$/gm, '');
        cleaned = cleaned.replace(/^\s*Download\s*$/gm, '');

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

// Export for ES6 modules (testing and future use)
export { ContentExtractor };

// Mark that content script is loaded
window.repoSpectorContentLoaded = true;

// ============================================
// Floating Panel Injection
// ============================================

class FloatingPanelManager {
    constructor() {
        this.panel = null;
        this.toggleButton = null;
        this.isVisible = false;
        this.isMaximized = false;
        this.init();
    }

    init() {
        this.createToggleButton();
        this.setupMessageListener();
    }

    createToggleButton() {
        this.toggleButton = document.createElement('button');
        this.toggleButton.id = 'repospector-toggle';
        this.toggleButton.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/>
            </svg>
            <span>RepoSpector</span>
        `;

        // Apply styles
        Object.assign(this.toggleButton.style, {
            position: 'fixed',
            top: '80px',
            right: '20px',
            padding: '12px 16px',
            background: 'linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '12px',
            color: 'white',
            fontWeight: '600',
            cursor: 'pointer',
            boxShadow: '0 8px 20px rgba(139, 92, 246, 0.4)',
            zIndex: '2147483646',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            transition: 'all 0.3s ease'
        });

        this.toggleButton.addEventListener('mouseenter', () => {
            this.toggleButton.style.transform = 'translateX(-4px)';
            this.toggleButton.style.boxShadow = '0 12px 28px rgba(139, 92, 246, 0.5)';
        });

        this.toggleButton.addEventListener('mouseleave', () => {
            this.toggleButton.style.transform = 'translateX(0)';
            this.toggleButton.style.boxShadow = '0 8px 20px rgba(139, 92, 246, 0.4)';
        });

        this.toggleButton.addEventListener('click', () => this.togglePanel());

        document.body.appendChild(this.toggleButton);
    }

    setupMessageListener() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.action === 'SHOW_PANEL') {
                this.showPanel();
                sendResponse({ success: true });
            } else if (message.action === 'HIDE_PANEL') {
                this.hidePanel();
                sendResponse({ success: true });
            } else if (message.action === 'TOGGLE_PANEL') {
                this.togglePanel();
                sendResponse({ success: true });
            }
            return true;
        });
    }

    togglePanel() {
        if (this.isVisible) {
            this.hidePanel();
        } else {
            this.showPanel();
        }
    }

    showPanel() {
        if (this.isVisible) return;

        console.log('🎨 RepoSpector: Showing floating panel');

        // Hide toggle button
        this.toggleButton.style.display = 'none';

        // Create panel container
        this.panel = document.createElement('div');
        this.panel.id = 'repospector-floating-panel';

        // Apply panel styles
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '20px',
            right: '20px',
            width: '420px',
            height: 'calc(100vh - 40px)',
            background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '16px',
            boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
            zIndex: '2147483647',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            transition: 'all 0.3s ease',
            animation: 'slideIn 0.3s ease-out'
        });

        // Add animation
        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
        `;
        document.head.appendChild(style);

        // Create header
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
            background: 'rgba(255, 255, 255, 0.02)',
            color: '#f1f5f9',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
        });

        header.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; font-weight: 600;">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2">
                    <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/>
                </svg>
                <span>RepoSpector</span>
            </div>
            <div style="display: flex; gap: 4px;">
                <button id="repospector-maximize" style="padding: 6px; background: transparent; border: none; color: rgba(241, 245, 249, 0.7); cursor: pointer; border-radius: 6px; display: flex; align-items: center;" title="Maximize">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
                    </svg>
                </button>
                <button id="repospector-close" style="padding: 6px; background: transparent; border: none; color: rgba(241, 245, 249, 0.7); cursor: pointer; border-radius: 6px; display: flex; align-items: center;" title="Close">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
        `;

        // Create iframe for popup content
        const iframe = document.createElement('iframe');
        iframe.src = chrome.runtime.getURL('src/popup/index.html');
        iframe.id = 'repospector-iframe';
        Object.assign(iframe.style, {
            width: '100%',
            height: '100%',
            border: 'none',
            flex: '1'
        });

        // Setup message bridge between iframe and content script
        window.addEventListener('message', (event) => {
            // Only accept messages from our iframe
            if (event.source !== iframe.contentWindow) return;

            const message = event.data;
            console.log('📨 Message from iframe:', message);

            // Forward to background script and send response back to iframe
            if (message.type) {
                chrome.runtime.sendMessage(message, (response) => {
                    iframe.contentWindow.postMessage({
                        responseId: message.requestId,
                        response: response
                    }, '*');
                });
            }
        });

        // Assemble panel
        this.panel.appendChild(header);
        this.panel.appendChild(iframe);
        document.body.appendChild(this.panel);

        // Setup button handlers
        const closeBtn = header.querySelector('#repospector-close');
        const maximizeBtn = header.querySelector('#repospector-maximize');

        closeBtn.addEventListener('mouseenter', () => {
            closeBtn.style.background = 'rgba(239, 68, 68, 0.2)';
            closeBtn.style.color = '#ef4444';
        });
        closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.background = 'transparent';
            closeBtn.style.color = 'rgba(241, 245, 249, 0.7)';
        });
        closeBtn.addEventListener('click', () => this.hidePanel());

        maximizeBtn.addEventListener('mouseenter', () => {
            maximizeBtn.style.background = 'rgba(255, 255, 255, 0.1)';
            maximizeBtn.style.color = '#f1f5f9';
        });
        maximizeBtn.addEventListener('mouseleave', () => {
            maximizeBtn.style.background = 'transparent';
            maximizeBtn.style.color = 'rgba(241, 245, 249, 0.7)';
        });
        maximizeBtn.addEventListener('click', () => this.toggleMaximize());

        this.isVisible = true;
    }

    toggleMaximize() {
        if (!this.panel) return;

        this.isMaximized = !this.isMaximized;

        if (this.isMaximized) {
            Object.assign(this.panel.style, {
                width: '840px',
                height: 'calc(100vh - 40px)'
            });
        } else {
            Object.assign(this.panel.style, {
                width: '420px',
                height: 'calc(100vh - 40px)'
            });
        }
    }

    hidePanel() {
        if (!this.isVisible) return;

        console.log('🎨 RepoSpector: Hiding floating panel');

        if (this.panel) {
            this.panel.remove();
            this.panel = null;
        }

        // Show toggle button
        this.toggleButton.style.display = 'flex';

        this.isVisible = false;
        this.isMaximized = false;
    }
}

// Initialize floating panel manager
const panelManager = new FloatingPanelManager(); 
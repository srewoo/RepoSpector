// Background script for RepoSpector Chrome Extension
// Modern ES6 module-based implementation

import { EncryptionService } from '../utils/encryption.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { ContextAnalyzer } from '../utils/contextAnalyzer.js';
import { BatchProcessor } from '../utils/batchProcessor.js';
import { CodeChunker } from '../utils/chunking.js';
import { TestGenerator } from '../utils/testGenerator.js';
import { CacheManager } from '../utils/cacheManager.js';
import { LanguageDetector } from '../utils/languageDetector.js';
import { PLATFORM_PATTERNS as _PLATFORM_PATTERNS, MODELS } from '../utils/constants.js';
import { RAGService } from '../services/RAGService.js';
import { GitHubService } from '../services/GitHubService.js';
import { GitLabService } from '../services/GitLabService.js';

class BackgroundService {
    constructor() {
        this.isProcessing = false;
        this.processingQueue = [];
        this.heartbeatInterval = null;
        this.activeTabs = new Map(); // Track active processing tabs

        // Initialize services
        try {
            this.errorHandler = new ErrorHandler();
            this.encryptionService = new EncryptionService();
            this.contextAnalyzer = new ContextAnalyzer();
            this.batchProcessor = new BatchProcessor();
            this.codeChunker = new CodeChunker();
            this.testGenerator = new TestGenerator();
            this.cacheManager = new CacheManager();
            this.languageDetector = new LanguageDetector();

            console.log('RepoSpector services initialized successfully');
        } catch (error) {
            console.error('Failed to initialize services:', error);
        }

        this.setupMessageHandlers();
        this.setupInstallHandler();
        this.setupHeartbeat();

        // Initialize encryption service asynchronously
        this.initializeEncryptionAsync();
    }

    /**
     * Setup heartbeat to prevent service worker timeout
     * Service workers timeout after 30 seconds of inactivity
     */
    setupHeartbeat() {
        // Clear any existing heartbeat
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }

        // Send heartbeat every 25 seconds to stay alive
        this.heartbeatInterval = setInterval(() => {
            if (this.isProcessing || this.activeTabs.size > 0) {
                console.log('💓 Heartbeat - keeping service worker alive', {
                    isProcessing: this.isProcessing,
                    activeTabs: this.activeTabs.size,
                    timestamp: new Date().toISOString()
                });

                // Send heartbeat message to active tabs
                this.activeTabs.forEach((tabData, tabId) => {
                    chrome.tabs.sendMessage(tabId, {
                        action: 'HEARTBEAT',
                        timestamp: Date.now()
                    }).catch(() => {
                        // Tab might be closed, remove from active tabs
                        this.activeTabs.delete(tabId);
                    });
                });
            }
        }, 25000); // 25 seconds

        console.log('💓 Heartbeat system initialized (25s interval)');
    }

    /**
     * Register a tab as actively processing
     */
    registerActiveTab(tabId, operation) {
        this.activeTabs.set(tabId, {
            operation,
            startTime: Date.now()
        });
        console.log(`📝 Registered active tab ${tabId} for ${operation}`);
    }

    /**
     * Unregister a tab when processing completes
     */
    unregisterActiveTab(tabId) {
        const tabData = this.activeTabs.get(tabId);
        if (tabData) {
            const duration = Date.now() - tabData.startTime;
            console.log(`✅ Unregistered tab ${tabId} after ${duration}ms`);
            this.activeTabs.delete(tabId);
        }
    }

    async initializeEncryptionAsync() {
        try {
            // Wait for encryption service to be fully initialized
            if (this.encryptionService && typeof this.encryptionService.initialize === 'function') {
                await this.encryptionService.initialize();
                this.encryptionReady = true;
                console.log('Encryption service fully initialized');
            } else {
                console.error('Encryption service not properly initialized');
                this.encryptionReady = false;
            }
        } catch (error) {
            console.error('Failed to fully initialize encryption service:', error);
            this.encryptionReady = false;
        }
    }

    async waitForEncryption() {
        if (this.encryptionReady) return;

        // Wait up to 5 seconds for encryption to initialize
        const startTime = Date.now();
        while (!this.encryptionReady && Date.now() - startTime < 5000) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (!this.encryptionReady) {
            console.warn('⚠️ Encryption service not ready after 5 seconds');
        }
    }

    setupInstallHandler() {
        chrome.runtime.onInstalled.addListener(async (details) => {
            console.log('RepoSpector installed:', details.reason);

            // MIGRATION: Convert old plain-text storage to encrypted format
            if (details.reason === 'update' || details.reason === 'install') {
                await this.migrateOldSettings();
            }

            // Load settings on install
            await this.loadSettings();

            // Initialize cache
            if (this.cacheManager && typeof this.cacheManager.initialize === 'function') {
                await this.cacheManager.initialize();
            } else {
                console.error('Cache manager not properly initialized');
            }

            // Set up context menus
            this.setupContextMenus();
        });
    }

    async migrateOldSettings() {
        try {
            console.log('Checking for old settings to migrate...');

            // Check for old plain-text keys
            const oldKeys = await chrome.storage.local.get([
                'openai_api_key',
                'github_token',
                'gitlab_token'
            ]);

            // Check if we already have new encrypted settings
            const newSettings = await chrome.storage.local.get('aiRepoSpectorSettings');

            // Only migrate if old keys exist and new settings don't have those keys
            const hasOldKeys = oldKeys.openai_api_key || oldKeys.github_token || oldKeys.gitlab_token;
            const hasNewSettings = newSettings.aiRepoSpectorSettings;

            if (hasOldKeys && !hasNewSettings) {
                console.log('Migrating old plain-text settings to encrypted format...');

                const settingsToSave = {};

                if (oldKeys.openai_api_key) {
                    console.log('Encrypting OpenAI API key...');
                    settingsToSave.apiKey = await this.encryptionService.encrypt(oldKeys.openai_api_key);
                }
                if (oldKeys.github_token) {
                    console.log('Encrypting GitHub token...');
                    settingsToSave.githubToken = await this.encryptionService.encrypt(oldKeys.github_token);
                }
                if (oldKeys.gitlab_token) {
                    console.log('Encrypting GitLab token...');
                    settingsToSave.gitlabToken = await this.encryptionService.encrypt(oldKeys.gitlab_token);
                }

                // Save encrypted settings
                await chrome.storage.local.set({ aiRepoSpectorSettings: settingsToSave });

                // Remove old plain-text keys for security
                await chrome.storage.local.remove([
                    'openai_api_key',
                    'github_token',
                    'gitlab_token'
                ]);

                console.log('✅ Migration complete! Old keys encrypted and removed.');
            } else if (hasOldKeys && hasNewSettings) {
                console.log('Old keys found but new settings already exist. Removing old keys...');
                // Just remove the old keys to clean up
                await chrome.storage.local.remove([
                    'openai_api_key',
                    'github_token',
                    'gitlab_token'
                ]);
                console.log('✅ Old plain-text keys removed for security.');
            } else {
                console.log('No migration needed.');
            }
        } catch (error) {
            console.error('Migration failed:', error);
            // Don't throw - allow extension to continue even if migration fails
        }
    }

    async loadSettings() {
        try {
            const settings = await this.getStoredSettings();
            console.log('Settings loaded:', { hasApiKey: !!settings.apiKey });
            return settings;
        } catch (error) {
            this.errorHandler.logError('Failed to load settings', error);
            throw error;
        }
    }

    setupMessageHandlers() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            this.handleMessage(message, sender, sendResponse);
            return true; // Keep the message channel open for async responses
        });
    }

    async handleMessage(message, sender, sendResponse) {
        try {
            switch (message.type) {
                case 'GENERATE_TESTS':
                    await this.handleGenerateTests(message, sendResponse);
                    break;

                case 'CHAT_WITH_CODE':
                    await this.handleChatWithCode(message, sendResponse);
                    break;

                case 'VALIDATE_API_KEY':
                    await this.handleValidateApiKey(message, sendResponse);
                    break;

                case 'SAVE_SETTINGS':
                    await this.handleSaveSettings(message, sendResponse);
                    break;

                case 'GET_SETTINGS':
                    await this.handleGetSettings(message, sendResponse);
                    break;

                case 'ANALYZE_CONTEXT':
                    await this.handleAnalyzeContext(message, sendResponse);
                    break;

                case 'PROCESS_DIFF':
                    await this.handleProcessDiff(message, sendResponse);
                    break;

                case 'GET_PROGRESS':
                    this.handleGetProgress(message, sendResponse);
                    break;

                case 'GET_TAB_ID':
                    this.handleGetTabId(message, sender, sendResponse);
                    break;

                default:
                    sendResponse({
                        success: false,
                        error: `Unknown message type: ${message.type}`
                    });
            }
        } catch (error) {
            this.errorHandler.logError('Background message handler', error);
            sendResponse({
                success: false,
                error: error.message
            });
        }
    }

    async handleGenerateTests(message, sendResponse) {
        const { tabId, options, code, context } = message.payload || message.data || {};

        try {
            // Add to processing queue if already processing
            if (this.isProcessing) {
                this.processingQueue.push({ message, sendResponse });
                sendResponse({
                    success: true,
                    queued: true,
                    message: 'Request queued, processing will begin shortly...'
                });
                return;
            }

            this.isProcessing = true;

            // Register this tab as actively processing
            if (tabId) {
                this.registerActiveTab(tabId, 'test_generation');
            }

            let extractedCode = code;
            let extractedContext = context;

            // If code is not provided, extract it from the tab
            if (!extractedCode && tabId) {
                try {
                    // Wrap extraction in timeout (10 seconds)
                    const extractWithTimeout = async () => {
                        const timeoutPromise = new Promise((_, reject) => {
                            setTimeout(() => reject(new Error('Code extraction timed out after 10 seconds')), 10000);
                        });

                        const extractionPromise = (async () => {
                            let extractionResult;
                            try {
                                extractionResult = await chrome.tabs.sendMessage(tabId, {
                                    type: 'EXTRACT_CODE',
                                    options: {
                                        contextLevel: options.contextLevel || 'smart'
                                    }
                                });
                                return extractionResult;
                            } catch (contentScriptError) {
                                throw contentScriptError;
                            }
                        })();

                        return Promise.race([extractionPromise, timeoutPromise]);
                    };

                    let extractionResult;
                    try {
                        extractionResult = await extractWithTimeout();
                    } catch (contentScriptError) {
                        // Content script not loaded, try to inject it
                        console.log('Content script not found on page, attempting dynamic injection...');

                        try {
                            // First check if we can inject scripts on this tab
                            const tab = await chrome.tabs.get(tabId);
                            if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
                                throw new Error('Cannot inject scripts on chrome:// or extension pages');
                            }

                            // Inject the content script
                            await chrome.scripting.executeScript({
                                target: { tabId: tabId },
                                files: ['assets/content.js']
                            });

                            // Wait longer for the script to fully initialize
                            await new Promise(resolve => setTimeout(resolve, 2000));

                            // Try to send message with retries (with overall timeout)
                            const retryWithTimeout = async () => {
                                const timeoutPromise = new Promise((_, reject) => {
                                    setTimeout(() => reject(new Error('Code extraction timed out after retries')), 10000);
                                });

                                const retryPromise = (async () => {
                                    let retries = 3;
                                    while (retries > 0) {
                                        try {
                                            const result = await chrome.tabs.sendMessage(tabId, {
                                                type: 'EXTRACT_CODE',
                                                options: {
                                                    contextLevel: options.contextLevel || 'smart'
                                                }
                                            });
                                            return result;
                                        } catch (retryError) {
                                            retries--;
                                            if (retries > 0) {
                                                console.log(`Retry ${3 - retries}/3 after waiting...`);
                                                await new Promise(resolve => setTimeout(resolve, 1000));
                                            } else {
                                                throw retryError;
                                            }
                                        }
                                    }
                                })();

                                return Promise.race([retryPromise, timeoutPromise]);
                            };

                            extractionResult = await retryWithTimeout();

                            console.log('Dynamic injection successful');
                        } catch (injectionError) {
                            // Fallback: try legacy extraction method
                            console.log('Dynamic injection not available, using legacy method (this is normal)...');
                            try {
                                extractionResult = await chrome.tabs.sendMessage(tabId, {
                                    action: 'extractCode'
                                });
                            } catch (legacyError) {
                                console.warn('All extraction methods failed:', legacyError);
                                throw new Error('Unable to extract code from this page. Please refresh the page and try again.');
                            }
                        }
                    }

                    if (extractionResult?.success) {
                        console.log('📥 Received extraction result from content script:');
                        console.log('  - Has data object:', !!extractionResult.data);
                        console.log('  - Has code directly:', !!extractionResult.code);

                        // Handle both new format (data.code) and legacy format (code)
                        if (extractionResult.data) {
                            extractedCode = extractionResult.data.code;
                            extractedContext = extractionResult.data.context || {};
                            console.log('  - Extracted code length (from data.code):', extractedCode?.length || 0);
                        } else if (extractionResult.code) {
                            extractedCode = extractionResult.code;
                            extractedContext = {};
                            console.log('  - Extracted code length (from code):', extractedCode?.length || 0);
                        } else {
                            console.error('❌ No code found in extraction result:', extractionResult);
                            throw new Error('No code found in extraction result');
                        }

                        if (!extractedCode || extractedCode.trim().length === 0) {
                            console.error('❌ Extracted code is empty!');
                            throw new Error('Extracted code is empty');
                        }

                        console.log('✅ Code successfully extracted, length:', extractedCode.length);
                    } else {
                        console.error('❌ Extraction failed:', extractionResult);
                        throw new Error(extractionResult?.error || 'Failed to extract code from page');
                    }
                } catch (error) {
                    throw new Error(`Code extraction failed: ${error.message}`);
                }
            }

            if (!extractedCode) {
                throw new Error('No code provided or extracted');
            }

            // Check cache first
            const cacheKey = this.cacheManager.generateKey(extractedCode, options);
            if (cacheKey) {
                const cachedResult = await this.cacheManager.get(cacheKey);
                if (cachedResult) {
                    this.isProcessing = false;
                    this.processQueue();

                    sendResponse({
                        success: true,
                        testCases: cachedResult.testCases,
                        fromCache: true,
                        cacheStats: this.cacheManager.getStats()
                    });
                    return;
                }
            }

            // Get settings for API key and model
            const settings = await this.getStoredSettings();
            console.log('🔑 Settings retrieved:', {
                hasApiKey: !!settings.apiKey,
                apiKeyLength: settings.apiKey?.length || 0,
                apiKeyPreview: settings.apiKey ? `${settings.apiKey.substring(0, 7)}...` : 'NONE'
            });

            if (!settings.apiKey) {
                console.error('❌ No API key found in settings!');
                throw new Error('OpenAI API key not configured');
            }

            // Detect programming language and framework
            console.log('🔍 Detecting programming language...');
            let languageDetection;
            try {
                languageDetection = this.languageDetector.detect({
                    url: extractedContext?.url,
                    filePath: extractedContext?.filePath,
                    code: extractedCode,
                    platform: extractedContext?.platform
                });
            } catch (detectionError) {
                console.warn('Language detection failed, using auto-detect mode:', detectionError);
                languageDetection = {
                    language: 'auto-detect',
                    confidence: 0,
                    method: 'fallback',
                    defaultFramework: 'auto-detect'
                };
            }

            console.log(`📝 Language detected: ${languageDetection.language} (confidence: ${languageDetection.confidence}%, method: ${languageDetection.method})`);
            console.log(`🧪 Recommended test framework: ${languageDetection.defaultFramework || 'auto-detect'}`);

            // Analyze context for intelligent test generation
            const enhancedContext = await this.contextAnalyzer.analyzeWithContext(extractedCode, {
                url: extractedContext?.url || 'unknown',
                level: options.contextLevel || 'smart',
                platform: extractedContext?.platform || 'unknown'
            });

            // Add language detection info to enhanced context
            enhancedContext.language = languageDetection.language;
            enhancedContext.languageDetection = languageDetection;

            // Determine test framework based on language (advisory only)
            const recommendedFramework = this.languageDetector.recommendFramework(languageDetection.language, extractedCode);
            const testFramework = options.testFramework ||
                recommendedFramework ||
                languageDetection.defaultFramework ||
                'auto-detect';

            console.log(`📋 Recommended framework: ${recommendedFramework || 'auto-detect'}`);
            console.log(`📋 Using test framework: ${testFramework}`);

            // Skip metadata generation - go straight to LLM generation
            // The enhanced test suite generation is not used for actual test output
            console.log('🚀 Starting LLM-based test generation...');
            console.log('🤖 Model:', settings.model || 'gpt-4');
            console.log('📊 API Key configured:', !!settings.apiKey);

            // Determine if chunking is needed
            const modelName = this.getModelId(settings.model);
            const estimatedTokens = this.codeChunker.estimateTokens(extractedCode);
            const maxTokens = this.codeChunker.getMaxTokensForModel(modelName);

            console.log('🔢 Estimated tokens:', estimatedTokens);
            console.log('🔢 Model max tokens:', maxTokens);

            let testResults;
            let lastError = null;
            const maxRetries = 2; // Retry up to 2 times

            // Retry loop for LLM generation
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    if (attempt > 0) {
                        console.log(`🔄 Retry attempt ${attempt}/${maxRetries}...`);
                    }

                    if (estimatedTokens > maxTokens * 0.8) { // Use chunking if > 80% of model limit
                        console.log('📦 Using chunked processing for large codebase');
                        console.log('🌐 Calling OpenAI API with chunking...');
                        testResults = await this.processWithChunking(extractedCode, options, enhancedContext, settings);
                    } else {
                        console.log('📝 Using direct processing for small/medium codebase');
                        console.log('🌐 Calling OpenAI API directly...');
                        testResults = await this.processDirect(extractedCode, options, enhancedContext, settings);
                    }

                    // If we got results, break out of retry loop
                    if (testResults && testResults.trim()) {
                        console.log('✅ LLM generation succeeded');
                        break;
                    } else {
                        throw new Error('Empty response from LLM');
                    }
                } catch (error) {
                    lastError = error;
                    console.error(`❌ LLM generation attempt ${attempt + 1} failed:`, error.message);

                    // If this was the last attempt, throw the error
                    if (attempt === maxRetries) {
                        throw new Error(`Test generation failed after ${maxRetries + 1} attempts: ${error.message}`);
                    }

                    // Wait before retrying (exponential backoff)
                    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
                }
            }

            // Safety check: if testResults is empty, throw descriptive error
            if (!testResults || testResults.trim() === '') {
                console.error('❌ OpenAI returned empty test results!');
                throw new Error('Test generation returned empty results. This may be due to: (1) Invalid API key, (2) Model/API issues, (3) Prompt too long. Check console logs for details.');
            }

            // Cache results if enabled
            if (settings.enableCache) {
                await this.cacheResults(extractedCode, options, testResults);
            }

            this.isProcessing = false;

            // Unregister active tab
            if (tabId) {
                this.unregisterActiveTab(tabId);
            }

            this.processQueue(); // Process next item in queue

            // Debug logging
            console.log('Test generation complete. Results length:', testResults?.length || 0);
            console.log('testResults preview:', testResults?.substring(0, 200) || 'EMPTY');

            const responseData = {
                success: true,
                testCases: testResults,
                context: enhancedContext,
                languageDetection,
                metadata: {
                    model: modelName,
                    chunked: estimatedTokens > maxTokens * 0.8,
                    tokensUsed: estimatedTokens,
                    language: languageDetection.language,
                    framework: testFramework,
                    languageConfidence: languageDetection.confidence
                }
            };

            console.log('Sending response with testCases:', testResults ? 'YES' : 'NO');
            sendResponse(responseData);

        } catch (error) {
            this.isProcessing = false;

            // Unregister active tab on error
            if (tabId) {
                this.unregisterActiveTab(tabId);
            }

            this.processQueue();

            this.errorHandler.logError('Test generation', error);
            sendResponse({
                success: false,
                error: error.message,
                retry: this.errorHandler.shouldRetry(error)
            });
        }
    }

    async handleChatWithCode(message, sendResponse) {
        const { tabId, question, conversationHistory } = message.payload || message.data || {};

        try {
            console.log('💬 Starting code chat session...');
            console.log('📝 User question:', question);
            console.log('📚 Conversation history:', conversationHistory ? `${conversationHistory.length} messages` : 'None');

            // Register active tab
            if (tabId) {
                this.registerActiveTab(tabId, 'code_chat');
            }

            // Extract code from the current page
            let extractedCode = null;
            let extractedContext = null;

            if (!tabId) {
                throw new Error('No tab ID provided');
            }

            console.log('🔍 Starting code extraction for tab', tabId);

            try {
                // Try with type: 'EXTRACT_CODE' first (new format)
                let extractionResult = await chrome.tabs.sendMessage(tabId, {
                    type: 'EXTRACT_CODE',
                    options: {
                        contextLevel: 'minimal'
                    }
                });

                console.log('📥 Received extraction result from content script:', {
                    success: extractionResult?.success,
                    hasDataObject: !!extractionResult?.data,
                    hasCodeDirectly: !!extractionResult?.code
                });

                // Fallback to action: 'EXTRACT_CODE' (legacy format)
                if (!extractionResult || !extractionResult.success) {
                    console.log('🔄 Trying legacy extraction format...');
                    extractionResult = await chrome.tabs.sendMessage(tabId, {
                        action: 'EXTRACT_CODE'
                    });
                }

                if (extractionResult && extractionResult.success) {
                    if (extractionResult.data) {
                        extractedCode = extractionResult.data.code;
                        extractedContext = extractionResult.data.context;
                        console.log('✅ Code successfully extracted, length:', extractedCode?.length || 0);
                    } else if (extractionResult.code) {
                        extractedCode = extractionResult.code;
                        extractedContext = extractionResult.context;
                        console.log('✅ Code successfully extracted (direct), length:', extractedCode?.length || 0);
                    }
                }
            } catch (error) {
                console.error('❌ Code extraction failed:', error);
                throw new Error('Could not extract code from the page. Please make sure you are on a GitHub or GitLab code file and try refreshing the page.');
            }

            if (!extractedCode || extractedCode.trim().length === 0) {
                throw new Error('No code found on this page. Please navigate to a code file on GitHub or GitLab.');
            }

            // Get settings
            const settings = await this.getStoredSettings();
            if (!settings.apiKey) {
                throw new Error('OpenAI API key not configured. Please add your API key in settings.');
            }

            // Detect language
            const languageDetection = this.languageDetector.detect({
                url: extractedContext?.url,
                filePath: extractedContext?.filePath,
                code: extractedCode,
                platform: extractedContext?.platform
            });

            console.log('🔍 Detected language:', languageDetection.language);

            // Build messages array for OpenAI (including conversation history)
            const messages = this.buildChatMessages(extractedCode, question, languageDetection, extractedContext, conversationHistory);

            console.log('📤 Sending chat request to OpenAI...');
            console.log('Messages count:', messages.length);
            console.log('Has conversation history:', conversationHistory && conversationHistory.length > 0);

            // Call OpenAI with streaming
            const result = await this.callOpenAI({
                model: this.getModelId(settings.model),
                messages: messages,
                temperature: 0.3,
                max_tokens: 2000
            }, settings.apiKey, {
                streaming: true,
                tabId: tabId
            });

            console.log('📥 Received response from OpenAI');

            // Unregister active tab
            if (tabId) {
                this.unregisterActiveTab(tabId);
            }

            sendResponse({
                success: true,
                response: result,
                languageDetection,
                metadata: {
                    language: languageDetection.language,
                    codeLength: extractedCode.length
                }
            });

        } catch (error) {
            // Unregister active tab on error
            if (tabId) {
                this.unregisterActiveTab(tabId);
            }

            this.errorHandler.logError('Code chat', error);
            sendResponse({
                success: false,
                error: error.message
            });
        }
    }

    /**
     * Build messages array for chat (with conversation history support)
     * @param {string} code - The code being discussed
     * @param {string} question - Current user question
     * @param {object} languageDetection - Language detection info
     * @param {object} context - Page context
     * @param {array} conversationHistory - Previous conversation messages
     * @returns {array} - Array of messages for OpenAI API
     */
    buildChatMessages(code, question, languageDetection, context, conversationHistory = []) {
        const language = languageDetection.language || 'unknown';
        const messages = [];

        // Add system message with code context
        messages.push({
            role: 'system',
            content: `You are an expert code assistant helping a developer understand and work with code. You are discussing the following ${language} code:

**Code:**
\`\`\`${language}
${code}
\`\`\`

**Context:**
- File: ${context?.filePath || 'unknown'}
- Language: ${language}
- Platform: ${context?.platform || 'unknown'}

Please provide clear, concise, and helpful responses. When answering:
- For **explanations**: Explain what the code does, its purpose, and how it works
- For **issues**: Identify bugs, security vulnerabilities, code smells, or potential problems
- For **improvements**: Suggest better patterns, optimizations, or refactoring opportunities
- For **specific questions**: Answer directly based on the code

Format responses in a developer-friendly way with code examples where appropriate.`
        });

        // Add conversation history if available
        if (conversationHistory && conversationHistory.length > 0) {
            console.log(`📝 Adding ${conversationHistory.length} messages from conversation history`);

            // Filter and add conversation messages (skip system messages and the initial welcome)
            conversationHistory.forEach(msg => {
                // Skip system messages, error messages, and the initial welcome message
                if (msg.role === 'system' || msg.type === 'error' || msg.id === 1) {
                    return;
                }

                // Add user and assistant messages
                if (msg.role === 'user' || msg.role === 'assistant') {
                    messages.push({
                        role: msg.role,
                        content: msg.content
                    });
                }
            });
        }

        // Add current question
        messages.push({
            role: 'user',
            content: question
        });

        return messages;
    }

    /**
     * Legacy method - kept for backward compatibility
     * Use buildChatMessages instead for new code
     */
    buildChatPrompt(code, question, languageDetection, context) {
        const language = languageDetection.language || 'unknown';

        return `You are an expert code assistant. A developer is asking about the following ${language} code:

**Code:**
\`\`\`${language}
${code}
\`\`\`

**Developer's Question:**
${question}

**Context:**
- File: ${context?.filePath || 'unknown'}
- Language: ${language}
- Platform: ${context?.platform || 'unknown'}

Please provide a clear, concise, and helpful response. If the question is about:
- **Explanation**: Explain what the code does, its purpose, and how it works
- **Issues**: Identify bugs, security vulnerabilities, code smells, or potential problems
- **Improvements**: Suggest better patterns, optimizations, or refactoring opportunities
- **Specific questions**: Answer directly based on the code

Format your response in a developer-friendly way with code examples where appropriate.`;
    }

    async processWithChunking(code, options, context, settings) {
        const chunks = this.codeChunker.createSemanticChunks(code, this.getModelId(settings.model));

        if (chunks.length === 1) {
            return await this.processDirect(code, options, context, settings);
        }

        console.log(`Processing ${chunks.length} chunks in parallel`);

        // Prepare chunks with context
        const chunksWithContext = this.codeChunker.prepareChunksWithContext(chunks, context);

        // Create batches for parallel processing
        const batches = this.codeChunker.createBatches(chunksWithContext, this.batchProcessor.maxConcurrent);

        // Process batches
        const results = await this.batchProcessor.processBatches(
            batches,
            (chunk) => this.generateTestsForChunk(chunk, options, settings),
            (progress) => {
                // Send progress updates to popup
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (chrome.runtime.lastError) {
                        console.warn('Failed to query tabs:', chrome.runtime.lastError);
                        return;
                    }

                    if (tabs && tabs.length > 0 && tabs[0]) {
                        chrome.tabs.sendMessage(tabs[0].id, {
                            type: 'PROGRESS_UPDATE',
                            data: progress
                        }).catch(() => { }); // Ignore if popup is closed
                    }
                });
            }
        );

        // Merge results intelligently
        return this.batchProcessor.mergeResults(results, 'intelligent');
    }

    async processDirect(code, options, context, settings) {
        const prompt = this.buildTestGenerationPrompt(code, options, context);

        console.log('📤 Sending prompt to OpenAI...');
        console.log('Prompt length:', prompt.length);
        console.log('Model:', this.getModelId(settings.model));

        // Enable streaming for better responsiveness
        const result = await this.callOpenAI({
            model: this.getModelId(settings.model),
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: 4000
        }, settings.apiKey, {
            streaming: true,
            tabId: options.tabId,
            requestId: options.requestId
        });

        console.log('📥 Received result from OpenAI');
        console.log('Result type:', typeof result);
        console.log('Result length:', result?.length || 0);

        return result;
    }

    async generateTestsForChunk(chunk, options, settings) {
        const prompt = this.buildTestGenerationPrompt(chunk.content, options, chunk.context);

        // Enable streaming for chunk processing too
        return await this.callOpenAI({
            model: this.getModelId(settings.model),
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: 2000
        }, settings.apiKey, {
            streaming: true,
            tabId: options.tabId,
            requestId: options.requestId
        });
    }

    buildTestGenerationPrompt(code, options, context) {
        const isDescriptionsOnly = options.testMode === 'descriptions';
        const testType = options.testType || 'unit';

        // Handle "All Types" by generating comprehensive test suites
        const isAllTypes = testType === 'all' || testType === 'All Types';

        let prompt;

        if (isAllTypes) {
            prompt = `You are an expert test engineer. Generate a COMPREHENSIVE test suite covering ALL test types for the following code.

**IMPORTANT**: Generate separate test suites for each applicable test type:
1. **Unit Tests** - Test individual functions/methods in isolation
2. **Integration Tests** - Test component interactions and data flow
3. **API Tests** - Test API endpoints, request/response handling (if applicable)
4. **End-to-End Tests** - Test complete user workflows (if applicable)

**Context Information:**
- Language: ${context.language || 'Auto-detected'}
- File: ${context.filePath || 'unknown'}
- Testing Framework: ${options.testFramework && options.testFramework !== 'auto-detect' ? options.testFramework : (context.testingFramework && context.testingFramework !== 'auto-detect' ? context.testingFramework : 'Automatically select the most appropriate framework')}
- Context Level: ${options.contextLevel || 'smart'}

**CRITICAL INSTRUCTIONS:**
1. First, analyze the code to identify the programming language
2. Automatically select the most appropriate testing framework for that language
3. If the code already contains test patterns (e.g., cy.visit, describe(), it(), @Test, def test_, etc.), follow the EXACT same style and framework
4. Generate complete, runnable test code - DO NOT return empty results
5. Use proper imports/requires for the testing framework
`;
        } else {
            prompt = `You are an expert test engineer. Generate comprehensive ${testType} tests for the following code.

**Context Information:**
- Language: ${context.language || 'Auto-detected'}
- File: ${context.filePath || 'unknown'}
- Testing Framework: ${options.testFramework && options.testFramework !== 'auto-detect' ? options.testFramework : (context.testingFramework && context.testingFramework !== 'auto-detect' ? context.testingFramework : 'Automatically select the most appropriate framework')}
- Context Level: ${options.contextLevel || 'smart'}

**CRITICAL INSTRUCTIONS:**
1. First, analyze the code to identify the programming language
2. Automatically select the most appropriate testing framework for that language
3. If the code already contains test patterns (e.g., cy.visit, describe(), it(), @Test, def test_, etc.), follow the EXACT same style and framework
4. Generate complete, runnable test code - DO NOT return empty results
5. Use proper imports/requires for the testing framework
`;
        }

        if (context.dependencies && context.dependencies.length > 0) {
            prompt += `\n**Dependencies:**\n${context.dependencies.map(dep => `- ${dep.name}: ${dep.summary}`).join('\n')}`;
        }

        if (context.projectPatterns) {
            prompt += `\n**Project Patterns:**\n${JSON.stringify(context.projectPatterns, null, 2)}`;
        }

        // Add context verification information for transparency
        if (context.fullContextVerification) {
            prompt += `\n**FULL CONTEXT VERIFICATION:**\n`;
            prompt += `- Method: ${context.fullContextVerification.method}\n`;
            prompt += `- Timestamp: ${context.fullContextVerification.timestamp}\n`;

            if (context.fullContextVerification.repositoryFilesCount) {
                prompt += `- Repository Files Analyzed: ${context.fullContextVerification.repositoryFilesCount}\n`;
                prompt += `- Config Files: ${context.fullContextVerification.configFilesAnalyzed?.join(', ') || 'None'}\n`;
                prompt += `- Test Files: ${context.fullContextVerification.testFilesAnalyzed?.join(', ') || 'None'}\n`;
                prompt += `- Dependencies: ${context.fullContextVerification.dependenciesCount?.production || 0} production, ${context.fullContextVerification.dependenciesCount?.development || 0} dev\n`;
            }

            if (context.fullContextVerification.testingFramework) {
                prompt += `- Testing Framework: ${context.fullContextVerification.testingFramework}\n`;
            }

            prompt += `- Repository Info Available: ${context.fullContextVerification.repositoryInfo ? 'Yes' : 'No'}\n`;
            prompt += `- Test Patterns Extracted: ${context.fullContextVerification.hasTestPatterns ? 'Yes' : 'No'}\n`;
        }


        prompt += `\n**Code to Test:**\n\`\`\`${context.language || 'javascript'}\n${code}\n\`\`\`\n\n`;

        // Add user-specific instructions if provided
        if (options.userPrompt) {
            prompt += `\n**User Instructions:**\n${options.userPrompt}\n\n`;
        }


        if (isAllTypes) {
            if (isDescriptionsOnly) {
                prompt += this.buildAllTypesDescriptionsPrompt();
            } else {
                prompt += this.buildAllTypesImplementationPrompt(options);
            }
        } else {
            if (isDescriptionsOnly) {
                prompt += this.buildSingleTypeDescriptionsPrompt();
            } else {
                prompt += this.buildSingleTypeImplementationPrompt();
            }
        }

        return prompt;
    }

    buildAllTypesDescriptionsPrompt() {
        return `
**RESPONSE FORMAT:**
Provide ONLY test descriptions and scenarios for ALL applicable test types. Organize as follows:

# Comprehensive Test Suite

## 1. Unit Tests
### Setup Requirements:
- [List unit test setup needs]
- [Mock specifications for dependencies]

### Test Cases:
#### Positive Tests:
1. **Test Name**: Description of what this validates
   - **Input**: Expected parameters
   - **Expected Outcome**: What should happen
   - **Assertions**: Key validations

#### Negative Tests:
[Error cases and edge conditions]

#### Edge Cases:
[Boundary conditions and special scenarios]

## 2. Integration Tests
### Setup Requirements:
- [Integration test environment setup]
- [Database/service dependencies]

### Test Cases:
#### Component Integration:
1. **Test Name**: How components work together
   - **Setup**: Required test environment
   - **Scenario**: Integration workflow
   - **Verification**: End-to-end validation

#### Data Flow Tests:
[Tests for data passing between components]

## 3. API Tests (if applicable)
### Setup Requirements:
- [API test environment]
- [Authentication/authorization setup]

### Test Cases:
#### Endpoint Tests:
1. **Test Name**: API endpoint validation
   - **Request**: HTTP method, headers, body
   - **Expected Response**: Status, headers, body structure
   - **Validation**: Response schema and business logic

#### Error Handling:
[Invalid requests, server errors, timeouts]

## 4. End-to-End Tests (if applicable)
### Setup Requirements:
- [Browser/environment setup]
- [Test data preparation]

### Test Cases:
#### User Workflows:
1. **Test Name**: Complete user journey
   - **Steps**: User actions sequence
   - **Expected Behavior**: UI responses and state changes
   - **Verification**: Final state validation

Do NOT include actual test code implementation.`;
    }

    buildAllTypesImplementationPrompt(options) {
        return `
**RESPONSE FORMAT:**
Provide complete, runnable test code for ALL applicable test types using the appropriate testing framework for the detected language.

**IMPORTANT INSTRUCTIONS:**
1. Analyze the provided code to determine:
   - The programming language
   - The most appropriate testing framework for that language
   - If existing tests are present, follow the exact same style and framework
2. Generate idiomatic test code following the language's best practices
3. Use the standard testing conventions for that language/framework
4. Structure tests logically with setup, teardown, positive cases, negative cases, and edge cases
5. Include appropriate imports/requires for the testing framework
6. Ensure tests are complete, runnable, and production-ready

**Test Types to Generate (where applicable):**
1. **Unit Tests** - Test individual functions/methods in isolation
2. **Integration Tests** - Test component interactions and data flow
3. **API Tests** - Test API endpoints (if the code contains API/HTTP handlers)
4. **End-to-End Tests** - Test complete workflows (if applicable)

**Guidelines:**
- Use the appropriate testing framework for the language (e.g., Jest/Mocha/Vitest for JavaScript, pytest for Python, JUnit for Java, NUnit for C#, RSpec for Ruby, etc.)
- Include proper setup and teardown for each test type
- Add descriptive test names and helpful comments
- Mock external dependencies appropriately
- Include positive tests, negative tests (error handling), and edge cases
- Ensure tests are independent and can run in any order
- Add appropriate assertions following the framework's conventions
- If the code is already a test file, generate additional complementary tests or improved test coverage

**Output Format:**
Return the complete test code with proper syntax for the detected language, ready to be saved and executed.`;
    }

    buildSingleTypeDescriptionsPrompt() {
        return `
**IMPORTANT**: Provide ONLY test descriptions and scenarios, NOT full implementation
Format as a structured list of test cases with descriptions
Include setup requirements and mock specifications

**Response Format:**
Return a structured list of test descriptions in the following format:

## Test Suite: [Function/Class Name]

### Setup Requirements:
- [List any setup needed]
- [Mock specifications]

### Test Cases:

#### Positive Tests:
1. **Test Name**: Description of what this test validates
   - **Input**: Expected input parameters
   - **Expected Outcome**: What should happen
   - **Assertions**: Key validations to check

2. **Test Name**: [Next test description]
   - **Input**: [Input details]
   - **Expected Outcome**: [Expected result]
   - **Assertions**: [What to verify]

#### Negative Tests:
[Similar format for error cases]

#### Edge Cases:
[Similar format for boundary conditions]

Do NOT include actual test code implementation.`;
    }

    buildSingleTypeImplementationPrompt() {
        return `
**IMPORTANT INSTRUCTIONS:**
1. Analyze the provided code to determine:
   - The programming language
   - The most appropriate testing framework for that language
   - If existing tests are present, follow the exact same style and framework
2. Generate complete, runnable test code using the appropriate testing framework
3. Follow the language's testing best practices and conventions
4. If the code is already a test file, generate additional complementary tests

**Guidelines:**
- Use the appropriate testing framework for the detected language (e.g., Jest/Mocha/Vitest/Cypress for JavaScript, pytest for Python, JUnit for Java, NUnit for C#, RSpec for Ruby, etc.)
- Include proper setup and teardown when needed
- Add descriptive test names and helpful comments
- Mock external dependencies appropriately
- Include positive tests, negative tests (error handling), and edge cases
- Include appropriate imports/requires for the testing framework
- Ensure tests are independent and can run in any order

**Response Format:**
Return only the complete test code with proper syntax for the detected language, ready to be saved and executed.`;
    }

    /**
     * Get the correct model ID for API calls
     * Extracts modelId from MODELS config if available, otherwise returns the model as-is
     */
    getModelId(modelIdentifier) {
        if (!modelIdentifier) return 'gpt-4o-mini'; // default fallback

        // If it's already a plain model name (no provider prefix), return as-is
        if (!modelIdentifier.includes(':')) {
            return modelIdentifier;
        }

        // Look up in MODELS config to get the correct modelId
        const modelConfig = MODELS[modelIdentifier];
        if (modelConfig && modelConfig.modelId) {
            return modelConfig.modelId;
        }

        // Fallback: extract the part after the colon
        const parts = modelIdentifier.split(':');
        return parts.length > 1 ? parts[1] : modelIdentifier;
    }

    async callOpenAI(requestData, apiKey, options = {}) {
        try {
            const { streaming = false, onChunk = null, tabId = null } = options;

            console.log('🔑 API Key present:', !!apiKey);
            console.log('📋 Request model:', requestData.model);
            console.log('📏 Request size:', JSON.stringify(requestData).length, 'bytes');
            console.log('🌊 Streaming mode:', streaming);
            console.log('🔍 API Key preview:', apiKey ? apiKey.substring(0, 20) + '...' : 'NONE');

            // Add stream parameter if streaming is enabled
            const requestBody = {
                ...requestData,
                stream: streaming
            };

            console.log('📡 Making fetch request to OpenAI API...');
            console.log('🤖 Model:', requestBody.model);
            console.log('🌊 Streaming enabled:', streaming);
            console.log('💬 Prompt size:', requestData.messages[0]?.content?.length || 0, 'characters');
            console.log('🔒 Request headers:', {
                'Content-Type': 'application/json',
                'Authorization': apiKey ? `Bearer ${apiKey.substring(0, 20)}...` : 'MISSING'
            });

            // Test if we can access OpenAI at all
            try {
                console.log('🧪 Testing basic connectivity to OpenAI...');
                const testResponse = await fetch('https://api.openai.com/v1/models', {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`
                    }
                });
                console.log('✅ Basic connectivity test:', testResponse.ok ? 'SUCCESS' : 'FAILED', testResponse.status);
            } catch (testError) {
                console.error('❌ Basic connectivity test failed:', testError.message);
                throw new Error(`Cannot connect to OpenAI API. Check if extension has permission for api.openai.com. Original error: ${testError.message}`);
            }

            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(requestBody)
            });

            console.log('📡 Response status:', response.status, response.statusText);

            if (!response.ok) {
                const errorText = await response.text();
                console.error('❌ API Error Response:', errorText);
                let error;
                try {
                    error = JSON.parse(errorText);
                } catch (e) {
                    throw new Error(`API request failed: ${response.status} - ${errorText}`);
                }
                throw new Error(error.error?.message || `API request failed: ${response.status}`);
            }

            // Handle streaming response
            if (streaming) {
                return await this.handleStreamingResponse(response, onChunk, tabId, options);
            }

            // Handle regular (non-streaming) response
            const data = await response.json();
            console.log('📦 Response data keys:', Object.keys(data));

            if (!data.choices || data.choices.length === 0) {
                console.error('❌ No choices in response:', data);
                throw new Error('No response choices received from API');
            }

            if (!data.choices[0]?.message?.content) {
                console.error('❌ No content in response:', data.choices[0]);
                throw new Error('Invalid response format from API');
            }

            const content = data.choices[0].message.content;

            // Log for debugging
            console.log('✅ OpenAI Response Length:', content?.length || 0);
            if (!content || content.trim() === '') {
                console.warn('⚠️ OpenAI returned empty content');
                console.warn('Full response:', JSON.stringify(data, null, 2));
            } else {
                console.log('✅ Content preview:', content.substring(0, 100) + '...');
            }

            return content;
        } catch (error) {
            console.error('❌ callOpenAI error:', error);
            console.error('❌ Error type:', error.constructor.name);
            console.error('❌ Error message:', error.message);
            console.error('❌ Error stack:', error.stack);

            // Check if it's a network error
            if (error instanceof TypeError && error.message === 'Failed to fetch') {
                console.error('🚫 Network error - possible causes:');
                console.error('   1. Host permission not granted (check chrome://extensions)');
                console.error('   2. CORS issue (OpenAI should allow this)');
                console.error('   3. Network connectivity issue');
                console.error('   4. Invalid API key format');
                console.error('💡 Try: Remove and re-add extension to grant permissions');
            }

            throw error;
        }
    }

    /**
     * Handle streaming response from OpenAI API
     * Sends chunks in real-time to popup for progressive display
     */
    async handleStreamingResponse(response, onChunk, tabId, options = {}) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        let chunkCount = 0;
        const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB max buffer
        const requestId = options.requestId;

        console.log('🌊 Starting to process streaming response...');

        try {
            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    console.log(`✅ Stream complete - received ${chunkCount} chunks, total length: ${fullContent.length}`);

                    // Send final chunk with isLastChunk flag to signal completion
                    if (tabId) {
                        chrome.runtime.sendMessage({
                            action: 'TEST_CHUNK',
                            requestId: requestId || `stream_${tabId}_${Date.now()}`,
                            tabId: tabId,
                            data: {
                                chunk: '',
                                fullContent: fullContent,
                                progress: chunkCount,
                                isLastChunk: true  // Flag to signal stream completion
                            }
                        }, (response) => {
                            if (chrome.runtime.lastError) {
                                console.debug('Could not send final chunk to popup:', chrome.runtime.lastError.message);
                            }
                        });
                    }

                    break;
                }

                // Decode the chunk
                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter(line => line.trim() !== '');

                for (const line of lines) {
                    // Remove 'data: ' prefix
                    if (line.startsWith('data: ')) {
                        const data = line.substring(6);

                        // Check for stream end
                        if (data === '[DONE]') {
                            continue;
                        }

                        try {
                            const parsed = JSON.parse(data);
                            const content = parsed.choices[0]?.delta?.content;

                            if (content) {
                                // Check buffer size before adding
                                if (fullContent.length + content.length > MAX_BUFFER_SIZE) {
                                    console.warn(`⚠️ Buffer size limit reached (${MAX_BUFFER_SIZE} bytes). Stopping stream.`);
                                    reader.cancel();
                                    throw new Error('Response too large - exceeded 10MB buffer limit');
                                }

                                fullContent += content;
                                chunkCount++;

                                // Send chunk to popup via message
                                if (onChunk && typeof onChunk === 'function') {
                                    onChunk(content, fullContent);
                                }

                                // Also send to tab if tabId is provided
                                if (tabId) {
                                    // Properly handle chrome.runtime.sendMessage with callback
                                    chrome.runtime.sendMessage({
                                        action: 'TEST_CHUNK',
                                        requestId: requestId || `stream_${tabId}_${Date.now()}`,
                                        tabId: tabId,
                                        data: {
                                            chunk: content,
                                            fullContent: fullContent,
                                            progress: chunkCount
                                        }
                                    }, (response) => {
                                        // Check for errors in callback
                                        if (chrome.runtime.lastError) {
                                            // Popup might be closed, log but continue
                                            console.debug('Could not send chunk to popup:', chrome.runtime.lastError.message);
                                        }
                                    });
                                }

                                // Log progress every 10 chunks
                                if (chunkCount % 10 === 0) {
                                    console.log(`📊 Streaming progress: ${chunkCount} chunks, ${fullContent.length} chars`);
                                }
                            }
                        } catch (e) {
                            console.warn('Failed to parse streaming chunk:', e);
                        }
                    }
                }
            }

            return fullContent;
        } catch (error) {
            console.error('❌ Error processing stream:', error);
            throw error;
        } finally {
            reader.releaseLock();
        }
    }

    async handleValidateApiKey(message, sendResponse) {
        try {
            const { apiKey } = message.data;

            const response = await fetch('https://api.openai.com/v1/models', {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });

            sendResponse({
                success: response.ok,
                valid: response.ok
            });
        } catch (error) {
            sendResponse({
                success: false,
                valid: false,
                error: error.message
            });
        }
    }

    async handleSaveSettings(message, sendResponse) {
        try {
            const { settings } = message.data;

            // Encrypt all sensitive keys before storing
            const sensitiveKeys = ['apiKey', 'githubToken', 'gitlabToken', 'anthropicApiKey', 'googleApiKey', 'cohereApiKey', 'mistralApiKey', 'groqApiKey', 'huggingfaceApiKey'];

            for (const key of sensitiveKeys) {
                if (settings[key] && settings[key].trim() !== '') {
                    settings[key] = await this.encryptionService.encrypt(settings[key]);
                }
            }

            await chrome.storage.local.set({ aiRepoSpectorSettings: settings });

            console.log('Settings saved successfully with encryption');
            sendResponse({ success: true });
        } catch (error) {
            this.errorHandler.logError('Save settings', error);
            sendResponse({
                success: false,
                error: error.message
            });
        }
    }

    async handleGetSettings(message, sendResponse) {
        try {
            const result = await chrome.storage.local.get('aiRepoSpectorSettings');
            const settings = result.aiRepoSpectorSettings || {};

            // Decrypt all sensitive keys
            const sensitiveKeys = ['apiKey', 'githubToken', 'gitlabToken', 'anthropicApiKey', 'googleApiKey', 'cohereApiKey', 'mistralApiKey', 'groqApiKey', 'huggingfaceApiKey'];

            for (const key of sensitiveKeys) {
                if (settings[key]) {
                    try {
                        settings[key] = await this.encryptionService.decrypt(settings[key]);
                    } catch (decryptError) {
                        console.warn(`Failed to decrypt ${key}, clearing it`);
                        settings[key] = '';
                    }
                }
            }

            sendResponse({
                success: true,
                data: settings
            });
        } catch (error) {
            this.errorHandler.logError('Get settings', error);
            sendResponse({
                success: false,
                error: error.message
            });
        }
    }

    async getStoredSettings() {
        // Wait for encryption service to be ready
        await this.waitForEncryption();

        const result = await chrome.storage.local.get('aiRepoSpectorSettings');
        const settings = result.aiRepoSpectorSettings || {};

        console.log('📦 Raw settings from storage:', {
            hasSettings: !!result.aiRepoSpectorSettings,
            hasEncryptedApiKey: !!settings.apiKey,
            encryptedKeyLength: settings.apiKey?.length || 0,
            encryptionReady: this.encryptionReady
        });

        // Decrypt all sensitive keys
        const sensitiveKeys = ['apiKey', 'githubToken', 'gitlabToken', 'anthropicApiKey', 'googleApiKey', 'cohereApiKey', 'mistralApiKey', 'groqApiKey', 'huggingfaceApiKey'];

        for (const key of sensitiveKeys) {
            if (settings[key]) {
                try {
                    const decrypted = await this.encryptionService.decrypt(settings[key]);
                    console.log(`✅ Decrypted ${key}, length: ${decrypted?.length || 0}`);
                    settings[key] = decrypted;
                } catch (decryptError) {
                    console.warn(`❌ Failed to decrypt ${key} in getStoredSettings, clearing it`, decryptError);
                    settings[key] = '';
                }
            }
        }

        return settings;
    }

    async handleAnalyzeContext(message, sendResponse) {
        try {
            const { code, url, level } = message.data;

            const context = await this.contextAnalyzer.analyzeWithContext(code, {
                url,
                level: level || 'smart'
            });

            sendResponse({
                success: true,
                data: context
            });
        } catch (error) {
            this.errorHandler.logError('Context analysis', error);
            sendResponse({
                success: false,
                error: error.message
            });
        }
    }

    async handleProcessDiff(message, sendResponse) {
        try {
            const { diffContent, url, options: _options } = message.data;

            // This will be enhanced in Phase 2.1
            const context = await this.contextAnalyzer.analyzeWithContext(diffContent, {
                url,
                level: 'smart',
                isDiff: true
            });

            sendResponse({
                success: true,
                data: context
            });
        } catch (error) {
            this.errorHandler.logError('Diff processing', error);
            sendResponse({
                success: false,
                error: error.message
            });
        }
    }

    handleGetProgress(message, sendResponse) {
        sendResponse({
            success: true,
            data: {
                isProcessing: this.isProcessing,
                queueLength: this.processingQueue.length
            }
        });
    }

    handleGetTabId(message, sender, sendResponse) {
        // Return the tab ID from the sender
        const tabId = sender?.tab?.id;
        console.log('📍 GET_TAB_ID request from tab:', tabId);
        sendResponse({
            success: true,
            tabId: tabId
        });
    }

    async processQueue() {
        if (this.processingQueue.length > 0) {
            const { message, sendResponse } = this.processingQueue.shift();
            await this.handleGenerateTests(message, sendResponse);
        }
    }

    async cacheResults(code, options, results) {
        try {
            const cacheKey = this.cacheManager.generateKey(code, options);
            if (cacheKey) {
                await this.cacheManager.set(cacheKey, {
                    testCases: results,
                    timestamp: Date.now(),
                    options
                });
            }
        } catch (error) {
            console.warn('Failed to cache results:', error);
        }
    }

    hashCode(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return hash.toString();
    }

    setupContextMenus() {
        // Check if contextMenus API is available
        if (!chrome.contextMenus) {
            console.warn('Context menus API not available');
            return;
        }

        try {
            chrome.contextMenus.removeAll(() => {
                if (chrome.runtime.lastError) {
                    console.warn('Error removing context menus:', chrome.runtime.lastError);
                }

                chrome.contextMenus.create({
                    id: 'generateTests',
                    title: 'Generate Test Cases',
                    contexts: ['selection', 'page']
                }, () => {
                    if (chrome.runtime.lastError) {
                        console.warn('Error creating generateTests context menu:', chrome.runtime.lastError);
                    }
                });

                chrome.contextMenus.create({
                    id: 'analyzeCode',
                    title: 'Analyze Code Structure',
                    contexts: ['selection', 'page']
                }, () => {
                    if (chrome.runtime.lastError) {
                        console.warn('Error creating analyzeCode context menu:', chrome.runtime.lastError);
                    }
                });
            });
        } catch (error) {
            console.warn('Failed to setup context menus:', error);
        }
    }
}

// Initialize services
let ragService = null;
let backgroundServiceInstance = null; // Keep a reference to the main service

// Listen for messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Ensure backgroundServiceInstance is initialized before handling messages
    if (!backgroundServiceInstance) {
        backgroundServiceInstance = new BackgroundService();
    }
    handleMessage(request, sender, sendResponse, backgroundServiceInstance);
    return true; // Keep channel open for async response
});

async function handleMessage(request, sender, sendResponse, serviceInstance) {
    try {
        const { type, payload } = request;

        switch (type) {
            case 'INIT_RAG':
                try {
                    // IMPORTANT: Default to OpenAI in service worker context
                    // Transformers.js requires DOM and won't work in service workers
                    const provider = payload.provider || 'openai';
                    const options = {
                        provider,
                        apiKey: payload.apiKey // Only needed for OpenAI
                    };

                    // Validate based on provider
                    if (provider === 'openai' && !payload.apiKey) {
                        sendResponse({ success: false, error: 'API Key required for OpenAI provider' });
                        return;
                    }

                    // Warn if user tries to use Transformers in service worker
                    if (provider === 'transformers') {
                        console.warn('⚠️ Transformers.js is not supported in service worker context. This will fail.');
                        sendResponse({
                            success: false,
                            error: 'Transformers.js requires DOM access and cannot run in service workers. Please use OpenAI embedding provider instead.'
                        });
                        return;
                    }

                    ragService = new RAGService(options);

                    // Initialize RAG service
                    await ragService.init((progress) => {
                        if (progress) {
                            chrome.runtime.sendMessage({ type: 'RAG_MODEL_PROGRESS', payload: progress }).catch(() => {
                                // Ignore errors if popup is closed
                            });
                        }
                    });

                    // Link RAG service to ContextAnalyzer if instance exists
                    if (serviceInstance && serviceInstance.contextAnalyzer) {
                        serviceInstance.contextAnalyzer.setRagService(ragService);
                    }

                    sendResponse({
                        success: true,
                        providerInfo: ragService.getProviderInfo()
                    });
                } catch (error) {
                    console.error('RAG initialization failed:', error);
                    sendResponse({
                        success: false,
                        error: error.message || 'Failed to initialize RAG service'
                    });
                }
                break;

            case 'INDEX_REPO':
                if (!ragService) {
                    sendResponse({ success: false, error: 'RAG Service not initialized' });
                    return;
                }
                // Note: In a real extension, we'd need to fetch files here or pass them in
                // For this demo, we assume files are passed in payload
                await ragService.indexRepository(payload.repoId, payload.files, (progress) => {
                    // Optional: Send progress updates back to UI via runtime.sendMessage
                    chrome.runtime.sendMessage({ type: 'RAG_PROGRESS', payload: progress });
                });
                sendResponse({ success: true });
                break;

            case 'RETRIEVE_CONTEXT':
                if (!ragService) {
                    sendResponse({ success: false, error: 'RAG Service not initialized' });
                    return;
                }
                const results = await ragService.retrieveContext(payload.repoId, payload.query);
                sendResponse({ success: true, results });
                break;

            case 'CHECK_INDEXED':
                if (!ragService) {
                    sendResponse({ success: false, error: 'RAG Service not initialized' });
                    return;
                }
                const isIndexed = await ragService.vectorStore.isIndexed(payload.repoId);
                sendResponse({ success: true, isIndexed });
                break;

            case 'AUTO_INDEX_REPO':
                try {
                    const { url, provider, apiKey, token } = payload;

                    // Initialize RAG if not already done
                    if (!ragService) {
                        ragService = new RAGService({ provider, apiKey });
                        await ragService.init();
                    }

                    // Determine platform and fetch files
                    let service;
                    let repoId;

                    if (url.includes('github.com')) {
                        service = new GitHubService(token);
                        repoId = service.getRepoId(url);
                    } else if (url.includes('gitlab.com')) {
                        service = new GitLabService(token);
                        repoId = service.getRepoId(url);
                    } else {
                        sendResponse({ success: false, error: 'Unsupported platform' });
                        return;
                    }

                    // Fetch repository files
                    const files = await service.fetchRepositoryFiles(url, (progress) => {
                        chrome.runtime.sendMessage({ type: 'AUTO_INDEX_PROGRESS', payload: progress });
                    });

                    // Index the repository
                    await ragService.indexRepository(repoId, files, (progress) => {
                        chrome.runtime.sendMessage({ type: 'RAG_PROGRESS', payload: progress });
                    });

                    sendResponse({ success: true, repoId, filesIndexed: files.length });
                } catch (error) {
                    console.error('Auto-index error:', error);
                    sendResponse({ success: false, error: error.message });
                }
                break;

            // ... existing handlers ...
            default:
                // Delegate to BackgroundService for all other message types
                if (serviceInstance && typeof serviceInstance.handleMessage === 'function') {
                    await serviceInstance.handleMessage(request, sender, sendResponse);
                } else {
                    console.warn(`Unknown message type or handler not found: ${type}`);
                    sendResponse({ success: false, error: `Unknown message type: ${type}` });
                }
                break;
        }
    } catch (error) {
        console.error('Background error:', error);
        sendResponse({ success: false, error: error.message });
    }
}

// Initialize the background service (moved inside the listener to ensure it's ready)
// new BackgroundService();
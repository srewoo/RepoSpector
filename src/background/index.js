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
import { TokenManager } from '../utils/tokenManager.js';
import { PLATFORM_PATTERNS as _PLATFORM_PATTERNS, MODELS } from '../utils/constants.js';
import {
    TEST_GENERATION_SYSTEM_PROMPT,
    buildEnhancedTestPrompt,
    buildEnhancedChatPrompt,
    CODE_REVIEW_PROMPT
} from '../utils/prompts.js';
import { RAGService } from '../services/RAGService.js';
import { GitHubService } from '../services/GitHubService.js';
import { GitLabService } from '../services/GitLabService.js';
import { LLMService } from '../services/LLMService.js';
import { PullRequestService } from '../services/PullRequestService.js';
import { StaticAnalysisService } from '../services/StaticAnalysisService.js';
import { OSVService } from '../services/OSVService.js';
import { EOLService } from '../services/EOLService.js';
import { AdaptiveLearningService } from '../services/AdaptiveLearningService.js';
import { CustomRulesService } from '../services/CustomRulesService.js';
import { PRThreadManager } from '../services/PRThreadManager.js';
import { PRSessionManager } from '../services/PRSessionManager.js';
// Prompt builders and review-engine imports for these domains now live in the
// per-domain handler modules under ./handlers/ (generators, prReview).
// Kept for the future backend re-enable (see docs/adr/0001-backend-service.md);
// prefixed with `_` so the intentionally-unused import passes lint.
import { AegisClient as _AegisClient } from '../services/AegisClient.js';
import { FindingFollowupService } from '../services/FindingFollowupService.js';
import { CodeGraphPipeline } from '../services/CodeGraphPipeline.js';
import { ReviewMetricsService } from '../services/ReviewMetricsService.js';
import { PRComplianceChecker } from '../services/PRComplianceChecker.js';
import { FindingCache } from '../services/FindingCache.js';
import { TelemetryService } from '../services/TelemetryService.js';
import { dispatch, registerHandlers } from './messageRouter.js';
import { createRagHandlers } from './handlers/ragHandlers.js';
import { createCacheTelemetryHandlers } from './handlers/cacheTelemetryHandlers.js';
import { createSettingsHandlers } from './handlers/settingsHandlers.js';
import { createThreadHandlers } from './handlers/threadHandlers.js';
import { createAnalysisHandlers } from './handlers/analysisHandlers.js';
import { createContextHandlers } from './handlers/contextHandlers.js';
import { createIndexingHandlers } from './handlers/indexingHandlers.js';
import { createChatHandlers } from './handlers/chatHandlers.js';
import { createGeneratorHandlers } from './handlers/generatorHandlers.js';
import { createPrReviewHandlers } from './handlers/prReviewHandlers.js';

class BackgroundService {
    constructor() {
        this.isProcessing = false;
        this.processingQueue = [];
        this.heartbeatInterval = null;
        this.activeTabs = new Map(); // Track active processing tabs
        this.prScoreCache = new Map(); // Cache PR scores for consistency

        // Initialize services
        try {
            this.errorHandler = new ErrorHandler();
            this.encryptionService = new EncryptionService();
            this.contextAnalyzer = new ContextAnalyzer();
            this.batchProcessor = new BatchProcessor();
            this.codeChunker = new CodeChunker();
            this.tokenManager = new TokenManager();
            this.testGenerator = new TestGenerator();
            this.cacheManager = new CacheManager();
            this.languageDetector = new LanguageDetector();

            // Initialize RAG services
            this.ragService = new RAGService({
                provider: 'local',  // Use local embeddings (free, 100% private!)
                apiKey: null  // Only needed if using OpenAI provider
            });
            this.githubService = new GitHubService();
            this.gitlabService = new GitLabService();
            this.llmService = new LLMService();
            this.osvService = new OSVService({ cacheTTL: 86400000 });
            this.eolService = new EOLService({ cacheTTL: 604800000 });
            this.adaptiveLearningService = new AdaptiveLearningService();
            this.findingCache = new FindingCache();
            this.telemetry = new TelemetryService();
            this.customRulesService = new CustomRulesService();
            this.pullRequestService = new PullRequestService();
            this.staticAnalysisService = new StaticAnalysisService({
                enableESLint: true,
                enableSemgrep: true,
                enableDependency: true,
                enableEOL: true,
                enableConfidenceAggregation: true,
                minConfidenceThreshold: 0.4,
                dependency: { osvService: this.osvService },
                eolService: this.eolService,
                adaptiveLearningService: this.adaptiveLearningService,
                customRulesService: this.customRulesService
            });
            this.prThreadManager = new PRThreadManager({
                retentionDays: 30,
                maxMessagesPerThread: 50
            });
            this.prSessionManager = new PRSessionManager({
                retentionDays: 30
            });

            // Wire up RAG service to context analyzer
            this.contextAnalyzer.setRagService(this.ragService);

            // Initialize Knowledge Graph Pipeline (GitNexus-inspired)
            this.codeGraphPipeline = new CodeGraphPipeline();

            // Initialize Review Metrics and Compliance
            this.reviewMetricsService = new ReviewMetricsService();
            this.prComplianceChecker = new PRComplianceChecker();

            console.log('RepoSpector services initialized successfully (including RAG with local embeddings + Knowledge Graph)');
        } catch (error) {
            console.error('Failed to initialize services:', error);
        }

        this.setupMessageHandlers();
        this.setupInstallHandler();
        this.setupHeartbeat();

        // Initialize encryption service asynchronously and load tokens
        this.initializeEncryptionAsync();
        this.loadTokensAsync();
        this.osvService.loadCache();
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

    /**
     * Load tokens from storage on service worker initialization
     * This ensures tokens are available even after service worker restarts
     */
    async loadTokensAsync() {
        try {
            // Wait for encryption to be ready
            await this.waitForEncryption();

            // Load settings from storage
            const settings = await this.getStoredSettings();

            // Set tokens on services
            if (settings && settings.githubToken) {
                this.githubService.token = settings.githubToken;
                console.log('✅ GitHub token loaded on startup');
            }
            if (settings && settings.gitlabToken) {
                this.gitlabService.token = settings.gitlabToken;
                console.log('✅ GitLab token loaded on startup');
            }
            if (settings && settings.apiKey) {
                this.ragService.apiKey = settings.apiKey;
                console.log('✅ RAG API key loaded on startup');
            }

            // Load EOL cache from storage
            this.eolService.loadCache();
        } catch (error) {
            console.error('❌ Failed to load tokens on startup:', error);
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
            const settings = await this.loadSettings();

            // Update RAG service with API keys from settings
            if (settings && settings.apiKey) {
                this.ragService.apiKey = settings.apiKey;
                console.log('RAG service API key loaded from settings');
            }
            if (settings && settings.githubToken) {
                this.githubService.token = settings.githubToken;
            }
            if (settings && settings.gitlabToken) {
                this.gitlabService.token = settings.gitlabToken;
            }

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
        // NOTE: Message handlers are now set up in the global listener at the bottom of this file
        // to avoid duplicate listeners. This method is kept for potential future use but
        // should NOT add a listener here to prevent conflicts.
        console.log('📡 BackgroundService ready to handle messages');
    }

    async handleGenerateTests(message, sendResponse, sender, isFromPopup = true) {
        const { tabId, options = {}, code, context, useDeepContext } = message.payload || message.data || {};

        // CRITICAL: Store isFromPopup in options so it propagates through the call chain
        options.isFromPopup = isFromPopup;
        console.log('🧪 handleGenerateTests | isFromPopup:', isFromPopup, '| tabId:', tabId);

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

                        const extractionPromise = chrome.tabs.sendMessage(tabId, {
                            type: 'EXTRACT_CODE',
                            options: { contextLevel: options.contextLevel || 'smart' }
                        });

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
                        // Safely extract error message from extraction result
                        const extractError = extractionResult?.error;
                        const errorMsg = typeof extractError === 'string'
                            ? extractError
                            : (extractError?.message || this.getErrorMessage(extractError) || 'Failed to extract code from page');
                        throw new Error(errorMsg);
                    }
                } catch (error) {
                    throw new Error(`Code extraction failed: ${this.getErrorMessage(error)}`);
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
            // Use 'deep' only if user enabled Deep Context toggle
            const contextLevel = useDeepContext ? 'deep' : (options.contextLevel || 'smart');
            console.log('🔍 Using context level:', contextLevel, '(Deep Context:', useDeepContext ? 'enabled' : 'disabled', ')');

            const enhancedContext = await this.contextAnalyzer.analyzeWithContext(extractedCode, {
                url: extractedContext?.url || 'unknown',
                level: contextLevel,
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

            // Determine if chunking is needed using TokenManager
            // IMPORTANT: Account for ALL context, not just code
            const modelName = this.getModelId(settings.model);
            const availableTokens = this.tokenManager.getAvailableTokens(modelName);

            // Calculate tokens for all context components
            const codeTokens = this.tokenManager.estimateTokens(extractedCode);
            const promptOverhead = 2000; // System prompt, instructions, formatting
            const responseReserve = this.tokenManager.getOutputLimit(modelName) || 4000; // Adaptive reserve based on model output limit

            // Get RAG context if Deep Context is enabled
            let ragContext = null;
            let ragTokens = 0;
            if (useDeepContext && this.ragService && extractedContext?.url) {
                try {
                    // Extract repoId from URL (e.g., "org/repo" from "https://gitlab.com/org/repo/...")
                    const repoId = this.contextAnalyzer.extractRepoIdFromUrl(
                        extractedContext.url,
                        extractedContext.platform
                    );

                    if (repoId) {
                        console.log('🔍 Retrieving RAG context for repo:', repoId, '(user enabled Deep Context for tests)');

                        // Build smart query from the code being tested
                        const codeContext = this.contextAnalyzer.buildSmartRAGQuery(extractedCode, extractedContext);
                        const smartQuery = `Generate tests for:\n\n${codeContext}`;

                        // Fetch relevant code chunks
                        const relevantChunks = await this.ragService.retrieveContext(repoId, smartQuery, 20);

                        // Also fetch repository documentation for understanding project purpose
                        const repoDocumentation = await this.ragService.getRepositoryDocumentation(repoId);

                        if (relevantChunks && relevantChunks.length > 0) {
                            // Format for test generation (expects chunks array)
                            ragContext = {
                                chunks: relevantChunks,  // Keep as array for processWithChunking/processDirect
                                documentation: repoDocumentation.found ? repoDocumentation : null
                            };
                            const chunksText = relevantChunks.map(c => c.content || '').join('\n\n');
                            ragTokens = this.tokenManager.estimateTokens(chunksText);

                            // Add documentation tokens
                            if (repoDocumentation.found) {
                                ragTokens += this.tokenManager.estimateTokens(repoDocumentation.content);
                                console.log(`📖 Repository documentation found: ${repoDocumentation.sources.join(', ')}`);
                            }

                            console.log(`📚 RAG context found: ${relevantChunks.length} chunks, ${ragTokens} tokens`);
                        } else if (repoDocumentation.found) {
                            // Only documentation available
                            ragContext = {
                                chunks: [],
                                documentation: repoDocumentation
                            };
                            ragTokens = this.tokenManager.estimateTokens(repoDocumentation.content);
                            console.log(`📖 Only documentation found: ${repoDocumentation.sources.join(', ')}`);
                        } else {
                            console.log('ℹ️ No RAG context found for this repository');
                        }
                    } else {
                        console.log('⚠️ Could not extract repoId from URL:', extractedContext.url);
                    }
                } catch (ragError) {
                    console.warn('⚠️ RAG context retrieval failed:', ragError);
                }
            } else if (!useDeepContext) {
                console.log('ℹ️ Deep Context (RAG) disabled by user for test generation');
            }

            // Get conversation history tokens if available
            const conversationHistory = options.conversationHistory || [];
            let historyTokens = 0;
            if (conversationHistory.length > 0) {
                const historyText = conversationHistory.map(m => m.content || '').join('\n');
                historyTokens = this.tokenManager.estimateTokens(historyText);
                console.log(`📜 Conversation history: ${historyTokens} tokens (${conversationHistory.length} messages)`);
            }

            // Calculate total and determine if chunking needed
            const totalContextTokens = codeTokens + ragTokens + historyTokens + promptOverhead + responseReserve;
            const effectiveLimit = availableTokens * 0.85; // Use 85% of limit for safety
            const needsChunking = totalContextTokens > effectiveLimit;

            // Create comprehensive token budget object
            const tokenBudget = {
                codeTokens,
                ragTokens,
                historyTokens,
                promptOverhead,
                responseReserve,
                totalContextTokens,
                availableTokens,
                effectiveLimit,
                needsChunking,
                utilizationPercent: Math.round((totalContextTokens / availableTokens) * 100)
            };

            console.log('📊 Comprehensive Token Budget Analysis:');
            console.log(`  - Code: ${tokenBudget.codeTokens} tokens`);
            console.log(`  - RAG context: ${tokenBudget.ragTokens} tokens`);
            console.log(`  - Conversation history: ${tokenBudget.historyTokens} tokens`);
            console.log(`  - Prompt overhead: ${tokenBudget.promptOverhead} tokens`);
            console.log(`  - Response reserve: ${tokenBudget.responseReserve} tokens`);
            console.log(`  - Total: ${tokenBudget.totalContextTokens} tokens`);
            console.log(`  - Available: ${tokenBudget.availableTokens} tokens (effective: ${Math.round(tokenBudget.effectiveLimit)})`);
            console.log(`  - Utilization: ${tokenBudget.utilizationPercent}%`);
            console.log(`  - Needs chunking: ${tokenBudget.needsChunking ? 'YES' : 'NO'}`);

            // Store RAG context and history in options for use in processDirect/processWithChunking
            options.ragContext = ragContext;
            options.conversationHistory = conversationHistory;
            options.tokenBudget = tokenBudget;

            let testResults;
            let lastError = null;
            const maxRetries = 2; // Retry up to 2 times

            // Retry loop for LLM generation
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    if (attempt > 0) {
                        console.log(`🔄 Retry attempt ${attempt}/${maxRetries}...`);
                    }

                    // Use chunking if code is too large OR if processDirect fails with token error
                    if (tokenBudget.needsChunking || (lastError && lastError.message.includes('too large'))) {
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

                    // Safely get error message
                    const errorMessage = error?.message || error?.toString() || String(error);
                    console.error(`❌ LLM generation attempt ${attempt + 1} failed:`, errorMessage);

                    // Check if it's a token error - if so, automatically switch to chunking
                    const isTokenError = errorMessage.includes('maximum context length') ||
                        errorMessage.includes('token') ||
                        errorMessage.includes('too large');

                    if (isTokenError && !tokenBudget.needsChunking) {
                        console.log('⚠️ Token limit hit - automatically switching to chunked processing');
                        // Force chunking on next attempt
                        tokenBudget.needsChunking = true;
                        // Don't count this as a failed attempt since we're switching strategy
                        attempt--;
                    }

                    // If this was the last attempt, throw a user-friendly error
                    if (attempt === maxRetries) {
                        if (isTokenError) {
                            // Even chunking failed, give helpful error
                            throw new Error(
                                `Code file is too large to process even with chunking. ` +
                                `Try selecting a smaller section of code.`
                            );
                        } else {
                            throw new Error(`Test generation failed after ${maxRetries + 1} attempts: ${errorMessage}`);
                        }
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
                    chunked: tokenBudget.needsChunking,
                    tokensUsed: tokenBudget.codeTokens,
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
                error: this.getErrorMessage(error),
                retry: this.errorHandler.shouldRetry(error)
            });
        }
    }

    /**
     * Build messages array for chat (with conversation history support and token management)
     * @param {string} code - The code being discussed
     * @param {string} question - Current user question
     * @param {object} languageDetection - Language detection info
     * @param {object} context - Page context
     * @param {array} conversationHistory - Previous conversation messages
     * @param {object} ragContext - RAG context (chunks and sources)
     * @param {string} model - Model identifier for token limits
     * @returns {array} - Array of messages for OpenAI API
     */
    buildChatMessages(code, question, languageDetection, context, conversationHistory = [], ragContext = null, model = 'gpt-4.1-mini') {
        const language = languageDetection.language || 'unknown';

        // Get model limits
        const availableTokens = this.tokenManager.getAvailableTokens(model);
        console.log(`📊 Token budget: ${availableTokens} tokens available for ${model}`);

        // Estimate tokens for fixed parts
        const questionTokens = this.tokenManager.estimateTokens(question);
        const codeTokens = this.tokenManager.estimateTokens(code);
        const ragTokens = ragContext?.chunks ? this.tokenManager.estimateTokens(ragContext.chunks) : 0;

        console.log(`📊 Token breakdown:
  - Question: ${questionTokens}
  - Code: ${codeTokens}
  - RAG context: ${ragTokens}
  - Total fixed: ${questionTokens + codeTokens + ragTokens}`);

        // Check if we need to truncate code
        let processedCode = code;
        let processedRAG = ragContext;
        const systemPromptEstimate = 500; // Estimated tokens for system prompt text
        const budgetForHistory = this.tokenManager.getOutputLimit(model) || 4000; // Adaptive reserve based on model output limit
        // Track truncation for user warnings
        this._lastTruncationInfo = { codeTruncated: false, ragTruncated: false };

        const fixedTokens = systemPromptEstimate + questionTokens + codeTokens + ragTokens;

        if (fixedTokens > availableTokens - budgetForHistory) {
            console.warn(`⚠️ Token limit approaching! Fixed content: ${fixedTokens}, Limit: ${availableTokens}`);

            // Strategy 1: Reduce RAG context first
            if (ragTokens > 0 && ragContext?.chunks) {
                const ragBudget = Math.floor(availableTokens * 0.2); // 20% for RAG
                if (ragTokens > ragBudget) {
                    console.log(`⚠️ Truncating RAG context from ${ragTokens} to ~${ragBudget} tokens`);
                    const truncatedRAG = this.tokenManager.truncateCode(ragContext.chunks, ragBudget);
                    processedRAG = {
                        chunks: truncatedRAG,
                        sources: ragContext.sources || []
                    };
                    this._lastTruncationInfo.ragTruncated = true;
                }
            }

            // Strategy 2: Truncate code if still too large
            const codeBudget = availableTokens - budgetForHistory - systemPromptEstimate - questionTokens -
                (processedRAG?.chunks ? this.tokenManager.estimateTokens(processedRAG.chunks) : 0);

            if (codeTokens > codeBudget) {
                console.log(`⚠️ Truncating code from ${codeTokens} to ~${codeBudget} tokens`);
                processedCode = this.tokenManager.truncateCode(code, codeBudget);
                this._lastTruncationInfo.codeTruncated = true;
            }
        }

        const messages = [];

        // Build enhanced system message with code context and optional RAG context
        // Use the enhanced chat prompt builder for much better code analysis
        let systemContent = buildEnhancedChatPrompt(processedCode, language, context, processedRAG);

        // Detect if this is diff content (has + or - line prefixes indicating additions/deletions)
        const isDiffContent = processedCode.includes('\n+') || processedCode.includes('\n-') ||
            processedCode.match(/^[+-]/m);

        if (isDiffContent) {
            // Add the comprehensive code review prompt for diffs
            systemContent += `

${CODE_REVIEW_PROMPT}`;
        }

        messages.push({
            role: 'system',
            content: systemContent
        });

        // Add conversation history if available (with token-aware pruning)
        if (conversationHistory && conversationHistory.length > 0) {
            console.log(`📝 Processing ${conversationHistory.length} messages from conversation history`);

            // Filter conversation messages (skip system messages and the initial welcome)
            const filteredHistory = conversationHistory.filter(msg => {
                // Skip system messages, error messages, and the initial welcome message
                if (msg.role === 'system' || msg.type === 'error' || msg.id === 1) {
                    return false;
                }
                // Keep user and assistant messages
                return (msg.role === 'user' || msg.role === 'assistant');
            }).map(msg => ({
                role: msg.role,
                content: msg.content
            }));

            // Add filtered history to messages temporarily for pruning
            messages.push(...filteredHistory);
        }

        // Add current question
        messages.push({
            role: 'user',
            content: question
        });

        // Prune messages to fit within token limit
        const prunedMessages = this.tokenManager.pruneMessages(messages, model);

        // Log pruning results
        const originalTokens = this.tokenManager.countMessagesTokens(messages);
        const prunedTokens = this.tokenManager.countMessagesTokens(prunedMessages);

        if (prunedTokens < originalTokens) {
            console.warn(`⚠️ Pruned conversation: ${originalTokens} → ${prunedTokens} tokens (${messages.length} → ${prunedMessages.length} messages)`);
        } else {
            console.log(`✅ Token count OK: ${prunedTokens} tokens (${prunedMessages.length} messages)`);
        }

        // Final validation
        const validation = this.tokenManager.validateTokenCount(prunedMessages, model);
        if (!validation.valid) {
            console.error(`❌ Token validation failed: ${validation.recommendation}`);
            throw new Error(validation.recommendation);
        } else {
            console.log(`✅ Token validation passed: ${validation.utilizationPercent}% of limit`);
        }

        return prunedMessages;
    }

    /**
     * Process large code in batches when it exceeds token limits
     * Used for test generation on very large files
     * @param {string} code - The code to process
     * @param {string} model - Model identifier
     * @param {string} systemPrompt - System prompt template
     * @param {string} userPrompt - User prompt template
     * @returns {array} - Array of results from each chunk
     */
    async processCodeInBatches(code, model, systemPrompt, userPrompt, apiKey) {
        console.log('📦 Processing large code in batches...');

        // Check if chunking is needed
        const tokenBudget = this.tokenManager.getTokenBudget(model, code.length);

        if (!tokenBudget.needsChunking) {
            console.log('✅ Code fits in single request, no chunking needed');
            return null; // Caller should handle normally
        }

        // Split code into chunks
        const chunks = this.tokenManager.chunkCode(code, model);
        console.log(`📦 Split code into ${chunks.length} chunks`);

        const results = [];

        for (const chunk of chunks) {
            console.log(`📦 Processing chunk ${chunk.index + 1}/${chunk.total} (${chunk.tokens} tokens)`);

            const chunkPrompt = userPrompt.replace('{{CODE}}', chunk.content) +
                `\n\n**Note:** This is chunk ${chunk.index + 1} of ${chunk.total} from a large file.`;

            try {
                const result = await this.callOpenAI({
                    model: model,  // Use full model identifier for provider routing
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: chunkPrompt }
                    ],
                    temperature: 0.3,
                    max_tokens: 4096
                }, apiKey, {
                    streaming: false,
                    requestId: `batch_${chunk.index}_${Date.now()}`
                });

                results.push({
                    chunkIndex: chunk.index,
                    result: result
                });

                console.log(`✅ Chunk ${chunk.index + 1} processed successfully`);

                // Small delay between chunks to avoid rate limiting
                if (chunk.index < chunk.total - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

            } catch (error) {
                console.error(`❌ Failed to process chunk ${chunk.index + 1}:`, error);
                results.push({
                    chunkIndex: chunk.index,
                    error: this.getErrorMessage(error)
                });
            }
        }

        return results;
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

        // OPTIMIZATION: Use summarized RAG context for multi-chunk processing
        // This reduces token usage significantly when processing many chunks
        if (options.ragContext && options.ragContext.chunks) {
            const ragChunks = options.ragContext.chunks;

            if (chunks.length > 1) {
                // For multi-chunk: Use summarized context to reduce token multiplication
                const summarizedRAG = this.summarizeRAGContext(ragChunks);
                context.ragContext = summarizedRAG.summaryText;
                context.ragSources = summarizedRAG.sources;
                console.log(`📚 Using SUMMARIZED RAG context (${summarizedRAG.sources.length} sources, ~${summarizedRAG.estimatedTokens} tokens) for ${chunks.length} chunks`);
                console.log(`   Token savings: ~${(ragChunks.length * 500 * (chunks.length - 1))} tokens avoided`);
            } else {
                // For single chunk: Use full context
                context.ragContext = ragChunks.map(chunk =>
                    `// File: ${chunk.filePath || 'unknown'}\n${chunk.content || chunk.text || ''}`
                ).join('\n\n---\n\n');
                context.ragSources = ragChunks.map(chunk => chunk.filePath || 'unknown');
                console.log(`📚 Added full RAG context from ${ragChunks.length} chunks`);
            }
        }

        // Prepare chunks with context (each chunk will now include RAG context)
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
        const modelId = this.getModelId(settings.model);

        // IMPORTANT: Merge RAG context from options into the context object
        // This ensures buildTestGenerationPrompt has access to RAG data
        if (options.ragContext && options.ragContext.chunks) {
            const ragChunks = options.ragContext.chunks;
            context.ragContext = ragChunks.map(chunk =>
                `// File: ${chunk.filePath || 'unknown'}\n${chunk.content || chunk.text || ''}`
            ).join('\n\n---\n\n');
            context.ragSources = ragChunks.map(chunk => chunk.filePath || 'unknown');
            console.log(`📚 Added RAG context from ${ragChunks.length} chunks to prompt`);
        }

        // Include repository documentation if available
        if (options.ragContext && options.ragContext.documentation) {
            context.repoDocumentation = options.ragContext.documentation;
            console.log(`📖 Added repository documentation to prompt context`);
        }

        // Build initial prompt with all context
        let prompt = this.buildTestGenerationPrompt(code, options, context);

        // Add conversation history if available
        if (options.conversationHistory && options.conversationHistory.length > 0) {
            const historySection = this.formatConversationHistory(options.conversationHistory);
            prompt = `${historySection}\n\n${prompt}`;
            console.log(`📜 Added conversation history (${options.conversationHistory.length} messages) to prompt`);
        }

        console.log('📤 Preparing prompt for OpenAI...');
        console.log('Initial prompt length:', prompt.length);
        console.log('Model:', modelId);

        // TOKEN MANAGEMENT: Check and truncate if needed
        // Use proper system/user message structure for better LLM performance
        const messages = [
            { role: 'system', content: TEST_GENERATION_SYSTEM_PROMPT },
            { role: 'user', content: prompt }
        ];

        // Validate token count
        const validation = this.tokenManager.validateTokenCount(messages, modelId);
        console.log(`📊 Token validation: ${validation.totalTokens} tokens (${validation.utilizationPercent}% of limit)`);

        if (!validation.valid) {
            console.warn(`⚠️ Token limit exceeded! ${validation.totalTokens} > ${validation.modelLimit}`);
            console.warn(`⚠️ ${validation.recommendation}`);

            // SMART TRUNCATION: Reduce context in order of priority
            // 1. First truncate conversation history (least important)
            // 2. Then truncate RAG context
            // 3. Finally truncate code (most important, last resort)
            const availableTokens = this.tokenManager.getAvailableTokens(modelId);
            let needsRebuild = false;

            // Step 1: Truncate or remove conversation history
            if (options.conversationHistory && options.conversationHistory.length > 0) {
                console.log('📉 Truncating conversation history to reduce tokens...');
                // Keep only last 2 messages for context
                if (options.conversationHistory.length > 2) {
                    options.conversationHistory = options.conversationHistory.slice(-2);
                    needsRebuild = true;
                    console.log('   Reduced to last 2 messages');
                } else {
                    // Remove conversation history entirely
                    options.conversationHistory = [];
                    needsRebuild = true;
                    console.log('   Removed conversation history entirely');
                }
            }

            // Step 2: Truncate or remove RAG context
            if (context.ragContext) {
                console.log('📉 Truncating RAG context to reduce tokens...');
                const ragTokens = this.tokenManager.estimateTokens(context.ragContext);
                if (ragTokens > 2000) {
                    // Keep only first 2000 tokens worth
                    context.ragContext = this.tokenManager.truncateCode(context.ragContext, 2000);
                    needsRebuild = true;
                    console.log('   Truncated RAG context to ~2000 tokens');
                } else {
                    // Remove RAG context entirely
                    context.ragContext = null;
                    context.ragSources = null;
                    needsRebuild = true;
                    console.log('   Removed RAG context entirely');
                }
            }

            // Rebuild prompt if we made changes
            if (needsRebuild) {
                prompt = this.buildTestGenerationPrompt(code, options, context);
                if (options.conversationHistory && options.conversationHistory.length > 0) {
                    const historySection = this.formatConversationHistory(options.conversationHistory);
                    prompt = `${historySection}\n\n${prompt}`;
                }
                messages[1].content = prompt; // Index 1 is the user message

                // Re-validate after context truncation
                const midValidation = this.tokenManager.validateTokenCount(messages, modelId);
                console.log(`📊 After context truncation: ${midValidation.totalTokens} tokens`);

                if (midValidation.valid) {
                    console.log('✅ Context truncation was sufficient');
                }
            }

            // Step 3: If still exceeds, truncate the code itself
            const finalValidation = this.tokenManager.validateTokenCount(messages, modelId);
            if (!finalValidation.valid) {
                const codeTokens = this.tokenManager.estimateTokens(code);
                const codeBudget = availableTokens - 2000;

                if (codeTokens > codeBudget) {
                    console.log(`⚠️ Truncating code from ${codeTokens} to ~${codeBudget} tokens`);
                    const truncatedCode = this.tokenManager.truncateCode(code, codeBudget);

                    // Rebuild prompt with truncated code (no extra context since we removed it)
                    prompt = this.buildTestGenerationPrompt(truncatedCode, options, context);
                    messages[1].content = prompt; // Index 1 is the user message

                    // Re-validate
                    const revalidation = this.tokenManager.validateTokenCount(messages, modelId);
                    console.log(`📊 After code truncation: ${revalidation.totalTokens} tokens`);

                    if (!revalidation.valid) {
                        // Still too large - force chunking
                        throw new Error(`Code is too large even after truncation (${revalidation.totalTokens} tokens). Using automatic chunking...`);
                    }
                }
            }
        }

        console.log('✅ Token validation passed, sending to OpenAI...');
        console.log('📍 processDirect | isFromPopup:', options.isFromPopup);

        // Enable streaming for better responsiveness (supports all LLM providers)
        const result = await this.callOpenAI({
            model: settings.model || modelId,  // Use full model identifier for provider routing
            messages: messages,
            temperature: 0.1,
            max_tokens: 8192
        }, settings.apiKey, {
            streaming: true,
            tabId: options.tabId,
            requestId: options.requestId || `test_direct_${Date.now()}`,
            isFromPopup: options.isFromPopup  // CRITICAL: Pass isFromPopup for chunk routing
        });

        console.log('📥 Received result from OpenAI');
        console.log('Result type:', typeof result);
        console.log('Result length:', result?.length || 0);

        return result;
    }

    async generateTestsForChunk(chunk, options, settings) {
        const modelId = this.getModelId(settings.model);

        // Add RAG context info to chunk's context if not already there
        // This ensures Deep Context is included in each chunk's prompt
        if (!chunk.context.ragContext && options.ragContext && options.ragContext.chunks) {
            const ragChunks = options.ragContext.chunks;
            chunk.context.ragContext = ragChunks.map(c =>
                `// File: ${c.filePath || 'unknown'}\n${c.content || c.text || ''}`
            ).join('\n\n---\n\n');
            chunk.context.ragSources = ragChunks.map(c => c.filePath || 'unknown');
        }

        let prompt = this.buildTestGenerationPrompt(chunk.content, options, chunk.context);

        // Add note that this is part of a larger file
        prompt = `**Note**: This is chunk ${chunk.index + 1} of ${chunk.total} from a larger code file.\n\n${prompt}`;

        // TOKEN MANAGEMENT: Validate chunk doesn't exceed limits
        // Use proper system/user message structure for better LLM performance
        const messages = [
            { role: 'system', content: TEST_GENERATION_SYSTEM_PROMPT },
            { role: 'user', content: prompt }
        ];
        const validation = this.tokenManager.validateTokenCount(messages, modelId);

        if (!validation.valid) {
            console.warn(`⚠️ Chunk ${chunk.index} exceeds token limit, truncating...`);
            const availableTokens = this.tokenManager.getAvailableTokens(modelId);

            // Smart truncation for chunks: truncate RAG first, then code
            if (chunk.context.ragContext) {
                const ragTokens = this.tokenManager.estimateTokens(chunk.context.ragContext);
                if (ragTokens > 1000) {
                    chunk.context.ragContext = this.tokenManager.truncateCode(chunk.context.ragContext, 1000);
                    console.log(`   Truncated RAG context in chunk ${chunk.index + 1} to ~1000 tokens`);
                } else {
                    chunk.context.ragContext = null;
                    chunk.context.ragSources = null;
                    console.log(`   Removed RAG context from chunk ${chunk.index + 1}`);
                }
                prompt = this.buildTestGenerationPrompt(chunk.content, options, chunk.context);
                prompt = `**Note**: This is chunk ${chunk.index + 1} of ${chunk.total} from a larger code file.\n\n${prompt}`;
                messages[1].content = prompt; // Index 1 is the user message
            }

            // If still too large, truncate code
            const revalidation = this.tokenManager.validateTokenCount(messages, modelId);
            if (!revalidation.valid) {
                const truncatedCode = this.tokenManager.truncateCode(chunk.content, availableTokens - 2000);
                prompt = this.buildTestGenerationPrompt(truncatedCode, options, chunk.context);
                prompt = `**Note**: This is chunk ${chunk.index + 1} of ${chunk.total} from a larger code file (truncated).\n\n${prompt}`;
                messages[1].content = prompt; // Index 1 is the user message
            }
        }

        // Enable streaming for chunk processing too (supports all LLM providers)
        return await this.callOpenAI({
            model: settings.model || modelId,  // Use full model identifier for provider routing
            messages: messages,
            temperature: 0.1,
            max_tokens: 4096
        }, settings.apiKey, {
            streaming: true,
            tabId: options.tabId,
            requestId: options.requestId || `test_chunk_${chunk.index}_${Date.now()}`,
            isFromPopup: options.isFromPopup  // CRITICAL: Pass isFromPopup for chunk routing
        });
    }

    buildTestGenerationPrompt(code, options, context) {
        // Enhance context with edge case analysis and test patterns
        const enhancedContext = { ...context };

        try {
            // Analyze code for edge cases
            const edgeCaseData = this.testGenerator.analyzeEdgeCases(code);
            if (edgeCaseData.promptEnhancements) {
                enhancedContext.edgeCaseEnhancements = edgeCaseData.promptEnhancements;
                enhancedContext.detectedEdgeCases = edgeCaseData.edgeCases;
            }

            // If we have existing tests from RAG, analyze their patterns
            if (context.ragContext && Array.isArray(context.ragContext)) {
                const testFiles = context.ragContext.filter(chunk =>
                    chunk.includes('.test.') || chunk.includes('.spec.') || chunk.includes('__tests__')
                );
                if (testFiles.length > 0) {
                    const patternData = this.testGenerator.analyzeExistingTestPatterns(testFiles.join('\n'));
                    if (patternData.promptEnhancement) {
                        enhancedContext.testPatternEnhancements = patternData.promptEnhancement;
                        enhancedContext.detectedFramework = patternData.framework;
                    }
                }
            }
        } catch (error) {
            console.warn('Failed to enhance test prompt context:', error);
        }

        // Use the enhanced prompt builder from prompts.js
        // This provides much more comprehensive test generation guidance
        return buildEnhancedTestPrompt(code, options, enhancedContext);
    }

    /**
     * Get the correct model ID for API calls
     * Extracts modelId from MODELS config if available, otherwise returns the model as-is
     */
    getModelId(modelIdentifier) {
        if (!modelIdentifier) return 'gpt-4.1-mini'; // default fallback

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

    /**
     * Summarize RAG context to reduce token usage in multi-chunk processing
     * Instead of sending full file contents, sends previews with file paths
     * @param {Array} ragChunks - Array of RAG chunks with content
     * @returns {Object} Summarized RAG context
     */
    summarizeRAGContext(ragChunks) {
        if (!ragChunks || ragChunks.length === 0) {
            return { summaryText: '', sources: [], estimatedTokens: 0 };
        }

        const maxPreviewLength = 500; // Characters per chunk preview
        const summaryParts = [];
        const sources = [];

        for (const chunk of ragChunks) {
            const filePath = chunk.filePath || 'unknown';
            const content = chunk.content || chunk.text || '';
            const relevance = chunk.relevance || chunk.score || 0;

            // Create a preview of the content
            const preview = content.substring(0, maxPreviewLength).trim();
            const truncated = content.length > maxPreviewLength;

            summaryParts.push(
                `// File: ${filePath}${relevance ? ` (relevance: ${(relevance * 100).toFixed(0)}%)` : ''}\n` +
                `${preview}${truncated ? '...' : ''}`
            );
            sources.push(filePath);
        }

        const summaryText = summaryParts.join('\n\n---\n\n');
        const estimatedTokens = Math.ceil(summaryText.length / 4); // Rough estimate

        return {
            summaryText,
            sources,
            estimatedTokens,
            originalChunks: ragChunks.length
        };
    }

    /**
     * Format conversation history for inclusion in prompt
     * @param {Array} history - Array of conversation messages
     * @returns {string} Formatted conversation history section
     */
    formatConversationHistory(history) {
        if (!history || history.length === 0) {
            return '';
        }

        let formatted = '**Previous Conversation Context:**\n';
        formatted += 'The following conversation provides context for test generation:\n\n';

        for (const message of history) {
            const role = message.role === 'assistant' ? 'AI' : 'User';
            const content = message.content || '';

            // Truncate very long messages to avoid token bloat
            const truncatedContent = content.length > 2000
                ? content.substring(0, 2000) + '... [truncated]'
                : content;

            formatted += `**${role}:** ${truncatedContent}\n\n`;
        }

        formatted += '---\n\n';
        return formatted;
    }

    /**
     * Unified LLM call method - delegates to LLMService for multi-provider support
     * Supports: OpenAI, Anthropic (Claude), Google (Gemini), Groq, Mistral, Ollama (local)
     *
     * @param {Object} requestData - Request data with model, messages, temperature, etc.
     * @param {string} apiKey - API key (not required for local/Ollama)
     * @param {Object} options - Options: streaming, onChunk, tabId, timeout, requestId
     * @returns {Promise<string>} LLM response content
     */
    async callOpenAI(requestData, apiKey, options = {}) {
        try {
            console.log('🤖 LLM Request:', {
                model: requestData.model,
                streaming: options.streaming || false,
                hasApiKey: !!apiKey,
                requestSize: JSON.stringify(requestData).length
            });

            // Delegate to the LLMService for multi-provider support
            const result = await this.llmService.callLLM(requestData, apiKey, options);

            console.log('✅ LLM Response received:', {
                length: result?.length || 0,
                preview: result ? result.substring(0, 100) + '...' : 'EMPTY'
            });

            return result;
        } catch (error) {
            console.error('❌ LLM call error:', error.message);

            // Check if it's a network/connectivity error
            if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
                console.error('🚫 Network error - check connectivity and permissions');
            }

            // Check if it's an Ollama-specific error
            if (error.message.includes('Ollama server not running')) {
                console.error('💡 Tip: Start Ollama with: ollama serve');
            }

            throw error;
        }
    }

    /**
     * Cancel an active request
     * @param {string} requestId - Request ID to cancel
     */
    cancelRequest(requestId) {
        if (!this.activeRequests || !requestId) return;

        const controller = this.activeRequests.get(requestId);
        if (controller) {
            console.log('🛑 Cancelling request:', requestId);
            controller.abort();
            this.activeRequests.delete(requestId);
        }
    }

    /**
     * Safely extract error message from error object
     * @param {*} error - Error object, string, or any value
     * @returns {string} - Safe error message string
     */
    getErrorMessage(error) {
        if (!error) return 'Unknown error';

        // If it's already a string, return it
        if (typeof error === 'string') return error;

        // If it has a message property
        if (error.message) return error.message;

        // Try toString()
        try {
            return error.toString();
        } catch (e) {
            // Last resort
            return String(error);
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
        console.log('📍 handleStreamingResponse | isFromPopup:', options.isFromPopup, '| tabId:', tabId, '| requestId:', requestId);

        try {
            // eslint-disable-next-line no-constant-condition -- streaming reader loop, exits via break/return
            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    console.log(`✅ Stream complete - received ${chunkCount} chunks, total length: ${fullContent.length}`);

                    // Send final chunk with isLastChunk flag to signal completion
                    if (tabId) {
                        const finalMessage = {
                            action: 'TEST_CHUNK',
                            requestId: requestId || `stream_${tabId}_${Date.now()}`,
                            tabId: tabId,
                            data: {
                                chunk: '',
                                fullContent: fullContent,
                                progress: chunkCount,
                                isLastChunk: true  // Flag to signal stream completion
                            }
                        };

                        // Send ONLY to the origin that requested it
                        if (options.isFromPopup) {
                            // Request came from popup - send to popup only
                            finalMessage.targetInstance = 'popup';
                            chrome.runtime.sendMessage(finalMessage).catch((error) => {
                                console.debug('Could not send final chunk to popup:', error);
                            });
                        } else {
                            // Request came from content script - send to tab only
                            finalMessage.targetInstance = 'content';
                            chrome.tabs.sendMessage(tabId, finalMessage).catch((error) => {
                                console.debug('Could not send final chunk to tab:', error);
                            });
                        }
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
                                    const chunkMessage = {
                                        action: 'TEST_CHUNK',
                                        requestId: requestId || `stream_${tabId}_${Date.now()}`,
                                        tabId: tabId,
                                        data: {
                                            chunk: content,
                                            fullContent: fullContent,
                                            progress: chunkCount
                                        }
                                    };

                                    // Send ONLY to the origin that requested it
                                    if (options.isFromPopup) {
                                        // Request came from popup - send to popup only
                                        // Add targetInstance to ensure popup picks it up
                                        chunkMessage.targetInstance = 'popup';
                                        chrome.runtime.sendMessage(chunkMessage).catch((error) => {
                                            console.debug('Could not send chunk to popup:', error);
                                        });
                                    } else {
                                        // Request came from content script - send to tab only
                                        // Add targetInstance to ensure content script picks it up
                                        chunkMessage.targetInstance = 'content';
                                        chrome.tabs.sendMessage(tabId, chunkMessage).catch((error) => {
                                            console.debug('Could not send chunk to tab:', error);
                                        });
                                    }
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

    /**
     * Get decrypted settings - internal helper method
     */
    async getSettings() {
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

        return settings;
    }

    /**
     * Ensure `this.ragService` matches the embedding provider chosen in Settings.
     *
     * The service is constructed once at startup defaulting to 'local'. When the
     * user picks a different Embedding Provider (Settings → AI Configuration), the
     * stored `embeddingProvider` becomes the source of truth — rebuild the RAG
     * service so indexing AND retrieval use the same provider (mixing providers
     * produces dimension-mismatched vectors: local=384, OpenAI=1536). Callers must
     * invoke this before any index/retrieve operation. Switching providers requires
     * re-indexing, which the Settings UI calls out.
     */
    async ensureRagEmbeddingProvider() {
        try {
            const settings = await this.getStoredSettings();
            const desired = settings.embeddingProvider === 'openai' ? 'openai' : 'local';
            const apiKey = settings.apiKey || null;

            if (!this.ragService || this.ragService.provider !== desired) {
                console.log(`🔄 Rebuilding RAG service for embedding provider: ${desired}`);
                this.ragService = new RAGService({ provider: desired, apiKey });
                if (this.contextAnalyzer) {
                    this.contextAnalyzer.setRagService(this.ragService);
                }
            } else if (desired === 'openai') {
                // Same provider, but keep the OpenAI key fresh for embedding calls.
                this.ragService.apiKey = apiKey;
            }
        } catch (error) {
            console.warn('ensureRagEmbeddingProvider failed (keeping existing service):', error?.message);
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

        // Track keys whose ciphertext is unreadable so we can wipe them from
        // storage in one write. Without this, every getStoredSettings() call
        // re-attempts decryption of the same bad blob and re-logs the
        // failure forever.
        const corruptKeys = [];

        for (const key of sensitiveKeys) {
            if (settings[key]) {
                try {
                    const decrypted = await this.encryptionService.decrypt(settings[key]);
                    settings[key] = decrypted;
                } catch (_decryptError) {
                    // Already logged once by EncryptionService at warn level
                    // with an actionable reason. Self-heal: drop the value.
                    settings[key] = '';
                    corruptKeys.push(key);
                }
            }
        }

        if (corruptKeys.length > 0) {
            console.warn(
                `[settings] Cleared ${corruptKeys.length} unreadable credential(s): ${corruptKeys.join(', ')}. ` +
                `Re-enter them in Settings.`
            );
            const persisted = { ...(result.aiRepoSpectorSettings || {}) };
            for (const k of corruptKeys) delete persisted[k];
            try {
                await chrome.storage.local.set({ aiRepoSpectorSettings: persisted });
            } catch (e) {
                console.warn('[settings] Failed to persist cleared credentials:', e?.message);
            }
        }

        return settings;
    }

    /**
     * Save repository metadata after indexing
     */
    async saveRepoMetadata(repoId, url, platform, stats) {
        try {
            const result = await chrome.storage.local.get(['indexedReposMetadata']);
            const metadata = result.indexedReposMetadata || {};

            metadata[repoId] = {
                url,
                platform,
                indexedAt: Date.now(),
                chunksCount: stats.chunksIndexed,
                filesCount: stats.filesProcessed || 0
            };

            await chrome.storage.local.set({ indexedReposMetadata: metadata });
            console.log('📝 Saved repo metadata for:', repoId);
        } catch (error) {
            console.error('Failed to save repo metadata:', error);
        }
    }

    async _fetchRAGContextForMultiPass(repoId, prData, options) {
        if (options.useRepoContext === false) return null;
        try {
            const prDescription = `${prData.title} ${prData.description || ''}`;
            return await this.ragService.retrieveContext(repoId, prDescription, 20, {
                formatOutput: false, // Keep raw chunks for per-file distribution
                maxChunksPerFile: 4
            });
        } catch (e) {
            console.warn('RAG context not available:', e.message);
            return null;
        }
    }

    async _fetchRepoDocForMultiPass(repoId, options) {
        if (options.useRepoContext === false) return { found: false };
        try {
            return await this.ragService.getRepositoryDocumentation(repoId);
        } catch (e) {
            return { found: false };
        }
    }

    /**
     * #16c — Cost estimation using a per-model pricing table.
     * Prices are in USD per 1K tokens (input / output).
     * Returns 0 for unknown models so telemetry never breaks a review.
     */
    _estimateCost(model = '', tokensIn = 0, tokensOut = 0) {
        const PRICING = {
            // OpenAI
            'openai:gpt-4.1':         { in: 0.002,   out: 0.008 },
            'openai:gpt-4.1-mini':    { in: 0.0004,  out: 0.0016 },
            'openai:o1-mini':         { in: 0.003,   out: 0.012 },
            'openai:gpt-4o':          { in: 0.005,   out: 0.015 },
            // Anthropic
            'anthropic:claude-opus-4':          { in: 0.015,  out: 0.075 },
            'anthropic:claude-sonnet-4':        { in: 0.003,  out: 0.015 },
            'anthropic:claude-3.5-haiku':       { in: 0.0008, out: 0.004 },
            'anthropic:claude-3-5-sonnet-20241022': { in: 0.003, out: 0.015 },
            // Google
            'google:gemini-2.0-flash':      { in: 0.0001, out: 0.0004 },
            'google:gemini-2.0-pro':        { in: 0.0035, out: 0.0105 },
            'google:gemini-2.0-flash-lite': { in: 0.000075, out: 0.0003 },
            // Groq (free tier, near-zero cost estimate)
            'groq:llama-3.3-70b':           { in: 0.00059, out: 0.00079 },
            'groq:deepseek-r1-distill-llama-70b': { in: 0.00075, out: 0.00099 },
            'groq:mixtral-8x7b':            { in: 0.00024, out: 0.00024 },
            // Mistral
            'mistral:mistral-large':   { in: 0.003, out: 0.009 },
            'mistral:codestral':       { in: 0.001, out: 0.003 },
            'mistral:mistral-small':   { in: 0.0002, out: 0.0006 },
        };
        const price = PRICING[model];
        if (!price) return 0;
        return (tokensIn / 1000) * price.in + (tokensOut / 1000) * price.out;
    }

    /**
     * Update PR service with current tokens
     */
    async updatePRServiceTokens() {
        try {
            const settings = await this.getStoredSettings();
            this.pullRequestService.githubToken = settings.githubToken || null;
            this.pullRequestService.gitlabToken = settings.gitlabToken || null;
        } catch (e) {
            console.warn('Failed to update PR service tokens:', e);
        }
    }

    /**
     * Detect if PR is for a test automation project
     */
    isTestAutomationPR(prData) {
        // Check file patterns
        const testPatterns = [
            /\.(test|spec|e2e|integration)\.(js|ts|jsx|tsx|py|java|rb)$/,
            /tests?\//,
            /__tests__\//,
            /cypress\//,
            /playwright\//,
            /selenium\//,
            /conftest\.py$/,
            /(jest|playwright|cypress|vitest|pytest|karma|mocha)\.(config|setup)/
        ];

        const testFileCount = prData.files.filter(f =>
            testPatterns.some(p => p.test(f.filename))
        ).length;

        // If more than 50% of files are test files, it's likely a test automation repo
        return testFileCount > prData.files.length * 0.5;
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


    async _runHunkPrompt(systemPrompt, userPrompt) {
        const settings = await this.getStoredSettings();
        const response = await this.llmService.streamChat(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            {
                provider: settings.provider,
                model: settings.model,
                apiKey: settings.apiKey,
                stream: false
            }
        );
        return response.content || response;
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

// ─────────────────────────────────────────────────────────────────────────────
// Service worker bootstrap
// ─────────────────────────────────────────────────────────────────────────────

const backgroundServiceInstance = new BackgroundService();
console.log('🚀 BackgroundService initialized at startup');

// ─── Handler registry ────────────────────────────────────────────────────────
//
// Each entry maps a message type to a function with signature
//   (message, sendResponse, sender, ctx) => Promise<void>
// Most entries are thin adapters around `BackgroundService` instance methods
// whose argument order varies historically — this is the one place that knows
// about that variance. New handlers should be registered next to their feature
// module, not here.

const svc = backgroundServiceInstance;

// RAG handlers live in ./handlers/ragHandlers.js. `ragState` is the mutable
// holder that replaced the old module-level `ragService` variable.
const ragState = { service: null };
const ragHandlers = createRagHandlers({ svc, ragState, RAGService, GitHubService, GitLabService });
const cacheTelemetryHandlers = createCacheTelemetryHandlers(svc);
const settingsHandlers = createSettingsHandlers({ svc, FindingFollowupService });
const threadHandlers = createThreadHandlers(svc);
const analysisHandlers = createAnalysisHandlers(svc);
const contextHandlers = createContextHandlers(svc);
const indexingHandlers = createIndexingHandlers(svc);
const chatHandlers = createChatHandlers(svc);
const generatorHandlers = createGeneratorHandlers(svc);
const prReviewHandlers = createPrReviewHandlers(svc);

registerHandlers({
    // Test generation — handleGenerateTests stays on the class (invoked by processQueue)
    GENERATE_TESTS: (m, send, sender, ctx) => svc.handleGenerateTests(m, send, sender, ctx.isFromPopup),

    // Each domain's handlers live in its own module under ./handlers/ and
    // register itself here via a spread of its create<Domain>Handlers(svc) map.
    // PR-review handlers (analyze/security/multipass/static + post/hunks/fetch-full-file)
    // include the allowContentScript hunk actions.
    ...chatHandlers,
    ...settingsHandlers,
    ...contextHandlers,
    ...indexingHandlers,
    ...prReviewHandlers,
    ...threadHandlers,
    ...generatorHandlers,
    ...analysisHandlers,
    ...ragHandlers,
    ...cacheTelemetryHandlers,
});

// ─── Single onMessage listener ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    dispatch(request, sender, sendResponse, { errorHandler: backgroundServiceInstance.errorHandler });
    return true; // keep channel open for async response
});

// ─── #16d — Daily alarm: prune expired FindingCache and AdaptiveLearning entries ──

const DAILY_PRUNE_ALARM = 'rs-daily-prune';

chrome.alarms.get(DAILY_PRUNE_ALARM, (alarm) => {
    if (!alarm) {
        chrome.alarms.create(DAILY_PRUNE_ALARM, {
            delayInMinutes: 60,
            periodInMinutes: 24 * 60
        });
    }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== DAILY_PRUNE_ALARM) return;
    try {
        await backgroundServiceInstance.findingCache.pruneExpired();
        console.log('🧹 FindingCache pruned');
    } catch (e) {
        console.warn('FindingCache prune failed:', e.message);
    }
    try {
        await backgroundServiceInstance.adaptiveLearningService.cleanup?.();
        console.log('🧹 AdaptiveLearning pruned');
    } catch (e) {
        console.warn('AdaptiveLearning cleanup failed:', e.message);
    }
});
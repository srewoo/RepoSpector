// Background script for RepoSpector Chrome Extension
// Modern ES6 module-based implementation

import { EncryptionService } from '../utils/encryption.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { ContextAnalyzer } from '../utils/contextAnalyzer.js';
import { BatchProcessor } from '../utils/batchProcessor.js';
import { CodeChunker } from '../utils/chunking.js';
import { TestGenerator } from '../utils/testGenerator.js';
import { CacheManager } from '../utils/cacheManager.js';
import { PLATFORM_PATTERNS as _PLATFORM_PATTERNS } from '../utils/constants.js';

class BackgroundService {
    constructor() {
        this.encryptionService = new EncryptionService();
        this.errorHandler = new ErrorHandler();
        this.contextAnalyzer = new ContextAnalyzer();
        this.batchProcessor = new BatchProcessor();
        this.codeChunker = new CodeChunker();
        this.testGenerator = new TestGenerator();
        this.cacheManager = new CacheManager();
        this.isProcessing = false;
        this.processingQueue = [];
        
        this.setupMessageHandlers();
        this.setupInstallHandler();
    }

    setupInstallHandler() {
        chrome.runtime.onInstalled.addListener(async (details) => {
            console.log('RepoSpector installed:', details.reason);
            
            // Load settings on install
            await this.loadSettings();
            
            // Initialize cache
            await this.cacheManager.initialize();
            
            // Set up context menus
            this.setupContextMenus();
        });
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
        const { tabId, options, code, context } = message.data;
        
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
            
            let extractedCode = code;
            let extractedContext = context;
            
            // If code is not provided, extract it from the tab
            if (!extractedCode && tabId) {
                try {
                    // First, try to send message to existing content script
                    let extractionResult;
                    try {
                        extractionResult = await chrome.tabs.sendMessage(tabId, {
                            type: 'EXTRACT_CODE',
                            options: {
                                contextLevel: options.contextLevel || 'smart'
                            }
                        });
                    } catch (contentScriptError) {
                        // Content script not loaded, try to inject it
                        console.log('Content script not found, attempting dynamic injection...');
                        
                        try {
                            await chrome.scripting.executeScript({
                                target: { tabId: tabId },
                                files: ['content.js']
                            });
                            
                            // Wait a moment for the script to initialize
                            await new Promise(resolve => setTimeout(resolve, 500));
                            
                            // Try again
                            extractionResult = await chrome.tabs.sendMessage(tabId, {
                                type: 'EXTRACT_CODE',
                                options: {
                                    contextLevel: options.contextLevel || 'smart'
                                }
                            });
                        } catch (injectionError) {
                            // Fallback: try legacy extraction method
                            console.log('Dynamic injection failed, trying legacy method...');
                            extractionResult = await chrome.tabs.sendMessage(tabId, {
                                action: 'extractCode'
                            });
                        }
                    }
                    
                    if (extractionResult?.success) {
                        // Handle both new format (data.code) and legacy format (code)
                        if (extractionResult.data) {
                            extractedCode = extractionResult.data.code;
                            extractedContext = extractionResult.data.context || {};
                        } else if (extractionResult.code) {
                            extractedCode = extractionResult.code;
                            extractedContext = {};
                        } else {
                            throw new Error('No code found in extraction result');
                        }
                    } else {
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
            if (!settings.apiKey) {
                throw new Error('OpenAI API key not configured');
            }

            // Analyze context for intelligent test generation
            const enhancedContext = await this.contextAnalyzer.analyzeWithContext(extractedCode, {
                url: extractedContext?.url || 'unknown',
                level: options.contextLevel || 'smart',
                platform: extractedContext?.platform || 'unknown'
            });

            // Generate intelligent test suite using the new TestGenerator
            await this.testGenerator.generateTestSuite(enhancedContext, {
                testTypes: Array.isArray(options.testType) ? options.testType : [options.testType || 'unit'],
                framework: 'auto',
                includeSetup: true,
                generateMocks: true,
                coverage: options.contextLevel === 'full' ? 'comprehensive' : 'standard'
            });

            // Determine if chunking is needed
            const modelName = settings.model || 'gpt-4o-mini';
            const estimatedTokens = this.codeChunker.estimateTokens(extractedCode);
            const maxTokens = this.codeChunker.getMaxTokensForModel(modelName);

            let testResults;
            
            if (estimatedTokens > maxTokens * 0.8) { // Use chunking if > 80% of model limit
                console.log('Using chunked processing for large codebase');
                testResults = await this.processWithChunking(extractedCode, options, enhancedContext, settings);
            } else {
                console.log('Using direct processing for small/medium codebase');
                testResults = await this.processDirect(extractedCode, options, enhancedContext, settings);
            }

            // Cache results if enabled
            if (settings.enableCache) {
                await this.cacheResults(extractedCode, options, testResults);
            }

            this.isProcessing = false;
            this.processQueue(); // Process next item in queue

            sendResponse({
                success: true,
                testCases: testResults,
                context: enhancedContext,
                metadata: {
                    model: modelName,
                    chunked: estimatedTokens > maxTokens * 0.8,
                    tokensUsed: estimatedTokens
                }
            });

        } catch (error) {
            this.isProcessing = false;
            this.processQueue();
            
            this.errorHandler.logError('Test generation', error);
            sendResponse({ 
                success: false, 
                error: error.message,
                retry: this.errorHandler.shouldRetry(error)
            });
        }
    }

    async processWithChunking(code, options, context, settings) {
        const chunks = this.codeChunker.createSemanticChunks(code, settings.model);
        
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
                    if (tabs[0]) {
                        chrome.tabs.sendMessage(tabs[0].id, {
                            type: 'PROGRESS_UPDATE',
                            data: progress
                        }).catch(() => {}); // Ignore if popup is closed
                    }
                });
            }
        );

        // Merge results intelligently
        return this.batchProcessor.mergeResults(results, 'intelligent');
    }

    async processDirect(code, options, context, settings) {
        const prompt = this.buildTestGenerationPrompt(code, options, context);
        
        return await this.callOpenAI({
            model: settings.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: 4000
        }, settings.apiKey);
    }

    async generateTestsForChunk(chunk, options, settings) {
        const prompt = this.buildTestGenerationPrompt(chunk.content, options, chunk.context);
        
        return await this.callOpenAI({
            model: settings.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: 2000
        }, settings.apiKey);
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
- Language: ${context.language || 'JavaScript'}
- File: ${context.filePath || 'unknown'}
- Testing Framework: ${context.testingFramework || 'Jest (default)'}
- Context Level: ${options.contextLevel || 'smart'}
- E2E Framework: ${options.e2eFramework || 'Playwright'}
`;
        } else {
            prompt = `You are an expert test engineer. Generate comprehensive ${testType} tests for the following code.

**Context Information:**
- Language: ${context.language || 'JavaScript'}
- File: ${context.filePath || 'unknown'}
- Testing Framework: ${context.testingFramework || 'Jest (default)'}
- Context Level: ${options.contextLevel || 'smart'}
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
        const e2eFramework = options.e2eFramework || 'Playwright';
        
        return `
**RESPONSE FORMAT:**
Provide complete, runnable test code for ALL applicable test types. Structure as follows:

# Comprehensive Test Suite

## 1. Unit Tests
\`\`\`javascript
// Unit tests using Jest/Vitest
describe('Unit Tests - [Component/Function Name]', () => {
  // Setup and teardown
  beforeEach(() => {
    // Test setup
  });

  afterEach(() => {
    // Cleanup
  });

  // Positive test cases
  describe('Positive Cases', () => {
    test('should [expected behavior]', () => {
      // Test implementation
    });
  });

  // Negative test cases
  describe('Error Handling', () => {
    test('should handle [error condition]', () => {
      // Error test implementation
    });
  });

  // Edge cases
  describe('Edge Cases', () => {
    test('should handle [edge condition]', () => {
      // Edge case implementation
    });
  });
});
\`\`\`

## 2. Integration Tests
\`\`\`javascript
// Integration tests
describe('Integration Tests - [Component Integration]', () => {
  // Integration test setup
  beforeAll(async () => {
    // Setup test environment
  });

  afterAll(async () => {
    // Cleanup resources
  });

  describe('Component Integration', () => {
    test('should integrate [components] correctly', async () => {
      // Integration test implementation
    });
  });

  describe('Data Flow', () => {
    test('should pass data between [components]', async () => {
      // Data flow test implementation
    });
  });
});
\`\`\`

## 3. API Tests (if applicable)
\`\`\`javascript
// API tests using supertest or similar
describe('API Tests - [Endpoint Name]', () => {
  describe('Endpoint Validation', () => {
    test('should respond to valid requests', async () => {
      // API test implementation
    });

    test('should validate request parameters', async () => {
      // Parameter validation tests
    });

    test('should handle authentication', async () => {
      // Auth tests
    });
  });

  describe('Error Handling', () => {
    test('should return appropriate errors', async () => {
      // Error response tests
    });
  });
});
\`\`\`

## 4. End-to-End Tests (if applicable)
\`\`\`javascript
// E2E tests using ${e2eFramework}
${e2eFramework === 'Playwright' ? `
import { test, expect } from '@playwright/test';

test.describe('E2E Tests - [Feature Name]', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to application
  });

  test('should complete [user workflow]', async ({ page }) => {
    // E2E test implementation
  });

  test('should handle [user interaction]', async ({ page }) => {
    // User interaction tests
  });
});
` : e2eFramework === 'Cypress' ? `
describe('E2E Tests - [Feature Name]', () => {
  beforeEach(() => {
    // Setup and navigation
  });

  it('should complete [user workflow]', () => {
    // Cypress E2E implementation
  });

  it('should handle [user interaction]', () => {
    // User interaction tests
  });
});
` : `
// E2E tests using ${e2eFramework}
describe('E2E Tests - [Feature Name]', () => {
  beforeEach(async () => {
    // Setup test environment
  });

  test('should complete [user workflow]', async () => {
    // E2E test implementation
  });
});
`}
\`\`\`

**Guidelines:**
- Include proper setup and teardown for each test type
- Add descriptive test names and comments
- Mock external dependencies appropriately
- Include both positive and negative test cases
- Ensure tests are independent and can run in any order
- Add appropriate assertions for each test type`;
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
**Guidelines:**
- Provide complete, runnable test code
- Include setup and teardown when needed
- Add descriptive test names and comments
- Mock external dependencies appropriately
- Include both positive and negative test cases

**Response Format:**
Return only the test code, properly formatted and ready to run.`;
    }

    async callOpenAI(requestData, apiKey) {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(requestData)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error?.message || `API request failed: ${response.status}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
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
            
            // Encrypt API key before storing
            if (settings.apiKey) {
                settings.apiKey = await this.encryptionService.encrypt(settings.apiKey);
            }
            
            await chrome.storage.local.set({ aiRepoSpectorSettings: settings });
            
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
            
            // Decrypt API key if present
            if (settings.apiKey) {
                try {
                    settings.apiKey = await this.encryptionService.decrypt(settings.apiKey);
                } catch (decryptError) {
                    console.warn('Failed to decrypt API key, clearing it');
                    settings.apiKey = '';
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
        const result = await chrome.storage.local.get('aiRepoSpectorSettings');
        const settings = result.aiRepoSpectorSettings || {};
        
        if (settings.apiKey) {
            settings.apiKey = await this.encryptionService.decrypt(settings.apiKey);
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
                chrome.contextMenus.create({
                    id: 'generateTests',
                    title: 'Generate Test Cases',
                    contexts: ['selection', 'page']
                });
                
                chrome.contextMenus.create({
                    id: 'analyzeCode',
                    title: 'Analyze Code Structure',
                    contexts: ['selection', 'page']
                });
            });
        } catch (error) {
            console.warn('Failed to setup context menus:', error);
        }
    }
}

// Initialize the background service
new BackgroundService(); 
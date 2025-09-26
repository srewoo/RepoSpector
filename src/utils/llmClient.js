// Advanced Multi-LLM Client with fallback capabilities and offline support
// Addresses weakness: API dependency risks, provides multiple providers

import {
    LLM_PROVIDERS,
    API_ENDPOINTS,
    MODELS
} from './constants.js';
import { ErrorHandler } from './errorHandler.js';
import { CacheManager } from './cacheManager.js';

export class MultiLLMClient {
    constructor() {
        this.errorHandler = new ErrorHandler();
        this.cacheManager = new CacheManager();
        this.providers = new Map();
        this.fallbackOrder = [];
        this.requestQueue = [];
        this.isProcessing = false;
        this.healthStatus = new Map();

        this.initializeProviders();
        this.startHealthMonitoring();
    }

    /**
     * Initialize all LLM providers
     */
    async initializeProviders() {
        // Initialize OpenAI provider
        this.providers.set(LLM_PROVIDERS.OPENAI, new OpenAIProvider());

        // Initialize Anthropic provider
        this.providers.set(LLM_PROVIDERS.ANTHROPIC, new AnthropicProvider());

        // Initialize Google provider
        this.providers.set(LLM_PROVIDERS.GOOGLE, new GoogleProvider());

        // Initialize Cohere provider
        this.providers.set(LLM_PROVIDERS.COHERE, new CohereProvider());

        // Initialize Mistral provider
        this.providers.set(LLM_PROVIDERS.MISTRAL, new MistralProvider());

        // Initialize Groq provider
        this.providers.set(LLM_PROVIDERS.GROQ, new GroqProvider());

        // Initialize local provider
        this.providers.set(LLM_PROVIDERS.LOCAL, new LocalProvider());

        // Set default fallback order based on reliability and cost
        this.fallbackOrder = [
            LLM_PROVIDERS.OPENAI,
            LLM_PROVIDERS.ANTHROPIC,
            LLM_PROVIDERS.GOOGLE,
            LLM_PROVIDERS.GROQ,
            LLM_PROVIDERS.COHERE,
            LLM_PROVIDERS.MISTRAL,
            LLM_PROVIDERS.LOCAL
        ];
    }

    /**
     * Generate test cases with intelligent provider selection and fallback
     */
    async generateTestCases(request) {
        const {
            code,
            context,
            options = {},
            preferredProvider = null,
            preferredModel = null
        } = request;

        // Check cache first
        const cacheKey = this.generateCacheKey(code, context, options);
        const cached = await this.cacheManager.get(cacheKey);
        if (cached && !options.forceFresh) {
            return {
                ...cached,
                fromCache: true,
                provider: cached.provider,
                model: cached.model
            };
        }

        // Determine provider order
        let providerOrder = [...this.fallbackOrder];
        if (preferredProvider && this.providers.has(preferredProvider)) {
            providerOrder = [preferredProvider, ...providerOrder.filter(p => p !== preferredProvider)];
        }

        // Try providers in order
        let lastError = null;
        for (const providerName of providerOrder) {
            const provider = this.providers.get(providerName);
            if (!provider || !await this.isProviderHealthy(providerName)) {
                continue;
            }

            try {
                // Select best model for this provider
                const selectedModel = this.selectOptimalModel(providerName, preferredModel, options);
                if (!selectedModel) continue;

                console.log(`Attempting test generation with ${providerName}:${selectedModel}`);

                // Generate with timeout and retry
                const result = await this.withRetry(async () => {
                    return await provider.generateTests({
                        code,
                        context,
                        options,
                        model: selectedModel
                    });
                }, 3);

                // Validate result quality
                const validationResult = await this.validateTestQuality(result, code, context);
                if (!validationResult.isValid && options.requireValidation !== false) {
                    throw new Error(`Generated tests failed validation: ${validationResult.issues.join(', ')}`);
                }

                // Cache successful result
                const response = {
                    ...result,
                    provider: providerName,
                    model: selectedModel,
                    quality: validationResult,
                    timestamp: Date.now(),
                    fromCache: false
                };

                await this.cacheManager.set(cacheKey, response);
                return response;

            } catch (error) {
                console.warn(`Provider ${providerName} failed:`, error.message);
                lastError = error;

                // Mark provider as temporarily unhealthy if it's a server error
                if (this.isServerError(error)) {
                    this.markProviderUnhealthy(providerName, 300000); // 5 minutes timeout
                }

                continue;
            }
        }

        // All providers failed - try offline fallback
        try {
            return await this.generateOfflineFallback(code, context, options);
        } catch (offlineError) {
            throw new Error(`All providers failed. Last error: ${lastError?.message || 'Unknown error'}`);
        }
    }

    /**
     * Select optimal model based on requirements
     */
    selectOptimalModel(providerName, preferredModel, options) {
        const availableModels = Object.entries(MODELS)
            .filter(([_key, model]) => model.provider === providerName)
            .map(([key, model]) => ({ key, ...model }));

        if (!availableModels.length) return null;

        // If specific model requested and available
        if (preferredModel && availableModels.find(m => m.key === preferredModel)) {
            return preferredModel;
        }

        // Select based on requirements
        const requirements = {
            maxCost: options.maxCost || Infinity,
            minQuality: options.minQuality || 'good',
            maxLatency: options.maxLatency || Infinity,
            requiresImages: options.requiresImages || false,
            contextSize: this.estimateTokens(options.code || '') + this.estimateTokens(JSON.stringify(options.context || {}))
        };

        // Filter models that meet requirements
        let suitableModels = availableModels.filter(model => {
            return (
                model.contextWindow >= requirements.contextSize &&
                (!requirements.requiresImages || model.supportsImages) &&
                model.costPer1kTokens.input <= requirements.maxCost &&
                this.getQualityScore(model.quality) >= this.getQualityScore(requirements.minQuality)
            );
        });

        if (!suitableModels.length) {
            // Fallback to largest context model
            suitableModels = availableModels.sort((a, b) => b.contextWindow - a.contextWindow);
        }

        // Sort by preference: quality -> cost -> context size
        suitableModels.sort((a, b) => {
            const qualityDiff = this.getQualityScore(b.quality) - this.getQualityScore(a.quality);
            if (qualityDiff !== 0) return qualityDiff;

            const costDiff = a.costPer1kTokens.input - b.costPer1kTokens.input;
            if (costDiff !== 0) return costDiff;

            return b.contextWindow - a.contextWindow;
        });

        return suitableModels[0]?.key || null;
    }

    /**
     * Generate offline fallback using templates and patterns
     */
    async generateOfflineFallback(code, context, options) {
        console.log('Falling back to offline template-based generation');

        try {
            const templateGenerator = new OfflineTemplateGenerator();
            return await templateGenerator.generate(code, context, options);
        } catch (error) {
            throw new Error(`Offline fallback failed: ${error.message}`);
        }
    }

    /**
     * Validate generated test quality
     */
    async validateTestQuality(result, originalCode, context) {
        try {
            const validator = new TestQualityValidator();
            return await validator.validate(result, originalCode, context);
        } catch (error) {
            console.warn('Test validation failed:', error);
            return {
                isValid: true, // Don't block on validation errors
                score: 0,
                issues: [`Validation error: ${error.message}`],
                suggestions: []
            };
        }
    }

    /**
     * Provider health monitoring
     */
    async startHealthMonitoring() {
        setInterval(async () => {
            for (const [providerName, _provider] of this.providers) {
                try {
                    const isHealthy = await this.checkProviderHealth(providerName);
                    this.healthStatus.set(providerName, {
                        healthy: isHealthy,
                        lastChecked: Date.now(),
                        consecutiveFailures: isHealthy ? 0 : (this.healthStatus.get(providerName)?.consecutiveFailures || 0) + 1
                    });
                } catch (error) {
                    console.warn(`Health check failed for ${providerName}:`, error);
                }
            }
        }, 60000); // Check every minute
    }

    async checkProviderHealth(providerName) {
        const provider = this.providers.get(providerName);
        if (!provider) return false;

        try {
            return await provider.healthCheck();
        } catch (error) {
            return false;
        }
    }

    async isProviderHealthy(providerName) {
        const status = this.healthStatus.get(providerName);
        if (!status) return true; // Assume healthy if not checked yet

        return status.healthy && status.consecutiveFailures < 3;
    }

    markProviderUnhealthy(providerName, timeoutMs) {
        this.healthStatus.set(providerName, {
            healthy: false,
            lastChecked: Date.now(),
            consecutiveFailures: 999,
            timeoutUntil: Date.now() + timeoutMs
        });
    }

    /**
     * Utility methods
     */
    generateCacheKey(code, context, options) {
        const data = {
            codeHash: this.hashString(code),
            contextHash: this.hashString(JSON.stringify(context)),
            optionsHash: this.hashString(JSON.stringify(options))
        };
        return `test_generation_${this.hashString(JSON.stringify(data))}`;
    }

    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(36);
    }

    estimateTokens(text) {
        return Math.ceil((text || '').length / 4);
    }

    getQualityScore(quality) {
        const scores = { good: 1, high: 2, premium: 3 };
        return scores[quality] || 0;
    }

    isServerError(error) {
        return error.status >= 500 ||
               error.message.includes('timeout') ||
               error.message.includes('unavailable') ||
               error.message.includes('server error');
    }

    async withRetry(operation, maxRetries = 3) {
        let lastError;
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                if (i < maxRetries - 1) {
                    await this.delay(Math.pow(2, i) * 1000); // Exponential backoff
                }
            }
        }
        throw lastError;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

/**
 * Base provider class
 */
class BaseProvider {
    constructor(providerName) {
        this.providerName = providerName;
        this.errorHandler = new ErrorHandler();
    }

    async generateTests(_request) {
        throw new Error('generateTests must be implemented by provider');
    }

    async healthCheck() {
        return true; // Default implementation
    }

    buildHeaders(apiKey, additionalHeaders = {}) {
        return {
            'Content-Type': 'application/json',
            'User-Agent': 'RepoSpector/2.0',
            ...additionalHeaders,
            ...(apiKey && { 'Authorization': this.getAuthHeader(apiKey) })
        };
    }

    getAuthHeader(apiKey) {
        return `Bearer ${apiKey}`;
    }

    async makeRequest(url, options = {}) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), options.timeout || 30000);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            return await response.json();
        } finally {
            clearTimeout(timeoutId);
        }
    }
}

/**
 * OpenAI Provider
 */
class OpenAIProvider extends BaseProvider {
    constructor() {
        super(LLM_PROVIDERS.OPENAI);
    }

    async generateTests(request) {
        const { code, context, options, model } = request;
        const settings = await this.getSettings();

        if (!settings.openaiApiKey) {
            throw new Error('OpenAI API key not configured');
        }

        const modelConfig = MODELS[model];
        if (!modelConfig) {
            throw new Error(`Model ${model} not found`);
        }

        const messages = [
            {
                role: 'system',
                content: this.buildSystemPrompt(options)
            },
            {
                role: 'user',
                content: this.buildUserPrompt(code, context, options)
            }
        ];

        const response = await this.makeRequest(API_ENDPOINTS[LLM_PROVIDERS.OPENAI].chat, {
            method: 'POST',
            headers: this.buildHeaders(settings.openaiApiKey),
            body: JSON.stringify({
                model: modelConfig.modelId,
                messages,
                max_tokens: Math.min(modelConfig.maxTokens, 4000),
                temperature: 0.1,
                top_p: 0.95
            })
        });

        return {
            testCases: response.choices[0].message.content,
            usage: response.usage,
            model: model,
            provider: this.providerName
        };
    }

    async healthCheck() {
        try {
            const settings = await this.getSettings();
            if (!settings.openaiApiKey) return false;

            const response = await this.makeRequest(API_ENDPOINTS[LLM_PROVIDERS.OPENAI].models, {
                method: 'GET',
                headers: this.buildHeaders(settings.openaiApiKey),
                timeout: 5000
            });

            return Array.isArray(response.data) && response.data.length > 0;
        } catch (error) {
            return false;
        }
    }

    buildSystemPrompt(options) {
        return `You are an expert software testing engineer. Generate comprehensive, production-ready test cases that follow best practices for ${options.testType || 'unit'} testing.

Focus on:
- Complete test coverage for all functions and edge cases
- Proper mocking and setup/teardown
- Clear, descriptive test names
- Error handling and boundary conditions
- Performance and security considerations
- Framework-specific best practices

Generate syntactically correct, runnable tests that require minimal manual adjustment.`;
    }

    buildUserPrompt(code, context, options) {
        return `Generate ${options.testType || 'unit'} tests for the following code:

**Code:**
\`\`\`${context.language || 'javascript'}
${code}
\`\`\`

**Context:**
- Language: ${context.language || 'javascript'}
- Framework: ${context.testingFramework || 'auto-detect'}
- Project Type: ${context.projectType || 'unknown'}
- Dependencies: ${context.dependencies?.map(d => d.name).join(', ') || 'none'}

**Requirements:**
- Generate tests for ALL functions, methods, and classes
- Include positive, negative, and edge case tests
- Add proper setup/teardown code
- Mock external dependencies
- Follow ${context.testingFramework || 'Jest'} syntax
- Ensure 100% function coverage

Return only the test code, ready to run.`;
    }

    async getSettings() {
        try {
            const result = await chrome.storage.local.get(['repoSpectorSettings']);
            return result.repoSpectorSettings || {};
        } catch (error) {
            return {};
        }
    }
}

/**
 * Anthropic Provider
 */
class AnthropicProvider extends BaseProvider {
    constructor() {
        super(LLM_PROVIDERS.ANTHROPIC);
    }

    getAuthHeader(apiKey) {
        return `Bearer ${apiKey}`;
    }

    async generateTests(request) {
        const { code, context, options, model } = request;
        const settings = await this.getSettings();

        if (!settings.anthropicApiKey) {
            throw new Error('Anthropic API key not configured');
        }

        const modelConfig = MODELS[model];
        const prompt = this.buildUserPrompt(code, context, options);

        const response = await this.makeRequest(API_ENDPOINTS[LLM_PROVIDERS.ANTHROPIC].chat, {
            method: 'POST',
            headers: {
                ...this.buildHeaders(settings.anthropicApiKey),
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: modelConfig.modelId,
                max_tokens: Math.min(modelConfig.maxTokens, 4000),
                messages: [{
                    role: 'user',
                    content: prompt
                }],
                temperature: 0.1
            })
        });

        return {
            testCases: response.content[0].text,
            usage: response.usage,
            model: model,
            provider: this.providerName
        };
    }

    async healthCheck() {
        // Anthropic doesn't have a simple health check endpoint
        return true;
    }

    buildUserPrompt(code, context, options) {
        return `You are an expert software testing engineer. Generate comprehensive test cases for the following code.

**Code to Test:**
\`\`\`${context.language || 'javascript'}
${code}
\`\`\`

**Context:**
- Language: ${context.language || 'javascript'}
- Testing Framework: ${context.testingFramework || 'Jest'}
- Test Type: ${options.testType || 'unit'}
- Quality Level: Premium (generate exhaustive tests)

**Requirements:**
1. Generate tests for EVERY function, method, and class in the code
2. Include comprehensive test cases:
   - Happy path scenarios
   - Edge cases and boundary conditions
   - Error handling and exceptions
   - Input validation
   - State transitions (for stateful code)
3. Use proper mocking for external dependencies
4. Add detailed setup and teardown
5. Follow ${context.testingFramework || 'Jest'} best practices
6. Ensure tests are production-ready

Generate complete, runnable test code with proper imports and structure.`;
    }

    async getSettings() {
        try {
            const result = await chrome.storage.local.get(['repoSpectorSettings']);
            return result.repoSpectorSettings || {};
        } catch (error) {
            return {};
        }
    }
}

/**
 * Google Provider
 */
class GoogleProvider extends BaseProvider {
    constructor() {
        super(LLM_PROVIDERS.GOOGLE);
    }

    getAuthHeader(apiKey) {
        return `Bearer ${apiKey}`;
    }

    async generateTests(request) {
        const { code, context, options, model } = request;
        const settings = await this.getSettings();

        if (!settings.googleApiKey) {
            throw new Error('Google API key not configured');
        }

        const modelConfig = MODELS[model];
        const url = API_ENDPOINTS[LLM_PROVIDERS.GOOGLE].chat.replace('{{model}}', modelConfig.modelId);

        const response = await this.makeRequest(`${url}?key=${settings.googleApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: this.buildUserPrompt(code, context, options)
                    }]
                }],
                generationConfig: {
                    maxOutputTokens: Math.min(modelConfig.maxTokens, 4000),
                    temperature: 0.1,
                    topP: 0.95
                }
            })
        });

        return {
            testCases: response.candidates[0].content.parts[0].text,
            usage: response.usageMetadata,
            model: model,
            provider: this.providerName
        };
    }

    buildUserPrompt(code, context, options) {
        return `Generate comprehensive ${options.testType || 'unit'} tests for this code:

Code:
\`\`\`${context.language || 'javascript'}
${code}
\`\`\`

Requirements:
- Test ALL functions and methods
- Include edge cases and error scenarios
- Use ${context.testingFramework || 'Jest'} framework
- Add proper mocks and setup
- Generate production-ready code

Return complete test file with imports.`;
    }

    async getSettings() {
        try {
            const result = await chrome.storage.local.get(['repoSpectorSettings']);
            return result.repoSpectorSettings || {};
        } catch (error) {
            return {};
        }
    }
}

// Additional providers (Cohere, Mistral, Groq) follow similar patterns...
class CohereProvider extends BaseProvider {
    constructor() {
        super(LLM_PROVIDERS.COHERE);
    }

    async generateTests(_request) {
        // Implementation similar to OpenAI but with Cohere-specific format
        throw new Error('Cohere provider not yet implemented');
    }
}

class MistralProvider extends BaseProvider {
    constructor() {
        super(LLM_PROVIDERS.MISTRAL);
    }

    async generateTests(_request) {
        // Implementation similar to OpenAI but with Mistral-specific format
        throw new Error('Mistral provider not yet implemented');
    }
}

class GroqProvider extends BaseProvider {
    constructor() {
        super(LLM_PROVIDERS.GROQ);
    }

    async generateTests(request) {
        // Groq uses OpenAI-compatible API
        const { code, context, options, model } = request;
        const settings = await this.getSettings();

        if (!settings.groqApiKey) {
            throw new Error('Groq API key not configured');
        }

        const modelConfig = MODELS[model];
        const messages = [
            {
                role: 'system',
                content: 'You are an expert test engineer. Generate comprehensive, production-ready test cases.'
            },
            {
                role: 'user',
                content: this.buildUserPrompt(code, context, options)
            }
        ];

        const response = await this.makeRequest(API_ENDPOINTS[LLM_PROVIDERS.GROQ].chat, {
            method: 'POST',
            headers: this.buildHeaders(settings.groqApiKey),
            body: JSON.stringify({
                model: modelConfig.modelId,
                messages,
                max_tokens: Math.min(modelConfig.maxTokens, 4000),
                temperature: 0.1
            })
        });

        return {
            testCases: response.choices[0].message.content,
            usage: response.usage,
            model: model,
            provider: this.providerName
        };
    }

    buildUserPrompt(code, context, options) {
        return `Generate ${options.testType || 'unit'} tests for ALL functions in this code:

\`\`\`${context.language}
${code}
\`\`\`

Framework: ${context.testingFramework || 'Jest'}
Generate complete, runnable tests covering all functions and edge cases.`;
    }

    async getSettings() {
        try {
            const result = await chrome.storage.local.get(['repoSpectorSettings']);
            return result.repoSpectorSettings || {};
        } catch (error) {
            return {};
        }
    }
}

/**
 * Local Provider (Ollama/LocalAI)
 */
class LocalProvider extends BaseProvider {
    constructor() {
        super(LLM_PROVIDERS.LOCAL);
    }

    async generateTests(request) {
        const { code, context, options, model } = request;

        try {
            const response = await this.makeRequest(API_ENDPOINTS[LLM_PROVIDERS.LOCAL].chat, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: MODELS[model].modelId,
                    messages: [{
                        role: 'user',
                        content: this.buildUserPrompt(code, context, options)
                    }],
                    stream: false
                }),
                timeout: 60000 // Local models can be slower
            });

            return {
                testCases: response.message?.content || response.response,
                model: model,
                provider: this.providerName
            };
        } catch (error) {
            throw new Error(`Local LLM server unavailable: ${error.message}`);
        }
    }

    async healthCheck() {
        try {
            const response = await this.makeRequest(API_ENDPOINTS[LLM_PROVIDERS.LOCAL].models, {
                timeout: 5000
            });
            return Array.isArray(response.models) && response.models.length > 0;
        } catch (error) {
            return false;
        }
    }

    buildUserPrompt(code, context, options) {
        return `Generate comprehensive test cases for this ${context.language} code:

${code}

Create ${options.testType || 'unit'} tests using ${context.testingFramework || 'Jest'}. Include all functions and edge cases.`;
    }
}

/**
 * Offline Template Generator (fallback when no LLM available)
 */
class OfflineTemplateGenerator {
    async generate(code, context, options) {
        console.log('Using offline template-based test generation');

        const analyzer = new OfflineCodeAnalyzer();
        const analysis = analyzer.analyze(code, context.language);

        const templates = new TestTemplateEngine();
        const tests = await templates.generateFromAnalysis(analysis, context, options);

        return {
            testCases: tests,
            provider: 'offline',
            model: 'template-based',
            quality: { score: 50, isValid: true, issues: [], suggestions: ['Generated from templates - may need manual review'] }
        };
    }
}

/**
 * Test Quality Validator
 */
class TestQualityValidator {
    async validate(result, originalCode, context) {
        const issues = [];
        const suggestions = [];
        let score = 100;

        try {
            // Check if result contains test code
            if (!result.testCases || typeof result.testCases !== 'string') {
                issues.push('No test code generated');
                score = 0;
                return { isValid: false, score, issues, suggestions };
            }

            // Basic syntax validation
            const syntaxValid = await this.validateSyntax(result.testCases, context.language);
            if (!syntaxValid.valid) {
                issues.push(`Syntax errors: ${syntaxValid.errors.join(', ')}`);
                score -= 30;
            }

            // Check for test structure
            const hasTests = this.hasTestStructure(result.testCases);
            if (!hasTests) {
                issues.push('No recognizable test structure found');
                score -= 40;
            }

            // Check coverage (basic function counting)
            const coverage = this.estimateCoverage(result.testCases, originalCode);
            if (coverage < 50) {
                issues.push(`Low estimated coverage: ${coverage}%`);
                score -= 20;
                suggestions.push('Consider generating tests for all functions');
            }

            // Check for best practices
            const bestPractices = this.checkBestPractices(result.testCases);
            score += bestPractices.score;
            suggestions.push(...bestPractices.suggestions);

            return {
                isValid: score > 30,
                score: Math.max(0, score),
                issues,
                suggestions
            };

        } catch (error) {
            return {
                isValid: true, // Don't fail on validation errors
                score: 0,
                issues: [`Validation failed: ${error.message}`],
                suggestions: ['Manual review recommended']
            };
        }
    }

    async validateSyntax(testCode, language) {
        // Basic syntax validation - could be enhanced with actual parsers
        const issues = [];

        if (language === 'javascript' || language === 'typescript') {
            // Check for basic JS/TS syntax issues
            const braceCount = (testCode.match(/\{/g) || []).length - (testCode.match(/\}/g) || []).length;
            if (braceCount !== 0) issues.push('Unmatched braces');

            const parenCount = (testCode.match(/\(/g) || []).length - (testCode.match(/\)/g) || []).length;
            if (parenCount !== 0) issues.push('Unmatched parentheses');
        }

        return {
            valid: issues.length === 0,
            errors: issues
        };
    }

    hasTestStructure(testCode) {
        const testPatterns = [
            /describe\s*\(/gi,
            /it\s*\(/gi,
            /test\s*\(/gi,
            /@Test/gi,
            /def\s+test_/gi
        ];

        return testPatterns.some(pattern => pattern.test(testCode));
    }

    estimateCoverage(testCode, originalCode) {
        // Simple heuristic: count function names in original code vs test code
        const functionNames = this.extractFunctionNames(originalCode);
        if (functionNames.length === 0) return 100; // No functions to test

        const testedFunctions = functionNames.filter(name =>
            testCode.toLowerCase().includes(name.toLowerCase())
        );

        return Math.round((testedFunctions.length / functionNames.length) * 100);
    }

    extractFunctionNames(code) {
        const patterns = [
            /function\s+(\w+)/gi,
            /const\s+(\w+)\s*=/gi,
            /(\w+)\s*\(/gi
        ];

        const names = new Set();
        patterns.forEach(pattern => {
            let match;
            while ((match = pattern.exec(code)) !== null) {
                names.add(match[1]);
            }
        });

        return Array.from(names);
    }

    checkBestPractices(testCode) {
        let score = 0;
        const suggestions = [];

        // Check for setup/teardown
        if (/beforeEach|beforeAll|setUp/gi.test(testCode)) score += 10;
        else suggestions.push('Consider adding test setup');

        // Check for mocking
        if (/mock|stub|spy/gi.test(testCode)) score += 10;
        else suggestions.push('Consider mocking external dependencies');

        // Check for assertions
        if (/expect|assert|should/gi.test(testCode)) score += 10;
        else suggestions.push('Ensure proper assertions are included');

        // Check for error testing
        if (/throw|error|exception/gi.test(testCode)) score += 10;
        else suggestions.push('Consider adding error handling tests');

        return { score, suggestions };
    }
}

/**
 * Simple offline code analyzer
 */
class OfflineCodeAnalyzer {
    analyze(code, language) {
        return {
            functions: this.extractFunctions(code, language),
            classes: this.extractClasses(code, language),
            imports: this.extractImports(code, language),
            complexity: this.estimateComplexity(code),
            language
        };
    }

    extractFunctions(code, language) {
        const patterns = {
            javascript: /(?:function\s+(\w+)|const\s+(\w+)\s*=.*?(?:function|=>))/gi,
            typescript: /(?:function\s+(\w+)|const\s+(\w+)\s*=.*?(?:function|=>))/gi,
            python: /def\s+(\w+)\s*\(/gi,
            java: /(?:public|private|protected)?\s*(?:static\s+)?(?:\w+\s+)*(\w+)\s*\(/gi
        };

        const pattern = patterns[language] || patterns.javascript;
        const functions = [];
        let match;

        while ((match = pattern.exec(code)) !== null) {
            functions.push({
                name: match[1] || match[2],
                line: this.getLineNumber(code, match.index)
            });
        }

        return functions;
    }

    extractClasses(code, language) {
        const patterns = {
            javascript: /class\s+(\w+)/gi,
            typescript: /class\s+(\w+)/gi,
            python: /class\s+(\w+)/gi,
            java: /(?:public\s+)?class\s+(\w+)/gi
        };

        const pattern = patterns[language] || patterns.javascript;
        const classes = [];
        let match;

        while ((match = pattern.exec(code)) !== null) {
            classes.push({
                name: match[1],
                line: this.getLineNumber(code, match.index)
            });
        }

        return classes;
    }

    extractImports(code, language) {
        const patterns = {
            javascript: /import.*?from\s+['"](.*?)['"]|require\s*\(\s*['"](.*?)['"]|/gi,
            typescript: /import.*?from\s+['"](.*?)['"]|require\s*\(\s*['"](.*?)['"]|/gi,
            python: /from\s+([\w.]+)\s+import|import\s+([\w.]+)/gi,
            java: /import\s+([\w.]+)/gi
        };

        const pattern = patterns[language] || patterns.javascript;
        const imports = [];
        let match;

        while ((match = pattern.exec(code)) !== null) {
            imports.push(match[1] || match[2]);
        }

        return imports;
    }

    estimateComplexity(code) {
        // Simple complexity estimation based on control structures
        const complexityPatterns = [
            /if\s*\(/gi,
            /for\s*\(/gi,
            /while\s*\(/gi,
            /switch\s*\(/gi,
            /catch\s*\(/gi
        ];

        return complexityPatterns.reduce((total, pattern) =>
            total + (code.match(pattern) || []).length, 1
        );
    }

    getLineNumber(code, index) {
        return code.substring(0, index).split('\n').length;
    }
}

/**
 * Template engine for offline test generation
 */
class TestTemplateEngine {
    async generateFromAnalysis(analysis, context, options) {
        const testType = options.testType || 'unit';
        const framework = context.testingFramework || 'jest';

        let tests = this.generateHeader(analysis, context);

        // Generate tests for each function
        for (const func of analysis.functions) {
            tests += this.generateFunctionTest(func, analysis, framework, testType);
        }

        // Generate tests for each class
        for (const cls of analysis.classes) {
            tests += this.generateClassTest(cls, analysis, framework, testType);
        }

        tests += this.generateFooter(analysis, context);

        return tests;
    }

    generateHeader(analysis, context) {
        const imports = analysis.imports.map(imp => `// Import: ${imp}`).join('\n');

        return `// Auto-generated test file
// Generated by RepoSpector (Offline Mode)
// Language: ${context.language}
// Framework: ${context.testingFramework || 'jest'}

${imports}

describe('Auto-generated Tests', () => {
    beforeEach(() => {
        // Setup code
    });

    afterEach(() => {
        // Cleanup code
    });

`;
    }

    generateFunctionTest(func, _analysis, _framework, _testType) {
        return `
    describe('${func.name}', () => {
        test('should handle basic functionality', () => {
            // TODO: Implement test for ${func.name}
            // This is a template-generated test that needs manual completion
            expect(${func.name}).toBeDefined();
        });

        test('should handle edge cases', () => {
            // TODO: Add edge case tests for ${func.name}
        });

        test('should handle error cases', () => {
            // TODO: Add error handling tests for ${func.name}
        });
    });
`;
    }

    generateClassTest(cls, _analysis, _framework, _testType) {
        return `
    describe('${cls.name}', () => {
        let instance;

        beforeEach(() => {
            instance = new ${cls.name}();
        });

        test('should instantiate correctly', () => {
            expect(instance).toBeInstanceOf(${cls.name});
        });

        test('should have expected methods', () => {
            // TODO: Add method tests for ${cls.name}
        });
    });
`;
    }

    generateFooter(_analysis, _context) {
        return `
});

// Note: These tests were generated offline using templates
// Manual review and completion is recommended
// Functions detected: ${_analysis.functions.map(f => f.name).join(', ')}
// Classes detected: ${_analysis.classes.map(c => c.name).join(', ')}
`;
    }
}
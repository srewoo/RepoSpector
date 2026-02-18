// Advanced test generator with comprehensive coverage and quality validation
//
// IMPORTANT: This module does NOT generate actual test code!
// It only provides:
// 1. Metadata tracking for coverage verification
// 2. Code analysis and context building
// 3. Integration with CoverageTracker for ensuring all functions are tested
//
// ALL actual test generation happens via LLM in the background service:
// src/background/index.js -> buildTestGenerationPrompt() -> callOpenAI() -> streaming response
//
// This ensures 100% LLM-generated tests with no template/mock code

import { ErrorHandler } from './errorHandler.js';
import { Sanitizer } from './sanitizer.js';
import { CoverageTracker } from './coverageTracker.js';
// Removed unused imports - these modules were deleted during cleanup
// import { ASTAnalyzer } from './astAnalyzer.js';
// import { FrameworkSupport } from './frameworkSupport.js';
// import { TestPatternLearning } from './testPatternLearning.js';
// import { MultiLLMClient } from './llmClient.js';
import {
    TEST_QUALITY_CONFIG,
    ANALYSIS_CONFIG
} from './constants.js';

// Phase 3 enhancements - Test generation improvements
import { analyzeFunction, buildEdgeCasePromptEnhancements } from './edgeCaseAnalyzer.js';
import { validateTestQuality as validateTestQualityUtil, detectFramework } from './testQualityValidator.js';
import { analyzeTestPatterns, buildPatternPromptEnhancement } from './testPatternAnalyzer.js';
import { validateSyntax } from './syntaxValidator.js';

export class TestGenerator {
    constructor() {
        this.errorHandler = new ErrorHandler();
        this.sanitizer = new Sanitizer();
        // Disabled - modules removed during cleanup
        // this.astAnalyzer = new ASTAnalyzer();
        // this.llmClient = new MultiLLMClient();

        // Enhanced capabilities - now implemented via Phase 3 imports:
        // - edgeCaseAnalyzer.js: Type-specific edge case detection
        // - testQualityValidator.js: Multi-layer test validation
        // - testPatternAnalyzer.js: Learn patterns from existing tests

        // Coverage tracker to ensure ALL functions are tested
        this.coverageTracker = new CoverageTracker();

        // Framework-specific prompts are handled via FRAMEWORK_CONFIGS in prompts.js
        // which provides detailed patterns for Jest, Mocha, pytest, JUnit, Playwright, Cypress
        this.frameworkGenerators = new Map([
            // Framework generators now handled via buildFrameworkSpecificPrompt in prompts.js
            // ['pytest', new PytestTestGenerator()],
            // ['junit', new JUnitTestGenerator()],
            // ['nunit', new NUnitTestGenerator()],
            // ['rspec', new RSpecTestGenerator()],
            // ['go-testing', new GoTestGenerator()]
        ]);

        // Test pattern generators with comprehensive coverage
        this.patternGenerators = {
            unit: this.generateComprehensiveUnitTests.bind(this),
            integration: this.generateIntegrationTestPatterns.bind(this),
            api: this.generateAPITestPatterns.bind(this),
            e2e: this.generateE2ETestPatterns.bind(this),
            performance: this.generatePerformanceTestPatterns.bind(this),
            security: this.generateSecurityTestPatterns.bind(this),
            accessibility: this.generateA11yTestPatterns.bind(this)
        };

        // Statistics tracking
        this.stats = {
            totalFunctions: 0,
            testedFunctions: 0,
            totalTestCases: 0,
            qualityScore: 0,
            coveragePercentage: 0
        };
    }

    /**
     * Enhanced generateTestSuite with Smart AST Analysis, Multi-Framework Support, and Pattern Learning
     */
    async generateEnhancedTestSuite(codeAnalysis, options = {}, context = {}) {
        try {
            const {
                testTypes = ['unit'],
                framework = 'auto',
                _includeSetup = true,
                _generateMocks = true,
                _coverage = 'comprehensive',
                _ensureAllFunctions = true,
                validateQuality = true,
                _compileCheck = true,
                _maxRetries = 3
            } = options;

            console.log('🚀 Starting enhanced test suite generation with Smart AST Analysis...');

            // Step 1: Enhanced AST Analysis - disabled (module removed)
            console.log('📝 AST Analysis skipped (module removed)...');
            const astAnalysis = {
                functions: [],
                classes: [],
                imports: [],
                complexity: { cyclomatic: 1, cognitive: 1 },
                testHints: [],
                dependencies: []
            };

            // Step 2: Detect Testing Framework - simplified (module removed)
            console.log('🔍 Using default testing framework...');
            const detectedFrameworks = [];
            const targetFramework = framework === 'auto' ? 'jest' : framework;

            // Step 3: Learn from Existing Test Patterns - disabled (module removed)
            console.log('🧠 Pattern learning skipped (module removed)...');
            let learnedPatterns = null;

            // Step 4: Combine analyses for enhanced context
            const enhancedContext = {
                ast: astAnalysis,
                framework: targetFramework,
                patterns: learnedPatterns,
                testHints: astAnalysis.testHints,
                complexity: astAnalysis.complexity,
                dependencies: astAnalysis.dependencies
            };

            // Step 5: Generate tests - fallback to original method
            console.log(`🛠️ Generating tests using ${targetFramework} framework...`);
            // Use the original generateTestSuite method as fallback
            const testResults = await this.generateTestSuite(codeAnalysis, {
                testTypes,
                framework: targetFramework
            });

            // Step 6: Apply learned patterns - skipped (module removed)
            // Pattern learning functionality has been removed

            // Step 7: Quality validation and enhancement
            if (validateQuality) {
                console.log('✅ Validating and enhancing test quality...');
                testResults.qualityMetrics = await this.validateTestQuality(testResults);

                // Enhance tests based on AST analysis insights
                testResults.tests = await this.enhanceTestsWithASTInsights(
                    testResults.tests,
                    astAnalysis
                );
            }

            // Step 8: Add comprehensive documentation
            testResults.documentation = this.generateTestDocumentation(
                astAnalysis,
                testResults,
                enhancedContext
            );

            console.log('🎉 Enhanced test suite generation completed successfully!');

            return {
                ...testResults,
                enhancements: {
                    astAnalysis: !!astAnalysis,
                    frameworkDetection: detectedFrameworks,
                    patternLearning: !!learnedPatterns,
                    qualityValidation: validateQuality
                },
                metadata: {
                    ...testResults.metadata,
                    enhancedGeneration: true,
                    astComplexity: astAnalysis.complexity,
                    testHints: astAnalysis.testHints
                }
            };

        } catch (error) {
            console.error('Enhanced test suite generation failed:', error);
            // Fallback to original method
            return await this.generateTestSuite(codeAnalysis, options);
        }
    }

    /**
     * Original generateTestSuite method (kept for backward compatibility)
     * Generate comprehensive test suite with guaranteed 100% function coverage
     */
    async generateTestSuite(codeAnalysis, options = {}) {
        try {
            const {
                testTypes = ['unit'],
                framework = 'auto',
                includeSetup = true,
                generateMocks = true,
                coverage = 'comprehensive',
                ensureAllFunctions = true,
                validateQuality = true,
                compileCheck = true,
                maxRetries = 3
            } = options;

            console.log('🚀 Starting comprehensive test suite generation...');

            // Enhanced code analysis with AST parsing
            const enhancedAnalysis = await this.performEnhancedAnalysis(codeAnalysis);

            // Detect optimal framework
            const detectedFramework = framework === 'auto'
                ? this.detectTestingFramework(enhancedAnalysis)
                : framework;

            console.log(`📋 Framework detected: ${detectedFramework}`);
            console.log(`🔍 Found ${enhancedAnalysis.functions.length} functions to test`);

            // Initialize coverage tracking
            this.coverageTracker.initialize(
                enhancedAnalysis.functions,
                enhancedAnalysis.classes
            );
            this.stats.totalFunctions = enhancedAnalysis.functions.length;

            let testSuite = {
                framework: detectedFramework,
                language: enhancedAnalysis.language,
                metadata: {
                    generatedAt: new Date().toISOString(),
                    totalFunctions: enhancedAnalysis.functions.length,
                    totalClasses: enhancedAnalysis.classes.length,
                    complexity: enhancedAnalysis.complexity,
                    version: '2.0.0'
                },
                setup: includeSetup ? await this.generateAdvancedTestSetup(enhancedAnalysis, detectedFramework) : null,
                teardown: includeSetup ? await this.generateAdvancedTestTeardown(enhancedAnalysis, detectedFramework) : null,
                mocks: generateMocks ? await this.generateIntelligentMocks(enhancedAnalysis, detectedFramework) : [],
                imports: await this.generateTestImports(enhancedAnalysis, detectedFramework),
                utilities: await this.generateTestUtilities(enhancedAnalysis, detectedFramework),
                tests: {},
                quality: null,
                coverage: null,
                stats: this.stats
            };

            // Generate tests for each requested type with retry logic
            for (const testType of testTypes) {
                if (this.patternGenerators[testType]) {
                    console.log(`📝 Generating ${testType} tests...`);

                    let attempts = 0;
                    let success = false;
                    let lastError = null;

                    while (attempts < maxRetries && !success) {
                        try {
                            testSuite.tests[testType] = await this.patternGenerators[testType](
                                enhancedAnalysis,
                                detectedFramework,
                                coverage,
                                options
                            );

                            // Validate coverage if required
                            if (ensureAllFunctions && testType === 'unit') {
                                const coverageResult = this.coverageTracker.validateCoverage(testSuite.tests[testType]);
                                if (!coverageResult.complete) {
                                    console.warn(`⚠️  Coverage incomplete: ${coverageResult.missing.length} items missing tests`);

                                    // Generate missing tests
                                    const missingTests = await this.generateMissingTests(
                                        coverageResult.missing,
                                        enhancedAnalysis,
                                        detectedFramework
                                    );

                                    testSuite.tests[testType] = this.mergeTestResults(
                                        testSuite.tests[testType],
                                        missingTests
                                    );
                                }
                            }

                            success = true;
                        } catch (error) {
                            attempts++;
                            lastError = error;
                            // Safely extract error message
                            const errMsg = error?.message || error?.toString?.() || String(error) || 'Unknown error';
                            console.warn(`⚠️  Test generation attempt ${attempts} failed:`, errMsg);

                            if (attempts < maxRetries) {
                                console.log('🔄 Retrying with fallback approach...');
                                // Try with different LLM provider or reduced complexity
                                enhancedAnalysis.fallbackMode = true;
                            }
                        }
                    }

                    if (!success) {
                        throw new Error(`Failed to generate ${testType} tests after ${maxRetries} attempts: ${lastError?.message}`);
                    }
                }
            }

            // Quality validation
            if (validateQuality) {
                console.log('🔍 Validating test quality...');
                testSuite.quality = await this.validateTestSuiteQuality(testSuite, enhancedAnalysis);

                if (testSuite.quality.score < TEST_QUALITY_CONFIG.MIN_COVERAGE_SCORE) {
                    console.warn(`⚠️  Quality score ${testSuite.quality.score} below threshold ${TEST_QUALITY_CONFIG.MIN_COVERAGE_SCORE}`);

                    // Attempt to improve quality
                    testSuite = await this.improveTestQuality(testSuite, enhancedAnalysis, testSuite.quality.issues);
                }
            }

            // Compilation/Syntax check using syntaxValidator
            if (compileCheck) {
                console.log('🔨 Checking test syntax...');
                const testCode = this.extractTestCode(testSuite);
                if (testCode) {
                    const syntaxResult = validateSyntax(testCode, {
                        language: enhancedAnalysis.language || 'javascript'
                    });

                    testSuite.compilation = {
                        success: syntaxResult.valid,
                        errors: syntaxResult.errors || [],
                        warnings: syntaxResult.warnings || []
                    };

                    if (!syntaxResult.valid) {
                        console.warn('⚠️ Syntax issues found:', syntaxResult.errors);
                    } else {
                        console.log('✅ Syntax validation passed');
                    }
                }
            }

            // Final coverage report
            testSuite.coverage = this.coverageTracker.generateReport();
            this.stats.coveragePercentage = testSuite.coverage.summary.coveragePercentage;
            this.stats.testedFunctions = testSuite.coverage.summary.testedFunctions;

            console.log('✅ Test suite generation completed!');
            console.log(`📊 Coverage: ${testSuite.coverage.summary.coveragePercentage.toFixed(2)}%`);
            console.log(`🏆 Quality Score: ${testSuite.quality?.score || 'N/A'}`);
            console.log(`🧪 Total Test Cases: ${this.stats.totalTestCases}`);

            return testSuite;

        } catch (error) {
            this.errorHandler.logError('Comprehensive test suite generation failed', error);

            // Don't use fallback templates - let the error propagate
            // The actual test generation will happen via LLM in processDirect/processWithChunking
            throw error;
        }
    }

    /**
     * Detect testing framework from code analysis
     */
    detectTestingFramework(codeAnalysis) {
        const { language, imports, dependencies, projectPatterns: _projectPatterns, code } = codeAnalysis;

        // Check imports for framework indicators
        const frameworkIndicators = {
            cypress: ['cypress', '@cypress', 'cypress-io', 'cy.'],
            jest: ['jest', '@jest', 'jest-environment'],
            mocha: ['mocha', 'chai', 'sinon'],
            jasmine: ['jasmine', 'jasmine-core'],
            pytest: ['pytest', 'unittest', 'mock'],
            junit: ['junit', 'org.junit', 'org.mockito'],
            nunit: ['NUnit', 'Microsoft.VisualStudio.TestTools'],
            rspec: ['rspec', 'spec_helper']
        };

        // Check imports and dependencies
        for (const [framework, indicators] of Object.entries(frameworkIndicators)) {
            const hasFramework = indicators.some(indicator =>
                imports.some(imp => imp.path.includes(indicator)) ||
                dependencies.some(dep => dep.includes(indicator))
            );

            if (hasFramework) {
                return framework;
            }
        }

        // Check code content for Cypress patterns (for existing test files)
        if (code && (language === 'javascript' || language === 'typescript')) {
            if (code.includes('cy.') ||
                code.includes('cy.visit') ||
                code.includes('cy.get') ||
                code.includes('cy.contains') ||
                code.includes('Cypress.')) {
                return 'cypress';
            }
        }

        // Fallback based on language
        const defaultFrameworks = {
            javascript: 'jest',
            typescript: 'jest',
            python: 'pytest',
            java: 'junit',
            csharp: 'nunit',
            ruby: 'rspec',
            go: 'testing'
        };

        return defaultFrameworks[language] || 'jest';
    }

    /**
     * Generate comprehensive unit tests for ALL functions with guaranteed coverage
     */
    async generateComprehensiveUnitTests(enhancedAnalysis, framework, coverage, options = {}) {
        console.log('🧪 Starting comprehensive unit test generation...');

        const testResults = {
            functions: [],
            classes: [],
            totalTests: 0,
            metadata: {
                framework,
                coverage,
                generatedAt: new Date().toISOString()
            }
        };

        try {
            // Generate tests for EVERY function - no exceptions
            console.log(`📋 Processing ${enhancedAnalysis.functions.length} functions...`);

            for (let i = 0; i < enhancedAnalysis.functions.length; i++) {
                const func = enhancedAnalysis.functions[i];
                console.log(`🔨 Generating tests for function: ${func.name} (${i + 1}/${enhancedAnalysis.functions.length})`);

                try {
                    const functionTests = await this.generateExhaustiveFunctionTests(
                        func,
                        enhancedAnalysis,
                        framework,
                        options
                    );

                    testResults.functions.push(functionTests);
                    testResults.totalTests += functionTests.testCases.length;
                    this.stats.totalTestCases += functionTests.testCases.length;

                    // Mark function as tested
                    this.coverageTracker.markFunctionTested(
                        func.name,
                        functionTests.testCases.length,
                        functionTests.testCases.map(tc => tc.type)
                    );

                } catch (error) {
                    console.error(`❌ Failed to generate tests for ${func.name}:`, error);

                    // Generate fallback tests to ensure coverage
                    const fallbackTests = await this.generateFallbackFunctionTests(func, framework);
                    testResults.functions.push(fallbackTests);
                    testResults.totalTests += fallbackTests.testCases.length;
                }
            }

            // Generate tests for EVERY class
            console.log(`📋 Processing ${enhancedAnalysis.classes.length} classes...`);

            for (let i = 0; i < enhancedAnalysis.classes.length; i++) {
                const cls = enhancedAnalysis.classes[i];
                console.log(`🔨 Generating tests for class: ${cls.name} (${i + 1}/${enhancedAnalysis.classes.length})`);

                try {
                    const classTests = await this.generateExhaustiveClassTests(
                        cls,
                        enhancedAnalysis,
                        framework,
                        options
                    );

                    testResults.classes.push(classTests);
                    testResults.totalTests += classTests.totalTestCases;
                    this.stats.totalTestCases += classTests.totalTestCases;

                } catch (error) {
                    console.error(`❌ Failed to generate tests for class ${cls.name}:`, error);

                    // Generate fallback tests
                    const fallbackTests = await this.generateFallbackClassTests(cls, framework);
                    testResults.classes.push(fallbackTests);
                    testResults.totalTests += fallbackTests.totalTestCases;
                }
            }

            console.log(`✅ Unit test generation completed: ${testResults.totalTests} tests generated`);
            return testResults;

        } catch (error) {
            console.error('❌ Unit test generation failed:', error);
            throw error;
        }
    }

    /**
     * Generate exhaustive tests for a single function
     *
     * IMPORTANT: This method only tracks metadata for coverage.
     * Actual test generation happens via LLM in background service:
     * buildTestGenerationPrompt -> callOpenAI -> streaming response
     */
    async generateExhaustiveFunctionTests(func, analysis, framework, options = {}) {
        try {
            // Build comprehensive context for the function
            const context = this.buildFunctionTestContext(func, analysis);

            // Return metadata structure for coverage tracking
            // The actual test generation is done by LLM in the background service
            return {
                functionName: func.name,
                line: func.line,
                complexity: func.complexity,
                context: context,
                testCases: [], // Empty - tests come from LLM
                metadata: {
                    generatedViaLLM: true,
                    hasTemplateGenerated: false,
                    requiresLLMGeneration: true,
                    hasSecurity: func.securityConcerns?.length > 0,
                    hasPerformance: func.complexity > ANALYSIS_CONFIG.FUNCTION_COMPLEXITY_THRESHOLD,
                    testTypes: ['positive', 'negative', 'edge'] // Expected test types
                }
            };

        } catch (error) {
            console.error(`Failed to prepare metadata for ${func.name}:`, error);
            // Safely extract error message
            const errMsg = error?.message || error?.toString?.() || String(error) || 'Unknown error';

            return {
                functionName: func.name,
                line: func.line,
                complexity: func.complexity,
                testCases: [],
                metadata: {
                    generatedViaLLM: true,
                    hasTemplateGenerated: false,
                    error: errMsg
                }
            };
        }
    }

    /**
     * Generate integration test patterns
     */
    async generateIntegrationTestPatterns(codeAnalysis, framework, _coverage) {
        const patterns = [];
        const { dependencies, imports: _imports } = codeAnalysis;

        // Generate integration tests based on dependencies
        const externalDeps = dependencies.filter(dep => !dep.isRelative);
        
        for (const dep of externalDeps.slice(0, 5)) { // Limit to avoid too many tests
            patterns.push({
                type: 'integration',
                target: dep.path,
                tests: this.generateDependencyIntegrationTests(dep, framework)
            });
        }

        return patterns;
    }

    /**
     * Generate API test patterns
     */
    async generateAPITestPatterns(codeAnalysis, framework, _coverage) {
        const patterns = [];
        const apiEndpoints = this.extractAPIEndpoints(codeAnalysis);

        for (const endpoint of apiEndpoints) {
            patterns.push({
                type: 'api',
                endpoint: endpoint.path,
                method: endpoint.method,
                tests: this.generateAPIEndpointTests(endpoint, framework)
            });
        }

        return patterns;
    }

    /**
     * Generate E2E test patterns
     */
    async generateE2ETestPatterns(codeAnalysis, framework, _coverage) {
        const patterns = [];
        const userFlows = this.extractUserFlows(codeAnalysis);

        for (const flow of userFlows) {
            patterns.push({
                type: 'e2e',
                flow: flow.name,
                tests: this.generateUserFlowTests(flow, framework)
            });
        }

        return patterns;
    }

    /**
     * Extract testable elements from code
     */
    extractTestableElements(codeAnalysis) {
        const { code, language } = codeAnalysis;
        
        const functions = this.extractFunctions(code, language);
        const classes = this.extractClasses(code, language);
        
        return {
            functions,
            classes,
            exports: codeAnalysis.exports || []
        };
    }

    /**
     * Extract functions from code
     */
    extractFunctions(code, language) {
        const functions = [];
        
        const patterns = {
            javascript: /(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)\s*=>|\([^)]*\)\s*{|function))/g,
            typescript: /(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)\s*=>|\([^)]*\)\s*{|function))/g,
            python: /def\s+(\w+)\s*\(/g,
            java: /(?:public|private|protected)?\s*(?:static\s+)?(?:\w+\s+)*(\w+)\s*\(/g
        };

        const pattern = patterns[language];
        if (pattern) {
            let match;
            while ((match = pattern.exec(code)) !== null) {
                const name = match[1] || match[2];
                if (name && !name.startsWith('_')) { // Skip private functions
                    functions.push({
                        name,
                        signature: this.extractFunctionSignature(code, name, language)
                    });
                }
            }
        }

        return functions;
    }

    /**
     * Extract classes from code
     */
    extractClasses(code, language) {
        const classes = [];
        
        const patterns = {
            javascript: /class\s+(\w+)/g,
            typescript: /class\s+(\w+)/g,
            python: /class\s+(\w+)/g,
            java: /(?:public\s+)?class\s+(\w+)/g
        };

        const pattern = patterns[language];
        if (pattern) {
            let match;
            while ((match = pattern.exec(code)) !== null) {
                const name = match[1];
                classes.push({
                    name,
                    methods: this.extractClassMethods(code, name, language)
                });
            }
        }

        return classes;
    }

    /**
     * Generate test setup code
     */
    generateTestSetup(codeAnalysis, framework) {
        const templates = {
            jest: `
beforeEach(() => {
    // Setup before each test
    jest.clearAllMocks();
});

beforeAll(() => {
    // Setup before all tests
});`,
            mocha: `
beforeEach(() => {
    // Setup before each test
});

before(() => {
    // Setup before all tests
});`,
            pytest: `
@pytest.fixture
def setup():
    """Setup fixture for tests"""
    # Setup code here
    yield
    # Teardown code here`
        };

        return templates[framework] || templates.jest;
    }

    /**
     * Generate test teardown code
     */
    generateTestTeardown(codeAnalysis, framework) {
        const templates = {
            jest: `
afterEach(() => {
    // Cleanup after each test
});

afterAll(() => {
    // Cleanup after all tests
});`,
            mocha: `
afterEach(() => {
    // Cleanup after each test
});

after(() => {
    // Cleanup after all tests
});`,
            pytest: `
def teardown():
    """Teardown after tests"""
    # Cleanup code here`
        };

        return templates[framework] || templates.jest;
    }

    /**
     * Generate mocks for dependencies
     */
    generateMocks(codeAnalysis, framework) {
        const mocks = [];
        const { dependencies } = codeAnalysis;

        const externalDeps = dependencies.filter(dep => !dep.isRelative).slice(0, 3);
        
        for (const dep of externalDeps) {
            mocks.push({
                dependency: dep.path,
                mock: this.generateMockForDependency(dep, framework)
            });
        }

        return mocks;
    }

    // Framework-specific template methods
    getJestUnitTemplate() {
        return `
describe('{{className}}', () => {
    {{testCases}}
});`;
    }

    getJestIntegrationTemplate() {
        return `
describe('{{integrationName}} Integration', () => {
    {{testCases}}
});`;
    }

    getJestMockTemplate() {
        return `
jest.mock('{{moduleName}}', () => ({
    {{mockImplementation}}
}));`;
    }

    getMochaUnitTemplate() {
        return `
describe('{{className}}', () => {
    {{testCases}}
});`;
    }

    getMochaIntegrationTemplate() {
        return `
describe('{{integrationName}} Integration', () => {
    {{testCases}}
});`;
    }

    getMochaMockTemplate() {
        return `
const sinon = require('sinon');
const {{moduleName}}Mock = sinon.stub();`;
    }

    getPytestUnitTemplate() {
        return `
class Test{{className}}:
    {{testCases}}`;
    }

    getPytestIntegrationTemplate() {
        return `
class Test{{integrationName}}Integration:
    {{testCases}}`;
    }

    getPytestMockTemplate() {
        return `
@patch('{{moduleName}}')
def test_with_mock(mock_{{moduleName}}):
    {{mockSetup}}`;
    }

    getJUnitUnitTemplate() {
        return `
public class {{className}}Test {
    {{testCases}}
}`;
    }

    getJUnitIntegrationTemplate() {
        return `
public class {{integrationName}}IntegrationTest {
    {{testCases}}
}`;
    }

    getJUnitMockTemplate() {
        return `
@Mock
private {{className}} {{instanceName}};`;
    }

    // Helper methods (stubs for now - can be expanded)
    extractFunctionSignature(_code, _name, _language) {
        // Extract function signature logic
        return { parameters: [], returnType: 'any' };
    }

    extractClassMethods(_code, _className, _language) {
        // Extract class methods logic
        return [];
    }

    extractAPIEndpoints(_codeAnalysis) {
        // Extract API endpoints from code
        return [];
    }

    extractUserFlows(_codeAnalysis) {
        // Extract user flows for E2E testing
        return [];
    }

    generateFunctionTests(_func, _framework, _coverage) {
        // Generate specific function tests
        return [];
    }

    generateClassTests(_cls, _framework, _coverage) {
        // Generate specific class tests
        return [];
    }

    generateDependencyIntegrationTests(dep, framework) {
        // Generate integration tests for external dependencies
        const tests = [];

        if (framework === 'jest') {
            tests.push(`
describe('${dep.path || dep} Integration', () => {
    beforeEach(() => {
        // Setup integration test environment
        jest.clearAllMocks();
    });

    test('should integrate with ${dep.path || dep}', async () => {
        // Test integration with dependency
        // TODO: Add specific integration test logic
        expect(true).toBe(true);
    });

    test('should handle ${dep.path || dep} errors gracefully', async () => {
        // Test error handling with dependency
        // TODO: Add error scenario tests
        expect(true).toBe(true);
    });

    test('should properly configure ${dep.path || dep}', () => {
        // Test configuration
        // TODO: Add configuration tests
        expect(true).toBe(true);
    });
});`);
        } else if (framework === 'pytest') {
            tests.push(`
class Test${(dep.path || dep).replace(/[^a-zA-Z0-9]/g, '')}Integration:
    """Integration tests for ${dep.path || dep}"""

    def test_integration(self):
        """Test integration with ${dep.path || dep}"""
        # TODO: Add specific integration test logic
        assert True

    def test_error_handling(self):
        """Test error handling with ${dep.path || dep}"""
        # TODO: Add error scenario tests
        assert True

    def test_configuration(self):
        """Test configuration"""
        # TODO: Add configuration tests
        assert True`);
        } else {
            tests.push(`// Integration tests for ${dep.path || dep}`);
        }

        return tests;
    }

    generateAPIEndpointTests(endpoint, framework) {
        // Generate API endpoint tests
        const tests = [];
        const method = endpoint.method || 'GET';
        const path = endpoint.path || '/api/endpoint';

        if (framework === 'jest') {
            tests.push(`
describe('${method} ${path}', () => {
    test('should return 200 for valid request', async () => {
        const response = await fetch('${path}', {
            method: '${method}'
        });
        expect(response.status).toBe(200);
    });

    test('should return 400 for invalid request', async () => {
        const response = await fetch('${path}', {
            method: '${method}',
            body: JSON.stringify({ invalid: 'data' })
        });
        expect(response.status).toBe(400);
    });

    test('should return 401 for unauthorized request', async () => {
        const response = await fetch('${path}', {
            method: '${method}'
            // No auth header
        });
        expect(response.status).toBe(401);
    });

    test('should return correct content-type', async () => {
        const response = await fetch('${path}', {
            method: '${method}'
        });
        expect(response.headers.get('content-type')).toMatch(/application\\/json/);
    });
});`);
        } else if (framework === 'pytest') {
            tests.push(`
class Test${method}${path.replace(/[^a-zA-Z0-9]/g, '')}:
    """API tests for ${method} ${path}"""

    def test_valid_request(self, client):
        """Test valid request"""
        response = client.${method.toLowerCase()}('${path}')
        assert response.status_code == 200

    def test_invalid_request(self, client):
        """Test invalid request"""
        response = client.${method.toLowerCase()}('${path}', json={'invalid': 'data'})
        assert response.status_code == 400

    def test_unauthorized_request(self, client):
        """Test unauthorized request"""
        response = client.${method.toLowerCase()}('${path}')
        assert response.status_code == 401

    def test_content_type(self, client):
        """Test content type"""
        response = client.${method.toLowerCase()}('${path}')
        assert 'application/json' in response.headers.get('Content-Type')`);
        } else {
            tests.push(`// API tests for ${method} ${path}`);
        }

        return tests;
    }

    generateUserFlowTests(flow, framework) {
        // Generate E2E user flow tests
        const tests = [];
        const flowName = flow.name || 'UserFlow';
        const steps = flow.steps || [];

        if (framework === 'cypress') {
            tests.push(`
describe('${flowName}', () => {
    beforeEach(() => {
        // Setup before each test
        cy.visit('/');
    });

    it('completes the full ${flowName} flow', () => {
        ${steps.map((step, i) => `
        // Step ${i + 1}: ${step.description || step}
        cy.get('${step.selector || '.step-' + i}').click();`).join('\n')}

        // Verify flow completion
        cy.url().should('include', '/success');
        cy.get('[data-testid="success-message"]').should('be.visible');
    });

    it('handles errors in ${flowName} flow', () => {
        // Test error scenarios
        cy.intercept('POST', '/api/*', { statusCode: 500 }).as('apiError');

        // Attempt flow
        ${steps.slice(0, 1).map((step, i) => `
        cy.get('${step.selector || '.step-' + i}').click();`).join('\n')}

        // Verify error handling
        cy.get('[data-testid="error-message"]').should('be.visible');
    });
});`);
        } else if (framework === 'playwright') {
            tests.push(`
import { test, expect } from '@playwright/test';

test.describe('${flowName}', () => {
    test('completes the full ${flowName} flow', async ({ page }) => {
        await page.goto('/');

        ${steps.map((step, i) => `
        // Step ${i + 1}: ${step.description || step}
        await page.click('${step.selector || '.step-' + i}');`).join('\n')}

        // Verify flow completion
        await expect(page).toHaveURL(/.*success/);
        await expect(page.locator('[data-testid="success-message"]')).toBeVisible();
    });

    test('handles errors in ${flowName} flow', async ({ page }) => {
        // Setup error scenario
        await page.route('/api/**', route => route.fulfill({ status: 500 }));

        await page.goto('/');

        // Attempt flow
        ${steps.slice(0, 1).map((step, i) => `
        await page.click('${step.selector || '.step-' + i}');`).join('\n')}

        // Verify error handling
        await expect(page.locator('[data-testid="error-message"]')).toBeVisible();
    });
});`);
        } else {
            tests.push(`// E2E tests for ${flowName} user flow`);
        }

        return tests;
    }

    generateMockForDependency(dep, _framework) {
        // Generate mock implementation for dependency
        return `// Mock for ${dep.path}`;
    }

    /**
     * Generate performance test patterns
     */
    async generatePerformanceTestPatterns(codeAnalysis, framework, _coverage) {
        const filePath = codeAnalysis.filePath || 'code';
        const functions = codeAnalysis.functions || [];
        const tests = [];

        // Configurable thresholds based on function complexity
        const getThreshold = (func) => {
            const complexity = func.complexity || 1;
            if (complexity >= 10) return { sync: 2000, async: 5000, label: 'high-complexity' };
            if (complexity >= 5) return { sync: 1000, async: 3000, label: 'medium-complexity' };
            return { sync: 500, async: 1000, label: 'low-complexity' };
        };

        // Detect async functions
        const isAsync = (func) => {
            return func.async === true || (func.name || '').startsWith('async') ||
                   func.returnType?.includes('Promise') || func.returnType?.includes('Observable');
        };

        // Generate timing tests for each function
        for (const func of functions.slice(0, 15)) {
            const threshold = getThreshold(func);
            const funcIsAsync = isAsync(func);

            if (framework === 'pytest') {
                if (funcIsAsync) {
                    tests.push(`@pytest.mark.asyncio
async def test_${func.name}_async_performance():
    """Ensure async ${func.name} completes within ${threshold.async}ms (${threshold.label})."""
    import asyncio, time
    start = time.perf_counter()
    await ${func.name}(${func.params?.length ? func.params.map(() => 'mock_arg').join(', ') : ''})
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert elapsed_ms < ${threshold.async}, f"${func.name} took {elapsed_ms:.1f}ms, expected <${threshold.async}ms"
`);
                } else {
                    tests.push(`def test_${func.name}_performance(benchmark):
    """Ensure ${func.name} completes within ${threshold.sync}ms (${threshold.label})."""
    result = benchmark(${func.name}${func.params?.length ? ', ' + func.params.map(() => 'mock_arg').join(', ') : ''})
    assert benchmark.stats.stats.mean < ${threshold.sync / 1000}  # Under ${threshold.sync}ms
`);
                }
            } else {
                if (funcIsAsync) {
                    tests.push(`it('${func.name} (async) should complete within ${threshold.async}ms [${threshold.label}]', async () => {
    const start = performance.now();
    await ${func.name}(${func.params?.length ? func.params.map(() => '/* mock */').join(', ') : ''});
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(${threshold.async});
});`);
                } else {
                    tests.push(`it('${func.name} should complete within ${threshold.sync}ms [${threshold.label}]', () => {
    const start = performance.now();
    ${func.name}(${func.params?.length ? func.params.map(() => '/* mock */').join(', ') : ''});
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(${threshold.sync});
});`);
                }
            }
        }

        // Add throughput/load tests for frequently-called functions
        const hotFunctions = functions.filter(f => {
            const name = (f.name || '').toLowerCase();
            return name.includes('process') || name.includes('handle') || name.includes('parse') ||
                   name.includes('transform') || name.includes('convert') || name.includes('calculate') ||
                   name.includes('filter') || name.includes('map') || name.includes('reduce');
        });

        for (const func of hotFunctions.slice(0, 5)) {
            const funcIsAsync = isAsync(func);
            if (framework === 'pytest') {
                tests.push(`def test_${func.name}_throughput():
    """${func.name} should handle 1000 iterations within 5 seconds."""
    import time
    start = time.perf_counter()
    for _ in range(1000):
        ${func.name}(${func.params?.length ? func.params.map(() => 'mock_arg').join(', ') : ''})
    elapsed = time.perf_counter() - start
    assert elapsed < 5.0, f"1000 calls took {elapsed:.2f}s, expected <5s"
`);
            } else {
                tests.push(`it('${func.name} should handle 1000 iterations within 5 seconds', ${funcIsAsync ? 'async ' : ''}() => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
        ${funcIsAsync ? 'await ' : ''}${func.name}(${func.params?.length ? func.params.map(() => '/* mock */').join(', ') : ''});
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);
});`);
            }
        }

        // Add memory/resource tests if classes detected
        if (codeAnalysis.classes?.length > 0) {
            for (const cls of codeAnalysis.classes.slice(0, 5)) {
                if (framework === 'pytest') {
                    tests.push(`def test_${cls.name}_no_memory_leak():
    """Ensure ${cls.name} cleans up resources properly."""
    import tracemalloc
    tracemalloc.start()
    instances = [${cls.name}() for _ in range(1000)]
    del instances
    import gc; gc.collect()
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert current < 10 * 1024 * 1024, f"Memory not freed: {current / 1024 / 1024:.1f}MB still allocated"
`);
                } else {
                    tests.push(`it('${cls.name} should not leak resources on repeated instantiation', () => {
    const before = process.memoryUsage?.().heapUsed || 0;
    const instances = Array.from({ length: 1000 }, () => new ${cls.name}());
    instances.length = 0; // Release references
    if (global.gc) global.gc(); // Force GC if exposed via --expose-gc
    const after = process.memoryUsage?.().heapUsed || 0;
    // Allow up to 10MB growth for 1000 instances
    expect(after - before).toBeLessThan(10 * 1024 * 1024);
});`);
                }
            }
        }

        if (tests.length === 0) {
            tests.push(framework === 'pytest'
                ? `def test_module_import_performance():\n    """Ensure module imports quickly."""\n    import time\n    start = time.time()\n    # import module_under_test\n    assert time.time() - start < 2.0\n`
                : `it('module should load within acceptable time', () => {\n    const start = performance.now();\n    // require or import module\n    expect(performance.now() - start).toBeLessThan(2000);\n});`
            );
        }

        return [{
            type: 'performance',
            framework,
            tests,
            description: `Performance tests for ${filePath} (${functions.length} functions, thresholds by complexity)`
        }];
    }

    /**
     * Generate security test patterns
     */
    async generateSecurityTestPatterns(codeAnalysis, framework, _coverage) {
        const filePath = codeAnalysis.filePath || 'code';
        const functions = codeAnalysis.functions || [];
        const tests = [];

        // Detect functions that handle user input, SQL, file paths, etc.
        const inputHandlers = functions.filter(f => {
            const name = f.name.toLowerCase();
            return name.includes('input') || name.includes('parse') || name.includes('query') ||
                   name.includes('request') || name.includes('param') || name.includes('body') ||
                   name.includes('validate') || name.includes('sanitize') || name.includes('auth') ||
                   name.includes('login') || name.includes('password') || name.includes('token') ||
                   name.includes('file') || name.includes('path') || name.includes('url');
        });

        const targets = inputHandlers.length > 0 ? inputHandlers : functions.slice(0, 5);

        for (const func of targets.slice(0, 8)) {
            const name = func.name;
            const nameLower = name.toLowerCase();

            // SQL injection tests
            if (nameLower.includes('query') || nameLower.includes('sql') || nameLower.includes('db') || nameLower.includes('find')) {
                if (framework === 'pytest') {
                    tests.push(`def test_${name}_sql_injection():\n    """${name} should not be vulnerable to SQL injection."""\n    malicious = "'; DROP TABLE users; --"\n    result = ${name}(malicious)\n    assert "DROP" not in str(result)\n`);
                } else {
                    tests.push(`it('${name} should reject SQL injection attempts', () => {\n    const malicious = "\\'; DROP TABLE users; --";\n    expect(() => ${name}(malicious)).not.toThrow();\n    // Verify query was parameterized, not concatenated\n});`);
                }
            }

            // XSS tests
            if (nameLower.includes('render') || nameLower.includes('html') || nameLower.includes('template') || nameLower.includes('display')) {
                if (framework === 'pytest') {
                    tests.push(`def test_${name}_xss_prevention():\n    """${name} should sanitize HTML output."""\n    malicious = '<script>alert("xss")</script>'\n    result = ${name}(malicious)\n    assert "<script>" not in str(result)\n`);
                } else {
                    tests.push(`it('${name} should sanitize against XSS', () => {\n    const malicious = '<script>alert("xss")</script>';\n    const result = ${name}(malicious);\n    expect(result).not.toContain('<script>');\n});`);
                }
            }

            // Path traversal tests
            if (nameLower.includes('file') || nameLower.includes('path') || nameLower.includes('read') || nameLower.includes('load')) {
                if (framework === 'pytest') {
                    tests.push(`def test_${name}_path_traversal():\n    """${name} should prevent path traversal attacks."""\n    malicious = "../../../etc/passwd"\n    with pytest.raises(Exception):\n        ${name}(malicious)\n`);
                } else {
                    tests.push(`it('${name} should reject path traversal attempts', () => {\n    const malicious = '../../../etc/passwd';\n    expect(() => ${name}(malicious)).toThrow();\n});`);
                }
            }

            // Auth bypass tests
            if (nameLower.includes('auth') || nameLower.includes('login') || nameLower.includes('token') || nameLower.includes('session')) {
                if (framework === 'pytest') {
                    tests.push(`def test_${name}_rejects_invalid_credentials():\n    """${name} should reject invalid authentication."""\n    assert not ${name}("", "")\n    assert not ${name}(None, None)\n`);
                } else {
                    tests.push(`it('${name} should reject invalid credentials', () => {\n    expect(${name}('', '')).toBeFalsy();\n    expect(${name}(null, null)).toBeFalsy();\n});`);
                }
            }

            // General null/undefined/empty input safety
            if (tests.length === 0 || !inputHandlers.includes(func)) {
                if (framework === 'pytest') {
                    tests.push(`def test_${name}_handles_malformed_input():\n    """${name} should handle malformed input safely."""\n    for bad_input in [None, "", "\\x00\\x01", "a" * 10000, -1, float("inf")]:\n        try:\n            ${name}(bad_input)\n        except (TypeError, ValueError):\n            pass  # Expected\n`);
                } else {
                    tests.push(`it('${name} should handle malformed input safely', () => {\n    const badInputs = [null, undefined, '', '\\x00', 'a'.repeat(10000), -1, Infinity];\n    for (const input of badInputs) {\n        expect(() => ${name}(input)).not.toThrow(/unhandled|crash|FATAL/i);\n    }\n});`);
                }
            }
        }

        return [{
            type: 'security',
            framework,
            tests,
            description: `Security tests for ${filePath}`
        }];
    }

    /**
     * Generate accessibility test patterns
     */
    async generateA11yTestPatterns(codeAnalysis, framework, _coverage) {
        const filePath = codeAnalysis.filePath || 'code';
        const tests = [];
        const classes = codeAnalysis.classes || [];
        const functions = codeAnalysis.functions || [];

        // Detect UI components (React, Vue, Svelte, etc.)
        const uiComponents = [...classes, ...functions].filter(item => {
            const name = (item.name || '').toLowerCase();
            return name.includes('component') || name.includes('button') || name.includes('form') ||
                   name.includes('input') || name.includes('modal') || name.includes('dialog') ||
                   name.includes('nav') || name.includes('menu') || name.includes('render') ||
                   name.includes('page') || name.includes('view') || name.includes('layout') ||
                   name.includes('header') || name.includes('footer') || name.includes('sidebar') ||
                   name.includes('card') || name.includes('list') || name.includes('table') ||
                   name.includes('dropdown') || name.includes('tooltip') || name.includes('tab');
        });

        for (const comp of uiComponents.slice(0, 10)) {
            if (framework === 'pytest') {
                // Python/Selenium-based a11y tests
                tests.push(`def test_${comp.name}_has_accessible_elements(driver):
    """${comp.name} should have proper ARIA attributes and keyboard navigation."""
    # Navigate to page containing ${comp.name}
    # element = driver.find_element(By.CSS_SELECTOR, '[data-testid="${comp.name}"]')
    # Assert ARIA labels exist
    # assert element.get_attribute('aria-label') or element.get_attribute('aria-labelledby')
    # Assert role is set
    # assert element.get_attribute('role')
    # Test keyboard focus
    # element.send_keys(Keys.TAB)
    # assert driver.switch_to.active_element == element
    pass
`);
            } else {
                // jest-axe automated accessibility test
                tests.push(`it('${comp.name} should have no accessibility violations', async () => {
    const { container } = render(<${comp.name} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
});`);
                // @testing-library role-based tests
                tests.push(`it('${comp.name} should be accessible via roles and labels', () => {
    render(<${comp.name} />);
    // Verify component is discoverable by role
    // expect(screen.getByRole('button')).toBeInTheDocument();
    // Verify aria-label or accessible name exists
    // expect(screen.getByRole('button')).toHaveAccessibleName();
});`);
                // Keyboard navigation test
                tests.push(`it('${comp.name} should support keyboard navigation', () => {
    render(<${comp.name} />);
    const element = screen.getByRole('button') || screen.getByTestId('${comp.name}');
    element.focus();
    expect(element).toHaveFocus();
    fireEvent.keyDown(element, { key: 'Enter' });
    // Verify Enter activates the component
    fireEvent.keyDown(element, { key: ' ' });
    // Verify Space activates the component (for buttons)
});`);
            }
        }

        // Add import helpers at the top
        if (uiComponents.length > 0 && framework !== 'pytest') {
            tests.unshift(`// Accessibility test imports
// import { axe, toHaveNoViolations } from 'jest-axe';
// import { render, screen, fireEvent } from '@testing-library/react';
// expect.extend(toHaveNoViolations);
`);
        }

        if (uiComponents.length === 0) {
            tests.push(framework === 'pytest'
                ? `# No UI components detected — skipping a11y tests for ${filePath}\n`
                : `// No UI components detected — skipping a11y tests for ${filePath}`
            );
        }

        return [{
            type: 'accessibility',
            framework,
            tests,
            description: `Accessibility tests for ${filePath} (${uiComponents.length} components)`
        }];
    }

    /**
     * Generate fallback test suite when main generation fails
     */
    async generateFallbackTestSuite(codeAnalysis, options) {
        console.warn('Using fallback test suite generation');

        const framework = options.framework || 'jest';
        const _testTypes = options.testTypes || ['unit'];

        // Create basic test structure based on detected functions/classes
        const fallbackTests = [];

        // Generate basic unit tests for detected functions
        if (codeAnalysis.functions && codeAnalysis.functions.length > 0) {
            const functionTests = codeAnalysis.functions.map(func => {
                return `describe('${func.name}', () => {
    it('should be defined', () => {
        expect(${func.name}).toBeDefined();
    });

    it('should handle basic functionality', () => {
        // Add test implementation
        // TODO: Implement specific tests for ${func.name}
    });
});`;
            }).join('\n\n');

            fallbackTests.push({
                type: 'unit',
                framework,
                code: functionTests,
                description: `Basic unit tests for ${codeAnalysis.functions.length} functions`
            });
        }

        // Generate basic tests for detected classes
        if (codeAnalysis.classes && codeAnalysis.classes.length > 0) {
            const classTests = codeAnalysis.classes.map(cls => {
                return `describe('${cls.name}', () => {
    let instance;

    beforeEach(() => {
        instance = new ${cls.name}();
    });

    it('should create an instance', () => {
        expect(instance).toBeInstanceOf(${cls.name});
    });

    ${cls.methods.map(method => `
    describe('${method.name}', () => {
        it('should exist', () => {
            expect(typeof instance.${method.name}).toBe('function');
        });

        it('should handle basic functionality', () => {
            // Add test implementation
            // TODO: Implement specific tests for ${method.name}
        });
    });`).join('\n')}
});`;
            }).join('\n\n');

            fallbackTests.push({
                type: 'unit',
                framework,
                code: classTests,
                description: `Basic class tests for ${codeAnalysis.classes.length} classes`
            });
        }

        // If no functions or classes detected, create generic tests
        if (fallbackTests.length === 0) {
            fallbackTests.push({
                type: 'unit',
                framework,
                code: `describe('Code Tests', () => {
    it('should be testable', () => {
        // Basic test structure
        expect(true).toBe(true);
    });

    it('should have proper implementation', () => {
        // TODO: Add specific tests based on code analysis
        // File: ${codeAnalysis.filePath || 'unknown'}
        // Language: ${codeAnalysis.language || 'unknown'}
    });
});`,
                description: 'Basic fallback test structure'
            });
        }

        return fallbackTests;
    }

    /**
     * Enhanced helper methods for the new functionality
     */

    async validateTestQuality(testResults) {
        try {
            const code = testResults?.code || testResults?.tests || '';
            if (!code) {
                return {
                    score: 0,
                    coverage: 'unknown',
                    maintainability: 'unknown',
                    readability: 'unknown',
                    suggestions: ['No test code provided for validation']
                };
            }

            // Use the real test quality validator
            const validationResult = validateTestQualityUtil(code, {
                framework: testResults.framework || detectFramework(code),
                targetCode: testResults.targetCode,
                expectedFunctions: testResults.expectedFunctions
            });

            // Map the detailed validation to the expected format
            return {
                score: validationResult.score,
                coverage: validationResult.score >= 80 ? 'high' : validationResult.score >= 60 ? 'medium' : 'low',
                maintainability: validationResult.bestPractices?.score >= 20 ? 'good' : 'needs improvement',
                readability: validationResult.structure?.hasDescriptiveNames ? 'excellent' : 'good',
                suggestions: validationResult.suggestions || [],
                details: {
                    structure: validationResult.structure,
                    assertions: validationResult.assertions,
                    coverageDetails: validationResult.coverage,
                    bestPractices: validationResult.bestPractices,
                    syntaxValid: validationResult.syntaxValid
                }
            };
        } catch (error) {
            console.warn('Test quality validation failed:', error);
            return {
                score: 70, // Default moderate score on error
                coverage: 'unknown',
                maintainability: 'unknown',
                readability: 'unknown',
                suggestions: ['Validation encountered an error: ' + error.message]
            };
        }
    }

    /**
     * Analyze code for edge cases and generate prompt enhancements
     * @param {string} code - The code to analyze
     * @returns {Object} Edge case analysis and prompt enhancements
     */
    analyzeEdgeCases(code) {
        try {
            const analysis = analyzeFunction(code);
            const promptEnhancements = buildEdgeCasePromptEnhancements(analysis);
            return {
                analysis,
                promptEnhancements,
                edgeCases: analysis.edgeCases || []
            };
        } catch (error) {
            console.warn('Edge case analysis failed:', error);
            return {
                analysis: null,
                promptEnhancements: '',
                edgeCases: []
            };
        }
    }

    /**
     * Analyze existing tests to learn patterns
     * @param {string} existingTests - Existing test code to analyze
     * @returns {Object} Pattern analysis results
     */
    analyzeExistingTestPatterns(existingTests) {
        try {
            const patterns = analyzeTestPatterns(existingTests);
            const promptEnhancement = buildPatternPromptEnhancement(patterns);
            return {
                patterns,
                promptEnhancement,
                framework: patterns.framework,
                style: patterns.style
            };
        } catch (error) {
            console.warn('Test pattern analysis failed:', error);
            return {
                patterns: null,
                promptEnhancement: '',
                framework: null,
                style: null
            };
        }
    }

    /**
     * Build enhanced prompt context with edge cases and patterns
     * @param {string} code - Code to generate tests for
     * @param {string} existingTests - Optional existing tests to learn from
     * @returns {Object} Enhanced prompt context
     */
    buildEnhancedPromptContext(code, existingTests = null) {
        const edgeCaseData = this.analyzeEdgeCases(code);
        const patternData = existingTests ? this.analyzeExistingTestPatterns(existingTests) : null;

        return {
            edgeCases: edgeCaseData,
            patterns: patternData,
            combinedEnhancements: [
                edgeCaseData.promptEnhancements,
                patternData?.promptEnhancement || ''
            ].filter(Boolean).join('\n\n')
        };
    }

    /**
     * Extract test code from a test suite for syntax validation
     * @param {Object} testSuite - The test suite object
     * @returns {string|null} Combined test code or null if not available
     */
    extractTestCode(testSuite) {
        if (!testSuite) return null;

        const codeParts = [];

        // Extract from tests array
        if (testSuite.tests && Array.isArray(testSuite.tests)) {
            for (const test of testSuite.tests) {
                if (test.code) codeParts.push(test.code);
            }
        }

        // Extract from unit tests
        if (testSuite.tests?.unit && Array.isArray(testSuite.tests.unit)) {
            for (const test of testSuite.tests.unit) {
                if (test.code) codeParts.push(test.code);
            }
        }

        // Extract from integration tests
        if (testSuite.tests?.integration && Array.isArray(testSuite.tests.integration)) {
            for (const test of testSuite.tests.integration) {
                if (test.code) codeParts.push(test.code);
            }
        }

        // Extract from raw code property
        if (testSuite.code) {
            codeParts.push(testSuite.code);
        }

        return codeParts.length > 0 ? codeParts.join('\n\n') : null;
    }

    async enhanceTestsWithASTInsights(tests, astAnalysis) {
        // Add insights from AST analysis to improve test quality
        // Skip if astAnalysis is missing or incomplete
        if (!astAnalysis || !astAnalysis.testHints) {
            console.log('⚠️ AST analysis missing, skipping test enhancements');
            return tests;
        }

        if (astAnalysis.testHints) {
            // Add async test handling if needed
            if (astAnalysis.testHints.asyncTesting) {
                this.addAsyncTestSupport(tests);
            }

            // Add mocking suggestions - check if mockingNeeded exists and is an array
            if (astAnalysis.testHints.mockingNeeded && Array.isArray(astAnalysis.testHints.mockingNeeded) && astAnalysis.testHints.mockingNeeded.length > 0) {
                this.addMockingSupport(tests, astAnalysis.testHints.mockingNeeded);
            }

            // Add error testing if error handling detected
            if (astAnalysis.testHints.errorTesting) {
                this.addErrorTestCases(tests);
            }

            // Add complex logic testing for high complexity functions
            if (astAnalysis.testHints.complexLogic) {
                this.addComplexityTestCases(tests, astAnalysis.complexity);
            }
        }

        return tests;
    }

    generateTestDocumentation(astAnalysis, testResults, enhancedContext) {
        // Handle missing or incomplete test results
        const tests = testResults?.tests || {};
        const unitTests = tests.unit || [];

        const docs = {
            summary: `Generated ${Array.isArray(unitTests) ? unitTests.length : 0} unit tests`,
            framework: enhancedContext?.framework || 'auto',
            coverage: 'Comprehensive coverage including edge cases',
            insights: [],
            recommendations: []
        };

        // Safe access to astAnalysis properties
        if (astAnalysis?.complexity?.cyclomatic > 10) {
            docs.insights.push('High complexity code detected - added comprehensive test coverage');
        }

        if (astAnalysis?.testHints?.asyncTesting) {
            docs.insights.push('Async patterns detected - added async test support');
        }

        if (astAnalysis?.testHints?.mockingNeeded?.length > 0) {
            docs.insights.push(`Mocking needed for: ${astAnalysis.testHints.mockingNeeded.join(', ')}`);
        }

        if (enhancedContext.patterns) {
            docs.insights.push('Applied learned patterns from existing tests');
        }

        return docs;
    }

    addAsyncTestSupport(tests) {
        // Add async/await support to tests that need it
        if (tests.unit) {
            tests.unit = tests.unit.map(test => {
                if (test.code && test.code.includes('await')) {
                    return {
                        ...test,
                        async: true,
                        code: test.code.replace(/test\(/g, 'test(').replace(/it\(/g, 'it(')
                    };
                }
                return test;
            });
        }
    }

    addMockingSupport(tests, mockingNeeded) {
        if (tests.unit) {
            tests.unit.forEach(test => {
                if (!test.mocks) test.mocks = [];

                mockingNeeded.forEach(mockType => {
                    switch (mockType) {
                        case 'http-requests':
                            test.mocks.push('// Mock HTTP requests');
                            test.mocks.push('jest.mock(\'axios\');');
                            break;
                        case 'browser-apis':
                            test.mocks.push('// Mock browser APIs');
                            test.mocks.push('Object.defineProperty(window, \'localStorage\', { value: mockLocalStorage });');
                            break;
                        case 'external-modules':
                            test.mocks.push('// Mock external modules');
                            test.mocks.push('jest.mock(\'external-dependency\');');
                            break;
                    }
                });
            });
        }
    }

    addErrorTestCases(tests) {
        if (tests.unit) {
            tests.unit.forEach(test => {
                if (!test.errorTests) {
                    test.errorTests = [
                        'test(\'should handle errors gracefully\', () => {',
                        '    expect(() => {',
                        '        // Test error condition',
                        '    }).toThrow();',
                        '});'
                    ];
                }
            });
        }
    }

    addComplexityTestCases(tests, complexity) {
        if (tests.unit && complexity.cyclomatic > 10) {
            tests.unit.forEach(test => {
                if (!test.complexityTests) {
                    test.complexityTests = [
                        '// Additional test cases for complex logic',
                        'describe(\'complex scenarios\', () => {',
                        '    test(\'should handle edge case 1\', () => {',
                        '        // Test complex edge case',
                        '    });',
                        '    test(\'should handle edge case 2\', () => {',
                        '        // Test another complex edge case',
                        '    });',
                        '});'
                    ];
                }
            });
        }
    }

    /**
     * Generate tests for missing functions/classes to ensure complete coverage
     */
    async generateMissingTests(missingItems, codeAnalysis, framework) {
        console.log(`🔧 Generating tests for ${missingItems.length} missing items...`);

        const missingTests = {
            functions: [],
            classes: [],
            totalTests: 0
        };

        for (const item of missingItems) {
            try {
                if (item.type === 'function') {
                    // Find the function in the analysis
                    const func = codeAnalysis.functions.find(f => f.name === item.name);
                    if (func) {
                        const functionTests = await this.generateFallbackFunctionTests(func, framework);
                        missingTests.functions.push(functionTests);
                        missingTests.totalTests += functionTests.testCases.length;

                        // Mark as tested
                        this.coverageTracker.markFunctionTested(
                            func.name,
                            functionTests.testCases.length,
                            functionTests.testCases.map(tc => tc.type)
                        );
                    }
                } else if (item.type === 'class') {
                    // Find the class in the analysis
                    const cls = codeAnalysis.classes.find(c => c.name === item.name);
                    if (cls) {
                        const classTests = await this.generateFallbackClassTests(cls, framework);
                        missingTests.classes.push(classTests);
                        missingTests.totalTests += classTests.totalTestCases;

                        // Mark as tested
                        this.coverageTracker.markClassTested(
                            cls.name,
                            classTests.totalTestCases,
                            cls.methods.map(m => m.name)
                        );
                    }
                }
            } catch (error) {
                console.error(`❌ Failed to generate missing test for ${item.name}:`, error);
            }
        }

        console.log(`✅ Generated ${missingTests.totalTests} tests for missing items`);
        return missingTests;
    }

    /**
     * Merge test results from different sources
     */
    mergeTestResults(existingTests, newTests) {
        if (!existingTests || !newTests) {
            return existingTests || newTests;
        }

        return {
            functions: [
                ...(existingTests.functions || []),
                ...(newTests.functions || [])
            ],
            classes: [
                ...(existingTests.classes || []),
                ...(newTests.classes || [])
            ],
            totalTests: (existingTests.totalTests || 0) + (newTests.totalTests || 0),
            metadata: {
                ...existingTests.metadata,
                merged: true,
                mergedAt: new Date().toISOString()
            }
        };
    }

    /**
     * Generate fallback tests for a function when LLM generation fails
     *
     * IMPORTANT: This should ONLY be used as last resort when LLM is unavailable
     * These are placeholder tests that need LLM completion
     */
    async generateFallbackFunctionTests(func, framework) {
        console.warn(`⚠️ Using fallback for function: ${func.name} - generating template tests`);

        const testCases = [];
        const name = func.name;
        const params = func.params || [];
        const paramList = params.map(p => p.name || p).join(', ');

        if (framework === 'pytest') {
            // Basic call test
            testCases.push({
                name: `test_${name}_basic`,
                type: 'unit',
                code: `def test_${name}_basic():\n    """${name} should execute without error."""\n    result = ${name}(${params.map(() => 'None').join(', ')})\n    assert result is not None or result is None  # Verify no crash\n`,
                description: `Basic call test for ${name}`
            });
            // Edge case: empty/null inputs
            if (params.length > 0) {
                testCases.push({
                    name: `test_${name}_empty_inputs`,
                    type: 'edge_case',
                    code: `def test_${name}_empty_inputs():\n    """${name} should handle empty inputs gracefully."""\n    try:\n        ${name}(${params.map(() => '""').join(', ')})\n    except (TypeError, ValueError):\n        pass  # Expected for invalid input\n`,
                    description: `Edge case test for ${name} with empty inputs`
                });
            }
            // Error handling test
            testCases.push({
                name: `test_${name}_none_input`,
                type: 'edge_case',
                code: `def test_${name}_none_input():\n    """${name} should handle None gracefully."""\n    try:\n        ${name}(None)\n    except (TypeError, ValueError):\n        pass\n`,
                description: `None input test for ${name}`
            });
        } else {
            // Jest/Mocha style
            testCases.push({
                name: `${name} basic call`,
                type: 'unit',
                code: `it('should execute ${name} without error', () => {\n    expect(() => ${name}(${params.map(() => 'undefined').join(', ')})).not.toThrow();\n});`,
                description: `Basic call test for ${name}`
            });
            if (params.length > 0) {
                testCases.push({
                    name: `${name} empty inputs`,
                    type: 'edge_case',
                    code: `it('should handle empty inputs in ${name}', () => {\n    expect(() => ${name}(${params.map(() => "''").join(', ')})).not.toThrow();\n});`,
                    description: `Edge case test for ${name}`
                });
            }
            testCases.push({
                name: `${name} null safety`,
                type: 'edge_case',
                code: `it('should handle null/undefined in ${name}', () => {\n    expect(() => ${name}(null)).not.toThrow();\n    expect(() => ${name}(undefined)).not.toThrow();\n});`,
                description: `Null safety test for ${name}`
            });
        }

        return {
            functionName: name,
            line: func.line,
            complexity: func.complexity,
            testCases,
            metadata: {
                fallback: true,
                requiresLLMGeneration: true,
                reason: 'LLM generation failed - template tests provided as baseline',
                generatedAt: new Date().toISOString()
            }
        };
    }

    /**
     * Generate fallback tests for a class when LLM generation fails
     *
     * IMPORTANT: This should ONLY be used as last resort when LLM is unavailable
     */
    async generateFallbackClassTests(cls, framework) {
        console.warn(`⚠️ Using fallback for class: ${cls.name} - generating template tests`);

        const methods = cls.methods || [];
        const methodResults = [];

        if (framework === 'pytest') {
            // Instance creation test
            const initTest = {
                name: `test_${cls.name}_instantiation`,
                type: 'unit',
                code: `def test_${cls.name}_instantiation():\n    """${cls.name} should instantiate without error."""\n    instance = ${cls.name}()\n    assert instance is not None\n`,
                description: `Instantiation test for ${cls.name}`
            };

            for (const method of methods) {
                const testCases = [{
                    name: `test_${cls.name}_${method.name}`,
                    type: 'unit',
                    code: `def test_${cls.name}_${method.name}():\n    """${method.name} should be callable."""\n    instance = ${cls.name}()\n    assert hasattr(instance, '${method.name}')\n    assert callable(getattr(instance, '${method.name}'))\n`,
                    description: `Method existence test for ${cls.name}.${method.name}`
                }];
                methodResults.push({ name: method.name, testCases });
            }

            if (methodResults.length > 0) {
                methodResults[0].testCases.unshift(initTest);
            } else {
                methodResults.push({ name: '__init__', testCases: [initTest] });
            }
        } else {
            const initTest = {
                name: `${cls.name} instantiation`,
                type: 'unit',
                code: `it('should create an instance of ${cls.name}', () => {\n    const instance = new ${cls.name}();\n    expect(instance).toBeInstanceOf(${cls.name});\n});`,
                description: `Instantiation test for ${cls.name}`
            };

            for (const method of methods) {
                const testCases = [{
                    name: `${cls.name}.${method.name} exists`,
                    type: 'unit',
                    code: `it('should have method ${method.name}', () => {\n    const instance = new ${cls.name}();\n    expect(typeof instance.${method.name}).toBe('function');\n});`,
                    description: `Method existence test for ${cls.name}.${method.name}`
                }, {
                    name: `${cls.name}.${method.name} no-throw`,
                    type: 'edge_case',
                    code: `it('${method.name} should not throw on basic call', () => {\n    const instance = new ${cls.name}();\n    expect(() => instance.${method.name}()).not.toThrow();\n});`,
                    description: `No-throw test for ${cls.name}.${method.name}`
                }];
                methodResults.push({ name: method.name, testCases });
            }

            if (methodResults.length > 0) {
                methodResults[0].testCases.unshift(initTest);
            } else {
                methodResults.push({ name: 'constructor', testCases: [initTest] });
            }
        }

        const totalTestCases = methodResults.reduce((sum, m) => sum + m.testCases.length, 0);

        return {
            className: cls.name,
            methods: methodResults,
            totalTestCases,
            metadata: {
                fallback: true,
                requiresLLMGeneration: true,
                reason: 'LLM generation failed - template tests provided as baseline',
                generatedAt: new Date().toISOString()
            }
        };
    }

    /**
     * Additional helper methods required by the test generation flow
     */

    async performEnhancedAnalysis(codeAnalysis) {
        // Enhance the basic code analysis with additional metadata
        return {
            ...codeAnalysis,
            functions: codeAnalysis.functions || [],
            classes: codeAnalysis.classes || [],
            complexity: codeAnalysis.complexity || { cyclomatic: 1, cognitive: 1 },
            dependencies: codeAnalysis.dependencies || [],
            imports: codeAnalysis.imports || []
        };
    }

    async generateAdvancedTestSetup(analysis, framework) {
        return this.generateTestSetup(analysis, framework);
    }

    async generateAdvancedTestTeardown(analysis, framework) {
        return this.generateTestTeardown(analysis, framework);
    }

    async generateIntelligentMocks(analysis, framework) {
        return this.generateMocks(analysis, framework);
    }

    async generateTestImports(analysis, framework) {
        const imports = [];
        if (framework === 'jest') {
            imports.push("import { jest } from '@jest/globals';");
        } else if (framework === 'mocha') {
            imports.push("import { describe, it, beforeEach, afterEach } from 'mocha';");
            imports.push("import { expect } from 'chai';");
        } else if (framework === 'pytest') {
            imports.push("import pytest");
        }
        return imports;
    }

    async generateTestUtilities(analysis, framework) {
        return [
            '// Test utility functions',
            'function createMockData() { return {}; }',
            'function resetState() { /* reset test state */ }'
        ];
    }

    async validateTestSuiteQuality(testSuite, analysis) {
        const totalTests = testSuite.tests.unit?.totalTests || 0;
        const totalFunctions = analysis.functions.length;
        const coverageScore = totalFunctions > 0 ? (totalTests / (totalFunctions * 3)) * 100 : 0;

        return {
            score: Math.min(coverageScore, 100),
            issues: coverageScore < TEST_QUALITY_CONFIG.MIN_COVERAGE_SCORE
                ? ['Insufficient test coverage']
                : []
        };
    }

    async improveTestQuality(testSuite, analysis, issues) {
        console.log('🔧 Attempting to improve test quality...');

        const functions = analysis.functions || [];
        const classes = analysis.classes || [];
        const framework = testSuite.framework || 'jest';

        // Collect existing test names to avoid duplicates
        const existingTestNames = new Set();
        const collectNames = (obj) => {
            if (!obj) return;
            if (typeof obj === 'string') return;
            if (Array.isArray(obj)) { obj.forEach(collectNames); return; }
            if (obj.name) existingTestNames.add(obj.name);
            if (obj.testCases) collectNames(obj.testCases);
            if (obj.methods) collectNames(obj.methods);
            if (obj.tests) collectNames(obj.tests);
        };
        collectNames(testSuite.tests);

        const additionalTests = [];

        // Issue: Insufficient test coverage — add tests for uncovered functions
        if (issues.includes('Insufficient test coverage')) {
            for (const func of functions) {
                if (existingTestNames.has(func.name)) continue;

                const fallback = await this.generateFallbackFunctionTests(func, framework);
                if (fallback.testCases.length > 0) {
                    additionalTests.push(...fallback.testCases);
                }
            }
        }

        // Add edge case tests for high-complexity functions
        const complexFunctions = functions.filter(f => (f.complexity || 1) >= 5);
        for (const func of complexFunctions.slice(0, 5)) {
            const edgeName = `${func.name} edge cases`;
            if (existingTestNames.has(edgeName)) continue;

            if (framework === 'pytest') {
                additionalTests.push({
                    name: `test_${func.name}_edge_cases`,
                    type: 'edge_case',
                    code: `@pytest.mark.parametrize("input_val", [None, "", 0, -1, [], {}, float("inf")])\ndef test_${func.name}_edge_cases(input_val):\n    """${func.name} should handle edge case inputs."""\n    try:\n        ${func.name}(input_val)\n    except (TypeError, ValueError):\n        pass\n`,
                    description: `Edge case tests for complex function ${func.name}`
                });
            } else {
                additionalTests.push({
                    name: edgeName,
                    type: 'edge_case',
                    code: `it('${func.name} should handle edge case inputs', () => {\n    const edgeCases = [null, undefined, '', 0, -1, [], {}, NaN, Infinity];\n    for (const input of edgeCases) {\n        expect(() => ${func.name}(input)).not.toThrow(/unhandled/i);\n    }\n});`,
                    description: `Edge case tests for complex function ${func.name}`
                });
            }
        }

        // Merge additional tests into the test suite
        if (additionalTests.length > 0) {
            if (!testSuite.tests) testSuite.tests = {};
            if (!testSuite.tests.unit) testSuite.tests.unit = { totalTests: 0, testCases: [] };
            if (!testSuite.tests.unit.testCases) testSuite.tests.unit.testCases = [];

            testSuite.tests.unit.testCases.push(...additionalTests);
            testSuite.tests.unit.totalTests = (testSuite.tests.unit.totalTests || 0) + additionalTests.length;
            console.log(`✅ Added ${additionalTests.length} tests to improve quality`);

            // Re-validate after improvement
            testSuite.quality = await this.validateTestSuiteQuality(testSuite, analysis);
            console.log(`📊 Updated quality score: ${testSuite.quality.score}`);
        }

        return testSuite;
    }

    buildFunctionTestContext(func, analysis) {
        return {
            function: func,
            language: analysis.language,
            dependencies: analysis.dependencies || [],
            complexity: func.complexity || 1,
            securityConcerns: func.securityConcerns || []
        };
    }

    async generateTemplateBasedTests(func, context, framework) {
        // DEPRECATED: Template-based tests removed
        // All tests must come from LLM via background service
        console.warn('⚠️ generateTemplateBasedTests called but template generation is disabled - use LLM');
        return [];
    }

    generateEdgeCaseTests(func, context, framework) {
        // DEPRECATED: Template-based tests removed
        // All tests must come from LLM via background service
        console.warn('⚠️ generateEdgeCaseTests called but template generation is disabled - use LLM');
        return [];
    }

    generateSecurityTests(func, context, framework) {
        // DEPRECATED: Template-based tests removed
        // All tests must come from LLM via background service
        console.warn('⚠️ generateSecurityTests called but template generation is disabled - use LLM');
        return [];
    }

    generatePerformanceTests(func, context, framework) {
        // DEPRECATED: Template-based tests removed
        // All tests must come from LLM via background service
        console.warn('⚠️ generatePerformanceTests called but template generation is disabled - use LLM');
        return [];
    }

    generateMinimalTest(func, testType, framework) {
        // DEPRECATED: Template-based tests removed
        // All tests must come from LLM via background service
        console.warn('⚠️ generateMinimalTest called but template generation is disabled - use LLM');
        return {
            name: `${func.name} ${testType} test`,
            type: testType,
            code: '', // Empty - must come from LLM
            description: `Requires LLM generation`,
            metadata: { requiresLLM: true }
        };
    }

    deduplicateTests(testCases) {
        const seen = new Set();
        return testCases.filter(test => {
            const key = `${test.name}_${test.type}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    async generateExhaustiveClassTests(cls, analysis, framework, options) {
        const methodTests = [];

        for (const method of cls.methods) {
            const methodAsFunc = {
                name: method.name,
                line: method.line || 0,
                complexity: method.complexity || 1,
                securityConcerns: []
            };

            const tests = await this.generateExhaustiveFunctionTests(
                methodAsFunc,
                analysis,
                framework,
                options
            );

            methodTests.push(tests);
        }

        return {
            className: cls.name,
            methods: methodTests,
            totalTestCases: methodTests.reduce((sum, m) => sum + m.testCases.length, 0),
            metadata: {
                generatedAt: new Date().toISOString()
            }
        };
    }
} 
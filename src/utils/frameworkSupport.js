// Multi-Framework Test Generation Support
// Supports Jest, Vitest, Playwright, Cypress, Mocha, Jasmine, and more

class FrameworkSupport {
    constructor() {
        this.frameworks = new Map();
        this.detectionPatterns = new Map();
        this.initializeFrameworks();
    }

    /**
     * Initialize all supported testing frameworks
     */
    initializeFrameworks() {
        // Jest
        this.frameworks.set('jest', new JestFramework());
        this.detectionPatterns.set('jest', [
            /jest\.config\.(js|ts|json)/,
            /"jest".*:.*{/,
            /import.*from.*['"]jest['"]/,
            /describe\s*\(/,
            /it\s*\(/,
            /test\s*\(/,
            /expect\s*\(/
        ]);

        // Vitest
        this.frameworks.set('vitest', new VitestFramework());
        this.detectionPatterns.set('vitest', [
            /vitest\.config\.(js|ts)/,
            /import.*vitest/,
            /import.*{.*vi.*}.*from.*['"]vitest['"]/,
            /@vitest\/ui/,
            /vite-node/
        ]);

        // Playwright
        this.frameworks.set('playwright', new PlaywrightFramework());
        this.detectionPatterns.set('playwright', [
            /playwright\.config\.(js|ts)/,
            /import.*{.*test.*}.*from.*['"]@playwright\/test['"]/,
            /import.*{.*Page.*}.*from.*['"]playwright['"]/,
            /test\.describe/,
            /test\.beforeEach/,
            /await.*page\./
        ]);

        // Cypress
        this.frameworks.set('cypress', new CypressFramework());
        this.detectionPatterns.set('cypress', [
            /cypress\.config\.(js|ts)/,
            /cypress\.json/,
            /cy\./,
            /Cypress\./,
            /import.*cypress/,
            /visit\s*\(/,
            /get\s*\(['"]/
        ]);

        // Mocha
        this.frameworks.set('mocha', new MochaFramework());
        this.detectionPatterns.set('mocha', [
            /\.mocharc\./,
            /mocha\.opts/,
            /import.*mocha/,
            /describe\s*\(/,
            /it\s*\(/,
            /before\s*\(/,
            /after\s*\(/
        ]);

        // Jasmine
        this.frameworks.set('jasmine', new JasmineFramework());
        this.detectionPatterns.set('jasmine', [
            /jasmine\.json/,
            /import.*jasmine/,
            /describe\s*\(/,
            /it\s*\(/,
            /expect\s*\(/,
            /spyOn\s*\(/
        ]);

        // QUnit
        this.frameworks.set('qunit', new QUnitFramework());
        this.detectionPatterns.set('qunit', [
            /QUnit\./,
            /import.*qunit/,
            /module\s*\(['"]/,
            /test\s*\(['"]/,
            /assert\./
        ]);

        // Ava
        this.frameworks.set('ava', new AvaFramework());
        this.detectionPatterns.set('ava', [
            /import.*test.*from.*['"]ava['"]/,
            /ava\.config\./,
            /test\s*\(['"]/,
            /t\.is\s*\(/,
            /t\.throws\s*\(/
        ]);

        console.log(`Initialized ${this.frameworks.size} testing frameworks`);
    }

    /**
     * Detect which testing framework is being used
     * @param {string} code - Source code to analyze
     * @param {object} context - Project context (package.json, file structure, etc.)
     * @returns {Array} Array of detected frameworks
     */
    detectFrameworks(code, context = {}) {
        const detected = [];

        // Check each framework's patterns
        for (const [frameworkName, patterns] of this.detectionPatterns) {
            let score = 0;

            // Check code patterns
            for (const pattern of patterns) {
                if (pattern.test(code)) {
                    score++;
                }
            }

            // Check package.json dependencies
            if (context.dependencies) {
                const allDeps = { ...context.dependencies, ...context.devDependencies };
                if (allDeps[frameworkName] ||
                    allDeps[`@${frameworkName}/core`] ||
                    allDeps[`@types/${frameworkName}`]) {
                    score += 3; // Strong indicator
                }
            }

            // Check config files
            if (context.configFiles) {
                const frameworkConfigs = context.configFiles.filter(file =>
                    file.includes(frameworkName) ||
                    patterns.some(p => p.test(file))
                );
                score += frameworkConfigs.length * 2;
            }

            // Check test directory structure
            if (context.testFiles) {
                const frameworkTests = context.testFiles.filter(file =>
                    patterns.some(p => p.test(file))
                );
                score += frameworkTests.length;
            }

            if (score > 0) {
                detected.push({
                    name: frameworkName,
                    confidence: Math.min(score * 20, 100), // Convert to percentage
                    framework: this.frameworks.get(frameworkName)
                });
            }
        }

        // Sort by confidence
        detected.sort((a, b) => b.confidence - a.confidence);

        // If no framework detected, default to Jest (most common)
        if (detected.length === 0) {
            detected.push({
                name: 'jest',
                confidence: 30, // Low confidence default
                framework: this.frameworks.get('jest')
            });
        }

        return detected;
    }

    /**
     * Generate tests using the most appropriate framework
     * @param {object} codeAnalysis - AST analysis of the code
     * @param {object} options - Test generation options
     * @param {object} context - Project context
     * @returns {object} Generated test code and metadata
     */
    async generateTests(codeAnalysis, options = {}, context = {}) {
        const detectedFrameworks = this.detectFrameworks(codeAnalysis.code || '', context);
        const primaryFramework = options.framework ?
            this.frameworks.get(options.framework) :
            detectedFrameworks[0]?.framework;

        if (!primaryFramework) {
            throw new Error('No suitable testing framework found or specified');
        }

        const frameworkName = options.framework || detectedFrameworks[0]?.name;

        try {
            // Generate comprehensive tests
            const testResults = await primaryFramework.generateTests(codeAnalysis, {
                ...options,
                detectedFrameworks,
                context
            });

            return {
                framework: frameworkName,
                confidence: detectedFrameworks[0]?.confidence || 100,
                tests: testResults,
                metadata: {
                    generatedAt: new Date().toISOString(),
                    framework: frameworkName,
                    testTypes: options.testTypes || ['unit'],
                    alternativeFrameworks: detectedFrameworks.slice(1).map(f => f.name)
                }
            };
        } catch (error) {
            console.error(`Test generation failed for ${frameworkName}:`, error);

            // Fallback to generic framework
            const fallbackFramework = this.frameworks.get('jest'); // Jest as fallback
            const fallbackTests = await fallbackFramework.generateTests(codeAnalysis, options);

            return {
                framework: 'jest',
                confidence: 50,
                tests: fallbackTests,
                metadata: {
                    generatedAt: new Date().toISOString(),
                    framework: 'jest',
                    testTypes: options.testTypes || ['unit'],
                    fallback: true,
                    originalFramework: frameworkName,
                    error: error.message
                }
            };
        }
    }

    /**
     * Get framework-specific configuration
     */
    getFrameworkConfig(frameworkName) {
        const framework = this.frameworks.get(frameworkName);
        return framework ? framework.getConfig() : null;
    }

    /**
     * Get all supported frameworks
     */
    getSupportedFrameworks() {
        return Array.from(this.frameworks.keys());
    }
}

/**
 * Base class for all testing frameworks
 */
class BaseFramework {
    constructor(name) {
        this.name = name;
        this.patterns = {};
        this.config = {};
    }

    async generateTests(codeAnalysis, options = {}) {
        const tests = {
            unit: [],
            integration: [],
            e2e: [],
            api: []
        };

        const requestedTypes = options.testTypes || ['unit'];

        for (const testType of requestedTypes) {
            switch (testType) {
                case 'unit':
                    tests.unit = await this.generateUnitTests(codeAnalysis, options);
                    break;
                case 'integration':
                    tests.integration = await this.generateIntegrationTests(codeAnalysis, options);
                    break;
                case 'e2e':
                    tests.e2e = await this.generateE2ETests(codeAnalysis, options);
                    break;
                case 'api':
                    tests.api = await this.generateAPITests(codeAnalysis, options);
                    break;
                default:
                    console.warn(`Unknown test type: ${testType}`);
            }
        }

        return tests;
    }

    async generateUnitTests(codeAnalysis, options) {
        // Override in subclasses
        return this.generateBasicUnitTests(codeAnalysis, options);
    }

    async generateIntegrationTests(codeAnalysis, options) {
        // Override in subclasses
        return this.generateBasicIntegrationTests(codeAnalysis, options);
    }

    async generateE2ETests(codeAnalysis, options) {
        // Override in subclasses
        return this.generateBasicE2ETests(codeAnalysis, options);
    }

    async generateAPITests(codeAnalysis, options) {
        // Override in subclasses
        return this.generateBasicAPITests(codeAnalysis, options);
    }

    // Common test generation methods
    generateBasicUnitTests(codeAnalysis, _options) {
        const tests = [];

        // Generate tests for functions
        if (codeAnalysis.functions) {
            for (const func of codeAnalysis.functions) {
                tests.push(this.generateFunctionTest(func));
            }
        }

        // Generate tests for classes
        if (codeAnalysis.classes) {
            for (const cls of codeAnalysis.classes) {
                tests.push(this.generateClassTests(cls));
            }
        }

        return tests;
    }

    generateFunctionTest(functionInfo) {
        // Override in subclasses for framework-specific syntax
        return {
            type: 'function',
            name: functionInfo.name,
            tests: [
                `// Test ${functionInfo.name}`,
                `// TODO: Add specific tests for ${functionInfo.name}`
            ]
        };
    }

    generateClassTests(classInfo) {
        // Override in subclasses for framework-specific syntax
        return {
            type: 'class',
            name: classInfo.name,
            tests: [
                `// Test ${classInfo.name}`,
                `// TODO: Add specific tests for ${classInfo.name}`
            ]
        };
    }

    generateBasicIntegrationTests(codeAnalysis, _options) {
        return [{
            type: 'integration',
            description: 'Basic integration test template',
            code: '// Integration tests to be implemented'
        }];
    }

    generateBasicE2ETests(codeAnalysis, _options) {
        return [{
            type: 'e2e',
            description: 'Basic E2E test template',
            code: '// E2E tests to be implemented'
        }];
    }

    generateBasicAPITests(codeAnalysis, _options) {
        return [{
            type: 'api',
            description: 'Basic API test template',
            code: '// API tests to be implemented'
        }];
    }

    getConfig() {
        return this.config;
    }
}

/**
 * Jest Framework Implementation
 */
class JestFramework extends BaseFramework {
    constructor() {
        super('jest');
        this.config = {
            testEnvironment: 'node',
            setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
            testMatch: ['**/__tests__/**/*.(js|jsx|ts|tsx)', '**/*.(test|spec).(js|jsx|ts|tsx)'],
            collectCoverageFrom: [
                'src/**/*.{js,jsx,ts,tsx}',
                '!src/**/*.d.ts',
                '!src/index.js'
            ],
            coverageThreshold: {
                global: {
                    branches: 80,
                    functions: 80,
                    lines: 80,
                    statements: 80
                }
            }
        };
    }

    generateFunctionTest(functionInfo) {
        const testCases = [];

        // Basic test structure
        testCases.push(`describe('${functionInfo.name}', () => {`);

        // Positive test cases
        testCases.push(`    test('should work with valid input', () => {`);
        testCases.push(`        // Arrange`);
        if (functionInfo.parameters && functionInfo.parameters.length > 0) {
            const params = functionInfo.parameters.map(p => this.generateMockValue(p.type)).join(', ');
            testCases.push(`        const result = ${functionInfo.name}(${params});`);
        } else {
            testCases.push(`        const result = ${functionInfo.name}();`);
        }
        testCases.push(`        `);
        testCases.push(`        // Assert`);
        testCases.push(`        expect(result).toBeDefined();`);
        testCases.push(`    });`);

        // Error test cases if function can throw
        if (functionInfo.throws || functionInfo.testHints?.errorTesting) {
            testCases.push(`    `);
            testCases.push(`    test('should handle error conditions', () => {`);
            testCases.push(`        expect(() => {`);
            testCases.push(`            ${functionInfo.name}(null);`);
            testCases.push(`        }).toThrow();`);
            testCases.push(`    });`);
        }

        // Async test cases
        if (functionInfo.isAsync) {
            testCases.push(`    `);
            testCases.push(`    test('should handle async operations', async () => {`);
            testCases.push(`        const result = await ${functionInfo.name}();`);
            testCases.push(`        expect(result).toBeDefined();`);
            testCases.push(`    });`);
        }

        // Edge cases based on parameters
        if (functionInfo.parameters) {
            for (const param of functionInfo.parameters) {
                if (param.type === 'string') {
                    testCases.push(`    `);
                    testCases.push(`    test('should handle empty string for ${param.name}', () => {`);
                    testCases.push(`        const result = ${functionInfo.name}('');`);
                    testCases.push(`        expect(result).toBeDefined();`);
                    testCases.push(`    });`);
                }

                if (param.type === 'number') {
                    testCases.push(`    `);
                    testCases.push(`    test('should handle zero for ${param.name}', () => {`);
                    testCases.push(`        const result = ${functionInfo.name}(0);`);
                    testCases.push(`        expect(result).toBeDefined();`);
                    testCases.push(`    });`);
                }

                if (param.type === 'array') {
                    testCases.push(`    `);
                    testCases.push(`    test('should handle empty array for ${param.name}', () => {`);
                    testCases.push(`        const result = ${functionInfo.name}([]);`);
                    testCases.push(`        expect(result).toBeDefined();`);
                    testCases.push(`    });`);
                }
            }
        }

        testCases.push(`});`);

        return {
            type: 'function',
            name: functionInfo.name,
            framework: 'jest',
            code: testCases.join('\n'),
            imports: ['// Add necessary imports here'],
            setup: this.generateTestSetup(functionInfo),
            mocks: this.generateMocks(functionInfo)
        };
    }

    generateClassTests(classInfo) {
        const testCases = [];

        testCases.push(`describe('${classInfo.name}', () => {`);
        testCases.push(`    let instance;`);
        testCases.push(`    `);
        testCases.push(`    beforeEach(() => {`);
        if (classInfo.constructors && classInfo.constructors.length > 0) {
            const params = classInfo.constructors[0].parameters?.map(p => this.generateMockValue(p.type)).join(', ') || '';
            testCases.push(`        instance = new ${classInfo.name}(${params});`);
        } else {
            testCases.push(`        instance = new ${classInfo.name}();`);
        }
        testCases.push(`    });`);
        testCases.push(`    `);

        // Constructor tests
        testCases.push(`    describe('constructor', () => {`);
        testCases.push(`        test('should create instance', () => {`);
        testCases.push(`            expect(instance).toBeInstanceOf(${classInfo.name});`);
        testCases.push(`        });`);
        testCases.push(`    });`);

        // Method tests
        if (classInfo.methods && classInfo.methods.length > 0) {
            for (const method of classInfo.methods) {
                testCases.push(`    `);
                testCases.push(`    describe('${method.name}', () => {`);
                testCases.push(`        test('should exist', () => {`);
                testCases.push(`            expect(typeof instance.${method.name}).toBe('function');`);
                testCases.push(`        });`);

                if (method.isAsync) {
                    testCases.push(`        `);
                    testCases.push(`        test('should handle async operation', async () => {`);
                    testCases.push(`            const result = await instance.${method.name}();`);
                    testCases.push(`            expect(result).toBeDefined();`);
                    testCases.push(`        });`);
                }

                testCases.push(`    });`);
            }
        }

        testCases.push(`});`);

        return {
            type: 'class',
            name: classInfo.name,
            framework: 'jest',
            code: testCases.join('\n'),
            imports: ['// Add necessary imports here'],
            setup: this.generateClassTestSetup(classInfo),
            mocks: this.generateClassMocks(classInfo)
        };
    }

    generateTestSetup(functionInfo) {
        const setup = [];

        if (functionInfo.dependencies && functionInfo.dependencies.length > 0) {
            setup.push('// Mock dependencies');
            for (const dep of functionInfo.dependencies) {
                setup.push(`jest.mock('${dep}');`);
            }
        }

        if (functionInfo.sideEffects && functionInfo.sideEffects.length > 0) {
            setup.push('// Setup for functions with side effects');
            setup.push('beforeEach(() => {');
            setup.push('    jest.clearAllMocks();');
            setup.push('});');
        }

        return setup;
    }

    generateMocks(functionInfo) {
        const mocks = [];

        if (functionInfo.dependencies) {
            for (const dep of functionInfo.dependencies) {
                mocks.push(`const mock${dep} = jest.fn();`);
            }
        }

        return mocks;
    }

    generateClassTestSetup(classInfo) {
        const setup = [];

        setup.push('beforeEach(() => {');
        setup.push('    jest.clearAllMocks();');
        setup.push('});');

        if (classInfo.dependencies && classInfo.dependencies.length > 0) {
            setup.push('');
            setup.push('// Mock dependencies');
            for (const dep of classInfo.dependencies) {
                setup.push(`jest.mock('${dep}');`);
            }
        }

        return setup;
    }

    generateClassMocks(classInfo) {
        const mocks = [];

        if (classInfo.methods) {
            for (const method of classInfo.methods) {
                if (method.name.includes('api') || method.name.includes('fetch') || method.name.includes('request')) {
                    mocks.push(`const mock${method.name} = jest.fn().mockResolvedValue({});`);
                }
            }
        }

        return mocks;
    }

    generateMockValue(type) {
        const mockValues = {
            'string': "'test'",
            'number': "42",
            'boolean': "true",
            'array': "[]",
            'object': "{}",
            'function': "jest.fn()",
            'date': "new Date()",
            'undefined': "undefined",
            'null': "null",
            'any': "'test'"
        };

        return mockValues[type] || mockValues.any;
    }
}

/**
 * Vitest Framework Implementation
 */
class VitestFramework extends BaseFramework {
    constructor() {
        super('vitest');
        this.config = {
            testEnvironment: 'jsdom',
            setupFiles: ['./vitest.setup.js'],
            include: ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
            coverage: {
                provider: 'c8',
                reporter: ['text', 'json', 'html'],
                exclude: ['node_modules/', 'test/']
            }
        };
    }

    generateFunctionTest(functionInfo) {
        const jestTest = new JestFramework().generateFunctionTest(functionInfo);

        // Convert Jest syntax to Vitest
        let vitestCode = jestTest.code
            .replace(/jest\./g, 'vi.')
            .replace(/expect\(/g, 'expect(')
            .replace(/describe\(/g, 'describe(')
            .replace(/test\(/g, 'test(')
            .replace(/beforeEach\(/g, 'beforeEach(');

        return {
            ...jestTest,
            framework: 'vitest',
            code: vitestCode,
            imports: [
                "import { describe, test, expect, beforeEach, vi } from 'vitest';"
            ]
        };
    }

    generateMockValue(type) {
        const mockValues = {
            'string': "'test'",
            'number': "42",
            'boolean': "true",
            'array': "[]",
            'object': "{}",
            'function': "vi.fn()",
            'date': "new Date()",
            'undefined': "undefined",
            'null': "null",
            'any': "'test'"
        };

        return mockValues[type] || mockValues.any;
    }
}

/**
 * Playwright Framework Implementation
 */
class PlaywrightFramework extends BaseFramework {
    constructor() {
        super('playwright');
        this.config = {
            testDir: './tests',
            timeout: 30000,
            use: {
                browserName: 'chromium',
                viewport: { width: 1280, height: 720 },
                screenshot: 'only-on-failure',
                trace: 'retain-on-failure'
            },
            projects: [
                { name: 'chromium', use: { browserName: 'chromium', viewport: { width: 1280, height: 720 } } },
                { name: 'firefox', use: { browserName: 'firefox', viewport: { width: 1280, height: 720 } } },
                { name: 'webkit', use: { browserName: 'webkit', viewport: { width: 1280, height: 720 } } }
            ]
        };
    }

    async generateE2ETests(codeAnalysis, options) {
        const tests = [];

        // Generate basic page tests
        if (codeAnalysis.functions) {
            const uiFunctions = codeAnalysis.functions.filter(f =>
                f.name.includes('render') ||
                f.name.includes('component') ||
                f.name.includes('ui')
            );

            for (const func of uiFunctions) {
                tests.push(this.generatePlaywrightTest(func, options));
            }
        }

        if (tests.length === 0) {
            // Default E2E test
            tests.push({
                type: 'e2e',
                framework: 'playwright',
                code: this.generateDefaultE2ETest(),
                imports: ["import { test, expect } from '@playwright/test';"]
            });
        }

        return tests;
    }

    generatePlaywrightTest(functionInfo, _options) {
        const testCases = [];

        testCases.push(`test.describe('${functionInfo.name} E2E Tests', () => {`);
        testCases.push(`    test('should render and interact correctly', async ({ page }) => {`);
        testCases.push(`        // Navigate to the page`);
        testCases.push(`        await page.goto('/');`);
        testCases.push(`        `);
        testCases.push(`        // Test the component/function behavior`);
        testCases.push(`        const element = page.locator('[data-testid="${functionInfo.name.toLowerCase()}"]');`);
        testCases.push(`        await expect(element).toBeVisible();`);
        testCases.push(`        `);
        testCases.push(`        // Interact with the element`);
        testCases.push(`        await element.click();`);
        testCases.push(`        `);
        testCases.push(`        // Assert expected behavior`);
        testCases.push(`        await expect(page).toHaveURL(/.*success.*/);`);
        testCases.push(`    });`);
        testCases.push(`});`);

        return {
            type: 'e2e',
            name: functionInfo.name,
            framework: 'playwright',
            code: testCases.join('\n'),
            imports: ["import { test, expect } from '@playwright/test';"]
        };
    }

    generateDefaultE2ETest() {
        return `test.describe('Application E2E Tests', () => {
    test('should load the application', async ({ page }) => {
        await page.goto('/');

        // Check if the page loads correctly
        await expect(page).toHaveTitle(/.*App.*/);

        // Check for main content
        const mainContent = page.locator('main, #app, [data-testid="app"]');
        await expect(mainContent).toBeVisible();
    });

    test('should handle navigation', async ({ page }) => {
        await page.goto('/');

        // Test navigation if links exist
        const navLinks = page.locator('a[href*="/"]');
        const count = await navLinks.count();

        if (count > 0) {
            await navLinks.first().click();
            await expect(page).toHaveURL(/.*\/.+/);
        }
    });
});`;
    }
}

/**
 * Cypress Framework Implementation
 */
class CypressFramework extends BaseFramework {
    constructor() {
        super('cypress');
        this.config = {
            baseUrl: 'http://localhost:3000',
            viewportWidth: 1280,
            viewportHeight: 720,
            video: false,
            screenshotOnRunFailure: true,
            supportFile: 'cypress/support/e2e.js',
            specPattern: 'cypress/e2e/**/*.cy.{js,jsx,ts,tsx}'
        };
    }

    async generateE2ETests(codeAnalysis, options) {
        const tests = [];

        // Generate Cypress-specific E2E tests
        if (codeAnalysis.functions) {
            const uiFunctions = codeAnalysis.functions.filter(f =>
                f.name.includes('render') ||
                f.name.includes('component') ||
                f.name.includes('ui')
            );

            for (const func of uiFunctions) {
                tests.push(this.generateCypressTest(func, options));
            }
        }

        if (tests.length === 0) {
            tests.push({
                type: 'e2e',
                framework: 'cypress',
                code: this.generateDefaultCypressTest(),
                imports: []
            });
        }

        return tests;
    }

    generateCypressTest(functionInfo, _options) {
        const testCases = [];

        testCases.push(`describe('${functionInfo.name} E2E Tests', () => {`);
        testCases.push(`    beforeEach(() => {`);
        testCases.push(`        cy.visit('/');`);
        testCases.push(`    });`);
        testCases.push(`    `);
        testCases.push(`    it('should render and work correctly', () => {`);
        testCases.push(`        // Find and interact with the component`);
        testCases.push(`        cy.get('[data-testid="${functionInfo.name.toLowerCase()}"]')`);
        testCases.push(`            .should('be.visible')`);
        testCases.push(`            .click();`);
        testCases.push(`        `);
        testCases.push(`        // Assert expected behavior`);
        testCases.push(`        cy.url().should('include', '/success');`);
        testCases.push(`    });`);
        testCases.push(`});`);

        return {
            type: 'e2e',
            name: functionInfo.name,
            framework: 'cypress',
            code: testCases.join('\n'),
            imports: []
        };
    }

    generateDefaultCypressTest() {
        return `describe('Application E2E Tests', () => {
    beforeEach(() => {
        cy.visit('/');
    });

    it('should load the application', () => {
        // Check if the page loads correctly
        cy.title().should('contain', 'App');

        // Check for main content
        cy.get('main, #app, [data-testid="app"]')
            .should('be.visible');
    });

    it('should handle user interactions', () => {
        // Test basic interactions
        cy.get('button, input, a').first().should('be.visible');

        // Test form submission if forms exist
        cy.get('form').then(($form) => {
            if ($form.length > 0) {
                cy.get('input[type="submit"], button[type="submit"]')
                    .first()
                    .click();
            }
        });
    });
});`;
    }
}

/**
 * Additional Framework Implementations
 */

class MochaFramework extends BaseFramework {
    constructor() {
        super('mocha');
        this.config = {
            timeout: 5000,
            recursive: true,
            require: ['ts-node/register'],
            spec: ['test/**/*.spec.js', 'test/**/*.test.js']
        };
    }

    generateFunctionTest(functionInfo) {
        const jestTest = new JestFramework().generateFunctionTest(functionInfo);

        // Convert Jest syntax to Mocha
        let mochaCode = jestTest.code
            .replace(/describe\(/g, 'describe(')
            .replace(/test\(/g, 'it(')
            .replace(/expect\(/g, 'expect(')
            .replace(/beforeEach\(/g, 'beforeEach(')
            .replace(/jest\./g, 'sinon.');

        return {
            ...jestTest,
            framework: 'mocha',
            code: mochaCode,
            imports: [
                "const { expect } = require('chai');",
                "const sinon = require('sinon');"
            ]
        };
    }
}

class JasmineFramework extends BaseFramework {
    constructor() {
        super('jasmine');
        this.config = {
            spec_dir: 'spec',
            spec_files: ['**/*[sS]pec.js'],
            helpers: ['helpers/**/*.js'],
            stopSpecOnExpectationFailure: false,
            random: true
        };
    }

    generateFunctionTest(functionInfo) {
        const jestTest = new JestFramework().generateFunctionTest(functionInfo);

        // Convert Jest syntax to Jasmine
        let jasmineCode = jestTest.code
            .replace(/test\(/g, 'it(')
            .replace(/jest\./g, 'jasmine.');

        return {
            ...jestTest,
            framework: 'jasmine',
            code: jasmineCode,
            imports: []
        };
    }
}

class QUnitFramework extends BaseFramework {
    constructor() {
        super('qunit');
        this.config = {
            autostart: false,
            module: 'default'
        };
    }

    generateFunctionTest(functionInfo) {
        const testCases = [];

        testCases.push(`QUnit.module('${functionInfo.name}', function() {`);
        testCases.push(`    QUnit.test('should work correctly', function(assert) {`);
        if (functionInfo.parameters && functionInfo.parameters.length > 0) {
            const params = functionInfo.parameters.map(p => this.generateMockValue(p.type)).join(', ');
            testCases.push(`        const result = ${functionInfo.name}(${params});`);
        } else {
            testCases.push(`        const result = ${functionInfo.name}();`);
        }
        testCases.push(`        assert.ok(result !== undefined, 'Function should return a value');`);
        testCases.push(`    });`);
        testCases.push(`});`);

        return {
            type: 'function',
            name: functionInfo.name,
            framework: 'qunit',
            code: testCases.join('\n'),
            imports: []
        };
    }

    generateMockValue(type) {
        const mockValues = {
            'string': "'test'",
            'number': "42",
            'boolean': "true",
            'array': "[]",
            'object': "{}",
            'function': "function() {}",
            'date': "new Date()",
            'undefined': "undefined",
            'null': "null",
            'any': "'test'"
        };

        return mockValues[type] || mockValues.any;
    }
}

class AvaFramework extends BaseFramework {
    constructor() {
        super('ava');
        this.config = {
            files: ['test/**/*'],
            match: ['**/test/**/*', '!**/node_modules/**/*'],
            concurrency: 5,
            failFast: true,
            tap: true,
            verbose: true
        };
    }

    generateFunctionTest(functionInfo) {
        const testCases = [];

        testCases.push(`import test from 'ava';`);
        testCases.push(`import { ${functionInfo.name} } from '../src/index.js';`);
        testCases.push(``);
        testCases.push(`test('${functionInfo.name} should work correctly', t => {`);
        if (functionInfo.parameters && functionInfo.parameters.length > 0) {
            const params = functionInfo.parameters.map(p => this.generateMockValue(p.type)).join(', ');
            testCases.push(`    const result = ${functionInfo.name}(${params});`);
        } else {
            testCases.push(`    const result = ${functionInfo.name}();`);
        }
        testCases.push(`    t.truthy(result);`);
        testCases.push(`});`);

        if (functionInfo.isAsync) {
            testCases.push(``);
            testCases.push(`test('${functionInfo.name} should handle async operations', async t => {`);
            testCases.push(`    const result = await ${functionInfo.name}();`);
            testCases.push(`    t.truthy(result);`);
            testCases.push(`});`);
        }

        return {
            type: 'function',
            name: functionInfo.name,
            framework: 'ava',
            code: testCases.join('\n'),
            imports: [`import test from 'ava';`]
        };
    }

    generateMockValue(type) {
        const mockValues = {
            'string': "'test'",
            'number': "42",
            'boolean': "true",
            'array': "[]",
            'object': "{}",
            'function': "() => {}",
            'date': "new Date()",
            'undefined': "undefined",
            'null': "null",
            'any': "'test'"
        };

        return mockValues[type] || mockValues.any;
    }
}

export { FrameworkSupport };
// Test Pattern Learning System
// Analyzes existing tests to learn and match team's coding patterns

class TestPatternLearning {
    constructor() {
        this.patterns = new Map();
        this.cache = new Map();
        this.confidence = new Map();
        this.initializePatterns();
    }

    /**
     * Initialize pattern categories and detectors
     */
    initializePatterns() {
        // Pattern categories to learn
        this.patternCategories = {
            naming: {
                testFiles: [],
                testSuites: [],
                testCases: [],
                variables: []
            },
            structure: {
                arrangement: [], // Arrange-Act-Assert, Given-When-Then, etc.
                setup: [],
                teardown: [],
                mocking: []
            },
            assertions: {
                styles: [], // expect(), assert(), should, etc.
                patterns: [],
                customMatchers: []
            },
            framework: {
                hooks: [], // beforeEach, beforeAll, etc.
                utilities: [],
                configuration: []
            },
            documentation: {
                comments: [],
                descriptions: [],
                tags: []
            }
        };

        console.log('Test pattern learning system initialized');
    }

    /**
     * Analyze existing test files to learn patterns
     * @param {Array} testFiles - Array of test file contents and paths
     * @param {object} context - Project context
     * @returns {object} Learned patterns
     */
    async analyzeExistingTests(testFiles, context = {}) {
        const analysisResults = {
            patterns: {},
            confidence: {},
            statistics: {},
            recommendations: []
        };

        if (!testFiles || testFiles.length === 0) {
            console.log('No existing test files found for pattern learning');
            return this.getDefaultPatterns();
        }

        try {
            console.log(`Analyzing ${testFiles.length} existing test files for patterns...`);

            // Analyze each test file
            const fileAnalyses = [];
            for (const testFile of testFiles) {
                const analysis = await this.analyzeTestFile(testFile);
                if (analysis) {
                    fileAnalyses.push(analysis);
                }
            }

            // Extract and consolidate patterns
            analysisResults.patterns = this.extractPatterns(fileAnalyses);
            analysisResults.confidence = this.calculateConfidence(fileAnalyses);
            analysisResults.statistics = this.generateStatistics(fileAnalyses);
            analysisResults.recommendations = this.generateRecommendations(analysisResults);

            // Cache results
            this.cachePatterns(analysisResults.patterns, context);

            console.log('Pattern analysis completed successfully');
            return analysisResults;

        } catch (error) {
            console.error('Pattern analysis failed:', error);
            return this.getDefaultPatterns();
        }
    }

    /**
     * Analyze a single test file for patterns
     */
    async analyzeTestFile(testFile) {
        if (!testFile || !testFile.content) {
            return null;
        }

        const analysis = {
            filePath: testFile.path,
            framework: null,
            patterns: {
                naming: {},
                structure: {},
                assertions: {},
                framework: {},
                documentation: {}
            }
        };

        try {
            const content = testFile.content;

            // Detect testing framework
            analysis.framework = this.detectFramework(content);

            // Analyze naming patterns
            analysis.patterns.naming = this.analyzeNamingPatterns(content, testFile.path);

            // Analyze test structure
            analysis.patterns.structure = this.analyzeStructurePatterns(content);

            // Analyze assertion patterns
            analysis.patterns.assertions = this.analyzeAssertionPatterns(content);

            // Analyze framework-specific patterns
            analysis.patterns.framework = this.analyzeFrameworkPatterns(content, analysis.framework);

            // Analyze documentation patterns
            analysis.patterns.documentation = this.analyzeDocumentationPatterns(content);

            return analysis;

        } catch (error) {
            console.error(`Failed to analyze test file ${testFile.path}:`, error);
            return null;
        }
    }

    /**
     * Analyze naming patterns in test files
     */
    analyzeNamingPatterns(content, filePath) {
        const patterns = {
            fileNaming: this.analyzeFileNaming(filePath),
            testSuites: this.extractTestSuiteNames(content),
            testCases: this.extractTestCaseNames(content),
            variables: this.extractVariableNames(content),
            constants: this.extractConstantNames(content)
        };

        return patterns;
    }

    analyzeFileNaming(filePath) {
        const fileName = filePath.split('/').pop();
        const patterns = {
            extension: fileName.split('.').pop(),
            naming: null,
            directory: filePath.split('/').slice(0, -1).join('/')
        };

        // Common test file patterns
        if (fileName.includes('.test.')) {
            patterns.naming = 'dot-test';
        } else if (fileName.includes('.spec.')) {
            patterns.naming = 'dot-spec';
        } else if (fileName.endsWith('Test.js') || fileName.endsWith('Test.ts')) {
            patterns.naming = 'suffix-test';
        } else if (fileName.endsWith('Spec.js') || fileName.endsWith('Spec.ts')) {
            patterns.naming = 'suffix-spec';
        } else if (filePath.includes('__tests__')) {
            patterns.naming = 'tests-directory';
        }

        return patterns;
    }

    extractTestSuiteNames(content) {
        const suites = [];

        // Match describe blocks
        const describeRegex = /describe\s*\(\s*['"`]([^'"`]+)['"`]/g;
        let match;
        while ((match = describeRegex.exec(content)) !== null) {
            suites.push({
                name: match[1],
                type: 'describe',
                line: this.getLineNumber(content, match.index)
            });
        }

        // Match context blocks (RSpec style)
        const contextRegex = /context\s*\(\s*['"`]([^'"`]+)['"`]/g;
        while ((match = contextRegex.exec(content)) !== null) {
            suites.push({
                name: match[1],
                type: 'context',
                line: this.getLineNumber(content, match.index)
            });
        }

        // Extract naming patterns
        const namingPatterns = this.extractNamingConventions(suites.map(s => s.name));

        return {
            suites,
            namingPatterns,
            count: suites.length
        };
    }

    extractTestCaseNames(content) {
        const testCases = [];

        // Match test/it blocks
        const testRegex = /(?:test|it)\s*\(\s*['"`]([^'"`]+)['"`]/g;
        let match;
        while ((match = testRegex.exec(content)) !== null) {
            testCases.push({
                name: match[1],
                type: match[0].startsWith('test') ? 'test' : 'it',
                line: this.getLineNumber(content, match.index)
            });
        }

        // Extract naming patterns
        const namingPatterns = this.extractNamingConventions(testCases.map(t => t.name));

        return {
            testCases,
            namingPatterns,
            count: testCases.length
        };
    }

    extractVariableNames(content) {
        const variables = [];

        // Extract variable declarations
        const varRegex = /(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
        let match;
        while ((match = varRegex.exec(content)) !== null) {
            variables.push({
                name: match[1],
                type: 'variable',
                line: this.getLineNumber(content, match.index)
            });
        }

        // Analyze naming patterns
        const patterns = {
            camelCase: variables.filter(v => /^[a-z][a-zA-Z0-9]*$/.test(v.name)).length,
            snake_case: variables.filter(v => /^[a-z][a-z0-9_]*$/.test(v.name)).length,
            PascalCase: variables.filter(v => /^[A-Z][a-zA-Z0-9]*$/.test(v.name)).length,
            prefixes: this.extractCommonPrefixes(variables.map(v => v.name)),
            suffixes: this.extractCommonSuffixes(variables.map(v => v.name))
        };

        return {
            variables: variables.slice(0, 50), // Limit for performance
            patterns,
            count: variables.length
        };
    }

    extractConstantNames(content) {
        const constants = [];

        // Extract constants (UPPER_CASE pattern)
        const constRegex = /(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*=/g;
        let match;
        while ((match = constRegex.exec(content)) !== null) {
            constants.push({
                name: match[1],
                line: this.getLineNumber(content, match.index)
            });
        }

        return {
            constants,
            count: constants.length,
            patterns: this.extractCommonPrefixes(constants.map(c => c.name))
        };
    }

    /**
     * Analyze test structure patterns
     */
    analyzeStructurePatterns(content) {
        const patterns = {
            arrangement: this.detectArrangementPatterns(content),
            setup: this.analyzeSetupPatterns(content),
            teardown: this.analyzeTeardownPatterns(content),
            mocking: this.analyzeMockingPatterns(content),
            organization: this.analyzeOrganizationPatterns(content)
        };

        return patterns;
    }

    detectArrangementPatterns(content) {
        const patterns = {
            arrangeActAssert: 0,
            givenWhenThen: 0,
            setup: 0
        };

        // Detect AAA pattern
        const aaaRegex = /\/\*?\*?\s*(?:arrange|act|assert)/gi;
        patterns.arrangeActAssert = (content.match(aaaRegex) || []).length;

        // Detect GWT pattern
        const gwtRegex = /\/\*?\*?\s*(?:given|when|then)/gi;
        patterns.givenWhenThen = (content.match(gwtRegex) || []).length;

        // Detect setup pattern
        const setupRegex = /\/\*?\*?\s*setup/gi;
        patterns.setup = (content.match(setupRegex) || []).length;

        return patterns;
    }

    analyzeSetupPatterns(content) {
        const patterns = {
            beforeEach: (content.match(/beforeEach\s*\(/g) || []).length,
            beforeAll: (content.match(/beforeAll\s*\(/g) || []).length,
            before: (content.match(/before\s*\(/g) || []).length,
            setup: (content.match(/setup\s*\(/g) || []).length,
            customSetup: this.extractCustomSetupMethods(content)
        };

        return patterns;
    }

    analyzeTeardownPatterns(content) {
        const patterns = {
            afterEach: (content.match(/afterEach\s*\(/g) || []).length,
            afterAll: (content.match(/afterAll\s*\(/g) || []).length,
            after: (content.match(/after\s*\(/g) || []).length,
            teardown: (content.match(/teardown\s*\(/g) || []).length,
            cleanup: (content.match(/cleanup\s*\(/g) || []).length
        };

        return patterns;
    }

    analyzeMockingPatterns(content) {
        const patterns = {
            jestMocks: (content.match(/jest\.mock\(/g) || []).length,
            jestSpies: (content.match(/jest\.spyOn\(/g) || []).length,
            jestFn: (content.match(/jest\.fn\(\)/g) || []).length,
            sinonMocks: (content.match(/sinon\./g) || []).length,
            viMocks: (content.match(/vi\.mock\(/g) || []).length,
            customMocks: this.extractCustomMockPatterns(content),
            mockLibraries: this.detectMockLibraries(content)
        };

        return patterns;
    }

    analyzeOrganizationPatterns(content) {
        const patterns = {
            nestedDescribes: this.countNestedDescribes(content),
            testGrouping: this.analyzeTestGrouping(content),
            fileStructure: this.analyzeFileStructure(content)
        };

        return patterns;
    }

    /**
     * Analyze assertion patterns
     */
    analyzeAssertionPatterns(content) {
        const patterns = {
            expectStyle: (content.match(/expect\(/g) || []).length,
            assertStyle: (content.match(/assert\./g) || []).length,
            shouldStyle: (content.match(/\.should\./g) || []).length,
            customMatchers: this.extractCustomMatchers(content),
            commonMatchers: this.analyzeCommonMatchers(content),
            errorAssertions: this.analyzeErrorAssertions(content)
        };

        return patterns;
    }

    extractCustomMatchers(content) {
        const matchers = [];

        // Look for custom matcher definitions
        const customMatcherRegex = /expect\.extend\s*\(\s*\{([^}]+)\}/g;
        let match;
        while ((match = customMatcherRegex.exec(content)) !== null) {
            const matcherContent = match[1];
            const matcherNames = matcherContent.match(/(\w+)\s*:/g);
            if (matcherNames) {
                matchers.push(...matcherNames.map(m => m.replace(':', '').trim()));
            }
        }

        // Look for custom matcher usage
        const usageRegex = /\.to([A-Z][a-zA-Z]*)\(/g;
        while ((match = usageRegex.exec(content)) !== null) {
            if (!['toBe', 'toEqual', 'toHaveBeenCalled'].includes(`to${match[1]}`)) {
                matchers.push(`to${match[1]}`);
            }
        }

        return [...new Set(matchers)];
    }

    analyzeCommonMatchers(content) {
        const matchers = {
            toBe: (content.match(/\.toBe\(/g) || []).length,
            toEqual: (content.match(/\.toEqual\(/g) || []).length,
            toBeNull: (content.match(/\.toBeNull\(/g) || []).length,
            toBeUndefined: (content.match(/\.toBeUndefined\(/g) || []).length,
            toBeTruthy: (content.match(/\.toBeTruthy\(/g) || []).length,
            toBeFalsy: (content.match(/\.toBeFalsy\(/g) || []).length,
            toContain: (content.match(/\.toContain\(/g) || []).length,
            toHaveLength: (content.match(/\.toHaveLength\(/g) || []).length,
            toThrow: (content.match(/\.toThrow\(/g) || []).length,
            toHaveBeenCalled: (content.match(/\.toHaveBeenCalled\(/g) || []).length
        };

        return matchers;
    }

    analyzeErrorAssertions(content) {
        const patterns = {
            throwAssertions: (content.match(/\.toThrow/g) || []).length,
            rejectAssertions: (content.match(/\.rejects\./g) || []).length,
            errorHandling: (content.match(/try\s*\{[\s\S]*?\}\s*catch/g) || []).length,
            errorTypes: this.extractErrorTypes(content)
        };

        return patterns;
    }

    /**
     * Analyze framework-specific patterns
     */
    analyzeFrameworkPatterns(content, framework) {
        const patterns = {
            hooks: this.analyzeHooksUsage(content),
            utilities: this.analyzeUtilitiesUsage(content),
            configuration: this.analyzeConfigurationPatterns(content),
            imports: this.analyzeImportPatterns(content),
            frameworkSpecific: this.analyzeFrameworkSpecificPatterns(content, framework)
        };

        return patterns;
    }

    analyzeHooksUsage(content) {
        const hooks = {
            beforeEach: this.extractHookUsage(content, 'beforeEach'),
            beforeAll: this.extractHookUsage(content, 'beforeAll'),
            afterEach: this.extractHookUsage(content, 'afterEach'),
            afterAll: this.extractHookUsage(content, 'afterAll'),
            before: this.extractHookUsage(content, 'before'),
            after: this.extractHookUsage(content, 'after')
        };

        return hooks;
    }

    extractHookUsage(content, hookName) {
        const regex = new RegExp(`${hookName}\\s*\\(([^)]*?)\\s*=>?\\s*\\{([\\s\\S]*?)\\}\\s*\\)`, 'g');
        const usages = [];
        let match;

        while ((match = regex.exec(content)) !== null) {
            usages.push({
                parameters: match[1].trim(),
                body: match[2].trim(),
                line: this.getLineNumber(content, match.index),
                async: match[0].includes('async')
            });
        }

        return {
            count: usages.length,
            usages: usages.slice(0, 5), // Limit for performance
            patterns: this.analyzeHookPatterns(usages)
        };
    }

    analyzeHookPatterns(usages) {
        if (usages.length === 0) return {};

        return {
            commonSetup: this.findCommonSetupPatterns(usages),
            asyncUsage: usages.filter(u => u.async).length,
            averageLength: usages.reduce((sum, u) => sum + u.body.length, 0) / usages.length
        };
    }

    /**
     * Analyze documentation patterns
     */
    analyzeDocumentationPatterns(content) {
        const patterns = {
            comments: this.analyzeCommentPatterns(content),
            descriptions: this.analyzeDescriptionPatterns(content),
            tags: this.analyzeTagPatterns(content),
            documentation: this.analyzeDocumentationStyle(content)
        };

        return patterns;
    }

    analyzeCommentPatterns(content) {
        const comments = {
            singleLine: (content.match(/\/\/[^\n]*\n/g) || []).length,
            multiLine: (content.match(/\/\*[\s\S]*?\*\//g) || []).length,
            jsdoc: (content.match(/\/\*\*[\s\S]*?\*\//g) || []).length,
            todo: (content.match(/\/\/\s*TODO/gi) || []).length,
            fixme: (content.match(/\/\/\s*FIXME/gi) || []).length
        };

        return comments;
    }

    analyzeDescriptionPatterns(content) {
        const descriptions = [];

        // Extract test descriptions from describe/it blocks
        const descRegex = /(?:describe|it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g;
        let match;
        while ((match = descRegex.exec(content)) !== null) {
            descriptions.push(match[1]);
        }

        return {
            descriptions: descriptions.slice(0, 20), // Limit for analysis
            patterns: this.extractDescriptionPatterns(descriptions),
            averageLength: descriptions.length > 0 ?
                descriptions.reduce((sum, d) => sum + d.length, 0) / descriptions.length : 0
        };
    }

    /**
     * Extract consolidated patterns from all analyses
     */
    extractPatterns(fileAnalyses) {
        if (!fileAnalyses || fileAnalyses.length === 0) {
            return this.getDefaultPatterns().patterns;
        }

        const consolidated = {
            naming: this.consolidateNamingPatterns(fileAnalyses),
            structure: this.consolidateStructurePatterns(fileAnalyses),
            assertions: this.consolidateAssertionPatterns(fileAnalyses),
            framework: this.consolidateFrameworkPatterns(fileAnalyses),
            documentation: this.consolidateDocumentationPatterns(fileAnalyses)
        };

        return consolidated;
    }

    consolidateNamingPatterns(analyses) {
        const namingPatterns = {
            fileNaming: {},
            testSuites: {},
            testCases: {},
            variables: {}
        };

        // Consolidate file naming patterns
        const filePatterns = {};
        analyses.forEach(analysis => {
            const pattern = analysis.patterns.naming.fileNaming;
            if (pattern && pattern.naming) {
                filePatterns[pattern.naming] = (filePatterns[pattern.naming] || 0) + 1;
            }
        });

        namingPatterns.fileNaming = {
            preferred: this.getMostCommon(filePatterns),
            distribution: filePatterns
        };

        // Consolidate test case naming
        const testCasePatterns = {};
        analyses.forEach(analysis => {
            const patterns = analysis.patterns.naming.testCases.namingPatterns;
            if (patterns) {
                Object.keys(patterns).forEach(pattern => {
                    testCasePatterns[pattern] = (testCasePatterns[pattern] || 0) + patterns[pattern];
                });
            }
        });

        namingPatterns.testCases = {
            preferred: this.getMostCommon(testCasePatterns),
            patterns: testCasePatterns
        };

        // Consolidate variable naming
        const variablePatterns = {};
        analyses.forEach(analysis => {
            const patterns = analysis.patterns.naming.variables.patterns;
            if (patterns) {
                Object.keys(patterns).forEach(pattern => {
                    if (typeof patterns[pattern] === 'number') {
                        variablePatterns[pattern] = (variablePatterns[pattern] || 0) + patterns[pattern];
                    }
                });
            }
        });

        namingPatterns.variables = {
            preferred: this.getMostCommon(variablePatterns),
            patterns: variablePatterns
        };

        return namingPatterns;
    }

    consolidateStructurePatterns(analyses) {
        const structurePatterns = {
            arrangement: {},
            setup: {},
            teardown: {},
            mocking: {}
        };

        // Consolidate arrangement patterns
        const arrangementTotals = { arrangeActAssert: 0, givenWhenThen: 0, setup: 0 };
        analyses.forEach(analysis => {
            const arrangement = analysis.patterns.structure.arrangement;
            if (arrangement) {
                Object.keys(arrangementTotals).forEach(key => {
                    arrangementTotals[key] += arrangement[key] || 0;
                });
            }
        });

        structurePatterns.arrangement = {
            preferred: this.getMostCommon(arrangementTotals),
            distribution: arrangementTotals
        };

        // Consolidate setup patterns
        const setupTotals = {};
        analyses.forEach(analysis => {
            const setup = analysis.patterns.structure.setup;
            if (setup) {
                Object.keys(setup).forEach(key => {
                    if (typeof setup[key] === 'number') {
                        setupTotals[key] = (setupTotals[key] || 0) + setup[key];
                    }
                });
            }
        });

        structurePatterns.setup = {
            preferred: this.getMostCommon(setupTotals),
            distribution: setupTotals
        };

        // Consolidate mocking patterns
        const mockingTotals = {};
        analyses.forEach(analysis => {
            const mocking = analysis.patterns.structure.mocking;
            if (mocking) {
                Object.keys(mocking).forEach(key => {
                    if (typeof mocking[key] === 'number') {
                        mockingTotals[key] = (mockingTotals[key] || 0) + mocking[key];
                    }
                });
            }
        });

        structurePatterns.mocking = {
            preferred: this.getMostCommon(mockingTotals),
            distribution: mockingTotals
        };

        return structurePatterns;
    }

    consolidateAssertionPatterns(analyses) {
        const assertionPatterns = {
            style: {},
            matchers: {},
            custom: []
        };

        // Consolidate assertion styles
        const styleTotals = {};
        analyses.forEach(analysis => {
            const assertions = analysis.patterns.assertions;
            if (assertions) {
                styleTotals.expect = (styleTotals.expect || 0) + (assertions.expectStyle || 0);
                styleTotals.assert = (styleTotals.assert || 0) + (assertions.assertStyle || 0);
                styleTotals.should = (styleTotals.should || 0) + (assertions.shouldStyle || 0);
            }
        });

        assertionPatterns.style = {
            preferred: this.getMostCommon(styleTotals),
            distribution: styleTotals
        };

        // Consolidate matcher patterns
        const matcherTotals = {};
        analyses.forEach(analysis => {
            const matchers = analysis.patterns.assertions.commonMatchers;
            if (matchers) {
                Object.keys(matchers).forEach(matcher => {
                    matcherTotals[matcher] = (matcherTotals[matcher] || 0) + matchers[matcher];
                });
            }
        });

        assertionPatterns.matchers = {
            mostUsed: this.getMostCommon(matcherTotals),
            distribution: matcherTotals
        };

        // Consolidate custom matchers
        const allCustomMatchers = [];
        analyses.forEach(analysis => {
            const custom = analysis.patterns.assertions.customMatchers;
            if (custom && Array.isArray(custom)) {
                allCustomMatchers.push(...custom);
            }
        });

        assertionPatterns.custom = [...new Set(allCustomMatchers)];

        return assertionPatterns;
    }

    consolidateFrameworkPatterns(analyses) {
        // Similar consolidation for framework patterns
        const frameworkPatterns = {
            hooks: {},
            imports: {},
            utilities: {}
        };

        // Consolidate hook usage
        const hookTotals = {};
        analyses.forEach(analysis => {
            const hooks = analysis.patterns.framework.hooks;
            if (hooks) {
                Object.keys(hooks).forEach(hook => {
                    if (hooks[hook] && typeof hooks[hook].count === 'number') {
                        hookTotals[hook] = (hookTotals[hook] || 0) + hooks[hook].count;
                    }
                });
            }
        });

        frameworkPatterns.hooks = {
            mostUsed: this.getMostCommon(hookTotals),
            distribution: hookTotals
        };

        return frameworkPatterns;
    }

    consolidateDocumentationPatterns(analyses) {
        const docPatterns = {
            comments: {},
            descriptions: {}
        };

        // Consolidate comment patterns
        const commentTotals = {};
        analyses.forEach(analysis => {
            const comments = analysis.patterns.documentation.comments;
            if (comments) {
                Object.keys(comments).forEach(type => {
                    commentTotals[type] = (commentTotals[type] || 0) + comments[type];
                });
            }
        });

        docPatterns.comments = {
            preferred: this.getMostCommon(commentTotals),
            distribution: commentTotals
        };

        return docPatterns;
    }

    /**
     * Apply learned patterns to generate new tests
     */
    async applyPatterns(codeAnalysis, learnedPatterns, options = {}) {
        try {
            const generationOptions = {
                ...options,
                patterns: learnedPatterns,
                style: {
                    naming: learnedPatterns.naming,
                    structure: learnedPatterns.structure,
                    assertions: learnedPatterns.assertions,
                    documentation: learnedPatterns.documentation
                }
            };

            // Generate tests using learned patterns
            const tests = await this.generateTestsWithPatterns(codeAnalysis, generationOptions);

            return {
                tests,
                patternsApplied: learnedPatterns,
                confidence: this.calculatePatternConfidence(learnedPatterns)
            };

        } catch (error) {
            console.error('Failed to apply learned patterns:', error);
            throw error;
        }
    }

    async generateTestsWithPatterns(codeAnalysis, options) {
        const tests = [];
        const patterns = options.patterns;

        // Generate function tests with learned patterns
        if (codeAnalysis.functions) {
            for (const func of codeAnalysis.functions) {
                const test = this.generateFunctionTestWithPatterns(func, patterns);
                tests.push(test);
            }
        }

        // Generate class tests with learned patterns
        if (codeAnalysis.classes) {
            for (const cls of codeAnalysis.classes) {
                const test = this.generateClassTestWithPatterns(cls, patterns);
                tests.push(test);
            }
        }

        return tests;
    }

    generateFunctionTestWithPatterns(functionInfo, patterns) {
        const testCode = [];

        // Apply naming patterns
        const suiteName = this.applyNamingPattern(functionInfo.name, patterns.naming.testSuites);
        const assertionStyle = patterns.assertions.style.preferred || 'expect';

        // Start test suite
        testCode.push(`describe('${suiteName}', () => {`);

        // Apply setup patterns if needed
        if (patterns.structure.setup.preferred &&
            ['beforeEach', 'beforeAll'].includes(patterns.structure.setup.preferred)) {
            testCode.push(`    ${patterns.structure.setup.preferred}(() => {`);
            testCode.push(`        // Setup based on learned patterns`);
            testCode.push(`    });`);
            testCode.push('');
        }

        // Generate test cases with learned patterns
        const testCaseName = this.applyTestCaseNaming(functionInfo.name, patterns.naming.testCases);
        testCode.push(`    test('${testCaseName}', () => {`);

        // Apply structure patterns (AAA, GWT, etc.)
        if (patterns.structure.arrangement.preferred === 'arrangeActAssert') {
            testCode.push(`        // Arrange`);
            testCode.push(`        const input = 'test';`);
            testCode.push('');
            testCode.push(`        // Act`);
            testCode.push(`        const result = ${functionInfo.name}(input);`);
            testCode.push('');
            testCode.push(`        // Assert`);
        } else {
            testCode.push(`        const result = ${functionInfo.name}();`);
        }

        // Apply assertion patterns
        const preferredMatcher = patterns.assertions.matchers.mostUsed || 'toBeDefined';
        if (assertionStyle === 'expect') {
            testCode.push(`        expect(result).${preferredMatcher}();`);
        } else if (assertionStyle === 'assert') {
            testCode.push(`        assert.ok(result);`);
        }

        testCode.push(`    });`);
        testCode.push(`});`);

        return {
            type: 'function',
            name: functionInfo.name,
            code: testCode.join('\n'),
            patternsUsed: {
                naming: suiteName,
                assertion: assertionStyle,
                structure: patterns.structure.arrangement.preferred
            }
        };
    }

    generateClassTestWithPatterns(classInfo, patterns) {
        // Similar to function test generation but for classes
        const testCode = [];
        const suiteName = this.applyNamingPattern(classInfo.name, patterns.naming.testSuites);

        testCode.push(`describe('${suiteName}', () => {`);

        if (patterns.structure.setup.preferred === 'beforeEach') {
            testCode.push(`    let instance;`);
            testCode.push('');
            testCode.push(`    beforeEach(() => {`);
            testCode.push(`        instance = new ${classInfo.name}();`);
            testCode.push(`    });`);
        }

        // Constructor test
        testCode.push('');
        testCode.push(`    test('should create instance', () => {`);
        testCode.push(`        expect(instance).toBeInstanceOf(${classInfo.name});`);
        testCode.push(`    });`);

        testCode.push(`});`);

        return {
            type: 'class',
            name: classInfo.name,
            code: testCode.join('\n'),
            patternsUsed: patterns
        };
    }

    // Helper methods
    getDefaultPatterns() {
        return {
            patterns: {
                naming: {
                    fileNaming: { preferred: 'dot-test' },
                    testSuites: { preferred: 'describe-function-name' },
                    testCases: { preferred: 'should-behavior' },
                    variables: { preferred: 'camelCase' }
                },
                structure: {
                    arrangement: { preferred: 'arrangeActAssert' },
                    setup: { preferred: 'beforeEach' },
                    mocking: { preferred: 'jest' }
                },
                assertions: {
                    style: { preferred: 'expect' },
                    matchers: { mostUsed: 'toBeDefined' }
                },
                framework: {
                    hooks: { mostUsed: 'beforeEach' }
                },
                documentation: {
                    comments: { preferred: 'singleLine' }
                }
            },
            confidence: 30, // Low confidence for defaults
            source: 'default'
        };
    }

    detectFramework(content) {
        if (content.includes('jest.')) return 'jest';
        if (content.includes('vitest') || content.includes('vi.')) return 'vitest';
        if (content.includes('@playwright/test')) return 'playwright';
        if (content.includes('cy.')) return 'cypress';
        if (content.includes('sinon.')) return 'mocha';
        if (content.includes('QUnit.')) return 'qunit';
        return 'unknown';
    }

    extractNamingConventions(names) {
        if (names.length === 0) return {};

        const patterns = {
            shouldPattern: names.filter(n => n.toLowerCase().includes('should')).length,
            canPattern: names.filter(n => n.toLowerCase().includes('can')).length,
            whenPattern: names.filter(n => n.toLowerCase().includes('when')).length,
            itPattern: names.filter(n => n.toLowerCase().startsWith('it ')).length
        };

        return patterns;
    }

    extractCommonPrefixes(names) {
        if (names.length < 2) return [];

        const prefixes = {};
        names.forEach(name => {
            for (let i = 1; i <= Math.min(name.length, 5); i++) {
                const prefix = name.substring(0, i);
                prefixes[prefix] = (prefixes[prefix] || 0) + 1;
            }
        });

        return Object.entries(prefixes)
            .filter(([, count]) => count > 1)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5)
            .map(([prefix]) => prefix);
    }

    extractCommonSuffixes(names) {
        if (names.length < 2) return [];

        const suffixes = {};
        names.forEach(name => {
            for (let i = 1; i <= Math.min(name.length, 5); i++) {
                const suffix = name.substring(name.length - i);
                suffixes[suffix] = (suffixes[suffix] || 0) + 1;
            }
        });

        return Object.entries(suffixes)
            .filter(([, count]) => count > 1)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5)
            .map(([suffix]) => suffix);
    }

    getMostCommon(distribution) {
        if (!distribution || Object.keys(distribution).length === 0) {
            return null;
        }

        return Object.entries(distribution)
            .sort(([, a], [, b]) => b - a)[0][0];
    }

    getLineNumber(content, index) {
        return content.substring(0, index).split('\n').length;
    }

    applyNamingPattern(name, patterns) {
        if (!patterns || !patterns.preferred) {
            return `${name} Tests`;
        }

        switch (patterns.preferred) {
            case 'describe-function-name':
                return `${name}`;
            case 'describe-class-name':
                return `${name} class`;
            default:
                return `${name}`;
        }
    }

    applyTestCaseNaming(functionName, patterns) {
        if (!patterns || !patterns.preferred) {
            return `should work correctly`;
        }

        switch (patterns.preferred) {
            case 'should-behavior':
                return `should work correctly`;
            case 'can-behavior':
                return `can execute without errors`;
            case 'when-condition':
                return `when called with valid parameters`;
            default:
                return `should work correctly`;
        }
    }

    calculateConfidence(analyses) {
        if (!analyses || analyses.length === 0) return 0;

        let totalConfidence = 0;
        const factors = {
            fileCount: Math.min(analyses.length * 10, 40), // Up to 40 points
            consistentNaming: this.calculateNamingConsistency(analyses) * 20,
            patternUsage: this.calculatePatternUsage(analyses) * 20,
            assertionConsistency: this.calculateAssertionConsistency(analyses) * 20
        };

        totalConfidence = Object.values(factors).reduce((sum, val) => sum + val, 0);
        return Math.min(Math.round(totalConfidence), 100);
    }

    calculateNamingConsistency(analyses) {
        // Calculate how consistent naming patterns are across files
        const fileNamingPatterns = analyses.map(a => a.patterns.naming.fileNaming.naming);
        const uniquePatterns = new Set(fileNamingPatterns.filter(p => p));
        return uniquePatterns.size <= 2 ? 1 : 0.5; // High consistency if <= 2 patterns
    }

    calculatePatternUsage(analyses) {
        // Calculate how consistently patterns are used
        let consistencyScore = 0;
        const totalAnalyses = analyses.length;

        if (totalAnalyses === 0) return 0;

        // Check assertion style consistency
        const assertionStyles = analyses.map(a => {
            const assertions = a.patterns.assertions;
            if (assertions.expectStyle > assertions.assertStyle && assertions.expectStyle > assertions.shouldStyle) {
                return 'expect';
            } else if (assertions.assertStyle > assertions.expectStyle && assertions.assertStyle > assertions.shouldStyle) {
                return 'assert';
            }
            return 'should';
        });

        const uniqueAssertionStyles = new Set(assertionStyles);
        consistencyScore += uniqueAssertionStyles.size <= 1 ? 0.5 : 0.2;

        return consistencyScore;
    }

    calculateAssertionConsistency(analyses) {
        // Calculate consistency in assertion usage
        if (analyses.length === 0) return 0;

        const totalAssertions = analyses.reduce((sum, analysis) => {
            const assertions = analysis.patterns.assertions;
            return sum + (assertions.expectStyle || 0) + (assertions.assertStyle || 0) + (assertions.shouldStyle || 0);
        }, 0);

        return totalAssertions > 0 ? 1 : 0;
    }

    calculatePatternConfidence(patterns) {
        // Calculate confidence in the learned patterns
        let confidence = 0;

        // Check if we have strong patterns
        if (patterns.naming && patterns.naming.testCases && patterns.naming.testCases.preferred) {
            confidence += 25;
        }

        if (patterns.structure && patterns.structure.arrangement && patterns.structure.arrangement.preferred) {
            confidence += 25;
        }

        if (patterns.assertions && patterns.assertions.style && patterns.assertions.style.preferred) {
            confidence += 25;
        }

        if (patterns.framework && patterns.framework.hooks && patterns.framework.hooks.mostUsed) {
            confidence += 25;
        }

        return confidence;
    }

    generateStatistics(analyses) {
        return {
            totalFiles: analyses.length,
            frameworks: [...new Set(analyses.map(a => a.framework))],
            avgTestsPerFile: analyses.length > 0 ?
                analyses.reduce((sum, a) => sum + (a.patterns.naming.testCases.count || 0), 0) / analyses.length : 0,
            totalTestCases: analyses.reduce((sum, a) => sum + (a.patterns.naming.testCases.count || 0), 0)
        };
    }

    generateRecommendations(analysisResults) {
        const recommendations = [];
        const patterns = analysisResults.patterns;

        if (analysisResults.confidence < 50) {
            recommendations.push('Consider adding more test files to improve pattern learning confidence');
        }

        if (patterns.naming && patterns.naming.fileNaming &&
            Object.keys(patterns.naming.fileNaming.distribution || {}).length > 2) {
            recommendations.push('Standardize test file naming conventions across the project');
        }

        if (patterns.assertions && patterns.assertions.style &&
            Object.keys(patterns.assertions.style.distribution || {}).length > 1) {
            recommendations.push('Consider using a consistent assertion style (expect, assert, or should)');
        }

        return recommendations;
    }

    cachePatterns(patterns, context) {
        const cacheKey = this.generateCacheKey(context);
        this.cache.set(cacheKey, {
            patterns,
            timestamp: Date.now(),
            context
        });
    }

    generateCacheKey(context) {
        return `patterns_${JSON.stringify(context).slice(0, 50)}`;
    }

    // Additional helper methods for pattern extraction...
    extractCustomSetupMethods(content) {
        const methods = [];
        const setupRegex = /function\s+setup(\w*)\s*\(/g;
        let match;
        while ((match = setupRegex.exec(content)) !== null) {
            methods.push(`setup${match[1]}`);
        }
        return methods;
    }

    extractCustomMockPatterns(content) {
        const patterns = [];
        // Look for custom mocking patterns
        const mockRegex = /mock(\w+)/gi;
        let match;
        while ((match = mockRegex.exec(content)) !== null) {
            patterns.push(match[0]);
        }
        return [...new Set(patterns)];
    }

    detectMockLibraries(content) {
        const libraries = [];
        const mockLibraries = ['sinon', 'jest', 'vitest', 'testdouble', 'proxyquire'];

        mockLibraries.forEach(lib => {
            if (content.includes(lib)) {
                libraries.push(lib);
            }
        });

        return libraries;
    }

    countNestedDescribes(content) {
        let maxNesting = 0;
        let currentNesting = 0;
        const lines = content.split('\n');

        lines.forEach(line => {
            if (line.includes('describe(')) {
                currentNesting++;
                maxNesting = Math.max(maxNesting, currentNesting);
            } else if (line.includes('});') && currentNesting > 0) {
                currentNesting--;
            }
        });

        return maxNesting;
    }

    analyzeTestGrouping(content) {
        const grouping = {
            byFeature: (content.match(/describe\s*\(\s*['"`][^'"`]*feature[^'"`]*['"`]/gi) || []).length,
            byFunction: (content.match(/describe\s*\(\s*['"`][a-zA-Z_$][a-zA-Z0-9_$]*['"`]/g) || []).length,
            byClass: (content.match(/describe\s*\(\s*['"`][A-Z][a-zA-Z0-9]*['"`]/g) || []).length
        };

        return grouping;
    }

    analyzeFileStructure(content) {
        const structure = {
            hasImports: content.includes('import') || content.includes('require'),
            hasSetup: content.includes('beforeEach') || content.includes('beforeAll'),
            hasTeardown: content.includes('afterEach') || content.includes('afterAll'),
            hasMocks: content.includes('mock') || content.includes('spy'),
            hasAsync: content.includes('async') || content.includes('await')
        };

        return structure;
    }

    extractErrorTypes(content) {
        const errorTypes = [];
        const errorRegex = /new\s+(\w*Error)\s*\(/g;
        let match;
        while ((match = errorRegex.exec(content)) !== null) {
            errorTypes.push(match[1]);
        }
        return [...new Set(errorTypes)];
    }

    analyzeUtilitiesUsage(content) {
        const utilities = {
            testHelpers: (content.match(/import.*helper/gi) || []).length,
            testUtils: (content.match(/import.*util/gi) || []).length,
            customMatchers: (content.match(/expect\.extend/g) || []).length,
            factories: (content.match(/factory|create\w*\(/gi) || []).length
        };

        return utilities;
    }

    analyzeConfigurationPatterns(content) {
        const config = {
            timeout: content.includes('timeout'),
            retry: content.includes('retry'),
            bail: content.includes('bail'),
            parallel: content.includes('parallel')
        };

        return config;
    }

    analyzeImportPatterns(content) {
        const imports = {
            namedImports: (content.match(/import\s*\{[^}]+\}/g) || []).length,
            defaultImports: (content.match(/import\s+\w+\s+from/g) || []).length,
            namespaceImports: (content.match(/import\s+\*\s+as\s+\w+/g) || []).length,
            requireStatements: (content.match(/require\s*\(/g) || []).length
        };

        return imports;
    }

    analyzeFrameworkSpecificPatterns(content, framework) {
        const patterns = {};

        switch (framework) {
            case 'jest':
                patterns.jestSpecific = {
                    snapshots: (content.match(/toMatchSnapshot/g) || []).length,
                    timers: (content.match(/jest\.useFakeTimers/g) || []).length,
                    modules: (content.match(/jest\.mock/g) || []).length
                };
                break;
            case 'cypress':
                patterns.cypressSpecific = {
                    commands: (content.match(/cy\./g) || []).length,
                    custom: (content.match(/Cypress\.Commands\.add/g) || []).length
                };
                break;
            case 'playwright':
                patterns.playwrightSpecific = {
                    pages: (content.match(/page\./g) || []).length,
                    locators: (content.match(/locator\(/g) || []).length
                };
                break;
        }

        return patterns;
    }

    analyzeTagPatterns(content) {
        const tags = {
            skip: (content.match(/\.skip\s*\(/g) || []).length,
            only: (content.match(/\.only\s*\(/g) || []).length,
            todo: (content.match(/\.todo\s*\(/g) || []).length,
            custom: this.extractCustomTags(content)
        };

        return tags;
    }

    extractCustomTags(content) {
        const tags = [];
        const tagRegex = /@(\w+)/g;
        let match;
        while ((match = tagRegex.exec(content)) !== null) {
            tags.push(match[1]);
        }
        return [...new Set(tags)];
    }

    analyzeDocumentationStyle(content) {
        const style = {
            hasFileHeader: content.startsWith('/**') || content.startsWith('/*'),
            hasInlineComments: (content.match(/\/\/ /g) || []).length > 5,
            hasBlockComments: (content.match(/\/\*/g) || []).length > 0,
            hasDescriptiveTests: this.hasDescriptiveTestNames(content)
        };

        return style;
    }

    hasDescriptiveTestNames(content) {
        const testNames = [];
        const testRegex = /(?:test|it)\s*\(\s*['"`]([^'"`]+)['"`]/g;
        let match;
        while ((match = testRegex.exec(content)) !== null) {
            testNames.push(match[1]);
        }

        // Check if test names are descriptive (more than 3 words on average)
        const avgWords = testNames.length > 0 ?
            testNames.reduce((sum, name) => sum + name.split(' ').length, 0) / testNames.length : 0;

        return avgWords > 3;
    }

    extractDescriptionPatterns(descriptions) {
        const patterns = {
            shouldPattern: descriptions.filter(d => d.toLowerCase().includes('should')).length,
            whenPattern: descriptions.filter(d => d.toLowerCase().includes('when')).length,
            itPattern: descriptions.filter(d => d.toLowerCase().startsWith('it ')).length,
            givenPattern: descriptions.filter(d => d.toLowerCase().includes('given')).length
        };

        return patterns;
    }

    findCommonSetupPatterns(usages) {
        if (usages.length === 0) return [];

        // Extract common setup operations
        const operations = [];
        usages.forEach(usage => {
            const body = usage.body;
            if (body.includes('mock')) operations.push('mocking');
            if (body.includes('clear')) operations.push('clearing');
            if (body.includes('reset')) operations.push('resetting');
            if (body.includes('new ')) operations.push('instantiation');
        });

        return [...new Set(operations)];
    }
}

export { TestPatternLearning };
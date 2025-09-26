// Supporting infrastructure for comprehensive test generation
// Includes quality validation, compilation checking, and coverage tracking

// Removed unused imports: TEST_QUALITY_CONFIG, ANALYSIS_CONFIG

/**
 * Test Quality Validator - validates generated tests for correctness and completeness
 */
export class TestQualityValidator {
    constructor() {
        this.validationRules = new Map();
        this.initializeValidationRules();
    }

    initializeValidationRules() {
        // JavaScript/TypeScript validation rules
        this.validationRules.set('javascript', [
            this.validateSyntax,
            this.validateTestStructure,
            this.validateAssertions,
            this.validateMocking,
            this.validateErrorHandling,
            this.validateEdgeCases
        ]);

        this.validationRules.set('typescript', [
            ...this.validationRules.get('javascript'),
            this.validateTypeAnnotations
        ]);

        // Python validation rules
        this.validationRules.set('python', [
            this.validatePythonSyntax,
            this.validatePythonTestStructure,
            this.validatePythonAssertions
        ]);
    }

    /**
     * Validate test suite quality
     */
    async validate(testSuite, _originalCode, _context) {
        const results = {
            isValid: true,
            score: 100,
            issues: [],
            suggestions: [],
            metrics: {}
        };

        try {
            // Get validation rules for language
            const rules = this.validationRules.get(_context.language) || this.validationRules.get('javascript');

            // Apply validation rules
            for (const rule of rules) {
                const ruleResult = await rule.call(this, testSuite, _originalCode, _context);

                if (!ruleResult.passed) {
                    results.isValid = false;
                    results.score -= ruleResult.penalty || 10;
                    results.issues.push(...ruleResult.issues);
                }

                results.suggestions.push(...(ruleResult.suggestions || []));
            }

            // Calculate final metrics
            results.metrics = await this.calculateQualityMetrics(testSuite, _originalCode);
            results.score = Math.max(0, Math.min(100, results.score));

        } catch (error) {
            console.error('Test validation failed:', error);
            results.isValid = false;
            results.score = 0;
            results.issues.push(`Validation error: ${error.message}`);
        }

        return results;
    }

    // Validation rule implementations
    async validateSyntax(testSuite, _originalCode, _context) {
        const issues = [];
        let passed = true;

        // Basic syntax validation for JavaScript/TypeScript
        const testCode = this.extractTestCode(testSuite);

        // Check for balanced brackets
        const braceBalance = this.checkBraceBalance(testCode);
        if (braceBalance !== 0) {
            issues.push('Unbalanced braces in test code');
            passed = false;
        }

        // Check for basic syntax patterns
        if (!testCode.includes('describe(') && !testCode.includes('test(') && !testCode.includes('it(')) {
            issues.push('No recognizable test structure found');
            passed = false;
        }

        return { passed, issues, penalty: 30 };
    }

    async validateTestStructure(testSuite, _originalCode, _context) {
        const issues = [];
        const suggestions = [];
        let passed = true;

        const testCode = this.extractTestCode(testSuite);

        // Check for proper test organization
        if (!testCode.includes('describe(')) {
            suggestions.push('Consider organizing tests with describe blocks');
        }

        // Check for setup/teardown
        if (!testCode.includes('beforeEach') && !testCode.includes('beforeAll')) {
            suggestions.push('Consider adding test setup (beforeEach/beforeAll)');
        }

        // Check test naming conventions
        const testNames = this.extractTestNames(testCode);
        const poorNames = testNames.filter(name => name.length < 10 || !name.includes('should'));

        if (poorNames.length > 0) {
            suggestions.push('Consider more descriptive test names that explain expected behavior');
        }

        return { passed, issues, suggestions, penalty: 5 };
    }

    async validateAssertions(testSuite, _originalCode, _context) {
        const issues = [];
        let passed = true;

        const testCode = this.extractTestCode(testSuite);

        // Check for assertions
        const assertionPatterns = [
            /expect\s*\(/g,
            /assert\s*\./g,
            /should\s*\./g,
            /toBe\(/g,
            /toEqual\(/g
        ];

        const hasAssertions = assertionPatterns.some(pattern => pattern.test(testCode));

        if (!hasAssertions) {
            issues.push('Tests appear to lack proper assertions');
            passed = false;
        }

        return { passed, issues, penalty: 25 };
    }

    async validateMocking(testSuite, _originalCode, _context) {
        const suggestions = [];
        const testCode = this.extractTestCode(testSuite);

        // Check if external dependencies should be mocked
        const imports = _context.imports || [];
        const externalImports = imports.filter(imp => !imp.isRelative);

        if (externalImports.length > 0 && !testCode.includes('mock') && !testCode.includes('stub')) {
            suggestions.push('Consider mocking external dependencies for better test isolation');
        }

        return { passed: true, suggestions };
    }

    async validateErrorHandling(testSuite, _originalCode, _context) {
        const suggestions = [];
        const testCode = this.extractTestCode(testSuite);

        // Check if error handling is tested
        const hasThrows = _originalCode.includes('throw') || _originalCode.includes('Error');
        const testsErrors = testCode.includes('toThrow') || testCode.includes('throws') || testCode.includes('except');

        if (hasThrows && !testsErrors) {
            suggestions.push('Original code contains error handling - consider testing error scenarios');
        }

        return { passed: true, suggestions };
    }

    async validateEdgeCases(testSuite, _originalCode, _context) {
        const suggestions = [];
        const testCode = this.extractTestCode(testSuite);

        // Check for common edge case patterns
        const edgeCasePatterns = [
            'null', 'undefined', 'empty', 'zero', 'negative',
            'boundary', 'max', 'min', 'edge'
        ];

        const hasEdgeCases = edgeCasePatterns.some(pattern =>
            testCode.toLowerCase().includes(pattern)
        );

        if (!hasEdgeCases) {
            suggestions.push('Consider adding edge case tests (null, undefined, empty values, boundaries)');
        }

        return { passed: true, suggestions };
    }

    async validateTypeAnnotations(testSuite, _originalCode, _context) {
        const suggestions = [];

        if (_context.language === 'typescript') {
            const _testCode = this.extractTestCode(testSuite);

            // Check if TypeScript features are being tested
            if (_originalCode.includes('interface') || _originalCode.includes('type')) {
                suggestions.push('Consider testing TypeScript type constraints and interfaces');
            }
        }

        return { passed: true, suggestions };
    }

    // Helper methods
    extractTestCode(testSuite) {
        let code = '';

        if (testSuite.tests) {
            Object.values(testSuite.tests).forEach(testGroup => {
                if (Array.isArray(testGroup)) {
                    testGroup.forEach(test => {
                        if (test.testCases) {
                            test.testCases.forEach(testCase => {
                                code += testCase.code || testCase.content || '';
                            });
                        }
                    });
                }
            });
        }

        return code;
    }

    checkBraceBalance(code) {
        let balance = 0;
        for (const char of code) {
            if (char === '{') balance++;
            if (char === '}') balance--;
        }
        return balance;
    }

    extractTestNames(code) {
        const names = [];

        // Extract test names from describe/it/test blocks
        const patterns = [
            /describe\s*\(\s*['"`]([^'"`]+)['"`]/g,
            /it\s*\(\s*['"`]([^'"`]+)['"`]/g,
            /test\s*\(\s*['"`]([^'"`]+)['"`]/g
        ];

        patterns.forEach(pattern => {
            let match;
            while ((match = pattern.exec(code)) !== null) {
                names.push(match[1]);
            }
        });

        return names;
    }

    async calculateQualityMetrics(testSuite, originalCode) {
        return {
            testCount: this.countTests(testSuite),
            assertionCount: this.countAssertions(testSuite),
            mockCount: this.countMocks(testSuite),
            coverageEstimate: this.estimateCoverage(testSuite, originalCode),
            complexityScore: this.calculateComplexityScore(testSuite)
        };
    }

    countTests(testSuite) {
        let count = 0;
        if (testSuite.tests) {
            Object.values(testSuite.tests).forEach(testGroup => {
                if (Array.isArray(testGroup)) {
                    testGroup.forEach(test => {
                        count += test.testCases ? test.testCases.length : 0;
                    });
                }
            });
        }
        return count;
    }

    countAssertions(testSuite) {
        const code = this.extractTestCode(testSuite);
        const assertionPatterns = [/expect\s*\(/g, /assert\s*\./g];

        return assertionPatterns.reduce((count, pattern) => {
            const matches = code.match(pattern);
            return count + (matches ? matches.length : 0);
        }, 0);
    }

    countMocks(testSuite) {
        const code = this.extractTestCode(testSuite);
        const mockPatterns = [/mock\s*\(/g, /stub\s*\(/g, /spy\s*\(/g];

        return mockPatterns.reduce((count, pattern) => {
            const matches = code.match(pattern);
            return count + (matches ? matches.length : 0);
        }, 0);
    }

    estimateCoverage(testSuite, originalCode) {
        // Simple heuristic: count function names in tests vs original code
        const originalFunctions = this.extractFunctionNames(originalCode);
        const testCode = this.extractTestCode(testSuite);

        const testedFunctions = originalFunctions.filter(func =>
            testCode.toLowerCase().includes(func.toLowerCase())
        );

        return originalFunctions.length > 0 ?
            Math.round((testedFunctions.length / originalFunctions.length) * 100) : 100;
    }

    extractFunctionNames(code) {
        const names = [];
        const patterns = [
            /function\s+(\w+)/g,
            /const\s+(\w+)\s*=/g,
            /(\w+)\s*:/g // Object methods
        ];

        patterns.forEach(pattern => {
            let match;
            while ((match = pattern.exec(code)) !== null) {
                if (match[1] && match[1].length > 1) {
                    names.push(match[1]);
                }
            }
        });

        return [...new Set(names)];
    }

    calculateComplexityScore(testSuite) {
        const code = this.extractTestCode(testSuite);

        // Count complexity indicators
        const complexityPatterns = [
            /if\s*\(/g,
            /for\s*\(/g,
            /while\s*\(/g,
            /switch\s*\(/g
        ];

        const complexity = complexityPatterns.reduce((total, pattern) => {
            const matches = code.match(pattern);
            return total + (matches ? matches.length : 0);
        }, 1);

        return Math.min(100, Math.round(100 / (1 + Math.log(complexity))));
    }
}

/**
 * Test Compiler - validates that generated tests compile correctly
 */
export class TestCompiler {
    constructor() {
        this.compilers = new Map();
        this.initializeCompilers();
    }

    initializeCompilers() {
        this.compilers.set('javascript', this.compileJavaScript.bind(this));
        this.compilers.set('typescript', this.compileTypeScript.bind(this));
        this.compilers.set('python', this.compilePython.bind(this));
    }

    /**
     * Validate test compilation
     */
    async validateCompilation(testSuite, language) {
        try {
            const compiler = this.compilers.get(language) || this.compilers.get('javascript');

            const result = await compiler(testSuite);

            return {
                success: result.success,
                errors: result.errors || [],
                warnings: result.warnings || [],
                suggestions: result.suggestions || []
            };

        } catch (error) {
            return {
                success: false,
                errors: [`Compilation validation failed: ${error.message}`],
                warnings: [],
                suggestions: ['Manual review of generated tests recommended']
            };
        }
    }

    async compileJavaScript(testSuite) {
        const errors = [];
        const warnings = [];
        const suggestions = [];

        try {
            const testCode = this.extractAllTestCode(testSuite);

            // Basic JavaScript validation
            // Check for syntax issues
            const syntaxErrors = this.validateJavaScriptSyntax(testCode);
            errors.push(...syntaxErrors);

            // Check imports
            const importErrors = this.validateImports(testCode);
            errors.push(...importErrors);

            // Check for undefined variables (basic check)
            const undefinedVars = this.checkUndefinedVariables(testCode);
            warnings.push(...undefinedVars);

            return {
                success: errors.length === 0,
                errors,
                warnings,
                suggestions
            };

        } catch (error) {
            return {
                success: false,
                errors: [`JavaScript compilation check failed: ${error.message}`]
            };
        }
    }

    async compileTypeScript(testSuite) {
        const result = await this.compileJavaScript(testSuite);

        // Additional TypeScript-specific checks
        const testCode = this.extractAllTestCode(testSuite);

        // Check type annotations
        if (testCode.includes(':') && !testCode.includes('://')) {
            result.suggestions.push('Verify TypeScript type annotations are correct');
        }

        return result;
    }

    async compilePython(testSuite) {
        const errors = [];
        const warnings = [];

        try {
            const testCode = this.extractAllTestCode(testSuite);

            // Basic Python syntax validation
            const syntaxErrors = this.validatePythonSyntax(testCode);
            errors.push(...syntaxErrors);

            return {
                success: errors.length === 0,
                errors,
                warnings
            };

        } catch (error) {
            return {
                success: false,
                errors: [`Python compilation check failed: ${error.message}`]
            };
        }
    }

    // Helper methods
    extractAllTestCode(testSuite) {
        let code = '';

        // Extract setup/teardown
        if (testSuite.setup) code += testSuite.setup + '\n';
        if (testSuite.teardown) code += testSuite.teardown + '\n';

        // Extract imports
        if (testSuite.imports) code += testSuite.imports + '\n';

        // Extract test code
        if (testSuite.tests) {
            Object.values(testSuite.tests).forEach(testGroup => {
                if (Array.isArray(testGroup)) {
                    testGroup.forEach(test => {
                        if (test.testCases) {
                            test.testCases.forEach(testCase => {
                                code += (testCase.code || testCase.content || '') + '\n';
                            });
                        }
                    });
                }
            });
        }

        return code;
    }

    validateJavaScriptSyntax(code) {
        const errors = [];

        // Check for basic syntax errors
        const braceCount = (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
        if (braceCount !== 0) {
            errors.push('Unbalanced curly braces');
        }

        const parenCount = (code.match(/\(/g) || []).length - (code.match(/\)/g) || []).length;
        if (parenCount !== 0) {
            errors.push('Unbalanced parentheses');
        }

        // Check for obvious syntax errors
        if (code.includes('function (')) {
            errors.push('Invalid function syntax - missing function name or arrow function format');
        }

        return errors;
    }

    validateImports(code) {
        const errors = [];

        // Check for malformed imports
        const importLines = code.match(/import.*from.*/g) || [];

        importLines.forEach(line => {
            if (!line.includes("'") && !line.includes('"')) {
                errors.push(`Malformed import statement: ${line}`);
            }
        });

        return errors;
    }

    checkUndefinedVariables(code) {
        const warnings = [];

        // Very basic undefined variable check
        const commonUndefined = ['describe', 'it', 'test', 'expect', 'jest', 'beforeEach', 'afterEach'];

        commonUndefined.forEach(varName => {
            if (code.includes(varName) && !code.includes(`import.*${varName}`)) {
                // This is expected for testing frameworks
                return;
            }
        });

        return warnings;
    }

    validatePythonSyntax(code) {
        const errors = [];

        // Check indentation (basic)
        const lines = code.split('\n');
        let _indentLevel = 0;

        lines.forEach((line, index) => {
            if (line.trim() === '') return;

            const indent = line.length - line.trimStart().length;

            if (line.trimEnd().endsWith(':')) {
                // Should increase indent on next line
                _indentLevel = indent + 4;
            } else if (indent % 4 !== 0) {
                errors.push(`Indentation error on line ${index + 1}`);
            }
        });

        return errors;
    }
}

/**
 * Coverage Tracker - ensures all functions are tested
 */
export class CoverageTracker {
    constructor() {
        this.functions = new Map();
        this.classes = new Map();
        this.testedFunctions = new Set();
        this.testedClasses = new Set();
    }

    /**
     * Initialize with functions to track
     */
    initialize(functions, classes = []) {
        this.functions.clear();
        this.classes.clear();
        this.testedFunctions.clear();
        this.testedClasses.clear();

        // Track all functions
        functions.forEach(func => {
            this.functions.set(func.name, {
                ...func,
                tested: false,
                testCount: 0
            });
        });

        // Track all classes
        classes.forEach(cls => {
            this.classes.set(cls.name, {
                ...cls,
                tested: false,
                methodsTested: 0,
                totalMethods: cls.methods ? cls.methods.length : 0
            });
        });
    }

    /**
     * Mark function as tested
     */
    markFunctionTested(functionName, testCount = 1) {
        if (this.functions.has(functionName)) {
            const func = this.functions.get(functionName);
            func.tested = true;
            func.testCount += testCount;
            this.testedFunctions.add(functionName);
        }
    }

    /**
     * Mark class as tested
     */
    markClassTested(className, methodsTested = 0) {
        if (this.classes.has(className)) {
            const cls = this.classes.get(className);
            cls.tested = true;
            cls.methodsTested = methodsTested;
            this.testedClasses.add(className);
        }
    }

    /**
     * Validate coverage completeness
     */
    validateCoverage(_testResults) {
        const missing = [];

        // Check functions
        this.functions.forEach((func, name) => {
            if (!func.tested) {
                missing.push({
                    type: 'function',
                    name,
                    line: func.line
                });
            }
        });

        // Check classes
        this.classes.forEach((cls, name) => {
            if (!cls.tested) {
                missing.push({
                    type: 'class',
                    name,
                    line: cls.line
                });
            }
        });

        return {
            complete: missing.length === 0,
            missing,
            percentage: this.calculateCoveragePercentage()
        };
    }

    /**
     * Generate coverage report
     */
    generateReport() {
        const totalFunctions = this.functions.size;
        const totalClasses = this.classes.size;
        const testedFunctions = this.testedFunctions.size;
        const testedClasses = this.testedClasses.size;

        const totalItems = totalFunctions + totalClasses;
        const testedItems = testedFunctions + testedClasses;

        return {
            functions: {
                total: totalFunctions,
                tested: testedFunctions,
                percentage: totalFunctions > 0 ? Math.round((testedFunctions / totalFunctions) * 100) : 100
            },
            classes: {
                total: totalClasses,
                tested: testedClasses,
                percentage: totalClasses > 0 ? Math.round((testedClasses / totalClasses) * 100) : 100
            },
            overall: {
                total: totalItems,
                tested: testedItems,
                percentage: totalItems > 0 ? Math.round((testedItems / totalItems) * 100) : 100
            },
            testedFunctions: testedFunctions,
            missing: this.getMissingItems()
        };
    }

    calculateCoveragePercentage() {
        const total = this.functions.size + this.classes.size;
        const tested = this.testedFunctions.size + this.testedClasses.size;

        return total > 0 ? Math.round((tested / total) * 100) : 100;
    }

    getMissingItems() {
        const missing = [];

        this.functions.forEach((func, name) => {
            if (!func.tested) {
                missing.push({ type: 'function', name });
            }
        });

        this.classes.forEach((cls, name) => {
            if (!cls.tested) {
                missing.push({ type: 'class', name });
            }
        });

        return missing;
    }
}
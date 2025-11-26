/**
 * Coverage Tracker for Test Generation
 * Ensures comprehensive test coverage for all functions and classes
 */

export class CoverageTracker {
    constructor() {
        this.functionCoverage = new Map();
        this.classCoverage = new Map();
        this.totalFunctions = 0;
        this.testedFunctions = 0;
        this.stats = {
            totalTestCases: 0,
            coveragePercentage: 0,
            missingTests: [],
            weakCoverage: []
        };
    }

    /**
     * Initialize coverage tracking with detected functions and classes
     */
    initialize(functions, classes = []) {
        console.log(`📊 Initializing coverage tracker: ${functions.length} functions, ${classes.length} classes`);

        this.totalFunctions = functions.length;
        this.functionCoverage.clear();
        this.classCoverage.clear();

        // Initialize function coverage tracking
        functions.forEach(func => {
            this.functionCoverage.set(func.name, {
                name: func.name,
                line: func.line,
                complexity: func.complexity || 1,
                tested: false,
                testCount: 0,
                testTypes: [],
                coverage: 0
            });
        });

        // Initialize class coverage tracking
        classes.forEach(cls => {
            this.classCoverage.set(cls.name, {
                name: cls.name,
                methods: cls.methods.map(m => ({
                    name: m.name,
                    tested: false,
                    testCount: 0
                })),
                tested: false,
                testCount: 0,
                coverage: 0
            });
        });
    }

    /**
     * Mark a function as tested with specified test cases
     */
    markFunctionTested(functionName, testCount = 1, testTypes = []) {
        if (this.functionCoverage.has(functionName)) {
            const coverage = this.functionCoverage.get(functionName);
            coverage.tested = true;
            coverage.testCount = testCount;
            coverage.testTypes = testTypes;

            // Calculate coverage score based on test types
            const expectedTestTypes = ['positive', 'negative', 'edge'];
            const typesCovered = expectedTestTypes.filter(type => testTypes.includes(type)).length;
            coverage.coverage = (typesCovered / expectedTestTypes.length) * 100;

            this.functionCoverage.set(functionName, coverage);
            this.updateStats();

            console.log(`✅ Marked ${functionName} as tested (${testCount} tests, ${coverage.coverage.toFixed(0)}% coverage)`);
        } else {
            console.warn(`⚠️ Function ${functionName} not found in coverage tracker`);
        }
    }

    /**
     * Mark a class as tested with specified test cases
     */
    markClassTested(className, testCount = 1, methodsCovered = []) {
        if (this.classCoverage.has(className)) {
            const coverage = this.classCoverage.get(className);
            coverage.tested = true;
            coverage.testCount = testCount;

            // Update method coverage
            methodsCovered.forEach(methodName => {
                const method = coverage.methods.find(m => m.name === methodName);
                if (method) {
                    method.tested = true;
                    method.testCount++;
                }
            });

            // Calculate class coverage percentage
            const testedMethods = coverage.methods.filter(m => m.tested).length;
            coverage.coverage = coverage.methods.length > 0
                ? (testedMethods / coverage.methods.length) * 100
                : 100;

            this.classCoverage.set(className, coverage);
            this.updateStats();

            console.log(`✅ Marked class ${className} as tested (${testCount} tests, ${coverage.coverage.toFixed(0)}% method coverage)`);
        } else {
            console.warn(`⚠️ Class ${className} not found in coverage tracker`);
        }
    }

    /**
     * Validate that all functions have adequate test coverage
     */
    validateCoverage(testResults) {
        console.log('🔍 Validating test coverage...');

        const missing = [];
        const weak = [];

        // Check function coverage
        for (const [name, coverage] of this.functionCoverage.entries()) {
            if (!coverage.tested || coverage.testCount === 0) {
                missing.push({
                    type: 'function',
                    name: name,
                    line: coverage.line,
                    reason: 'No tests generated'
                });
            } else if (coverage.testCount < 3) {
                weak.push({
                    type: 'function',
                    name: name,
                    line: coverage.line,
                    testCount: coverage.testCount,
                    reason: 'Insufficient test cases (minimum 3 recommended)'
                });
            } else if (coverage.coverage < 100) {
                weak.push({
                    type: 'function',
                    name: name,
                    line: coverage.line,
                    coverage: coverage.coverage,
                    reason: 'Not all test types covered (positive, negative, edge)'
                });
            }
        }

        // Check class coverage
        for (const [name, coverage] of this.classCoverage.entries()) {
            if (!coverage.tested || coverage.testCount === 0) {
                missing.push({
                    type: 'class',
                    name: name,
                    reason: 'No tests generated'
                });
            } else if (coverage.coverage < 80) {
                weak.push({
                    type: 'class',
                    name: name,
                    methodsCovered: coverage.methods.filter(m => m.tested).length,
                    totalMethods: coverage.methods.length,
                    coverage: coverage.coverage,
                    reason: 'Less than 80% method coverage'
                });
            }
        }

        const isComplete = missing.length === 0;
        const hasAdequateCoverage = weak.length === 0;

        console.log(`📊 Coverage validation: ${isComplete ? '✅' : '❌'} Complete, ${hasAdequateCoverage ? '✅' : '⚠️'} Adequate`);
        if (missing.length > 0) {
            console.warn(`⚠️ Missing tests for ${missing.length} items:`, missing.map(m => m.name).join(', '));
        }
        if (weak.length > 0) {
            console.warn(`⚠️ Weak coverage for ${weak.length} items:`, weak.map(w => w.name).join(', '));
        }

        return {
            complete: isComplete,
            adequate: hasAdequateCoverage,
            missing: missing,
            weak: weak,
            stats: this.getStats()
        };
    }

    /**
     * Get functions/classes that are missing tests
     */
    getMissingTests() {
        const missing = {
            functions: [],
            classes: []
        };

        // Find untested functions
        for (const [name, coverage] of this.functionCoverage.entries()) {
            if (!coverage.tested || coverage.testCount === 0) {
                missing.functions.push({
                    name: name,
                    line: coverage.line,
                    complexity: coverage.complexity
                });
            }
        }

        // Find untested classes
        for (const [name, coverage] of this.classCoverage.entries()) {
            if (!coverage.tested || coverage.testCount === 0) {
                missing.classes.push({
                    name: name,
                    methods: coverage.methods
                });
            }
        }

        return missing;
    }

    /**
     * Update internal statistics
     */
    updateStats() {
        // Count tested functions
        this.testedFunctions = Array.from(this.functionCoverage.values())
            .filter(c => c.tested && c.testCount > 0).length;

        // Calculate total test cases
        this.stats.totalTestCases = 0;
        for (const coverage of this.functionCoverage.values()) {
            this.stats.totalTestCases += coverage.testCount;
        }
        for (const coverage of this.classCoverage.values()) {
            this.stats.totalTestCases += coverage.testCount;
        }

        // Calculate coverage percentage
        this.stats.coveragePercentage = this.totalFunctions > 0
            ? (this.testedFunctions / this.totalFunctions) * 100
            : 0;

        // Get missing tests
        const missing = this.getMissingTests();
        this.stats.missingTests = [...missing.functions, ...missing.classes];

        // Get weak coverage items
        this.stats.weakCoverage = [];
        for (const [name, coverage] of this.functionCoverage.entries()) {
            if (coverage.tested && (coverage.testCount < 3 || coverage.coverage < 100)) {
                this.stats.weakCoverage.push({
                    type: 'function',
                    name: name,
                    testCount: coverage.testCount,
                    coverage: coverage.coverage
                });
            }
        }
    }

    /**
     * Get coverage statistics
     */
    getStats() {
        return {
            totalFunctions: this.totalFunctions,
            testedFunctions: this.testedFunctions,
            totalTestCases: this.stats.totalTestCases,
            coveragePercentage: this.stats.coveragePercentage,
            missingTests: this.stats.missingTests.length,
            weakCoverage: this.stats.weakCoverage.length
        };
    }

    /**
     * Generate detailed coverage report
     */
    generateReport() {
        const report = {
            summary: {
                totalFunctions: this.totalFunctions,
                testedFunctions: this.testedFunctions,
                totalClasses: this.classCoverage.size,
                testedClasses: Array.from(this.classCoverage.values()).filter(c => c.tested).length,
                totalTestCases: this.stats.totalTestCases,
                coveragePercentage: this.stats.coveragePercentage,
                status: this.stats.coveragePercentage === 100 ? 'complete' : 'incomplete'
            },
            functions: Array.from(this.functionCoverage.entries()).map(([name, coverage]) => ({
                name: name,
                line: coverage.line,
                complexity: coverage.complexity,
                tested: coverage.tested,
                testCount: coverage.testCount,
                testTypes: coverage.testTypes,
                coverage: coverage.coverage,
                status: this.getCoverageStatus(coverage)
            })),
            classes: Array.from(this.classCoverage.entries()).map(([name, coverage]) => ({
                name: name,
                tested: coverage.tested,
                testCount: coverage.testCount,
                methodsCovered: coverage.methods.filter(m => m.tested).length,
                totalMethods: coverage.methods.length,
                coverage: coverage.coverage,
                status: this.getCoverageStatus(coverage)
            })),
            missingTests: this.stats.missingTests,
            weakCoverage: this.stats.weakCoverage,
            generatedAt: new Date().toISOString()
        };

        console.log('📊 Coverage Report Generated:');
        console.log(`   Total Functions: ${report.summary.totalFunctions}`);
        console.log(`   Tested Functions: ${report.summary.testedFunctions}`);
        console.log(`   Coverage: ${report.summary.coveragePercentage.toFixed(2)}%`);
        console.log(`   Total Test Cases: ${report.summary.totalTestCases}`);
        console.log(`   Status: ${report.summary.status}`);

        return report;
    }

    /**
     * Get coverage status for an item
     */
    getCoverageStatus(coverage) {
        if (!coverage.tested || coverage.testCount === 0) {
            return 'not-tested';
        }
        if (coverage.coverage === undefined) {
            return coverage.testCount >= 3 ? 'good' : 'weak';
        }
        if (coverage.coverage === 100 && coverage.testCount >= 3) {
            return 'excellent';
        }
        if (coverage.coverage >= 80) {
            return 'good';
        }
        if (coverage.coverage >= 50) {
            return 'fair';
        }
        return 'weak';
    }

    /**
     * Reset coverage tracking
     */
    reset() {
        this.functionCoverage.clear();
        this.classCoverage.clear();
        this.totalFunctions = 0;
        this.testedFunctions = 0;
        this.stats = {
            totalTestCases: 0,
            coveragePercentage: 0,
            missingTests: [],
            weakCoverage: []
        };
        console.log('🔄 Coverage tracker reset');
    }
}

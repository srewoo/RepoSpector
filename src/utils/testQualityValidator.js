/**
 * Test Quality Validator for RepoSpector
 *
 * Multi-layer validation for generated test code:
 * - Structure (25 points)
 * - Assertions (25 points)
 * - Coverage (25 points)
 * - Best Practices (25 points)
 */

import { validateSyntax, quickValidate } from './syntaxValidator.js';

/**
 * Framework-specific patterns for test detection
 */
const FRAMEWORK_PATTERNS = {
    jest: {
        testBlocks: [
            /\b(test|it)\s*\(\s*['"`]/g,
            /\bdescribe\s*\(\s*['"`]/g,
            /\bbeforeEach\s*\(/g,
            /\bafterEach\s*\(/g,
            /\bbeforeAll\s*\(/g,
            /\bafterAll\s*\(/g
        ],
        assertions: [
            /\bexpect\s*\([^)]+\)\s*\.\s*\w+/g,
            /\bexpect\s*\([^)]+\)\s*\.\s*not\s*\.\s*\w+/g,
            /\.toEqual\s*\(/g,
            /\.toBe\s*\(/g,
            /\.toHaveBeenCalled/g,
            /\.toThrow/g,
            /\.resolves\s*\./g,
            /\.rejects\s*\./g
        ],
        mocks: [
            /\bjest\.fn\s*\(/g,
            /\bjest\.mock\s*\(/g,
            /\bjest\.spyOn\s*\(/g,
            /\.mockReturnValue\s*\(/g,
            /\.mockImplementation\s*\(/g,
            /\.mockResolvedValue\s*\(/g
        ],
        async: [
            /\basync\s+\(/g,
            /\bawait\s+/g,
            /\.resolves\s*\./g,
            /\.rejects\s*\./g
        ]
    },
    mocha: {
        testBlocks: [
            /\b(it|specify)\s*\(\s*['"`]/g,
            /\bdescribe\s*\(\s*['"`]/g,
            /\bcontext\s*\(\s*['"`]/g,
            /\bbefore\s*\(/g,
            /\bafter\s*\(/g,
            /\bbeforeEach\s*\(/g,
            /\bafterEach\s*\(/g
        ],
        assertions: [
            /\bassert\s*\.\s*\w+/g,
            /\bexpect\s*\([^)]+\)\s*\.\s*to\s*\./g,
            /\.should\s*\./g,
            /\bshould\s*\.\s*\w+/g
        ],
        mocks: [
            /\bsinon\.\w+/g,
            /\.stub\s*\(/g,
            /\.spy\s*\(/g,
            /\.mock\s*\(/g
        ],
        async: [
            /\bdone\s*\(/g,
            /\breturn\s+.*\.then\s*\(/g,
            /\basync\s+/g
        ]
    },
    pytest: {
        testBlocks: [
            /\bdef\s+test_\w+/g,
            /\bclass\s+Test\w+/g,
            /\b@pytest\.\w+/g,
            /\b@fixture/g
        ],
        assertions: [
            /\bassert\s+/g,
            /\bpytest\.raises\s*\(/g,
            /\bpytest\.warns\s*\(/g,
            /\bpytest\.approx\s*\(/g
        ],
        mocks: [
            /\b@patch/g,
            /\bmocker\.\w+/g,
            /\bMagicMock\s*\(/g,
            /\bMock\s*\(/g
        ],
        async: [
            /\basync\s+def\s+test_/g,
            /\bawait\s+/g,
            /\b@pytest\.mark\.asyncio/g
        ]
    },
    vitest: {
        testBlocks: [
            /\b(test|it)\s*\(\s*['"`]/g,
            /\bdescribe\s*\(\s*['"`]/g,
            /\bbeforeEach\s*\(/g,
            /\bafterEach\s*\(/g
        ],
        assertions: [
            /\bexpect\s*\([^)]+\)\s*\.\s*\w+/g,
            /\.toEqual\s*\(/g,
            /\.toBe\s*\(/g,
            /\.toMatchSnapshot\s*\(/g
        ],
        mocks: [
            /\bvi\.fn\s*\(/g,
            /\bvi\.mock\s*\(/g,
            /\bvi\.spyOn\s*\(/g
        ],
        async: [
            /\basync\s+/g,
            /\bawait\s+/g
        ]
    },
    junit: {
        testBlocks: [
            /\b@Test\b/g,
            /\b@BeforeEach\b/g,
            /\b@AfterEach\b/g,
            /\b@BeforeAll\b/g,
            /\b@AfterAll\b/g,
            /\bpublic\s+void\s+test\w+/g
        ],
        assertions: [
            /\bassertEquals\s*\(/g,
            /\bassertTrue\s*\(/g,
            /\bassertFalse\s*\(/g,
            /\bassertNotNull\s*\(/g,
            /\bassertThrows\s*\(/g,
            /\bassertThat\s*\(/g
        ],
        mocks: [
            /\b@Mock\b/g,
            /\b@InjectMocks\b/g,
            /\bwhen\s*\(/g,
            /\bverify\s*\(/g,
            /\bMockito\.\w+/g
        ],
        async: []
    }
};

/**
 * Test name quality patterns
 */
const TEST_NAME_PATTERNS = {
    good: [
        /should\s+\w+/i,
        /when\s+\w+.*then/i,
        /given\s+\w+.*when/i,
        /returns?\s+\w+/i,
        /throws?\s+\w+/i,
        /handles?\s+\w+/i
    ],
    bad: [
        /^test\d*$/i,
        /^it\s*$/i,
        /^works?$/i,
        /^should$/i,
        /^check/i
    ]
};

/**
 * Validate test quality
 * Returns a score from 0-100 with detailed breakdown
 */
export function validateTestQuality(code, options = {}) {
    const {
        framework = detectFramework(code),
        targetFunction = null,
        expectedCoverage = ['happy', 'error', 'edge']
    } = options;

    const result = {
        score: 0,
        breakdown: {
            structure: { score: 0, max: 25, details: [] },
            assertions: { score: 0, max: 25, details: [] },
            coverage: { score: 0, max: 25, details: [] },
            bestPractices: { score: 0, max: 25, details: [] }
        },
        issues: [],
        suggestions: [],
        metadata: {
            framework,
            testCount: 0,
            assertionCount: 0,
            hasAsync: false,
            hasMocks: false
        }
    };

    // First validate syntax
    const syntaxResult = quickValidate(code);
    if (!syntaxResult.valid) {
        result.issues.push({
            severity: 'error',
            type: 'SYNTAX_ERROR',
            message: syntaxResult.error
        });
        return result;
    }

    const patterns = FRAMEWORK_PATTERNS[framework] || FRAMEWORK_PATTERNS.jest;

    // 1. Structure Validation (25 points)
    validateStructure(code, patterns, result);

    // 2. Assertions Validation (25 points)
    validateAssertions(code, patterns, result);

    // 3. Coverage Validation (25 points)
    validateCoverage(code, patterns, result, targetFunction, expectedCoverage);

    // 4. Best Practices Validation (25 points)
    validateBestPractices(code, patterns, result, framework);

    // Calculate total score
    result.score =
        result.breakdown.structure.score +
        result.breakdown.assertions.score +
        result.breakdown.coverage.score +
        result.breakdown.bestPractices.score;

    // Generate suggestions
    generateSuggestions(result);

    return result;
}

/**
 * Detect testing framework from code
 */
export function detectFramework(code) {
    const frameworkIndicators = {
        jest: [/\bjest\./g, /\.toMatchSnapshot/g, /jest\.fn\(/g],
        vitest: [/\bvi\./g, /from\s+['"]vitest['"]/g],
        mocha: [/\bsinon\./g, /\bshould\./g, /\.should\./g, /from\s+['"]chai['"]/g],
        pytest: [/\bpytest\./g, /\bdef\s+test_/g, /\b@fixture/g],
        junit: [/\b@Test\b/g, /\bimport\s+.*junit/g, /\bAssertions\./g]
    };

    let bestMatch = 'jest'; // Default to jest
    let highestCount = 0;

    for (const [framework, patterns] of Object.entries(frameworkIndicators)) {
        let count = 0;
        for (const pattern of patterns) {
            const matches = code.match(pattern);
            if (matches) count += matches.length;
        }
        if (count > highestCount) {
            highestCount = count;
            bestMatch = framework;
        }
    }

    return bestMatch;
}

/**
 * Validate test structure
 */
function validateStructure(code, patterns, result) {
    const structure = result.breakdown.structure;

    // Count test blocks
    let testCount = 0;
    let describeCount = 0;
    let setupCount = 0;
    let teardownCount = 0;

    for (const pattern of patterns.testBlocks) {
        const matches = code.match(pattern) || [];
        const patternStr = pattern.source;

        if (patternStr.includes('test') || patternStr.includes('it') || patternStr.includes('specify')) {
            testCount += matches.length;
        } else if (patternStr.includes('describe') || patternStr.includes('context')) {
            describeCount += matches.length;
        } else if (patternStr.includes('before') || patternStr.includes('Before')) {
            setupCount += matches.length;
        } else if (patternStr.includes('after') || patternStr.includes('After')) {
            teardownCount += matches.length;
        }
    }

    result.metadata.testCount = testCount;

    // Score based on structure
    if (testCount >= 1) {
        structure.score += 10;
        structure.details.push({ pass: true, message: `Has ${testCount} test(s)` });
    } else {
        structure.details.push({ pass: false, message: 'No test blocks found' });
        result.issues.push({
            severity: 'error',
            type: 'NO_TESTS',
            message: 'No test blocks found in code'
        });
    }

    // Grouping with describe
    if (describeCount >= 1 && testCount > 1) {
        structure.score += 5;
        structure.details.push({ pass: true, message: `Tests are grouped (${describeCount} describe block(s))` });
    } else if (testCount > 3) {
        structure.details.push({ pass: false, message: 'Consider grouping tests with describe blocks' });
    }

    // Setup/teardown
    if (setupCount > 0 || teardownCount > 0) {
        structure.score += 5;
        structure.details.push({ pass: true, message: 'Uses setup/teardown hooks' });
    }

    // Has proper imports
    const hasImports = /^import\s+/m.test(code) || /^const\s+.*=\s*require/m.test(code);
    if (hasImports) {
        structure.score += 5;
        structure.details.push({ pass: true, message: 'Has proper imports' });
    } else {
        structure.details.push({ pass: false, message: 'Missing imports' });
    }
}

/**
 * Validate assertions
 */
function validateAssertions(code, patterns, result) {
    const assertions = result.breakdown.assertions;

    // Count assertions
    let assertionCount = 0;
    for (const pattern of patterns.assertions) {
        const matches = code.match(pattern) || [];
        assertionCount += matches.length;
    }

    result.metadata.assertionCount = assertionCount;

    const testCount = result.metadata.testCount || 1;
    const assertionsPerTest = assertionCount / testCount;

    // Score based on assertion count
    if (assertionCount === 0) {
        assertions.details.push({ pass: false, message: 'No assertions found' });
        result.issues.push({
            severity: 'error',
            type: 'NO_ASSERTIONS',
            message: 'Tests have no assertions'
        });
    } else if (assertionsPerTest < 1) {
        assertions.score += 5;
        assertions.details.push({ pass: false, message: `Low assertion density: ${assertionsPerTest.toFixed(1)} per test` });
        result.issues.push({
            severity: 'warning',
            type: 'LOW_ASSERTIONS',
            message: 'Some tests may be missing assertions'
        });
    } else if (assertionsPerTest >= 1 && assertionsPerTest <= 5) {
        assertions.score += 15;
        assertions.details.push({ pass: true, message: `Good assertion density: ${assertionsPerTest.toFixed(1)} per test` });
    } else {
        assertions.score += 10;
        assertions.details.push({ pass: true, message: `High assertion density: ${assertionsPerTest.toFixed(1)} per test` });
    }

    // Check for meaningful assertions
    const hasMeaningfulAssertions =
        /\.toEqual\((?!undefined|null)/.test(code) ||
        /\.toBe\((?!undefined|null)/.test(code) ||
        /assertEquals\([^,]+,\s*[^)]+\)/.test(code) ||
        /\bassert\s+\w+\s*(==|!=|is|in|not)/.test(code);

    if (hasMeaningfulAssertions) {
        assertions.score += 5;
        assertions.details.push({ pass: true, message: 'Has meaningful value assertions' });
    }

    // Check for error assertions
    const hasErrorAssertions =
        /\.toThrow/.test(code) ||
        /\.rejects/.test(code) ||
        /assertThrows/.test(code) ||
        /pytest\.raises/.test(code);

    if (hasErrorAssertions) {
        assertions.score += 5;
        assertions.details.push({ pass: true, message: 'Tests error conditions' });
    }
}

/**
 * Validate test coverage types
 */
function validateCoverage(code, patterns, result, targetFunction, expectedCoverage) {
    const coverage = result.breakdown.coverage;

    // Analyze test names and content for coverage types
    const testContents = extractTestContents(code);

    const coverageFound = {
        happy: false,
        error: false,
        edge: false,
        null: false,
        boundary: false,
        async: false
    };

    // Check for happy path tests
    const happyPatterns = [/success/i, /valid/i, /correct/i, /returns/i, /works/i, /should\s+\w+/i];
    for (const test of testContents) {
        if (happyPatterns.some(p => p.test(test))) {
            coverageFound.happy = true;
            break;
        }
    }

    // Check for error tests
    const errorPatterns = [/error/i, /fail/i, /invalid/i, /throw/i, /reject/i, /exception/i];
    for (const test of testContents) {
        if (errorPatterns.some(p => p.test(test))) {
            coverageFound.error = true;
            break;
        }
    }

    // Check for edge case tests
    const edgePatterns = [/edge/i, /empty/i, /null/i, /undefined/i, /zero/i, /negative/i, /boundary/i, /special/i, /large/i, /small/i];
    for (const test of testContents) {
        if (edgePatterns.some(p => p.test(test))) {
            coverageFound.edge = true;
            break;
        }
    }

    // Check for null/undefined tests
    if (/null|undefined|nil|None/i.test(code)) {
        coverageFound.null = true;
    }

    // Check for boundary tests
    if (/0|max|min|boundary|limit/i.test(code)) {
        coverageFound.boundary = true;
    }

    // Check for async tests
    for (const pattern of patterns.async || []) {
        if (pattern.test(code)) {
            coverageFound.async = true;
            result.metadata.hasAsync = true;
            break;
        }
    }

    // Score based on coverage
    let coverageScore = 0;
    const coveredTypes = [];

    if (coverageFound.happy) {
        coverageScore += 8;
        coveredTypes.push('happy path');
    }
    if (coverageFound.error) {
        coverageScore += 8;
        coveredTypes.push('error cases');
    }
    if (coverageFound.edge) {
        coverageScore += 6;
        coveredTypes.push('edge cases');
    }
    if (coverageFound.null || coverageFound.boundary) {
        coverageScore += 3;
        coveredTypes.push('boundary/null cases');
    }

    coverage.score = Math.min(coverageScore, 25);

    if (coveredTypes.length > 0) {
        coverage.details.push({ pass: true, message: `Covers: ${coveredTypes.join(', ')}` });
    }

    // Check missing coverage
    const missing = [];
    if (!coverageFound.happy) missing.push('happy path');
    if (!coverageFound.error) missing.push('error handling');
    if (!coverageFound.edge) missing.push('edge cases');

    if (missing.length > 0) {
        coverage.details.push({ pass: false, message: `Missing coverage: ${missing.join(', ')}` });
        result.issues.push({
            severity: 'warning',
            type: 'INCOMPLETE_COVERAGE',
            message: `Tests missing: ${missing.join(', ')}`
        });
    }
}

/**
 * Validate best practices
 */
function validateBestPractices(code, patterns, result, framework) {
    const practices = result.breakdown.bestPractices;

    // Check test naming
    const testNames = extractTestNames(code, framework);
    let goodNames = 0;
    let badNames = 0;

    for (const name of testNames) {
        const isGood = TEST_NAME_PATTERNS.good.some(p => p.test(name));
        const isBad = TEST_NAME_PATTERNS.bad.some(p => p.test(name));

        if (isGood && !isBad) goodNames++;
        else if (isBad) badNames++;
    }

    if (testNames.length > 0) {
        const goodRatio = goodNames / testNames.length;
        if (goodRatio >= 0.8) {
            practices.score += 8;
            practices.details.push({ pass: true, message: 'Descriptive test names' });
        } else if (goodRatio >= 0.5) {
            practices.score += 5;
            practices.details.push({ pass: true, message: 'Mostly descriptive test names' });
        } else {
            practices.details.push({ pass: false, message: 'Test names could be more descriptive' });
        }
    }

    // Check for mocking
    let hasMocks = false;
    for (const pattern of patterns.mocks || []) {
        if (pattern.test(code)) {
            hasMocks = true;
            break;
        }
    }
    result.metadata.hasMocks = hasMocks;

    // Check for proper async handling
    const hasAsyncTests = /async\s+\(|async\s+function|async\s+def/.test(code);
    const hasAwait = /\bawait\b/.test(code);
    const hasThen = /\.then\s*\(/.test(code);
    const hasDone = /\bdone\s*\(\s*\)/.test(code);

    if (hasAsyncTests || hasThen || hasDone) {
        if (hasAsyncTests && hasAwait) {
            practices.score += 6;
            practices.details.push({ pass: true, message: 'Uses async/await properly' });
        } else if (hasDone || hasThen) {
            practices.score += 4;
            practices.details.push({ pass: true, message: 'Handles async with callbacks/promises' });
        }
    } else {
        practices.score += 3;
    }

    // Check for test isolation (no shared state mutation)
    const hasSharedState = /^(let|var)\s+\w+\s*=/m.test(code) && !/beforeEach|setUp/i.test(code);
    if (!hasSharedState) {
        practices.score += 5;
        practices.details.push({ pass: true, message: 'Tests appear isolated' });
    } else if (/beforeEach|setUp/i.test(code)) {
        practices.score += 5;
        practices.details.push({ pass: true, message: 'Uses setup for shared state' });
    } else {
        practices.details.push({ pass: false, message: 'Potential shared state between tests' });
    }

    // Check for cleanup
    const hasCleanup = /afterEach|tearDown|after\s*\(/i.test(code);
    if (hasMocks || hasSharedState) {
        if (hasCleanup) {
            practices.score += 3;
            practices.details.push({ pass: true, message: 'Has cleanup/teardown' });
        } else {
            practices.details.push({ pass: false, message: 'Consider adding cleanup for mocks/state' });
        }
    } else {
        practices.score += 3;
    }

    // Check for no console.log in tests
    const hasConsoleLogs = /console\.(log|info|debug)\s*\(/.test(code);
    if (!hasConsoleLogs) {
        practices.score += 3;
        practices.details.push({ pass: true, message: 'No debug console.log statements' });
    } else {
        practices.details.push({ pass: false, message: 'Remove console.log statements from tests' });
    }
}

/**
 * Extract test contents (name + body)
 */
function extractTestContents(code) {
    const contents = [];

    // Match test/it blocks
    const testPattern = /(?:test|it|specify)\s*\(\s*['"`]([^'"`]+)['"`][^{]*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/gs;
    let match;

    while ((match = testPattern.exec(code)) !== null) {
        contents.push(match[1] + ' ' + match[2]);
    }

    // Match Python test functions
    const pythonPattern = /def\s+(test_\w+)[^:]*:([\s\S]*?)(?=\n(?:def|class|$))/g;
    while ((match = pythonPattern.exec(code)) !== null) {
        contents.push(match[1] + ' ' + match[2]);
    }

    return contents;
}

/**
 * Extract test names
 */
function extractTestNames(code, framework) {
    const names = [];

    // JavaScript test names
    const jsPattern = /(?:test|it|specify)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let match;
    while ((match = jsPattern.exec(code)) !== null) {
        names.push(match[1]);
    }

    // Python test names
    const pythonPattern = /def\s+(test_\w+)/g;
    while ((match = pythonPattern.exec(code)) !== null) {
        names.push(match[1].replace(/_/g, ' '));
    }

    // Java test names
    const javaPattern = /void\s+(test\w+)/g;
    while ((match = javaPattern.exec(code)) !== null) {
        names.push(match[1]);
    }

    return names;
}

/**
 * Generate improvement suggestions
 */
function generateSuggestions(result) {
    const { breakdown, issues, metadata } = result;

    // Structure suggestions
    if (breakdown.structure.score < 15) {
        if (metadata.testCount === 0) {
            result.suggestions.push('Add test blocks using describe/it or test() syntax');
        }
        if (metadata.testCount > 3 && !issues.some(i => i.message.includes('grouped'))) {
            result.suggestions.push('Group related tests using describe() blocks');
        }
    }

    // Assertion suggestions
    if (breakdown.assertions.score < 15) {
        if (metadata.assertionCount === 0) {
            result.suggestions.push('Add assertions to verify expected behavior');
        } else {
            result.suggestions.push('Add more assertions to increase test confidence');
        }
    }

    // Coverage suggestions
    if (breakdown.coverage.score < 15) {
        result.suggestions.push('Add tests for error conditions and edge cases');
        result.suggestions.push('Consider boundary value testing');
    }

    // Best practices suggestions
    if (breakdown.bestPractices.score < 15) {
        result.suggestions.push('Use descriptive test names that explain the expected behavior');
    }

    // Async suggestions
    if (metadata.hasAsync && !issues.some(i => i.message.includes('async'))) {
        result.suggestions.push('Ensure all async operations are properly awaited');
    }
}

/**
 * Quick validation for generated tests
 */
export function quickValidateTests(code) {
    // Quick checks
    const hasTests = /\b(test|it|describe|def\s+test_|@Test)\b/.test(code);
    const hasAssertions = /\b(expect|assert|should)\b/.test(code);

    if (!hasTests) {
        return { valid: false, error: 'No test blocks found' };
    }
    if (!hasAssertions) {
        return { valid: false, error: 'No assertions found' };
    }

    return { valid: true };
}

export default {
    validateTestQuality,
    detectFramework,
    quickValidateTests
};

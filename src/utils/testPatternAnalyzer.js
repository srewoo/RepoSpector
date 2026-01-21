/**
 * Test Pattern Analyzer for RepoSpector
 *
 * Learns testing patterns from existing tests in the codebase via RAG
 * to generate consistent and idiomatic test code.
 */

/**
 * Testing pattern categories
 */
export const PATTERN_CATEGORIES = {
    STRUCTURE: 'structure',         // How tests are organized
    NAMING: 'naming',               // Test naming conventions
    ASSERTIONS: 'assertions',       // Common assertion patterns
    MOCKING: 'mocking',            // How mocks are created/used
    SETUP: 'setup',                 // Setup/teardown patterns
    ASYNC: 'async',                 // Async test handling
    DATA: 'data',                   // Test data patterns
    ERROR: 'error'                  // Error testing patterns
};

/**
 * Framework-specific pattern extractors
 */
const PATTERN_EXTRACTORS = {
    jest: {
        structure: [
            { pattern: /describe\(['"`]([^'"`]+)['"`],\s*\(\)\s*=>\s*\{/g, type: 'describe-arrow' },
            { pattern: /describe\(['"`]([^'"`]+)['"`],\s*function\s*\(\)\s*\{/g, type: 'describe-function' },
            { pattern: /describe\.each\([^)]+\)\(['"`]([^'"`]+)['"`]/g, type: 'describe-each' }
        ],
        naming: [
            { pattern: /it\(['"`](should\s+[^'"`]+)['"`]/g, type: 'should-style' },
            { pattern: /it\(['"`](when\s+[^'"`]+)['"`]/g, type: 'when-then-style' },
            { pattern: /test\(['"`]([^'"`]+)['"`]/g, type: 'test-style' }
        ],
        assertions: [
            { pattern: /expect\(([^)]+)\)\.toBe\(([^)]+)\)/g, type: 'toBe' },
            { pattern: /expect\(([^)]+)\)\.toEqual\(([^)]+)\)/g, type: 'toEqual' },
            { pattern: /expect\(([^)]+)\)\.toHaveLength\(([^)]+)\)/g, type: 'toHaveLength' },
            { pattern: /expect\(([^)]+)\)\.toHaveBeenCalledWith\(([^)]+)\)/g, type: 'toHaveBeenCalledWith' },
            { pattern: /expect\(([^)]+)\)\.toMatchObject\(([^)]+)\)/g, type: 'toMatchObject' },
            { pattern: /expect\(([^)]+)\)\.toContain\(([^)]+)\)/g, type: 'toContain' }
        ],
        mocking: [
            { pattern: /jest\.fn\(\)/g, type: 'jest.fn' },
            { pattern: /jest\.mock\(['"`]([^'"`]+)['"`]/g, type: 'jest.mock' },
            { pattern: /jest\.spyOn\(([^,]+),\s*['"`]([^'"`]+)['"`]\)/g, type: 'jest.spyOn' },
            { pattern: /\.mockReturnValue\(([^)]+)\)/g, type: 'mockReturnValue' },
            { pattern: /\.mockResolvedValue\(([^)]+)\)/g, type: 'mockResolvedValue' },
            { pattern: /\.mockImplementation\(/g, type: 'mockImplementation' }
        ],
        setup: [
            { pattern: /beforeEach\(\s*(?:async\s*)?\(\)\s*=>\s*\{([^}]+)\}\)/gs, type: 'beforeEach' },
            { pattern: /afterEach\(\s*(?:async\s*)?\(\)\s*=>\s*\{([^}]+)\}\)/gs, type: 'afterEach' },
            { pattern: /beforeAll\(\s*(?:async\s*)?\(\)\s*=>\s*\{([^}]+)\}\)/gs, type: 'beforeAll' }
        ],
        async: [
            { pattern: /it\(['"`][^'"`]+['"`],\s*async\s*\(\)\s*=>/g, type: 'async-it' },
            { pattern: /await\s+expect\(([^)]+)\)\.resolves/g, type: 'resolves' },
            { pattern: /await\s+expect\(([^)]+)\)\.rejects/g, type: 'rejects' }
        ],
        error: [
            { pattern: /expect\(\s*\(\)\s*=>\s*[^)]+\)\.toThrow\(/g, type: 'sync-throw' },
            { pattern: /expect\([^)]+\)\.rejects\.toThrow\(/g, type: 'async-throw' },
            { pattern: /expect\([^)]+\)\.toThrowError\(/g, type: 'toThrowError' }
        ]
    },

    mocha: {
        structure: [
            { pattern: /describe\(['"`]([^'"`]+)['"`],\s*function\s*\(\)\s*\{/g, type: 'describe-function' },
            { pattern: /context\(['"`]([^'"`]+)['"`]/g, type: 'context' }
        ],
        naming: [
            { pattern: /it\(['"`](should\s+[^'"`]+)['"`]/g, type: 'should-style' }
        ],
        assertions: [
            { pattern: /expect\(([^)]+)\)\.to\.equal\(([^)]+)\)/g, type: 'chai-equal' },
            { pattern: /expect\(([^)]+)\)\.to\.be\.true/g, type: 'chai-true' },
            { pattern: /expect\(([^)]+)\)\.to\.deep\.equal\(([^)]+)\)/g, type: 'chai-deep-equal' },
            { pattern: /assert\.equal\(([^,]+),\s*([^)]+)\)/g, type: 'assert-equal' }
        ],
        mocking: [
            { pattern: /sinon\.stub\(([^)]+)\)/g, type: 'sinon-stub' },
            { pattern: /sinon\.spy\(([^)]+)\)/g, type: 'sinon-spy' },
            { pattern: /sinon\.mock\(([^)]+)\)/g, type: 'sinon-mock' }
        ],
        setup: [
            { pattern: /before\(\s*function\s*\(\)\s*\{([^}]+)\}\)/gs, type: 'before' },
            { pattern: /beforeEach\(\s*function\s*\(\)\s*\{([^}]+)\}\)/gs, type: 'beforeEach' }
        ],
        async: [
            { pattern: /it\(['"`][^'"`]+['"`],\s*function\s*\(done\)/g, type: 'done-callback' },
            { pattern: /it\(['"`][^'"`]+['"`],\s*async\s*function\s*\(\)/g, type: 'async-function' }
        ],
        error: [
            { pattern: /expect\(\s*\(\)\s*=>[^)]+\)\.to\.throw/g, type: 'chai-throw' }
        ]
    },

    pytest: {
        structure: [
            { pattern: /class\s+(Test\w+):/g, type: 'test-class' },
            { pattern: /@pytest\.fixture/g, type: 'fixture' }
        ],
        naming: [
            { pattern: /def\s+(test_\w+)/g, type: 'test-function' }
        ],
        assertions: [
            { pattern: /assert\s+(\w+)\s*==\s*([^\n]+)/g, type: 'assert-equal' },
            { pattern: /assert\s+(\w+)\s+is\s+([^\n]+)/g, type: 'assert-is' },
            { pattern: /assert\s+(\w+)\s+in\s+([^\n]+)/g, type: 'assert-in' }
        ],
        mocking: [
            { pattern: /@patch\(['"`]([^'"`]+)['"`]\)/g, type: 'patch-decorator' },
            { pattern: /mocker\.patch\(['"`]([^'"`]+)['"`]\)/g, type: 'mocker-patch' }
        ],
        setup: [
            { pattern: /@pytest\.fixture\s*(?:\([^)]*\))?\s*def\s+(\w+)/g, type: 'fixture-def' }
        ],
        async: [
            { pattern: /@pytest\.mark\.asyncio/g, type: 'asyncio-mark' },
            { pattern: /async\s+def\s+test_/g, type: 'async-test' }
        ],
        error: [
            { pattern: /with\s+pytest\.raises\((\w+)\)/g, type: 'pytest-raises' }
        ]
    }
};

/**
 * Analyze existing tests to extract patterns
 */
export function analyzeTestPatterns(testCode, framework = 'jest') {
    const extractors = PATTERN_EXTRACTORS[framework] || PATTERN_EXTRACTORS.jest;
    const patterns = {
        framework,
        structure: [],
        naming: [],
        assertions: [],
        mocking: [],
        setup: [],
        async: [],
        data: [],
        error: [],
        summary: {}
    };

    // Extract patterns for each category
    for (const [category, categoryExtractors] of Object.entries(extractors)) {
        for (const { pattern, type } of categoryExtractors) {
            const matches = [...testCode.matchAll(pattern)];
            for (const match of matches) {
                patterns[category].push({
                    type,
                    match: match[0],
                    captures: match.slice(1),
                    index: match.index
                });
            }
        }
    }

    // Analyze test data patterns
    patterns.data = analyzeTestData(testCode);

    // Generate summary
    patterns.summary = generatePatternSummary(patterns);

    return patterns;
}

/**
 * Analyze test data patterns
 */
function analyzeTestData(code) {
    const dataPatterns = [];

    // Factory functions
    const factoryPatterns = /(?:const|function)\s+(create|make|build|generate)\w*\s*[=\(]/g;
    let match;
    while ((match = factoryPatterns.exec(code)) !== null) {
        dataPatterns.push({
            type: 'factory',
            name: match[1],
            match: match[0]
        });
    }

    // Fixtures
    const fixturePatterns = /(?:const|let)\s+(\w*(?:fixture|mock|stub|fake|dummy|sample|test)\w*)\s*=/gi;
    while ((match = fixturePatterns.exec(code)) !== null) {
        dataPatterns.push({
            type: 'fixture',
            name: match[1],
            match: match[0]
        });
    }

    // Object literals for test data
    const objectDataPattern = /(?:const|let)\s+(\w+)\s*=\s*\{[^}]+\}\s*;/g;
    while ((match = objectDataPattern.exec(code)) !== null) {
        if (/data|input|expected|result|mock|config|options/i.test(match[1])) {
            dataPatterns.push({
                type: 'object-data',
                name: match[1],
                match: match[0]
            });
        }
    }

    return dataPatterns;
}

/**
 * Generate summary of extracted patterns
 */
function generatePatternSummary(patterns) {
    return {
        totalPatterns: Object.values(patterns)
            .filter(Array.isArray)
            .reduce((sum, arr) => sum + arr.length, 0),
        structureStyle: getMostCommonType(patterns.structure),
        namingConvention: getMostCommonType(patterns.naming),
        primaryAssertions: getTopTypes(patterns.assertions, 3),
        mockingApproach: getMostCommonType(patterns.mocking),
        asyncStyle: getMostCommonType(patterns.async),
        hasSetup: patterns.setup.length > 0,
        hasErrorTests: patterns.error.length > 0,
        usesFactories: patterns.data.some(d => d.type === 'factory')
    };
}

/**
 * Get most common pattern type
 */
function getMostCommonType(patterns) {
    if (!patterns || patterns.length === 0) return null;

    const counts = {};
    for (const p of patterns) {
        counts[p.type] = (counts[p.type] || 0) + 1;
    }

    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

/**
 * Get top N pattern types
 */
function getTopTypes(patterns, n = 3) {
    if (!patterns || patterns.length === 0) return [];

    const counts = {};
    for (const p of patterns) {
        counts[p.type] = (counts[p.type] || 0) + 1;
    }

    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([type]) => type);
}

/**
 * Learn patterns from RAG context
 */
export async function learnPatternsFromRAG(ragService, repoId, targetFunction) {
    try {
        // Search for existing test patterns
        const testQuery = `test ${targetFunction} unit test mock assert`;

        const results = await ragService.retrieveContext(
            repoId,
            testQuery,
            5,
            {
                includeMetadata: true,
                formatOutput: false
            }
        );

        if (!results || results.length === 0) {
            return null;
        }

        // Combine test code from results
        const testCode = results
            .filter(r => isTestFile(r.filePath || r.metadata?.filePath))
            .map(r => r.content || r.text)
            .join('\n\n');

        if (!testCode) {
            return null;
        }

        // Detect framework
        const framework = detectFramework(testCode);

        // Analyze patterns
        const patterns = analyzeTestPatterns(testCode, framework);

        return {
            patterns,
            sourceFiles: results.map(r => r.filePath || r.metadata?.filePath).filter(Boolean),
            framework
        };
    } catch (error) {
        console.error('Failed to learn patterns from RAG:', error);
        return null;
    }
}

/**
 * Check if file is a test file
 */
function isTestFile(filePath) {
    if (!filePath) return false;
    return /\.(test|spec|e2e)\.(js|ts|jsx|tsx)$/.test(filePath) ||
           /tests?\//i.test(filePath) ||
           /__tests__\//.test(filePath) ||
           /test_\w+\.py$/.test(filePath);
}

/**
 * Detect testing framework from code
 */
function detectFramework(code) {
    const indicators = {
        jest: [/jest\./g, /\.toMatchSnapshot/g, /jest\.fn/g],
        mocha: [/\bsinon\./g, /\.to\.equal/g, /\bshould\./g],
        pytest: [/\bpytest\./g, /\bdef\s+test_/g, /@fixture/g]
    };

    let best = 'jest';
    let maxScore = 0;

    for (const [framework, patterns] of Object.entries(indicators)) {
        let score = 0;
        for (const pattern of patterns) {
            const matches = code.match(pattern);
            if (matches) score += matches.length;
        }
        if (score > maxScore) {
            maxScore = score;
            best = framework;
        }
    }

    return best;
}

/**
 * Build prompt enhancement from learned patterns
 */
export function buildPatternPromptEnhancement(learnedPatterns) {
    if (!learnedPatterns || !learnedPatterns.patterns) {
        return '';
    }

    const { patterns, framework } = learnedPatterns;
    const { summary } = patterns;

    let prompt = '\n## Testing Patterns From Codebase\n\n';
    prompt += `This codebase uses ${framework} for testing. Follow these patterns:\n\n`;

    // Structure style
    if (summary.structureStyle) {
        prompt += `**Test Structure**: Use ${summary.structureStyle} style\n`;
    }

    // Naming convention
    if (summary.namingConvention) {
        const examples = patterns.naming.slice(0, 2).map(n => n.captures?.[0] || n.match);
        prompt += `**Naming Convention**: Use ${summary.namingConvention} style\n`;
        if (examples.length > 0) {
            prompt += `  Examples from codebase: ${examples.join(', ')}\n`;
        }
    }

    // Assertion patterns
    if (summary.primaryAssertions.length > 0) {
        prompt += `**Assertions**: Prefer ${summary.primaryAssertions.join(', ')}\n`;
    }

    // Mocking approach
    if (summary.mockingApproach) {
        prompt += `**Mocking**: Use ${summary.mockingApproach}\n`;
        const mockExamples = patterns.mocking.slice(0, 2).map(m => m.match);
        if (mockExamples.length > 0) {
            prompt += `  Examples: \`${mockExamples[0]}\`\n`;
        }
    }

    // Async style
    if (summary.asyncStyle) {
        prompt += `**Async Tests**: Use ${summary.asyncStyle} pattern\n`;
    }

    // Setup/teardown
    if (summary.hasSetup) {
        prompt += `**Setup**: Tests use beforeEach/afterEach hooks\n`;
    }

    // Factories
    if (summary.usesFactories) {
        prompt += `**Test Data**: Consider using factory functions for test data\n`;
    }

    return prompt;
}

/**
 * Suggest tests based on patterns
 */
export function suggestTestsFromPatterns(patterns, targetFunction, functionAnalysis) {
    const suggestions = [];

    // Basic test suggestion
    suggestions.push({
        type: 'unit',
        name: formatTestName(patterns.summary.namingConvention, `${targetFunction} returns expected result`),
        description: 'Basic functionality test'
    });

    // Error test if pattern exists
    if (patterns.summary.hasErrorTests) {
        suggestions.push({
            type: 'error',
            name: formatTestName(patterns.summary.namingConvention, `${targetFunction} throws on invalid input`),
            description: 'Error handling test'
        });
    }

    // Async test if function is async
    if (functionAnalysis?.isAsync && patterns.summary.asyncStyle) {
        suggestions.push({
            type: 'async',
            name: formatTestName(patterns.summary.namingConvention, `${targetFunction} resolves with data`),
            description: 'Async success test'
        });
        suggestions.push({
            type: 'async-error',
            name: formatTestName(patterns.summary.namingConvention, `${targetFunction} rejects on error`),
            description: 'Async error test'
        });
    }

    // Edge case tests
    suggestions.push({
        type: 'edge',
        name: formatTestName(patterns.summary.namingConvention, `${targetFunction} handles empty input`),
        description: 'Edge case test'
    });

    return suggestions;
}

/**
 * Format test name based on convention
 */
function formatTestName(convention, description) {
    switch (convention) {
        case 'should-style':
            return `should ${description.replace(/^(should\s+)?/, '')}`;
        case 'when-then-style':
            return `when called ${description}`;
        case 'test-style':
            return description;
        default:
            return description;
    }
}

export default {
    PATTERN_CATEGORIES,
    analyzeTestPatterns,
    learnPatternsFromRAG,
    buildPatternPromptEnhancement,
    suggestTestsFromPatterns
};

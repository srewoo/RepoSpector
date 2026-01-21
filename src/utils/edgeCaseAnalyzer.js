/**
 * Edge Case Analyzer for RepoSpector
 *
 * Analyzes code to detect types and generate type-specific edge cases
 * for comprehensive test generation.
 */

/**
 * Type-specific edge cases for test generation
 */
export const EDGE_CASES = {
    string: {
        basic: [
            { value: '""', description: 'empty string' },
            { value: '"   "', description: 'whitespace only' },
            { value: '"\\t\\n"', description: 'tabs and newlines' }
        ],
        boundaries: [
            { value: '"a"', description: 'single character' },
            { value: '"a".repeat(1000)', description: 'very long string' },
            { value: '"a".repeat(10000)', description: 'extremely long string' }
        ],
        special: [
            { value: '"<script>alert(1)</script>"', description: 'XSS payload' },
            { value: '"\'; DROP TABLE users; --"', description: 'SQL injection' },
            { value: '"${process.env.SECRET}"', description: 'template injection' },
            { value: '"\\0"', description: 'null character' },
            { value: '"\\u0000"', description: 'unicode null' },
            { value: '"🎉🎊🎁"', description: 'emoji characters' },
            { value: '"日本語"', description: 'unicode (CJK)' },
            { value: '"مرحبا"', description: 'RTL text (Arabic)' }
        ],
        format: [
            { value: '"test@example.com"', description: 'email format' },
            { value: '"not-an-email"', description: 'invalid email' },
            { value: '"https://example.com"', description: 'URL format' },
            { value: '"192.168.1.1"', description: 'IP address' },
            { value: '"2023-12-25"', description: 'date format (ISO)' },
            { value: '"12/25/2023"', description: 'date format (US)' },
            { value: '"+1-555-123-4567"', description: 'phone number' }
        ]
    },

    number: {
        basic: [
            { value: '0', description: 'zero' },
            { value: '-0', description: 'negative zero' },
            { value: '1', description: 'positive one' },
            { value: '-1', description: 'negative one' }
        ],
        boundaries: [
            { value: 'Number.MAX_SAFE_INTEGER', description: 'max safe integer' },
            { value: 'Number.MIN_SAFE_INTEGER', description: 'min safe integer' },
            { value: 'Number.MAX_VALUE', description: 'max value' },
            { value: 'Number.MIN_VALUE', description: 'min positive value' },
            { value: 'Number.MAX_SAFE_INTEGER + 1', description: 'beyond safe integer' }
        ],
        special: [
            { value: 'Infinity', description: 'positive infinity' },
            { value: '-Infinity', description: 'negative infinity' },
            { value: 'NaN', description: 'not a number' },
            { value: '0.1 + 0.2', description: 'floating point precision' },
            { value: '1e308', description: 'scientific notation large' },
            { value: '1e-308', description: 'scientific notation small' }
        ],
        decimal: [
            { value: '0.5', description: 'simple decimal' },
            { value: '0.333333333333', description: 'repeating decimal' },
            { value: '-0.001', description: 'small negative decimal' },
            { value: '99.99', description: 'common currency value' }
        ]
    },

    array: {
        basic: [
            { value: '[]', description: 'empty array' },
            { value: '[1]', description: 'single element' },
            { value: '[1, 2, 3]', description: 'multiple elements' }
        ],
        boundaries: [
            { value: 'new Array(1000).fill(0)', description: 'large array (1000)' },
            { value: 'new Array(10000).fill(0)', description: 'very large array' },
            { value: '[[[[[]]]]]', description: 'deeply nested' }
        ],
        special: [
            { value: '[null, undefined, NaN]', description: 'falsy values' },
            { value: '[1, "2", true, null]', description: 'mixed types' },
            { value: '[{a: 1}, {a: 2}]', description: 'array of objects' },
            { value: '[[1, 2], [3, 4]]', description: '2D array' },
            { value: 'Array(3)', description: 'sparse array' },
            { value: '[1, , 3]', description: 'array with holes' }
        ],
        duplicate: [
            { value: '[1, 1, 1]', description: 'all duplicates' },
            { value: '[1, 2, 1, 2]', description: 'repeated pattern' }
        ]
    },

    object: {
        basic: [
            { value: '{}', description: 'empty object' },
            { value: '{ a: 1 }', description: 'single property' },
            { value: '{ a: 1, b: 2 }', description: 'multiple properties' }
        ],
        special: [
            { value: 'null', description: 'null object' },
            { value: '{ [Symbol("key")]: "value" }', description: 'symbol key' },
            { value: 'Object.create(null)', description: 'null prototype' },
            { value: '{ get x() { return 1; } }', description: 'getter property' },
            { value: '{ __proto__: null }', description: 'prototype pollution safe' },
            { value: '{ constructor: "evil" }', description: 'constructor property' }
        ],
        nested: [
            { value: '{ a: { b: { c: 1 } } }', description: 'deeply nested' },
            { value: '(() => { const o = {}; o.self = o; return o; })()', description: 'circular reference' }
        ],
        keys: [
            { value: '{ "": 1 }', description: 'empty string key' },
            { value: '{ " ": 1 }', description: 'whitespace key' },
            { value: '{ "123": 1 }', description: 'numeric string key' },
            { value: '{ "a.b": 1 }', description: 'dot in key' }
        ]
    },

    boolean: {
        basic: [
            { value: 'true', description: 'true' },
            { value: 'false', description: 'false' }
        ],
        truthy: [
            { value: '1', description: 'truthy number' },
            { value: '"true"', description: 'truthy string' },
            { value: '[]', description: 'truthy empty array' },
            { value: '{}', description: 'truthy empty object' }
        ],
        falsy: [
            { value: '0', description: 'falsy zero' },
            { value: '""', description: 'falsy empty string' },
            { value: 'null', description: 'falsy null' },
            { value: 'undefined', description: 'falsy undefined' },
            { value: 'NaN', description: 'falsy NaN' }
        ]
    },

    date: {
        basic: [
            { value: 'new Date()', description: 'current date' },
            { value: 'new Date(0)', description: 'epoch' },
            { value: 'new Date("2023-01-01")', description: 'specific date' }
        ],
        boundaries: [
            { value: 'new Date("1970-01-01")', description: 'unix epoch' },
            { value: 'new Date("2038-01-19")', description: 'near Y2K38' },
            { value: 'new Date(8640000000000000)', description: 'max date' },
            { value: 'new Date(-8640000000000000)', description: 'min date' }
        ],
        special: [
            { value: 'new Date("invalid")', description: 'invalid date' },
            { value: 'new Date("2023-02-29")', description: 'invalid leap day' },
            { value: 'new Date("2024-02-29")', description: 'valid leap day' },
            { value: 'new Date("2023-12-31T23:59:59.999Z")', description: 'year boundary' }
        ],
        timezone: [
            { value: 'new Date("2023-06-15T12:00:00+00:00")', description: 'UTC' },
            { value: 'new Date("2023-06-15T12:00:00-05:00")', description: 'EST' },
            { value: 'new Date("2023-06-15T12:00:00+09:00")', description: 'JST' }
        ]
    },

    function: {
        basic: [
            { value: '() => {}', description: 'empty arrow function' },
            { value: 'function() {}', description: 'empty function' },
            { value: '(x) => x', description: 'identity function' }
        ],
        special: [
            { value: 'async () => {}', description: 'async function' },
            { value: 'function* () {}', description: 'generator function' },
            { value: 'null', description: 'null instead of function' },
            { value: 'undefined', description: 'undefined instead of function' },
            { value: '() => { throw new Error(); }', description: 'throwing function' }
        ]
    },

    promise: {
        basic: [
            { value: 'Promise.resolve(1)', description: 'resolved promise' },
            { value: 'Promise.reject(new Error())', description: 'rejected promise' },
            { value: 'new Promise(() => {})', description: 'pending promise' }
        ],
        special: [
            { value: 'Promise.resolve().then(() => { throw new Error(); })', description: 'rejection in then' },
            { value: 'new Promise((r) => setTimeout(r, 5000))', description: 'slow promise' }
        ]
    }
};

/**
 * Parameter type patterns for detection
 */
const TYPE_PATTERNS = {
    string: [
        /:\s*string/i,
        /\.toString\(\)/,
        /\.trim\(\)/,
        /\.toLowerCase\(\)/,
        /\.toUpperCase\(\)/,
        /\.split\(/,
        /\.includes\(/,
        /\.startsWith\(/,
        /\.endsWith\(/,
        /\.match\(/,
        /\.replace\(/,
        /typeof\s+\w+\s*===?\s*['"]string['"]/
    ],
    number: [
        /:\s*number/i,
        /parseInt\(/,
        /parseFloat\(/,
        /Math\./,
        /\.toFixed\(/,
        /Number\(/,
        /typeof\s+\w+\s*===?\s*['"]number['"]/,
        /isNaN\(/,
        /isFinite\(/
    ],
    boolean: [
        /:\s*boolean/i,
        /!\s*\w+/,
        /\|\|/,
        /&&/,
        /typeof\s+\w+\s*===?\s*['"]boolean['"]/
    ],
    array: [
        /:\s*\w+\[\]/,
        /Array\.isArray/,
        /\.map\(/,
        /\.filter\(/,
        /\.reduce\(/,
        /\.forEach\(/,
        /\.find\(/,
        /\.some\(/,
        /\.every\(/,
        /\.push\(/,
        /\.pop\(/,
        /\.shift\(/,
        /\.slice\(/,
        /\.splice\(/,
        /\.length/
    ],
    object: [
        /:\s*object/i,
        /:\s*\{[^}]*\}/,
        /Object\./,
        /\.hasOwnProperty\(/,
        /in\s+\w+/,
        /typeof\s+\w+\s*===?\s*['"]object['"]/
    ],
    date: [
        /:\s*Date/,
        /new Date/,
        /\.getTime\(/,
        /\.toISOString\(/,
        /\.getFullYear\(/,
        /\.getMonth\(/,
        /Date\.now/,
        /Date\.parse/
    ],
    function: [
        /:\s*Function/,
        /:\s*\([^)]*\)\s*=>/,
        /typeof\s+\w+\s*===?\s*['"]function['"]/,
        /\.call\(/,
        /\.apply\(/,
        /\.bind\(/,
        /callback/i
    ],
    promise: [
        /:\s*Promise/,
        /async\s/,
        /await\s/,
        /\.then\(/,
        /\.catch\(/,
        /\.finally\(/,
        /Promise\./
    ]
};

/**
 * Context-aware value patterns
 */
const CONTEXT_PATTERNS = {
    email: [/email/i, /@/],
    url: [/url/i, /link/i, /href/i],
    phone: [/phone/i, /tel/i, /mobile/i],
    date: [/date/i, /time/i, /timestamp/i],
    id: [/id$/i, /Id$/],
    name: [/name/i, /title/i],
    password: [/password/i, /pwd/i, /secret/i],
    path: [/path/i, /file/i, /dir/i],
    count: [/count/i, /num/i, /quantity/i, /amount/i],
    price: [/price/i, /cost/i, /amount/i, /total/i],
    percentage: [/percent/i, /rate/i, /ratio/i]
};

/**
 * Analyze code to detect parameter types
 */
export function analyzeParameterTypes(code, paramName) {
    const detectedTypes = [];

    for (const [type, patterns] of Object.entries(TYPE_PATTERNS)) {
        for (const pattern of patterns) {
            // Check if pattern matches in context of parameter
            const paramRegex = new RegExp(`${paramName}[^\\w].*${pattern.source}|${pattern.source}.*${paramName}[^\\w]`, 'i');
            if (paramRegex.test(code)) {
                detectedTypes.push(type);
                break;
            }
        }
    }

    // Also check for TypeScript type annotations
    const tsTypeAnnotation = new RegExp(`${paramName}\\s*:\\s*(\\w+(?:<[^>]+>)?(?:\\[\\])?)`);
    const tsMatch = code.match(tsTypeAnnotation);
    if (tsMatch) {
        const annotatedType = tsMatch[1].toLowerCase();
        if (annotatedType.includes('string')) detectedTypes.push('string');
        if (annotatedType.includes('number') || annotatedType.includes('int')) detectedTypes.push('number');
        if (annotatedType.includes('boolean') || annotatedType.includes('bool')) detectedTypes.push('boolean');
        if (annotatedType.includes('[]') || annotatedType.includes('array')) detectedTypes.push('array');
        if (annotatedType.includes('date')) detectedTypes.push('date');
        if (annotatedType.includes('promise')) detectedTypes.push('promise');
    }

    return [...new Set(detectedTypes)];
}

/**
 * Detect context from parameter name and usage
 */
export function detectContext(paramName, code) {
    const contexts = [];

    for (const [context, patterns] of Object.entries(CONTEXT_PATTERNS)) {
        for (const pattern of patterns) {
            if (pattern.test(paramName) || pattern.test(code)) {
                contexts.push(context);
                break;
            }
        }
    }

    return contexts;
}

/**
 * Generate edge cases for detected types
 */
export function generateEdgeCases(types, contexts = [], options = {}) {
    const {
        maxPerType = 5,
        includeSecurity = true,
        includePerformance = true,
        prioritize = 'coverage' // 'coverage' | 'security' | 'boundaries'
    } = options;

    const edgeCases = [];
    const addedDescriptions = new Set();

    // If no types detected, use general edge cases
    if (types.length === 0) {
        types = ['string', 'number', 'boolean', 'array', 'object'];
    }

    for (const type of types) {
        const typeEdgeCases = EDGE_CASES[type];
        if (!typeEdgeCases) continue;

        // Prioritize based on option
        let categories;
        switch (prioritize) {
            case 'security':
                categories = ['special', 'basic', 'boundaries'];
                break;
            case 'boundaries':
                categories = ['boundaries', 'basic', 'special'];
                break;
            default:
                categories = ['basic', 'boundaries', 'special'];
        }

        let added = 0;
        for (const category of categories) {
            const cases = typeEdgeCases[category] || [];
            for (const edgeCase of cases) {
                if (added >= maxPerType) break;
                if (addedDescriptions.has(edgeCase.description)) continue;

                // Skip security cases if not requested
                if (!includeSecurity && category === 'special' &&
                    (edgeCase.description.includes('XSS') ||
                     edgeCase.description.includes('SQL') ||
                     edgeCase.description.includes('injection'))) {
                    continue;
                }

                // Skip performance cases if not requested
                if (!includePerformance &&
                    (edgeCase.description.includes('large') ||
                     edgeCase.description.includes('long'))) {
                    continue;
                }

                edgeCases.push({
                    ...edgeCase,
                    type,
                    category
                });
                addedDescriptions.add(edgeCase.description);
                added++;
            }
        }

        // Add context-specific edge cases
        for (const context of contexts) {
            const contextCases = getContextSpecificEdgeCases(type, context);
            for (const edgeCase of contextCases) {
                if (added >= maxPerType) break;
                if (addedDescriptions.has(edgeCase.description)) continue;

                edgeCases.push({
                    ...edgeCase,
                    type,
                    category: 'context',
                    context
                });
                addedDescriptions.add(edgeCase.description);
                added++;
            }
        }
    }

    return edgeCases;
}

/**
 * Get context-specific edge cases
 */
function getContextSpecificEdgeCases(type, context) {
    const cases = [];

    switch (context) {
        case 'email':
            if (type === 'string') {
                cases.push(
                    { value: '"test@example.com"', description: 'valid email' },
                    { value: '"invalid-email"', description: 'invalid email format' },
                    { value: '"test+tag@example.com"', description: 'email with plus sign' },
                    { value: '"test@sub.domain.com"', description: 'email with subdomain' },
                    { value: '"@example.com"', description: 'email without local part' },
                    { value: '"test@"', description: 'email without domain' }
                );
            }
            break;

        case 'url':
            if (type === 'string') {
                cases.push(
                    { value: '"https://example.com"', description: 'valid HTTPS URL' },
                    { value: '"http://example.com"', description: 'valid HTTP URL' },
                    { value: '"ftp://example.com"', description: 'FTP URL' },
                    { value: '"//example.com"', description: 'protocol-relative URL' },
                    { value: '"/path/to/resource"', description: 'relative URL' },
                    { value: '"javascript:alert(1)"', description: 'javascript URL (XSS)' },
                    { value: '"https://example.com?q=<script>"', description: 'URL with XSS in query' }
                );
            }
            break;

        case 'id':
            if (type === 'string') {
                cases.push(
                    { value: '"abc123"', description: 'alphanumeric ID' },
                    { value: '"123e4567-e89b-12d3-a456-426614174000"', description: 'UUID format' },
                    { value: '""', description: 'empty ID' },
                    { value: '"../../../etc/passwd"', description: 'path traversal in ID' }
                );
            } else if (type === 'number') {
                cases.push(
                    { value: '1', description: 'minimum valid ID' },
                    { value: '0', description: 'zero ID' },
                    { value: '-1', description: 'negative ID' },
                    { value: 'Number.MAX_SAFE_INTEGER', description: 'max ID value' }
                );
            }
            break;

        case 'password':
            if (type === 'string') {
                cases.push(
                    { value: '"Password123!"', description: 'strong password' },
                    { value: '"a"', description: 'too short password' },
                    { value: '""', description: 'empty password' },
                    { value: '"password"', description: 'common weak password' },
                    { value: '"a".repeat(1000)', description: 'very long password' },
                    { value: '"<script>"', description: 'XSS in password' }
                );
            }
            break;

        case 'count':
        case 'quantity':
            if (type === 'number') {
                cases.push(
                    { value: '0', description: 'zero count' },
                    { value: '1', description: 'single item' },
                    { value: '-1', description: 'negative count' },
                    { value: '0.5', description: 'fractional count' },
                    { value: '1000000', description: 'large count' }
                );
            }
            break;

        case 'price':
            if (type === 'number') {
                cases.push(
                    { value: '0', description: 'free (zero price)' },
                    { value: '0.01', description: 'minimum price' },
                    { value: '-1', description: 'negative price' },
                    { value: '99.99', description: 'typical price' },
                    { value: '0.001', description: 'sub-cent price' },
                    { value: '999999.99', description: 'high price' }
                );
            }
            break;

        case 'percentage':
            if (type === 'number') {
                cases.push(
                    { value: '0', description: 'zero percent' },
                    { value: '50', description: 'half' },
                    { value: '100', description: 'full (100%)' },
                    { value: '-10', description: 'negative percentage' },
                    { value: '150', description: 'over 100%' },
                    { value: '0.5', description: 'half percent' }
                );
            }
            break;

        case 'path':
            if (type === 'string') {
                cases.push(
                    { value: '"/valid/path/file.txt"', description: 'valid absolute path' },
                    { value: '"relative/path.txt"', description: 'relative path' },
                    { value: '"../parent/file.txt"', description: 'parent directory' },
                    { value: '"../../etc/passwd"', description: 'path traversal' },
                    { value: '"/path/with spaces/file.txt"', description: 'path with spaces' },
                    { value: '"C:\\\\Windows\\\\System32"', description: 'Windows path' },
                    { value: '""', description: 'empty path' }
                );
            }
            break;
    }

    return cases;
}

/**
 * Analyze a function and generate comprehensive edge cases
 */
export function analyzeFunction(code) {
    const result = {
        functionName: '',
        parameters: [],
        edgeCases: [],
        recommendations: []
    };

    // Extract function name
    const funcNameMatch = code.match(/(?:function\s+(\w+)|const\s+(\w+)\s*=|(\w+)\s*[=:]\s*(?:async\s*)?\(?)/);
    if (funcNameMatch) {
        result.functionName = funcNameMatch[1] || funcNameMatch[2] || funcNameMatch[3];
    }

    // Extract parameters
    const paramsMatch = code.match(/\(([^)]*)\)/);
    if (paramsMatch) {
        const paramsStr = paramsMatch[1];
        // Parse parameters (handle destructuring, defaults, types)
        const paramRegex = /(\w+)(?:\s*:\s*([^,=]+))?(?:\s*=\s*([^,]+))?/g;
        let match;
        while ((match = paramRegex.exec(paramsStr)) !== null) {
            const [, name, typeAnnotation, defaultValue] = match;
            const types = analyzeParameterTypes(code, name);
            const contexts = detectContext(name, code);

            result.parameters.push({
                name,
                typeAnnotation: typeAnnotation?.trim(),
                defaultValue: defaultValue?.trim(),
                detectedTypes: types,
                contexts
            });
        }
    }

    // Generate edge cases for each parameter
    for (const param of result.parameters) {
        const paramEdgeCases = generateEdgeCases(
            param.detectedTypes,
            param.contexts,
            { maxPerType: 4 }
        );

        result.edgeCases.push({
            parameter: param.name,
            cases: paramEdgeCases.map(ec => ({
                value: ec.value,
                description: `${param.name}: ${ec.description}`,
                type: ec.type,
                category: ec.category
            }))
        });
    }

    // Generate recommendations
    if (code.includes('throw') || code.includes('Error')) {
        result.recommendations.push('Test error throwing conditions');
    }
    if (code.includes('async') || code.includes('await') || code.includes('Promise')) {
        result.recommendations.push('Test async error handling and race conditions');
    }
    if (code.includes('try') && code.includes('catch')) {
        result.recommendations.push('Test both success and failure paths in try-catch');
    }
    if (code.includes('.length') || code.includes('for') || code.includes('while')) {
        result.recommendations.push('Test with empty and large collections');
    }

    return result;
}

/**
 * Build edge case prompt enhancements for test generation
 */
export function buildEdgeCasePromptEnhancements(codeAnalysis) {
    const { parameters, edgeCases, recommendations } = codeAnalysis;

    let prompt = '\n## Edge Cases to Test\n\n';

    // Add parameter-specific edge cases
    for (const paramEdgeCases of edgeCases) {
        prompt += `### Parameter: \`${paramEdgeCases.parameter}\`\n`;
        prompt += 'Test with these values:\n';

        for (const ec of paramEdgeCases.cases.slice(0, 5)) {
            prompt += `- ${ec.value} (${ec.description})\n`;
        }
        prompt += '\n';
    }

    // Add recommendations
    if (recommendations.length > 0) {
        prompt += '### Additional Recommendations\n';
        for (const rec of recommendations) {
            prompt += `- ${rec}\n`;
        }
    }

    return prompt;
}

export default {
    EDGE_CASES,
    analyzeParameterTypes,
    detectContext,
    generateEdgeCases,
    analyzeFunction,
    buildEdgeCasePromptEnhancements
};

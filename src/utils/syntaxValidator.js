/**
 * Syntax Validator for RepoSpector
 *
 * Browser-safe syntax checking for generated test code.
 * Uses a lightweight parsing approach since acorn may not be available.
 */

/**
 * Token types for basic lexing
 */
const TOKEN_TYPES = {
    STRING: 'STRING',
    TEMPLATE: 'TEMPLATE',
    COMMENT: 'COMMENT',
    KEYWORD: 'KEYWORD',
    IDENTIFIER: 'IDENTIFIER',
    NUMBER: 'NUMBER',
    OPERATOR: 'OPERATOR',
    PUNCTUATION: 'PUNCTUATION',
    REGEX: 'REGEX',
    WHITESPACE: 'WHITESPACE'
};

/**
 * JavaScript keywords
 */
const KEYWORDS = new Set([
    'break', 'case', 'catch', 'continue', 'debugger', 'default', 'delete',
    'do', 'else', 'finally', 'for', 'function', 'if', 'in', 'instanceof',
    'new', 'return', 'switch', 'this', 'throw', 'try', 'typeof', 'var',
    'void', 'while', 'with', 'class', 'const', 'enum', 'export', 'extends',
    'import', 'super', 'implements', 'interface', 'let', 'package', 'private',
    'protected', 'public', 'static', 'yield', 'async', 'await', 'of'
]);

/**
 * Bracket pairs for matching
 */
const BRACKET_PAIRS = {
    '(': ')',
    '[': ']',
    '{': '}',
    '<': '>'
};

const CLOSING_BRACKETS = new Set(Object.values(BRACKET_PAIRS));

/**
 * Validate JavaScript/TypeScript syntax
 * Returns validation result with errors and warnings
 */
export function validateSyntax(code, options = {}) {
    const {
        language = 'javascript',
        allowJSX = true,
        allowTypeScript = true,
        strictMode = false
    } = options;

    const result = {
        valid: true,
        errors: [],
        warnings: [],
        info: {
            lines: code.split('\n').length,
            characters: code.length,
            hasAsyncCode: false,
            hasJSX: false,
            hasTypeScript: false
        }
    };

    try {
        // Basic checks
        checkBracketMatching(code, result);
        checkStringQuotes(code, result);
        checkSemicolons(code, result, strictMode);
        checkCommonSyntaxErrors(code, result);
        checkKeywordUsage(code, result);

        // Language-specific checks
        if (allowTypeScript) {
            checkTypeScriptSyntax(code, result);
        }
        if (allowJSX) {
            checkJSXSyntax(code, result);
        }

        // Detect code features
        result.info.hasAsyncCode = /\basync\b|\bawait\b|\.then\(|Promise/.test(code);
        result.info.hasJSX = /<\w+[^>]*>/.test(code) && /<\/\w+>/.test(code);
        result.info.hasTypeScript = /:\s*(string|number|boolean|any|void|never|unknown)\b|<\w+>|interface\s+\w+|type\s+\w+\s*=/.test(code);

        // Try Function constructor validation (catches many syntax errors)
        validateWithFunctionConstructor(code, result);

    } catch (error) {
        result.valid = false;
        result.errors.push({
            type: 'PARSE_ERROR',
            message: error.message,
            line: null,
            column: null
        });
    }

    result.valid = result.errors.length === 0;
    return result;
}

/**
 * Check bracket matching
 */
function checkBracketMatching(code, result) {
    const stack = [];
    const positions = [];
    let inString = false;
    let stringChar = null;
    let inTemplate = false;
    let inComment = false;
    let inMultilineComment = false;
    let lineNumber = 1;
    let column = 0;

    for (let i = 0; i < code.length; i++) {
        const char = code[i];
        const prevChar = code[i - 1];
        const nextChar = code[i + 1];

        column++;

        if (char === '\n') {
            lineNumber++;
            column = 0;
            inComment = false;
            continue;
        }

        // Handle comments
        if (!inString && !inTemplate) {
            if (char === '/' && nextChar === '/') {
                inComment = true;
                continue;
            }
            if (char === '/' && nextChar === '*') {
                inMultilineComment = true;
                continue;
            }
            if (char === '*' && nextChar === '/') {
                inMultilineComment = false;
                i++;
                continue;
            }
        }

        if (inComment || inMultilineComment) continue;

        // Handle strings
        if (!inTemplate && (char === '"' || char === "'") && prevChar !== '\\') {
            if (!inString) {
                inString = true;
                stringChar = char;
            } else if (char === stringChar) {
                inString = false;
                stringChar = null;
            }
            continue;
        }

        // Handle template literals
        if (char === '`' && prevChar !== '\\') {
            inTemplate = !inTemplate;
            continue;
        }

        if (inString || inTemplate) continue;

        // Check brackets
        if (BRACKET_PAIRS[char]) {
            stack.push({ char, line: lineNumber, column, expected: BRACKET_PAIRS[char] });
            positions.push({ char, line: lineNumber, column });
        } else if (CLOSING_BRACKETS.has(char)) {
            if (stack.length === 0) {
                result.errors.push({
                    type: 'UNMATCHED_BRACKET',
                    message: `Unexpected closing bracket '${char}'`,
                    line: lineNumber,
                    column
                });
            } else {
                const last = stack.pop();
                if (last.expected !== char) {
                    result.errors.push({
                        type: 'MISMATCHED_BRACKET',
                        message: `Expected '${last.expected}' but found '${char}'`,
                        line: lineNumber,
                        column,
                        openedAt: { line: last.line, column: last.column }
                    });
                }
            }
        }
    }

    // Check for unclosed brackets
    for (const unclosed of stack) {
        result.errors.push({
            type: 'UNCLOSED_BRACKET',
            message: `Unclosed '${unclosed.char}' bracket`,
            line: unclosed.line,
            column: unclosed.column
        });
    }

    // Check for unclosed strings
    if (inString) {
        result.errors.push({
            type: 'UNCLOSED_STRING',
            message: 'Unclosed string literal',
            line: lineNumber,
            column
        });
    }

    if (inTemplate) {
        result.errors.push({
            type: 'UNCLOSED_TEMPLATE',
            message: 'Unclosed template literal',
            line: lineNumber,
            column
        });
    }
}

/**
 * Check string quote consistency
 */
function checkStringQuotes(code, result) {
    // Check for common quote issues
    const mixedQuotes = /(['"])[^'"]*\1.*(['"])[^'"]*\2/g;
    let singleQuoteCount = 0;
    let doubleQuoteCount = 0;

    // Count quotes (excluding escaped and template)
    const stringMatches = code.match(/(?<!\\)(['"])(.*?)(?<!\\)\1/g) || [];
    for (const match of stringMatches) {
        if (match.startsWith("'")) singleQuoteCount++;
        else doubleQuoteCount++;
    }

    // Warn about inconsistent quotes
    if (singleQuoteCount > 0 && doubleQuoteCount > 0) {
        const dominant = singleQuoteCount > doubleQuoteCount ? 'single' : 'double';
        result.warnings.push({
            type: 'INCONSISTENT_QUOTES',
            message: `Mixed quote styles. Consider using ${dominant} quotes consistently.`,
            singleCount: singleQuoteCount,
            doubleCount: doubleQuoteCount
        });
    }
}

/**
 * Check semicolon usage
 */
function checkSemicolons(code, result, strictMode) {
    if (!strictMode) return;

    const lines = code.split('\n');
    let lineNumber = 0;

    for (const line of lines) {
        lineNumber++;
        const trimmed = line.trim();

        // Skip empty lines, comments, and lines ending with certain patterns
        if (!trimmed ||
            trimmed.startsWith('//') ||
            trimmed.startsWith('/*') ||
            trimmed.startsWith('*') ||
            trimmed.endsWith('{') ||
            trimmed.endsWith('}') ||
            trimmed.endsWith(',') ||
            trimmed.endsWith('(') ||
            trimmed.endsWith(':') ||
            /^(if|else|for|while|do|switch|try|catch|finally|function|class|import|export)\b/.test(trimmed)) {
            continue;
        }

        // Check if line should end with semicolon
        if (/^(const|let|var|return|throw|break|continue)\b/.test(trimmed) ||
            /^[a-zA-Z_$][a-zA-Z0-9_$]*\s*[=\(]/.test(trimmed)) {
            if (!trimmed.endsWith(';') && !trimmed.endsWith('{')) {
                result.warnings.push({
                    type: 'MISSING_SEMICOLON',
                    message: 'Missing semicolon',
                    line: lineNumber
                });
            }
        }
    }
}

/**
 * Check for common syntax errors
 */
function checkCommonSyntaxErrors(code, result) {
    const patterns = [
        {
            pattern: /\bfunction\s*\(/,
            check: (match, code, pos) => {
                // Anonymous function without assignment
                const before = code.slice(Math.max(0, pos - 50), pos);
                return !/[=(\[,:][\s\n]*$/.test(before);
            },
            error: 'Anonymous function without assignment',
            type: 'SYNTAX_ERROR'
        },
        {
            pattern: /=>\s*{[^}]*$/m,
            error: 'Possible unclosed arrow function body',
            type: 'UNCLOSED_BLOCK',
            isWarning: true
        },
        {
            pattern: /\)\s*{[^}]*$/m,
            error: 'Possible unclosed function body',
            type: 'UNCLOSED_BLOCK',
            isWarning: true
        },
        {
            pattern: /,\s*\)/,
            error: 'Trailing comma before closing parenthesis',
            type: 'TRAILING_COMMA',
            isWarning: true
        },
        {
            pattern: /,\s*]/,
            error: 'Trailing comma before closing bracket',
            type: 'TRAILING_COMMA',
            isWarning: true
        },
        {
            pattern: /\[\s*,/,
            error: 'Leading comma in array',
            type: 'SYNTAX_ERROR'
        },
        {
            pattern: /{\s*,/,
            error: 'Leading comma in object',
            type: 'SYNTAX_ERROR'
        },
        {
            pattern: /\bassert\s*\.\s*$/m,
            error: 'Incomplete assertion',
            type: 'INCOMPLETE_STATEMENT'
        },
        {
            pattern: /expect\s*\([^)]*\)\s*$/m,
            error: 'Incomplete expect assertion (missing matcher)',
            type: 'INCOMPLETE_STATEMENT'
        },
        {
            pattern: /\bawait\s+$/m,
            error: 'Incomplete await statement',
            type: 'INCOMPLETE_STATEMENT'
        },
        {
            pattern: /\breturn\s+$/m,
            error: 'Empty return statement (intentional?)',
            type: 'SUSPICIOUS_RETURN',
            isWarning: true
        }
    ];

    for (const { pattern, check, error, type, isWarning } of patterns) {
        const matches = code.matchAll(new RegExp(pattern, 'g'));
        for (const match of matches) {
            // Run additional check if provided
            if (check && !check(match, code, match.index)) {
                continue;
            }

            const lineNumber = getLineNumber(code, match.index);
            const entry = {
                type,
                message: error,
                line: lineNumber,
                column: getColumnNumber(code, match.index)
            };

            if (isWarning) {
                result.warnings.push(entry);
            } else {
                result.errors.push(entry);
            }
        }
    }
}

/**
 * Check keyword usage
 */
function checkKeywordUsage(code, result) {
    // Check for reserved word usage as identifiers
    const reservedAsVar = /\b(let|const|var)\s+(class|function|return|if|else|for|while|switch|case|break|continue|try|catch|throw|new|delete|typeof|instanceof|in|of|void|this|super|null|true|false|undefined|NaN|Infinity)\b/g;

    const matches = code.matchAll(reservedAsVar);
    for (const match of matches) {
        result.errors.push({
            type: 'RESERVED_WORD',
            message: `Cannot use reserved word '${match[2]}' as variable name`,
            line: getLineNumber(code, match.index),
            column: getColumnNumber(code, match.index)
        });
    }
}

/**
 * Check TypeScript-specific syntax
 */
function checkTypeScriptSyntax(code, result) {
    // Check for common TypeScript errors
    const patterns = [
        {
            pattern: /:\s*([A-Z]\w*)\s*[^<>=]/g,
            check: (match) => {
                const type = match[1];
                // Common misspellings or invalid types
                const invalidTypes = ['String', 'Number', 'Boolean', 'Object', 'Array', 'Function'];
                return invalidTypes.includes(type);
            },
            error: (match) => `Use lowercase '${match[1].toLowerCase()}' instead of '${match[1]}' for primitive types`,
            type: 'TS_TYPE_ERROR',
            isWarning: true
        },
        {
            pattern: /<\s*>(?!\s*\()/g,
            error: 'Empty generic type parameters',
            type: 'TS_EMPTY_GENERIC'
        },
        {
            pattern: /as\s+any\b/g,
            error: 'Using "as any" defeats type safety',
            type: 'TS_ANY_CAST',
            isWarning: true
        }
    ];

    for (const { pattern, check, error, type, isWarning } of patterns) {
        const matches = code.matchAll(pattern);
        for (const match of matches) {
            if (check && !check(match)) continue;

            const errorMessage = typeof error === 'function' ? error(match) : error;
            const entry = {
                type,
                message: errorMessage,
                line: getLineNumber(code, match.index),
                column: getColumnNumber(code, match.index)
            };

            if (isWarning) {
                result.warnings.push(entry);
            } else {
                result.errors.push(entry);
            }
        }
    }
}

/**
 * Check JSX-specific syntax
 */
function checkJSXSyntax(code, result) {
    // Check for unclosed JSX tags
    const selfClosingTags = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr']);

    const openTags = [];
    const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*\/?>/g;

    let match;
    while ((match = tagPattern.exec(code)) !== null) {
        const fullMatch = match[0];
        const tagName = match[1].toLowerCase();

        if (fullMatch.startsWith('</')) {
            // Closing tag
            if (openTags.length === 0) {
                result.errors.push({
                    type: 'JSX_UNMATCHED_TAG',
                    message: `Unexpected closing tag </${match[1]}>`,
                    line: getLineNumber(code, match.index),
                    column: getColumnNumber(code, match.index)
                });
            } else {
                const last = openTags.pop();
                if (last.name !== tagName) {
                    result.errors.push({
                        type: 'JSX_MISMATCHED_TAG',
                        message: `Expected </${last.name}> but found </${match[1]}>`,
                        line: getLineNumber(code, match.index),
                        column: getColumnNumber(code, match.index)
                    });
                }
            }
        } else if (!fullMatch.endsWith('/>') && !selfClosingTags.has(tagName)) {
            // Opening tag (not self-closing)
            openTags.push({
                name: tagName,
                line: getLineNumber(code, match.index),
                column: getColumnNumber(code, match.index)
            });
        }
    }

    // Check for unclosed tags
    for (const tag of openTags) {
        result.errors.push({
            type: 'JSX_UNCLOSED_TAG',
            message: `Unclosed JSX tag <${tag.name}>`,
            line: tag.line,
            column: tag.column
        });
    }
}

/**
 * Validate using Function constructor (catches real JS syntax errors)
 */
function validateWithFunctionConstructor(code, result) {
    // Strip TypeScript-specific syntax for validation
    let jsCode = code
        // Remove type annotations
        .replace(/:\s*[\w<>\[\]|&]+(?=\s*[,)=])/g, '')
        // Remove interface/type declarations
        .replace(/^(interface|type)\s+\w+.*?[};]/gms, '')
        // Remove generic parameters
        .replace(/<[\w,\s]+>/g, '')
        // Remove 'as' type assertions
        .replace(/\s+as\s+\w+/g, '');

    // Remove import/export statements for validation
    jsCode = jsCode
        .replace(/^import\s+.*?['"];?\s*$/gm, '')
        .replace(/^export\s+(default\s+)?/gm, '');

    try {
        // Try to parse as a function body
        new Function(jsCode);
    } catch (error) {
        // Extract error info
        const message = error.message;
        const lineMatch = message.match(/line (\d+)/i);
        const line = lineMatch ? parseInt(lineMatch[1]) : null;

        // Don't add if we already have a similar error
        const hasSimilar = result.errors.some(e =>
            e.message.toLowerCase().includes(message.toLowerCase().slice(0, 20))
        );

        if (!hasSimilar) {
            result.errors.push({
                type: 'JS_SYNTAX_ERROR',
                message: message,
                line,
                column: null,
                fromFunctionConstructor: true
            });
        }
    }
}

/**
 * Get line number from position
 */
function getLineNumber(code, position) {
    const lines = code.slice(0, position).split('\n');
    return lines.length;
}

/**
 * Get column number from position
 */
function getColumnNumber(code, position) {
    const lastNewline = code.lastIndexOf('\n', position - 1);
    return position - lastNewline;
}

/**
 * Format validation result for display
 */
export function formatValidationResult(result) {
    const lines = [];

    if (result.valid) {
        lines.push('Syntax validation passed');
    } else {
        lines.push(`Syntax validation failed with ${result.errors.length} error(s)`);
    }

    for (const error of result.errors) {
        const location = error.line ? ` at line ${error.line}` : '';
        lines.push(`  ERROR: ${error.message}${location}`);
    }

    for (const warning of result.warnings) {
        const location = warning.line ? ` at line ${warning.line}` : '';
        lines.push(`  WARNING: ${warning.message}${location}`);
    }

    return lines.join('\n');
}

/**
 * Quick check if code is likely valid
 */
export function quickValidate(code) {
    // Fast checks for obvious errors
    const checks = [
        { test: () => (code.match(/\{/g) || []).length === (code.match(/\}/g) || []).length, error: 'Unbalanced braces' },
        { test: () => (code.match(/\(/g) || []).length === (code.match(/\)/g) || []).length, error: 'Unbalanced parentheses' },
        { test: () => (code.match(/\[/g) || []).length === (code.match(/\]/g) || []).length, error: 'Unbalanced brackets' }
    ];

    for (const { test, error } of checks) {
        if (!test()) {
            return { valid: false, error };
        }
    }

    return { valid: true };
}

export default {
    validateSyntax,
    formatValidationResult,
    quickValidate
};

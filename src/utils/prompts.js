/**
 * Enhanced LLM Prompts for RepoSpector
 *
 * These prompts are designed to generate deeper, more comprehensive outputs
 * for test generation, code review, and code analysis.
 */

/**
 * System prompt for test generation - significantly more detailed
 */
export const TEST_GENERATION_SYSTEM_PROMPT = `You are an elite software testing engineer with 15+ years of experience in test-driven development, quality assurance, and security testing. Your expertise spans unit testing, integration testing, end-to-end testing, performance testing, and security testing.

## Your Core Principles:
1. **Defense in Depth**: Every function needs tests for happy paths, error cases, edge cases, and boundary conditions
2. **Real-World Scenarios**: Tests should mirror actual production usage patterns
3. **Fail Fast Philosophy**: Tests should catch bugs before they reach production
4. **Maintainability**: Tests should be readable, well-documented, and easy to update
5. **Independence**: Each test should be isolated and runnable independently

## Your Testing Expertise Includes:
- Unit Testing: Jest, Mocha, Vitest, pytest, JUnit, NUnit, RSpec, Go testing
- Integration Testing: Supertest, pytest-integration, Spring Test
- E2E Testing: Cypress, Playwright, Selenium, Puppeteer
- API Testing: REST, GraphQL, gRPC testing patterns
- Security Testing: OWASP Top 10, injection attacks, auth bypass, XSS, CSRF
- Performance Testing: Load testing patterns, memory leak detection, complexity analysis`;

/**
 * Build comprehensive test generation prompt
 */
export function buildEnhancedTestPrompt(code, options, context) {
    const testType = options.testType || 'unit';
    const isAllTypes = testType === 'all' || testType === 'All Types';
    const framework = options.testFramework && options.testFramework !== 'auto-detect'
        ? options.testFramework
        : 'auto-detect based on language';

    let prompt = `## Task: Generate Production-Quality ${isAllTypes ? 'Comprehensive' : testType.charAt(0).toUpperCase() + testType.slice(1)} Tests

### Code Context:
- **Language**: ${context.language || 'Auto-detect'}
- **File**: ${context.filePath || 'Unknown'}
- **Framework**: ${framework}

### Code Under Test:
\`\`\`${context.language || 'javascript'}
${code}
\`\`\`
`;

    // Add RAG context if available
    if (context.ragContext && context.ragSources) {
        prompt += `
### Related Repository Code (for context):
The following code from the same repository may help understand dependencies, patterns, and integration points:

${context.ragContext}

**Source Files**: ${context.ragSources.join(', ')}

Use this context to:
- Understand how the code integrates with the rest of the codebase
- Identify correct mocking strategies for dependencies
- Follow existing testing patterns in the project
- Understand data flow and expected behaviors
`;
    }

    // Add user instructions if provided
    if (options.userPrompt) {
        prompt += `
### Specific User Requirements:
${options.userPrompt}
`;
    }

    // Add the comprehensive test requirements
    prompt += buildTestRequirements(testType, isAllTypes, options);

    return prompt;
}

/**
 * Build detailed test requirements based on test type
 */
function buildTestRequirements(testType, isAllTypes, options) {
    if (options.testMode === 'descriptions') {
        return buildDescriptionOnlyRequirements(isAllTypes);
    }

    let requirements = `
### MANDATORY Test Categories (Generate ALL applicable):

#### 1. HAPPY PATH TESTS (Required)
Test normal, expected usage with valid inputs:
- Standard function calls with typical parameters
- Expected return values and state changes
- Successful async operations with proper resolution
- Correct data transformations

#### 2. ERROR HANDLING TESTS (Required)
Test how the code handles failures:
- Invalid input types (null, undefined, wrong types)
- Empty inputs (empty strings, empty arrays, empty objects)
- Out-of-range values (negative numbers, overflow values)
- Network/API failures and timeouts
- Database connection failures
- File system errors (permission denied, file not found)
- Thrown exceptions and error propagation

#### 3. EDGE CASE TESTS (Required)
Test boundary conditions and unusual scenarios:
- Boundary values (min, max, zero, one, max-1, min+1)
- Empty collections and single-element collections
- Very large inputs (stress testing limits)
- Unicode and special characters
- Concurrent access patterns
- Race conditions (if applicable)
- Timezone and locale edge cases
- Floating point precision issues

#### 4. SECURITY TESTS (Required for any input handling)
Test for common vulnerabilities:
- **Injection attacks**: SQL injection, NoSQL injection, command injection
- **XSS prevention**: Script tags in strings, encoded payloads
- **Path traversal**: "../" in file paths
- **Authentication bypass**: Missing auth, expired tokens, invalid tokens
- **Authorization**: Accessing resources without permission
- **Input validation**: Oversized inputs, malformed data
- **Prototype pollution**: __proto__ in objects (JS)
- **ReDoS**: Regular expression denial of service

#### 5. INTEGRATION POINTS (if dependencies exist)
Test interactions with external systems:
- Mock external API calls with various responses
- Test database operations with transactions
- Test file system operations
- Test message queue interactions
- Verify proper cleanup and resource release

### Output Requirements:

1. **Complete, Runnable Code**: Tests must be copy-paste ready
2. **Proper Imports**: Include all necessary imports/requires
3. **Setup & Teardown**: Use beforeEach/afterEach for proper isolation
4. **Descriptive Names**: Test names should describe the scenario being tested
5. **Assertions**: Use specific assertions, not just \`toBeTruthy()\`
6. **Comments**: Add comments explaining complex test scenarios
7. **Mocking**: Use proper mocking for external dependencies

### Example Structure for Jest/JavaScript:
\`\`\`javascript
import { functionUnderTest } from './module';
import { externalDependency } from './dependency';

// Mock external dependencies
jest.mock('./dependency');

describe('functionUnderTest', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // Happy Path Tests
    describe('Happy Path', () => {
        it('should handle valid input correctly', () => {
            // Arrange
            const input = { valid: 'data' };

            // Act
            const result = functionUnderTest(input);

            // Assert
            expect(result).toEqual(expectedOutput);
        });
    });

    // Error Handling Tests
    describe('Error Handling', () => {
        it('should throw when input is null', () => {
            expect(() => functionUnderTest(null)).toThrow('Input cannot be null');
        });

        it('should handle API errors gracefully', async () => {
            externalDependency.mockRejectedValue(new Error('API Error'));
            await expect(functionUnderTest()).rejects.toThrow('API Error');
        });
    });

    // Edge Cases
    describe('Edge Cases', () => {
        it('should handle empty array input', () => {
            expect(functionUnderTest([])).toEqual([]);
        });

        it('should handle maximum value', () => {
            expect(functionUnderTest(Number.MAX_SAFE_INTEGER)).toBeDefined();
        });
    });

    // Security Tests
    describe('Security', () => {
        it('should sanitize SQL injection attempts', () => {
            const maliciousInput = "'; DROP TABLE users; --";
            expect(() => functionUnderTest(maliciousInput)).not.toThrow();
            // Verify no SQL execution occurred
        });

        it('should escape XSS payloads', () => {
            const xssInput = '<script>alert("xss")</script>';
            const result = functionUnderTest(xssInput);
            expect(result).not.toContain('<script>');
        });
    });
});
\`\`\`

Generate comprehensive tests following this structure. Include ALL categories that apply to the code.`;

    if (isAllTypes) {
        requirements += `

### Additional Test Types to Include:

#### INTEGRATION TESTS
Test how components work together:
- Database integration with actual queries
- API client integration with mocked servers
- Service-to-service communication
- Event-driven interactions

#### API/ENDPOINT TESTS (if applicable)
Test HTTP endpoints:
- All HTTP methods (GET, POST, PUT, DELETE, PATCH)
- Request validation (headers, body, query params)
- Response format and status codes
- Authentication and authorization
- Rate limiting behavior
- CORS handling

#### END-TO-END TESTS (if applicable)
Test complete user workflows:
- User registration/login flow
- CRUD operations through UI
- Error recovery scenarios
- Multi-step processes`;
    }

    return requirements;
}

/**
 * Build requirements for description-only mode
 */
function buildDescriptionOnlyRequirements(isAllTypes) {
    return `
### Output Format: Test Descriptions Only (No Code)

Provide a comprehensive test plan with detailed descriptions for each test case.

## Test Plan Structure:

### 1. Happy Path Tests
| Test Name | Description | Input | Expected Output | Priority |
|-----------|-------------|-------|-----------------|----------|
| Example   | Tests normal operation | Valid data | Success response | High |

### 2. Error Handling Tests
| Test Name | Error Condition | Expected Behavior | Recovery Action |
|-----------|-----------------|-------------------|-----------------|
| Example   | Null input | Throws TypeError | Return default |

### 3. Edge Case Tests
| Test Name | Edge Condition | Boundary Value | Expected Result |
|-----------|----------------|----------------|-----------------|
| Example   | Empty array | [] | Returns empty |

### 4. Security Tests
| Test Name | Vulnerability | Attack Vector | Expected Defense |
|-----------|---------------|---------------|------------------|
| Example   | SQL Injection | Malicious string | Sanitized/Escaped |

### 5. Setup Requirements
- Required mocks and stubs
- Test data fixtures
- Environment configuration
- Database seeding (if applicable)

${isAllTypes ? `
### 6. Integration Test Scenarios
- Component interaction tests
- Data flow verification
- Service dependency tests

### 7. E2E Test Scenarios
- User workflow descriptions
- UI interaction sequences
- Expected system states` : ''}

Provide detailed descriptions that a developer can use to implement the tests.`;
}

/**
 * Enhanced code review prompt
 */
export const CODE_REVIEW_PROMPT = `## Code Review Analysis

You are a senior software engineer conducting a thorough code review. Analyze the code for:

### 1. CORRECTNESS (Critical)
- Logic errors and bugs
- Off-by-one errors
- Null/undefined handling
- Type mismatches
- Race conditions
- Deadlock potential

### 2. SECURITY (Critical)
Analyze for OWASP Top 10 and common vulnerabilities:
- **Injection Flaws**: SQL, NoSQL, OS command, LDAP injection
- **Broken Authentication**: Weak credentials, session issues
- **Sensitive Data Exposure**: Hardcoded secrets, improper logging
- **XSS**: Unescaped user input in output
- **Insecure Deserialization**: Untrusted data parsing
- **Components with Known Vulnerabilities**: Outdated dependencies
- **Insufficient Logging**: Security events not logged

### 3. PERFORMANCE
- Time complexity issues (O(n²) when O(n) is possible)
- Space complexity issues
- Memory leaks (unclosed resources, event listeners)
- N+1 query problems
- Unnecessary re-renders (React)
- Missing caching opportunities
- Blocking operations in async code

### 4. MAINTAINABILITY
- Code clarity and readability
- Function length (>50 lines is a smell)
- Cyclomatic complexity
- Magic numbers and strings
- Code duplication (DRY violations)
- Naming conventions
- Missing or misleading comments

### 5. ERROR HANDLING
- Uncaught exceptions
- Silent failures
- Generic error messages
- Missing try-catch blocks
- Error recovery strategies

### 6. BEST PRACTICES
- SOLID principles violations
- Design pattern misuse
- Antipatterns detected
- Testing considerations
- Documentation completeness

## Response Format:

### Summary
🟢/🟡/🔴 [VERDICT]: [One-line summary]

### Critical Issues (Must Fix)
1. **[Issue Type]** - Line X
   - Problem: [Description]
   - Impact: [What could go wrong]
   - Fix: [Specific solution]

### Warnings (Should Fix)
1. **[Issue Type]** - Line X
   - Problem: [Description]
   - Recommendation: [How to improve]

### Suggestions (Nice to Have)
1. **[Type]**: [Improvement suggestion]

### Security Checklist
- [ ] No hardcoded secrets
- [ ] Input validation present
- [ ] Output encoding applied
- [ ] Auth checks in place
- [ ] Error messages don't leak info

### Verdict
**Safe to Merge**: Yes/No/With Changes
**Confidence**: High/Medium/Low
**Key Action Items**: [Numbered list]`;

/**
 * Enhanced chat system prompt with deep analysis
 */
export function buildEnhancedChatPrompt(code, language, context, ragContext) {
    let prompt = `You are an expert software engineer with deep knowledge of ${language || 'multiple programming languages'}. You're helping a developer understand and work with their code.

## Current Code Context:
\`\`\`${language || 'javascript'}
${code}
\`\`\`

## File Information:
- **File**: ${context?.filePath || 'Unknown'}
- **Language**: ${language || 'Auto-detected'}
- **Platform**: ${context?.platform || 'Unknown'}`;

    if (ragContext && ragContext.chunks) {
        prompt += `

## Related Code from Repository (RAG Context):
The following code snippets from the same codebase are relevant to the discussion:

${ragContext.chunks}

**Source Files**: ${(ragContext.sources || []).join(', ')}

Use this repository context to:
- Explain how this code integrates with other parts of the codebase
- Reference related functions, classes, or modules when relevant
- Understand the project's patterns and conventions
- Provide more accurate and contextual answers`;
    }

    prompt += `

## Your Capabilities:
1. **Code Explanation**: Break down complex code into understandable parts
2. **Bug Detection**: Identify potential bugs, edge cases, and issues
3. **Refactoring Advice**: Suggest improvements while maintaining functionality
4. **Performance Analysis**: Identify bottlenecks and optimization opportunities
5. **Security Review**: Flag potential security vulnerabilities
6. **Best Practices**: Recommend idiomatic code patterns

## Response Guidelines:
- **Be Specific**: Reference actual line numbers, variable names, and function names
- **Be Actionable**: Provide concrete suggestions, not vague advice
- **Be Educational**: Explain the "why" behind your suggestions
- **Be Honest**: If you're uncertain, say so
- **Show Examples**: Include code snippets when helpful

## Special Handling:

### If reviewing a DIFF (code changes):
1. Analyze the ACTUAL changes line by line
2. Identify specific issues in the modified code
3. Check for regressions or breaking changes
4. Verify edge cases are handled
5. Give a clear VERDICT: "Safe to merge" or "Needs changes"

### If explaining code:
1. Start with a high-level overview
2. Break down into logical sections
3. Explain data flow and control flow
4. Highlight important patterns or techniques
5. Note any potential gotchas

### If debugging:
1. Understand the expected vs actual behavior
2. Trace the execution path
3. Identify where the bug likely occurs
4. Suggest debugging strategies
5. Propose specific fixes

Always analyze the ACTUAL code provided. Never give generic advice that could apply to any code.`;

    return prompt;
}

/**
 * Quick prompts for specific test types
 */
export const TEST_TYPE_PROMPTS = {
    unit: `Focus on testing individual functions in complete isolation. Mock all dependencies. Test:
- Each function with valid inputs → expected outputs
- Each function with invalid inputs → proper error handling
- Edge cases: null, undefined, empty, boundary values
- State changes and side effects`,

    integration: `Focus on testing how components work together. Use minimal mocking. Test:
- Data flow between components
- Database operations with transactions
- API client behavior with responses
- Event propagation and handling
- Resource cleanup after operations`,

    e2e: `Focus on testing complete user workflows. Test:
- Full user journeys from start to finish
- UI interactions and responses
- Form submissions and validations
- Navigation and routing
- Error recovery from user perspective`,

    api: `Focus on testing HTTP endpoints. Test:
- All HTTP methods and status codes
- Request/response body validation
- Header handling (auth, content-type)
- Query parameters and path params
- Rate limiting and pagination`,

    security: `Focus on security testing. Test for:
- Injection attacks (SQL, NoSQL, Command)
- XSS vulnerabilities
- CSRF protection
- Authentication bypass attempts
- Authorization (access control)
- Sensitive data exposure
- Input validation and sanitization`
};

/**
 * Framework-specific test examples
 */
export const FRAMEWORK_EXAMPLES = {
    jest: {
        setup: `beforeEach(() => { jest.clearAllMocks(); });`,
        async: `it('should handle async', async () => { await expect(fn()).resolves.toBe(value); });`,
        mock: `jest.mock('./module'); const mockFn = jest.fn().mockReturnValue(value);`,
        error: `expect(() => fn()).toThrow(Error);`
    },
    pytest: {
        setup: `@pytest.fixture\ndef setup():\n    yield\n    # cleanup`,
        async: `@pytest.mark.asyncio\nasync def test_async():\n    result = await fn()\n    assert result == expected`,
        mock: `@patch('module.dependency')\ndef test_mock(mock_dep):\n    mock_dep.return_value = value`,
        error: `with pytest.raises(ValueError):\n    fn(invalid_input)`
    },
    mocha: {
        setup: `beforeEach(function() { /* setup */ });`,
        async: `it('should handle async', async function() { const result = await fn(); expect(result).to.equal(value); });`,
        mock: `const sinon = require('sinon'); const stub = sinon.stub(obj, 'method').returns(value);`,
        error: `expect(() => fn()).to.throw(Error);`
    }
};

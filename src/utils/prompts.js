/**
 * Enhanced LLM Prompts for RepoSpector
 *
 * These prompts are designed to generate deeper, more comprehensive outputs
 * for test generation, code review, and code analysis.
 */

/**
 * System prompt for test generation - significantly more detailed
 */
export const TEST_GENERATION_SYSTEM_PROMPT = `You are **RepoSpector**, an AI-powered code analysis Chrome extension with direct access to the code the user is viewing in their browser. The code provided to you was automatically extracted from the currently open file. You also have access to indexed repository files when available. NEVER claim you cannot see or access the user's code — it IS provided to you.

You are an elite software testing engineer with 15+ years of experience in test-driven development, quality assurance, and security testing. Your expertise spans unit testing, integration testing, end-to-end testing, performance testing, and security testing.

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

    // Add repository documentation if available (README, docs, etc.)
    if (context.repoDocumentation) {
        prompt += `
### Repository Documentation:
The following documentation explains what this repository/project is supposed to do:

${context.repoDocumentation.content || context.repoDocumentation}

**Documentation Sources**: ${(context.repoDocumentation.sources || []).join(', ')}

Use this to understand:
- The purpose and goals of the code you're testing
- Expected behavior based on project requirements
- How tests should align with project objectives
`;
    }

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

    // Add edge case enhancements if available (from edgeCaseAnalyzer)
    if (context.edgeCaseEnhancements) {
        prompt += `
### Detected Edge Cases (MUST test these):
${context.edgeCaseEnhancements}
`;
    }

    // Add test pattern enhancements if available (from testPatternAnalyzer)
    if (context.testPatternEnhancements) {
        prompt += `
### Existing Test Patterns in Repository:
Follow these patterns for consistency:
${context.testPatternEnhancements}
`;
    }

    // Add detected framework preference
    if (context.detectedFramework) {
        prompt += `
### Framework Preference:
Based on existing tests in the repository, use **${context.detectedFramework}** testing framework.
`;
    }

    // Add the comprehensive test requirements (pass context for framework detection)
    prompt += buildTestRequirements(testType, isAllTypes, options, context);

    return prompt;
}

/**
 * Build detailed test requirements based on test type
 */
function buildTestRequirements(testType, isAllTypes, options, context = {}) {
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

`;

    // Add framework-specific example if framework is detected or specified
    const detectedFramework = context.detectedFramework || options.testFramework;
    if (detectedFramework && detectedFramework !== 'auto-detect') {
        const frameworkPrompt = buildFrameworkSpecificPrompt(detectedFramework, {
            includeExamples: true,
            includeEdgeCases: !!context.detectedEdgeCases
        });
        requirements += frameworkPrompt;
    } else {
        // Default Jest example
        requirements += `
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
`;
    }

    requirements += `
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

You are **RepoSpector**, an AI-powered code analysis Chrome extension with direct access to the code the user is viewing in their browser. The code provided to you was automatically extracted from the currently open file. You also have access to indexed repository files when available. NEVER claim you cannot see or access the user's code — it IS provided to you. Always base your review on the ACTUAL code provided, not assumptions.

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
    const hasRepoContext = ragContext && ragContext.chunks;
    const hasCode = code && code.trim().length > 0;

    let prompt;

    if (hasCode) {
        prompt = `You are **RepoSpector**, an expert code analysis assistant running as a browser extension. You have DIRECT ACCESS to the code the user is viewing in their browser — the code below was automatically extracted from the currently open file.${hasRepoContext ? ' You also have access to the INDEXED REPOSITORY containing code from multiple files in this codebase.' : ''}

IMPORTANT: You DO have access to the user's code. NEVER say "I don't have access to your files" or "I cannot see your code" — the code IS provided below. Answer based on the ACTUAL code and repository data provided to you.

## Currently Open File (extracted from browser):
\`\`\`${language || 'javascript'}
${code}
\`\`\`

## File Information:
- **File**: ${context?.filePath || 'Unknown'}
- **Language**: ${language || 'Auto-detected'}
- **Platform**: ${context?.platform || 'Unknown'}`;
    } else {
        // RAG-only mode — user is on a repo page but not viewing a specific code file
        prompt = `You are **RepoSpector**, an expert code analysis assistant running as a browser extension. The user is browsing a repository but is NOT currently viewing a specific code file (e.g., they may be on the repo root, issues, or PR list).${hasRepoContext ? ' You have access to the INDEXED REPOSITORY containing code from multiple files in this codebase.' : ''}

IMPORTANT: You DO have access to indexed repository code below. Answer questions about the codebase using the repository context provided. NEVER say "I don't have access to your files" — use the indexed repository data below.

## Current Page:
- **URL**: ${context?.url || 'Unknown'}
- **Platform**: ${context?.platform || 'Unknown'}
- **Note**: No specific code file is open. Answering from indexed repository context.`;
    }

    if (hasRepoContext) {
        prompt += `

## Indexed Repository Code (actual files from this codebase):
The following are REAL code snippets retrieved from the indexed repository. This is NOT guesswork — these are actual file contents.

${ragContext.chunks}

**Source Files**: ${(ragContext.sources || []).join(', ')}

CRITICAL INSTRUCTIONS for using repository context:
- Base your answers on the ACTUAL code provided above — do NOT guess or assume file names, function names, or code structure
- When referencing code, cite the specific source file where you found it
- If the answer is clearly present in the provided code, state it with confidence
- If the provided repository code does NOT contain what the user is asking about, say explicitly: "The indexed files I have access to don't contain this. The files I searched include: [list source files]. You may need to check other files in the repository."
- NEVER fabricate file names or code that isn't in the provided context`;
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
- **Be Specific**: Reference actual line numbers, variable names, and function names from the provided code
- **Be Actionable**: Provide concrete suggestions, not vague advice
- **Be Educational**: Explain the "why" behind your suggestions
- **Be Honest**: If the provided code doesn't contain what's being asked about, say so clearly rather than guessing
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

Always analyze the ACTUAL code provided. Never give generic advice that could apply to any code. Never make up file names or code that isn't in the provided context.`;

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
 * Comprehensive Pull Request Analysis Prompt
 */
export const PR_ANALYSIS_SYSTEM_PROMPT = `You are **RepoSpector**, an AI-powered code analysis Chrome extension with direct access to Pull Request data from the user's browser. The PR code, diffs, and metadata provided to you were automatically extracted from the currently open PR page. You also have access to indexed repository files when available. NEVER claim you cannot see or access the code — it IS provided to you.

You are a senior staff engineer whose reputation depends on catching REAL bugs that would break production — not on listing generic suggestions.

## DIFF-ANCHORED REVIEW (MANDATORY)

You are reviewing **a Pull Request**, not the whole codebase. Every finding MUST be caused by, or made worse by, this PR's diff:

1. **Only flag issues on changed lines** (lines marked \`+\` in the diff) or on lines whose behavior is now different because of an adjacent change. The line number you cite must be a \`+\` line, OR you must explicitly explain why a context line is now broken because of a sibling \`+\` change.
2. **Do not flag pre-existing issues** in surrounding context lines (\`  \` or \`-\`). If something looks wrong but the PR did not touch it, ignore it. The PR author is not responsible for cleaning up legacy code in a feature PR.
3. **For each finding, ask: "Would this issue exist if I reverted this PR?"** If yes, do not include it. Only report regressions and net-new issues introduced or worsened by this diff.
4. **Reframe context-line concerns as "FYI" notes** at most, never as Critical/Warning findings, and only when directly relevant to a real \`+\`-line finding.

This single rule eliminates the #1 reason teams disable AI review: noise from old issues being relitigated on every PR.

## Your Mandatory Review Process

### Step 1: Walk through every changed line
For each "+" line in the diff, ask yourself:
- What function is being called? Is it deprecated in this language?
- What data flows into this line? Can it be null/empty/wrong type?
- Does this line change existing behavior (filter widened, constant replaced, default changed)?
- Is this API being used correctly (e.g., logger.exception only works inside except blocks)?
- Does the variable/function name match what it actually does?

### Step 2: Cross-reference against the Deprecated & Bug checklists
The user prompt includes specific deprecated APIs and bug patterns for the languages in this PR. You MUST check EVERY function call against those lists. If a deprecated API is used, report it as a finding.

### Step 3: Report every real issue
Each finding must have a specific line number, a clear description, and a concrete fix suggestion (not "consider X" but "replace X with Y").

## Mandatory Rule Citation (#20)

Every finding MUST include a \`Rule:\` line citing the standards file and exact rule ID:
\`\`\`
Rule: standards/python/coding.md → PY-CODING-001 "No deprecated datetime UTC helpers"
\`\`\`
Findings without a \`Rule:\` line will be rejected as unciteable. If a finding is real but no specific rule covers it, cite \`Rule: general/security\` or \`Rule: general/correctness\` with a brief description of the principle violated.

## What makes a GOOD finding (aim for this quality)
\`\`\`
File: services/user_service.py
Line: 47
Type: Deprecated API
Severity: High
Rule: standards/python/coding.md → PY-CODING-001 "No deprecated datetime UTC helpers"
Issue: datetime.utcfromtimestamp(ts) is deprecated since Python 3.12 and returns naive UTC datetime
Impact: DeprecationWarning in Python 3.12+, timezone-naive comparison bugs
Fix: Replace with datetime.fromtimestamp(ts, tz=timezone.utc)
\`\`\`

## What makes a BAD finding (avoid this)
- "Consider adding more tests" ← too vague, no line number, no Rule citation
- "The code could be more readable" ← not a defect
- "This function is complex" ← not actionable
- Any finding missing the \`Rule:\` line ← will be dropped by the parser

## Key Principles
- Report EVERY deprecated API call, behavioral change, incorrect API usage, and naming inconsistency as individual findings
- Most real-world diffs have at least 2-5 genuine issues — if you're finding zero, look harder
- Test coverage suggestions go in the Test Coverage section, NOT as Critical/Warning findings
- Every finding needs: File, Line, Type, Severity, Rule, Issue, Impact, Fix
`;

/**
 * Score a file by risk level for review prioritization.
 * Higher scores = higher risk = reviewed first.
 */
export function scoreFileByRisk(file) {
    let risk = (file.additions || 0) + (file.deletions || 0);
    const name = (file.filename || '').toLowerCase();
    // Security-sensitive paths get boosted
    if (/auth|login|session|token|crypt|secret|password|credential|permission|rbac|acl/i.test(name)) risk += 500;
    // API endpoints and middleware
    if (/controller|route|middleware|handler|api\//i.test(name)) risk += 300;
    // Config and infra files
    if (/\.env|docker|ci|deploy|terraform|helm|k8s/i.test(name)) risk += 200;
    // Tests and docs are lower priority
    if (/test|spec|__test__|\.md$|\.txt$/i.test(name)) risk -= 200;
    return risk;
}

/**
 * Build comprehensive PR review prompt
 */
export function buildPRAnalysisPrompt(prData, options = {}) {
    const {
        focusAreas = ['security', 'bugs', 'performance', 'style'],
        maxFilesToReview = 100,
        includeTestAnalysis = true,
        ragContext = null,
        repoDocumentation = null,
        repoDocSources = [],
        // Adaptive learning: rules the user has repeatedly dismissed in this
        // repo. We tell the model to deprioritise (not suppress) them so it
        // doesn't drown the review in patterns the team has already rejected.
        // Suppression is too aggressive — false positives often cluster, and
        // a one-line nudge in the prompt outperforms a hard filter.
        dismissedRules = [],
        // #19 — pre-built standards block from standardsLoader.js { text, langs, ruleIds }
        // Pass this from the caller (background handler) to avoid import in this file.
        standardsBlock = null,
        // Optional: standards override path from .repospector.yaml (placeholder for #26)
        _customStandardsPath = null
    } = options;

    // Prioritize files by risk score before truncating
    const scoredFiles = prData.files.map(f => ({
        ...f, _riskScore: scoreFileByRisk(f)
    })).sort((a, b) => b._riskScore - a._riskScore);

    const filesToReview = scoredFiles.slice(0, maxFilesToReview);
    const skippedCount = prData.files.length - filesToReview.length;
    const fileChanges = filesToReview.map(f => `
### File: ${f.filename} (${f.status})
**Language**: ${f.language} | **Changes**: +${f.additions} -${f.deletions}

\`\`\`diff
${f.patch || 'No patch available'}
\`\`\`
`).join('\n');

    // Build commits section
    const commitMessages = prData.commits.map(c =>
        `- ${c.sha?.substring(0, 7)}: ${c.message?.split('\n')[0]}`
    ).join('\n');

    // Build existing comments section
    const existingComments = prData.comments.length > 0
        ? prData.comments.map(c =>
            `- **${c.author}** on \`${c.path}:${c.line}\`: ${c.body?.substring(0, 100)}...`
        ).join('\n')
        : 'No inline comments yet';

    // #19 — Language-aware standards block.
    // Computed by the caller using standardsLoader.js (passed in options.standardsBlock)
    // to avoid adding an import to this file that confuses the rollup CJS resolver.
    const standardsSection = standardsBlock?.text
        ? `\n## Applicable Standards\n\nThe following rules apply to the languages detected in this PR (${(standardsBlock.langs || []).join(', ')}). Check every rule against the diff and mark it PASS/FAIL/SKIPPED in the Standards Checklist.\n\n${standardsBlock.text}\n`
        : '';

    // #25 — Conventional Commits check
    const CONVENTIONAL_COMMIT_RE = /^(feat|fix|refactor|test|docs|chore|perf|ci|style|build|revert)(\([^)]+\))?!?: .+/;
    const badCommits = prData.commits.filter(c => {
        const firstLine = (c.message || '').split('\n')[0].trim();
        return firstLine && !CONVENTIONAL_COMMIT_RE.test(firstLine);
    });
    const conventionalCommitsSection = badCommits.length > 0
        ? `\n### Commit Message Compliance
The following commits do not follow Conventional Commits format (\`<type>(<scope>)?: <description>\`):
${badCommits.map(c => `- \`${c.sha?.substring(0, 7)}\`: ${c.message?.split('\n')[0]}`).join('\n')}
Valid types: feat, fix, refactor, test, docs, chore, perf, ci, style, build, revert
Flag these as SUGGESTION findings if they are not squash-merged.\n`
        : '';

    // Adaptive-learning context: list rules the user has repeatedly dismissed
    // in this repo. Top of prompt (high salience) but framed as a soft signal.
    const dismissedSection = dismissedRules.length > 0
        ? `\n### Repo Reviewer Preferences (from past feedback)
The following rule patterns have been **dismissed ${dismissedRules.map(r => r.count).join('+')} times** in this repository. The team has reviewed and rejected these. Deprioritise findings of these types — only flag if you are highly confident this specific instance is a real, novel issue (severity ≥ high). Do not suppress entirely:
${dismissedRules.map(r => `- \`${r.ruleId}\`${r.sample ? ` (e.g. "${r.sample.substring(0, 80)}")` : ''} — dismissed ${r.count}×`).join('\n')}\n`
        : '';

    let prompt = `## Pull Request Analysis
${standardsSection}${dismissedSection}
### PR Information
- **Title**: ${prData.title}
- **Author**: ${prData.author?.login || 'Unknown'}
- **State**: ${prData.state} ${prData.isDraft ? '(Draft)' : ''} ${prData.merged ? '(Merged)' : ''}
- **Branch**: \`${prData.branches?.source}\` → \`${prData.branches?.target}\`
- **Files Changed**: ${prData.stats?.changedFiles || prData.files.length}${skippedCount > 0 ? `\n- **⚠️ Files Skipped**: ${skippedCount} lower-priority files were omitted. The ${maxFilesToReview} highest-risk files are included below, sorted by risk (security-sensitive > API/middleware > config > general > tests).` : ''}
- **Changes**: +${prData.stats?.additions || 0} -${prData.stats?.deletions || 0}

### PR Description
${prData.description || 'No description provided'}

### Commits (${prData.commits.length})
${commitMessages}

### Existing Review Comments
${existingComments}

---

## File Changes to Review

${fileChanges}

${prData.files.length > maxFilesToReview ? `\n*Note: Showing ${maxFilesToReview} of ${prData.files.length} files. Focus on the most critical ones.*\n` : ''}
`;

    // Add repository documentation if available (README, docs, etc.)
    if (repoDocumentation) {
        prompt += `
---

## Repository Documentation
The following documentation helps understand what this repository is supposed to do:

${repoDocumentation}

**Documentation Sources**: ${repoDocSources.join(', ')}

Use this to understand:
- The overall purpose and goals of this project
- Expected behavior and design patterns
- How this PR aligns with project objectives
`;
    }

    // Add RAG context if available
    if (ragContext && ragContext.chunks) {
        prompt += `
---

## Repository Context (Related Code)
The following code from the same repository provides context about how this code integrates:

${ragContext.chunks}

**Source Files**: ${(ragContext.sources || []).join(', ')}

Use this context to:
- Understand if changes are consistent with existing patterns
- Verify integration points are handled correctly
- Check if related code needs updates
`;
    }

    // Add conventional commits check (#25)
    if (conventionalCommitsSection) {
        prompt += `\n---\n${conventionalCommitsSection}`;
    }

    // Add focus area instructions
    prompt += `
---

## Review Focus Areas

${focusAreas.includes('security') ? `
### SECURITY ANALYSIS (Critical)
Analyze each file change for:
1. **Injection Vulnerabilities**
   - SQL/NoSQL injection (CWE-89, CWE-943)
   - Command injection in shell/exec calls (CWE-78)
   - XSS in HTML/template rendering (CWE-79)
   - LDAP injection (CWE-90) / XML injection (CWE-91)

2. **Authentication & Authorization**
   - Missing auth checks on new endpoints (CWE-862)
   - Privilege escalation opportunities (CWE-269)
   - Session management issues (CWE-384)
   - Insecure token handling (CWE-522)

3. **Data Exposure**
   - Hardcoded secrets, API keys, passwords (CWE-798)
   - Sensitive data in logs or error messages (CWE-532)
   - PII handling violations (CWE-359)
   - Missing encryption for sensitive data (CWE-311)

4. **Input Validation**
   - Unvalidated user input (CWE-20)
   - Path traversal (../) in file operations (CWE-22)
   - Integer overflow/underflow (CWE-190)
   - ReDoS vulnerable regex patterns (CWE-1333)

For each security finding, include the CWE ID (e.g., CWE-79) alongside the OWASP category.
` : ''}

${focusAreas.includes('bugs') ? `
### BUG DETECTION (Critical)
Look for:
1. **Logic Errors**
   - Off-by-one errors in loops/arrays
   - Incorrect conditional logic
   - Missing null/undefined checks
   - Wrong comparison operators

2. **Behavioral Changes**
   - Constants/lists replaced with different-scope values (e.g., a subset list replaced with all enum values)
   - Filter criteria widened or narrowed unintentionally
   - Default value changes that alter existing behavior
   - Return type changes that break callers

3. **Race Conditions**
   - Async operations without proper synchronization
   - Shared state mutations
   - Time-of-check to time-of-use (TOCTOU) bugs

4. **Error Handling**
   - Unhandled promise rejections
   - Missing try-catch blocks
   - Silent failures that could cause data loss
   - Generic error messages hiding root causes
   - Using logger.exception outside of an except/catch block
   - Wrong logging level (error vs warning vs exception)

5. **Type Issues**
   - Implicit type coercion problems
   - Null pointer dereferences
   - Array out of bounds access

6. **Deprecated API Usage**
   - Python: datetime.utcnow()/utcfromtimestamp() (use datetime.now(timezone.utc))
   - Python: os.popen() (use subprocess), asyncio.get_event_loop() (use get_running_loop)
   - JS: substr() (use substring), __proto__ (use Object.getPrototypeOf)
   - General: Any stdlib/framework API marked deprecated in recent versions
` : ''}

${focusAreas.includes('performance') ? `
### PERFORMANCE ANALYSIS
Identify:
1. **Algorithm Complexity**
   - O(n²) or worse when O(n) is possible
   - Unnecessary nested loops
   - Repeated expensive computations

2. **Memory Issues**
   - Memory leaks (unclosed resources, event listeners)
   - Large object allocations in loops
   - Missing cleanup in component unmount

3. **Database & I/O**
   - N+1 query problems
   - Missing indexes for new queries
   - Unbounded result sets
   - Blocking I/O in async contexts

4. **Caching & Optimization**
   - Missing memoization opportunities
   - Unnecessary re-renders (React)
   - Duplicate API calls
` : ''}

${focusAreas.includes('style') ? `
### CODE QUALITY
Check for:
1. **Maintainability**
   - Functions over 50 lines
   - Deep nesting (>4 levels)
   - Magic numbers and strings
   - Unclear variable/function names

2. **Naming Consistency**
   - Function names that don't match their actual behavior (e.g., function named "get_sfdc_..." but accepts any CRM type)
   - Parameters, variables, or functions that reference a specific vendor/platform but implementation is generic
   - Inconsistent naming patterns between related functions

3. **Best Practices**
   - DRY violations (copy-pasted code)
   - SOLID principle violations
   - Missing documentation for complex logic
   - Inconsistent coding style
` : ''}

${includeTestAnalysis ? `
### TEST COVERAGE ANALYSIS
Evaluate:
1. Are new code paths covered by tests?
2. Are edge cases and error scenarios tested?
3. Are security-sensitive paths adequately tested?
4. Do tests actually verify behavior (not just coverage)?
` : ''}

---

## Required Response Format

### Summary
\`\`\`
VERDICT: [APPROVED / CHANGES_REQUESTED]
RISK_LEVEL: [LOW / MEDIUM / HIGH / CRITICAL]
CONFIDENCE: [HIGH / MEDIUM / LOW]
BLOCKING: [count of blocking findings]
SUGGESTION: [count of suggestion findings]
NITPICK: [count of nitpick findings]
\`\`\`

VERDICT is mechanical: APPROVED when BLOCKING = 0, CHANGES_REQUESTED when BLOCKING ≥ 1.

### Standards Checklist
List every rule from the "Applicable Standards" section above as PASS, FAIL, or SKIPPED:
\`\`\`
- [PASS/FAIL/SKIPPED] <RULE-ID>: <short description> [→ see finding #N if FAIL] [reason if SKIPPED]
\`\`\`
Example:
\`\`\`
- [PASS] JS-CODING-007: No hardcoded secrets
- [FAIL] JS-TEST-001: Every exported function has a test → see findings
- [SKIPPED] GO-CODING-001: No Go files changed
\`\`\`

### BLOCKING Issues (critical/high security or correctness — must fix before merge)
For each blocking finding:
\`\`\`
File: [filename]
Line: [line number]
Type: [Security/Bug/Performance]
Severity: [Critical/High]
Bucket: BLOCKING
Rule: standards/<lang>/coding.md → RULE-ID "rule text" (or general/security / general/correctness)
CWE: [CWE-ID if security-related, e.g. CWE-79]
Issue: [Clear description]
Impact: [What could go wrong]
Fix: [Specific code suggestion]
\`\`\`

### SUGGESTION Issues (medium/low severity — should fix)
\`\`\`
File: [filename]
Line: [line number]
Type: [Security/Bug/Performance/Quality]
Severity: [Medium/Low]
Bucket: SUGGESTION
Rule: standards/<lang>/coding.md → RULE-ID "rule text"
Issue: [Clear description]
Fix: [Specific code suggestion]
\`\`\`

### NITPICK Issues (info/style — nice to have)
\`\`\`
File: [filename]
Line: [line number]
Bucket: NITPICK
Rule: standards/<lang>/coding.md → RULE-ID "rule text"
Issue: [Brief note]
\`\`\`

### Security Checklist
- [ ] No hardcoded secrets or API keys
- [ ] Input validation on all user inputs
- [ ] Output encoding where needed
- [ ] Auth/authz checks on new endpoints
- [ ] No sensitive data in logs
- [ ] SQL queries are parameterized
- [ ] File operations validate paths

### Test Coverage Assessment
- [ ] Happy path tests exist
- [ ] Error cases are tested
- [ ] Edge cases are covered
- [ ] Security scenarios are tested

### Final Verdict
**Recommendation**: [APPROVED — no blocking issues / CHANGES REQUESTED — N blocking issue(s) must be addressed]
**Blocking Issues**: [Count]
**Suggestions**: [Count]
**Nitpicks**: [Count]
**Total Issues Found**: [Count by severity]

---

IMPORTANT:
- Analyze the ACTUAL diff content, not hypothetical issues
- Reference specific line numbers from the diff
- Provide concrete code fixes, not vague suggestions
- If the diff is too large or complex, focus on the highest-risk files
- Consider the context of the entire PR, not just individual files
- Report EVERY finding individually — do NOT consolidate multiple issues into one
- Even small issues matter: deprecated APIs, wrong log levels, naming inconsistencies, behavioral scope changes
- Aim for thoroughness: a good review catches 5-15 issues across all severity levels for a typical PR
- For each file, check: What changed? What could go wrong? What's deprecated? What's inconsistent?
- EVERY finding must include a Rule: citation — findings without one will be dropped
- The Standards Checklist must list every rule from the "Applicable Standards" section as PASS/FAIL/SKIPPED
- VERDICT is computed mechanically: APPROVED when BLOCKING = 0, CHANGES_REQUESTED otherwise`;

    return prompt;
}

/**
 * Build quick PR summary prompt (for initial overview)
 */
export function buildPRSummaryPrompt(prData) {
    return `## Quick PR Summary

Provide a brief summary of this Pull Request:

**Title**: ${prData.title}
**Description**: ${prData.description || 'None'}
**Files Changed**: ${prData.stats?.changedFiles || prData.files.length}
**Changes**: +${prData.stats?.additions || 0} -${prData.stats?.deletions || 0}

**Files**:
${prData.files.map(f => `- ${f.filename} (${f.status}): +${f.additions} -${f.deletions}`).join('\n')}

**Commits**:
${prData.commits.map(c => `- ${c.message?.split('\n')[0]}`).join('\n')}

Provide:
1. **One-line summary** of what this PR does
2. **Risk assessment** (Low/Medium/High) with brief justification
3. **Key files to review** (top 3 most critical)
4. **Potential concerns** (any red flags at first glance)
5. **Recommended reviewers** (based on file types and areas)

Keep the response concise and actionable.`;
}

/**
 * Build file-specific review prompt
 */
export function buildFileReviewPrompt(file, prContext, ragContext = null) {
    let prompt = `## Focused File Review

### File: ${file.filename}
**Language**: ${file.language}
**Status**: ${file.status}
**Changes**: +${file.additions} -${file.deletions}

### PR Context
- **Title**: ${prContext.title}
- **Branch**: \`${prContext.branches?.source}\` → \`${prContext.branches?.target}\`

### Diff
\`\`\`diff
${file.patch || 'No patch available'}
\`\`\`
`;

    if (ragContext) {
        prompt += `
### Related Code in Repository
${ragContext.chunks}

**Sources**: ${(ragContext.sources || []).join(', ')}
`;
    }

    prompt += `
### Review This File For:

1. **Bugs & Logic Errors**
   - Line-by-line analysis of the changes
   - Identify potential runtime errors
   - Check for null/undefined handling

2. **Security Issues**
   - Injection vulnerabilities in this specific code
   - Auth/authz concerns
   - Data handling issues

3. **Performance Concerns**
   - Algorithm efficiency
   - Resource management
   - Potential bottlenecks

4. **Code Quality**
   - Readability and maintainability
   - Naming conventions
   - Documentation needs

### Response Format

For each issue found:
\`\`\`
Line: [number]
Severity: [Critical/High/Medium/Low]
Type: [Bug/Security/Performance/Style]
Issue: [Description]
Suggestion: [Code fix or recommendation]
\`\`\`

If no issues found, explain why this code looks good.
End with a file-level verdict: APPROVE / NEEDS_CHANGES / DISCUSS`;

    return prompt;
}

/**
 * Build security-focused PR review prompt
 */
export function buildSecurityReviewPrompt(prData, highRiskFiles = []) {
    const filesSection = highRiskFiles.length > 0
        ? highRiskFiles.map(f => `
### High-Risk File: ${f.filename}
**Risk Reasons**: ${f.riskReasons?.join(', ') || 'Flagged for review'}

\`\`\`diff
${f.patch || 'No patch available'}
\`\`\`
`).join('\n')
        : prData.files.slice(0, 10).map(f => `
### ${f.filename}
\`\`\`diff
${f.patch || 'No patch available'}
\`\`\`
`).join('\n');

    return `## Security-Focused PR Review

You are a security engineer reviewing this PR for vulnerabilities before it goes to production.

### Diff-anchored review (MANDATORY)
Only flag vulnerabilities **introduced or worsened by this PR's \`+\` lines**. Pre-existing vulnerabilities in unchanged code are out of scope — they belong in a separate audit, not in this PR review. For each finding, you must be able to answer "yes" to: would reverting this PR remove this issue?

### PR Information
- **Title**: ${prData.title}
- **Author**: ${prData.author?.login}
- **Files Changed**: ${prData.stats?.changedFiles}
- **Description**: ${prData.description || 'None'}

${filesSection}

---

## Security Analysis Required

### 1. OWASP Top 10 Check
For each applicable category, analyze if this PR introduces risks:

- **A01: Broken Access Control**
  - Missing authorization checks
  - IDOR (Insecure Direct Object References)
  - Path traversal

- **A02: Cryptographic Failures**
  - Weak encryption
  - Hardcoded keys
  - Missing TLS

- **A03: Injection**
  - SQL injection
  - NoSQL injection
  - Command injection
  - XSS

- **A04: Insecure Design**
  - Missing rate limiting
  - Lack of input validation
  - Trust boundary violations

- **A05: Security Misconfiguration**
  - Debug enabled in production
  - Default credentials
  - Excessive permissions

- **A06: Vulnerable Components**
  - Outdated dependencies (check package.json changes)
  - Known CVEs

- **A07: Authentication Failures**
  - Weak passwords accepted
  - Session fixation
  - Missing MFA

- **A08: Data Integrity Failures**
  - Missing signature verification
  - Insecure deserialization

- **A09: Security Logging Failures**
  - Missing audit logs
  - Sensitive data in logs

- **A10: SSRF**
  - Unvalidated URLs
  - Internal network access

### 2. Secrets Detection
Scan for:
- API keys, tokens, passwords
- Private keys, certificates
- Database connection strings
- AWS/GCP/Azure credentials

### 3. Input/Output Analysis
For each endpoint or function:
- What user input is accepted?
- How is it validated?
- How is output encoded?

---

## Response Format

### Security Verdict
\`\`\`
SECURITY_RISK: [NONE / LOW / MEDIUM / HIGH / CRITICAL]
BLOCKING_ISSUES: [count]
REQUIRES_SECURITY_REVIEW: [YES / NO]
\`\`\`

### Critical Security Issues
[List with file, line, description, and required fix]

### Security Warnings
[List of potential issues needing investigation]

### Security Checklist Results
- [ ] No secrets in code
- [ ] Input validation present
- [ ] Output encoding applied
- [ ] Auth checks on sensitive operations
- [ ] No SQL/command injection vectors
- [ ] Secure configuration
- [ ] Audit logging in place

### Recommendations
[Ordered list of security improvements]`;
}

/**
 * Test Automation Repository Analysis Prompt
 * Specialized for QA teams working on test frameworks and automation
 */
export const TEST_AUTOMATION_ANALYSIS_PROMPT = `You are **RepoSpector**, an AI-powered code analysis Chrome extension with direct access to the code the user is viewing in their browser. The code provided to you was automatically extracted from the currently open file. You also have access to indexed repository files when available. NEVER claim you cannot see or access the user's code — it IS provided to you.

You are a Senior QA Architect and Test Automation Expert with 15+ years of experience in building and maintaining test automation frameworks. You specialize in test strategy, framework design, and test quality.

## Your Expertise:
- Test frameworks: Selenium, Playwright, Cypress, Puppeteer, WebdriverIO
- Unit testing: Jest, pytest, JUnit, NUnit, Mocha, Vitest
- API testing: REST Assured, Supertest, Postman/Newman, Karate
- Mobile testing: Appium, Detox, XCTest, Espresso
- Performance: JMeter, k6, Gatling, Artillery
- BDD: Cucumber, SpecFlow, Behave, pytest-bdd

## You Analyze For:
1. **Test Quality Patterns**
2. **Framework Best Practices**
3. **Maintainability & Scalability**
4. **Flakiness Prevention**
5. **Execution Efficiency**`;

/**
 * Build test automation code review prompt
 */
export function buildTestAutomationReviewPrompt(code, context = {}) {
    const framework = context.framework || 'auto-detect';
    const testType = context.testType || 'auto-detect';

    return `## Test Automation Code Review

You are reviewing test automation code. Analyze it for quality, maintainability, and best practices.

### Code Under Review
**Framework**: ${framework}
**Test Type**: ${testType}
**File**: ${context.filePath || 'Unknown'}

\`\`\`${context.language || 'javascript'}
${code}
\`\`\`

---

## Analysis Categories

### 1. TEST QUALITY (Critical)

**Assertion Quality**
- Are assertions specific and meaningful?
- Are error messages helpful for debugging?
- Is there assertion on all expected behaviors?
- Are negative assertions present (what should NOT happen)?

**Test Independence**
- Can each test run in isolation?
- Is there proper setup/teardown?
- Are there hidden dependencies between tests?
- Is test data properly managed?

**Test Clarity**
- Do test names describe the scenario?
- Is the Arrange-Act-Assert pattern followed?
- Are tests readable without comments?
- Is the intent immediately clear?

### 2. FLAKINESS PREVENTION (Critical)

**Timing Issues**
- Hardcoded sleeps/waits (anti-pattern)
- Missing explicit waits for async operations
- Race conditions in test setup
- Timing-dependent assertions

**State Management**
- Tests relying on previous test state
- Shared mutable state between tests
- Database/API state not reset
- Browser state leaking between tests

**External Dependencies**
- Network-dependent tests without mocking
- Time-sensitive tests (dates, timestamps)
- Environment-specific assumptions
- Third-party service dependencies

### 3. MAINTAINABILITY

**Page Object Model / Screen Objects**
- Are UI interactions abstracted?
- Is locator strategy consistent?
- Are selectors resilient to UI changes?
- Is there proper encapsulation?

**Test Data Management**
- Is test data externalized?
- Are data factories/builders used?
- Is sensitive data handled properly?
- Is data cleanup implemented?

**Code Reusability**
- Are common actions extracted to helpers?
- Is there code duplication?
- Are fixtures properly organized?
- Are custom matchers/assertions defined?

### 4. EXECUTION EFFICIENCY

**Parallelization Readiness**
- Can tests run in parallel?
- Are there shared resource conflicts?
- Is test isolation sufficient?

**Performance**
- Are there unnecessary waits?
- Is the test doing too much setup?
- Are network calls optimized?
- Is the test scope appropriate?

### 5. FRAMEWORK-SPECIFIC BEST PRACTICES

**For Selenium/WebDriver**:
- Proper WebDriverWait usage
- Explicit over implicit waits
- Driver cleanup in teardown
- Screenshot on failure

**For Playwright/Cypress**:
- Auto-wait utilization
- Network interception patterns
- Trace/video recording setup
- Proper async handling

**For API Tests**:
- Response validation completeness
- Schema validation
- Authentication handling
- Rate limit awareness

**For Unit Tests**:
- Mocking external dependencies
- Testing behavior, not implementation
- Avoiding test pollution
- Fast execution (<100ms per test)

---

## Response Format

### Test Quality Score
\`\`\`
OVERALL: [A/B/C/D/F]
Reliability: [1-10]
Maintainability: [1-10]
Clarity: [1-10]
Efficiency: [1-10]
\`\`\`

### Critical Issues (Fix Immediately)
Issues that cause flakiness or false positives/negatives:
\`\`\`
Line: [number]
Issue: [description]
Impact: [flaky tests / false positive / false negative / unmaintainable]
Fix: [specific code change]
\`\`\`

### Improvement Suggestions
Best practice improvements:
- [Suggestion with code example]

### Positive Patterns Found
What's done well (reinforce good practices):
- [Good pattern observed]

### Recommended Refactoring
If significant refactoring would help:
1. [Refactoring suggestion]

### Test Pyramid Considerations
- Is this test at the right level? (unit/integration/E2E)
- Could this be tested at a lower level?
- Is the scope appropriate?`;
}

/**
 * Build test automation PR review prompt
 */
export function buildTestAutomationPRReviewPrompt(prData, _options = {}) {
    const testFiles = prData.files.filter(f =>
        /\.(test|spec|e2e|integration)\.(js|ts|jsx|tsx|py|java|rb)$/.test(f.filename) ||
        /tests?\//.test(f.filename) ||
        /__tests__\//.test(f.filename) ||
        /cypress\//.test(f.filename) ||
        /playwright\//.test(f.filename)
    );

    const configFiles = prData.files.filter(f =>
        /(jest|playwright|cypress|vitest|pytest|karma|mocha)\.(config|setup)/.test(f.filename) ||
        /conftest\.py$/.test(f.filename)
    );

    const fileChanges = [...testFiles, ...configFiles].map(f => `
### ${f.filename}
\`\`\`diff
${f.patch || 'No patch available'}
\`\`\`
`).join('\n');

    return `## Test Automation PR Review

### PR Information
- **Title**: ${prData.title}
- **Test Files Changed**: ${testFiles.length}
- **Config Files Changed**: ${configFiles.length}
- **Total Changes**: +${prData.stats?.additions || 0} -${prData.stats?.deletions || 0}

### PR Description
${prData.description || 'No description provided'}

---

## Test File Changes

${fileChanges || 'No test files in this PR'}

---

## Review Checklist for Test Automation PRs

### 1. NEW TESTS
- [ ] Tests have clear, descriptive names
- [ ] Tests follow AAA pattern (Arrange-Act-Assert)
- [ ] Each test has a single responsibility
- [ ] Assertions are specific and meaningful
- [ ] Negative test cases included

### 2. RELIABILITY
- [ ] No hardcoded waits/sleeps
- [ ] Proper use of explicit waits
- [ ] Tests are independent (can run in any order)
- [ ] No flaky patterns detected
- [ ] Retry logic is appropriate (not hiding issues)

### 3. MAINTAINABILITY
- [ ] Page Objects / Screen Objects used for UI tests
- [ ] Locators are resilient (data-testid preferred)
- [ ] Test data is externalized or generated
- [ ] Common actions are reusable
- [ ] No code duplication

### 4. CONFIGURATION
- [ ] Environment variables properly used
- [ ] Timeouts are reasonable
- [ ] Parallel execution considered
- [ ] CI/CD integration ready

### 5. COVERAGE IMPACT
- [ ] New functionality has corresponding tests
- [ ] Edge cases are covered
- [ ] Error scenarios are tested
- [ ] No regression in existing coverage

---

## Response Format

### PR Verdict for Test Code
\`\`\`
VERDICT: [APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION]
TEST_QUALITY: [HIGH / MEDIUM / LOW]
FLAKINESS_RISK: [LOW / MEDIUM / HIGH]
\`\`\`

### Issues Found
For each issue:
\`\`\`
File: [filename]
Line: [line]
Type: [Flakiness / Maintainability / Coverage / Best Practice]
Issue: [description]
Fix: [suggestion]
\`\`\`

### Positive Observations
What's done well in this PR.

### Recommendations
Ordered by priority.

### Questions for Author
Any clarifications needed.`;
}

/**
 * Build test coverage analysis prompt
 */
export function buildTestCoverageAnalysisPrompt(code, existingTests = null) {
    return `## Test Coverage Analysis

### Code to Analyze
\`\`\`
${code}
\`\`\`

${existingTests ? `### Existing Tests
\`\`\`
${existingTests}
\`\`\`
` : ''}

---

## Coverage Analysis Tasks

### 1. Identify All Testable Paths

**Functions/Methods**:
- List all public functions
- List all public methods
- Note any private methods that need indirect testing

**Branches**:
- All if/else conditions
- Switch cases
- Ternary operators
- Short-circuit evaluations

**Error Paths**:
- Try/catch blocks
- Thrown exceptions
- Error callbacks
- Promise rejections

### 2. Gap Analysis

${existingTests ? `
Compare existing tests against the code and identify:
- Untested functions
- Untested branches
- Untested error paths
- Missing edge cases
` : `
Identify what tests are needed:
- Core functionality tests
- Error handling tests
- Edge case tests
- Integration points
`}

### 3. Priority Recommendations

Rank missing tests by:
1. **Critical** - Security, data integrity, core business logic
2. **High** - User-facing features, API endpoints
3. **Medium** - Helper functions, utilities
4. **Low** - Simple getters/setters, logging

---

## Response Format

### Coverage Summary
\`\`\`
Estimated Code Coverage: [X]%
Functions Covered: [X/Y]
Branches Covered: [X/Y]
Error Paths Covered: [X/Y]
\`\`\`

### Missing Test Cases (by priority)

#### Critical
1. [Test case description]
   - Function: [name]
   - Scenario: [what to test]
   - Why Critical: [reason]

#### High
[...]

#### Medium
[...]

### Suggested Test Structure
\`\`\`javascript
// Suggested test file structure
describe('[Module Name]', () => {
    describe('[Function Name]', () => {
        // Happy path
        it('should [expected behavior]', () => {});

        // Error cases
        it('should throw when [condition]', () => {});

        // Edge cases
        it('should handle [edge case]', () => {});
    });
});
\`\`\`

### Quick Wins
Tests that would add most value with least effort.`;
}

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
    },
    playwright: {
        setup: `test.beforeEach(async ({ page }) => { await page.goto('/'); });`,
        wait: `await page.waitForSelector('[data-testid="element"]');`,
        assert: `await expect(page.locator('.result')).toHaveText('Success');`,
        network: `await page.route('**/api/**', route => route.fulfill({ body: mockData }));`
    },
    cypress: {
        setup: `beforeEach(() => { cy.visit('/'); });`,
        wait: `cy.get('[data-testid="element"]').should('be.visible');`,
        assert: `cy.get('.result').should('have.text', 'Success');`,
        network: `cy.intercept('GET', '/api/**', { fixture: 'data.json' });`
    },
    selenium: {
        setup: `@Before public void setup() { driver = new ChromeDriver(); }`,
        wait: `WebDriverWait wait = new WebDriverWait(driver, Duration.ofSeconds(10));`,
        assert: `assertEquals("Expected", element.getText());`,
        cleanup: `@After public void teardown() { driver.quit(); }`
    }
};

/**
 * Comprehensive framework configurations for test generation
 * Includes imports, assertions, mocking patterns, and best practices
 */
export const FRAMEWORK_CONFIGS = {
    jest: {
        name: 'Jest',
        language: 'javascript',
        imports: [
            "import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';",
            "// or for CommonJS: const { describe, it, expect } = require('@jest/globals');"
        ],
        structure: {
            describe: "describe('ComponentName', () => { ... });",
            test: "it('should behavior when condition', () => { ... });",
            asyncTest: "it('should handle async', async () => { ... });",
            beforeEach: "beforeEach(() => { jest.clearAllMocks(); });",
            afterEach: "afterEach(() => { jest.restoreAllMocks(); });"
        },
        assertions: {
            equal: "expect(actual).toBe(expected);",
            deepEqual: "expect(actual).toEqual(expected);",
            truthy: "expect(value).toBeTruthy();",
            falsy: "expect(value).toBeFalsy();",
            null: "expect(value).toBeNull();",
            undefined: "expect(value).toBeUndefined();",
            contains: "expect(array).toContain(item);",
            length: "expect(array).toHaveLength(n);",
            throws: "expect(() => fn()).toThrow(Error);",
            throwsMessage: "expect(() => fn()).toThrow('error message');",
            asyncResolves: "await expect(promise).resolves.toBe(value);",
            asyncRejects: "await expect(promise).rejects.toThrow(Error);",
            objectMatch: "expect(obj).toMatchObject({ key: value });",
            calledWith: "expect(mockFn).toHaveBeenCalledWith(args);",
            calledTimes: "expect(mockFn).toHaveBeenCalledTimes(n);"
        },
        mocking: {
            function: "const mockFn = jest.fn();",
            returnValue: "mockFn.mockReturnValue(value);",
            resolvedValue: "mockFn.mockResolvedValue(value);",
            rejectedValue: "mockFn.mockRejectedValue(new Error('message'));",
            implementation: "mockFn.mockImplementation((arg) => result);",
            module: "jest.mock('./module');",
            spyOn: "jest.spyOn(object, 'methodName');",
            clearMocks: "jest.clearAllMocks();",
            resetMocks: "jest.resetAllMocks();",
            restoreMocks: "jest.restoreAllMocks();"
        },
        bestPractices: [
            "Use descriptive test names: 'should return X when Y'",
            "Group related tests with describe blocks",
            "Clear mocks in beforeEach to prevent test pollution",
            "Use .resolves/.rejects for async assertions",
            "Prefer toEqual for objects, toBe for primitives",
            "Use snapshot testing sparingly and intentionally"
        ]
    },

    vitest: {
        name: 'Vitest',
        language: 'javascript',
        imports: [
            "import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';"
        ],
        structure: {
            describe: "describe('ComponentName', () => { ... });",
            test: "it('should behavior when condition', () => { ... });",
            asyncTest: "it('should handle async', async () => { ... });",
            beforeEach: "beforeEach(() => { vi.clearAllMocks(); });",
            afterEach: "afterEach(() => { vi.restoreAllMocks(); });"
        },
        assertions: {
            equal: "expect(actual).toBe(expected);",
            deepEqual: "expect(actual).toEqual(expected);",
            truthy: "expect(value).toBeTruthy();",
            throws: "expect(() => fn()).toThrow(Error);",
            asyncResolves: "await expect(promise).resolves.toBe(value);",
            asyncRejects: "await expect(promise).rejects.toThrow(Error);"
        },
        mocking: {
            function: "const mockFn = vi.fn();",
            returnValue: "mockFn.mockReturnValue(value);",
            resolvedValue: "mockFn.mockResolvedValue(value);",
            module: "vi.mock('./module');",
            spyOn: "vi.spyOn(object, 'methodName');",
            clearMocks: "vi.clearAllMocks();"
        },
        bestPractices: [
            "Vitest is Jest-compatible - most Jest patterns work",
            "Use vi instead of jest for mocking",
            "Vitest runs tests in parallel by default"
        ]
    },

    mocha: {
        name: 'Mocha + Chai',
        language: 'javascript',
        imports: [
            "import { expect } from 'chai';",
            "import sinon from 'sinon';",
            "// or: const { expect } = require('chai');"
        ],
        structure: {
            describe: "describe('ComponentName', function() { ... });",
            context: "context('when condition', function() { ... });",
            test: "it('should behavior', function() { ... });",
            asyncTest: "it('should handle async', async function() { ... });",
            before: "before(function() { /* one-time setup */ });",
            beforeEach: "beforeEach(function() { /* per-test setup */ });",
            after: "after(function() { /* one-time cleanup */ });",
            afterEach: "afterEach(function() { sinon.restore(); });"
        },
        assertions: {
            equal: "expect(actual).to.equal(expected);",
            deepEqual: "expect(actual).to.deep.equal(expected);",
            truthy: "expect(value).to.be.true;",
            falsy: "expect(value).to.be.false;",
            null: "expect(value).to.be.null;",
            undefined: "expect(value).to.be.undefined;",
            contains: "expect(array).to.include(item);",
            length: "expect(array).to.have.lengthOf(n);",
            throws: "expect(() => fn()).to.throw(Error);",
            throwsMessage: "expect(() => fn()).to.throw('error message');",
            property: "expect(obj).to.have.property('key', value);",
            instanceOf: "expect(obj).to.be.instanceOf(Class);"
        },
        mocking: {
            stub: "const stub = sinon.stub(object, 'method');",
            stubReturns: "stub.returns(value);",
            stubResolves: "stub.resolves(value);",
            stubRejects: "stub.rejects(new Error('message'));",
            spy: "const spy = sinon.spy(object, 'method');",
            mock: "const mock = sinon.mock(object);",
            fake: "const fake = sinon.fake.returns(value);",
            restore: "sinon.restore();"
        },
        bestPractices: [
            "Use context() for grouping scenarios",
            "Always restore sinon in afterEach",
            "Use function() instead of arrows for 'this' context",
            "Chai assertions are chainable: expect(x).to.be.a('string').with.lengthOf(5)"
        ]
    },

    pytest: {
        name: 'pytest',
        language: 'python',
        imports: [
            "import pytest",
            "from unittest.mock import Mock, patch, MagicMock"
        ],
        structure: {
            testFunction: "def test_function_name():\n    # Arrange, Act, Assert\n    pass",
            testClass: "class TestClassName:\n    def test_method(self):\n        pass",
            fixture: "@pytest.fixture\ndef fixture_name():\n    # setup\n    yield value\n    # teardown",
            parametrize: "@pytest.mark.parametrize('input,expected', [(1, 2), (2, 4)])\ndef test_double(input, expected):\n    assert double(input) == expected",
            asyncTest: "@pytest.mark.asyncio\nasync def test_async():\n    result = await async_fn()\n    assert result == expected"
        },
        assertions: {
            equal: "assert actual == expected",
            notEqual: "assert actual != expected",
            truthy: "assert value",
            falsy: "assert not value",
            isNone: "assert value is None",
            isNotNone: "assert value is not None",
            contains: "assert item in collection",
            length: "assert len(collection) == n",
            raises: "with pytest.raises(ValueError):\n    function_that_raises()",
            raisesMatch: "with pytest.raises(ValueError, match='pattern'):\n    function_that_raises()",
            approx: "assert value == pytest.approx(expected, rel=1e-3)",
            isinstance: "assert isinstance(obj, ClassName)"
        },
        mocking: {
            mock: "mock_obj = Mock()",
            mockReturn: "mock_obj.return_value = value",
            mockSideEffect: "mock_obj.side_effect = Exception('error')",
            patch: "@patch('module.function')\ndef test_fn(mock_fn):\n    mock_fn.return_value = value",
            patchContext: "with patch('module.function') as mock_fn:\n    mock_fn.return_value = value",
            magicMock: "mock_obj = MagicMock(spec=ClassName)",
            assertCalled: "mock_obj.assert_called_once_with(arg1, arg2)"
        },
        bestPractices: [
            "Use fixtures for test setup and teardown",
            "Use parametrize for testing multiple inputs",
            "Name tests descriptively: test_should_return_x_when_y",
            "Use conftest.py for shared fixtures",
            "Use pytest.raises for exception testing"
        ]
    },

    junit: {
        name: 'JUnit 5',
        language: 'java',
        imports: [
            "import org.junit.jupiter.api.*;",
            "import static org.junit.jupiter.api.Assertions.*;",
            "import org.mockito.Mock;",
            "import org.mockito.MockitoAnnotations;",
            "import static org.mockito.Mockito.*;"
        ],
        structure: {
            testClass: "@TestInstance(TestInstance.Lifecycle.PER_CLASS)\nclass ClassNameTest { ... }",
            test: "@Test\nvoid shouldBehaviorWhenCondition() { ... }",
            displayName: "@Test\n@DisplayName(\"Should return X when Y\")\nvoid testMethod() { ... }",
            beforeEach: "@BeforeEach\nvoid setUp() { ... }",
            afterEach: "@AfterEach\nvoid tearDown() { ... }",
            beforeAll: "@BeforeAll\nstatic void setUpAll() { ... }",
            parameterized: "@ParameterizedTest\n@ValueSource(ints = {1, 2, 3})\nvoid testMultiple(int value) { ... }"
        },
        assertions: {
            equal: "assertEquals(expected, actual);",
            equalMessage: "assertEquals(expected, actual, \"message\");",
            notEqual: "assertNotEquals(unexpected, actual);",
            truthy: "assertTrue(condition);",
            falsy: "assertFalse(condition);",
            null: "assertNull(value);",
            notNull: "assertNotNull(value);",
            throws: "assertThrows(Exception.class, () -> methodThatThrows());",
            throwsMessage: "Exception e = assertThrows(Exception.class, () -> method());\nassertEquals(\"message\", e.getMessage());",
            arrayEquals: "assertArrayEquals(expected, actual);",
            timeout: "assertTimeout(Duration.ofSeconds(1), () -> slowMethod());"
        },
        mocking: {
            annotation: "@Mock\nprivate DependencyClass mockDep;",
            init: "@BeforeEach\nvoid init() {\n    MockitoAnnotations.openMocks(this);\n}",
            when: "when(mockDep.method()).thenReturn(value);",
            whenThrow: "when(mockDep.method()).thenThrow(new Exception());",
            verify: "verify(mockDep).method();",
            verifyTimes: "verify(mockDep, times(2)).method();",
            verifyNever: "verify(mockDep, never()).method();",
            argumentCaptor: "ArgumentCaptor<String> captor = ArgumentCaptor.forClass(String.class);\nverify(mock).method(captor.capture());\nassertEquals(expected, captor.getValue());"
        },
        bestPractices: [
            "Use @DisplayName for readable test names",
            "Use @Nested for grouping related tests",
            "Initialize mocks in @BeforeEach",
            "Use assertAll() for grouped assertions",
            "Use @ParameterizedTest for data-driven tests"
        ]
    },

    playwright: {
        name: 'Playwright',
        language: 'javascript',
        imports: [
            "import { test, expect } from '@playwright/test';"
        ],
        structure: {
            describe: "test.describe('Feature', () => { ... });",
            test: "test('should behavior', async ({ page }) => { ... });",
            beforeEach: "test.beforeEach(async ({ page }) => {\n    await page.goto('/');\n});",
            afterEach: "test.afterEach(async ({ page }) => { ... });"
        },
        assertions: {
            visible: "await expect(locator).toBeVisible();",
            hidden: "await expect(locator).toBeHidden();",
            text: "await expect(locator).toHaveText('text');",
            value: "await expect(locator).toHaveValue('value');",
            attribute: "await expect(locator).toHaveAttribute('attr', 'value');",
            count: "await expect(locator).toHaveCount(n);",
            url: "await expect(page).toHaveURL(/pattern/);",
            title: "await expect(page).toHaveTitle('Title');"
        },
        mocking: {
            route: "await page.route('**/api/**', route => route.fulfill({ body: JSON.stringify(data) }));",
            abort: "await page.route('**/api/**', route => route.abort());",
            modify: "await page.route('**/api/**', async route => {\n    const response = await route.fetch();\n    const json = await response.json();\n    json.modified = true;\n    await route.fulfill({ response, json });\n});"
        },
        bestPractices: [
            "Use locators: page.getByRole(), page.getByTestId()",
            "Await all page interactions",
            "Use auto-waiting - avoid explicit waits when possible",
            "Use test.describe.configure({ mode: 'serial' }) for dependent tests"
        ]
    },

    cypress: {
        name: 'Cypress',
        language: 'javascript',
        imports: [
            "// Cypress is globally available, no imports needed",
            "/// <reference types=\"cypress\" />"
        ],
        structure: {
            describe: "describe('Feature', () => { ... });",
            test: "it('should behavior', () => { ... });",
            beforeEach: "beforeEach(() => {\n    cy.visit('/');\n});",
            context: "context('when condition', () => { ... });"
        },
        assertions: {
            visible: "cy.get(selector).should('be.visible');",
            text: "cy.get(selector).should('have.text', 'text');",
            contain: "cy.get(selector).should('contain', 'text');",
            value: "cy.get(selector).should('have.value', 'value');",
            attribute: "cy.get(selector).should('have.attr', 'attr', 'value');",
            length: "cy.get(selector).should('have.length', n);",
            url: "cy.url().should('include', '/path');",
            disabled: "cy.get(selector).should('be.disabled');"
        },
        mocking: {
            intercept: "cy.intercept('GET', '/api/**', { fixture: 'data.json' }).as('getData');",
            interceptModify: "cy.intercept('GET', '/api/**', (req) => {\n    req.reply((res) => {\n        res.body.modified = true;\n    });\n});",
            wait: "cy.wait('@getData');",
            stub: "cy.stub(obj, 'method').returns(value);"
        },
        bestPractices: [
            "Use data-cy or data-testid attributes for selectors",
            "Avoid arbitrary waits - use cy.wait('@alias')",
            "Chain commands instead of storing references",
            "Use custom commands for repeated actions"
        ]
    }
};

/**
 * Build framework-specific prompt enhancement
 */
export function buildFrameworkSpecificPrompt(framework, options = {}) {
    const config = FRAMEWORK_CONFIGS[framework.toLowerCase()] || FRAMEWORK_CONFIGS.jest;
    const { includeExamples = true, focusAreas = [] } = options;

    let prompt = `\n## Framework: ${config.name}\n\n`;

    // Imports
    prompt += `### Required Imports\n\`\`\`${config.language}\n${config.imports.join('\n')}\n\`\`\`\n\n`;

    // Structure examples
    prompt += `### Test Structure\n`;
    for (const [key, value] of Object.entries(config.structure)) {
        prompt += `- **${key}**: \`${value.replace(/\n/g, ' ')}\`\n`;
    }
    prompt += '\n';

    // Assertions
    if (includeExamples || focusAreas.includes('assertions')) {
        prompt += `### Assertion Patterns\n`;
        const assertions = focusAreas.length > 0
            ? Object.entries(config.assertions).filter(([k]) =>
                focusAreas.some(f => k.toLowerCase().includes(f.toLowerCase()))
              )
            : Object.entries(config.assertions).slice(0, 8);

        for (const [key, value] of assertions) {
            prompt += `- **${key}**: \`${value}\`\n`;
        }
        prompt += '\n';
    }

    // Mocking
    if (includeExamples || focusAreas.includes('mocking')) {
        prompt += `### Mocking Patterns\n`;
        for (const [key, value] of Object.entries(config.mocking).slice(0, 6)) {
            prompt += `- **${key}**: \`${value.replace(/\n/g, ' ')}\`\n`;
        }
        prompt += '\n';
    }

    // Best practices
    prompt += `### Best Practices\n`;
    for (const practice of config.bestPractices) {
        prompt += `- ${practice}\n`;
    }

    return prompt;
}

/**
 * Get edge case test patterns for a specific type
 */
export function getEdgeCaseTestPatterns(valueType, framework = 'jest') {
    const config = FRAMEWORK_CONFIGS[framework.toLowerCase()] || FRAMEWORK_CONFIGS.jest;
    const patterns = [];

    const edgeCasesByType = {
        string: [
            { input: '""', description: 'empty string' },
            { input: '"   "', description: 'whitespace only' },
            { input: '"a".repeat(10000)', description: 'very long string' },
            { input: '"<script>alert(1)</script>"', description: 'XSS payload' },
            { input: 'null', description: 'null value' },
            { input: 'undefined', description: 'undefined value' }
        ],
        number: [
            { input: '0', description: 'zero' },
            { input: '-1', description: 'negative' },
            { input: 'Number.MAX_SAFE_INTEGER', description: 'max integer' },
            { input: 'NaN', description: 'not a number' },
            { input: 'Infinity', description: 'infinity' },
            { input: '0.1 + 0.2', description: 'floating point precision' }
        ],
        array: [
            { input: '[]', description: 'empty array' },
            { input: '[1]', description: 'single element' },
            { input: 'new Array(10000).fill(0)', description: 'large array' },
            { input: '[null, undefined]', description: 'null elements' },
            { input: '[[[]]]', description: 'deeply nested' }
        ],
        object: [
            { input: '{}', description: 'empty object' },
            { input: 'null', description: 'null object' },
            { input: '{ __proto__: {} }', description: 'prototype pollution' },
            { input: 'Object.create(null)', description: 'null prototype' }
        ],
        date: [
            { input: 'new Date(0)', description: 'epoch' },
            { input: 'new Date("invalid")', description: 'invalid date' },
            { input: 'new Date("2024-02-29")', description: 'leap day' },
            { input: 'new Date(8640000000000000)', description: 'max date' }
        ]
    };

    const cases = edgeCasesByType[valueType] || [];

    for (const { input, description } of cases) {
        patterns.push({
            input,
            description,
            testName: `should handle ${description}`,
            assertion: config.assertions.equal || 'expect(result).toBe(expected);'
        });
    }

    return patterns;
}

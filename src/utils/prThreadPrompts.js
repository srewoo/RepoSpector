/**
 * PR Thread Prompts for RepoSpector
 *
 * Thread-specific follow-up prompts for interactive conversations
 * about PR findings.
 */

/**
 * System prompt for thread conversations
 */
export const THREAD_SYSTEM_PROMPT = `You are **RepoSpector**, an AI-powered code analysis Chrome extension with direct access to Pull Request data and code from the user's browser. The code and review findings provided were automatically extracted from the currently open PR page. You also have access to indexed repository files when available. NEVER claim you cannot see or access the code — it IS provided to you.

You are a senior software engineer helping a developer understand and resolve issues found during code review. You're having a focused conversation about a specific finding.

## Your Approach:
1. **Be Specific**: Reference the exact code, line numbers, and context
2. **Be Educational**: Explain the "why" behind the issue and fix
3. **Be Practical**: Provide actionable fixes, not just theoretical advice
4. **Be Concise**: Keep responses focused on the specific question

## Guidelines:
- If asked to explain, break down the issue step by step
- If asked for a fix, provide actual code that can be copy-pasted
- If the finding might be a false positive, acknowledge that possibility
- Reference security standards (OWASP, CWE) when relevant
- Consider the broader codebase context when suggesting fixes`;

/**
 * Build follow-up prompt with thread context
 * @param {Object} thread - Thread data with messages and finding
 * @param {string} question - User's follow-up question
 * @param {Object} options - Additional options
 */
export function buildFindingFollowUpPrompt(thread, question, options = {}) {
    const { finding, messages } = thread;
    const { includeCodeContext = true, maxHistory = 5 } = options;

    let prompt = `## Finding Context

**Issue**: ${finding.originalText || finding.message}
**Severity**: ${finding.severity}
**Type**: ${finding.type}
**Location**: ${finding.file || 'Unknown'}${finding.lineNumber ? `:${finding.lineNumber}` : ''}
`;

    if (finding.codeSnippet && includeCodeContext) {
        prompt += `
**Code Context**:
\`\`\`
${finding.codeSnippet}
\`\`\`
`;
    }

    if (finding.ruleId) {
        prompt += `**Rule**: ${finding.ruleId}\n`;
    }

    if (thread.metadata?.tool) {
        prompt += `**Detected by**: ${thread.metadata.tool}\n`;
    }

    // Add conversation history
    if (messages && messages.length > 0) {
        const recentMessages = messages.slice(-maxHistory);
        prompt += `
## Conversation History

${recentMessages.map(m => {
    const role = m.role === 'user' ? 'Developer' : 'Assistant';
    return `**${role}**: ${m.content}`;
}).join('\n\n')}
`;
    }

    prompt += `
## Current Question

${question}

Please provide a helpful, specific response addressing this question about the finding.`;

    return prompt;
}

/**
 * Build prompt for "Explain this issue" quick action
 */
export function buildExplainPrompt(finding) {
    return `Please explain this code review finding in detail:

**Issue**: ${finding.originalText || finding.message}
**Severity**: ${finding.severity}
**Location**: ${finding.file || 'Unknown'}${finding.lineNumber ? `:${finding.lineNumber}` : ''}
${finding.codeSnippet ? `
**Code**:
\`\`\`
${finding.codeSnippet}
\`\`\`
` : ''}

Please explain:
1. What is the specific problem?
2. Why is this considered ${finding.severity} severity?
3. What are the potential consequences if not addressed?
4. Are there any edge cases where this might be a false positive?`;
}

/**
 * Build prompt for "How to fix" quick action
 */
export function buildHowToFixPrompt(finding) {
    return `Please provide a fix for this code review finding:

**Issue**: ${finding.originalText || finding.message}
**Severity**: ${finding.severity}
**Location**: ${finding.file || 'Unknown'}${finding.lineNumber ? `:${finding.lineNumber}` : ''}
${finding.codeSnippet ? `
**Current Code**:
\`\`\`
${finding.codeSnippet}
\`\`\`
` : ''}

Please provide:
1. The specific fix (actual code I can use)
2. Explanation of why this fix addresses the issue
3. Any additional changes that might be needed elsewhere
4. How to verify the fix works correctly`;
}

/**
 * Build prompt for "Is this a false positive?" quick action
 */
export function buildFalsePositiveCheckPrompt(finding) {
    return `Please analyze whether this finding might be a false positive:

**Issue**: ${finding.originalText || finding.message}
**Severity**: ${finding.severity}
**Location**: ${finding.file || 'Unknown'}${finding.lineNumber ? `:${finding.lineNumber}` : ''}
${finding.ruleId ? `**Rule**: ${finding.ruleId}` : ''}
${finding.codeSnippet ? `
**Code**:
\`\`\`
${finding.codeSnippet}
\`\`\`
` : ''}
${finding.confidence ? `**Detection Confidence**: ${Math.round(finding.confidence * 100)}%` : ''}

Please analyze:
1. Is this likely a true positive or false positive?
2. What context would make this a false positive?
3. What additional information would help determine this?
4. If it's a true positive, what's the impact?
5. Recommended action: fix, investigate further, or dismiss?`;
}

/**
 * Build prompt for PR refinement requests
 * e.g., "focus on security", "show me performance issues"
 */
export function buildRefinementPrompt(session, request) {
    const { prData, analysis } = session;

    const focusAreas = {
        security: 'security vulnerabilities, injection attacks, authentication issues, sensitive data exposure',
        performance: 'performance bottlenecks, memory leaks, N+1 queries, inefficient algorithms',
        bugs: 'logic errors, null pointer issues, race conditions, edge cases',
        style: 'code style, naming conventions, documentation, maintainability',
        testing: 'test coverage gaps, missing edge case tests, test quality issues'
    };

    const focus = focusAreas[request.toLowerCase()] || request;

    return `Based on the previous PR analysis, please provide a focused review on: **${focus}**

## PR Context
- **Title**: ${prData.title}
- **Files Changed**: ${prData.filesCount}
- **Stats**: +${prData.stats?.additions || 0} -${prData.stats?.deletions || 0}

## Previous Analysis Summary
${analysis?.llmAnalysis ? `The previous analysis found issues. Now focus specifically on ${focus}.` : 'No previous analysis available.'}

Please provide:
1. All issues related to ${focus}
2. Severity rating for each
3. Specific locations and fixes
4. Overall assessment of ${focus} concerns in this PR`;
}

/**
 * Build prompt for comparing with previous review
 */
export function buildComparisonPrompt(currentFindings, previousFindings) {
    return `Compare the current PR review findings with the previous review:

## Current Findings (${currentFindings.length})
${currentFindings.map(f => `- [${f.severity}] ${f.message}`).join('\n')}

## Previous Findings (${previousFindings.length})
${previousFindings.map(f => `- [${f.severity}] ${f.message}`).join('\n')}

Please analyze:
1. Which issues are new in the current review?
2. Which issues were resolved since the previous review?
3. Which issues remain unaddressed?
4. Overall progress assessment`;
}

/**
 * Quick action prompts configuration
 */
export const QUICK_ACTIONS = [
    {
        id: 'explain',
        label: 'Explain',
        icon: 'HelpCircle',
        description: 'Get a detailed explanation of this issue',
        buildPrompt: buildExplainPrompt
    },
    {
        id: 'fix',
        label: 'How to Fix',
        icon: 'Wrench',
        description: 'Get specific code to fix this issue',
        buildPrompt: buildHowToFixPrompt
    },
    {
        id: 'false-positive',
        label: 'False Positive?',
        icon: 'AlertCircle',
        description: 'Check if this might be a false positive',
        buildPrompt: buildFalsePositiveCheckPrompt
    }
];

/**
 * Get quick action by ID
 */
export function getQuickAction(actionId) {
    return QUICK_ACTIONS.find(a => a.id === actionId);
}

/**
 * Build suggested follow-up questions based on finding type
 */
export function getSuggestedQuestions(finding) {
    const baseQuestions = [
        'Can you explain this issue in more detail?',
        'How do I fix this?',
        'Is this a false positive?'
    ];

    const typeSpecificQuestions = {
        security: [
            'What is the security impact of this vulnerability?',
            'How could an attacker exploit this?',
            'What are the OWASP guidelines for this?'
        ],
        bug: [
            'What conditions trigger this bug?',
            'How can I write a test to catch this?',
            'Are there similar issues elsewhere in the code?'
        ],
        performance: [
            'What is the performance impact?',
            'How can I measure the improvement after fixing?',
            'Are there any trade-offs with the suggested fix?'
        ],
        style: [
            'What is the recommended pattern for this?',
            'Is there an ESLint rule for this?',
            'Should I fix similar issues across the codebase?'
        ]
    };

    const typeQuestions = typeSpecificQuestions[finding.type] || [];

    return [...baseQuestions, ...typeQuestions].slice(0, 5);
}

export default {
    THREAD_SYSTEM_PROMPT,
    buildFindingFollowUpPrompt,
    buildExplainPrompt,
    buildHowToFixPrompt,
    buildFalsePositiveCheckPrompt,
    buildRefinementPrompt,
    buildComparisonPrompt,
    QUICK_ACTIONS,
    getQuickAction,
    getSuggestedQuestions
};

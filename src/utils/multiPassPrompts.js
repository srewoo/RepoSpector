// Multi-pass PR review prompts for per-file analysis and aggregation

/**
 * Language-specific review rules injected into per-file prompts
 */
export const LANGUAGE_REVIEW_RULES = {
    javascript: {
        deprecated: [
            'substr() → use substring() or slice()',
            '__proto__ → use Object.getPrototypeOf()',
            'arguments.callee → use named functions',
            'with statement → use destructuring',
            'document.write() → use DOM APIs',
            'escape()/unescape() → use encodeURIComponent()/decodeURIComponent()'
        ],
        securityChecks: [
            'eval(), new Function(), setTimeout(string) → code injection',
            'innerHTML without sanitization → XSS',
            'postMessage without origin validation',
            'prototype pollution via Object.assign/spread on user input',
            'RegExp with user input without escaping → ReDoS',
            'Hardcoded secrets, API keys, tokens in source'
        ],
        performanceChecks: [
            'Synchronous XHR in main thread',
            'Missing useMemo/useCallback/React.memo causing unnecessary re-renders',
            'Importing entire lodash vs lodash/specific',
            'Memory leaks from uncleared setInterval/addEventListener',
            'Large objects in closure scope'
        ],
        patterns: [
            'Promise without .catch() or try/catch around await',
            'async function without error handling',
            'console.log left in production code',
            '== instead of === (type coercion)',
            'Missing cleanup in useEffect return'
        ]
    },
    typescript: {
        deprecated: [
            'namespace keyword → use ES modules',
            '<Type> casting → use "as Type"',
            'Plus all JavaScript deprecated APIs'
        ],
        securityChecks: [
            'Type assertions (as any) bypassing type safety',
            '@ts-ignore suppressing real errors',
            'Non-null assertions (!) hiding null safety',
            'Plus all JavaScript security checks'
        ],
        performanceChecks: [
            'Same as JavaScript performance checks'
        ],
        patterns: [
            'any type usage where specific types exist',
            'Missing return types on public methods',
            'Enum vs const enum vs union types',
            'Plus all JavaScript patterns'
        ]
    },
    python: {
        deprecated: [
            'datetime.utcnow() / utcfromtimestamp() → use datetime.now(timezone.utc)',
            'os.popen() → use subprocess.run()',
            'asyncio.get_event_loop() → use asyncio.get_running_loop()',
            'typing.Dict/List/Tuple → use dict/list/tuple (3.9+)',
            'unittest.assertEquals → use assertEqual',
            'collections.MutableMapping → use collections.abc.MutableMapping'
        ],
        securityChecks: [
            'pickle.loads() on untrusted data → deserialization attack',
            'yaml.load() without Loader → use safe_load()',
            'os.system() / subprocess with shell=True',
            'str.format() with user input → format string attack',
            'SQL string concatenation → use parameterized queries',
            'eval()/exec() on user input'
        ],
        performanceChecks: [
            'N+1 queries in ORM loops',
            'List comprehension vs generator for large datasets',
            'Global interpreter lock considerations for threading',
            'String concatenation in loops → use join()'
        ],
        patterns: [
            'Bare except: clause (catches SystemExit, KeyboardInterrupt)',
            'Mutable default arguments (def f(x=[]))',
            'logger.exception() outside except block',
            'Wrong logging level (logger.info for errors)',
            'Missing __init__.py for package structure'
        ]
    },
    java: {
        deprecated: [
            'Date/Calendar → use java.time (LocalDate, Instant)',
            'Vector/Hashtable → use ArrayList/HashMap',
            'Thread.stop()/suspend()/resume()',
            'finalize() method',
            'StringBuffer → StringBuilder (single-threaded)'
        ],
        securityChecks: [
            'SQL concatenation → use PreparedStatement',
            'XML parsing without disabling external entities (XXE)',
            'Deserialization of untrusted data (ObjectInputStream)',
            'Hardcoded credentials in source',
            'Reflection on user-controlled class names'
        ],
        performanceChecks: [
            'String concatenation in loops → use StringBuilder',
            'Autoboxing in tight loops',
            'Unclosed resources → use try-with-resources',
            'N+1 JPA/Hibernate queries'
        ],
        patterns: [
            'Catching Exception instead of specific exceptions',
            'Empty catch blocks',
            'equals() without hashCode()',
            'Missing null checks on return values'
        ]
    },
    go: {
        deprecated: [
            'ioutil package → use io and os directly (Go 1.16+)'
        ],
        securityChecks: [
            'fmt.Sprintf in SQL queries → use parameterized queries',
            'Unvalidated HTTP redirects',
            'TLS InsecureSkipVerify=true',
            'os/exec with user input'
        ],
        performanceChecks: [
            'Goroutine leaks (unbuffered channels, missing context cancellation)',
            'Allocations in hot paths → use sync.Pool',
            'defer in loops (defer executes at function exit, not loop iteration)'
        ],
        patterns: [
            'Error return value ignored',
            'Goroutine without WaitGroup or context',
            'Race condition on shared state without mutex',
            'Nil pointer dereference on interface assertion'
        ]
    },
    ruby: {
        deprecated: [
            'URI.escape → use CGI.escape or URI::DEFAULT_PARSER',
            'File.exists? → use File.exist?',
            'Fixnum/Bignum → use Integer'
        ],
        securityChecks: [
            'send() with user-controlled method name',
            'system()/exec() with user input',
            'YAML.load → use YAML.safe_load',
            'ERB template injection'
        ],
        performanceChecks: [
            'N+1 queries → use includes/eager_load',
            'Each vs find_each for large datasets'
        ],
        patterns: [
            'Rescue Exception instead of StandardError',
            'Missing frozen_string_literal comment'
        ]
    },
    php: {
        deprecated: [
            'mysql_* functions → use mysqli or PDO',
            'ereg() → use preg_match()',
            'each() → use foreach'
        ],
        securityChecks: [
            'SQL concatenation → use prepared statements',
            'exec()/system()/passthru() with user input',
            'unserialize() on untrusted data',
            'include/require with user-controlled path'
        ],
        performanceChecks: [
            'Count() inside loop condition',
            'Loading all DB records into memory'
        ],
        patterns: [
            'Missing type declarations (PHP 7+)',
            'Loose comparison (== vs ===) with type-sensitive values'
        ]
    },
    csharp: {
        deprecated: [
            'WebRequest → use HttpClient',
            'ArrayList → use List<T>',
            'Thread.Abort() → use CancellationToken'
        ],
        securityChecks: [
            'SQL string concatenation → use parameterized queries',
            'BinaryFormatter deserialization → use System.Text.Json',
            'Regex without timeout → ReDoS'
        ],
        performanceChecks: [
            'String concatenation in loops → use StringBuilder',
            'LINQ in hot paths without materialization',
            'Missing ConfigureAwait(false) in library code',
            'Unclosed IDisposable → use using statement'
        ],
        patterns: [
            'Catching Exception instead of specific types',
            'async void (except event handlers)',
            'Missing null checks (use nullable reference types)'
        ]
    },
    rust: {
        deprecated: [],
        securityChecks: [
            'unsafe blocks without justification',
            'unwrap() on user input → use proper error handling',
            'Raw SQL without parameterization'
        ],
        performanceChecks: [
            'Unnecessary clone() → use references',
            'collect() on large iterators without size hint',
            'Box<dyn Trait> where generics suffice'
        ],
        patterns: [
            'unwrap()/expect() in library code → return Result',
            'Unused Result (must_use)',
            'Mutex poisoning not handled'
        ]
    },
    kotlin: {
        deprecated: [
            'Java Date → use java.time or kotlinx-datetime'
        ],
        securityChecks: [
            'Same as Java security checks'
        ],
        performanceChecks: [
            'Creating unnecessary intermediate collections',
            'Coroutine scope leaks'
        ],
        patterns: [
            '!! (non-null assertion) → use safe calls or let',
            'Missing sealed class exhaustive when',
            'Mutable collections exposed as public API'
        ]
    }
};

/**
 * Get language-specific review rules
 */
export function getLanguageRules(language) {
    if (!language) return LANGUAGE_REVIEW_RULES.javascript;
    const lang = language.toLowerCase();
    // Handle aliases
    const aliases = {
        'js': 'javascript', 'jsx': 'javascript', 'mjs': 'javascript',
        'ts': 'typescript', 'tsx': 'typescript',
        'py': 'python',
        'rb': 'ruby',
        'cs': 'csharp',
        'rs': 'rust',
        'kt': 'kotlin', 'kts': 'kotlin'
    };
    return LANGUAGE_REVIEW_RULES[aliases[lang] || lang] || LANGUAGE_REVIEW_RULES.javascript;
}

// ─── System Prompts ───

export const PER_FILE_REVIEW_SYSTEM_PROMPT = `You are RepoSpector, an AI code reviewer analyzing a single file change within a Pull Request. You review with the precision of a senior engineer — finding real bugs, security issues, and quality problems while avoiding false positives.

## Output Rules
- Respond with ONLY a valid JSON object. No markdown outside the JSON, no explanatory text.
- Every finding MUST reference a specific line number from the diff.
- Assign confidence scores honestly: 0.9+ only for certain issues, 0.5-0.7 for likely issues, below 0.5 for suspicions.
- If the file looks clean, return an empty findings array — do NOT fabricate issues.
- Focus exclusively on the CHANGED lines (+ lines in the diff), but use unchanged context lines to understand intent.

## Review Priorities (in order)
1. Security vulnerabilities with exploitable impact
2. Bugs that will cause runtime failures or incorrect behavior
3. Behavioral changes that silently alter existing functionality
4. Deprecated API usage that should be modernized
5. Performance regressions or anti-patterns
6. Code quality and maintainability issues

## Bug Detection Checklist (apply to EVERY changed function/method)
- NULL/UNDEFINED: Can any variable be null/undefined when accessed? Check every .property chain and function argument.
- OFF-BY-ONE: Are loop boundaries correct? Are array indices within bounds? Is <= vs < correct?
- RACE CONDITIONS: Can concurrent calls cause data corruption? Are shared resources protected?
- ERROR PATHS: What happens when this code fails? Is the error caught? Is cleanup done? Are resources released?
- EDGE CASES: Empty arrays, empty strings, zero values, negative numbers, very large inputs, unicode characters.
- TYPE COERCION: Are comparisons type-safe? Could implicit conversion produce wrong results?
- STATE MUTATION: Does this modify shared state? Could callers be surprised by side effects?
- RESOURCE LEAKS: Are file handles, connections, timers, and event listeners properly cleaned up?
- BACKWARDS COMPATIBILITY: Does this change break any existing callers or API contracts?`;

export const AGGREGATION_SYSTEM_PROMPT = `You are RepoSpector performing the final synthesis of a multi-pass Pull Request review. You received structured per-file findings from individual file reviews. Your job is to:

1. DEDUPLICATE: Merge findings that describe the same underlying issue across files. Keep the highest severity and confidence.
2. CROSS-REFERENCE: Identify cross-file issues that individual reviews missed:
   - Interface contract violations (signature changed in one file, callers not updated)
   - Inconsistent patterns (error handling done differently across files)
   - Missing test files for changed source files
   - Configuration changes that affect other changed files
3. ELEVATE OR DEMOTE: Adjust severity based on cross-file context (a "medium" finding may become "high" if it affects multiple files)
4. SYNTHESIZE: Produce the final review in the exact markdown format specified.

Be thorough but precise. Every finding must be actionable.`;

// ─── Prompt Builders ───

/**
 * Build a lightweight PR context summary (no diffs from other files)
 */
export function buildPRContextSummary(prData) {
    return {
        title: prData.title || 'Unknown',
        purpose: (prData.description || 'No description').substring(0, 300),
        sourceBranch: prData.branches?.source || 'unknown',
        targetBranch: prData.branches?.target || 'unknown',
        otherFiles: (prData.files || []).map(f => f.filename).slice(0, 30),
        totalAdditions: prData.stats?.additions || 0,
        totalDeletions: prData.stats?.deletions || 0,
        isDraft: prData.isDraft || false,
        commitCount: prData.commits?.length || 0
    };
}

/**
 * Build per-file review prompt
 * @param {Object} unit - ReviewUnit from FileGroupingStrategy
 * @param {Object} context - { prContext, focusAreas, ragChunks, staticFindings, languageRules }
 */
export function buildPerFileReviewPrompt(unit, context = {}) {
    const { prContext, focusAreas = [], ragChunks, staticFindings, languageRules } = context;

    // Build file diffs section
    const fileDiffs = unit.files.map(f => `### File: ${f.filename} (${f.status || 'modified'})
**Language**: ${f.language || 'unknown'} | **Changes**: +${f.additions || 0} -${f.deletions || 0}

\`\`\`diff
${f.patch || 'No patch available'}
\`\`\``).join('\n\n');

    const primaryLang = unit.files[0]?.language || 'unknown';

    let prompt = `## Per-File Code Review

### PR Context
- **Title**: ${prContext?.title || 'Unknown'}
- **Purpose**: ${prContext?.purpose || 'No description'}
- **Branch**: \`${prContext?.sourceBranch || '?'}\` → \`${prContext?.targetBranch || '?'}\`
- **Other files in this PR**: ${(prContext?.otherFiles || []).filter(f => !unit.files.some(uf => uf.filename === f)).slice(0, 15).join(', ') || 'none'}

---

## Files Under Review

${fileDiffs}
`;

    // Inject static analysis findings for these files
    if (staticFindings && staticFindings.length > 0) {
        prompt += `\n---\n\n## Pre-detected Static Analysis Findings\n`;
        for (const f of staticFindings.slice(0, 10)) {
            prompt += `- **${(f.severity || 'info').toUpperCase()}** [${f.ruleId || f.category || 'rule'}] ${f.filePath || ''}:${f.line || '?'} — ${f.message}\n`;
        }
        prompt += `\nValidate these findings and find any issues the static analyzers missed.\n`;
    }

    // Inject per-file RAG context
    if (ragChunks && ragChunks.length > 0) {
        prompt += `\n---\n\n## Related Repository Code (for understanding context)\n`;
        for (const chunk of ragChunks.slice(0, 3)) {
            const source = chunk.filePath || chunk.file || 'context';
            const content = (chunk.content || chunk.text || '').substring(0, 600);
            prompt += `\`\`\`\n// ${source}\n${content}\n\`\`\`\n\n`;
        }
    }

    // Language-specific rules
    const rules = languageRules || getLanguageRules(primaryLang);
    prompt += `\n---\n\n## Language-Specific Checks (${primaryLang})\n`;
    if (rules.deprecated?.length) prompt += `**Deprecated APIs**: ${rules.deprecated.slice(0, 5).join('; ')}\n`;
    if (rules.securityChecks?.length) prompt += `**Security Patterns**: ${rules.securityChecks.slice(0, 5).join('; ')}\n`;
    if (rules.performanceChecks?.length) prompt += `**Performance Anti-patterns**: ${rules.performanceChecks.slice(0, 4).join('; ')}\n`;
    if (rules.patterns?.length) prompt += `**Common Bugs**: ${rules.patterns.slice(0, 4).join('; ')}\n`;

    // Focus areas
    if (focusAreas.length > 0) {
        prompt += `\n**Review Focus**: ${focusAreas.join(', ')}\n`;
    }

    // Required output format
    const fileNames = unit.files.map(f => `"${f.filename}"`).join(' or ');
    prompt += `
---

## Required Response Format

Respond with ONLY a JSON object (no markdown fences, no text outside JSON):

{
  "file": ${fileNames.includes(' or ') ? '"primary_filename"' : fileNames},
  "language": "${primaryLang}",
  "fileVerdict": "APPROVE | NEEDS_CHANGES | DISCUSS",
  "riskLevel": "LOW | MEDIUM | HIGH | CRITICAL",
  "findings": [
    {
      "id": "F1",
      "file": "filename_where_issue_is",
      "line": 42,
      "severity": "critical | high | medium | low",
      "type": "security | bug | performance | style | deprecated | testing",
      "cwe": "CWE-ID or null",
      "title": "Concise issue title (under 100 chars)",
      "description": "What is wrong and why",
      "impact": "What could go wrong in production",
      "suggestion": "Specific code fix or recommendation",
      "confidence": 0.85
    }
  ],
  "positives": ["Good patterns observed in this file"],
  "testCoverage": {
    "hasTests": false,
    "missingTests": ["Concrete test scenario: e.g. 'Test login() with expired token returns 401'"]
  },
  "criticalTestCases": [
    "Specific test case tied to a finding: e.g. 'Verify SQL query in getUser() is parameterized (F1)'"
  ]
}

Be thorough. Report EVERY real issue. Reference exact line numbers from the diff.`;

    return prompt;
}

/**
 * Build aggregation/synthesis prompt from per-file findings
 * @param {Array} perFileResults - Array of parsed per-file JSON results
 * @param {Object} context - { prData, failedFiles, commitMessages }
 */
export function buildAggregationPrompt(perFileResults, context = {}) {
    const { prData, failedFiles = [], commitMessages = '' } = context;

    // Build compact findings summary
    const findingsSummary = perFileResults.map(r => ({
        file: r.file,
        language: r.language,
        verdict: r.fileVerdict,
        risk: r.riskLevel,
        findings: (r.findings || []).map(f => ({
            id: f.id, file: f.file || r.file, line: f.line,
            severity: f.severity, type: f.type, cwe: f.cwe,
            title: f.title, description: f.description,
            impact: f.impact, suggestion: f.suggestion,
            confidence: f.confidence
        })),
        positives: r.positives,
        testCoverage: r.testCoverage
    }));

    // Count findings by severity
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const r of perFileResults) {
        for (const f of (r.findings || [])) {
            if (counts[f.severity] !== undefined) counts[f.severity]++;
        }
    }

    // Build commit messages
    const commits = commitMessages || (prData?.commits || []).map(c =>
        `- ${(c.sha || '').substring(0, 7)}: ${(c.message || '').split('\n')[0]}`
    ).join('\n');

    let prompt = `## PR Aggregation Review

### PR Metadata
- **Title**: ${prData?.title || 'Unknown'}
- **Author**: ${prData?.author?.login || 'Unknown'}
- **State**: ${prData?.state || 'open'} ${prData?.isDraft ? '(Draft)' : ''} ${prData?.merged ? '(Merged)' : ''}
- **Branch**: \`${prData?.branches?.source || '?'}\` → \`${prData?.branches?.target || '?'}\`
- **Total Files**: ${prData?.stats?.changedFiles || prData?.files?.length || 0}
- **Total Changes**: +${prData?.stats?.additions || 0} -${prData?.stats?.deletions || 0}

### Commits
${commits || 'No commits available'}

### PR Description
${(prData?.description || 'No description provided').substring(0, 1000)}

---

### Finding Summary (from ${perFileResults.length} file reviews)
- Critical: ${counts.critical}
- High: ${counts.high}
- Medium: ${counts.medium}
- Low: ${counts.low}
${failedFiles.length > 0 ? `- **Files not reviewed** (errors): ${failedFiles.join(', ')}` : ''}

### Per-File Findings

\`\`\`json
${JSON.stringify(findingsSummary, null, 1)}
\`\`\`

---

### Cross-File Analysis Required
Analyze the per-file findings above for:
1. **Interface breakage**: Function signatures changed in one file while callers in other files still use old signatures?
2. **Pattern inconsistency**: Same operations handled differently across files (error handling, logging, validation)?
3. **Missing tests**: For each changed source file, is there a corresponding test change in this PR?
4. **Configuration impact**: Do config changes affect behavior of other changed files?
5. **Dependency chain**: If file A imports from file B and both changed, are changes compatible?

---

### Required Output Format

\`\`\`
VERDICT: [APPROVE / REQUEST_CHANGES / COMMENT]
RISK_LEVEL: [LOW / MEDIUM / HIGH / CRITICAL]
CONFIDENCE: [HIGH / MEDIUM / LOW]
BLOCKING_ISSUES: [count]
TOTAL_FINDINGS: [X critical, Y high, Z medium, W low]
\`\`\`

### Critical Issues (Must Fix Before Merge)
For each:
- **File**: [filename(s)]
- **Line**: [line number(s)]
- **Type**: [Security/Bug/Performance]
- **Severity**: Critical or High
- **CWE**: [if applicable]
- **Confidence**: [0.0-1.0]
- **Issue**: [Clear description]
- **Impact**: [What could go wrong]
- **Fix**: [Specific suggestion]

### Warnings (Should Fix)
Same format, severity Medium

### Suggestions (Nice to Have)
Brief list, severity Low

### Cross-File Issues
Issues spanning multiple files not visible in per-file review

### Security Checklist
- [ ] No hardcoded secrets or API keys
- [ ] Input validation on all user inputs
- [ ] Output encoding where needed
- [ ] Auth/authz checks on new endpoints
- [ ] No sensitive data in logs
- [ ] SQL queries are parameterized

### Test Coverage Assessment
- Files missing tests: [list from per-file reviews]
- Test quality: [Are existing tests sufficient? Do they cover the changed behavior?]

### P0 Test Cases (Must-Have Before Merge)
For each critical/high finding and each major behavioral change, draft a concrete test case:

| # | Test Scenario | File Under Test | What to Assert | Why P0 |
|---|--------------|-----------------|----------------|--------|
| 1 | [Specific scenario, e.g., "Call login() with expired token"] | [filename] | [Expected behavior, e.g., "Should return 401, not crash"] | [Linked to finding F1 or behavioral change] |
| 2 | ... | ... | ... | ... |

Include at least:
- 1 test per critical/high finding (verifying the fix works)
- 1 test per behavioral change (verifying old behavior is preserved or new behavior is intentional)
- 1 negative/edge case test (what happens with bad input, empty data, concurrent access)
- Aim for 5-10 P0 test cases total

### Positive Observations
Good patterns found across the PR

### Final Verdict
**Recommendation**: [Clear action item]
**Blocking Issues**: [count]
**Total Issues Found**: [count by severity]`;

    return prompt;
}

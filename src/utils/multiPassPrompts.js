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

export const PER_FILE_REVIEW_SYSTEM_PROMPT = `You are RepoSpector, a senior staff engineer performing a per-file code review. Your reputation depends on catching REAL bugs that would break production — not on listing generic suggestions.

## Your Review Process (MANDATORY — follow these steps IN ORDER)

### Step 1: Read the diff line by line
Before producing ANY output, mentally walk through every "+" line in the diff. For each changed line, ask:
- What function is being called? Is it on the deprecated list for this language?
- What data flows into this line? Can it be null/empty/wrong type?
- Does this line change existing behavior? (e.g., a filter condition widened, a constant replaced, a default value changed)
- Is this API being used correctly? (e.g., logger.exception only works inside except blocks)
- Does the variable/function name match what it actually does?

### Step 2: Cross-reference against the Language-Specific Checks
The user prompt includes a "Language-Specific Checks" section with deprecated APIs, security patterns, and common bugs for this language. You MUST check EVERY function call in the diff against those lists. If a deprecated API is called, report it.

### Step 3: Produce findings
Report every real issue found in Steps 1-2. Each finding MUST have:
- A specific line number from the diff
- A concrete description of what is wrong
- A specific fix (not "consider using X" but "replace X with Y")

## What Goes In Findings vs TestCoverage
- **findings array**: ACTUAL CODE DEFECTS — deprecated APIs, bugs, security issues, behavioral changes, incorrect API usage, naming inconsistencies. These are problems IN the code being reviewed.
- **testCoverage field**: Missing test scenarios. NEVER put "missing tests" in findings.

## Severity Guide
- **critical**: Will cause data loss, security breach, or crash in production
- **high**: Bug that produces wrong results, deprecated API with known replacement, behavioral change that breaks callers
- **medium**: Code quality issue that could cause future bugs, performance anti-pattern
- **low**: Style issue, minor naming inconsistency

## Example Finding (this is what a GOOD finding looks like)
\`\`\`json
{
  "id": "F1",
  "file": "services/user_service.py",
  "line": 47,
  "severity": "high",
  "type": "deprecated",
  "cwe": null,
  "title": "datetime.utcfromtimestamp() is deprecated since Python 3.12",
  "description": "Line 47 calls datetime.utcfromtimestamp(ts) which returns a naive UTC datetime. This is deprecated and will be removed. It also causes timezone bugs when compared with timezone-aware datetimes.",
  "impact": "Will emit DeprecationWarning in Python 3.12+ and break in future Python versions. Timezone-naive comparison bugs possible.",
  "suggestion": "Replace with: datetime.fromtimestamp(ts, tz=timezone.utc)",
  "confidence": 0.95
}
\`\`\`

## Output Format
Respond with ONLY a valid JSON object. No markdown, no explanation text outside the JSON.
Assign confidence honestly: 0.9+ for certain issues, 0.6-0.8 for likely issues, below 0.5 for uncertain.
Focus on CHANGED lines (+ lines), but use context lines to understand intent.
If the code is genuinely clean with no issues, return an empty findings array — but this should be RARE. Most real-world diffs have at least one issue.`;

export const AGGREGATION_SYSTEM_PROMPT = `You are RepoSpector performing the final synthesis of a multi-pass Pull Request review. You received structured per-file findings from individual file reviews.

## Your Job
1. PRESERVE ALL CODE DEFECTS: Every finding from per-file reviews that describes a real code issue (deprecated API, bug, security, behavioral change, incorrect API usage) MUST appear in your output. Do NOT drop or minimize per-file findings.
2. DEDUPLICATE: If the exact same issue appears in multiple files, merge them (keep highest severity/confidence). But different issues in different files are NOT duplicates.
3. CROSS-REFERENCE: Find issues the per-file reviews missed:
   - Interface contract violations (signature changed in one file, callers not updated)
   - Inconsistent patterns across files (error handling, naming conventions)
   - Configuration changes that affect other changed files
4. ELEVATE severity when cross-file context makes an issue worse (e.g., a deprecated API used in multiple files → elevate to high)
5. FORMAT the output in the exact markdown structure specified.

## Critical Rule
If per-file reviews found N total findings with severity >= medium, your output MUST contain at least N findings in the Critical/Warnings sections (after deduplication). Do NOT silently drop findings or convert code defects into suggestions.`;

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

    const primaryLang = unit.files[0]?.language || 'unknown';
    const rules = languageRules || getLanguageRules(primaryLang);

    // ── Section 1: PR Context (brief) ──
    let prompt = `## PR Context
- **Title**: ${prContext?.title || 'Unknown'}
- **Purpose**: ${prContext?.purpose || 'No description'}
- **Branch**: \`${prContext?.sourceBranch || '?'}\` → \`${prContext?.targetBranch || '?'}\`
- **Other files in this PR**: ${(prContext?.otherFiles || []).filter(f => !unit.files.some(uf => uf.filename === f)).slice(0, 15).join(', ') || 'none'}

---

`;

    // ── Section 2: Language rules FIRST (so LLM reads rules before the diff) ──
    prompt += `## Language-Specific Checks for ${primaryLang} — APPLY THESE TO EVERY LINE IN THE DIFF\n\n`;
    if (rules.deprecated?.length) {
        prompt += `### Deprecated APIs (flag EVERY occurrence):\n`;
        for (const d of rules.deprecated) prompt += `- ${d}\n`;
    }
    if (rules.securityChecks?.length) {
        prompt += `\n### Security Patterns (flag if found):\n`;
        for (const s of rules.securityChecks) prompt += `- ${s}\n`;
    }
    if (rules.patterns?.length) {
        prompt += `\n### Common Bugs (flag if found):\n`;
        for (const p of rules.patterns) prompt += `- ${p}\n`;
    }
    if (rules.performanceChecks?.length) {
        prompt += `\n### Performance Anti-patterns:\n`;
        for (const p of rules.performanceChecks) prompt += `- ${p}\n`;
    }

    // Focus areas
    if (focusAreas.length > 0) {
        prompt += `\n**Additional Focus**: ${focusAreas.join(', ')}\n`;
    }

    // ── Section 3: Static analysis findings (if any) ──
    if (staticFindings && staticFindings.length > 0) {
        prompt += `\n---\n\n## Pre-detected Static Analysis Findings\n`;
        for (const f of staticFindings.slice(0, 10)) {
            prompt += `- **${(f.severity || 'info').toUpperCase()}** [${f.ruleId || f.category || 'rule'}] ${f.filePath || ''}:${f.line || '?'} — ${f.message}\n`;
        }
        prompt += `\nValidate these AND find issues the static analyzers missed.\n`;
    }

    // ── Section 4: RAG context ──
    if (ragChunks && ragChunks.length > 0) {
        prompt += `\n---\n\n## Related Repository Code (for understanding context)\n`;
        for (const chunk of ragChunks.slice(0, 3)) {
            const source = chunk.filePath || chunk.file || 'context';
            const content = (chunk.content || chunk.text || '').substring(0, 600);
            prompt += `\`\`\`\n// ${source}\n${content}\n\`\`\`\n\n`;
        }
    }

    // ── Section 5: The diff (LAST — so LLM applies rules while reading it) ──
    prompt += `\n---\n\n## Files Under Review — APPLY ALL CHECKS ABOVE TO EVERY + LINE\n\n`;

    for (const f of unit.files) {
        prompt += `### File: ${f.filename} (${f.status || 'modified'})
**Language**: ${f.language || 'unknown'} | **Changes**: +${f.additions || 0} -${f.deletions || 0}

\`\`\`diff
${f.patch || 'No patch available'}
\`\`\`

`;
    }

    // ── Section 6: Required output ──
    const fileNames = unit.files.map(f => `"${f.filename}"`).join(' or ');
    prompt += `---

## Required Response — JSON ONLY

Respond with ONLY a JSON object. No markdown fences. No text before or after.

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
      "type": "security | bug | performance | style | deprecated",
      "cwe": "CWE-ID or null",
      "title": "Concise title (under 100 chars)",
      "description": "What is wrong and why — reference the specific code on this line",
      "impact": "What could go wrong in production",
      "suggestion": "Replace X with Y (be specific, not vague)",
      "confidence": 0.85
    }
  ],
  "positives": ["Good patterns observed"],
  "testCoverage": {
    "hasTests": false,
    "missingTests": ["Test scenario descriptions go HERE, not in findings"]
  },
  "criticalTestCases": [
    "Specific test tied to finding: e.g. 'Verify F1 fix: call fromtimestamp(tz=timezone.utc)'"
  ]
}

IMPORTANT REMINDERS:
- Check every function call against the deprecated list above. Each deprecated call = one finding.
- If a filter/query/condition changed, report what behavior changed and whether it's intentional.
- "missing tests" go in testCoverage, NEVER in findings.
- Every finding needs a specific line number and a concrete fix.`;

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

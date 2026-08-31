// Multi-pass PR review prompts for per-file analysis and aggregation

import { formatPatchWithLineNumbers } from './patchLines.js';
import { resolveBudget } from './reviewContextBudget.js';
import { expandPatch, shouldPreferExpansion } from './dynamicContext.js';
import { stripDeletionOnlyHunks, renderOmittedFiles } from './diffBudget.js';

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
            'Missing cleanup in useEffect return',
            '`x || default` used where `x ?? default` is intended → `||` also replaces falsy values (0, "", false), not just null/undefined',
            'Over-broad gate: an `if (x)` guard wrapping a statement that also sets an unrelated field → the unrelated field silently never gets set; gate each concern separately',
            'Timeout/TTL/retry/concurrency constant changed by a large factor (e.g. 86400 → 300) without a comment justifying the trade-off'
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
            'String concatenation in loops → use join()',
            'HTTP client (httpx.AsyncClient/requests.Session) constructed inside a retry loop instead of hoisted above it → loses connection pooling/keep-alive, extra TCP+TLS handshake per attempt'
        ],
        patterns: [
            'Bare except: clause (catches SystemExit, KeyboardInterrupt)',
            'Mutable default arguments (def f(x=[]))',
            'logger.exception() outside except block',
            'Wrong logging level (logger.info for errors)',
            'Missing __init__.py for package structure',
            'HTTP response not closed on a retry/fallback path (continue in a retry loop, or response reassigned on a 401/403 auth fallback) → connection-pool leak; httpx.Response has no __del__, so read/aclose() the prior response before reassigning or continuing',
            '`x or default` used where `dict.get(key, default)` is intended → `or` also replaces falsy values ("", 0, False), not just a missing key; often untested',
            'Over-broad gate drops a sibling assignment: an `if x:` guard wrapping a statement (e.g. dataclasses.replace) that ALSO sets an unrelated field → the unrelated field silently never gets set. Gate each concern on its own truthiness',
            'Non-200 (e.g. 404) recorded as a circuit-breaker / health failure → breaker trips on healthy dependencies; treat 404 as terminal, not a server-health event'
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
            'Nil pointer dereference on interface assertion',
            'HTTP response body not closed on a retry/fallback path (continue in a retry loop, or resp reassigned) → connection-pool leak; defer resp.Body.Close() before any continue/reassign',
            'http.Client constructed inside a retry loop instead of hoisted → loses connection reuse',
            'Non-200 (e.g. 404) recorded as a circuit-breaker / health failure → breaker trips on healthy dependencies'
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
- **findings array**: ONLY observable code defects introduced by the change — bugs, exploitable security issues, breaking behavioral changes, and incorrect API usage with a concrete failure outcome.
- **testCoverage field**: Missing test scenarios. NEVER put "missing tests" in findings.

## Precision Contract
- An empty findings array is a successful, normal review result. Never invent a finding to make the review look useful.
- Do not report style, naming, formatting, documentation, maintainability preferences, speculative future risks, generic best practices, or optional refactors.
- Do not report missing tests as defects.
- Every finding must identify the exact changed line, quote the relevant code, and state a concrete input/state/sequence that produces an observable wrong outcome.
- If the evidence in this diff cannot prove the problem, omit it. A possible concern is not a finding.

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
Every diff is presented as numbered hunks: the number at the start of each line
in \`__new hunk__\` IS that line's number in the file. Report it verbatim.
If the code is clean or no defect can be proven from the supplied evidence, return an empty findings array.`;

export const AGGREGATION_SYSTEM_PROMPT = `You are RepoSpector performing the final synthesis of a multi-pass Pull Request review. You received structured per-file findings from individual file reviews.

## Your Job
1. PRESERVE ONLY PROVEN DEFECTS: Keep a per-file finding only when it identifies a concrete, observable failure supported by the supplied code. Drop style, optional improvements, missing-test complaints, and speculative risks.
2. DEDUPLICATE: If the exact same issue appears in multiple files, merge them (keep highest severity/confidence). But different issues in different files are NOT duplicates.
3. CROSS-REFERENCE: Find issues the per-file reviews missed:
   - Interface contract violations (signature changed in one file, callers not updated)
   - Inconsistent patterns across files (error handling, naming conventions)
   - Configuration changes that affect other changed files
4. ELEVATE severity when cross-file context makes an issue worse (e.g., a deprecated API used in multiple files → elevate to high)
5. FORMAT the output in the exact markdown structure specified.

## Critical Rule
It is correct to return zero findings. Never preserve a claim merely to match the number emitted by an earlier pass.`;

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
 * @returns {Array<{text: string, cache?: boolean}>} content parts — the shared
 *   preamble first (marked cacheable), then this unit's own material. Pass
 *   straight through as a message's `content`; LLMService joins them for any
 *   provider that has no cache-breakpoint format.
 */
export function buildPerFileReviewPrompt(unit, context = {}) {
    const {
        prContext,
        focusAreas = [],
        ragChunks,
        staticFindings,
        languageRules,
        conventionBlock = '',
        standardsText = '',
        // The repo's own AGENTS.md / CLAUDE.md, pre-rendered and sanitised by
        // RepoInstructionsService. Absent for repos that carry neither.
        repoInstructions = '',
        graphContext,
        // Phase 2 additions — see ReviewFileContextService / reviewIntentContext.
        fileContext = null,   // Map<filename, {fullContent, testPath, testContent, testFileMissing}>
        intentBlock = '',     // rendered Jira / pipeline / description context
        contextBudget = null, // see reviewContextBudget.js; defaults when absent
        // Per-file declaration ranges ({filename -> [{startLine, endLine}]}) used
        // to expand each hunk to its enclosing function/class. Absent for a
        // caller that has not run SymbolExtractor; expansion then falls back to a
        // fixed asymmetric window. See utils/dynamicContext.js.
        declarationsByFile = null,
        dynamicContext = null, // overrides for DYNAMIC_CONTEXT_DEFAULTS
        // Files this review unit changed but is NOT showing (dropped by the
        // diff budget). Rendered by name so the model cannot conclude that a
        // caller was never updated. See utils/diffBudget.js.
        omittedFiles = [],
        // Called once with what the diff section actually did, so the review's
        // stats block can report expansion/omission without this builder having
        // to change its return shape (an array of cache-marked parts).
        onContextStats = null,
    } = context;

    /** Filled in as files are rendered; surfaced on the returned prompt object. */
    const contextStats = { expandedFiles: 0, fullFileFiles: 0, deletionOnlyHunksRemoved: 0 };

    const budget = resolveBudget({ overrides: contextBudget || undefined });

    const primaryLang = unit.files[0]?.language || 'unknown';
    // Tolerate a caller that passes a pre-rendered string: fall back to the real
    // rule object rather than indexing into a string and silently rendering nothing.
    const rules = (languageRules && typeof languageRules === 'object')
        ? languageRules
        : getLanguageRules(primaryLang);

    // ── Section 1: PR Context (brief) ──
    //
    // Identical for every review unit in the PR, and first in the prompt, so it
    // forms the head of a prefix shared by all of them.
    //
    // The file list is NOT filtered to exclude this unit's own files, though
    // that reads like the obvious thing to do and is what this did before. A
    // per-unit filter makes line 1 of the prompt different for every call, and
    // since caching is a prefix match, that alone defeated caching for the whole
    // per-file pass. The unfiltered list is also the more accurate statement —
    // it is what the PR touches — and the diff below already tells the model
    // which files it is being asked about.
    let preamble = `## PR Context
- **Title**: ${prContext?.title || 'Unknown'}
- **Purpose**: ${prContext?.purpose || 'No description'}
- **Branch**: \`${prContext?.sourceBranch || '?'}\` → \`${prContext?.targetBranch || '?'}\`
- **Files in this PR**: ${(prContext?.otherFiles || []).slice(0, 15).join(', ') || 'none'}

---

`;

    // ── Section 1b: Intent — what this change is SUPPOSED to do ──
    // Without this the reviewer can only ask "is this code correct?", never
    // "is this the change that was asked for?". An unmet acceptance criterion
    // is a legitimate finding.
    if (intentBlock && String(intentBlock).trim()) {
        preamble += `${String(intentBlock).trim()}\n\n---\n\n`;
    }

    // ── Section 2: Language rules FIRST (so LLM reads rules before the diff) ──
    preamble += `## Language-Specific Checks for ${primaryLang} — APPLY THESE TO EVERY LINE IN THE DIFF\n\n`;
    if (rules.deprecated?.length) {
        preamble += `### Deprecated APIs (flag EVERY occurrence):\n`;
        for (const d of rules.deprecated) preamble += `- ${d}\n`;
    }
    if (rules.securityChecks?.length) {
        preamble += `\n### Security Patterns (flag if found):\n`;
        for (const s of rules.securityChecks) preamble += `- ${s}\n`;
    }
    if (rules.patterns?.length) {
        preamble += `\n### Common Bugs (flag if found):\n`;
        for (const p of rules.patterns) preamble += `- ${p}\n`;
    }
    if (rules.performanceChecks?.length) {
        preamble += `\n### Performance Anti-patterns:\n`;
        for (const p of rules.performanceChecks) preamble += `- ${p}\n`;
    }

    // Focus areas
    if (focusAreas.length > 0) {
        preamble += `\n**Additional Focus**: ${focusAreas.join(', ')}\n`;
    }

    // ── Section 2a: Written standards (bundled, or org-synced) ──
    // Reference material, not instructions: it is inserted under our heading and
    // sanitised upstream (StandardsSyncService.sanitize) precisely because it can
    // come from a remote document.
    if (standardsText && String(standardsText).trim()) {
        preamble += `\n### Written Coding Standards
Cite the rule ID in \`rule\` when a finding violates one of these.

${String(standardsText).slice(0, 6000)}
`;
    }

    // ── Section 2b: This team's own conventions ──
    // Mined by ConventionMiner from the repo's past review comments. These are
    // the findings a generic reviewer structurally cannot produce, so they get
    // their own heading rather than being buried in the generic rules.
    if (conventionBlock && String(conventionBlock).trim()) {
        preamble += `\n### This Repository's Own Review Conventions (mined from past review comments)
These are what THIS team actually asks for in review. Violations are real findings,
usually severity medium, category "conventions". Cite the convention in \`rule\`.

${String(conventionBlock).trim()}
`;
    }

    // ── Section 2c: The repo's own instruction files ──
    // AGENTS.md / CLAUDE.md, read from the DEFAULT BRANCH only — see
    // RepoInstructionsService for why that pin is the whole security model.
    // Already sanitised and fenced there, so it is appended as-is; wrapping it
    // again here would nest fences and break the block.
    if (repoInstructions && String(repoInstructions).trim()) {
        preamble += `\n${String(repoInstructions).trim()}\n`;
    }

    // ── Sections 3+ are per-unit: static findings, retrieved chunks, the
    // code-graph slice for these files, and the diff itself. They start a
    // new part so the shared preamble above can carry the cache breakpoint.
    let rest = '';

    // ── Section 3: Static analysis findings (if any) ──
    if (staticFindings && staticFindings.length > 0) {
        rest += `\n---\n\n## Pre-detected Static Analysis Findings\n`;
        for (const f of staticFindings.slice(0, 10)) {
            rest += `- **${(f.severity || 'info').toUpperCase()}** [${f.ruleId || f.category || 'rule'}] ${f.filePath || ''}:${f.line || '?'} — ${f.message}\n`;
        }
        rest += `\nValidate these AND find issues the static analyzers missed.\n`;
    }

    // ── Section 4: RAG context ──
    // Budgets come from `reviewContextBudget` rather than literals here: the
    // repo is fully indexed, so how much of it reaches the model is a tuning
    // decision the eval harness has to be able to vary.
    if (ragChunks && ragChunks.length > 0) {
        rest += `\n---\n\n## Related Repository Code (for understanding context)\n`;
        for (const chunk of ragChunks.slice(0, budget.ragChunks)) {
            const source = chunk.filePath || chunk.file || 'context';
            const content = (chunk.content || chunk.text || '').substring(0, budget.ragChunkChars);
            rest += `\`\`\`\n// ${source}\n${content}\n\`\`\`\n\n`;
        }
    }

    // ── Section 4b: Code-graph cross-file context ──
    if (graphContext && String(graphContext).trim()) {
        rest += `\n---\n\n## Cross-File Context from the Code Knowledge Graph
Use this to catch issues that depend on code OUTSIDE this diff — callers that would break, callees whose contract changed, functions the changed symbols impact. If a changed signature/behavior breaks one of these callers, that is a finding.

${String(graphContext).slice(0, budget.graphContextChars)}
`;
    }

    // ── Section 4c: Windowing sibling note ──
    // Present only for a `solo-window` unit, and differs per window of the
    // SAME file — so it goes in `rest`, never in `preamble`. `preamble` is
    // the cacheable prefix shared byte-for-byte across every review unit;
    // putting a per-window string there would defeat prompt caching for the
    // whole per-file pass (see the note on Section 1 above). It sits
    // immediately before the diff section so it's the last thing read before
    // the code.
    if (unit.siblingNote) {
        rest += `\n---\n\n> ${unit.siblingNote}\n`;
    }

    // ── Section 5: The diff (LAST — so LLM applies rules while reading it) ──
    rest += `\n---\n\n## Files Under Review — APPLY ALL CHECKS ABOVE TO EVERY + LINE\n\n`;

    for (const f of unit.files) {
        const ctx = fileContext?.get?.(f.filename) || null;

        rest += `### File: ${f.filename} (${f.status || 'modified'})
**Language**: ${f.language || 'unknown'} | **Changes**: +${f.additions || 0} -${f.deletions || 0}

`;

        // ── How much of this file the model sees ──
        //
        // Two strategies, chosen per file rather than globally:
        //
        //   Small file  → the WHOLE post-change file. A hunk cannot answer "does
        //                 this break the caller below", "is this the right
        //                 abstraction", or "is this state already tracked
        //                 elsewhere in the file", and for a few hundred lines the
        //                 full file is both cheap and strictly more informative.
        //
        //   Large file  → the hunks EXPANDED to their enclosing declarations.
        //                 This is the case `reviewContextBudget.js` documents:
        //                 misses concentrate in large files, read as attention
        //                 dilution. Pasting 2,000 lines around a 12-line change
        //                 is most of that haystack. See utils/dynamicContext.js.
        //
        // Expansion is attempted first because its outcome decides whether the
        // full file is still needed; when it is refused (content that does not
        // verifiably match the patch — a stale ref or a truncated fetch) the file
        // falls back to whatever it would have shown before.
        const declarations = declarationsByFile?.get?.(f.filename)
            || declarationsByFile?.[f.filename]
            || [];

        const preferExpansion = ctx?.fullContent
            && shouldPreferExpansion(ctx.fullContent)
            && !ctx.truncated;

        let renderPatch = f.patch;
        // Per-file, NOT the cumulative counter: a unit can hold several files, and
        // reading the counter here would deny the full-file fallback to every file
        // after the first one that expanded.
        let didExpand = false;

        if (preferExpansion) {
            const expansion = expandPatch({
                patch: f.patch,
                filename: f.filename,
                fileContent: ctx.fullContent,
                declarations,
                options: dynamicContext || undefined,
            });
            if (expansion.expanded) {
                renderPatch = expansion.patch;
                didExpand = true;
                contextStats.expandedFiles++;
                rest += `#### Context strategy: hunks expanded to their enclosing function/class
This file is large (${ctx.fullContent.split('\n').length} lines), so instead of the whole file
you are shown each changed region grown out to the function or class that contains
it. Code outside those regions is NOT shown — do not assert that something is
absent from this file, only that it is absent from what you can see.

`;
            }
        }

        if (!didExpand) {
            if (ctx?.fullContent) {
                contextStats.fullFileFiles++;
                rest += `#### Full file after the change${ctx.truncated ? ' (truncated to fit budget)' : ''}
Use this for context and to judge whether the change fits the file. Only report issues on lines the diff below actually touches.

\`\`\`${f.language || ''}
${ctx.fullContent}
\`\`\`

`;
            }
        }

        // Deletion-only hunks carry nothing reviewable — the prompt already tells
        // the model never to report against a removed line, so those tokens buy a
        // restatement of a rule. On a refactor or a file move they are most of the
        // diff. See utils/diffBudget.js.
        const stripped = stripDeletionOnlyHunks(renderPatch);
        contextStats.deletionOnlyHunksRemoved += stripped.removedHunks;
        if (stripped.patch) renderPatch = stripped.patch;

        // The test file — present or conspicuously absent.
        if (ctx?.testPath && ctx.testContent) {
            rest += `#### Existing test file: ${ctx.testPath}
Check that the behavior changed in the diff is actually covered here. A changed
branch, error path, or signature with no corresponding test change is a finding.

\`\`\`${f.language || ''}
${ctx.testContent}
\`\`\`

`;
        } else if (ctx?.testFileMissing) {
            rest += `#### Test file: NONE FOUND
No test file was located for this source file. If this diff adds or changes an
exported/public function, missing test coverage is a legitimate finding — report
it once for this file, not once per function.

`;
        }

        // Line-numbered hunks, not a raw ```diff block. The model previously had
        // to count lines from the @@ header to name a location, and got it wrong
        // silently — a correct finding on the wrong line still reads as
        // authoritative. The number is now printed next to the code, so `line`
        // is a value to COPY rather than compute.
        rest += `#### Diff — THIS is what you are reviewing
Each line in \`__new hunk__\` is prefixed with its REAL line number in the file.
Lines marked \`+\` are added by this PR. Lines in \`__old hunk__\` were REMOVED —
never report a finding against them; the PR has already deleted that code.

\`\`\`
${formatPatchWithLineNumbers(renderPatch, f.filename)}
\`\`\`

`;
    }

    // ── Section 5b: Files changed but not shown ──
    // Costs a handful of tokens and converts a wrong answer into a stated
    // limitation: without it the model believes it has seen the whole change and
    // reports "the caller was never updated" about a file it was not given.
    const omittedBlock = renderOmittedFiles(omittedFiles);
    if (omittedBlock) rest += `\n${omittedBlock}\n`;

    onContextStats?.({ ...contextStats, omittedFiles: omittedFiles.length });

    // ── Section 6: Required output ──
    const fileNames = unit.files.map(f => `"${f.filename}"`).join(' or ');
    rest += `---

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
      "line": 42,                        // COPY the number shown in __new hunk__; do not count lines
      "severity": "critical | high | medium | low",
      "type": "security | bug | performance | style | deprecated",
      "cwe": "CWE-ID or null",
      "title": "Concise title (under 100 chars)",
      "description": "What is wrong and why — reference the specific code on this line",
      "impact": "What could go wrong in production",
      "suggestion": "Replace X with Y (be specific, not vague)",
      "confidence": 0.85,
      // Escalation — set ONLY when the diff cannot settle the question.
      // This is not "I am unsure": an unsupported guess should simply not be
      // reported. Use it when answering needs something code review does not
      // have — a product decision, a migration plan, a threat model, whether a
      // downstream team was told. A real question a human must answer.
      "needsHumanReview": false,
      "expertise": "security | architecture | product | domain | operations | accessibility",
      "escalationReason": "What specifically cannot be determined from the diff, and what a human needs to check"
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
- Every finding needs a specific line number and a concrete fix.
- The line number MUST be one printed in the \`__new hunk__\` gutter for that file.
  Do not compute it, do not offset it, do not cite a line from \`__old hunk__\`.
- Escalate sparingly. \`needsHumanReview\` is for a question the diff genuinely
  cannot answer, not for hedging a weak finding. If you would not want a senior
  engineer paged for it, do not set it.`;

    // Two parts, not one string, so the transport can put a cache breakpoint at
    // the end of the shared preamble. The per-file pass makes one call per
    // review unit and every one of them re-sends that preamble — PR context,
    // intent, language rules, the standards block (up to 6KB), and the mined
    // conventions — unchanged. Providers with no breakpoint format receive the
    // two joined, which is exactly the string this returned before.
    return [
        { text: preamble, cache: true },
        { text: rest },
    ];
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

/**
 * Standards loader — embeds standards files at import time so they are
 * available in the extension's service worker without a fetch/readFile call.
 *
 * Organised by language family → aspect (coding | testing).
 * Add new languages by extending STANDARDS and LANG_MAP.
 */

// ---- Embedded standards text ----

const JS_CODING = `# JavaScript / TypeScript Coding Standards

## JS-CODING-001: No deprecated string APIs
Use \`substring()\` instead of \`substr()\`. The \`substr()\` method is deprecated and may be removed in future environments.

## JS-CODING-002: No \`__proto__\` mutation
Do not assign to \`__proto__\`. Use \`Object.create()\`, \`Object.setPrototypeOf()\`, or class \`extends\`.

## JS-CODING-003: Prefer \`const\` and \`let\` over \`var\`
\`var\` has function scope and hoisting behaviour that leads to bugs. Use \`const\` for values that never reassign, \`let\` otherwise. Never use \`var\`.

## JS-CODING-004: Async/await over Promise chains
Prefer \`async\`/\`await\` over \`.then()\`/\`.catch()\` chains. Every \`await\` expression inside an \`async\` function must be inside a \`try/catch\` or have a caller that handles the rejection.

## JS-CODING-005: No \`eval()\` or \`new Function(string)\`
These constructs execute arbitrary code strings and are a direct XSS/code-injection vector.

## JS-CODING-006: Explicit error handling in async code
Do not swallow errors with empty \`catch\` blocks. Log the error or rethrow.

## JS-CODING-007: No hardcoded secrets
API keys, tokens, passwords, and connection strings must never appear in source code.

## TS-CODING-001: \`strict: true\` enforced
Never use \`any\` — use \`unknown\` plus narrowing guards.

## TS-CODING-002: \`zod\` validation at every external boundary
All inputs crossing a trust boundary must be validated with a Zod schema before use.

## TS-CODING-003: No non-null assertion without guard
The \`!\` postfix operator silently removes \`null\`/\`undefined\` from the type. Only acceptable when a non-null invariant is proven by a preceding runtime check.`;

const JS_TESTING = `# JavaScript / TypeScript Testing Standards

## JS-TEST-001: Every exported function must have at least one unit test
Any function exported from a module that is new or modified in this PR must have a corresponding test in a \`*.test.ts\`, \`*.test.js\`, \`*.spec.ts\`, or \`*.spec.js\` file.

## JS-TEST-002: No \`console.log\` in test files
Test files must not contain \`console.log\`.

## JS-TEST-003: Test names describe behaviour, not implementation
Test names must follow the form \`it('should <behaviour> when <condition>')\`.

## JS-TEST-004: No hardcoded real credentials in test fixtures
Test fixtures must use obviously fake values, never real API keys, tokens, or passwords.

## JS-TEST-005: Async tests must await all assertions
Every \`async\` test that uses \`await\` must assert the result of the awaited expression.

## JS-TEST-006: Integration tests must clean up resources
Tests that create database rows, files, or mock servers must clean them up in \`afterEach\`/\`afterAll\`.

## JS-TEST-007: No skipped tests without a tracking comment
A \`test.skip\` or \`xit\` without an associated ticket reference hides forgotten regressions.`;

const PY_CODING = `# Python Coding Standards

## PY-CODING-001: No deprecated datetime UTC helpers
\`datetime.utcnow()\` and \`datetime.utcfromtimestamp()\` are deprecated since Python 3.12. Use \`datetime.now(timezone.utc)\` and \`datetime.fromtimestamp(ts, tz=timezone.utc)\`.

## PY-CODING-002: No \`os.popen()\` — use \`subprocess\`
\`os.popen()\` is deprecated since Python 3.0. Use \`subprocess.run()\` or \`subprocess.Popen()\` with explicit argument lists.

## PY-CODING-003: No \`asyncio.get_event_loop()\` — use \`get_running_loop()\`
Inside an async context use \`asyncio.get_running_loop()\`. For creating a new loop in a synchronous entrypoint use \`asyncio.run()\`.

## PY-CODING-004: \`logger.exception()\` only inside \`except\` blocks
Calling it outside an \`except\` block logs \`NoneType: None\` as the traceback, which is misleading.

## PY-CODING-005: No bare \`except:\` without re-raise or logging
A bare \`except\` that silently passes hides crashes. Always either log the error or re-raise.

## PY-CODING-006: No mutable default arguments
Use \`None\` as the default and create the mutable value inside the function.

## PY-CODING-007: Type hints required on all public functions (Python 3.10+)
All public functions must have type hints on parameters and return values.`;

const PY_TESTING = `# Python Testing Standards

## PY-TEST-001: Every public function must have at least one test
Any public function (not prefixed \`_\`) that is new or modified in this PR must have a corresponding \`test_*.py\` or \`*_test.py\` test.

## PY-TEST-002: Use \`pytest\` fixtures, not module-level globals
Test state must be isolated in \`pytest\` fixtures with appropriate scope.

## PY-TEST-003: No \`unittest.mock.patch\` on implementation details
Mock at the boundary (network call, DB query), not at internal function calls.

## PY-TEST-004: Async tests must use \`pytest-asyncio\`
All \`async def test_*\` functions must be decorated \`@pytest.mark.asyncio\`.

## PY-TEST-005: No \`time.sleep()\` in tests
Use \`asyncio.wait_for()\`, polling with exponential backoff, or test fixtures that produce deterministic state.`;

const GO_CODING = `# Go Coding Standards

## GO-CODING-001: Errors must be handled — never \`_\` discard
Do not discard errors with \`_\`. Every returned \`error\` must be returned, logged, or explicitly justified.

## GO-CODING-002: Wrap errors with context using \`fmt.Errorf("%w")\`
When returning an error from a deeper call, wrap it to preserve the error chain.

## GO-CODING-003: Use \`context.Context\` as the first parameter for I/O functions
Every function that performs I/O must accept \`ctx context.Context\` as its first parameter.

## GO-CODING-004: No \`panic\` in library code
\`panic\` is only acceptable in \`main()\` for unrecoverable startup failures. Library functions must return errors.

## GO-CODING-005: Use \`sync.Mutex\` or channels — not raw memory sharing
Do not share mutable state between goroutines without synchronisation.

## GO-CODING-006: Struct fields must have JSON tags if serialised
Any struct field participating in JSON encoding must have an explicit \`json:"name"\` tag.

## GO-CODING-007: \`defer\` for resource cleanup
All resources requiring explicit closure must be closed with \`defer\` immediately after acquisition.`;

const GO_TESTING = `# Go Testing Standards

## GO-TEST-001: Every exported function must have at least one test
Any exported function (uppercase) that is new or modified in this PR must have a \`_test.go\` test exercising it.

## GO-TEST-002: Table-driven tests for all non-trivial logic
Functions with branching logic must use table-driven test structure covering each branch.

## GO-TEST-003: Use \`testify/assert\` or stdlib \`testing\` — not both
Choose one assertion library per package for consistent output.

## GO-TEST-004: Use \`testcontainers-go\` for external dependencies
Tests requiring a real DB, Redis, Kafka, or HTTP server must use \`testcontainers-go\`.

## GO-TEST-005: No \`time.Sleep\` in tests
Use channels or \`sync.WaitGroup\` to synchronise test goroutines.`;

// ---- Language detection ----

/**
 * Extension → language family mapping.
 * Keys are lowercased file extensions (without the dot).
 */
const EXT_TO_LANG = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'javascript',
    tsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    pyw: 'python',
    go: 'go'
};

/**
 * Returns the set of language families present in a list of changed files.
 * @param {Array<{filename: string}>} files
 * @returns {Set<string>}
 */
export function detectLanguages(files) {
    const langs = new Set();
    for (const f of files) {
        const ext = (f.filename || '').split('.').pop()?.toLowerCase();
        if (ext && EXT_TO_LANG[ext]) langs.add(EXT_TO_LANG[ext]);
    }
    return langs;
}

// ---- Standards registry ----

const STANDARDS = {
    javascript: { coding: JS_CODING, testing: JS_TESTING },
    python: { coding: PY_CODING, testing: PY_TESTING },
    go: { coding: GO_CODING, testing: GO_TESTING }
};

/**
 * Builds a combined standards block for the detected languages.
 * Only includes testing standards when JSX/TSX files are in the diff
 * (consistent with the PR description's "adapter from the skill" note).
 *
 * @param {Set<string>} langs - detected language families
 * @param {Array<{filename: string}>} files - changed files (for UI-testing gate)
 * @returns {{ text: string, ruleIds: string[] }}
 */
export function buildStandardsBlock(langs, files = []) {
    const parts = [];
    const ruleIds = [];

    const hasUI = files.some(f => /\.(jsx|tsx)$/i.test(f.filename || ''));

    for (const lang of langs) {
        const std = STANDARDS[lang];
        if (!std) continue;

        parts.push(std.coding);
        // Extract rule IDs (lines matching `## ID:`)
        for (const match of std.coding.matchAll(/^## ([A-Z]+-[A-Z]+-\d+):/gm)) {
            ruleIds.push(match[1]);
        }

        // Only include testing standards for UI files (JS) or non-UI languages
        if (lang !== 'javascript' || hasUI) {
            parts.push(std.testing);
            for (const match of std.testing.matchAll(/^## ([A-Z]+-[A-Z]+-\d+):/gm)) {
                ruleIds.push(match[1]);
            }
        } else if (lang === 'javascript') {
            // Always include JS testing standards (they apply to all JS, not just UI)
            parts.push(std.testing);
            for (const match of std.testing.matchAll(/^## ([A-Z]+-[A-Z]+-\d+):/gm)) {
                ruleIds.push(match[1]);
            }
        }
    }

    return { text: parts.join('\n\n---\n\n'), ruleIds };
}

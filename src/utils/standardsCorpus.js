/**
 * standardsCorpus — the performance aspect, and the Java language family.
 *
 * Split out of `standardsLoader.js`, which holds the loader logic plus the
 * original javascript/python/go coding and testing text and was already at the
 * project's file-length ceiling. This module is data only; `standardsLoader`
 * owns detection, assembly, and rule-ID extraction.
 *
 * Two aspects were deliberately NOT ported from the upstream corpus these rules
 * came from:
 *
 *   Benchmark harnesses and lint commands. Both were written for a reviewer with
 *   a checkout and a toolchain. RepoSpector reviews a diff in a browser and can
 *   run neither, so "run `golangci-lint run ./...`" is a rule it can never
 *   produce a finding against — prompt weight with nothing behind it. The
 *   lint rules that ARE visible in a patch (an unexplained suppression comment,
 *   a swallowed error) are kept, restated as diff-checkable rules.
 *
 * Rule IDs must match `^## ([A-Z]+-[A-Z]+-\d+):` — that regex is how
 * `buildStandardsBlock` harvests the citable ID list, and `citationEnforcer`
 * rejects a finding citing an ID that is not in it.
 */

const JS_PERF = `# JavaScript / TypeScript Performance Standards

## JS-PERF-001: No array or object spread inside a loop
\`acc = [...acc, item]\` inside a loop copies the whole accumulator every iteration, turning an O(n) build into O(n²). Push into the array, or spread once after the loop.

## JS-PERF-002: No nested iteration over the same collection
Two nested loops over the same array is O(n²). Build a \`Map\` or \`Set\` keyed by the lookup field and index into it.

## JS-PERF-003: Hoist invariant work out of hot paths
Object literals, regex literals, and derived arrays that do not depend on the loop variable must be created once above the loop, not per iteration.

## JS-PERF-004: Await independent work concurrently
Sequential \`await\`s on operations with no ordering dependency serialise work that could overlap. Use \`Promise.all\`.`;

const PY_PERF = `# Python Performance Standards

## PY-PERF-001: No nested comprehension building a large intermediate
A comprehension inside a comprehension materialises the inner result for every outer item. Split it into named steps, or use a generator so the intermediate is never built.

## PY-PERF-002: No blocking I/O inside an async function
A synchronous \`requests\` call, \`open()\`, or \`time.sleep\` inside \`async def\` blocks the event loop and stalls every other coroutine. Use the async client, or hand the work to a thread executor.

## PY-PERF-003: No nested iteration over the same collection
Two nested loops over the same sequence is O(n²). Build a \`dict\` or \`set\` for the lookup.

## PY-PERF-004: Hoist invariant lookups out of loops
Attribute chains, \`len()\` on an unchanging sequence, and recompiled regexes belong above the loop, not inside it.`;

const GO_PERF = `# Go Performance Standards

## GO-PERF-001: Pre-allocate slice capacity when the size is known
\`append\` in a loop without capacity reallocates and copies repeatedly. Use \`make([]T, 0, len(src))\`.

## GO-PERF-002: No string concatenation in a loop
\`s += x\` allocates a new string every iteration. Use \`strings.Builder\`.

## GO-PERF-003: No nested iteration over the same collection
Two nested loops over the same slice is O(n²). Build a map for the lookup.

## GO-PERF-004: Parallelise independent I/O
Sequential HTTP or database calls with no ordering dependency should run under \`errgroup.Group\`.

## GO-PERF-005: Avoid reflection on hot paths
Reflection bypasses type safety and is slow. Prefer generics or code generation where the type set is known.

## GO-PERF-006: Do not copy large structs by value
Passing or ranging over large structs by value copies them each time. Use a pointer, or index the slice.`;

const JAVA_CODING = `# Java Coding Standards

## JAVA-CODING-001: Never swallow an exception
\`catch (Exception e) {}\` discards the failure. Log it with context or rethrow — an empty catch block is a defect, not a style preference.

## JAVA-CODING-002: Do not return \`null\` from a public method
Return \`Optional<T>\` for a value that may legitimately be absent, or an empty collection for a collection.

## JAVA-CODING-003: Validate constructor arguments
Reference arguments a class stores must be checked with \`Objects.requireNonNull\` so the failure surfaces at construction rather than at first use, far from the cause.

## JAVA-CODING-004: Inject dependencies through the constructor
Do not \`new\` a collaborator inside business logic — it cannot be substituted in a test and the dependency is invisible at the call site.

## JAVA-CODING-005: Wrap third-party exceptions at the boundary
Let a domain exception cross a module boundary, not a driver or client library's own exception type.

## JAVA-CODING-006: Handle the failure branch of \`CompletableFuture\`
A chain without \`.exceptionally()\` or \`.handle()\` drops the exception silently.

## JAVA-CODING-007: Protect shared mutable state
Prefer immutable value objects. Where state must be shared and mutated, use \`java.util.concurrent\` types rather than raw \`synchronized\` blocks.

## JAVA-CODING-008: No hardcoded secrets
API keys, tokens, passwords, and connection strings must not appear in source.

## JAVA-CODING-009: Suppression requires a stated reason
\`@SuppressWarnings\` without a comment explaining why the warning does not apply is unreviewable — the next reader cannot tell a considered decision from a silenced one.`;

const JAVA_TESTING = `# Java Testing Standards

## JAVA-TEST-001: Every public method must have at least one test
A public method new or modified in this PR needs a corresponding \`<ClassName>Test.java\` case exercising it.

## JAVA-TEST-002: Unit tests make no real network, filesystem, or database calls
Mock the collaborator. A unit test that reaches a real dependency is an integration test and belongs in a separate source set tagged \`@Tag("integration")\`.

## JAVA-TEST-003: Cover branches with \`@ParameterizedTest\`
Logic with multiple branches must be exercised per branch via \`@ParameterizedTest\` + \`@MethodSource\`, not by one test asserting the happy path.

## JAVA-TEST-004: Test names state behaviour and condition
Follow \`should_<expected>_when_<condition>\`. A name like \`test1\` or \`testCreate\` says nothing when it fails in CI.

## JAVA-TEST-005: Assert on the outcome, not merely that nothing threw
A test whose body calls the method and asserts nothing still passes when the method is gutted.

## JAVA-TEST-006: No \`Thread.sleep\` in tests
Synchronise with \`CountDownLatch\`, \`Awaitility\`, or a completed future. A sleep is both slow and flaky.`;

const JAVA_PERF = `# Java Performance Standards

## JAVA-PERF-001: No string concatenation inside a loop
\`s += x\` allocates a new \`String\` per iteration. Use \`StringBuilder\`.

## JAVA-PERF-002: Pre-size collections built in a loop
\`new ArrayList<>()\` that grows to a known size reallocates and copies. Pass the expected size to the constructor.

## JAVA-PERF-003: No \`List.contains()\` inside a loop
That is O(n) per call and O(n²) overall. Use a \`Set\`.

## JAVA-PERF-004: No database query inside a loop
Batch the query or express it as a \`JOIN\` — a per-row query is the N+1 pattern.

## JAVA-PERF-005: No nested iteration over the same collection
Two nested loops over the same collection is O(n²). Build a \`Map\` for the lookup.

## JAVA-PERF-006: Parallelise independent I/O
Sequential calls with no ordering dependency should run under \`CompletableFuture.allOf()\`.

## JAVA-PERF-007: Do not use a parallel stream on a small collection
Below roughly 10K elements the fork/join overhead exceeds the benefit.

## JAVA-PERF-008: Avoid autoboxing on hot paths
\`List<Integer>\` in a tight loop allocates per element. Use a primitive array or a primitive-specialised collection.`;

// ---- Hygiene: the lint rules that are visible in a diff ----
//
// The upstream corpus keeps these in `linters.md`, most of which is "run
// `golangci-lint run ./...`" — instructions for a reviewer with a checkout and
// a toolchain, which RepoSpector is not. Those were dropped.
//
// But a subset of every linters.md is not about running anything: it describes
// a property a reviewer can check by reading the patch. An unexplained
// suppression comment, a promise nobody awaits, a block of commented-out code —
// each is a defect visible in the diff, and a real linter would flag it. Those
// are restated here as ordinary rules.
//
// Java's equivalents went straight into JAVA-CODING-009 when that family was
// written; these are the same treatment for the three languages that already
// had coding standards.

const JS_HYGIENE = `# JavaScript / TypeScript Hygiene Standards

## JS-CODING-030: Suppression comments require a stated reason
An \`eslint-disable\` or \`eslint-disable-next-line\` with no explanation is unreviewable — the next reader cannot tell a considered exception from a silenced warning. State why the rule does not apply on the line above.

## JS-CODING-031: Every promise must be awaited, returned, or caught
A floating promise runs detached: its rejection surfaces as an unhandled rejection far from the cause, and its completion is not ordered against anything. Await it, return it, or attach a \`.catch\`.

## JS-CODING-032: No \`console.*\` in production code
Console output is unstructured, unfiltered, and ships to users. Use the project's logger. Test files are exempt — see JS-TEST-002 for the rule that applies there.

## JS-CODING-033: No commented-out code
Commented-out blocks rot: they are not compiled, not tested, and not updated with the code around them. Delete them — version control is the archive.

## JS-CODING-034: No unused variables, imports, or parameters
An unused import or binding is either dead weight or a symptom of an incomplete edit — most often a refactor that removed the use and left the declaration.

## TS-CODING-010: \`@ts-ignore\` and \`@ts-expect-error\` require a stated reason
Both switch off the type checker for a line. Without a comment saying which error is being suppressed and why it is safe, the suppression outlives the reason for it. Prefer \`@ts-expect-error\`, which fails once the underlying error is fixed.`;

const PY_HYGIENE = `# Python Hygiene Standards

## PY-CODING-030: Suppression comments require a stated reason
\`# noqa\` and \`# type: ignore\` without an explanation hide a finding rather than resolving it. Name the specific code being suppressed (\`# noqa: E501\`, not bare \`# noqa\`) and say why.

## PY-CODING-031: No commented-out code
Commented-out blocks are not executed, not tested, and drift from the code around them. Delete them.

## PY-CODING-032: No unused imports or names
An unused import is dead weight, and after a refactor it is usually the residue of a removed call — worth checking that the removal was complete.

## PY-CODING-033: No wildcard imports
\`from module import *\` makes the origin of every name unresolvable by reading, and silently shadows locals when the module changes.`;

const GO_HYGIENE = `# Go Hygiene Standards

## GO-CODING-030: \`//nolint\` requires a stated reason
A bare \`//nolint\` suppresses a real finding with no record of why. Name the linter and give the reason: \`//nolint:gosec // path is validated above\`.

## GO-CODING-031: No commented-out code
Commented-out blocks are not compiled, so they are not kept correct. Delete them.

## GO-CODING-032: No unused variables, imports, or parameters
Go's compiler rejects unused locals and imports, so an unused one reaching review usually means a build-tagged or generated file — worth checking it is intentional.

## GO-CODING-033: Exported identifiers need doc comments
An exported symbol with no comment starting with its own name is undocumented in \`go doc\` and at every call site.`;

/** Hygiene text, keyed by language family. */
export const HYGIENE_STANDARDS = {
    javascript: JS_HYGIENE,
    python: PY_HYGIENE,
    go: GO_HYGIENE,
};

/** Performance text keyed by the same language families the loader detects. */
export const PERF_STANDARDS = {
    javascript: JS_PERF,
    python: PY_PERF,
    go: GO_PERF,
    java: JAVA_PERF,
};

/** The Java family, which had no entry in the original corpus at all. */
export const JAVA_STANDARDS = {
    coding: JAVA_CODING,
    testing: JAVA_TESTING,
    perf: JAVA_PERF,
};

export default { PERF_STANDARDS, HYGIENE_STANDARDS, JAVA_STANDARDS };

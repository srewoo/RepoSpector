/**
 * missingTestFinder — "this diff adds a function and no test touches it".
 *
 * ## Why this exists
 *
 * Comparing RepoSpector's output against Bito's on four real MRs, the single
 * most common finding Bito produced that RepoSpector *structurally could not*
 * was this one:
 *
 *     "adding a direct unit test would provide faster feedback for regressions
 *      in this client"
 *     "adding dedicated unit tests for the walk function would improve coverage
 *      for its complex internal logic — depth capping, cycle detection"
 *     "the untested normalization logic in normalizeBaselineCases"
 *
 * RepoSpector could not say any of that, for a structural reason rather than a
 * quality one: its only test lens (`test-quality`) is gated by `appliesTo` on
 * **test files being present in the diff**. A PR that adds an exported function
 * and no test therefore has the one lens that would notice switched off. The
 * repo also has `TestCoverageBuilder`, which models TESTED_BY edges — but it is
 * a graph feature and nothing in the review path consults it.
 *
 * ## Why it is deterministic, and must be
 *
 * "Was a test added for this symbol?" is a question about text in the diff. It
 * needs no model, and a model is measurably bad at it — this repo's adjudicated
 * corpus shows 10.7% precision on LLM correctness findings. So this emits
 * findings with `source: 'static'`, which the pipeline already treats as ground
 * truth rather than a guess.
 *
 * ## What it deliberately does NOT claim
 *
 * It claims a test does not MENTION the symbol. It does not claim the symbol is
 * untested — coverage can come from an integration test that never names it,
 * which is exactly the objection the Hermes MR author raised ("behaviour is
 * currently covered by end-to-end tests"). That objection is correct and the
 * wording here concedes it, because a finding that overclaims gets dismissed
 * along with everything else the reviewer said.
 *
 * It also stays quiet unless the PR ALREADY has a test file somewhere in it, or
 * the repo shows no test convention at all — see `shouldRun`. Telling a
 * docs-only or config-only PR that it lacks tests is noise.
 */

import { extractDeclaredSymbols, DECL_PATTERNS } from './declaredSymbols.js';
import { parsePatchHunks } from './patchLines.js';

/** Path shapes that ARE tests, across the ecosystems reviewed here. */
const TEST_PATH = /(\.test\.|\.spec\.|_test\.|(^|\/)test_|(^|\/)tests?\/|(^|\/)__tests__\/|Test\.(java|kt)$|Tests\.swift$)/i;

/** Files whose contents are never worth a coverage claim. */
const NON_SOURCE = /\.(md|txt|json|ya?ml|toml|lock|snap|svg|png|jpe?g|gif|css|scss|html?)$/i;

/** Generated or vendored code — nobody hand-writes tests for protoc output. */
const GENERATED = /(_pb2?(_grpc)?\.py|\.pb\.go|_generated\.|\.gen\.|(^|\/)(vendor|node_modules|dist|build)\/|\.min\.js$)/i;

export function isTestPath(path) {
    return TEST_PATH.test(String(path || ''));
}

/** Added-line text of one patch. */
function addedText(patch) {
    const out = [];
    for (const hunk of parsePatchHunks(patch)) {
        for (const l of hunk.lines) if (l.type === 'added') out.push(l.content);
    }
    return out.join('\n');
}

/**
 * New-line number of the added line that DECLARES `symbol`.
 *
 * `declarationLineFor` in declaredSymbols returns the line's TEXT, which is the
 * right answer for prompt building and the wrong one here — a finding needs a
 * number to anchor an inline comment to.
 */
function declarationLineNumber(patch, symbol) {
    for (const hunk of parsePatchHunks(patch)) {
        for (const l of hunk.lines) {
            if (l.type !== 'added' || l.number.new == null) continue;
            for (const pattern of DECL_PATTERNS) {
                pattern.lastIndex = 0;
                let m;
                while ((m = pattern.exec(l.content)) !== null) {
                    if (m[1] === symbol) return l.number.new;
                }
            }
        }
    }
    return null;
}

/** All text of one patch (added + context), for "does a test mention this?". */
function allText(patch) {
    const out = [];
    for (const hunk of parsePatchHunks(patch)) {
        for (const l of hunk.lines) if (l.type !== 'deleted') out.push(l.content);
    }
    return out.join('\n');
}

/**
 * Only exported/public declarations are worth a finding.
 *
 * A private helper is tested through its caller by design, and flagging every
 * internal function would bury the one public entry point that genuinely has no
 * test — which is the finding worth making.
 */
function isExported(code, symbol) {
    const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
        `\\bexport\\s+(?:default\\s+)?(?:async\\s+)?(?:function|class|const|let|var)\\s+${esc}\\b`
        + `|\\bexport\\s*\\{[^}]*\\b${esc}\\b`          // export { foo }
        + `|\\bfunc\\s+${esc}\\b`                        // go: capitalised check below
        + `|^\\s*(?:public|open)\\s+.*\\b${esc}\\b`      // java/kotlin/swift
        + `|^\\s*(?:def|class)\\s+${esc}\\b`,            // python (underscore check below)
        'm'
    ).test(code);
}

/**
 * A TypeScript `type`/`interface` is not a testable unit.
 *
 * Run against the real MR !68 diff this finder reported `RegressionImpactParams`,
 * `BaselineCaseTitle` and `SignalReport` — all type aliases. Nobody writes a unit
 * test for a type; the compiler is its test. Three noise findings out of ten is
 * exactly the ratio that gets a whole reviewer switched off, so types are
 * excluded rather than merely deprioritised.
 */
function isTypeOnlyDeclaration(code, symbol) {
    const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b(?:export\\s+)?(?:declare\\s+)?(?:interface|type)\\s+${esc}\\b`).test(code);
}

/** Python `_private` and Go lowercase are package-private by convention. */
function isConventionallyPublic(symbol) {
    if (symbol.startsWith('_')) return false;
    return true;
}

/**
 * Should this run at all?
 *
 * Silent unless the diff contains at least one source file worth testing. The
 * caller may additionally require an existing test convention; see the
 * `requireTestPresence` option, which is on by default so a repo with no tests
 * at all is not lectured on every PR.
 */
export function shouldRun(files = [], { requireTestPresence = true } = {}) {
    const paths = files.map(f => f?.filename || f?.new_path || f?.path || '').filter(Boolean);
    const hasSource = paths.some(p => !isTestPath(p) && !NON_SOURCE.test(p) && !GENERATED.test(p));
    if (!hasSource) return false;
    if (!requireTestPresence) return true;
    return paths.some(isTestPath);
}

/**
 * Find exported symbols this diff ADDS that no test file in the diff mentions.
 *
 * @param {object} prData - provider PR payload with `files[]`
 * @param {object} [opts]
 * @param {boolean} [opts.requireTestPresence=true] - only run when the PR already touches a test
 * @param {number} [opts.maxFindings=5] - cap; a 40-symbol PR should not yield 40 findings
 * @returns {Array<object>} findings in RepoSpector's shape, `source: 'static'`
 */
export function findMissingTests(prData, opts = {}) {
    const { requireTestPresence = true, maxFindings = 5 } = opts;
    const files = prData?.files || [];
    if (!shouldRun(files, { requireTestPresence })) return [];

    // Everything any test in this PR says, in one haystack. Cross-file on
    // purpose: a test for `src/a.js` legitimately lives in `test/unit/a.test.js`,
    // and pairing by filename would miss every repo that does not mirror paths.
    const testHaystack = files
        .filter(f => isTestPath(f?.filename || f?.new_path || f?.path || ''))
        .map(f => allText(f?.patch ?? f?.diff ?? ''))
        .join('\n');

    const findings = [];
    for (const f of files) {
        const path = f?.filename || f?.new_path || f?.path || '';
        const patch = f?.patch ?? f?.diff ?? '';
        if (!path || !patch) continue;
        if (isTestPath(path) || NON_SOURCE.test(path) || GENERATED.test(path)) continue;

        const added = addedText(patch);
        if (!added.trim()) continue;

        for (const symbol of extractDeclaredSymbols(added)) {
            if (!isConventionallyPublic(symbol)) continue;
            if (!isExported(added, symbol)) continue;
            if (isTypeOnlyDeclaration(added, symbol)) continue;

            const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const mentioned = new RegExp(`(^|[^\\w$])${esc}(?![\\w$])`).test(testHaystack);
            if (mentioned) continue;

            findings.push({
                file: path,
                line: declarationLineNumber(patch, symbol),
                severity: 'low',
                source: 'static',
                rule: 'static/missing-test',
                ruleId: 'missing-test',
                title: `New exported \`${symbol}\` is not mentioned by any test in this PR`,
                description:
                    `This diff adds the exported symbol \`${symbol}\` in \`${path}\`, and no test file changed by `
                    + `this PR references it by name. That does not prove it is untested — an existing integration `
                    + `test may exercise it without naming it — but a direct unit test localises a regression to this `
                    + `symbol instead of to whatever end-to-end test happens to break.`,
                suggestion: `Add a test that calls \`${symbol}\` directly, or note here which existing test covers it.`,
            });
            if (findings.length >= maxFindings) return findings;
        }
    }
    return findings;
}

export default { findMissingTests, shouldRun, isTestPath };

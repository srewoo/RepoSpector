/**
 * Shared helpers for recognising test files and mapping them back to the
 * production file they most likely cover. Used by TestCoverageBuilder (to build
 * TESTED_BY edges) and ImpactAnalyzer (to exclude tests from blast radius).
 */

/**
 * A test directory anywhere in the path, INCLUDING at the repository root.
 *
 * This was a substring match against `'/test/'`, `'/tests/'` and `'/spec/'`,
 * which the leading slash made unreachable for a root-level directory: paths
 * arrive repo-relative, so ky's whole suite (`test/main.ts`, `test/hooks.ts`)
 * matched nothing and carried no `.test.` marker in the filename either. Every
 * TESTED_BY edge for such a repository was therefore missing, and the graph
 * reported `coverageRatio: 0` with every symbol "untested" — which in turn is
 * what `untested-blast-radius` findings are computed from, so a repo laid out
 * this way got a page of coverage findings that were all noise.
 *
 * `(^|\/)` is the whole fix: anchor at a path boundary rather than requiring a
 * preceding slash.
 */
const TEST_DIR_RE = /(^|\/)(tests?|spec|specs|__tests__|__test__|__mocks__)\//i;

/** Is this path a test/spec file? */
export function isTestFile(filePath) {
    if (!filePath) return false;
    const lower = String(filePath).toLowerCase();
    if (TEST_DIR_RE.test(lower)) return true;
    return /(\.|_|-)(test|spec|e2e)\.[a-z0-9]+$/.test(lower) || // foo.test.js, foo_spec.rb
        /(^|\/)test_[^/]+\.py$/.test(lower) ||                  // test_foo.py
        /_test\.(go|py|rb|java|kt)$/.test(lower);               // foo_test.go
}

/**
 * Given a test file path, return candidate production file paths it may cover.
 * Strips test markers and tries common locations relative to the test file.
 * @returns {string[]} candidate production paths (basename + dir-shifted variants)
 */
export function productionCandidatesForTest(testPath) {
    if (!testPath) return [];
    const slash = testPath.lastIndexOf('/');
    const dir = slash >= 0 ? testPath.slice(0, slash) : '';
    let base = slash >= 0 ? testPath.slice(slash + 1) : testPath;

    const dot = base.lastIndexOf('.');
    const ext = dot >= 0 ? base.slice(dot) : '';
    let stem = dot >= 0 ? base.slice(0, dot) : base;

    // Strip test/spec markers from the stem.
    stem = stem
        .replace(/[._-]?(test|spec)$/i, '')
        .replace(/^(test|spec)[._-]?/i, '');

    const stems = new Set([stem]);
    const fileName = stem + ext;

    const dirs = new Set([dir]);
    // __tests__/foo.test.js → ../foo.js ; tests/foo_test.go → ../foo.go
    dirs.add(dir.replace(/\/?(__tests__|__mocks__|tests?|spec|__test__)$/i, ''));

    const candidates = new Set();
    for (const d of dirs) {
        for (const s of stems) {
            candidates.add(d ? `${d}/${s}${ext}` : `${s}${ext}`);
        }
    }
    candidates.add(fileName); // bare basename, last resort
    candidates.delete(testPath);
    return [...candidates].filter(Boolean);
}

/**
 * Per-language test-file naming conventions, in the order we should try them.
 * Each entry maps a production stem+ext to the paths a test for it would live at,
 * relative to the production file's directory unless the pattern says otherwise.
 *
 * Go is deliberately first-and-only for `.go`: the toolchain enforces
 * `foo_test.go` beside `foo.go`, so guessing anything else wastes an API call.
 */
const TEST_PATTERNS = {
    go: (dir, stem) => [`${dir}/${stem}_test.go`],
    py: (dir, stem) => [
        `${dir}/test_${stem}.py`,
        `${dir}/${stem}_test.py`,
        `tests/test_${stem}.py`,
        `test/test_${stem}.py`,
    ],
    rb: (dir, stem) => [`${dir}/${stem}_spec.rb`, `spec/${stem}_spec.rb`],
    java: (dir, stem) => [`${dir}/${stem}Test.java`, dir.replace('/main/', '/test/') + `/${stem}Test.java`],
    kt: (dir, stem) => [`${dir}/${stem}Test.kt`, dir.replace('/main/', '/test/') + `/${stem}Test.kt`],
};

/** JS/TS-family extensions all share one convention set. */
const JS_EXTS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs']);

/**
 * Given a PRODUCTION file path, return candidate test file paths, best guess
 * first. The inverse of `productionCandidatesForTest`.
 *
 * Used by the review context builder: a reviewer with a full clone can simply
 * open the test file, which is how "this new exported function has no test"
 * findings get produced. We have no clone, so we guess the path and fetch it — a
 * bounded number of cheap API calls, most of which hit on the first candidate.
 *
 * Returns [] for a path that is already a test file (nothing to look up).
 *
 * @param {string} filePath
 * @returns {string[]} candidate test paths, ordered by likelihood
 */
export function testCandidatesForProduction(filePath) {
    if (!filePath || isTestFile(filePath)) return [];

    const slash = filePath.lastIndexOf('/');
    const dir = slash >= 0 ? filePath.slice(0, slash) : '';
    const base = slash >= 0 ? filePath.slice(slash + 1) : filePath;

    const dot = base.lastIndexOf('.');
    if (dot < 0) return [];
    const ext = base.slice(dot + 1).toLowerCase();
    const stem = base.slice(0, dot);

    const out = [];

    if (JS_EXTS.has(ext)) {
        // Same directory first — the overwhelmingly common layout.
        out.push(`${dir ? dir + '/' : ''}${stem}.test.${ext}`);
        out.push(`${dir ? dir + '/' : ''}${stem}.spec.${ext}`);
        // Then the __tests__ sibling directory.
        out.push(`${dir ? dir + '/' : ''}__tests__/${stem}.test.${ext}`);
        out.push(`${dir ? dir + '/' : ''}__tests__/${stem}.${ext}`);
        // Then a top-level mirror, which is what this repo itself uses.
        const mirrored = dir.replace(/^src\//, '');
        out.push(`test/${mirrored ? mirrored + '/' : ''}${stem}.test.${ext}`);
        out.push(`tests/${mirrored ? mirrored + '/' : ''}${stem}.test.${ext}`);
    } else if (TEST_PATTERNS[ext]) {
        out.push(...TEST_PATTERNS[ext](dir, stem));
    } else {
        return [];
    }

    // Collapse the `//` that a root-level file (dir === '') would produce.
    return [...new Set(out.map(p => p.replace(/\/{2,}/g, '/').replace(/^\//, '')))];
}

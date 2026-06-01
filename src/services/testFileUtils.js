/**
 * Shared helpers for recognising test files and mapping them back to the
 * production file they most likely cover. Used by TestCoverageBuilder (to build
 * TESTED_BY edges) and ImpactAnalyzer (to exclude tests from blast radius).
 */

const TEST_PATH_HINTS = ['__tests__', '__mocks__', '/test/', '/tests/', '/spec/', '/__test__/'];

/** Is this path a test/spec file? */
export function isTestFile(filePath) {
    if (!filePath) return false;
    const lower = filePath.toLowerCase();
    if (TEST_PATH_HINTS.some(h => lower.includes(h))) return true;
    return /(\.|_|-)(test|spec)\.[a-z0-9]+$/.test(lower) || // foo.test.js, foo_spec.rb
        /(^|\/)test_[^/]+\.py$/.test(lower) ||               // test_foo.py
        /_test\.(go|py|rb|java|kt)$/.test(lower);            // foo_test.go
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

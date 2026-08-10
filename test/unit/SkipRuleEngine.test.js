const {
    evaluateSkipRules,
    classifyChanges,
} = require('../../src/services/SkipRuleEngine.js');
const { VERDICT } = require('../../src/services/reviewSchema.js');

const baseFiles = [{ filename: 'src/foo.js' }];

function pr(overrides = {}) {
    return {
        state: 'open',
        isDraft: false,
        merged: false,
        mergeable: true,
        title: 'Add feature',
        author: { login: 'alice' },
        files: baseFiles,
        stats: { additions: 10, deletions: 2 },
        ...overrides,
    };
}

describe('SkipRuleEngine.classifyChanges', () => {
    it('detects DOCS_ONLY', () => {
        expect(classifyChanges([
            { filename: 'README.md' },
            { filename: 'docs/api.md' },
        ])).toBe('DOCS_ONLY');
    });
    it('detects TESTS_ONLY', () => {
        expect(classifyChanges([
            { filename: 'src/__tests__/foo.test.js' },
            { filename: 'pkg/bar_test.go' },
        ])).toBe('TESTS_ONLY');
    });
    it('detects CI_ONLY', () => {
        expect(classifyChanges([
            { filename: '.github/workflows/ci.yml' },
        ])).toBe('CI_ONLY');
    });
    it('detects DEPS_ONLY', () => {
        expect(classifyChanges([
            { filename: 'package.json' },
            { filename: 'package-lock.json' },
        ])).toBe('DEPS_ONLY');
    });
    it('detects CODE_CHANGES when any code file present', () => {
        expect(classifyChanges([
            { filename: 'src/foo.js' },
            { filename: 'README.md' },
        ])).toBe('CODE_CHANGES');
    });
    it('treats binary-only as BINARY_ONLY', () => {
        expect(classifyChanges([
            { filename: 'assets/logo.png' },
        ])).toBe('BINARY_ONLY');
    });
    it('returns EMPTY on no files', () => {
        expect(classifyChanges([])).toBe('EMPTY');
    });
});

describe('SkipRuleEngine.evaluateSkipRules', () => {
    it('SKIPs closed PRs', () => {
        const r = evaluateSkipRules(pr({ state: 'closed' }));
        expect(r.action).toBe('SKIP');
        expect(r.reason).toBe('pr_closed_or_merged');
    });
    it('SKIPs drafts', () => {
        const r = evaluateSkipRules(pr({ isDraft: true }));
        expect(r).toEqual({ action: 'SKIP', reason: 'draft_pr' });
    });
    it('SKIPs bot-authored PRs', () => {
        const r = evaluateSkipRules(pr({ author: { login: 'dependabot[bot]' } }));
        expect(r.action).toBe('SKIP');
        expect(r.reason).toMatch(/^bot_author:/);
    });
    it('SKIPs pure revert PRs by title', () => {
        const r = evaluateSkipRules(pr({ title: 'Revert "broken commit"' }));
        expect(r).toEqual({ action: 'SKIP', reason: 'revert_pr' });
    });
    it('does NOT skip a revert that also adds new code', () => {
        // The new code is exactly what needs reviewing; `/^revert\b/` swallowed it.
        const r = evaluateSkipRules(pr({
            title: 'Revert the cache layer and add a bounded LRU',
        }));
        expect(r.action).toBe('REVIEW');
    });
    it('DEFERs on merge conflict', () => {
        const r = evaluateSkipRules(pr({ mergeable: false }));
        expect(r).toEqual({ action: 'DEFER', reason: 'merge_conflict' });
    });
    it('does NOT defer when mergeable is null (still checking)', () => {
        const r = evaluateSkipRules(pr({ mergeable: null }));
        expect(r.action).not.toBe('DEFER');
    });
    it('DEFERs on failing pipeline', () => {
        const r = evaluateSkipRules(pr({ pipelineStatus: 'failed' }));
        expect(r).toEqual({ action: 'DEFER', reason: 'failing_pipeline' });
    });
    it('reviews oversized PRs partially rather than skipping them', () => {
        const files = Array.from({ length: 300 }, (_, i) => ({
            filename: `src/mod${i}.js`, additions: 30, deletions: 0,
        }));
        const r = evaluateSkipRules(pr({ files, stats: { additions: 9000, deletions: 0 } }));
        expect(r.action).toBe('REVIEW');
        expect(r.partial.reason).toMatch(/^oversized/);
        expect(r.partial.totalFiles).toBe(300);
        expect(r.partial.reviewedFiles.length).toBeGreaterThan(0);
        expect(r.partial.reviewedFiles.length).toBeLessThan(300);
        expect(r.partial.skippedFileCount).toBe(300 - r.partial.reviewedFiles.length);
    });
    it('still hard-SKIPs oversized PRs when partial review is disabled', () => {
        const r = evaluateSkipRules(
            pr({ stats: { additions: 9999, deletions: 0 } }),
            { allowPartialReview: false },
        );
        expect(r.action).toBe('SKIP');
        expect(r.reason).toMatch(/^oversized/);
    });
    it('prioritises high-churn non-generated source in a partial review', () => {
        const files = [
            { filename: 'vendor/huge.js', additions: 5000, deletions: 0 },
            { filename: 'src/small.js', additions: 5, deletions: 0 },
            { filename: 'src/big.js', additions: 900, deletions: 0 },
            { filename: 'src/big.test.js', additions: 900, deletions: 0 },
        ];
        const r = evaluateSkipRules(pr({ files, stats: { additions: 6805, deletions: 0 } }));
        expect(r.action).toBe('REVIEW');
        // Real source before tests, tests before vendored code.
        expect(r.partial.reviewedFiles[0]).toBe('src/big.js');
        expect(r.partial.reviewedFiles).toContain('src/small.js');
        expect(r.partial.reviewedFiles.indexOf('vendor/huge.js')).toBe(-1);
    });
    it('never reduces a single-huge-file MR to nothing', () => {
        const files = [{ filename: 'src/monolith.js', additions: 20000, deletions: 0 }];
        const r = evaluateSkipRules(pr({ files, stats: { additions: 20000, deletions: 0 } }));
        expect(r.action).toBe('REVIEW');
        expect(r.partial.reviewedFiles).toEqual(['src/monolith.js']);
    });
    it('AUTO_VERDICT APPROVE for docs-only', () => {
        const r = evaluateSkipRules(pr({
            files: [{ filename: 'docs/intro.md' }],
        }));
        expect(r.action).toBe('AUTO_VERDICT');
        expect(r.verdict).toBe(VERDICT.APPROVE);
        expect(r.classification).toBe('DOCS_ONLY');
    });
    it('REVIEWS tests-only PRs instead of auto-approving them', () => {
        // Wrong assertions and silently-disabled tests are real defects, and the
        // dedicated test-quality finder lens can only run if the gate lets the
        // review happen at all.
        const r = evaluateSkipRules(pr({
            files: [{ filename: 'src/foo.test.js' }],
        }));
        expect(r.action).toBe('REVIEW');
        expect(r.classification).toBe('TESTS_ONLY');
        expect(r.testsOnly).toBe(true);
        expect(r.verdict).toBeUndefined();
    });
    it('AUTO_VERDICT NEEDS_DISCUSSION for deps-only', () => {
        const r = evaluateSkipRules(pr({
            files: [{ filename: 'package.json' }, { filename: 'package-lock.json' }],
        }));
        expect(r.verdict).toBe(VERDICT.NEEDS_DISCUSSION);
        expect(r.classification).toBe('DEPS_ONLY');
    });
    it('REVIEWs normal code change', () => {
        const r = evaluateSkipRules(pr());
        expect(r.action).toBe('REVIEW');
        expect(r.classification).toBe('CODE_CHANGES');
    });
    it('handles missing pr gracefully', () => {
        expect(evaluateSkipRules(null)).toEqual({ action: 'REVIEW' });
    });
    it('supports GitLab-shaped files (new_path) and string-only state', () => {
        const r = evaluateSkipRules({
            state: 'opened',
            files: [{ new_path: 'docs/foo.md' }],
        });
        expect(r.classification).toBe('DOCS_ONLY');
    });
});

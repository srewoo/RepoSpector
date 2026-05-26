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
    it('SKIPs revert PRs by title', () => {
        const r = evaluateSkipRules(pr({ title: 'Revert "broken commit"' }));
        expect(r).toEqual({ action: 'SKIP', reason: 'revert_pr' });
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
    it('SKIPs oversized PRs', () => {
        const r = evaluateSkipRules(pr({ stats: { additions: 9999, deletions: 0 } }));
        expect(r.action).toBe('SKIP');
        expect(r.reason).toMatch(/^oversized/);
    });
    it('AUTO_VERDICT APPROVE for docs-only', () => {
        const r = evaluateSkipRules(pr({
            files: [{ filename: 'docs/intro.md' }],
        }));
        expect(r.action).toBe('AUTO_VERDICT');
        expect(r.verdict).toBe(VERDICT.APPROVE);
        expect(r.classification).toBe('DOCS_ONLY');
    });
    it('AUTO_VERDICT APPROVE for tests-only', () => {
        const r = evaluateSkipRules(pr({
            files: [{ filename: 'src/foo.test.js' }],
        }));
        expect(r.verdict).toBe(VERDICT.APPROVE);
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

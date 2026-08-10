/**
 * Prompt caching is a prefix match, so these builders have two properties no
 * other test checks:
 *
 *   1. The part marked cacheable must actually be IDENTICAL across the calls
 *      that are supposed to share it. A reordering that reads as harmless —
 *      moving the already-reported list above the diff, filtering a file list
 *      per unit — silently costs a full re-read of the largest block in the
 *      prompt on every call, and shows up only on the bill.
 *   2. Joining the parts must reproduce the single string these builders used
 *      to return, since that is what every non-Anthropic provider receives.
 *
 * Both are asserted directly rather than snapshotted, so they survive wording
 * changes and fail on the thing that matters.
 */

const { buildLensFinderPrompt, FINDER_LENSES } = require('../../src/utils/finderLensPrompts.js');
const { buildPerFileReviewPrompt } = require('../../src/utils/multiPassPrompts.js');
const { flattenContent } = require('../../src/utils/promptCache.js');

/** The text of the part carrying the cache breakpoint. */
function cacheablePart(parts) {
    const marked = parts.filter(p => p.cache);
    expect(marked).toHaveLength(1);
    return marked[0].text;
}

const DIFF = `@@ -1,4 +1,6 @@\n+const x = compute();\n+if (!x) { return; }\n${'+// filler line\n'.repeat(200)}`;

describe('buildLensFinderPrompt', () => {
    const lens = FINDER_LENSES[0];
    const base = { prTitle: 'Add retry logic', diffText: DIFF, graphContext: 'graph facts' };

    it('keeps the cacheable part identical across rounds', () => {
        const round1 = buildLensFinderPrompt(lens, { ...base, existingTitles: [] });
        const round2 = buildLensFinderPrompt(lens, {
            ...base,
            existingTitles: ['Unchecked null deref', 'Missing await'],
        });

        // Same lens, so the system prompt must be byte-identical too — it
        // renders ahead of the user turn and is part of the same prefix.
        expect(round2.system).toBe(round1.system);
        expect(cacheablePart(round2.user)).toBe(cacheablePart(round1.user));
    });

    it('puts the diff inside the cacheable part, not after it', () => {
        const { user } = buildLensFinderPrompt(lens, { ...base, existingTitles: ['a'] });
        const cached = cacheablePart(user);
        expect(cached).toContain('## Diff under review');
        expect(cached).toContain('const x = compute();');
    });

    it('keeps the per-round already-reported list out of the cacheable part', () => {
        const { user } = buildLensFinderPrompt(lens, {
            ...base,
            existingTitles: ['Unchecked null deref'],
        });
        expect(cacheablePart(user)).not.toContain('Unchecked null deref');
        expect(flattenContent(user)).toContain('Unchecked null deref');
    });

    it('still tells the finder what not to repeat', () => {
        const { user } = buildLensFinderPrompt(lens, {
            ...base,
            existingTitles: ['Unchecked null deref'],
        });
        const text = flattenContent(user);
        expect(text).toContain('do NOT repeat these');
        expect(text).toContain('Unchecked null deref');
    });

    it('says so explicitly when nothing has been reported yet', () => {
        const { user } = buildLensFinderPrompt(lens, { ...base, existingTitles: [] });
        expect(flattenContent(user)).toContain('(none yet)');
    });

    it('orders the diff before the already-reported list once joined', () => {
        const text = flattenContent(
            buildLensFinderPrompt(lens, { ...base, existingTitles: ['a'] }).user,
        );
        expect(text.indexOf('## Diff under review'))
            .toBeLessThan(text.indexOf('## Already-reported issues'));
    });
});

describe('buildPerFileReviewPrompt', () => {
    const prContext = {
        title: 'Add retry logic',
        purpose: 'Retry transient upload failures',
        sourceBranch: 'feat/retry',
        targetBranch: 'main',
        otherFiles: ['src/a.js', 'src/b.js', 'src/c.js'],
    };
    const unit = (filename) => ({
        files: [{ filename, language: 'javascript', patch: DIFF, status: 'modified' }],
    });
    const context = { prContext, standardsText: '## JS-CODING-001: rule\nbody' };

    it('keeps the cacheable part identical across review units', () => {
        const a = buildPerFileReviewPrompt(unit('src/a.js'), context);
        const b = buildPerFileReviewPrompt(unit('src/b.js'), context);
        expect(cacheablePart(b)).toBe(cacheablePart(a));
    });

    it('puts the shared preamble inside the cacheable part', () => {
        const parts = buildPerFileReviewPrompt(unit('src/a.js'), context);
        const cached = cacheablePart(parts);
        expect(cached).toContain('## PR Context');
        expect(cached).toContain('Language-Specific Checks');
        expect(cached).toContain('JS-CODING-001');
    });

    it('keeps this unit\'s own files out of the cacheable part', () => {
        const parts = buildPerFileReviewPrompt(unit('src/a.js'), context);
        // The header lists every file in the PR, so match on the diff body,
        // which is what genuinely varies per unit.
        expect(cacheablePart(parts)).not.toContain('const x = compute();');
        expect(flattenContent(parts)).toContain('const x = compute();');
    });

    it('lists every file in the PR rather than a per-unit subset', () => {
        const text = flattenContent(buildPerFileReviewPrompt(unit('src/a.js'), context));
        // The unit's own file stays listed — excluding it is what made line 1
        // differ per call and defeated caching for the whole per-file pass.
        expect(text).toContain('src/a.js');
        expect(text).toContain('src/b.js');
        expect(text).toContain('src/c.js');
    });

    it('renders a files line even when the PR context carries none', () => {
        const text = flattenContent(buildPerFileReviewPrompt(unit('src/a.js'), {
            prContext: { ...prContext, otherFiles: [] },
        }));
        expect(text).toContain('**Files in this PR**: none');
    });

    it('joins to a prompt that still carries the diff and the output contract', () => {
        const text = flattenContent(buildPerFileReviewPrompt(unit('src/a.js'), context));
        expect(text).toContain('Files Under Review');
        expect(text).toContain('__new hunk__');
    });
});

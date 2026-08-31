/**
 * The budget's job is to make the two failure modes VISIBLE: a response with no
 * room to be written (which reads as a review that found nothing), and a file
 * dropped without being named (which reads as a file that does not exist).
 */

const {
    stripDeletionOnlyHunks,
    hasReviewableChange,
    fitFilesToBudget,
    renderOmittedFiles,
    estimateTokens,
} = require('../../src/utils/diffBudget.js');
const { parsePatchHunks } = require('../../src/utils/patchLines.js');

const MODIFY_HUNK = [
    '@@ -10,3 +10,3 @@',
    '     const a = 1;',
    '-    const b = 2;',
    '+    const b = 3;',
    '     return a + b;',
].join('\n');

const DELETE_ONLY_HUNK = [
    '@@ -30,4 +29,0 @@',
    '-function dead() {',
    '-    return null;',
    '-}',
    '-',
].join('\n');

describe('stripDeletionOnlyHunks', () => {
    it('removes a hunk that only deletes', () => {
        const res = stripDeletionOnlyHunks(`${MODIFY_HUNK}\n${DELETE_ONLY_HUNK}`);
        expect(res.removedHunks).toBe(1);
        expect(res.keptHunks).toBe(1);
        expect(res.patch).not.toContain('function dead()');
        expect(res.patch).toContain('const b = 3;');
    });

    it('keeps a modification whole, including its removed side', () => {
        // A -/+ pair is a modification: the removed line is what makes the change
        // legible ("this used to check for null").
        const res = stripDeletionOnlyHunks(MODIFY_HUNK);
        expect(res.removedHunks).toBe(0);
        expect(res.patch).toContain('-    const b = 2;');
    });

    it('returns an empty patch when nothing reviewable survives', () => {
        // Not a header-only diff: "here is the diff:" followed by nothing reads
        // as a fetch failure to the model.
        const res = stripDeletionOnlyHunks(DELETE_ONLY_HUNK);
        expect(res.patch).toBe('');
        expect(res.keptHunks).toBe(0);
    });

    it('leaves the surviving patch parseable with correct line numbers', () => {
        const res = stripDeletionOnlyHunks(`${DELETE_ONLY_HUNK}\n${MODIFY_HUNK}`);
        const hunks = parsePatchHunks(res.patch);
        expect(hunks.length).toBe(1);
        expect(hunks[0].newStart).toBe(10);
        const added = hunks[0].lines.find(l => l.type === 'added');
        expect(added.number.new).toBe(11);
    });

    it('passes diff preamble lines through', () => {
        const withHeader = `--- a/x.js\n+++ b/x.js\n${MODIFY_HUNK}`;
        expect(stripDeletionOnlyHunks(withHeader).patch).toContain('+++ b/x.js');
    });

    it('is safe on junk input', () => {
        expect(stripDeletionOnlyHunks('').patch).toBe('');
        expect(stripDeletionOnlyHunks(null).patch).toBe('');
        expect(stripDeletionOnlyHunks(undefined).removedHunks).toBe(0);
    });
});

describe('hasReviewableChange', () => {
    it('is true only when something was added', () => {
        expect(hasReviewableChange(MODIFY_HUNK)).toBe(true);
        expect(hasReviewableChange(DELETE_ONLY_HUNK)).toBe(false);
        expect(hasReviewableChange('')).toBe(false);
    });
});

describe('fitFilesToBudget', () => {
    const bigPatch = (n) => ['@@ -1,1 +1,1 @@', ...Array.from({ length: n }, (_, i) => `+line ${i}`)].join('\n');

    it('reserves room for the response instead of filling the window', () => {
        // 10k window, 4k soft reserve: a 9k-token diff must not be included even
        // though it "fits" the raw window.
        const files = [{ filename: 'a.js', patch: bigPatch(9000) }];
        const { included, omitted, stats } = fitFilesToBudget({
            files, contextWindowTokens: 10_000, promptTokens: 0,
        });
        expect(included).toHaveLength(0);
        expect(omitted[0].omittedBecause).toBe('budget');
        expect(stats.stoppedEarly).toBe(true);
    });

    it('includes what fits, in the order the caller gave', () => {
        // Order is the caller's risk ranking, not re-sorted by size.
        const files = [
            { filename: 'small.js', patch: bigPatch(10) },
            { filename: 'huge.js', patch: bigPatch(50_000) },
            { filename: 'also-small.js', patch: bigPatch(10) },
        ];
        const { included, omitted } = fitFilesToBudget({ files, contextWindowTokens: 100_000 });
        expect(included.map(f => f.filename)).toEqual(['small.js', 'also-small.js']);
        expect(omitted.map(f => f.filename)).toEqual(['huge.js']);
    });

    it('names a deletion-only file instead of showing it an empty diff', () => {
        const files = [{ filename: 'dead.js', patch: DELETE_ONLY_HUNK }];
        const { included, omitted, stats } = fitFilesToBudget({ files, contextWindowTokens: 100_000 });
        expect(included).toHaveLength(0);
        expect(omitted[0].omittedBecause).toBe('no added lines');
        expect(stats.deletionOnlyHunksRemoved).toBe(1);
    });

    it('strips deletion-only hunks from files it does include', () => {
        const files = [{ filename: 'a.js', patch: `${MODIFY_HUNK}\n${DELETE_ONLY_HUNK}` }];
        const { included, stats } = fitFilesToBudget({ files, contextWindowTokens: 100_000 });
        expect(included[0].patch).not.toContain('function dead()');
        expect(stats.deletionOnlyHunksRemoved).toBe(1);
    });

    it('caps the share of the window spent on diff text', () => {
        // maxDiffShare 0.6 of a 20k window = 12k, even with nothing else in the
        // prompt and a generous reserve.
        const files = [{ filename: 'a.js', patch: bigPatch(13_000) }];
        const { included } = fitFilesToBudget({ files, contextWindowTokens: 20_000 });
        expect(included).toHaveLength(0);
    });

    it('counts the prompt that already exists', () => {
        const files = [{ filename: 'a.js', patch: bigPatch(2000) }];
        const roomy = fitFilesToBudget({ files, contextWindowTokens: 30_000, promptTokens: 0 });
        const crowded = fitFilesToBudget({ files, contextWindowTokens: 30_000, promptTokens: 28_000 });
        expect(roomy.included).toHaveLength(1);
        expect(crowded.included).toHaveLength(0);
    });

    it('enforces nothing when the window size is unknown', () => {
        // A guessed ceiling would silently truncate real reviews.
        const files = [{ filename: 'a.js', patch: bigPatch(100_000) }];
        expect(fitFilesToBudget({ files, contextWindowTokens: 0 }).included).toHaveLength(1);
        expect(fitFilesToBudget({ files }).included).toHaveLength(1);
    });

    it('accepts an injected token counter', () => {
        const counted = [];
        fitFilesToBudget({
            files: [{ filename: 'a.js', patch: MODIFY_HUNK }],
            contextWindowTokens: 100_000,
            countTokens: (t) => { counted.push(t); return 1; },
        });
        expect(counted).toHaveLength(1);
    });

    it('handles an empty file list', () => {
        const res = fitFilesToBudget({ files: [], contextWindowTokens: 10_000 });
        expect(res.included).toEqual([]);
        expect(res.omitted).toEqual([]);
    });
});

describe('renderOmittedFiles', () => {
    it('is empty when nothing was omitted', () => {
        expect(renderOmittedFiles([])).toBe('');
        expect(renderOmittedFiles()).toBe('');
    });

    it('names omitted files and forbids inferring from their absence', () => {
        const out = renderOmittedFiles([
            { filename: 'src/caller.js', additions: 4, deletions: 1, omittedBecause: 'budget' },
        ]);
        expect(out).toContain('src/caller.js');
        expect(out).toContain('+4 -1');
        // The whole point: stop the model reporting "the caller was not updated".
        expect(out).toMatch(/not updated/);
    });

    it('lists deleted files separately', () => {
        const out = renderOmittedFiles([
            { filename: 'src/a.js', omittedBecause: 'budget' },
            { filename: 'src/gone.js', status: 'removed' },
        ]);
        expect(out).toContain('Deleted files:');
        const deletedIdx = out.indexOf('Deleted files:');
        expect(out.indexOf('src/gone.js')).toBeGreaterThan(deletedIdx);
        expect(out.indexOf('src/a.js')).toBeLessThan(deletedIdx);
    });

    it('marks a removals-only file as such', () => {
        const out = renderOmittedFiles([{ filename: 'src/a.js', omittedBecause: 'no added lines' }]);
        expect(out).toContain('removals only');
    });
});

describe('estimateTokens', () => {
    it('scales with length and is zero for nothing', () => {
        expect(estimateTokens('')).toBe(0);
        expect(estimateTokens(null)).toBe(0);
        expect(estimateTokens('a'.repeat(400))).toBe(100);
    });
});

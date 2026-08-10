/**
 * The multi-finder diff budget.
 *
 * `_buildDiffText` walked the files in order and `break`ed the moment one did not
 * fit the remaining budget. A single large FIRST file therefore consumed the whole
 * allowance and no other file in the MR was shown to any lens.
 *
 * This matters more than it looks: the multi-finder pass is what moved measured
 * human-comment recall from 0% to ~31%, and the eval's recorded misses were
 * concentrated in large files — consistent with this truncation rather than with
 * the "attention dilution" it was attributed to.
 */

const { MultiFinderService } = require('../../src/services/MultiFinderService.js');

const svc = new MultiFinderService({});
const file = (filename, size) => ({ filename, patch: 'x'.repeat(size) });

describe('MultiFinderService._buildDiffText', () => {
    it('shows every file even when the first one is huge', () => {
        const prData = {
            files: [
                file('src/huge.js', 30000),   // 2.5x the whole budget on its own
                file('src/small.js', 100),
                file('src/other.js', 200),
            ],
        };
        const text = svc._buildDiffText(prData);

        expect(text).toContain('### src/huge.js');
        expect(text).toContain('### src/small.js');
        expect(text).toContain('### src/other.js');
    });

    it('gives the small files their content in full', () => {
        const prData = {
            files: [file('src/huge.js', 30000), file('src/small.js', 100)],
        };
        const text = svc._buildDiffText(prData);
        const smallSection = text.slice(text.indexOf('### src/small.js'));
        expect(smallSection).not.toContain('truncated');
        expect(smallSection).toContain('x'.repeat(100));
    });

    // Swept across widths, because a single width hides the failure: the first
    // version of this test used 20 files, where 12000/20 = 600 clears the 400-char
    // per-file floor, so the floor never bit and a 4x budget overrun at 100 files
    // went unnoticed until a live eval run.
    it.each([1, 2, 5, 10, 20, 30, 50, 100, 400])(
        'stays within the total budget at %i files',
        (n) => {
            const prData = { files: Array.from({ length: n }, (_, i) => file(`src/f${i}.js`, 5000)) };
            const budget = 12000;
            const text = svc._buildDiffText(prData, budget);
            // Per-file headers and truncation notes are framing, not diff payload.
            const framing = Math.min(n, Math.floor(budget / 400)) * 140 + 120;
            expect(text.length).toBeLessThanOrEqual(budget + framing);
        },
    );

    it('shows fewer files rather than blowing the budget when the MR is very wide', () => {
        const prData = { files: Array.from({ length: 100 }, (_, i) => file(`src/f${i}.js`, 5000)) };
        const text = svc._buildDiffText(prData, 12000);
        const shown = (text.match(/### src\//g) || []).length;
        // 12000 / 400 = at most 30 files can get a usable slice.
        expect(shown).toBeLessThanOrEqual(30);
        expect(shown).toBeGreaterThan(0);
    });

    it('says how many files it omitted', () => {
        const prData = { files: Array.from({ length: 100 }, (_, i) => file(`src/f${i}.js`, 5000)) };
        const text = svc._buildDiffText(prData, 12000);
        // A lens told "here is the diff" will reason as though it saw all of it.
        expect(text).toMatch(/further changed file\(s\) omitted/);
    });

    it('omits nothing when every file fits', () => {
        const prData = { files: [file('a.js', 100), file('b.js', 100)] };
        expect(svc._buildDiffText(prData, 12000)).not.toMatch(/omitted/);
    });

    it('announces truncation so a lens knows it sees a partial file', () => {
        const text = svc._buildDiffText({ files: [file('src/huge.js', 30000)] });
        expect(text).toMatch(/truncated at \d+ of 30000 chars/);
    });

    it('does not announce truncation when nothing was cut', () => {
        const text = svc._buildDiffText({ files: [file('src/a.js', 50)] });
        expect(text).not.toContain('truncated');
    });

    it('gives the files it DOES show a usable slice on a very wide MR', () => {
        // The tradeoff on a wide MR is fewer files at a readable size, not every
        // file at an unreadable one: 12000/200 = 60 chars each is worse than not
        // showing the file, because it invites a finding the lens cannot ground.
        const prData = {
            files: Array.from({ length: 200 }, (_, i) => file(`src/f${i}.js`, 2000)),
        };
        const text = svc._buildDiffText(prData, 12000);

        const shown = [...text.matchAll(/### (src\/f\d+\.js)/g)].map(m => m[1]);
        expect(shown.length).toBeGreaterThan(0);
        expect(shown.length).toBeLessThanOrEqual(30);   // 12000 / 400

        for (const name of shown) {
            const start = text.indexOf(`### ${name}`);
            const next = text.indexOf('### ', start + 4);
            const section = text.slice(start, next === -1 ? undefined : next);
            expect(section.length).toBeGreaterThan(300);
        }
        expect(text).toMatch(/further changed file\(s\) omitted/);
    });

    it('redistributes leftover budget to the files that were cut', () => {
        // One tiny file plus one large one: the large file should receive far more
        // than a naive equal split (12000/2 = 6000) because the small file frees up
        // almost its entire share.
        const prData = { files: [file('src/tiny.js', 10), file('src/big.js', 30000)] };
        const text = svc._buildDiffText(prData, 12000);
        const match = text.match(/truncated at (\d+) of 30000 chars/);
        expect(match).toBeTruthy();
        expect(Number(match[1])).toBeGreaterThan(6000);
    });

    it('returns empty string when no file carries a patch', () => {
        expect(svc._buildDiffText({ files: [{ filename: 'a.js' }] })).toBe('');
        expect(svc._buildDiffText({ files: [] })).toBe('');
        expect(svc._buildDiffText({})).toBe('');
    });
});

/**
 * The eval harness found misses concentrating in large files while the same
 * defect classes were caught 100% of the time in small ones, and read it as
 * attention dilution. Windowing is the response. The risk it introduces is
 * showing the model a fragment it mistakes for the whole file, so the tests
 * pin the boundaries and the sibling note as much as the splitting.
 */
const { windowFile, WINDOW_DEFAULTS } = require('../../src/services/HunkWindower.js');

/** A patch with `count` hunks of `linesEach` added lines apiece. */
function makePatch(count, linesEach) {
    const out = [];
    for (let h = 0; h < count; h++) {
        const start = 1 + h * 1000;
        out.push(`@@ -${start},${linesEach} +${start},${linesEach} @@`);
        for (let i = 0; i < linesEach; i++) out.push(`+line ${h}-${i}`);
    }
    return out.join('\n');
}

describe('windowFile', () => {
    it('returns the file unchanged in a single window when below threshold', () => {
        const file = { filename: 'src/small.js', patch: makePatch(2, 10), additions: 20, deletions: 0 };
        const windows = windowFile(file);
        expect(windows).toHaveLength(1);
        expect(windows[0].windowTotal).toBe(1);
        expect(windows[0].patch).toBe(file.patch);
        expect(windows[0].siblingNote).toBe('');
    });

    it('splits a large file into multiple windows', () => {
        const file = { filename: 'src/big.go', patch: makePatch(10, 60), additions: 600, deletions: 0 };
        const windows = windowFile(file);
        expect(windows.length).toBeGreaterThan(1);
        expect(windows.every(w => w.filename === 'src/big.go')).toBe(true);
        expect(windows.map(w => w.windowIndex)).toEqual(windows.map((_, i) => i + 1));
        expect(new Set(windows.map(w => w.windowTotal))).toEqual(new Set([windows.length]));
    });

    it('never splits an individual hunk', () => {
        const file = { filename: 'src/big.go', patch: makePatch(10, 60), additions: 600, deletions: 0 };
        const windows = windowFile(file);
        const original = new Set(file.patch.split('\n').filter(l => l.startsWith('@@')));
        const seenHeaders = [];

        for (const w of windows) {
            const lines = w.patch.split('\n');

            // A leading overlap is a comment block (plus blank separator lines),
            // never diff content — strip it and the remainder must start with a
            // real hunk header. That is the actual "no orphaned hunk body"
            // invariant; it tolerates the legitimate leading overlap instead of
            // rejecting it.
            let i = 0;
            while (i < lines.length && (lines[i] === '' || lines[i].startsWith('#'))) i++;
            expect(lines[i]).toBeDefined();
            expect(lines[i].startsWith('@@')).toBe(true);

            const headerIdxs = [];
            lines.forEach((l, idx) => { if (l.startsWith('@@')) headerIdxs.push(idx); });
            expect(headerIdxs.length).toBeGreaterThan(0);
            headerIdxs.forEach(h => seenHeaders.push(lines[h]));

            // No header was emitted without its body: the lines between EVERY
            // header and the next (or end of patch) are non-empty, not just some.
            for (let h = 0; h < headerIdxs.length; h++) {
                const start = headerIdxs[h] + 1;
                const end = h + 1 < headerIdxs.length ? headerIdxs[h + 1] : lines.length;
                expect(end).toBeGreaterThan(start);
            }
        }

        // Across all windows, headers are neither lost nor duplicated into two windows.
        expect(new Set(seenHeaders)).toEqual(original);
        expect(seenHeaders.length).toBe(original.size);
    });

    it('keeps a single oversized hunk whole in its own window', () => {
        const file = { filename: 'src/huge.js', patch: makePatch(1, 900), additions: 900, deletions: 0 };
        const windows = windowFile(file);
        expect(windows).toHaveLength(1);
        expect(windows[0].patch.split('\n').filter(l => l.startsWith('@@'))).toHaveLength(1);
    });

    it('covers every hunk across the windows, losing none', () => {
        const file = { filename: 'src/big.go', patch: makePatch(9, 55), additions: 495, deletions: 0 };
        const seen = windowFile(file)
            .flatMap(w => w.patch.split('\n').filter(l => l.startsWith('@@')));
        const original = file.patch.split('\n').filter(l => l.startsWith('@@'));
        expect(new Set(seen)).toEqual(new Set(original));
    });

    it('tells the model that sibling windows exist', () => {
        const windows = windowFile({ filename: 'src/big.go', patch: makePatch(10, 60), additions: 600, deletions: 0 });
        expect(windows[0].siblingNote).toContain('window 1 of');
        expect(windows[0].siblingNote).toMatch(/not.*missing|other windows|reviewed separately/i);
    });

    it('splits a large patch even when additions/deletions metadata is absent', () => {
        // Both platform paths populate additions/deletions today, but if that
        // metadata were ever missing, treating the file as 0 changed lines
        // would silently disable splitting for a possibly-huge patch — the
        // worst failure mode for a feature whose whole point is splitting.
        const file = { filename: 'src/big.go', patch: makePatch(10, 60) };
        const windows = windowFile(file);
        expect(windows.length).toBeGreaterThan(1);
    });

    it('respects overrides', () => {
        const file = { filename: 'src/big.go', patch: makePatch(10, 60), additions: 600, deletions: 0 };
        expect(windowFile(file, { minLocToSplit: 100000 })).toHaveLength(1);
    });

    it('handles a file with no patch without throwing', () => {
        const windows = windowFile({ filename: 'bin/blob.png', additions: 0, deletions: 0 });
        expect(windows).toHaveLength(1);
        expect(windows[0].patch).toBe('');
    });

    it('exposes its defaults', () => {
        expect(WINDOW_DEFAULTS.minLocToSplit).toBe(250);
        expect(WINDOW_DEFAULTS.maxLocPerWindow).toBe(200);
        expect(WINDOW_DEFAULTS.overlapLines).toBe(20);
    });
});

/**
 * Rule 2 — scope awareness.
 *
 * Rule 1 ("never split a hunk") still allowed a break between two hunks that
 * both edit the same function, so each half went to a different reviewer and
 * any defect visible only across both halves was structurally unreachable.
 * The scope signal is git's own hunk section heading, so these tests build
 * patches with real headings.
 */
function makeSectionedPatch(sections) {
    const out = [];
    let line = 1;
    for (const { heading, hunks, linesEach } of sections) {
        for (let h = 0; h < hunks; h++) {
            out.push(`@@ -${line},${linesEach} +${line},${linesEach} @@ ${heading}`);
            for (let i = 0; i < linesEach; i++) out.push(`+${heading}-${h}-${i}`);
            line += linesEach + 20;
        }
    }
    return out.join('\n');
}

/** Which window index each hunk header landed in. */
function headerPlacement(windows) {
    const map = new Map();
    windows.forEach(w => {
        w.patch.split('\n')
            .filter(l => l.startsWith('@@'))
            .forEach(h => map.set(h, w.windowIndex));
    });
    return map;
}

describe('windowFile — declaration boundaries', () => {
    it('keeps every hunk of one declaration in the same window', () => {
        // Three declarations, each edited by 3 hunks of 40 lines = 120 loc per
        // declaration. With maxLocPerWindow 200, greedy per-hunk packing would
        // fit 1.5 declarations per window and split the middle one.
        const patch = makeSectionedPatch([
            { heading: 'func Alpha(', hunks: 3, linesEach: 40 },
            { heading: 'func Beta(', hunks: 3, linesEach: 40 },
            { heading: 'func Gamma(', hunks: 3, linesEach: 40 },
        ]);
        const windows = windowFile({ filename: 'src/svc.go', patch, additions: 360, deletions: 0 });
        expect(windows.length).toBeGreaterThan(1);

        const placement = headerPlacement(windows);
        for (const heading of ['func Alpha(', 'func Beta(', 'func Gamma(']) {
            const windowsUsed = new Set(
                [...placement.entries()]
                    .filter(([header]) => header.endsWith(heading))
                    .map(([, idx]) => idx),
            );
            expect(windowsUsed.size).toBe(1);
        }
    });

    it('does not merge same-named declarations separated by another one', () => {
        // git repeats the nearest preceding declaration, so a heading recurring
        // after an intervening one is a different region of the file — merging
        // them would drag unrelated code into one window.
        const patch = makeSectionedPatch([
            { heading: 'func Alpha(', hunks: 1, linesEach: 30 },
            { heading: 'func Beta(', hunks: 1, linesEach: 30 },
            { heading: 'func Alpha(', hunks: 1, linesEach: 30 },
        ]);
        const windows = windowFile(
            { filename: 'src/svc.go', patch, additions: 90, deletions: 0 },
            { minLocToSplit: 10, maxLocPerWindow: 40 },
        );
        // Three separate units at 31 loc each and a 40 loc budget → one per window.
        expect(windows).toHaveLength(3);
    });

    it('falls back to per-hunk packing when one declaration is too big to keep whole', () => {
        // A whole-file rewrite carries one heading across the entire patch.
        // Honouring rule 2 there would rebuild the single oversized prompt that
        // windowing exists to prevent, so the section degrades to hunks.
        const patch = makeSectionedPatch([
            { heading: 'func Everything(', hunks: 20, linesEach: 50 },
        ]);
        const windows = windowFile({ filename: 'src/mono.go', patch, additions: 1000, deletions: 0 });
        expect(windows.length).toBeGreaterThan(1);
    });

    it('treats headingless hunks individually, preserving pre-scope packing', () => {
        // Config and plain-text patches get no funcname from git. Collapsing
        // them all into one "" section would make the whole file indivisible.
        const noHeadings = makePatch(10, 60);
        const windows = windowFile({ filename: 'deploy/values.yaml', patch: noHeadings, additions: 600, deletions: 0 });
        expect(windows.length).toBeGreaterThan(1);
    });

    it('still loses no hunk when grouping by declaration', () => {
        const patch = makeSectionedPatch([
            { heading: 'class Repo:', hunks: 4, linesEach: 45 },
            { heading: 'def save(', hunks: 2, linesEach: 45 },
            { heading: 'def load(', hunks: 5, linesEach: 45 },
        ]);
        const file = { filename: 'src/repo.py', patch, additions: 495, deletions: 0 };
        const seen = windowFile(file).flatMap(w => w.patch.split('\n').filter(l => l.startsWith('@@')));
        const original = patch.split('\n').filter(l => l.startsWith('@@'));
        expect(new Set(seen)).toEqual(new Set(original));
        expect(seen.length).toBe(original.length);
    });

    it('exposes the section ceiling as a tunable default', () => {
        expect(WINDOW_DEFAULTS.maxSectionLoc).toBe(400);
    });
});

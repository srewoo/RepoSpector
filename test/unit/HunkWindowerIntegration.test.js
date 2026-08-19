/**
 * Windowing changes how many LLM calls a review makes, so the flag being
 * genuinely off by default matters as much as the splitting working.
 */
const { FileGroupingStrategy } = require('../../src/services/FileGroupingStrategy.js');
const { chunkMR } = require('../../src/services/MRChunker.js');

function bigFile(filename, hunks = 10, linesEach = 60) {
    const out = [];
    for (let h = 0; h < hunks; h++) {
        const start = 1 + h * 1000;
        out.push(`@@ -${start},${linesEach} +${start},${linesEach} @@`);
        for (let i = 0; i < linesEach; i++) out.push(`+line ${h}-${i}`);
    }
    return {
        filename,
        patch: out.join('\n'),
        additions: hunks * linesEach,
        deletions: 0,
        language: 'go',
    };
}

describe('FileGroupingStrategy with hunk windowing', () => {
    it('produces one solo unit for a large file when the flag is off', () => {
        const strategy = new FileGroupingStrategy();
        const units = strategy.group([bigFile('tsdb/head_wal.go')]);
        const forFile = units.filter(u => u.primaryFile === 'tsdb/head_wal.go');
        expect(forFile).toHaveLength(1);
        expect(forFile[0].type).toBe('solo');
    });

    it('is off by default even when not passed explicitly', () => {
        const strategy = new FileGroupingStrategy({});
        expect(strategy.hunkWindowing).toBe(false);
    });

    it('expands a large file into windowed units when the flag is on', () => {
        const strategy = new FileGroupingStrategy({ hunkWindowing: true });
        const units = strategy.group([bigFile('tsdb/head_wal.go')]);
        const forFile = units.filter(u => u.primaryFile === 'tsdb/head_wal.go');
        expect(forFile.length).toBeGreaterThan(1);
        expect(forFile.every(u => u.type === 'solo-window')).toBe(true);
        expect(forFile.map(u => u.windowIndex)).toEqual(forFile.map((_, i) => i + 1));
        expect(forFile[0].siblingNote).toContain('window 1 of');
    });

    it('leaves a small file as a single unit even with the flag on', () => {
        const strategy = new FileGroupingStrategy({ hunkWindowing: true });
        const units = strategy.group([bigFile('src/small.js', 2, 10)]);
        const forFile = units.filter(u => u.primaryFile === 'src/small.js');
        expect(forFile).toHaveLength(1);
    });

    it('keeps grouped small files untouched with the flag on', () => {
        const strategy = new FileGroupingStrategy({ hunkWindowing: true });
        const small = [
            { filename: 'src/a.js', patch: '@@ -1,2 +1,2 @@\n+a', additions: 2, deletions: 0, language: 'javascript' },
            { filename: 'src/b.js', patch: '@@ -1,2 +1,2 @@\n+b', additions: 2, deletions: 0, language: 'javascript' },
        ];
        const units = new FileGroupingStrategy({ hunkWindowing: true }).group(small);
        expect(units.some(u => u.type === 'group')).toBe(true);
        expect(units.some(u => u.type === 'solo-window')).toBe(false);
        expect(strategy.hunkWindowing).toBe(true);
    });
});

function smallFile(filename) {
    return {
        filename,
        patch: '@@ -1,2 +1,2 @@\n+a\n+b',
        additions: 2,
        deletions: 0,
        language: 'javascript',
    };
}

function inputTotalLoc(files) {
    let n = 0;
    for (const f of files) n += (f.additions ?? 0) + (f.deletions ?? 0);
    return n;
}

// Counts real added/removed diff lines in a patch, ignoring the
// comment-prefixed overlap block HunkWindower leads a window with (every
// line there starts with `# `, never bare `+`/`-`). This is what actually
// proves content reached an LLM prompt or not — `additions`/`deletions` on a
// window is a copy of the WHOLE file's counters (see HunkWindower), so it
// cannot be summed across windows to check for loss the way real diff lines
// can.
function realChangedLineCount(patch) {
    if (!patch) return 0;
    let n = 0;
    for (const line of patch.split('\n')) {
        if (line.startsWith('+') || line.startsWith('-')) {
            if (line.startsWith('+++') || line.startsWith('---')) continue;
            n++;
        }
    }
    return n;
}

describe('chunkMR + windowing composition (regression)', () => {
    // Regression for: MRChunker's own packing pass used to enable windowing
    // too. Its `locOf()` credits each window with the file's FULL
    // additions/deletions, so two windows of one file could land in the same
    // chunk sharing one `filename`; `FileGroupingStrategy.group()`'s
    // `assigned.has(filename)` dedup then silently dropped one window's diff,
    // and the survivor was emitted as `type: 'solo'` — a complete-looking
    // review that had actually lost content. This test runs the REAL
    // chunk-then-group composition (chunkMR with windowing OFF for packing,
    // then per-chunk FileGroupingStrategy with windowing ON — exactly what
    // ReviewOrchestrator + MultiPassReviewEngine do together) and asserts no
    // changed lines are lost and no chunk ever carries a duplicate filename.
    it('loses no changed lines and produces no duplicate filenames per chunk when chunking meets windowing', () => {
        const bigFileEntry = bigFile('tsdb/head_wal.go', 10, 60); // 600 changed lines, windows into 4
        const smallFiles = Array.from({ length: 24 }, (_, i) => smallFile(`src/file${i}.js`));
        const files = [bigFileEntry, ...smallFiles]; // 25 files >= chunkingThresholdFiles (20)

        // `hunkWindowing: true` is passed here deliberately, even though
        // `chunkMR` no longer reads it: this is the value that would reach
        // MRChunker's packing pass if a future caller re-threaded `settings`
        // in (the exact regression). Passing it and still getting a clean
        // result proves the packing pass really ignores it.
        const { chunks, summary } = chunkMR({ files }, { hunkWindowing: true });
        expect(summary.chunked).toBe(true);
        expect(chunks.length).toBeGreaterThan(0);

        const inputRealLines = files.reduce((acc, f) => acc + realChangedLineCount(f.patch), 0);

        let reachedRealLines = 0;
        const bigFileUnits = [];
        for (const chunk of chunks) {
            // No duplicate filenames may reach a chunk's own file list — the
            // bug's precondition (packing crediting a window with the whole
            // file's loc, so two windows of one file land in the same chunk).
            const chunkSeen = new Set();
            for (const f of chunk.files) {
                expect(chunkSeen.has(f.filename)).toBe(false);
                chunkSeen.add(f.filename);
            }

            // This is the real per-chunk step MultiPassReviewEngine performs:
            // `new FileGroupingStrategy({ hunkWindowing: settings?.hunkWindowing ?? HUNK_WINDOWING })`.
            const units = new FileGroupingStrategy({ hunkWindowing: true }).group(chunk.files, {});
            for (const unit of units) {
                const unitSeen = new Set();
                for (const f of unit.files) {
                    // No duplicate filenames within a review unit either — the
                    // dedup that silently dropped the second window's diff was
                    // keyed on filename at this exact level.
                    expect(unitSeen.has(f.filename)).toBe(false);
                    unitSeen.add(f.filename);
                    reachedRealLines += realChangedLineCount(f.patch);
                }
                if (unit.primaryFile === 'tsdb/head_wal.go') bigFileUnits.push(unit);
            }
        }

        // The actual regression: total real diff lines (+/-) reaching review
        // units must equal what the input carried — no content silently
        // dropped. (additions/deletions counters are not usable for this
        // check: HunkWindower stamps the WHOLE file's counters onto every
        // window, so they cannot be summed across windows to detect loss.)
        expect(reachedRealLines).toBe(inputRealLines);
        expect(inputTotalLoc(files)).toBeGreaterThan(0);

        // And the big file was actually windowed end-to-end, not silently
        // collapsed back into one 'solo' unit downstream.
        expect(bigFileUnits.length).toBeGreaterThan(1);
        expect(bigFileUnits.every(u => u.type === 'solo-window')).toBe(true);
        expect(bigFileUnits.map(u => u.windowIndex).sort((a, b) => a - b))
            .toEqual(bigFileUnits.map((_, i) => i + 1));
    });
});

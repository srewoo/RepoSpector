/**
 * Static-analysis findings are produced against the concatenated added-lines
 * block, not the file. These tests pin the translation back to file
 * coordinates — the bug they cover put inline comments on unrelated code while
 * still looking authoritative.
 */

const {
    extractAddedLines,
    mapAddedBlockLine,
    oldLineForNewLine,
} = require('../../src/utils/patchLines.js');
const { StaticAnalysisService } = require('../../src/services/StaticAnalysisService.js');

// Two hunks, deliberately with context and removed lines before the added ones
// so block coordinates and file coordinates cannot coincide by accident.
const PATCH = [
    '@@ -1,6 +1,7 @@',
    ' const a = 1;',      // new 1  (context)
    ' const b = 2;',      // new 2  (context)
    '-const old = 3;',    //        (removed)
    '+eval(userInput);',  // new 3  (added)   <- block line 1
    '+const c = 4;',      // new 4  (added)   <- block line 2
    ' const d = 5;',      // new 5  (context)
    ' const e = 6;',      // new 6  (context)
    ' const f = 7;',      // new 7  (context)
    '@@ -40,4 +41,5 @@',
    ' function g() {',    // new 41 (context)
    '+  return eval(x);', // new 42 (added)   <- block line 3
    ' }',                 // new 43 (context)
    ' // tail',           // new 44 (context)
].join('\n');

describe('extractAddedLines', () => {
    it('returns only added lines, with their real new-side file numbers', () => {
        const { code, lineNumbers } = extractAddedLines(PATCH);

        expect(code.split('\n')).toEqual([
            'eval(userInput);',
            'const c = 4;',
            '  return eval(x);',
        ]);
        expect(lineNumbers).toEqual([3, 4, 42]);
    });

    it('keeps the code block and the line map the same length', () => {
        const { code, lineNumbers } = extractAddedLines(PATCH);
        expect(code.split('\n')).toHaveLength(lineNumbers.length);
    });

    it('is empty for a patch with no additions', () => {
        const { code, lineNumbers } = extractAddedLines('@@ -1,2 +1,1 @@\n const a = 1;\n-const b = 2;');
        expect(code).toBe('');
        expect(lineNumbers).toEqual([]);
    });
});

describe('mapAddedBlockLine', () => {
    const map = [3, 4, 42];

    it('translates a 1-based block line to the file line', () => {
        expect(mapAddedBlockLine(1, map)).toBe(3);
        expect(mapAddedBlockLine(3, map)).toBe(42);
    });

    it('returns null rather than guessing when the line is out of range', () => {
        expect(mapAddedBlockLine(4, map)).toBeNull();
        expect(mapAddedBlockLine(0, map)).toBeNull();
        expect(mapAddedBlockLine(undefined, map)).toBeNull();
    });
});

describe('StaticAnalysisService.remapFindingsToFileLines', () => {
    const svc = new StaticAnalysisService();
    const map = [3, 4, 42];

    it('rewrites line to the real file line and preserves the original', () => {
        const [f] = svc.remapFindingsToFileLines([{ line: 3, severity: 'critical' }], map);
        expect(f.line).toBe(42);
        expect(f.blockLine).toBe(3);
        expect(f.severity).toBe('critical');
    });

    it('maps endLine into the same coordinate space', () => {
        const [f] = svc.remapFindingsToFileLines([{ line: 1, endLine: 2 }], map);
        expect(f.line).toBe(3);
        expect(f.endLine).toBe(4);
    });

    it('never lets a mapped endLine fall before the start line', () => {
        // block 2 -> file 4, block 3 -> file 42; a reversed range must not survive
        const [f] = svc.remapFindingsToFileLines([{ line: 3, endLine: 2 }], map);
        expect(f.endLine).toBeGreaterThanOrEqual(f.line);
    });

    it('drops the line of an unmappable finding instead of guessing', () => {
        const [f] = svc.remapFindingsToFileLines([{ line: 99, title: 'x' }], map);
        expect(f.line).toBeUndefined();
        expect(f.lineUnresolved).toBe(true);
        expect(f.title).toBe('x');
    });

    it('leaves findings alone when no map is available', () => {
        const input = [{ line: 7 }];
        expect(svc.remapFindingsToFileLines(input, [])).toEqual(input);
    });
});

describe('StaticAnalysisService.analyzePullRequest line coordinates', () => {
    it('reports eval() on the file line, not the block line', async () => {
        const svc = new StaticAnalysisService({
            enableDependency: false,
            enableEOL: false,
        });

        const result = await svc.analyzePullRequest({
            files: [{ filename: 'src/app.js', status: 'modified', patch: PATCH, additions: 3, deletions: 1 }],
        }, { enableDependency: false });

        const evalFindings = result.findings.filter(f => /eval/i.test(f.message || f.title || ''));
        expect(evalFindings.length).toBeGreaterThan(0);

        // The added `eval(` calls live on file lines 3 and 42. Block coordinates
        // would have reported 1 and 3 — the regression this guards.
        const lines = evalFindings.map(f => f.line).filter(n => n != null);
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
            expect([3, 42]).toContain(line);
        }
    });
});

describe('oldLineForNewLine', () => {
    it('resolves the old-side number for a context line', () => {
        // new 5 is ' const d = 5;', old side 4 (one line was removed above it)
        expect(oldLineForNewLine(PATCH, 5)).toBe(4);
    });

    it('returns null for an added line, so callers omit old_line', () => {
        expect(oldLineForNewLine(PATCH, 3)).toBeNull();
        expect(oldLineForNewLine(PATCH, 42)).toBeNull();
    });

    it('returns null for a line outside the diff', () => {
        expect(oldLineForNewLine(PATCH, 999)).toBeNull();
    });
});

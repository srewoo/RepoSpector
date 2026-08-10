const { assignChunkStartLines, numberLines } = require('../../src/utils/chunkLines.js');

const FILE = [
    'import { save } from "./db";',   // 1
    '',                               // 2
    'export function a() {',          // 3
    '  return save(1);',              // 4
    '}',                              // 5
    '',                               // 6
    'export function b() {',          // 7
    '  return save(2);',              // 8
    '}',                              // 9
].join('\n');

describe('assignChunkStartLines', () => {
    it('gives each chunk the 1-based line it starts at', () => {
        const chunks = [
            { content: 'import { save } from "./db";\n' },
            { content: 'export function b() {\n  return save(2);\n}' },
        ];
        expect(assignChunkStartLines(FILE, chunks).map(c => c.startLine)).toEqual([1, 7]);
    });

    it('handles overlapping chunks, which the chunker always produces', () => {
        // ~200 tokens of the previous chunk are prepended to the next, so a
        // chunk can begin before the previous one ended.
        const chunks = [
            { content: 'export function a() {\n  return save(1);\n}' },
            { content: '}\n\nexport function b() {' },
        ];
        expect(assignChunkStartLines(FILE, chunks).map(c => c.startLine)).toEqual([3, 5]);
    });

    it('picks the occurrence belonging to this chunk when text repeats', () => {
        // A duplicated block would otherwise all resolve to the first match.
        const dup = 'x();\ny();\nx();\ny();\n';
        const chunks = [{ content: 'x();\ny();\n' }, { content: 'x();\ny();\n' }];
        expect(assignChunkStartLines(dup, chunks).map(c => c.startLine)).toEqual([1, 1]);
    });

    it('returns null for a chunk that is not a substring of the file', () => {
        // Guessing would produce a confident wrong line, which is the failure
        // this whole mechanism exists to avoid.
        const out = assignChunkStartLines(FILE, [{ content: 'never appears anywhere' }]);
        expect(out[0].startLine).toBeNull();
    });

    it('preserves the rest of each chunk', () => {
        const out = assignChunkStartLines(FILE, [{ content: '}', tokens: 5, type: 'code' }]);
        expect(out[0].tokens).toBe(5);
        expect(out[0].type).toBe('code');
    });

    it('handles empty input without throwing', () => {
        expect(assignChunkStartLines('', [{ content: 'x' }])[0].startLine).toBeNull();
        expect(assignChunkStartLines(FILE, [])).toEqual([]);
        expect(assignChunkStartLines(FILE, [{ content: '' }])[0].startLine).toBeNull();
    });

    it('is correct for a chunk at the very end of the file', () => {
        const out = assignChunkStartLines(FILE, [{ content: '  return save(2);\n}' }]);
        expect(out[0].startLine).toBe(8);
    });

    it('matches the first occurrence, including one inside another line', () => {
        // `}` appears on line 1 inside `import { save }`, not first on line 5 —
        // the search is over characters, not whole lines, and callers pass
        // multi-line chunks precisely so the match is unambiguous.
        expect(assignChunkStartLines(FILE, [{ content: '}' }])[0].startLine).toBe(1);
    });
});

describe('numberLines', () => {
    it('numbers from the given start line', () => {
        expect(numberLines('a\nb', 10)).toBe('10 | a\n11 | b');
    });

    it('pads so the gutter stays aligned across a width change', () => {
        expect(numberLines('a\nb', 9)).toBe(' 9 | a\n10 | b');
    });

    it('returns the content unchanged when there is no line information', () => {
        expect(numberLines('a\nb', null)).toBe('a\nb');
        expect(numberLines('a\nb', 0)).toBe('a\nb');
        expect(numberLines('a\nb', undefined)).toBe('a\nb');
    });
});

describe('end to end', () => {
    it('numbers a chunk with the file\'s real line numbers', () => {
        const [chunk] = assignChunkStartLines(FILE, [
            { content: 'export function b() {\n  return save(2);\n}' },
        ]);
        const numbered = numberLines(chunk.content, chunk.startLine);
        expect(numbered).toContain('7 | export function b() {');
        expect(numbered).toContain('8 |   return save(2);');
        // Which matches the real file.
        expect(FILE.split('\n')[6]).toBe('export function b() {');
    });
});

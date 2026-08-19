/**
 * The adjudication worksheet is only as good as the code it shows. A hunk
 * slicer that returns the wrong window makes every verdict it informs wrong,
 * and silently — the reader has no way to tell they judged the wrong lines.
 */
const { splitHunks, hunkForLine } = require('../../eval/lib/hunks.js');

const PATCH = [
    '@@ -1,4 +1,5 @@',
    ' context a',
    '-removed b',
    '+added b',
    '+added c',
    ' context d',
    '@@ -100,3 +101,4 @@ func doThing() {',
    ' context e',
    '+added f',
    ' context g',
].join('\n');

describe('splitHunks', () => {
    it('splits on hunk headers and records the new-side range', () => {
        const hunks = splitHunks(PATCH);
        expect(hunks).toHaveLength(2);
        expect(hunks[0].newStart).toBe(1);
        expect(hunks[0].newEnd).toBe(5);
        expect(hunks[1].newStart).toBe(101);
        expect(hunks[1].newEnd).toBe(104);
        expect(hunks[1].header).toContain('func doThing()');
    });

    it('returns an empty array for an absent or empty patch', () => {
        expect(splitHunks(null)).toEqual([]);
        expect(splitHunks('')).toEqual([]);
    });

    it('handles a header with no count, which means one line', () => {
        const hunks = splitHunks('@@ -5 +5 @@\n-x\n+y');
        expect(hunks[0].newStart).toBe(5);
        expect(hunks[0].newEnd).toBe(5);
    });

    it('handles a pure-deletion hunk (new count of 0) without newEnd < newStart', () => {
        const hunks = splitHunks('@@ -10,5 +10,0 @@\n-a\n-b\n-c\n-d\n-e');
        expect(hunks[0].newStart).toBe(10);
        expect(hunks[0].newEnd).toBeGreaterThanOrEqual(hunks[0].newStart);
    });
});

describe('hunkForLine', () => {
    it('finds the hunk containing a new-side line', () => {
        expect(hunkForLine(PATCH, 102).header).toContain('func doThing()');
        expect(hunkForLine(PATCH, 3).newStart).toBe(1);
    });

    it('returns null when no hunk covers the line', () => {
        expect(hunkForLine(PATCH, 50)).toBeNull();
    });

    it('returns null for a missing line number rather than guessing', () => {
        expect(hunkForLine(PATCH, null)).toBeNull();
    });

    it('includes the diff body, not just the header', () => {
        expect(hunkForLine(PATCH, 102).text).toContain('+added f');
    });

    it('rejects line 0 on principle, not because no hunk happens to start there', () => {
        expect(hunkForLine(PATCH, 0)).toBeNull();
    });

    it('rejects a negative line number', () => {
        expect(hunkForLine(PATCH, -5)).toBeNull();
    });

    it('rejects a non-numeric line', () => {
        expect(hunkForLine(PATCH, 'abc')).toBeNull();
    });
});

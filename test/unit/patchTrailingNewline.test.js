/**
 * The phantom line a trailing newline used to create.
 *
 * `parsePatchHunks` treated an EMPTY split element as a context line. In a unified
 * diff even a blank context line is " " (a single space), so the only source of ''
 * is the trailing element `split('\n')` produces for a patch that ends in a
 * newline — which GitLab's `diff` field always does, and GitHub's `patch`
 * sometimes does.
 *
 * That invented a line at lastLine+1 which every consumer then trusted.
 */

const {
    parsePatchHunks,
    commentableLines,
    oldLineForNewLine,
    snapToCommentableLine,
    addedLines,
} = require('../../src/utils/patchLines.js');

const BODY = '@@ -1,3 +1,4 @@\n ctx1\n+added2\n ctx3';
const WITH_TRAILING_NEWLINE = `${BODY}\n`;

describe('a patch ending in a newline', () => {
    it('parses to the same lines as one that does not', () => {
        const a = parsePatchHunks(BODY)[0].lines.map(l => [l.type, l.number.new]);
        const b = parsePatchHunks(WITH_TRAILING_NEWLINE)[0].lines.map(l => [l.type, l.number.new]);
        expect(b).toEqual(a);
    });

    it('does not invent a commentable line past the end of the hunk', () => {
        // Was [1, 2, 3, 4] — line 4 does not exist in this diff. Offering it meant a
        // finding there passed validation and GitHub 422'd the ENTIRE review, losing
        // every inline comment rather than just the bad one.
        expect([...commentableLines(WITH_TRAILING_NEWLINE)].sort((x, y) => x - y)).toEqual([1, 2, 3]);
        expect(commentableLines(WITH_TRAILING_NEWLINE).has(4)).toBe(false);
    });

    it('does not resolve an old_line for a line that does not exist', () => {
        // A bogus old_line makes GitLab reject the diff note with a 400.
        expect(oldLineForNewLine(WITH_TRAILING_NEWLINE, 4)).toBeNull();
        // Real context lines still resolve.
        expect(oldLineForNewLine(WITH_TRAILING_NEWLINE, 1)).toBe(1);
        expect(oldLineForNewLine(WITH_TRAILING_NEWLINE, 3)).toBe(2);
        // An ADDED line must resolve to null so the field is omitted.
        expect(oldLineForNewLine(WITH_TRAILING_NEWLINE, 2)).toBeNull();
    });

    it('does not change which lines are added', () => {
        expect([...addedLines(WITH_TRAILING_NEWLINE)]).toEqual([2]);
    });

    it('handles CRLF patches without inventing a line', () => {
        const crlf = '@@ -1,2 +1,2 @@\r\n ctx1\r\n+added2\r\n';
        expect(commentableLines(crlf).has(3)).toBe(false);
    });

    it('handles the "\\ No newline at end of file" marker', () => {
        const patch = '@@ -1,2 +1,2 @@\n ctx1\n+added2\n\\ No newline at end of file\n';
        expect([...commentableLines(patch)].sort((x, y) => x - y)).toEqual([1, 2]);
    });
});

describe('snapToCommentableLine tie-breaking', () => {
    it('prefers the lower line when two candidates are equidistant', () => {
        // The guard was `candidate < best` with `best` still null on the first tie,
        // and `n < null` is always false — so the winner depended on Set order.
        expect(snapToCommentableLine(10, new Set([8, 12]), 5)).toBe(8);
        expect(snapToCommentableLine(10, new Set([12, 8]), 5)).toBe(8);
    });

    it('returns the exact line when it is allowed', () => {
        expect(snapToCommentableLine(10, new Set([8, 10, 12]))).toBe(10);
    });

    it('refuses to snap beyond maxDistance', () => {
        expect(snapToCommentableLine(10, new Set([30]), 5)).toBeNull();
    });

    it('returns null for an empty allow-list', () => {
        expect(snapToCommentableLine(10, new Set())).toBeNull();
        expect(snapToCommentableLine(10, null)).toBeNull();
    });
});

describe('ReviewOrchestrator shares the one parser', () => {
    it('no longer defines its own parsePatchHunks', () => {
        // The duplicate had already drifted from patchLines (no `\ No newline`
        // handling, different context rule), so the assigned-hunk allow-list and
        // the posting allow-list disagreed — a finding could survive one filter
        // and be dropped by the other.
        const fs = require('fs');
        const src = fs.readFileSync(
            require('path').join(__dirname, '../../src/services/ReviewOrchestrator.js'),
            'utf8',
        );
        expect(src).not.toMatch(/function parsePatchHunks/);
        expect(src).toMatch(/from '\.\.\/utils\/patchLines\.js'/);
    });
});

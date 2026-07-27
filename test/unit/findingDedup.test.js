/**
 * Tests for findingDedup — keep only genuinely new findings.
 */
const { findingKey, isDuplicate, freshFindings } = require('../../src/utils/findingDedup.js');

describe('findingDedup', () => {
    it('builds a coarse key', () => {
        expect(findingKey({ file: 'a.js', line: 5, type: 'Bug' })).toBe('a.js:5:bug');
    });

    it('treats same file + nearby line + same type as duplicate', () => {
        const existing = [{ file: 'a.js', line: 10, type: 'security', title: 'xss sink' }];
        expect(isDuplicate(existing, { file: 'a.js', line: 12, type: 'security', title: 'different words' })).toBe(true);
    });

    it('treats different files as distinct even if identical otherwise', () => {
        const existing = [{ file: 'a.js', line: 10, type: 'bug', title: 'null deref' }];
        expect(isDuplicate(existing, { file: 'b.js', line: 10, type: 'bug', title: 'null deref' })).toBe(false);
    });

    it('detects duplicates by title token overlap when types differ', () => {
        const existing = [{ file: 'a.js', line: 10, type: 'bug', title: 'unclosed httpx response leaks connection' }];
        const dup = { file: 'a.js', line: 11, type: 'performance', title: 'httpx response unclosed leaks connection pool' };
        expect(isDuplicate(existing, dup)).toBe(true);
    });

    it('distant lines on the same file are not duplicates', () => {
        const existing = [{ file: 'a.js', line: 10, type: 'bug', title: 'x' }];
        expect(isDuplicate(existing, { file: 'a.js', line: 40, type: 'bug', title: 'x' })).toBe(false);
    });

    it('freshFindings removes items matching existing AND self-duplicates', () => {
        const existing = [{ file: 'a.js', line: 5, type: 'security', title: 'sql injection' }];
        const candidates = [
            { file: 'a.js', line: 6, type: 'security', title: 'sql injection variant' }, // dup of existing
            { file: 'a.js', line: 20, type: 'bug', title: 'off by one' },                 // new
            { file: 'a.js', line: 21, type: 'bug', title: 'off by one error' }            // dup of the new one
        ];
        const fresh = freshFindings(existing, candidates);
        expect(fresh).toHaveLength(1);
        expect(fresh[0].line).toBe(20);
    });
});

/**
 * Tests for the REAL content-script code-cleaning helpers
 * (src/content/codeCleaning.js) — no mocks, no inline reimplementation.
 *
 * Previously this suite defined a from-scratch `extractCode()` helper at the
 * bottom of the file and tested that, never touching production code. The pure
 * cleaning logic has been extracted from content/index.js into codeCleaning.js
 * (which ContentExtractor now delegates to) so it can be exercised directly.
 */

const {
    cleanLineNumbers,
    cleanupExtractedCode,
} = require('../../src/content/codeCleaning.js');

describe('cleanLineNumbers', () => {
    it('should strip leading line-number gutters', () => {
        const input = '1  const a = 1;\n2  const b = 2;';
        expect(cleanLineNumbers(input)).toBe('const a = 1;\nconst b = 2;');
    });

    it('should strip tab-separated line numbers', () => {
        expect(cleanLineNumbers('12\tfoo()')).toBe('foo()');
    });

    it('should leave code without gutters unchanged', () => {
        const code = 'function x() {\n  return 1;\n}';
        expect(cleanLineNumbers(code)).toBe(code);
    });

    it('should pass through non-string input', () => {
        expect(cleanLineNumbers(null)).toBeNull();
    });
});

describe('cleanupExtractedCode', () => {
    it('should remove GitLab/GitHub UI chrome labels', () => {
        const input = 'const x = 1;\nCopy\nRaw\nBlame\nconst y = 2;';
        const out = cleanupExtractedCode(input);
        expect(out).not.toMatch(/^\s*Copy\s*$/m);
        expect(out).not.toMatch(/^\s*Raw\s*$/m);
        expect(out).not.toMatch(/^\s*Blame\s*$/m);
        expect(out).toContain('const x = 1;');
        expect(out).toContain('const y = 2;');
    });

    it('should strip line-number gutters (multi-space, tab, and single-space)', () => {
        expect(cleanupExtractedCode('1  const a = 1;')).toBe('const a = 1;');
        expect(cleanupExtractedCode('42\tconst b = 2;')).toBe('const b = 2;');
        expect(cleanupExtractedCode('7 const c = 3;')).toBe('const c = 3;');
    });

    it('should collapse three-or-more blank lines to two', () => {
        const out = cleanupExtractedCode('a\n\n\n\nb');
        expect(out).toBe('a\n\nb');
    });

    it('should trim leading/trailing whitespace', () => {
        expect(cleanupExtractedCode('   \nconst a = 1;\n   ')).toBe('const a = 1;');
    });

    it('should return falsy input unchanged', () => {
        expect(cleanupExtractedCode('')).toBe('');
        expect(cleanupExtractedCode(null)).toBeNull();
    });
});

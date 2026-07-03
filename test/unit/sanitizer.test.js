/**
 * Tests for the REAL Sanitizer (src/utils/sanitizer.js) — no mocks.
 * Previously this suite jest.mock'd the subject and tested an inline fake with
 * method names ('sanitizeURL', 'sanitizeJSON', 'validateInput') that never
 * existed in production.
 */

const { Sanitizer } = require('../../src/utils/sanitizer.js');

describe('Sanitizer', () => {
    let sanitizer;
    beforeEach(() => {
        sanitizer = new Sanitizer();
    });

    describe('sanitizeApiKey', () => {
        it('should trim whitespace and strip control characters', () => {
            expect(sanitizer.sanitizeApiKey('  sk-abcdefghijklmnopqrstuvwx  ')).toBe('sk-abcdefghijklmnopqrstuvwx');
            // Control characters (not regular spaces) are stripped.
            expect(sanitizer.sanitizeApiKey('sk-abcdefghijklmnopqrst')).toBe('sk-abcdefghijklmnopqrst');
        });

        it('should return empty string for non-string input', () => {
            expect(sanitizer.sanitizeApiKey(null)).toBe('');
            expect(sanitizer.sanitizeApiKey(undefined)).toBe('');
            expect(sanitizer.sanitizeApiKey(12345)).toBe('');
        });

        it('should cap length at the configured maximum', () => {
            const long = 'sk-' + 'a'.repeat(2000);
            expect(sanitizer.sanitizeApiKey(long).length).toBe(1000);
        });
    });

    describe('sanitizeUrl', () => {
        it('should accept http and https URLs', () => {
            expect(sanitizer.sanitizeUrl('https://github.com/foo')).toBe('https://github.com/foo');
            expect(sanitizer.sanitizeUrl('http://localhost:8080/x')).toBe('http://localhost:8080/x');
        });

        it('should reject non-http(s) protocols', () => {
            expect(sanitizer.sanitizeUrl('javascript:alert(1)')).toBe('');
            expect(sanitizer.sanitizeUrl('file:///etc/passwd')).toBe('');
            expect(sanitizer.sanitizeUrl('ftp://host/x')).toBe('');
        });

        it('should reject malformed URLs and non-strings', () => {
            expect(sanitizer.sanitizeUrl('not a url')).toBe('');
            expect(sanitizer.sanitizeUrl(null)).toBe('');
        });
    });

    describe('sanitizeFilename', () => {
        it('should replace path separators and strip traversal', () => {
            // Separators become '-', then '..' traversal sequences are removed.
            expect(sanitizer.sanitizeFilename('../../etc/passwd')).toBe('--etc-passwd.txt');
            expect(sanitizer.sanitizeFilename('a/b\\c:d.txt')).toBe('a-b-c-d.txt');
        });

        it('should add a .txt extension when none present', () => {
            expect(sanitizer.sanitizeFilename('report')).toBe('report.txt');
        });

        it('should default when given non-strings', () => {
            expect(sanitizer.sanitizeFilename(null)).toBe('download.txt');
        });
    });

    describe('sanitizeJsonInput', () => {
        it('should parse valid JSON', () => {
            expect(sanitizer.sanitizeJsonInput('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] });
        });

        it('should return null for invalid JSON or non-strings', () => {
            expect(sanitizer.sanitizeJsonInput('{bad json')).toBeNull();
            expect(sanitizer.sanitizeJsonInput(null)).toBeNull();
        });

        it('should reject oversized JSON', () => {
            const big = JSON.stringify({ x: 'y'.repeat(200000) });
            expect(sanitizer.sanitizeJsonInput(big)).toBeNull();
        });
    });

    describe('sanitizeHtmlContent', () => {
        it('should strip script tags, javascript: and inline handlers', () => {
            const out = sanitizer.sanitizeHtmlContent('<div onclick="x()">hi<script>alert(1)</script></div>');
            expect(out).not.toContain('<script>');
            expect(out).not.toMatch(/onclick\s*=/);
            expect(out).toContain('hi');
        });
    });

    describe('sanitizeNumber', () => {
        it('should clamp within range', () => {
            expect(sanitizer.sanitizeNumber('50', 0, 100, 0)).toBe(50);
            expect(sanitizer.sanitizeNumber('500', 0, 100, 0)).toBe(100);
            expect(sanitizer.sanitizeNumber('-5', 0, 100, 0)).toBe(0);
        });
        it('should return default for non-numbers', () => {
            expect(sanitizer.sanitizeNumber('abc', 0, 100, 7)).toBe(7);
        });
    });

    describe('sanitizeCustomSelectors', () => {
        it('should keep valid selectors and drop dangerous/invalid ones', () => {
            const input = ['.code', '#main', 'div', 'bad<selector>', '', '   '];
            const out = sanitizer.sanitizeCustomSelectors(input);
            expect(out).toContain('.code');
            expect(out).toContain('#main');
            expect(out).toContain('div');
            expect(out.some(s => s.includes('<'))).toBe(false);
            expect(out).not.toContain('');
        });

        it('should return empty array for non-arrays', () => {
            expect(sanitizer.sanitizeCustomSelectors('nope')).toEqual([]);
        });

        it('should cap at 50 selectors', () => {
            const many = Array.from({ length: 80 }, (_, i) => `.c${i}`);
            expect(sanitizer.sanitizeCustomSelectors(many).length).toBe(50);
        });
    });

    describe('enum sanitizers', () => {
        it('should validate testType, contextLevel, and model with fallbacks', () => {
            expect(sanitizer.sanitizeTestType('unit')).toBe('unit');
            expect(sanitizer.sanitizeTestType('bogus')).toBe('unit');
            expect(sanitizer.sanitizeContextLevel('full')).toBe('full');
            expect(sanitizer.sanitizeContextLevel('bogus')).toBe('smart');
            expect(sanitizer.sanitizeModel('gpt-4')).toBe('gpt-4');
            expect(sanitizer.sanitizeModel('bogus')).toBe('gpt-4.1-mini');
        });
    });

    describe('sanitizeBranch', () => {
        it('should strip git-forbidden characters and default when empty', () => {
            expect(sanitizer.sanitizeBranch('feature/new thing')).toBe('feature/newthing');
            expect(sanitizer.sanitizeBranch('')).toBe('main');
            expect(sanitizer.sanitizeBranch('..')).toBe('main');
        });
    });
});

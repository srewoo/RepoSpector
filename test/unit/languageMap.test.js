/**
 * Tests for the canonical language-detection utility (src/utils/languageMap.js).
 * Exercises the REAL module — no mocks.
 */

const {
    EXTENSION_TO_LANGUAGE,
    extensionOf,
    detectLanguageFromPath,
} = require('../../src/utils/languageMap.js');

describe('extensionOf', () => {
    it('should return the lowercased extension for a simple filename', () => {
        expect(extensionOf('foo.JS')).toBe('js');
        expect(extensionOf('Bar.TSX')).toBe('tsx');
    });

    it('should use the basename, not directory dots', () => {
        expect(extensionOf('src/a.b/c.py')).toBe('py');
        expect(extensionOf('deep/nested/path/File.go')).toBe('go');
    });

    it('should treat an extensionless basename as its own name', () => {
        expect(extensionOf('Dockerfile')).toBe('dockerfile');
        expect(extensionOf('path/to/Dockerfile')).toBe('dockerfile');
    });

    it('should return empty string for missing or non-string input', () => {
        expect(extensionOf('')).toBe('');
        expect(extensionOf(null)).toBe('');
        expect(extensionOf(undefined)).toBe('');
    });
});

describe('detectLanguageFromPath', () => {
    it('should map common extensions to canonical language names', () => {
        expect(detectLanguageFromPath('a.js')).toBe('javascript');
        expect(detectLanguageFromPath('a.ts')).toBe('typescript');
        expect(detectLanguageFromPath('a.py')).toBe('python');
        expect(detectLanguageFromPath('a.go')).toBe('go');
        expect(detectLanguageFromPath('a.rs')).toBe('rust');
    });

    it('should collapse jsx/tsx to javascript/typescript by default', () => {
        expect(detectLanguageFromPath('a.jsx')).toBe('javascript');
        expect(detectLanguageFromPath('a.tsx')).toBe('typescript');
    });

    it('should keep jsx/tsx distinct when distinguishJsx is set', () => {
        expect(detectLanguageFromPath('a.jsx', { distinguishJsx: true })).toBe('jsx');
        expect(detectLanguageFromPath('a.tsx', { distinguishJsx: true })).toBe('tsx');
        // non-jsx extensions are unaffected by the flag
        expect(detectLanguageFromPath('a.ts', { distinguishJsx: true })).toBe('typescript');
    });

    it('should return the caller-specified fallback for unknown extensions', () => {
        expect(detectLanguageFromPath('a.unknownext')).toBe('unknown');
        expect(detectLanguageFromPath('a.unknownext', { fallback: 'text' })).toBe('text');
        expect(detectLanguageFromPath('', { fallback: 'text' })).toBe('text');
    });

    it('should map header and variant extensions consistently', () => {
        expect(detectLanguageFromPath('a.h')).toBe('c');
        expect(detectLanguageFromPath('a.hpp')).toBe('cpp');
        expect(detectLanguageFromPath('a.cc')).toBe('cpp');
        expect(detectLanguageFromPath('a.mjs')).toBe('javascript');
        expect(detectLanguageFromPath('a.kt')).toBe('kotlin');
    });

    it('should be case-insensitive on the path', () => {
        expect(detectLanguageFromPath('SRC/Main.JAVA')).toBe('java');
    });
});

describe('EXTENSION_TO_LANGUAGE', () => {
    it('should be frozen to prevent accidental mutation', () => {
        expect(Object.isFrozen(EXTENSION_TO_LANGUAGE)).toBe(true);
    });

    it('should key by bare (dot-less) lowercase extensions', () => {
        expect(EXTENSION_TO_LANGUAGE.js).toBe('javascript');
        expect(EXTENSION_TO_LANGUAGE['.js']).toBeUndefined();
    });
});

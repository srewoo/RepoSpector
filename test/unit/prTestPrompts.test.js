const { buildPRTestPrompt, frameworkForPath, languageForPath, extractCodeBlock, PR_TEST_SYSTEM_PROMPT } = require('../../src/utils/prTestPrompts.js');

describe('frameworkForPath', () => {
    it('maps by extension', () => {
        expect(frameworkForPath('src/a.py')).toBe('pytest');
        expect(frameworkForPath('pkg/a.go')).toBe('go test');
        expect(frameworkForPath('src/a.ts')).toBe('jest');
        expect(frameworkForPath('x.unknown')).toBe('auto-detect');
    });
    it('prefers what the existing test file uses', () => {
        expect(frameworkForPath('src/a.js', "import { test, expect } from 'vitest';\ntest('x', () => {});")).toBe('vitest');
    });
});

describe('buildPRTestPrompt', () => {
    const base = {
        filePath: 'src/pay.js', fullContent: 'export function charge(a) { return a; }',
        symbols: ['charge'], callers: [{ name: 'checkout', filePath: 'src/checkout.js', line: 40 }],
        framework: 'jest', language: 'javascript',
    };
    it('asks for a new file when no test exists, naming the target symbols', () => {
        const p = buildPRTestPrompt({ ...base, existingTest: null });
        expect(p).toMatch(/Create a new test file/);
        expect(p).toMatch(/`charge`/);
        expect(p).toMatch(/src\/checkout\.js:40/);
    });
    it('asks for append-only blocks when a test file exists, and includes it', () => {
        const p = buildPRTestPrompt({ ...base, existingTest: { path: 'test/pay.test.js', content: "describe('charge', () => {});" } });
        expect(p).toMatch(/Output ONLY new test blocks/);
        expect(p).toMatch(/test\/pay\.test\.js/);
        expect(p).toMatch(/describe\('charge'/);
    });
    it('caps the existing test file it inlines', () => {
        const p = buildPRTestPrompt({ ...base, existingTest: { path: 't.js', content: 'x'.repeat(50_000) } });
        expect(p.length).toBeLessThan(30_000);
        expect(p).toMatch(/truncated/);
    });
});

describe('extractCodeBlock', () => {
    it('returns fenced content, else the trimmed text', () => {
        expect(extractCodeBlock('hi\n```js\nconst a = 1;\n```\nbye')).toBe('const a = 1;');
        expect(extractCodeBlock('  plain  ')).toBe('plain');
    });
});

it('system prompt forbids prose and placeholders', () => {
    expect(PR_TEST_SYSTEM_PROMPT).toMatch(/no explanation/i);
    expect(PR_TEST_SYSTEM_PROMPT).toMatch(/TODO/);
});

describe('languageForPath', () => {
    it('maps extensions to highlight languages', () => {
        expect(languageForPath('a/b.py')).toBe('python');
        expect(languageForPath('a/b.tsx')).toBe('typescript');
        expect(languageForPath('a/b.go')).toBe('go');
        expect(languageForPath('a/b.unknown')).toBe('javascript');
    });
});

it('does not let detectFramework override a non-JS extension', () => {
    // detectFramework defaults to 'jest' and never says "unknown".
    expect(frameworkForPath('src/a.py', 'some test body with no indicators')).toBe('pytest');
});

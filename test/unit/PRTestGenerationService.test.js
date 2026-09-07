const { PRTestGenerationService } = require('../../src/services/PRTestGenerationService.js');

const patch = (lines) => ['@@ -1,1 +1,4 @@', ...lines].join('\n');
const prData = {
    files: [
        { filename: 'src/pay.js', patch: patch(['+export function charge(a) {', '+  if (a < 0) throw new Error("neg");', '+  return a;', '+}']) },
        { filename: 'src/util.js', patch: patch(['+export function fmt(x) { return String(x); }']) },
    ],
};
const GOOD = "```js\ndescribe('charge', () => {\n  it('returns amount', () => { expect(charge(1)).toBe(1); });\n  it('throws on negative', () => { expect(() => charge(-1)).toThrow('neg'); });\n});\n```";
const BROKEN = '```js\ndescribe(\'charge\', () => {\n  it(\'x\', () => { expect(charge(1)).toBe(1);\n```';

// A TypeScript generic annotation (`Map<string, number>`) used to be exactly
// the shape `validateSyntax` misread as JSX / mangled via its regex TS
// stripper. Both bugs are now fixed, so TypeScript gets the same STRONG
// (`validateSyntax`) check as JavaScript — these fixtures now exercise that
// strong path rather than the weak brace-counting fallback.
const tsPrData = {
    files: [
        { filename: 'src/cache.ts', patch: patch(['+export function load() {', '+  return 1;', '+}']) },
    ],
};
const TS_GOOD = "```ts\nconst m: Map<string, number> = new Map();\ndescribe('load', () => {\n  it('starts empty', () => { expect(m.size).toBe(0); });\n});\n```";
const TS_BROKEN = "```ts\nconst m: Map<string, number> = new Map();\ndescribe('load', () => {\n  it('starts empty', () => { expect(m.size).toBe(0);\n```";
// Balanced braces/parens (so the weak `quickValidate` brace counter would
// wave this through), but `a b` is not valid JS — only a real parse
// (`validateSyntax`, now trusted for TypeScript) catches this.
const TS_STRICT_BROKEN = "```ts\nconst m: Map<string, number> = new Map();\nfunction useIt(a, b) { return a b; }\n```";

// `.jsx` maps to language 'javascript' (see `languageForPath`), so a React
// component test like this used to be run through the STRONG check even
// though `validateSyntax` ends in `new Function()`, which cannot parse
// untranspiled JSX — it was wrongly rejected. `looksLikeJsx` now routes it to
// the weak (but sound) brace-counting check instead.
const jsxPrData = {
    files: [
        { filename: 'src/Button.jsx', patch: patch(['+export function Button() {', '+  return null;', '+}']) },
    ],
};
const JSX_GOOD = "```jsx\nimport { render, screen } from '@testing-library/react';\ndescribe('Button', () => {\n  it('renders with the given label', () => { render(<Button label=\"x\" />); expect(screen.getByText('x')).toBeTruthy(); });\n  it('handles missing label edge case', () => { render(<Button />); expect(screen.queryByText('x')).toBeFalsy(); });\n});\n```";
const JSX_BROKEN = "```jsx\nimport { render } from '@testing-library/react';\nit('renders', () => { render(<Button label=\"x\" />);\n```";

function makeDeps({ responses = [GOOD], fileContext = null } = {}) {
    let i = 0;
    const llmService = { streamChat: jest.fn(async () => ({ content: responses[Math.min(i++, responses.length - 1)], usage: { input: 10, output: 5 } })) };
    const ctx = fileContext || new Map([
        ['src/pay.js', { fullContent: 'export function charge(a) { if (a < 0) throw new Error("neg"); return a; }', testPath: null, testContent: null }],
        ['src/util.js', { fullContent: 'export function fmt(x) { return String(x); }', testPath: 'test/util.test.js', testContent: "describe('fmt', () => { it('old', () => {}); });" }],
    ]);
    // Matches the real service: an OBJECT carrying a byFile Map, not a bare Map.
    const fileContextService = { build: jest.fn(async () => ({ byFile: ctx, stats: {} })) };
    return { llmService, fileContextService };
}
const settings = { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'k' };

describe('PRTestGenerationService.generate', () => {
    it('creates a test file for an untested symbol with no existing test', async () => {
        const deps = makeDeps();
        const svc = new PRTestGenerationService(deps);
        const res = await svc.generate('https://github.com/a/b/pull/1', prData, settings, { onlyFiles: ['src/pay.js'] });
        expect(res.files).toHaveLength(1);
        expect(res.files[0]).toMatchObject({ targetFile: 'src/pay.js', mode: 'create', symbols: ['charge'], framework: 'jest' });
        expect(res.files[0].path).toMatch(/pay\.test\.js$/);
        expect(res.files[0].content).toMatch(/describe\('charge'/);
        expect(res.files[0].quality.syntaxOk).toBe(true);
        const [messages, opts] = deps.llmService.streamChat.mock.calls[0];
        expect(messages[1].content).toMatch(/Create a new test file/);
        expect(opts).toMatchObject({ provider: 'openai', stream: false });
    });

    it('appends when a test file already exists', async () => {
        const svc = new PRTestGenerationService(makeDeps());
        const res = await svc.generate('u', prData, settings, { onlyFiles: ['src/util.js'] });
        expect(res.files[0]).toMatchObject({ mode: 'append', path: 'test/util.test.js' });
    });

    it('retries once with the validator error when the first output is broken', async () => {
        const deps = makeDeps({ responses: [BROKEN, GOOD] });
        const svc = new PRTestGenerationService(deps);
        const res = await svc.generate('u', prData, settings, { onlyFiles: ['src/pay.js'] });
        expect(deps.llmService.streamChat).toHaveBeenCalledTimes(2);
        expect(deps.llmService.streamChat.mock.calls[1][0].at(-1).content).toMatch(/previous output/i);
        expect(res.files[0].quality.attempts).toBe(2);
    });

    it('skips a file whose output is still broken after the retry, with a reason', async () => {
        const svc = new PRTestGenerationService(makeDeps({ responses: [BROKEN, BROKEN] }));
        const res = await svc.generate('u', prData, settings, { onlyFiles: ['src/pay.js'] });
        expect(res.files).toHaveLength(0);
        expect(res.skipped[0]).toMatchObject({ file: 'src/pay.js' });
        expect(res.skipped[0].reason).toMatch(/syntax/i);
    });

    it('passes graph callers into the prompt when a graph is given', async () => {
        const graph = {
            findNodeByName: () => [{ id: 't', properties: { name: 'charge', filePath: 'src/pay.js' } }],
            getRelationshipsTo: () => [{ type: 'CALLS', sourceId: 'c', confidence: 0.9 }],
            getNode: () => ({ properties: { name: 'checkout', filePath: 'src/checkout.js', startLine: 40 } }),
        };
        const deps = makeDeps();
        const svc = new PRTestGenerationService({ ...deps, graph });
        await svc.generate('u', prData, settings, { onlyFiles: ['src/pay.js'] });
        expect(deps.llmService.streamChat.mock.calls[0][0][1].content).toMatch(/src\/checkout\.js:40/);
    });

    it('respects maxFiles and sums usage', async () => {
        const svc = new PRTestGenerationService(makeDeps());
        const res = await svc.generate('u', prData, settings, { maxFiles: 1 });
        expect(res.files.length + res.skipped.length).toBe(1);
        expect(res.usage).toEqual({ input: 10, output: 5 });
    });

    it('returns a skipped entry when the PR has no untested exported symbols', async () => {
        const svc = new PRTestGenerationService(makeDeps());
        const res = await svc.generate('u', { files: [{ filename: 'README.md', patch: patch(['+hello']) }] }, settings);
        expect(res.files).toEqual([]);
        expect(res.skipped[0].reason).toMatch(/no untested exported symbols/);
    });

    it('accepts a TypeScript test with a generic type annotation (validateSyntax now runs for TS)', async () => {
        const ctx = new Map([
            ['src/cache.ts', { fullContent: 'export function load() { return 1; }', testPath: null, testContent: null }],
        ]);
        const deps = makeDeps({ responses: [TS_GOOD], fileContext: ctx });
        const svc = new PRTestGenerationService(deps);
        const res = await svc.generate('u', tsPrData, settings, { onlyFiles: ['src/cache.ts'] });
        expect(res.skipped).toEqual([]);
        expect(res.files).toHaveLength(1);
        expect(res.files[0]).toMatchObject({ targetFile: 'src/cache.ts', mode: 'create', symbols: ['load'] });
        expect(res.files[0].content).toMatch(/Map<string, number>/);
    });

    it('still skips a TypeScript test with unbalanced braces, via the quality validator', async () => {
        const ctx = new Map([
            ['src/cache.ts', { fullContent: 'export function load() { return 1; }', testPath: null, testContent: null }],
        ]);
        const deps = makeDeps({ responses: [TS_BROKEN, TS_BROKEN], fileContext: ctx });
        const svc = new PRTestGenerationService(deps);
        const res = await svc.generate('u', tsPrData, settings, { onlyFiles: ['src/cache.ts'] });
        expect(res.files).toEqual([]);
        expect(res.skipped[0]).toMatchObject({ file: 'src/cache.ts' });
        expect(res.skipped[0].reason).toMatch(/syntax/i);
    });

    it('skips a TypeScript test with genuinely broken syntax that only a real parse catches (STRONG check running for TS)', async () => {
        // Braces and parens are balanced here, so the weak brace-counting
        // fallback would wave this through; only `validateSyntax` actually
        // parsing the code catches `a b`. Proves the strong check, not the
        // weak one, is gating TypeScript now.
        const ctx = new Map([
            ['src/cache.ts', { fullContent: 'export function load() { return 1; }', testPath: null, testContent: null }],
        ]);
        const deps = makeDeps({ responses: [TS_STRICT_BROKEN, TS_STRICT_BROKEN], fileContext: ctx });
        const svc = new PRTestGenerationService(deps);
        const res = await svc.generate('u', tsPrData, settings, { onlyFiles: ['src/cache.ts'] });
        expect(res.files).toEqual([]);
        expect(res.skipped[0]).toMatchObject({ file: 'src/cache.ts' });
        expect(res.skipped[0].reason).toMatch(/syntax/i);
    });

    it('accepts a .jsx test containing a JSX component element (previously wrongly rejected by the strong check)', async () => {
        const ctx = new Map([
            ['src/Button.jsx', { fullContent: 'export function Button() { return null; }', testPath: null, testContent: null }],
        ]);
        const deps = makeDeps({ responses: [JSX_GOOD], fileContext: ctx });
        const svc = new PRTestGenerationService(deps);
        const res = await svc.generate('u', jsxPrData, settings, { onlyFiles: ['src/Button.jsx'] });
        expect(res.skipped).toEqual([]);
        expect(res.files).toHaveLength(1);
        expect(res.files[0]).toMatchObject({ targetFile: 'src/Button.jsx', mode: 'create', symbols: ['Button'] });
        expect(res.files[0].content).toMatch(/<Button/);
    });

    it('still skips a .jsx test with unbalanced braces, via the quality validator', async () => {
        const ctx = new Map([
            ['src/Button.jsx', { fullContent: 'export function Button() { return null; }', testPath: null, testContent: null }],
        ]);
        const deps = makeDeps({ responses: [JSX_BROKEN, JSX_BROKEN], fileContext: ctx });
        const svc = new PRTestGenerationService(deps);
        const res = await svc.generate('u', jsxPrData, settings, { onlyFiles: ['src/Button.jsx'] });
        expect(res.files).toEqual([]);
        expect(res.skipped[0]).toMatchObject({ file: 'src/Button.jsx' });
        expect(res.skipped[0].reason).toMatch(/syntax/i);
    });
});

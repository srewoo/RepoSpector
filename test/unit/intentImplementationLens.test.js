/**
 * The intent-versus-implementation lens.
 *
 * Added because every other lens hunts a CATEGORY of defect (injection, a race,
 * an N+1) and none asks the question a human reviewer asks first: does this code
 * do what it says it does? Measured recall against real reviewer threads is 23%,
 * and the misses are dominated by that class.
 *
 * These are contract tests over the prompt, not over model behaviour — the prompt
 * is the only part that is deterministic. They pin the two properties that make
 * this lens safe: it demands BOTH halves of the mismatch be quoted, and it
 * refuses "could be clearer".
 */

const { FINDER_LENSES, buildLensFinderPrompt, activeLenses } = require('../../src/utils/finderLensPrompts.js');

const lens = FINDER_LENSES.find(l => l.key === 'intent-implementation');

describe('intent-implementation lens', () => {
    it('exists and is not gated off by default', () => {
        expect(lens).toBeDefined();
        // No appliesTo / requiresReuseContext: intent mismatches occur in any
        // file type, so gating it would silently disable it on most PRs.
        expect(activeLenses([lens], { files: [{ filename: 'src/a.js' }] })).toHaveLength(1);
    });

    it('demands the CLAIM and the contradicting code both be quoted', () => {
        expect(lens.instruction).toMatch(/Quote the CLAIM/);
        expect(lens.instruction).toMatch(/contradicting code line/);
        expect(lens.instruction).toMatch(/without both is not reportable/);
    });

    it('explicitly refuses vague-clarity findings', () => {
        expect(lens.instruction).toMatch(/"Could be clearer" is not a mismatch/);
    });

    it('covers the mismatch sources that live in a diff', () => {
        for (const source of [/NAME promises/, /docstring/i, /comment/i, /test whose title/i, /never read/i]) {
            expect(lens.instruction).toMatch(source);
        }
    });

    it('builds a prompt that carries its instruction', () => {
        const { system, user } = buildLensFinderPrompt(lens, { diff: 'x', existingFindings: [] });
        expect(`${system}\n${user}`).toMatch(/does not do what it CLAIMS/);
    });
});

describe('correctness lenses now demand a concrete trigger', () => {
    it('the correctness lens rejects "callers may pass nil" by name', () => {
        const l = FINDER_LENSES.find(x => x.key === 'concurrency-correctness');
        expect(l.instruction).toMatch(/CONCRETE input or interleaving/);
        expect(l.instruction).toMatch(/is not a finding/);
    });

    it('the api-contract lens must point at what consumes the contract', () => {
        const l = FINDER_LENSES.find(x => x.key === 'api-contract');
        expect(l.instruction).toMatch(/cannot\s+point at what consumes the contract is speculation/);
    });
});

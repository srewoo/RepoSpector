/**
 * The sibling sweep — recall, not precision.
 *
 * Motivated by the measured injected-defect run: `unchecked-error` 6/9 and
 * `loose-equality` 4/6, with the misses concentrated in large files. The reviewer
 * finds A defect of a class and stops. Once a class is flagged at 2+ sites those
 * sites define the pattern better than any prompt can.
 *
 * The safety property under test is INTERSECTION: a candidate must contain what
 * the flagged sites have in common, never what one of them happens to contain.
 * Given this repo's measured precision, a mechanism that multiplies findings has
 * to be the most conservative thing in the pipeline — so most of these tests are
 * about the sweep refusing to fire.
 */

const { sweepSiblings, tokenize, renderSweep, MIN_SITES } = require('../../src/utils/siblingSweep.js');

const patch = (lines) => ['@@ -1,1 +1,20 @@', ...lines].join('\n');

describe('tokenize', () => {
    it('keeps operators, because a loose-equality pattern lives in its operator', () => {
        expect([...tokenize('if (status == ready) {')]).toContain('==');
    });

    it('drops stopwords and short tokens that would match everything', () => {
        const toks = [...tokenize('if (const x = the value) return')];
        expect(toks).not.toContain('if');
        expect(toks).not.toContain('return');
        expect(toks).not.toContain('value');
    });
});

describe('sweeps siblings of a pattern flagged at 2+ sites', () => {
    const diffs = {
        'src/a.js': patch([
            '+if (statusCode == 200) { ok(); }',
            '+if (statusCode == 404) { bad(); }',
            '+if (statusCode == 500) { boom(); }',
        ]),
    };

    it('reports the unflagged third instance, even though it is adjacent', () => {
        // Adjacency is the point: real sibling defects sit on consecutive lines.
        const findings = [
            { file: 'src/a.js', line: 1, ruleId: 'eqeqeq' },
            { file: 'src/a.js', line: 2, ruleId: 'eqeqeq' },
        ];
        const hits = sweepSiblings(findings, diffs);
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({ file: 'src/a.js', line: 3 });
        expect(hits[0].sharedTokens).toEqual(expect.arrayContaining(['==', 'statusCode']));
    });

    it('intersects rather than unions — one site\'s incidental token cannot drive the sweep', () => {
        // `ok` appears only at site 1. A union would sweep on it and match lines
        // that have nothing to do with the flagged pattern.
        const findings = [
            { file: 'src/a.js', line: 1, ruleId: 'eqeqeq' },
            { file: 'src/a.js', line: 2, ruleId: 'eqeqeq' },
        ];
        const hits = sweepSiblings(findings, diffs);
        expect(hits[0].sharedTokens).not.toContain('ok');
        expect(hits[0].sharedTokens).not.toContain('bad');
    });
});

describe('refuses to sweep — the conservative direction', () => {
    it('does not sweep from a single site: one example is not a pattern', () => {
        const findings = [{ file: 'src/a.js', line: 1, ruleId: 'eqeqeq' }];
        expect(sweepSiblings(findings, { 'src/a.js': patch(['+if (a == b) {', '+if (c == d) {']) })).toEqual([]);
        expect(MIN_SITES).toBe(2);
    });

    it('does not sweep a pattern too generic to search on', () => {
        // Two sites sharing only `==` and nothing else: below MIN_SHARED_TOKENS.
        const diffs = { 'src/a.js': patch(['+if (a == b) {', '+if (c == d) {', '+if (e == f) {']) };
        const findings = [
            { file: 'src/a.js', line: 1, ruleId: 'eqeqeq' },
            { file: 'src/a.js', line: 2, ruleId: 'eqeqeq' },
        ];
        expect(sweepSiblings(findings, diffs)).toEqual([]);
    });

    it('never reports a line that was already flagged', () => {
        const diffs = { 'src/a.js': patch(['+doThing(userId, retryCount);', '+doThing(userId, retryCount);']) };
        const findings = [
            { file: 'src/a.js', line: 1, ruleId: 'r' },
            { file: 'src/a.js', line: 2, ruleId: 'r' },
        ];
        expect(sweepSiblings(findings, diffs)).toEqual([]);
    });

    it('never reads a file outside the diff', () => {
        const findings = [
            { file: 'src/a.js', line: 1, ruleId: 'r' },
            { file: 'src/a.js', line: 2, ruleId: 'r' },
        ];
        // Only src/b.js is in the diff map; findings point at src/a.js.
        expect(sweepSiblings(findings, { 'src/b.js': patch(['+x = 1;']) })).toEqual([]);
    });

    it('ignores findings anchored to context lines, which are not added code', () => {
        const diffs = { 'src/a.js': patch([' if (statusCode == 200) {', ' if (statusCode == 404) {']) };
        const findings = [
            { file: 'src/a.js', line: 1, ruleId: 'eqeqeq' },
            { file: 'src/a.js', line: 2, ruleId: 'eqeqeq' },
        ];
        expect(sweepSiblings(findings, diffs)).toEqual([]);
    });

    it('caps hits per class so one broad pattern cannot flood a review', () => {
        const many = Array.from({ length: 12 }, () => '+process(recordId, batchSize);');
        const diffs = { 'src/a.js': patch(many) };
        const findings = [
            { file: 'src/a.js', line: 1, ruleId: 'r' },
            { file: 'src/a.js', line: 6, ruleId: 'r' },
        ];
        expect(sweepSiblings(findings, diffs).length).toBeLessThanOrEqual(5);
    });

    it('returns nothing for no findings and no diff', () => {
        expect(sweepSiblings([], {})).toEqual([]);
        expect(sweepSiblings(undefined, undefined)).toEqual([]);
    });
});

describe('renderSweep', () => {
    it('renders nothing when nothing was swept', () => {
        expect(renderSweep([])).toBe('');
    });

    it('labels hits as leads, never as findings', () => {
        const md = renderSweep([
            { class: 'rule:eqeqeq', file: 'src/a.js', line: 3, content: 'if (x == y)', sharedTokens: ['=='], sites: [] },
        ]);
        expect(md).toMatch(/leads, not findings/);
        expect(md).toMatch(/src\/a\.js:3/);
    });
});

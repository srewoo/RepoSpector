const { symbolFromFinding, offersTestGeneration } = require('../../src/utils/prTestPrompts.js');

describe('symbolFromFinding', () => {
    it('reads the backticked symbol from the title', () => {
        expect(symbolFromFinding({ title: 'New exported `charge` is not mentioned by any test in this PR' })).toBe('charge');
    });
    it('returns null without one', () => {
        expect(symbolFromFinding({ title: 'Unbounded loop' })).toBeNull();
        expect(symbolFromFinding(null)).toBeNull();
    });
});

describe('offersTestGeneration', () => {
    it('offers generation for static/missing-test findings', () => {
        expect(offersTestGeneration({ rule: 'static/missing-test' })).toBe(true);
    });
    it('does not offer generation for graph/untested-blast-radius findings, even tagged coverage', () => {
        expect(offersTestGeneration({ rule: 'graph/untested-blast-radius', category: 'coverage' })).toBe(false);
    });
    it('does not offer generation for a bare coverage category with no rule', () => {
        expect(offersTestGeneration({ category: 'coverage' })).toBe(false);
    });
    it('returns false for a null finding', () => {
        expect(offersTestGeneration(null)).toBe(false);
    });
});

/**
 * The low-value gate — measured false-positive class 6.
 *
 * "A large secondary bucket of micro-performance and style restatements with no
 * functional consequence." Counted across both adjudicated corpora: 13 false
 * positives to 1 true positive, against a ~8:1 base rate.
 *
 * That single true positive is the whole reason this gate DEMOTES rather than
 * drops, and most of this suite guards the exemptions that keep it from muting
 * findings that do carry consequence.
 */

const { assessLowValue, markLowValue } = require('../../src/utils/lowValueGate.js');

const low = (f) => assessLowValue(f).lowValue;

describe('demotes restatements with no stated consequence', () => {
    it.each([
        ['Two full passes over to_concat dtypes where one suffices'],
        ['Redundant passes over to_union to collect dtypes'],
        ['Unnecessary re-computation of the same value'],
        ['This could be simplified with a map'],
        ['Consider using a switch for readability'],
    ])('%s', (title) => {
        expect(low({ title, severity: 'low' })).toBe(true);
    });

    it('explains itself, including the severity it acted on', () => {
        const out = assessLowValue({ title: 'Redundant loop', severity: 'low' });
        expect(out.reason).toMatch(/preference/);
        expect(out.reason).toMatch(/not given an inline slot/);
    });

    it('marks rather than removes — nothing is lost from the summary', () => {
        const { findings, demoted } = markLowValue([
            { title: 'Redundant loop', severity: 'low' },
            { title: 'SQL injection', severity: 'high' },
        ]);
        expect(demoted).toBe(1);
        expect(findings).toHaveLength(2);          // still both there
        expect(findings[0]._lowValue).toBe(true);
        expect(findings[1]._lowValue).toBeUndefined();
    });
});

describe('does NOT demote — the exemptions that matter', () => {
    it('keeps a restatement that states a real consequence', () => {
        // "Redundant validation lets the second call run unchecked" is a defect
        // report that happens to use the word "redundant".
        expect(low({ title: 'Redundant check means the second call runs unchecked and can corrupt state', severity: 'low' })).toBe(false);
        expect(low({ title: 'Unnecessary copy in hot path causes O(n^2) behaviour', severity: 'medium' })).toBe(false);
    });

    it('keeps a high or critical severity restatement — severity asserts impact', () => {
        expect(low({ title: 'Redundant loop', severity: 'high' })).toBe(false);
        expect(low({ title: 'Redundant loop', severity: 'critical' })).toBe(false);
    });

    it('never demotes a deterministic static finding', () => {
        expect(low({ title: 'Redundant assignment', severity: 'low', source: 'static' })).toBe(false);
    });

    it('never demotes an escalation — a question is not a style note', () => {
        expect(low({ title: 'Redundant path here?', severity: 'low', needsHumanReview: true })).toBe(false);
    });

    it('leaves ordinary defect findings untouched', () => {
        expect(low({ title: 'Off-by-one in the loop bound', severity: 'medium' })).toBe(false);
        expect(low({})).toBe(false);
    });
});

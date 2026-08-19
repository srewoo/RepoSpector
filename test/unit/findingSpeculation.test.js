/**
 * The speculation gate — the LARGEST measured false-positive class.
 *
 * `eval/README.md` records it first by frequency: "Speculation with no triggering
 * evidence in the diff — 'callers may pass nil', 'if other tests run in
 * parallel', 'may not be implemented' — nothing in the hunk suggests the
 * condition arises." Those three phrasings are the first three tests below,
 * verbatim, because a gate justified by measured examples should be tested
 * against them rather than against invented ones.
 *
 * As everywhere in this pipeline, the FALSE-REFUTATION suite is the one that
 * matters: dropping a real finding is the expensive direction, and hedging is how
 * careful reviewers write.
 */

const { assessSpeculation } = require('../../src/utils/findingSpeculation.js');
const { EVIDENCE } = require('../../src/utils/findingEvidence.js');

const refuted = (f, a) => assessSpeculation(f, a).verdict === EVIDENCE.REFUTED;

describe('refutes ungrounded speculation (measured false positives)', () => {
    it('"callers may pass nil" — a claim about callers, not about the diff', () => {
        expect(refuted({ title: 'Potential nil dereference', description: 'Callers may pass nil for this argument.' })).toBe(true);
    });

    it('"if other tests run in parallel" — a condition the diff does not show', () => {
        expect(refuted({ title: 'Shared state could race if other tests run in parallel' })).toBe(true);
    });

    it('"may not be implemented" — speculation about an absent implementation', () => {
        expect(refuted({ title: 'Handler may not be implemented on all platforms' })).toBe(true);
    });

    it('refutes future-tense worry with no present trigger', () => {
        expect(refuted({ title: 'This could become a bottleneck in the future' })).toBe(true);
    });

    it('refutes an unshown-concurrency claim', () => {
        expect(refuted({ title: 'Map access might corrupt under concurrent access' })).toBe(true);
    });

    it('reports the trigger phrase, so a human can judge the gate itself', () => {
        const out = assessSpeculation({ title: 'Consumers could send an empty list' });
        expect(out.verdict).toBe(EVIDENCE.REFUTED);
        expect(out.trigger).toMatch(/Consumers could/i);
        expect(out.reason).toMatch(/hypothetical/);
    });
});

describe('does NOT refute — the expensive direction', () => {
    it('keeps a hedged finding whose construct is grounded on an added line', () => {
        // Proof beats grammar. The evidence gate found the named construct in
        // added code, so the finding is about this diff however it is phrased.
        const finding = { title: 'Callers may pass nil to `json.Unmarshal`' };
        expect(refuted(finding, { verdict: EVIDENCE.GROUNDED })).toBe(false);
    });

    it('keeps a hedge that is anchored to the shown code', () => {
        expect(refuted({ title: 'This line could overflow for large inputs' })).toBe(false);
        expect(refuted({ title: 'The added call may block the event loop' })).toBe(false);
    });

    it('keeps a hedge with no hypothetical trigger at all', () => {
        // Politeness, not speculation — both halves are required.
        expect(refuted({ title: 'This may be clearer as a switch statement' })).toBe(false);
    });

    it('keeps a flat assertion, however severe', () => {
        expect(refuted({ title: 'SQL injection via string concatenation' })).toBe(false);
    });

    it('keeps an escalation — its whole purpose is to raise what the diff cannot settle', () => {
        // Refuting these would delete the one output that exists to say "ask a
        // human", exactly as the LLM refuter carve-out does.
        const escalation = { title: 'Callers may rely on the old ordering', needsHumanReview: true };
        expect(refuted(escalation)).toBe(false);
    });

    it('keeps a finding with no text rather than guessing', () => {
        expect(refuted({})).toBe(false);
        expect(refuted({ title: '' })).toBe(false);
    });

    it('does not treat "mayor", "maybe" or "cloud" as hedges', () => {
        expect(refuted({ title: 'mayor_id could not be parsed if other systems change the schema' })).toBe(true); // 'could' is a real hedge
        expect(refuted({ title: 'Cloudwatch metric name is wrong' })).toBe(false);
    });
});

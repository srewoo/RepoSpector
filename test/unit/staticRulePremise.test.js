/**
 * The static-rule premise gate.
 *
 * `eval/README.md` calls this class "the most mechanically fixable of the six":
 * "every no-dupe-keys / no-unreachable hit pointed at a hunk with no object
 * literal and no dead code; several flagged the very unreachable code the diff
 * deleted."
 *
 * It matters that this gate exists separately from the construct gates in
 * findingEvidence: a static finding's title is its rule id, which names no code,
 * so those gates extract nothing and never fire — and static findings bypass the
 * LLM refuter by design. Before this gate a mis-mapped static hit had nothing at
 * all standing between it and the PR.
 */

const { checkStaticPremise, CHECKED_RULES } = require('../../src/utils/staticRulePremise.js');

const patch = (lines) => ['@@ -1,4 +1,8 @@', ...lines].join('\n');

describe('refutes a rule that fired where its construct does not exist', () => {
    it('no-dupe-keys with no object literal anywhere near the line', () => {
        const p = patch(['+const a = 1;', '+const b = 2;', '+const c = 3;']);
        const out = checkStaticPremise({ ruleId: 'no-dupe-keys', line: 2 }, p);
        expect(out.ok).toBe(false);
        expect(out.reason).toMatch(/mis-mapped/);
    });

    it('no-unreachable with no terminating statement above', () => {
        const p = patch(['+const a = 1;', '+doWork();', '+more();']);
        expect(checkStaticPremise({ ruleId: 'no-unreachable', line: 2 }, p).ok).toBe(false);
    });

    it('eqeqeq on a line using strict equality already', () => {
        const p = patch(['+if (a === b) {', '+  run();', '+}']);
        expect(checkStaticPremise({ ruleId: 'eqeqeq', line: 1 }, p).ok).toBe(false);
    });

    it('no-empty-catch where no catch clause exists', () => {
        const p = patch(['+const x = compute();', '+return x;']);
        expect(checkStaticPremise({ ruleId: 'no-empty-catch', line: 1 }, p).ok).toBe(false);
    });

    it('does not let a rule match its own name quoted in a comment', () => {
        // "// no-dupe-keys: reviewed, keys are distinct" must not satisfy the
        // premise — a comment about a rule is not the construct the rule needs.
        const p = patch(['+// no-dupe-keys reviewed: a: 1 is fine', '+doWork();']);
        expect(checkStaticPremise({ ruleId: 'no-dupe-keys', line: 1 }, p).ok).toBe(false);
    });
});

describe('does NOT refute — the expensive direction', () => {
    it('passes no-dupe-keys on a real object literal', () => {
        const p = patch(['+const cfg = {', '+  a: 1,', '+  a: 2,', '+};']);
        expect(checkStaticPremise({ ruleId: 'no-dupe-keys', line: 2 }, p).ok).toBe(true);
    });

    it('passes no-unreachable after a return', () => {
        const p = patch(['+return early;', '+doWork();']);
        expect(checkStaticPremise({ ruleId: 'no-unreachable', line: 2 }, p).ok).toBe(true);
    });

    it('passes eqeqeq on genuine loose equality, and is not fooled by === or !==', () => {
        expect(checkStaticPremise({ ruleId: 'eqeqeq', line: 1 }, patch(['+if (a == b) {'])).ok).toBe(true);
        expect(checkStaticPremise({ ruleId: 'eqeqeq', line: 1 }, patch(['+if (a != b) {'])).ok).toBe(true);
        expect(checkStaticPremise({ ruleId: 'eqeqeq', line: 1 }, patch(['+if (a !== b) {'])).ok).toBe(false);
    });

    it('fails open for a rule it has never heard of', () => {
        const p = patch(['+const a = 1;']);
        expect(checkStaticPremise({ ruleId: 'some-future-rule', line: 1 }, p).ok).toBe(true);
    });

    it('fails open with no patch, no line, or an unparsed patch', () => {
        expect(checkStaticPremise({ ruleId: 'eqeqeq', line: 1 }, '').ok).toBe(true);
        expect(checkStaticPremise({ ruleId: 'eqeqeq' }, patch(['+if (a === b) {'])).ok).toBe(true);
        expect(checkStaticPremise({ ruleId: 'eqeqeq', line: 1 }, 'not a patch').ok).toBe(true);
    });

    it('defers to GATE 1 when the cited line is not in the diff at all', () => {
        // findingEvidence already refutes that with a better message; reporting
        // it twice would attribute the drop to the wrong gate.
        const p = patch(['+const a = 1;']);
        expect(checkStaticPremise({ ruleId: 'eqeqeq', line: 999 }, p).ok).toBe(true);
    });

    it('reads a window, so a construct split across lines still counts', () => {
        // Cited at the opening brace; the repeated key is on following lines.
        const p = patch(['+const cfg = {', '+  dupe: 1,', '+  dupe: 2,', '+};']);
        expect(checkStaticPremise({ ruleId: 'no-dupe-keys', line: 1 }, p).ok).toBe(true);
    });

    it('requires an actual DUPLICATE key, not merely an object literal', () => {
        // The tightening that took this gate from 7 to 22 kills on the measured
        // corpus, with no true positive lost: real diffs are full of object
        // literals, so "a literal exists" is not the rule's premise.
        const distinct = patch(['+const cfg = {', '+  a: 1,', '+  b: 2,', '+};']);
        expect(checkStaticPremise({ ruleId: 'no-dupe-keys', line: 2 }, distinct).ok).toBe(false);
    });

    it('requires the terminator to be ABOVE the cited line for unreachability', () => {
        // A `return` two lines below makes nothing above it dead.
        const below = patch(['+doWork();', '+more();', '+return x;']);
        expect(checkStaticPremise({ ruleId: 'no-unreachable', line: 1 }, below).ok).toBe(false);
    });

    it('exposes its rule coverage rather than making tests guess', () => {
        expect(CHECKED_RULES).toEqual(expect.arrayContaining(['no-dupe-keys', 'no-unreachable', 'eqeqeq']));
    });
});

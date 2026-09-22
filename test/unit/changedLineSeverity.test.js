/**
 * Promotion is narrow on purpose: same rule, same detection, severity decided by
 * whether this change wrote the line. These tests pin the narrowness — a rule
 * off the allowlist, or a hit on a context line, must come back untouched.
 */
const { promoteIntroducedFindings, addedLineIndex } = require('../../src/utils/changedLineSeverity.js');

// new-side: 10 context, 11 added, 12 added
const PATCH = ['@@ -10,1 +10,3 @@', ' const a = 1;', '+if (x == undefined) {}', '+const b = 2;'].join('\n');
const files = [{ filename: 'src/a.js', patch: PATCH }];

const finding = (over = {}) => ({
    ruleId: 'ts/eqeqeq', filePath: 'src/a.js', line: 11,
    severity: 'low', message: 'Use === / !== instead of == / !=.', ...over,
});

describe('addedLineIndex', () => {
    it('indexes added lines only, not context', () => {
        const idx = addedLineIndex(files);
        expect([...idx.get('src/a.js')].sort((a, b) => a - b)).toEqual([11, 12]);
    });
});

describe('promoteIntroducedFindings', () => {
    it('promotes an allowlisted rule on an added line', () => {
        const { findings, promoted } = promoteIntroducedFindings([finding()], files);
        expect(promoted).toBe(1);
        expect(findings[0].severity).toBe('medium');
        expect(findings[0].introducedByChange).toBe(true);
    });

    it('rewrites the message to state a consequence, not a preference', () => {
        const { findings } = promoteIntroducedFindings([finding()], files);
        // lowValueGate demotes prose that reads as a preference; the promoted
        // form must not read like one.
        expect(findings[0].message).not.toMatch(/prefer|consider using|for readability|style/i);
        expect(findings[0].message).toMatch(/coercion/i);
    });

    it('leaves a hit on a context line alone — it is pre-existing style', () => {
        const { findings, promoted } = promoteIntroducedFindings([finding({ line: 10 })], files);
        expect(promoted).toBe(0);
        expect(findings[0].severity).toBe('low');
    });

    it('leaves a rule that is not on the allowlist alone', () => {
        const { findings, promoted } = promoteIntroducedFindings(
            [finding({ ruleId: 'ts/no-debugger' })], files,
        );
        expect(promoted).toBe(0);
        expect(findings[0].severity).toBe('low');
    });

    it('leaves a finding in an unchanged file alone', () => {
        const { promoted } = promoteIntroducedFindings([finding({ filePath: 'src/other.js' })], files);
        expect(promoted).toBe(0);
    });

    it('is a no-op with no findings or no files', () => {
        expect(promoteIntroducedFindings([], files).promoted).toBe(0);
        expect(promoteIntroducedFindings([finding()], []).promoted).toBe(0);
    });

    it('does not drop anything', () => {
        const input = [finding(), finding({ ruleId: 'other/rule' }), finding({ line: 10 })];
        expect(promoteIntroducedFindings(input, files).findings).toHaveLength(3);
    });
});

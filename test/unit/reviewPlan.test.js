/**
 * The plan pass. Its value is an agenda on large units; its risk is cost and a
 * model treating the agenda as findings. These tests pin the gate and the
 * fail-open behaviour — the two things that decide whether a review still runs.
 */
const {
    changedLineCount, shouldPlan, buildPlanPrompt, runReviewPlan,
    PLAN_LINE_THRESHOLD,
} = require('../../src/utils/reviewPlan.js');

const patchOf = (n) => ['@@ -1,1 +1,' + n + ' @@', ...Array.from({ length: n }, (_, i) => `+line ${i}`)].join('\n');
const unit = (files) => ({ files });

describe('changedLineCount', () => {
    it('counts added and removed lines, not headers', () => {
        const u = unit([{ filename: 'a.js', patch: '@@ -1,2 +1,2 @@\n-old\n+new\n context' }]);
        expect(changedLineCount(u)).toBe(2);
    });

    it('does not count the +++/--- file headers', () => {
        const u = unit([{ filename: 'a.js', patch: '--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n+one' }]);
        expect(changedLineCount(u)).toBe(1);
    });
});

describe('shouldPlan', () => {
    it('skips a small single-file change', () => {
        expect(shouldPlan(unit([{ filename: 'a.js', patch: patchOf(5) }]))).toBe(false);
    });

    it('plans a large single-file change', () => {
        expect(shouldPlan(unit([{ filename: 'a.js', patch: patchOf(PLAN_LINE_THRESHOLD + 1) }]))).toBe(true);
    });

    it('holds a multi-file group to the higher threshold', () => {
        const u = unit([
            { filename: 'a.js', patch: patchOf(30) },
            { filename: 'b.js', patch: patchOf(30) },
        ]);
        expect(shouldPlan(u)).toBe(false);          // 60 changed lines, group bar is 100
        expect(shouldPlan(u, { groupThreshold: 50 })).toBe(true);
    });

    it('never plans an empty unit', () => {
        expect(shouldPlan(unit([]))).toBe(false);
    });
});

describe('buildPlanPrompt', () => {
    it('includes every file patch and the stated purpose', () => {
        const p = buildPlanPrompt(
            unit([{ filename: 'a.js', patch: '+a' }, { filename: 'b.js', patch: '+b' }]),
            { prContext: { title: 'T', purpose: 'P' } },
        );
        expect(p).toContain('a.js');
        expect(p).toContain('b.js');
        expect(p).toContain('T');
        expect(p).toContain('P');
    });
});

describe('runReviewPlan', () => {
    const big = unit([{ filename: 'a.js', patch: patchOf(PLAN_LINE_THRESHOLD + 1) }]);

    it('returns the plan text when the model answers in the expected shape', async () => {
        const llm = { streamChat: async () => ({ content: 'Summary: x\n\nIssues\n\n1. [high] y' }) };
        expect(await runReviewPlan({ llmService: llm, unit: big })).toContain('Issues');
    });

    it('returns empty when the unit is below the gate — no call is made', async () => {
        let called = false;
        const llm = { streamChat: async () => { called = true; return { content: 'Issues' }; } };
        const out = await runReviewPlan({ llmService: llm, unit: unit([{ filename: 'a.js', patch: patchOf(2) }]) });
        expect(out).toBe('');
        expect(called).toBe(false);
    });

    it('fails open when the model throws — the review must still run', async () => {
        const llm = { streamChat: async () => { throw new Error('rate limited'); } };
        await expect(runReviewPlan({ llmService: llm, unit: big })).resolves.toBe('');
    });

    it('rejects output that is not a plan rather than passing prose along', async () => {
        const llm = { streamChat: async () => ({ content: 'I cannot help with that.' }) };
        expect(await runReviewPlan({ llmService: llm, unit: big })).toBe('');
    });

    it('returns empty with no llmService', async () => {
        expect(await runReviewPlan({ llmService: null, unit: big })).toBe('');
    });
});

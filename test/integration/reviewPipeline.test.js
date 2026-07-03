/**
 * Integration test: the REAL review pipeline end-to-end on a fixture diff.
 *
 * Unlike test/unit/orchestrator.e2e.test.js (which stubs the whole engine),
 * this wires the ACTUAL MultiPassReviewEngine into the ACTUAL ReviewOrchestrator
 * and stubs only the LLM network boundary (llmService.streamChat). It therefore
 * exercises file grouping, batch processing, per-file prompt building + response
 * parsing, cross-file aggregation, assigned-hunks normalization, cross-chunk
 * dedupe, and verdict roll-up together — the seam the mock-only tests hid.
 */

const { ReviewOrchestrator } = require('../../src/services/ReviewOrchestrator.js');
const { MultiPassReviewEngine } = require('../../src/services/MultiPassReviewEngine.js');
const { VERDICT } = require('../../src/services/reviewSchema.js');
const {
    PER_FILE_REVIEW_SYSTEM_PROMPT,
} = require('../../src/utils/multiPassPrompts.js');

// Build a file whose patch adds a line at `addedLine` (a real diff hunk), so
// findings on that line survive assigned-hunks normalization.
function fileWithAddedLine(filename, addedLine) {
    const patch = [
        `@@ -${addedLine},0 +${addedLine},1 @@`,
        `+const value_${addedLine} = 1;`,
    ].join('\n');
    return { filename, additions: 1, deletions: 0, patch, language: 'javascript' };
}

function fixturePR() {
    return {
        state: 'open',
        isDraft: false,
        mergeable: true,
        author: { login: 'alice' },
        title: 'Add search endpoint',
        stats: { additions: 2, deletions: 0 },
        commits: [{ sha: 'abc1234', message: 'feat: add search' }],
        files: [
            fileWithAddedLine('src/foo.js', 2),
            fileWithAddedLine('src/bar.js', 2),
        ],
    };
}

/**
 * Stub LLM: returns a valid per-file JSON review for per-file calls (one real
 * finding on the added line + one out-of-hunk finding that must be dropped),
 * and a plain-text synthesis for the aggregation call.
 */
function makeStubLLM() {
    return jest.fn(async (messages) => {
        const system = messages?.[0]?.content ?? '';
        const isPerFile = system === PER_FILE_REVIEW_SYSTEM_PROMPT;

        if (isPerFile) {
            // Derive which file this unit is about from the user prompt so the
            // finding's file matches an assigned hunk.
            const userPrompt = messages?.[1]?.content ?? '';
            const file = /src\/bar\.js/.test(userPrompt) ? 'src/bar.js' : 'src/foo.js';
            return {
                content: JSON.stringify({
                    file,
                    language: 'javascript',
                    fileVerdict: 'REQUEST_CHANGES',
                    riskLevel: 'HIGH',
                    findings: [
                        { severity: 'high', file, line: 2, message: 'Unvalidated input reaches query', rule: 'security:injection' },
                        { severity: 'low', file, line: 999, message: 'Out-of-hunk nit — should be dropped' },
                    ],
                    positives: [],
                }),
                usage: { input: 100, output: 50 },
            };
        }

        // Aggregation call
        return { content: 'Cross-file synthesis: input validation gap spans the search path.', usage: { input: 40, output: 20 } };
    });
}

describe('Review pipeline (real engine + orchestrator) integration', () => {
    it('reviews a fixture diff end-to-end and returns normalized, canonical findings', async () => {
        const streamChat = makeStubLLM();
        const engine = new MultiPassReviewEngine({ llmService: { streamChat } });
        const orchestrator = new ReviewOrchestrator({ multiPassEngine: engine });

        const events = [];
        const report = await orchestrator.review(
            fixturePR(), {}, { provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'sk-test' }, {},
            (ev) => events.push(ev),
        );

        // Skip rules let normal code changes through.
        expect(report.meta.gate.action).toBe('REVIEW');

        // The LLM boundary was actually exercised (per-file calls + aggregation).
        expect(streamChat).toHaveBeenCalled();
        expect(streamChat.mock.calls.length).toBeGreaterThanOrEqual(2);

        // Real per-file findings survived the seam (this is what the mock-only
        // suite hid): at least one canonical finding with a real line + severity.
        expect(report.findings.length).toBeGreaterThan(0);
        const kept = report.findings;
        expect(kept.every((f) => ['src/foo.js', 'src/bar.js'].includes(f.file))).toBe(true);
        expect(kept.some((f) => f.line === 2 && f.severity === 'blocking')).toBe(true);

        // Out-of-hunk finding (line 999) was dropped by normalization.
        expect(kept.some((f) => f.line === 999)).toBe(false);

        // Verdict reflects the worst surviving severity (a 'high' → blocking).
        expect(report.verdict).toBe(VERDICT.BLOCK);

        // Deep-phase narrative came from the aggregation call.
        expect(report.summary.deep).toContain('Cross-file synthesis');

        // Streaming emitted per-chunk findings before the final report.
        expect(events.some((e) => e.step === 'chunk_findings')).toBe(true);
    });

    it('short-circuits via skip rules for a draft PR without calling the LLM', async () => {
        const streamChat = jest.fn();
        const engine = new MultiPassReviewEngine({ llmService: { streamChat } });
        const orchestrator = new ReviewOrchestrator({ multiPassEngine: engine });

        const pr = fixturePR();
        pr.isDraft = true;

        const report = await orchestrator.review(pr, {}, {}, {});
        expect(['SKIP', 'DEFER']).toContain(report.meta.gate.action);
        expect(streamChat).not.toHaveBeenCalled();
        expect(report.findings).toHaveLength(0);
    });
});

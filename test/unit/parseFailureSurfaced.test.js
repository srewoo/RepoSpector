const { MultiPassReviewEngine } = require('../../src/services/MultiPassReviewEngine.js');

describe('a per-file parse failure is counted, not hidden', () => {
    it('reports parseFailures in the result stats', async () => {
        // MultiPassReviewEngine calls this.llmService.streamChat(...) (not
        // callLLM) at both the per-unit review pass and the aggregation pass,
        // and unwraps each response as `response.content || response`.
        const llm = {
            streamChat: jest.fn().mockResolvedValue({
                content: 'Sorry, here is prose and no JSON.',
                usage: { input: 1, output: 1 }
            })
        };
        const engine = new MultiPassReviewEngine({ llmService: llm });
        const prData = { files: [{ filename: 'a.js', patch: '@@ -1,1 +1,2 @@\n a\n+b', additions: 1, deletions: 0 }] };
        // Signature is execute(prData, context, settings, options, onProgress) — MultiPassReviewEngine.js:37
        const res = await engine.execute(prData, {}, { model: 'openai:gpt-4o', apiKey: 'x' }, {}, null);
        expect(res.stats?.parseFailures).toBe(1);
        // `perFileFindings` is one result object per file (verified in the
        // task brief), so with one file it has length 1, not 0 — the array
        // itself does not go empty. What must be empty is the findings the
        // unparseable unit actually contributed: without this counter, a
        // unit whose findings never survived parsing is indistinguishable
        // from a file with zero findings because it was genuinely clean.
        expect(res.perFileFindings).toHaveLength(1);
        expect(res.perFileFindings.flatMap(f => f.findings || [])).toHaveLength(0);
    });
});

/**
 * Counting a parse failure and telling nobody is the same defect as not
 * counting it. `buildPrecisionAnalysis` already renders the honest text; the
 * handler now feeds parseFailures into its `partial` flag (prReviewHandlers.js)
 * so a file whose JSON never parsed can no longer land inside a "Clean review".
 */
describe('a parse failure produces the partial-review treatment', () => {
    const { buildPrecisionAnalysis } = require('../../src/utils/genuineProblemGate.js');

    // Mirrors the expression in prReviewHandlers.js.
    const analysisFor = (parseFailures, findings = [], partialOnly = false) => {
        let text = buildPrecisionAnalysis(findings, { partial: partialOnly || parseFailures > 0 });
        if (parseFailures > 0) {
            text += `\n\n> ⚠️ ${parseFailures} review unit${parseFailures === 1 ? '' : 's'} produced output that could not be parsed`;
        }
        return text;
    };

    it('does not report a clean review when a unit failed to parse', () => {
        const text = analysisFor(1);
        expect(text).not.toMatch(/Clean review/);
        expect(text).toMatch(/Partial review/);
        expect(text).toMatch(/not considered clean/);
        expect(text).toMatch(/could not be parsed/);
    });

    it('is unchanged when nothing failed to parse', () => {
        expect(analysisFor(0)).toBe('## Clean review\n\nNo genuine problems were found in the changed code.');
    });

    it('a partial run with findings still says partial, not "N problems found"', () => {
        const text = analysisFor(2, [{ severity: 'high', title: 'x' }]);
        expect(text).toMatch(/Partial review/);
        expect(text).toMatch(/2 review units produced output that could not be parsed/);
    });
});

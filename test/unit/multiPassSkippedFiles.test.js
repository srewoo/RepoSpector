/**
 * The engine used to record the files it cut for the file cap on an instance
 * field (`lastSkippedFiles`). Two chunks sharing one engine in parallel would
 * overwrite each other's value. It is now part of the returned result.
 */
const { MultiPassReviewEngine } = require('../../src/services/MultiPassReviewEngine.js');
const { PER_FILE_REVIEW_SYSTEM_PROMPT } = require('../../src/utils/multiPassPrompts.js');

const file = (filename, added) => ({
    filename, additions: added, deletions: 0, language: 'javascript',
    patch: ['@@ -1,0 +1,1 @@', '+const x = 1;'].join('\n'),
});

function stubLLM() {
    return jest.fn(async (messages) => {
        if (messages?.[0]?.content === PER_FILE_REVIEW_SYSTEM_PROMPT) {
            return {
                content: JSON.stringify({ file: 'src/big.js', language: 'javascript', fileVerdict: 'APPROVE', riskLevel: 'LOW', findings: [], positives: [] }),
                usage: { input: 1, output: 1 },
            };
        }
        return { content: 'ok', usage: { input: 1, output: 1 } };
    });
}

describe('MultiPassReviewEngine skippedFiles', () => {
    it('returns the files cut by maxFilesToReview instead of storing them on the instance', async () => {
        const engine = new MultiPassReviewEngine({ llmService: { streamChat: stubLLM() } });
        const prData = { title: 't', files: [file('src/big.js', 400), file('src/small.js', 1)] };
        const result = await engine.execute(
            prData, {}, { provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'sk' },
            { maxFilesToReview: 1, reviewPlan: false },
        );
        expect(result.skippedFiles).toHaveLength(1);
        expect(['src/big.js', 'src/small.js']).toContain(result.skippedFiles[0]);
        expect(engine.lastSkippedFiles).toBeUndefined();
    });

    it('returns an empty list when nothing was cut', async () => {
        const engine = new MultiPassReviewEngine({ llmService: { streamChat: stubLLM() } });
        const result = await engine.execute(
            { title: 't', files: [file('src/big.js', 4)] }, {},
            { provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'sk' }, { reviewPlan: false },
        );
        expect(result.skippedFiles).toEqual([]);
    });
});

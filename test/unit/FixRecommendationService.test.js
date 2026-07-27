/**
 * Tests for FixRecommendationService — recommendation-only suggested patches.
 * Uses a mock llmService so no network/key is needed.
 */
const { FixRecommendationService } = require('../../src/services/FixRecommendationService.js');

function mockLLM(fixes) {
    return {
        streamChat: jest.fn().mockResolvedValue({
            content: JSON.stringify({ fixes }),
            usage: { input: 10, output: 5 }
        })
    };
}

const prData = { files: [{ filename: 'a.js', patch: '+ const x = a || b;' }] };
const settings = { provider: 'openai', model: 'x', apiKey: 'k' };

describe('FixRecommendationService', () => {
    it('attaches a suggestedFix (recommendation only) to a finding', async () => {
        const llm = mockLLM([
            { fid: 'FX0', original: 'const x = a || b;', replacement: 'const x = a ?? b;', explanation: 'nullish', applicability: 'safe', confidence: 0.9 }
        ]);
        const svc = new FixRecommendationService({ llmService: llm });
        const { findings, stats } = await svc.recommend([
            { file: 'a.js', line: 1, severity: 'high', title: 'use ??' }
        ], { prData, settings });

        expect(stats.produced).toBe(1);
        expect(findings[0].suggestedFix.replacement).toBe('const x = a ?? b;');
        expect(findings[0].suggestedFix.applicability).toBe('safe');
        expect(findings[0].suggestedFix.recommendationOnly).toBe(true);
    });

    it('skips a fix when both original and replacement are null', async () => {
        const llm = mockLLM([{ fid: 'FX0', original: null, replacement: null, explanation: 'cannot fix' }]);
        const svc = new FixRecommendationService({ llmService: llm });
        const { findings, stats } = await svc.recommend([
            { file: 'a.js', line: 1, severity: 'medium', title: 'x' }
        ], { prData, settings });
        expect(stats.produced).toBe(0);
        expect(findings[0].suggestedFix).toBeUndefined();
    });

    it('defaults unknown applicability to review-needed', async () => {
        const llm = mockLLM([{ fid: 'FX0', original: 'a', replacement: 'b', applicability: 'totally-safe-trust-me', confidence: 0.5 }]);
        const svc = new FixRecommendationService({ llmService: llm });
        const { findings } = await svc.recommend([
            { file: 'a.js', line: 1, severity: 'high', title: 'x' }
        ], { prData, settings });
        expect(findings[0].suggestedFix.applicability).toBe('review-needed');
    });

    it('no-ops cleanly with no findings', async () => {
        const llm = mockLLM([]);
        const svc = new FixRecommendationService({ llmService: llm });
        const { findings, stats } = await svc.recommend([], { prData, settings });
        expect(findings).toEqual([]);
        expect(stats.produced).toBe(0);
        expect(llm.streamChat).not.toHaveBeenCalled();
    });
});

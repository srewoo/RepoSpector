const { RelevanceScorer } = require('../../src/services/RelevanceScorer.js');

describe('RelevanceScorer reads hybrid-searcher fields', () => {
    const scorer = new RelevanceScorer();
    const hybrid = (semanticScore, keywordScore) => ({
        docId: 'd', score: 0.02, content: 'function unrelated() {}',
        metadata: { filePath: 'src/x.js' },
        matchInfo: { semanticScore, keywordScore, keywordRank: 1, semanticRank: 1, boosts: [] },
    });

    it('a strong semantic match outranks a weak one', () => {
        const [top] = scorer.rerank([hybrid(0.2, 0), hybrid(0.9, 0)], 'anything');
        expect(top.matchInfo.semanticScore).toBe(0.9);
    });

    it('a strong keyword match outranks a weak one', () => {
        const [top] = scorer.rerank([hybrid(0, 1), hybrid(0, 14)], 'anything');
        expect(top.matchInfo.keywordScore).toBe(14);
    });

    it('still accepts vector-only results with top-level similarity', () => {
        const [top] = scorer.rerank([{ similarity: 0.1, content: '', metadata: {} }, { similarity: 0.8, content: '', metadata: {} }], 'q');
        expect(top.similarity).toBe(0.8);
    });
});

/**
 * Self-reflection scoring.
 *
 * The posting policy used to order by severity, which the model assigns to each
 * finding in isolation with every incentive to inflate — so "sort by severity,
 * keep 15" was close to arbitrary among a pile of self-declared `high`s. These
 * tests pin the two properties that make the score safe to rely on: it orders
 * correctly, and it never silently deletes a finding that survived verification.
 */

const { SuggestionScorer } = require('../../src/services/SuggestionScorer.js');
const { partitionForPosting } = require('../../src/utils/reviewPostingPolicy.js');

function mockLLM(scores) {
    return {
        streamChat: jest.fn().mockResolvedValue({
            content: JSON.stringify({ scores }),
            usage: { input: 10, output: 5 },
        }),
    };
}

const prData = { title: 'PR' };
const settings = { provider: 'openai', model: 'x', apiKey: 'k' };

const findings = [
    { file: 'a.js', line: 1, severity: 'high', title: 'generic advice' },
    { file: 'a.js', line: 2, severity: 'high', title: 'command injection' },
    { file: 'a.js', line: 3, severity: 'high', title: 'naming nit' },
];

describe('SuggestionScorer', () => {
    it('attaches scores and sorts most-valuable first', async () => {
        const llm = mockLLM([
            { sid: 'S0', score: 2, reason: 'generic' },
            { sid: 'S1', score: 9, reason: 'concrete failure path' },
            { sid: 'S2', score: 4, reason: 'minor' },
        ]);
        const { findings: out, stats } = await new SuggestionScorer({ llmService: llm })
            .score(findings, { prData, settings });

        expect(out.map(f => f.title)).toEqual(['command injection', 'naming nit', 'generic advice']);
        expect(out[0].score).toBe(9);
        expect(out[0].scoreReason).toBe('concrete failure path');
        expect(stats).toMatchObject({ input: 3, scored: 3, min: 2, max: 9 });
    });

    it('strips the internal sid before the finding leaves the service', async () => {
        const llm = mockLLM([{ sid: 'S0', score: 5 }]);
        const { findings: out } = await new SuggestionScorer({ llmService: llm })
            .score([findings[0]], { prData, settings });
        expect(out[0].sid).toBeUndefined();
    });

    it('keeps an unscored finding at a neutral score rather than dropping it', async () => {
        // Model answered for one of three. The other two must survive.
        const llm = mockLLM([{ sid: 'S1', score: 8 }]);
        const { findings: out, stats } = await new SuggestionScorer({ llmService: llm })
            .score(findings, { prData, settings });

        expect(out).toHaveLength(3);
        expect(stats).toMatchObject({ scored: 1, unscored: 2 });
        expect(out.filter(f => f.scoreSource === 'default')).toHaveLength(2);
    });

    it('survives a scoring outage with every finding intact', async () => {
        const llm = { streamChat: jest.fn().mockRejectedValue(new Error('502')) };
        const { findings: out } = await new SuggestionScorer({ llmService: llm })
            .score(findings, { prData, settings });
        expect(out).toHaveLength(3);
        expect(out.every(f => f.score === 5)).toBe(true);
    });

    it('clamps a model that ignores the 1-10 scale', async () => {
        const llm = mockLLM([
            { sid: 'S0', score: 99 },
            { sid: 'S1', score: -4 },
            { sid: 'S2', score: 'high' },
        ]);
        const { findings: out } = await new SuggestionScorer({ llmService: llm })
            .score(findings, { prData, settings });

        const byTitle = Object.fromEntries(out.map(f => [f.title, f.score]));
        expect(byTitle['generic advice']).toBe(10);
        expect(byTitle['command injection']).toBe(1);
        // Unparseable → neutral, not dropped.
        expect(byTitle['naming nit']).toBe(5);
    });

    it('does nothing when there is no LLM, rather than failing the review', async () => {
        const { findings: out, usage } = await new SuggestionScorer({})
            .score(findings, { prData, settings });
        expect(out).toEqual(findings);
        expect(usage).toEqual({ input: 0, output: 0 });
    });
});

describe('partitionForPosting with scores', () => {
    // `scoreSource: 'model'` is what SuggestionScorer stamps on a finding a
    // batch actually scored, and it is now what makes the score a VERDICT the
    // posting floor may act on. A bare number with no provenance is treated as
    // unscored (see the two tests at the end of this block).
    const blocking = (line, score, title) => ({ file: 'a.js', line, severity: 'blocking', score, scoreSource: 'model', title });

    it('fills the inline cap with the highest-scoring findings', () => {
        const { inline } = partitionForPosting(
            [blocking(1, 3, 'low value'), blocking(2, 9, 'high value'), blocking(3, 6, 'mid')],
            { maxInline: 2 },
        );
        expect(inline.map(f => f.title)).toEqual(['high value', 'mid']);
    });

    it('drops below an explicit score floor and says so', () => {
        const { inline, stats } = partitionForPosting(
            [blocking(1, 3, 'low'), blocking(2, 9, 'high')],
            { minScore: 5 },
        );
        expect(inline.map(f => f.title)).toEqual(['high']);
        expect(stats.droppedByScore).toBe(1);
    });

    it('never drops an UNSCORED finding on the score gate', () => {
        // The scorer not answering is not evidence against the finding.
        const { inline, stats } = partitionForPosting(
            [{ file: 'a.js', line: 1, severity: 'blocking', title: 'unscored' }],
            { minScore: 8 },
        );
        expect(inline).toHaveLength(1);
        expect(stats.droppedByScore).toBe(0);
    });

    it('leaves order untouched when nothing is scored', () => {
        const input = [blocking(1, undefined, 'first'), blocking(2, undefined, 'second')];
        const { inline } = partitionForPosting(input, {});
        expect(inline.map(f => f.title)).toEqual(['first', 'second']);
    });

    it('never drops a finding whose score has no model provenance', () => {
        // SuggestionScorer.js:88 stamps `score: 5, scoreSource: 'default'` on
        // every finding a batch did not return. The number is finite but is not
        // a verdict, so the floor must not act on it — otherwise a repo-set
        // minScore deletes the comment for a finding the precision gate kept
        // and decideFailure already turned into REQUEST_CHANGES.
        const { inline, stats } = partitionForPosting(
            [{ file: 'a.js', line: 1, severity: 'blocking', title: 'stamped', score: 5, scoreSource: 'default' }],
            { minScore: 8 },
        );
        expect(inline).toHaveLength(1);
        expect(stats.droppedByScore).toBe(0);
    });

    it('never drops a gate-tagged _scoreUnavailable finding', () => {
        const { inline, stats } = partitionForPosting(
            [{ file: 'a.js', line: 1, severity: 'blocking', title: 'tagged', score: 5, scoreSource: 'default', _scoreUnavailable: true }],
            { minScore: 8 },
        );
        expect(inline).toHaveLength(1);
        expect(stats.droppedByScore).toBe(0);
    });

    it('is off by default — no score floor unless asked for', () => {
        const { inline, stats } = partitionForPosting([blocking(1, 1, 'barely worth it')], {});
        expect(inline).toHaveLength(1);
        expect(stats.droppedByScore).toBe(0);
    });
});

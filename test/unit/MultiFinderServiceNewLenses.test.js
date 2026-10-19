/**
 * MultiFinderService with the context-backed lenses (spec §3.1, §3.3):
 * `needs` resolution, not-run reporting, OPTIONAL budget priority, the
 * rulesCompliance quote filter, and PR intent reaching every lens.
 */
const { MultiFinderService } = require('../../src/services/MultiFinderService.js');
const { FINDER_LENSES } = require('../../src/utils/finderLensPrompts.js');
const { NEW_LENSES } = require('../../src/review-core/lenses/index.js');
const { PRIORITY } = require('../../src/utils/callBudget.js');

const settings = { provider: 'openai', model: 'x', apiKey: 'k' };
const prData = {
    title: 'PR', baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40),
    files: [{ filename: 'src/a.js', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,2 @@\n a\n+b' }],
};
const rules = NEW_LENSES.find(l => l.key === 'rulesCompliance');
const prior = NEW_LENSES.find(l => l.key === 'priorPrComments');

const llmReturning = (findings) => ({
    streamChat: jest.fn().mockResolvedValue({ content: JSON.stringify({ findings }), usage: { input: 1, output: 1 } }),
});
const callFor = (llm, title) => llm.streamChat.mock.calls.find(c => c[0][0].content.includes(title));

describe('MultiFinderService — context-backed lenses', () => {
    it('runs a lens with its context at OPTIONAL priority; old lenses stay ESSENTIAL', async () => {
        const llm = llmReturning([]);
        await new MultiFinderService({ llmService: llm }).findAdditional([], {
            prData, settings, maxRounds: 1,
            lenses: [FINDER_LENSES[0], rules],
            rulesFiles: [{ path: 'AGENTS.md', text: 'Never log tokens.' }],
        });
        const rc = callFor(llm, rules.title);
        expect(JSON.stringify(rc[0][1].content)).toContain('Never log tokens.');
        expect(rc[1].budgetPriority).toBe(PRIORITY.OPTIONAL);
        expect(callFor(llm, FINDER_LENSES[0].title)[1].budgetPriority).toBe(PRIORITY.ESSENTIAL);
    });

    it('a lens whose need is not-run is not called and is reported', async () => {
        const llm = llmReturning([]);
        const contextPort = { priorPrComments: jest.fn(async () => ({ status: 'not-run', reason: 'pass prior_pr_comments' })) };
        const { stats } = await new MultiFinderService({ llmService: llm }).findAdditional([], {
            prData, settings, maxRounds: 1, lenses: [FINDER_LENSES[0], prior], contextPort,
        });
        expect(callFor(llm, prior.title)).toBeUndefined();
        expect(stats.lensReport).toEqual([{ lens: 'priorPrComments', status: 'not-run', reason: 'pass prior_pr_comments' }]);
    });

    it('reports not-run even when no lens is left to run', async () => {
        const llm = llmReturning([]);
        const { stats } = await new MultiFinderService({ llmService: llm }).findAdditional([], {
            prData, settings, maxRounds: 1, lenses: [rules], rulesFiles: [],
        });
        expect(llm.streamChat).not.toHaveBeenCalled();
        expect(stats.lensReport[0]).toMatchObject({ lens: 'rulesCompliance', status: 'not-run' });
    });

    it('drops rulesCompliance findings without a quoted rule and tags the rest', async () => {
        const llm = llmReturning([
            { file: 'src/a.js', line: 2, type: 'style', title: 'logs a token', quotedRule: 'Never log tokens.', rulesFile: 'AGENTS.md' },
            { file: 'src/a.js', line: 2, type: 'style', title: 'vague rule claim' },
        ]);
        const { findings } = await new MultiFinderService({ llmService: llm }).findAdditional([], {
            prData, settings, maxRounds: 1, lenses: [rules],
            rulesFiles: [{ path: 'AGENTS.md', text: 'Never log tokens.' }],
        });
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ lens: 'rulesCompliance', quotedRule: 'Never log tokens.', source: 'llm' });
    });

    it('a lens call that fails is reported in lensReport', async () => {
        const llm = { streamChat: jest.fn().mockRejectedValue(new Error('Call budget exhausted')) };
        const { stats } = await new MultiFinderService({ llmService: llm }).findAdditional([], {
            prData, settings, maxRounds: 1, lenses: [rules],
            rulesFiles: [{ path: 'AGENTS.md', text: 'Never log tokens.' }],
        });
        expect(stats.lensReport).toEqual([{ lens: 'rulesCompliance', status: 'not-run', reason: 'Call budget exhausted' }]);
    });

    it('PR description and linked issue reach every lens, capped at 2000 chars each', async () => {
        const llm = llmReturning([]);
        await new MultiFinderService({ llmService: llm }).findAdditional([], {
            prData, settings, maxRounds: 1,
            prDescription: 'D'.repeat(5000), linkedIssue: 'ISSUE-7: users must be able to log out',
        });
        for (const call of llm.streamChat.mock.calls) {
            const user = JSON.stringify(call[0][1].content);
            expect(user).toContain('ISSUE-7: users must be able to log out');
            expect(user).toContain('D'.repeat(2000));
            expect(user).not.toContain('D'.repeat(2001));
        }
    });
});

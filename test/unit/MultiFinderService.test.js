/**
 * Tests for MultiFinderService — recall booster with loop-until-dry.
 * Mock llmService so no network/key is needed.
 */
const { MultiFinderService } = require('../../src/services/MultiFinderService.js');
const { FINDER_LENSES } = require('../../src/utils/finderLensPrompts.js');

// Assert against the lens registry rather than a hardcoded count, so adding a
// lens (e.g. `systemic`) does not fail an unrelated test.
const ALL_LENSES = FINDER_LENSES.length;
const NON_TEST_LENSES = FINDER_LENSES.filter(l => l.key !== 'test-quality').length;

const settings = { provider: 'openai', model: 'x', apiKey: 'k' };

describe('MultiFinderService', () => {
    it('adds a genuinely new finding and dedupes identical ones across lenses', async () => {
        // Every lens call returns the SAME finding → only one survives dedup.
        const llm = {
            streamChat: jest.fn().mockResolvedValue({
                content: JSON.stringify({ findings: [{ file: 'a.js', line: 7, type: 'security', title: 'ssrf on resolved target' }] }),
                usage: { input: 5, output: 5 }
            })
        };
        const svc = new MultiFinderService({ llmService: llm });
        const prData = { title: 'PR', files: [{ filename: 'a.js', patch: '+ fetch(userUrl)' }] };

        const { findings, stats } = await svc.findAdditional([], { prData, settings, maxRounds: 2 });

        expect(findings).toHaveLength(1);
        expect(findings[0].title).toMatch(/ssrf/i);
        expect(findings[0].source).toBe('llm');
        expect(findings[0].lens).toBeTruthy();
        // Round 1 adds 1; round 2 finds only the duplicate → dry → stop.
        expect(stats.rounds).toBe(2);
        expect(stats.added).toBe(1);
    });

    it('does not re-report a finding already in the baseline', async () => {
        const llm = {
            streamChat: jest.fn().mockResolvedValue({
                content: JSON.stringify({ findings: [{ file: 'a.js', line: 7, type: 'security', title: 'ssrf issue' }] }),
                usage: { input: 5, output: 5 }
            })
        };
        const svc = new MultiFinderService({ llmService: llm });
        const prData = { title: 'PR', files: [{ filename: 'a.js', patch: '+ fetch(userUrl)' }] };
        const baseline = [{ file: 'a.js', line: 7, type: 'security', title: 'ssrf already found' }];

        const { findings, stats } = await svc.findAdditional(baseline, { prData, settings, maxRounds: 1 });
        expect(findings).toHaveLength(0);
        expect(stats.added).toBe(0);
    });

    it('skips the test-quality lens when no test files are in the diff', async () => {
        const llm = {
            streamChat: jest.fn().mockResolvedValue({
                content: JSON.stringify({ findings: [{ file: 'a.js', line: 1, type: 'bug', title: 'same each time' }] }),
                usage: { input: 1, output: 1 }
            })
        };
        const svc = new MultiFinderService({ llmService: llm });
        const prData = { title: 'PR', files: [{ filename: 'a.js', patch: '+ x' }] }; // no test files

        await svc.findAdditional([], { prData, settings, maxRounds: 1 });
        // test-quality excluded when no test files are in the diff.
        expect(llm.streamChat).toHaveBeenCalledTimes(NON_TEST_LENSES);
    });

    it('runs the test-quality lens when a test file IS present', async () => {
        const llm = {
            streamChat: jest.fn().mockResolvedValue({
                content: JSON.stringify({ findings: [] }),
                usage: { input: 1, output: 1 }
            })
        };
        const svc = new MultiFinderService({ llmService: llm });
        const prData = { title: 'PR', files: [{ filename: 'a.test.js', patch: '+ expect(1).toBe(1)' }] };

        await svc.findAdditional([], { prData, settings, maxRounds: 1 });
        // empty findings ⇒ dry after round 1 ⇒ one call per active lens.
        expect(llm.streamChat).toHaveBeenCalledTimes(ALL_LENSES);
    });

    it('no-ops safely with an empty diff', async () => {
        const llm = { streamChat: jest.fn() };
        const svc = new MultiFinderService({ llmService: llm });
        const { findings } = await svc.findAdditional([], { prData: { files: [] }, settings });
        expect(findings).toEqual([]);
        expect(llm.streamChat).not.toHaveBeenCalled();
    });
});

/**
 * Tests for MultiFinderService — recall booster with loop-until-dry.
 * Mock llmService so no network/key is needed.
 */
const { MultiFinderService } = require('../../src/services/MultiFinderService.js');
const { FINDER_LENSES, activeLenses } = require('../../src/utils/finderLensPrompts.js');

// Expected call counts are derived from the same gate the service uses, rather
// than hardcoded or hand-subtracted. Gating is now per-lens (`appliesTo`,
// `requiresReuseContext`), so counting "all lenses minus the ones I remembered"
// silently rots the moment a lens grows a gate — which is exactly what happened
// when the a11y and reuse lenses were added.
const expectedCalls = (files, hasReuseContext = false) =>
    activeLenses(FINDER_LENSES, { files, hasReuseContext }).length;

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
        expect(llm.streamChat).toHaveBeenCalledTimes(expectedCalls(prData.files));
        const keysCalled = llm.streamChat.mock.calls.map(c => c[0][0].content);
        expect(keysCalled.some(sys => /Adversarial test reader/.test(sys))).toBe(false);
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
        expect(llm.streamChat).toHaveBeenCalledTimes(expectedCalls(prData.files));
        const keysCalled = llm.streamChat.mock.calls.map(c => c[0][0].content);
        expect(keysCalled.some(sys => /Adversarial test reader/.test(sys))).toBe(true);
    });

    it('drops the reuse lens when no prior-art candidates were retrieved', async () => {
        // The whole point of the lens is that it cites retrieved evidence. With
        // nothing retrieved it could only speculate, so it must not run at all.
        const llm = {
            streamChat: jest.fn().mockResolvedValue({
                content: JSON.stringify({ findings: [] }), usage: { input: 1, output: 1 }
            })
        };
        const svc = new MultiFinderService({ llmService: llm });
        const prData = { title: 'PR', files: [{ filename: 'a.js', patch: '+ x' }] };

        await svc.findAdditional([], { prData, settings, maxRounds: 1 });
        const systems = llm.streamChat.mock.calls.map(c => c[0][0].content);
        expect(systems.some(sys => /Codebase-reuse specialist/.test(sys))).toBe(false);
    });

    it('runs the reuse lens, with its candidates, when retrieval found some', async () => {
        const llm = {
            streamChat: jest.fn().mockResolvedValue({
                content: JSON.stringify({ findings: [] }), usage: { input: 1, output: 1 }
            })
        };
        const svc = new MultiFinderService({ llmService: llm });
        const prData = { title: 'PR', files: [{ filename: 'a.js', patch: '+ x' }] };
        const reuseContext = '## Possible prior implementations\n- `src/utils/old.js`';

        await svc.findAdditional([], { prData, settings, maxRounds: 1, reuseContext });

        expect(llm.streamChat).toHaveBeenCalledTimes(expectedCalls(prData.files, true));
        const reuseCall = llm.streamChat.mock.calls
            .find(c => /Codebase-reuse specialist/.test(c[0][0].content));
        expect(reuseCall).toBeDefined();
        // The candidates reach the lens that needs them...
        const reuseUser = JSON.stringify(reuseCall[0][1].content);
        expect(reuseUser).toContain('src/utils/old.js');
        // ...and no other lens pays for context it does not read.
        const otherCall = llm.streamChat.mock.calls
            .find(c => /Security specialist/.test(c[0][0].content));
        expect(JSON.stringify(otherCall[0][1].content)).not.toContain('src/utils/old.js');
    });

    it('skips the accessibility lens on a backend-only diff', async () => {
        // Asking for an a11y finding on a Go handler invites an invented one.
        const llm = {
            streamChat: jest.fn().mockResolvedValue({
                content: JSON.stringify({ findings: [] }), usage: { input: 1, output: 1 }
            })
        };
        const svc = new MultiFinderService({ llmService: llm });
        const prData = { title: 'PR', files: [{ filename: 'server/handler.go', patch: '+ x' }] };

        await svc.findAdditional([], { prData, settings, maxRounds: 1 });
        const systems = llm.streamChat.mock.calls.map(c => c[0][0].content);
        expect(systems.some(sys => /Accessibility & internationalisation/.test(sys))).toBe(false);
    });

    it('runs the accessibility lens when the diff touches UI files', async () => {
        const llm = {
            streamChat: jest.fn().mockResolvedValue({
                content: JSON.stringify({ findings: [] }), usage: { input: 1, output: 1 }
            })
        };
        const svc = new MultiFinderService({ llmService: llm });
        const prData = { title: 'PR', files: [{ filename: 'src/Button.tsx', patch: '+ <div onClick={go} />' }] };

        await svc.findAdditional([], { prData, settings, maxRounds: 1 });
        const systems = llm.streamChat.mock.calls.map(c => c[0][0].content);
        expect(systems.some(sys => /Accessibility & internationalisation/.test(sys))).toBe(true);
    });

    it('no-ops safely with an empty diff', async () => {
        const llm = { streamChat: jest.fn() };
        const svc = new MultiFinderService({ llmService: llm });
        const { findings } = await svc.findAdditional([], { prData: { files: [] }, settings });
        expect(findings).toEqual([]);
        expect(llm.streamChat).not.toHaveBeenCalled();
    });
});

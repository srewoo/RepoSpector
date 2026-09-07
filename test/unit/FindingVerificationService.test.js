/**
 * Tests for FindingVerificationService — adversarial FP removal.
 * Uses a mock llmService so no network/key is needed.
 */
const { FindingVerificationService } = require('../../src/services/FindingVerificationService.js');

function mockLLM(verdicts) {
    return {
        streamChat: jest.fn().mockResolvedValue({
            content: JSON.stringify({ verdicts }),
            usage: { input: 10, output: 5 }
        })
    };
}

const prData = { title: 'PR', files: [{ filename: 'a.py', patch: '+ bad line' }] };
const settings = { provider: 'openai', model: 'x', apiKey: 'k' };

describe('FindingVerificationService', () => {
    it('drops a finding the verifier confidently refutes', async () => {
        const llm = mockLLM([
            { vid: 'V0', keep: false, confidence: 0.9, reason: 'pre-existing' },
            { vid: 'V1', keep: true, confidence: 0.9, correctedSeverity: 'high' }
        ]);
        const svc = new FindingVerificationService({ llmService: llm });
        const { findings, dropped, stats } = await svc.verify([
            { file: 'a.py', line: 1, severity: 'high', title: 'fp' },
            { file: 'a.py', line: 2, severity: 'high', title: 'real' }
        ], { prData, settings, llmRefutation: true });

        expect(dropped).toHaveLength(1);
        expect(dropped[0].title).toBe('fp');
        expect(findings).toHaveLength(1);
        expect(findings[0].title).toBe('real');
        expect(stats.dropped).toBe(1);
        expect(stats.kept).toBe(1);
    });

    it('applies corrected severity on kept findings', async () => {
        const llm = mockLLM([{ vid: 'V0', keep: true, confidence: 0.8, correctedSeverity: 'low' }]);
        const svc = new FindingVerificationService({ llmService: llm });
        const { findings } = await svc.verify([
            { file: 'a.py', line: 1, severity: 'high', title: 'overrated' }
        ], { prData, settings, llmRefutation: true });
        expect(findings[0].severity).toBe('low');
        expect(findings[0]._originalSeverity).toBe('high');
    });

    it('fails open: keeps findings when no verdict is returned', async () => {
        const llm = mockLLM([]); // model returned nothing usable
        const svc = new FindingVerificationService({ llmService: llm });
        const { findings, dropped } = await svc.verify([
            { file: 'a.py', line: 1, severity: 'high', title: 'keep-me' }
        ], { prData, settings, llmRefutation: true });
        expect(dropped).toHaveLength(0);
        expect(findings).toHaveLength(1);
    });

    it('does NOT drop on a low-confidence refutation', async () => {
        const llm = mockLLM([{ vid: 'V0', keep: false, confidence: 0.3, reason: 'maybe' }]);
        const svc = new FindingVerificationService({ llmService: llm });
        const { findings, dropped } = await svc.verify([
            { file: 'a.py', line: 1, severity: 'high', title: 'uncertain' }
        ], { prData, settings, llmRefutation: true });
        expect(dropped).toHaveLength(0);
        expect(findings).toHaveLength(1);
    });

    it('bypasses deterministic static findings by default (never sent to the model)', async () => {
        const llm = mockLLM([]);
        const svc = new FindingVerificationService({ llmService: llm });
        const { findings } = await svc.verify([
            { file: 'a.py', line: 1, severity: 'high', title: 'secret', source: 'static' }
        ], { prData, settings, llmRefutation: true });
        expect(llm.streamChat).not.toHaveBeenCalled();
        expect(findings).toHaveLength(1);
    });

    it('passes graph findings through without asking the refuter', async () => {
        const llmService = { streamChat: jest.fn() };
        const svc = new FindingVerificationService({ llmService });
        const graphFinding = { file: 'src/a.js', line: 3, source: 'graph', rule: 'graph/signature-changed-callers', title: 't', description: 'd', severity: 'high', evidence: 'src/b.js:1' };
        const res = await svc.verify([graphFinding], { llmRefutation: true, verifyStatic: false });
        expect(res.findings).toHaveLength(1);
        expect(llmService.streamChat).not.toHaveBeenCalled();
    });
});

describe('llmRefutation defaults', () => {
    it('does not call the model unless the refuter is explicitly enabled', async () => {
        const llm = mockLLM([{ vid: 'V0', keep: false, confidence: 0.99, reason: 'no' }]);
        const svc = new FindingVerificationService({ llmService: llm });

        const { findings, stats, usage } = await svc.verify(
            [{ file: 'a.py', line: 1, severity: 'high', title: 'kept by default' }],
            { prData, settings }   // no llmRefutation
        );

        expect(llm.streamChat).not.toHaveBeenCalled();
        expect(stats.llmRefutation).toBe(false);
        expect(usage).toEqual({ input: 0, output: 0 });
        // A high-confidence refutation the model WOULD have returned must not
        // apply when the model was never consulted.
        expect(findings).toHaveLength(1);
    });

    it('still runs the deterministic gates with the refuter off', async () => {
        const llm = mockLLM([]);
        const svc = new FindingVerificationService({ llmService: llm });

        // Line 99 does not exist in this file's diff — the evidence gate refutes
        // it mechanically, with no model involved.
        const { findings, dropped, stats } = await svc.verify(
            [{ file: 'a.py', line: 99, severity: 'high', title: 'phantom' }],
            {
                prData: {
                    title: 'PR',
                    files: [{ filename: 'a.py', patch: '@@ -1,1 +1,2 @@\n a = 1\n+b = 2' }],
                },
                settings,
            }
        );

        expect(llm.streamChat).not.toHaveBeenCalled();
        expect(findings).toHaveLength(0);
        expect(dropped).toHaveLength(1);
        expect(stats.evidenceRefuted).toBe(1);
    });

    it('reports which mode ran, so a review can be attributed', async () => {
        const llm = mockLLM([{ vid: 'V0', keep: true, confidence: 0.9 }]);
        const svc = new FindingVerificationService({ llmService: llm });

        const { stats } = await svc.verify(
            [{ file: 'a.py', line: 1, severity: 'high', title: 't' }],
            { prData, settings, llmRefutation: true }
        );

        expect(stats.llmRefutation).toBe(true);
        expect(llm.streamChat).toHaveBeenCalled();
    });
});

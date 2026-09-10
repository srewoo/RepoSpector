/**
 * P2-2 — the second runtime-neutral slice.
 *
 * `findingPipeline` decides what a reviewer will SEE; this decides what
 * survives being argued with. Same extraction shape: findings in, findings out,
 * every collaborator injected.
 *
 * The property worth most of these tests is the one a refactor loses quietly:
 * both stages FAIL OPEN. A citation enforcer that throws, or a verifier whose
 * model is unreachable, must return the candidates unchanged. An empty list
 * from a broken defence stage is indistinguishable from a clean review, which
 * is the exact failure the completeness contract exists to prevent.
 */
const { defendCandidates } = require('../../src/services/candidateDefence.js');

const finding = (over = {}) => ({
    file: 'src/a.js', line: 10, severity: 'high', title: 'a defect', ...over,
});

const citations = (findings) => ({
    findings: findings.map((f) => ({ ...f, rule: f.rule ?? 'inferred/rule' })),
    stats: { inferred: findings.length },
});

describe('the slice is driven entirely by injected adapters', () => {
    it('runs with no adapters at all and changes nothing', async () => {
        const input = [finding()];
        const out = await defendCandidates(input, {}, {});
        expect(out.findings).toEqual(input);
        expect(out.stats).toEqual({ citation: null, verification: null, scoring: null });
    });

    it('imports nothing and touches no browser API', async () => {
        const source = require('node:fs').readFileSync(
            require.resolve('../../src/services/candidateDefence.js'), 'utf8',
        );
        expect(source).not.toMatch(/^import /m);
        expect(source).not.toMatch(/\bchrome\./);
        expect(source).not.toMatch(/\bfetch\(/);
    });

    it('runs the stages in order', async () => {
        const order = [];
        await defendCandidates([finding()], {
            enforceCitations: (f) => { order.push('citations'); return citations(f); },
            verifier: { verify: async (f) => { order.push('verify'); return { findings: f, dropped: [], stats: {}, usage: {} }; } },
            scorer: { score: async (f) => { order.push('score'); return { findings: f, stats: {}, usage: {} }; } },
        }, {});
        expect(order).toEqual(['citations', 'verify', 'score']);
    });

    it('accumulates token usage across the stages that spent it', async () => {
        const out = await defendCandidates([finding()], {
            verifier: { verify: async (f) => ({ findings: f, dropped: [], stats: {}, usage: { input: 10, output: 5 } }) },
            scorer: { score: async (f) => ({ findings: f, stats: {}, usage: { input: 3, output: 2 } }) },
        }, {});
        expect(out.usage).toEqual({ input: 13, output: 7 });
    });
});

describe('every stage fails OPEN', () => {
    const boom = new Error('model unreachable');

    it('a citation enforcer that throws keeps the candidates', async () => {
        const stages = [];
        const out = await defendCandidates([finding(), finding({ title: 'b' })], {
            enforceCitations: () => { throw boom; },
            onStageError: (stage) => stages.push(stage),
        }, {});

        expect(out.findings).toHaveLength(2);
        expect(stages).toEqual(['citations']);
        // Reported as "did not run", never as "found nothing".
        expect(out.stats.citation).toBeNull();
    });

    it('a verifier that throws keeps the candidates rather than emptying them', async () => {
        // The dangerous one: an empty list here reads downstream as a clean
        // review of code nothing actually checked.
        const out = await defendCandidates([finding(), finding({ title: 'b' })], {
            verifier: { verify: async () => { throw boom; } },
        }, {});

        expect(out.findings).toHaveLength(2);
        expect(out.stats.verification).toBeNull();
    });

    it('a scorer that throws degrades ordering, never deletes a finding', async () => {
        const out = await defendCandidates([finding()], {
            scorer: { score: async () => { throw boom; } },
        }, {});
        expect(out.findings).toHaveLength(1);
        expect(out.stats.scoring).toBeNull();
    });

    it('names the stage that failed, so an outage is explainable', async () => {
        const seen = [];
        await defendCandidates([finding()], {
            enforceCitations: () => { throw boom; },
            verifier: { verify: async () => { throw boom; } },
            scorer: { score: async () => { throw boom; } },
            onStageError: (stage, error) => seen.push([stage, error.message]),
        }, {});
        expect(seen.map((s) => s[0])).toEqual(['citations', 'verification', 'scoring']);
        expect(seen[0][1]).toBe('model unreachable');
    });
});

describe('what each stage contributes', () => {
    it('citations give every finding a rule it can be argued with', async () => {
        const out = await defendCandidates([finding()], { enforceCitations: citations }, {});
        expect(out.findings[0].rule).toBe('inferred/rule');
        expect(out.stats.citation).toEqual({ inferred: 1 });
    });

    it('verification drops are carried out, not lost', async () => {
        const out = await defendCandidates([finding(), finding({ title: 'unproven' })], {
            verifier: {
                verify: async (f) => ({
                    findings: f.slice(0, 1),
                    dropped: f.slice(1).map((x) => ({ ...x, _drop: { reason: 'cited line absent' } })),
                    stats: { kept: 1, dropped: 1 },
                    usage: {},
                }),
            },
        }, {});

        expect(out.findings).toHaveLength(1);
        expect(out.dropped[0]._drop.reason).toBe('cited line absent');
    });

    it('passes the file bodies through, so citations are checked against source', async () => {
        // P1-2 depends on this reaching the verifier; dropping it here would
        // silently return the check to diff-only.
        let received = null;
        const fileContext = new Map([['src/a.js', { fullContent: 'x' }]]);
        await defendCandidates([finding()], {
            verifier: { verify: async (f, opts) => { received = opts; return { findings: f, dropped: [], stats: {}, usage: {} }; } },
        }, { fileContext, prData: { files: [] }, settings: { model: 'm' } });

        expect(received.fileContext).toBe(fileContext);
        expect(received.settings).toEqual({ model: 'm' });
    });

    it('skips the model-backed stages entirely when there is nothing to defend', async () => {
        const verify = jest.fn();
        const score = jest.fn();
        const out = await defendCandidates([], {
            verifier: { verify }, scorer: { score },
        }, {});
        expect(verify).not.toHaveBeenCalled();
        expect(score).not.toHaveBeenCalled();
        expect(out.findings).toEqual([]);
    });
});

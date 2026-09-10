/**
 * P2-2 — the first runtime-neutral slice extracted behind the seam.
 *
 * The plan is explicit that a big-bang extraction of the review handler is the
 * riskiest refactor available, and that the completeness contract should become
 * the seam instead. That seam landed with P0-1; this is the first increment
 * behind it.
 *
 * What these tests pin is the property that makes the extraction worth doing:
 * every gate, scanner and validator is INJECTED, so the pipeline can be
 * exercised — and shared by another runtime — with no browser, no chrome APIs,
 * no fetch and no storage anywhere in the call.
 */
const { runFindingPipeline } = require('../../src/services/findingPipeline.js');

const finding = (over = {}) => ({
    file: 'src/a.js', line: 10, severity: 'high', title: 'a defect', ...over,
});

/** Adapters that do nothing, so a test can add back only what it is about. */
const passthroughGate = (findings) => ({ findings, dropped: [], stats: { kept: findings.length, dropped: 0 } });
const passthroughScope = (findings) => ({ kept: findings, dropped: [], stats: { mode: 'added', kept: findings.length } });
const passthroughAdmit = (findings, kind) => ({
    admitted: findings, rejected: [], stats: { kind, admitted: findings.length, rejected: 0 },
});

describe('the pipeline is driven entirely by injected adapters', () => {
    it('runs with no adapters at all and changes nothing', async () => {
        const input = [finding()];
        const out = await runFindingPipeline(input, {}, {});
        expect(out.findings).toEqual(input);
        expect(out.stats).toEqual({ precision: null, admission: [], validation: null, scope: null });
    });

    it('applies the gate it was given, not one it imported', async () => {
        const out = await runFindingPipeline([finding(), finding({ title: 'noise' })], {
            precisionGate: (findings) => ({
                findings: findings.filter((f) => f.title !== 'noise'),
                dropped: findings.filter((f) => f.title === 'noise').map((f) => ({ ...f, _precisionDrop: 'noise' })),
                stats: { kept: 1, dropped: 1, input: 2 },
            }),
        }, {});

        expect(out.findings).toHaveLength(1);
        expect(out.dropped[0]._precisionDrop).toBe('noise');
        expect(out.stats.precision).toMatchObject({ kept: 1, dropped: 1 });
    });

    it('runs the stages in the shipped order', async () => {
        const order = [];
        await runFindingPipeline([finding()], {
            precisionGate: (f) => { order.push('gate'); return passthroughGate(f); },
            admit: (f, k) => { order.push(`admit:${k}`); return passthroughAdmit(f, k); },
            validator: { validate: async (f) => { order.push('validate'); return { findings: f, stats: {} }; } },
            scope: (f) => { order.push('scope'); return passthroughScope(f); },
        }, {
            external: [finding({ file: 'x.js', ruleId: 'r1' })],
            graph: [finding({ file: 'y.js', rule: 'graph/x' })],
        });

        expect(order).toEqual(['gate', 'admit:scanner', 'admit:graph', 'validate', 'scope']);
    });

    it('touches no browser API — it is findings in, findings out', async () => {
        // The property that makes this slice shareable. If a future edit reaches
        // for chrome or fetch here, this fails rather than the API worker.
        const source = require('node:fs').readFileSync(
            require.resolve('../../src/services/findingPipeline.js'), 'utf8',
        );
        expect(source).not.toMatch(/\bchrome\./);
        expect(source).not.toMatch(/\bfetch\(/);
        expect(source).not.toMatch(/localStorage|indexedDB/);
        // And it imports nothing: every dependency arrives as an adapter.
        expect(source).not.toMatch(/^import /m);
    });
});

describe('deterministic admission through the pipeline', () => {
    it('admits each source separately and records each stat', async () => {
        const out = await runFindingPipeline([], {
            admit: passthroughAdmit,
        }, {
            external: [finding({ file: 'x.js', ruleId: 'r1' })],
            graph: [finding({ file: 'y.js', rule: 'graph/x' })],
            missingTests: [finding({ file: 'z.js', rule: 'static/missing-test' })],
        });

        expect(out.findings).toHaveLength(3);
        expect(out.stats.admission.map((s) => s.kind))
            .toEqual(['scanner', 'graph', 'missing-test']);
    });

    it('does not re-add a finding already present', async () => {
        const existing = finding({ file: 'x.js', ruleId: 'r1' });
        const out = await runFindingPipeline([existing], { admit: passthroughAdmit }, {
            external: [{ ...existing }],
        });
        expect(out.findings).toHaveLength(1);
        expect(out.stats.admission).toHaveLength(0);
    });

    it('carries a rejected admission into dropped rather than losing it', async () => {
        const out = await runFindingPipeline([], {
            admit: (findings, kind) => ({
                admitted: [], rejected: findings.map((f) => ({ ...f, _admissionDrop: 'no rule id' })),
                stats: { kind, admitted: 0, rejected: findings.length },
            }),
        }, { external: [finding({ file: 'x.js' })] });

        expect(out.findings).toHaveLength(0);
        expect(out.dropped[0]._admissionDrop).toBe('no rule id');
    });
});

describe('validation is optional in both directions', () => {
    it('absent, findings pass through unvalidated', async () => {
        const out = await runFindingPipeline([finding()], { scope: passthroughScope }, {});
        expect(out.findings).toHaveLength(1);
        expect(out.stats.validation).toBeNull();
    });

    it('a refuted candidate is withheld and recorded', async () => {
        const out = await runFindingPipeline([finding(), finding({ title: 'wrong' })], {
            validator: {
                validate: async (findings) => ({
                    findings: findings.map((f) => ({
                        ...f,
                        validation: { status: f.title === 'wrong' ? 'refuted' : 'confirmed' },
                    })),
                    stats: { confirmed: 1, refuted: 1, unresolved: 0 },
                }),
            },
        }, {});

        expect(out.findings).toHaveLength(1);
        expect(out.dropped[0]._precisionDrop).toBe('refuted-by-validation');
        expect(out.stats.validation).toMatchObject({ refuted: 1 });
    });

    it('an UNRESOLVED candidate is kept, carrying the record that says so', async () => {
        // The distinction the whole stage rests on: unresolved is not refuted,
        // and an unavailable check must never silently remove a finding.
        const out = await runFindingPipeline([finding()], {
            validator: {
                validate: async (findings) => ({
                    findings: findings.map((f) => ({ ...f, validation: { status: 'unresolved' } })),
                    stats: { confirmed: 0, refuted: 0, unresolved: 1 },
                }),
            },
        }, {});

        expect(out.findings).toHaveLength(1);
        expect(out.findings[0].validation.status).toBe('unresolved');
        expect(out.dropped).toHaveLength(0);
    });
});

describe('candidates are captured before suppression', () => {
    it('exports the pre-gate set, so a rescued bug is still reachable', async () => {
        const out = await runFindingPipeline([finding(), finding({ title: 'low value' })], {
            precisionGate: (findings) => ({
                findings: findings.slice(0, 1),
                dropped: findings.slice(1),
                stats: { kept: 1, dropped: 1 },
            }),
        }, {});

        expect(out.findings).toHaveLength(1);
        // P1-8 depends on this: a bug deleted for scoring 6 cannot be rescued
        // by a verifier that never sees it.
        expect(out.preSuppressionCandidates).toHaveLength(2);
    });
});

describe('the extracted slice is exported for other runtimes', () => {
    it('review-core re-exports it', () => {
        const fs = require('node:fs');
        const index = fs.readFileSync(
            require.resolve('../../packages/review-core/src/index.js'), 'utf8',
        );
        expect(index).toContain('runFindingPipeline');
        const shim = fs.readFileSync(
            require.resolve('../../packages/review-core/src/findingPipeline.js'), 'utf8',
        );
        expect(shim).toContain('src/services/findingPipeline.js');
    });
});

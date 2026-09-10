/**
 * P1-7 — benchmark the actual final output, separately per product path.
 *
 * The harness produced one precision figure and one recall figure. Neither is
 * the number a release decision needs, and three of the failures are structural
 * rather than a matter of tuning:
 *
 *   - Pooling results across product paths averages three different reviewers.
 *   - Recall against all human comments scores a defect-only policy as missing
 *     every style comment ever written.
 *   - "Precision improved" cannot be checked against "and it cost N real
 *     defects" unless every stage records what it removed.
 */
const {
    buildBenchmarkReport,
    formatBenchmarkReport,
    classifyReference,
    isCleanCase,
} = require('../../eval/lib/benchmarkReport.js');
const {
    PRODUCT_PATH,
    requireSinglePath,
    normalizeProductPath,
    describeHostAgent,
} = require('../../eval/lib/productPaths.js');
const {
    createRetention,
    recordStage,
    scoreRetention,
} = require('../../eval/lib/retention.js');
const { buildManifest, diffManifests, describeManifestDiff } = require('../../eval/lib/manifest.js');
const { categoriesOf, coverageOf, CATEGORIES } = require('../../eval/lib/caseCategories.js');
const { predictionId } = require('../../eval/lib/ids.js');

const kase = (over = {}) => ({
    id: 'mr-1',
    productPath: PRODUCT_PATH.EXTENSION,
    predictions: [],
    adjudications: [],
    humanComments: [],
    ...over,
});

describe('product paths are never pooled', () => {
    it('accepts a corpus that is all one path', () => {
        expect(requireSinglePath([kase(), kase({ id: 'mr-2' })])).toBe(PRODUCT_PATH.EXTENSION);
    });

    it('refuses to average two different reviewers', () => {
        expect(() => requireSinglePath([kase(), kase({ id: 'x', productPath: PRODUCT_PATH.API })]))
            .toThrow(/Refusing to pool/);
    });

    it('defaults an unknown path to the extension rather than inventing one', () => {
        expect(normalizeProductPath('nonsense')).toBe(PRODUCT_PATH.EXTENSION);
        expect(normalizeProductPath('mcp-host')).toBe(PRODUCT_PATH.MCP_HOST);
    });

    it('an mcp-host figure without a named agent is marked unreproducible', () => {
        expect(describeHostAgent({ productPath: PRODUCT_PATH.MCP_HOST }))
            .toMatch(/NOT RECORDED/);
        expect(describeHostAgent({
            productPath: PRODUCT_PATH.MCP_HOST,
            hostAgent: { name: 'claude-code', model: 'opus-5' },
        })).toMatch(/claude-code.*opus-5/);
    });

    it('names the agent nowhere else — it is only part of the MCP path', () => {
        expect(describeHostAgent({ productPath: PRODUCT_PATH.EXTENSION, hostAgent: { name: 'x' } }))
            .toBeNull();
    });
});

describe('defect recall is separated from design/style agreement', () => {
    it('classifies a functional complaint as a defect', () => {
        expect(classifyReference({ body: 'this throws on an empty list' })).toBe('defect');
    });

    it('classifies a preference as design/style', () => {
        expect(classifyReference({ body: 'please rename this variable' })).toBe('design-style');
        expect(classifyReference({ body: 'nit: formatting', tagGroup: 'style' })).toBe('design-style');
    });

    it('an explicit tagGroup wins over the classifier', () => {
        expect(classifyReference({ body: 'this crashes', tagGroup: 'style' })).toBe('design-style');
        expect(classifyReference({ body: 'rename this', tagGroup: 'correctness' })).toBe('defect');
    });

    it('a defect-only reviewer is not scored as missing every style comment', () => {
        const report = buildBenchmarkReport([kase({
            predictions: [{ file: 'a.js', line: 10, title: 'throws on empty' }],
            humanComments: [
                { file: 'a.js', line: 10, body: 'this throws on empty input' },
                { file: 'a.js', line: 40, body: 'please rename this variable' },
                { file: 'a.js', line: 60, body: 'reorder these imports' },
            ],
        })]);

        // Old behaviour would have reported 1/3 = 33%.
        expect(report.defectRecall).toMatchObject({ matched: 1, reference: 1 });
        expect(report.defectRecall.rate).toBe(1);
        expect(report.designStyleAgreement).toMatchObject({ matched: 0, reference: 2 });
    });
});

describe('inline precision is reported apart from everything reported', () => {
    const inline = { file: 'a.js', line: 10, title: 'real', posted: true };
    const summary = { file: 'a.js', line: 50, title: 'weak', posted: false };

    it('scores the two sets separately', () => {
        const report = buildBenchmarkReport([kase({
            predictions: [inline, summary],
            adjudications: [
                { predictionId: predictionId({ file: 'mr-1::a.js', line: 10, title: 'real' }), verdict: 'true_positive' },
                { predictionId: predictionId({ file: 'mr-1::a.js', line: 50, title: 'weak' }), verdict: 'false_positive' },
            ],
        })]);

        expect(report.inlinePrecision.adjudicated).toBe(1);
        expect(report.inlinePrecision.rate).toBe(1);
        expect(report.reportedPrecision.adjudicated).toBe(2);
        expect(report.reportedPrecision.rate).toBe(0.5);
    });
});

describe('clean PRs and incompleteness get their own numbers', () => {
    it('a PR with no reference defect is clean, and its findings are a cost', () => {
        const clean = kase({ id: 'clean', predictions: [{ file: 'a.js', line: 1 }, { file: 'b.js', line: 2 }] });
        expect(isCleanCase(clean)).toBe(true);

        const report = buildBenchmarkReport([clean]);
        expect(report.cleanCases).toBe(1);
        expect(report.falsePositivesPerCleanCase).toBe(2);
    });

    it('a PR whose only human comments are style is still clean for defect purposes', () => {
        expect(isCleanCase(kase({ humanComments: [{ file: 'a.js', line: 1, body: 'rename this' }] })))
            .toBe(true);
    });

    it('an explicit `clean` flag wins over inference', () => {
        expect(isCleanCase({ clean: false, humanComments: [] })).toBe(false);
    });

    it('a run that could not read the change is counted, not folded in', () => {
        const report = buildBenchmarkReport([
            kase({ id: 'a', incomplete: true }),
            kase({ id: 'b' }),
        ]);
        expect(report.incompleteCases).toBe(1);
        expect(report.incompletenessRate).toBe(0.5);
    });
});

describe('stage retention makes the cost of a precision change visible', () => {
    const a = { file: 'a.js', line: 1, title: 'real defect' };
    const b = { file: 'b.js', line: 2, title: 'noise' };

    it('records what each stage removed', () => {
        const r = createRetention();
        recordStage(r, 'precision-gate', [a, b], [a]);
        expect(r.stages[0]).toMatchObject({ stage: 'precision-gate', in: 2, out: 1, droppedCount: 1 });
        expect(r.stages[0].dropped[0].file).toBe('b.js');
    });

    it('counts additions separately so a re-add cannot hide a removal', () => {
        const c = { file: 'c.js', line: 3, title: 'scanner match' };
        const r = createRetention();
        recordStage(r, 'deterministic-admission', [a, b], [a, c]);
        expect(r.stages[0]).toMatchObject({ droppedCount: 1, added: 1 });
    });

    it('attributes drops to human verdicts once they exist', () => {
        const r = createRetention();
        recordStage(r, 'precision-gate', [a, b], []);
        const scored = scoreRetention(r, [
            { predictionId: predictionId(a), verdict: 'true_positive' },
            { predictionId: predictionId(b), verdict: 'false_positive' },
        ]);
        expect(scored[0]).toMatchObject({ trueDropped: 1, falseDropped: 1, unknownDropped: 0 });
    });

    it('an unjudged drop is unknown, never counted as a correct suppression', () => {
        const r = createRetention();
        recordStage(r, 'precision-gate', [a], []);
        expect(scoreRetention(r, [])[0]).toMatchObject({ trueDropped: 0, unknownDropped: 1 });
    });

    it('carries the drop reason a stage recorded', () => {
        const r = createRetention();
        recordStage(r, 'precision-gate', [{ ...b, _precisionDrop: 'review-commentary' }], []);
        expect(r.stages[0].dropped[0].reason).toBe('review-commentary');
    });
});

describe('a run records what it was', () => {
    it('captures the flags that change what a review says', () => {
        const m = buildManifest({
            model: 'gpt-4o',
            opts: { precisionGate: true, contextProfile: 'legacy', theme: 'dark' },
        });
        expect(m.flags).toMatchObject({ precisionGate: true, contextProfile: 'legacy' });
        // Not a flag that changes review output.
        expect(m.flags.theme).toBeUndefined();
        expect(m.pipelineVersion).toBeGreaterThan(0);
    });

    it('states the confounds between two runs rather than implying there are none', () => {
        const before = buildManifest({ model: 'gpt-4o', opts: { precisionGate: true } });
        const after = buildManifest({ model: 'claude-sonnet-5', opts: { precisionGate: false } });
        const diffs = diffManifests(before, after);

        expect(diffs.map((d) => d.key)).toEqual(
            expect.arrayContaining(['model', 'flags.precisionGate']),
        );
        expect(describeManifestDiff(diffs)).toMatch(/may be attributable to these/);
    });

    it('says so plainly when two runs are comparable', () => {
        const m = buildManifest({ model: 'gpt-4o', opts: {} });
        expect(describeManifestDiff(diffManifests(m, m))).toMatch(/no recorded input differs/);
    });
});

describe('the corpus states what it does not cover', () => {
    it('detects a clean case and a multi-file case', () => {
        expect(categoriesOf({ humanComments: [] })).toContain(CATEGORIES.CLEAN);
        expect(categoriesOf({
            humanComments: [{ file: 'a', body: 'x' }],
            prData: { files: Array.from({ length: 6 }, (_, i) => ({ filename: `f${i}.js` })) },
        })).toContain(CATEGORIES.MULTI_FILE);
    });

    it('detects a deletion-only change', () => {
        expect(categoriesOf({
            humanComments: [{ file: 'a', body: 'x' }],
            prData: { files: [{ filename: 'a.js', patch: '@@ -1,2 +1,0 @@\n-a\n-b' }] },
        })).toContain(CATEGORIES.DELETIONS);
    });

    it('an explicit categories array wins over inference', () => {
        expect(categoriesOf({ categories: ['malformed-provider-output'], humanComments: [] }))
            .toEqual(['malformed-provider-output']);
    });

    it('names every shape the corpus lacks', () => {
        const coverage = coverageOf([{ humanComments: [] }]);
        expect(coverage.present[CATEGORIES.CLEAN]).toBe(1);
        expect(coverage.missing).toContain(CATEGORIES.MALFORMED_PROVIDER);
        expect(coverage.missing).toContain(CATEGORIES.INCOMPLETE_REPO);
    });
});

describe('the rendered report', () => {
    it('states its scope, its intervals and what it cannot say', () => {
        const text = formatBenchmarkReport(buildBenchmarkReport([
            kase({ predictions: [{ file: 'a.js', line: 1, posted: true }] }),
        ], { manifest: buildManifest({ model: 'gpt-4o', opts: { precisionGate: true } }) }));

        expect(text).toMatch(/Product path:\s+extension/);
        expect(text).toMatch(/Inline precision/);
        expect(text).toMatch(/Reported precision/);
        expect(text).toMatch(/Defect recall/);
        expect(text).toMatch(/Design\/style/);
        expect(text).toMatch(/finding\(s\) per clean PR/);
        expect(text).toMatch(/Incompleteness/);
        expect(text).toMatch(/gate on the LOWER BOUND/);
        expect(text).toMatch(/shape\(s\) are ABSENT/);
    });
});

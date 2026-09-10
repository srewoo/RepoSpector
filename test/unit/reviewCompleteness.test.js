/**
 * P0-1 — review completeness governs every verdict.
 *
 * The defect this covers: zero findings because nothing was wrong and zero
 * findings because nothing was READ were the same value at every layer, and
 * the second one shipped as APPROVED. These tests pin the contract itself, its
 * production of failure evidence in each engine, and the one rule that matters
 * — an incomplete run may request changes but may never approve.
 */
const {
    createCompleteness,
    mergeCompleteness,
    completenessReasons,
    isComplete,
    describeCompleteness,
    governVerdict,
    INCOMPLETE_VERDICT,
} = require('../../src/utils/reviewCompleteness.js');

describe('the completeness contract', () => {
    it('a run with nothing missing is complete', () => {
        const c = createCompleteness({ expectedUnits: 3, inspectedUnits: 3 });
        expect(isComplete(c)).toBe(true);
        expect(completenessReasons(c)).toEqual([]);
        expect(describeCompleteness(c)).toBe('');
    });

    it('counts a parse failure, a failed unit and an uninspected unit separately', () => {
        const c = createCompleteness({
            expectedUnits: 4,
            inspectedUnits: 2,
            parseFailures: 1,
            failedUnits: ['a.js'],
        });
        expect(isComplete(c)).toBe(false);
        expect(completenessReasons(c)).toHaveLength(3);
    });

    it('merges contracts from several chunks without losing any of them', () => {
        const merged = mergeCompleteness(
            { expectedUnits: 2, inspectedUnits: 2 },
            { expectedUnits: 2, inspectedUnits: 1, parseFailures: 1 },
            { failedUnits: [{ unit: 'c.js', reason: 'chunk-failed', error: 'timeout' }] },
        );
        expect(merged.expectedUnits).toBe(4);
        expect(merged.inspectedUnits).toBe(3);
        expect(merged.parseFailures).toBe(1);
        expect(merged.failedUnits).toHaveLength(1);
    });

    it('does not report an undeclared expected count as a shortfall', () => {
        // An engine that cannot count its own units is not thereby incomplete.
        expect(isComplete(createCompleteness({ inspectedUnits: 0 }))).toBe(true);
    });

    it('an optional unavailable check does not make the run incomplete', () => {
        const c = createCompleteness({
            unavailableChecks: [{ name: 'semgrep', reason: 'not installed', required: false }],
        });
        expect(isComplete(c)).toBe(true);
    });

    it('an advisory omission is recorded but does not withdraw approval', () => {
        const c = createCompleteness({
            omissions: [{ kind: 'removals-only', detail: 'stripped', advisory: true }],
        });
        expect(c.omissions[0].advisory).toBe(true);
        expect(isComplete(c)).toBe(true);
    });

    it('malformed input cannot erase completeness information', () => {
        expect(() => createCompleteness(null)).not.toThrow();
        expect(createCompleteness('nonsense').parseFailures).toBe(0);
        expect(createCompleteness({ failedUnits: 'not-an-array' }).failedUnits).toEqual([]);
    });
});

describe('only a complete run may approve', () => {
    const incomplete = createCompleteness({ parseFailures: 1 });

    it('withdraws an approval verdict and its host event', () => {
        const out = governVerdict({ verdict: 'APPROVED', reviewEvent: 'APPROVE' }, incomplete);
        expect(out.verdict).toBe(INCOMPLETE_VERDICT);
        expect(out.reviewEvent).toBe('COMMENT');
        expect(out.downgraded).toBe(true);
        expect(out.reasons.join(' ')).toMatch(/could not be parsed/);
    });

    it('leaves a blocking outcome alone — a defect in code that WAS read stays a defect', () => {
        const out = governVerdict(
            { verdict: 'CHANGES_REQUESTED', reviewEvent: 'REQUEST_CHANGES' },
            incomplete,
        );
        expect(out.verdict).toBe('CHANGES_REQUESTED');
        expect(out.reviewEvent).toBe('REQUEST_CHANGES');
        expect(out.downgraded).toBe(false);
        expect(out.reasons.length).toBeGreaterThan(0);
    });

    it('leaves a complete run untouched', () => {
        const out = governVerdict({ verdict: 'APPROVED', reviewEvent: 'APPROVE' }, null);
        expect(out.verdict).toBe('APPROVED');
        expect(out.reviewEvent).toBe('APPROVE');
        expect(out.downgraded).toBe(false);
    });

    it('an event-only approval is caught even when the verdict string differs', () => {
        expect(governVerdict({ verdict: 'CLEAN', reviewEvent: 'APPROVE' }, incomplete).verdict)
            .toBe(INCOMPLETE_VERDICT);
    });
});

describe('buildVerdictReport applies the rule centrally', () => {
    const { buildVerdictReport, VERDICT } = require('../../src/services/reviewSchema.js');

    it('an empty finding set from an incomplete run is not an APPROVE', () => {
        const report = buildVerdictReport({
            findings: [],
            completeness: { parseFailures: 2 },
        });
        expect(report.verdict).toBe(VERDICT.INCOMPLETE);
        expect(report.meta.incomplete).toBe(true);
        expect(report.meta.verdictDowngradedForIncompleteness).toBe(true);
        expect(report.meta.incompleteReasons).toHaveLength(1);
    });

    it('an empty finding set from a complete run still approves', () => {
        const report = buildVerdictReport({ findings: [], completeness: { expectedUnits: 1, inspectedUnits: 1 } });
        expect(report.verdict).toBe(VERDICT.APPROVE);
        expect(report.meta.incomplete).toBe(false);
    });

    it('a blocking finding still blocks when the run was incomplete', () => {
        const report = buildVerdictReport({
            findings: [{ severity: 'critical', file: 'a.js', line: 3, title: 'auth bypass' }],
            completeness: { failedUnits: ['b.js'] },
        });
        expect(report.verdict).toBe(VERDICT.BLOCK);
        expect(report.meta.incomplete).toBe(true);
    });

    it('reads the contract from meta when not passed explicitly', () => {
        const report = buildVerdictReport({ findings: [], meta: { completeness: { parseFailures: 1 } } });
        expect(report.verdict).toBe(VERDICT.INCOMPLETE);
    });
});

describe('MultiPassReviewEngine emits the contract', () => {
    const { MultiPassReviewEngine } = require('../../src/services/MultiPassReviewEngine.js');

    const prData = {
        files: [{ filename: 'a.js', patch: '@@ -1,1 +1,2 @@\n a\n+b', additions: 1, deletions: 0 }],
    };
    const settings = { model: 'openai:gpt-4o', apiKey: 'x' };

    it('an unparseable per-file response produces an incomplete contract', async () => {
        const llm = {
            streamChat: jest.fn().mockResolvedValue({
                content: 'Sorry, here is prose and no JSON.',
                usage: { input: 1, output: 1 },
            }),
        };
        const res = await new MultiPassReviewEngine({ llmService: llm })
            .execute(prData, {}, settings, {}, null);

        expect(res.stats.parseFailures).toBe(1);
        expect(res.completeness.parseFailures).toBe(1);
        expect(isComplete(res.completeness)).toBe(false);
    });

    it('a clean parseable review produces a complete contract', async () => {
        const llm = {
            streamChat: jest.fn().mockResolvedValue({
                content: JSON.stringify({ findings: [], summary: 'ok' }),
                usage: { input: 1, output: 1 },
            }),
        };
        const res = await new MultiPassReviewEngine({ llmService: llm })
            .execute(prData, {}, settings, {}, null);

        expect(res.completeness.parseFailures).toBe(0);
        expect(isComplete(res.completeness)).toBe(true);
    });
});

describe('ReviewOrchestrator no longer loses the engine contract', () => {
    const { ReviewOrchestrator } = require('../../src/services/ReviewOrchestrator.js');
    const { VERDICT } = require('../../src/services/reviewSchema.js');

    const prData = {
        state: 'open',
        isDraft: false,
        mergeable: true,
        stats: { additions: 1, deletions: 0 },
        files: [{ filename: 'a.js', patch: '@@ -1,1 +1,2 @@\n a\n+b', additions: 1, deletions: 0 }],
        author: { login: 'someone' },
        title: 'change',
    };

    it('propagates parseFailures the adapter used to drop, and refuses to approve', async () => {
        const engine = {
            execute: jest.fn().mockResolvedValue({
                analysis: '',
                perFileFindings: [],
                failedFiles: [],
                stats: { parseFailures: 1 },
                completeness: createCompleteness({ expectedUnits: 1, inspectedUnits: 0, parseFailures: 1 }),
            }),
        };
        const report = await new ReviewOrchestrator({ multiPassEngine: engine }).review(prData);

        expect(report.meta.completeness.parseFailures).toBe(1);
        expect(report.verdict).toBe(VERDICT.INCOMPLETE);
    });

    it('a chunk that throws leaves every one of its files recorded as uninspected', async () => {
        const engine = { execute: jest.fn().mockRejectedValue(new Error('Timed out after 240s')) };
        const report = await new ReviewOrchestrator({ multiPassEngine: engine }).review(prData);

        expect(report.meta.completeness.failedUnits).toHaveLength(1);
        expect(report.meta.completeness.failedUnits[0].error).toMatch(/Timed out/);
        expect(report.verdict).toBe(VERDICT.INCOMPLETE);
    });

    it('a legacy engine with no contract is still judged on failedFiles', async () => {
        const engine = {
            execute: jest.fn().mockResolvedValue({
                analysis: '', perFileFindings: [], failedFiles: ['a.js'],
            }),
        };
        const report = await new ReviewOrchestrator({ multiPassEngine: engine }).review(prData);
        expect(report.verdict).toBe(VERDICT.INCOMPLETE);
    });

    it('a genuinely clean complete run still approves', async () => {
        const engine = {
            execute: jest.fn().mockResolvedValue({
                analysis: 'looks fine',
                perFileFindings: [],
                failedFiles: [],
                completeness: createCompleteness({ expectedUnits: 1, inspectedUnits: 1 }),
            }),
        };
        const report = await new ReviewOrchestrator({ multiPassEngine: engine }).review(prData);
        expect(report.verdict).toBe(VERDICT.APPROVE);
        expect(report.meta.incomplete).toBe(false);
    });

    it('preserves valid findings produced by the units that DID succeed', async () => {
        const twoFiles = {
            ...prData,
            files: [
                prData.files[0],
                { filename: 'b.js', patch: '@@ -1,1 +1,2 @@\n a\n+c', additions: 1, deletions: 0 },
            ],
        };
        const engine = {
            execute: jest.fn().mockResolvedValue({
                analysis: '',
                perFileFindings: [{
                    file: 'a.js',
                    findings: [{ severity: 'high', file: 'a.js', line: 2, title: 'real bug', suggestion: 'fix it' }],
                }],
                failedFiles: ['b.js'],
                completeness: createCompleteness({
                    expectedUnits: 2, inspectedUnits: 1, failedUnits: ['b.js'],
                }),
            }),
        };
        const report = await new ReviewOrchestrator({ multiPassEngine: engine }).review(twoFiles);

        expect(report.findings.length).toBeGreaterThan(0);
        expect(report.verdict).toBe(VERDICT.BLOCK);
        expect(report.meta.completeness.failedUnits).toHaveLength(1);
    });
});

describe('when EVERY chunk fails, not just one', () => {
    const { ReviewOrchestrator } = require('../../src/services/ReviewOrchestrator.js');
    const { VERDICT } = require('../../src/services/reviewSchema.js');

    /**
     * Past `chunkingThresholdFiles` (20), so the orchestrator really does fan
     * out — a single-chunk fixture cannot exercise "ALL chunks failed" at all.
     */
    const FILES = 24;
    const bigPr = {
        state: 'open', isDraft: false, mergeable: true,
        stats: { additions: FILES * 5, deletions: 0 },
        author: { login: 'someone' }, title: 'change',
        files: Array.from({ length: FILES }, (_, i) => ({
            filename: `src/f${i}.js`,
            patch: `@@ -1,1 +1,6 @@\n a\n${Array.from({ length: 5 }, (_, j) => `+line${j}`).join('\n')}`,
            additions: 5, deletions: 0,
        })),
    };

    it('a total timeout produces no findings AND no approval', async () => {
        // The dangerous shape: every unit failed, so the finding count is zero
        // — which is byte-for-byte what a clean review returns.
        const engine = { execute: jest.fn().mockRejectedValue(new Error('Timed out after 240s')) };
        const report = await new ReviewOrchestrator({ multiPassEngine: engine }).review(bigPr);

        expect(report.findings).toHaveLength(0);
        expect(report.verdict).toBe(VERDICT.INCOMPLETE);
        expect(report.verdict).not.toBe(VERDICT.APPROVE);
    });

    it('records every file as uninspected, not just the first', async () => {
        const engine = { execute: jest.fn().mockRejectedValue(new Error('Timed out after 240s')) };
        const report = await new ReviewOrchestrator({ multiPassEngine: engine }).review(bigPr);

        const failed = report.meta.completeness.failedUnits.map((f) => f.unit);
        for (const file of bigPr.files) expect(failed).toContain(file.filename);
        expect(report.meta.completeness.inspectedUnits).toBe(0);
    });

    it('the narrative says what was not read rather than reading as clean', async () => {
        const engine = { execute: jest.fn().mockRejectedValue(new Error('Timed out after 240s')) };
        const report = await new ReviewOrchestrator({ multiPassEngine: engine }).review(bigPr);

        expect(describeCompleteness(report.meta.completeness)).toMatch(/Incomplete review/);
        expect(report.meta.incompleteReasons.join(' ')).toMatch(/failed to review/);
    });

    it('really does fan out, or the case above tests nothing', async () => {
        // Guard on the fixture itself: if the chunker stops splitting this PR,
        // "ALL chunks failed" silently becomes "the one chunk failed".
        const engine = { execute: jest.fn().mockRejectedValue(new Error('Timed out after 240s')) };
        await new ReviewOrchestrator({ multiPassEngine: engine }).review(bigPr);
        expect(engine.execute.mock.calls.length).toBeGreaterThan(1);
    });

    it('one chunk failing out of several still preserves the others findings', async () => {
        // The contrast case: partial failure must not discard what succeeded.
        let call = 0;
        const engine = {
            execute: jest.fn().mockImplementation(async (chunkPrData) => {
                call++;
                if (call === 1) throw new Error('Timed out after 240s');
                const file = chunkPrData.files[0].filename;
                return {
                    analysis: '',
                    perFileFindings: [{
                        file,
                        findings: [{ severity: 'high', file, line: 2, title: 'real bug' }],
                    }],
                    failedFiles: [],
                    completeness: createCompleteness({ expectedUnits: 1, inspectedUnits: 1 }),
                };
            }),
        };
        const report = await new ReviewOrchestrator({ multiPassEngine: engine }).review(bigPr);

        expect(report.findings.length).toBeGreaterThan(0);
        expect(report.meta.incomplete).toBe(true);
    });
});

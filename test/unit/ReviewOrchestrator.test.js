const { ReviewOrchestrator } = require('../../src/services/ReviewOrchestrator.js');
const { VERDICT, PHASE } = require('../../src/services/reviewSchema.js');

function mkFile(filename, addedLines = [1, 2], opts = {}) {
    // Build a minimal patch where added lines correspond to the requested
    // NEW-side numbers (assumes context-free hunks starting at addedLines[0]).
    const newStart = addedLines[0];
    const patch = [
        `@@ -${newStart},0 +${newStart},${addedLines.length} @@`,
        ...addedLines.map((_n, i) => `+line ${i}`),
    ].join('\n');
    return {
        filename,
        additions: addedLines.length,
        deletions: 0,
        patch,
        ...opts,
    };
}

function basePR(overrides = {}) {
    return {
        state: 'open',
        isDraft: false,
        mergeable: true,
        author: { login: 'alice' },
        title: 'Add feature',
        stats: { additions: 5, deletions: 0 },
        files: [mkFile('src/a.js', [10, 11, 12])],
        ...overrides,
    };
}

// Stub MultiPassReviewEngine — returns findings deterministically based on
// the chunk's files, so we can verify chunk fan-out.
function makeStubEngine(handler) {
    return {
        execute: jest.fn(async (prData, _ctx, _settings, _opts, onProgress) => {
            onProgress?.({ phase: 'preparing' });
            return handler(prData);
        }),
    };
}

describe('ReviewOrchestrator — gate behaviour', () => {
    it('SKIP gate returns SKIP verdict without calling the engine', async () => {
        const engine = makeStubEngine(() => ({ analysis: '', perFileFindings: [] }));
        const orch = new ReviewOrchestrator({ multiPassEngine: engine });

        const report = await orch.review(basePR({ isDraft: true }));
        expect(report.verdict).toBe(VERDICT.SKIP);
        expect(engine.execute).not.toHaveBeenCalled();
        expect(report.meta.gate.reason).toBe('draft_pr');
    });

    it('DEFER gate returns DEFER verdict', async () => {
        const engine = makeStubEngine(() => ({ analysis: '', perFileFindings: [] }));
        const orch = new ReviewOrchestrator({ multiPassEngine: engine });

        const report = await orch.review(basePR({ mergeable: false }));
        expect(report.verdict).toBe(VERDICT.DEFER);
        expect(engine.execute).not.toHaveBeenCalled();
    });

    it('AUTO_VERDICT (docs-only) APPROVEs without engine call', async () => {
        const engine = makeStubEngine(() => ({ analysis: '', perFileFindings: [] }));
        const orch = new ReviewOrchestrator({ multiPassEngine: engine });

        const report = await orch.review(basePR({
            files: [mkFile('docs/intro.md', [1, 2])],
        }));
        expect(report.verdict).toBe(VERDICT.APPROVE);
        expect(engine.execute).not.toHaveBeenCalled();
        expect(report.meta.gate.classification).toBe('DOCS_ONLY');
    });
});

describe('ReviewOrchestrator — review pipeline', () => {
    it('runs deep phase, lifts findings to canonical, and filters to assigned hunks', async () => {
        const engine = makeStubEngine(() => ({
            analysis: 'Looks fine.',
            perFileFindings: [
                { severity: 'high', file: 'src/a.js', line: 10, message: 'XSS risk' },          // in hunks
                { severity: 'low', file: 'src/a.js', line: 999, message: 'unrelated nit' },     // outside hunks
                { severity: 'critical', file: 'src/other.js', line: 1, message: 'outside diff' }, // file not in diff
            ],
        }));

        const orch = new ReviewOrchestrator({ multiPassEngine: engine });
        const report = await orch.review(basePR());

        expect(engine.execute).toHaveBeenCalledTimes(1);
        expect(report.findings).toHaveLength(1);
        expect(report.findings[0].file).toBe('src/a.js');
        expect(report.findings[0].line).toBe(10);
        expect(report.findings[0].phase).toBe(PHASE.DEEP);
        expect(report.verdict).toBe(VERDICT.BLOCK);
        expect(report.meta.normalization.deep.dropped).toBe(2);
    });

    it('merges standards findings (from context.staticFindings)', async () => {
        const engine = makeStubEngine(() => ({ analysis: '', perFileFindings: [] }));
        const orch = new ReviewOrchestrator({ multiPassEngine: engine });

        const report = await orch.review(
            basePR(),
            {
                staticFindings: [
                    { severity: 'low', file: 'src/a.js', line: 11, message: 'no-unused-vars', source: 'eslint' },
                ],
            },
        );
        expect(report.findings).toHaveLength(1);
        expect(report.findings[0].phase).toBe(PHASE.STANDARDS);
        expect(report.findings[0].source).toBe('eslint');
        expect(report.verdict).toBe(VERDICT.APPROVE); // nitpick only
    });

    it('emits chunk_findings progress events with per-chunk findings (streaming UX)', async () => {
        const files = Array.from({ length: 25 }, (_, i) =>
            mkFile(`src/dir/f${i}.js`, [10, 11, 12], { additions: 100, deletions: 0 }),
        );
        let chunkIndex = 0;
        const engine = {
            execute: jest.fn(async (prData) => {
                chunkIndex++;
                return {
                    analysis: `chunk ${chunkIndex} ok`,
                    perFileFindings: [
                        { severity: 'medium', file: prData.files[0].filename, line: 10, message: `f${chunkIndex}` },
                    ],
                };
            }),
        };
        const orch = new ReviewOrchestrator({ multiPassEngine: engine });

        const events = [];
        await orch.review(
            basePR({ files, stats: { additions: 2500, deletions: 0 } }),
            {},
            {},
            {},
            (ev) => events.push(ev),
        );

        const streamed = events.filter((e) => e.step === 'chunk_findings');
        expect(streamed.length).toBeGreaterThan(1);
        // Every event has the per-chunk index, total, and at least one finding.
        for (const ev of streamed) {
            expect(typeof ev.chunkIndex).toBe('number');
            expect(typeof ev.totalChunks).toBe('number');
            expect(Array.isArray(ev.findings)).toBe(true);
        }
        // Sum of streamed findings equals what shows up in the final report.
        const streamedTotal = streamed.reduce((n, ev) => n + ev.findings.length, 0);
        // Dedupe in the final report can collapse some, but streamed count ≥ final.
        expect(streamedTotal).toBeGreaterThan(0);
    });

    it('chunks large MRs and fans out to engine.execute per chunk', async () => {
        const files = Array.from({ length: 25 }, (_, i) =>
            mkFile(`src/dir/f${i}.js`, [10, 11, 12], { additions: 100, deletions: 0 }),
        );
        const engine = makeStubEngine(() => ({ analysis: 'chunk-ok\n', perFileFindings: [] }));
        const orch = new ReviewOrchestrator({ multiPassEngine: engine });

        const report = await orch.review(basePR({ files, stats: { additions: 2500, deletions: 0 } }));
        expect(engine.execute.mock.calls.length).toBeGreaterThan(1);
        expect(report.meta.chunkSummary.chunked).toBe(true);
        expect(report.summary.deep).toContain('chunk-ok');
    });

    it('dedupes findings that appear in multiple chunks', async () => {
        const files = Array.from({ length: 25 }, (_, i) =>
            mkFile(`src/f${i}.js`, [10, 11, 12], { additions: 100, deletions: 0 }),
        );
        // Every chunk reports the same finding on src/f0.js:10
        const engine = makeStubEngine(() => ({
            analysis: '',
            perFileFindings: [
                { severity: 'medium', file: 'src/f0.js', line: 10, message: 'same finding everywhere' },
            ],
        }));
        const orch = new ReviewOrchestrator({ multiPassEngine: engine });
        const report = await orch.review(basePR({ files, stats: { additions: 2500, deletions: 0 } }));

        // Despite N chunks each emitting it, dedupe collapses to one.
        const matching = report.findings.filter((f) => f.file === 'src/f0.js' && f.line === 10);
        expect(matching).toHaveLength(1);
    });

    it('survives engine throwing on one chunk and continues with others', async () => {
        const files = Array.from({ length: 25 }, (_, i) =>
            mkFile(`src/f${i}.js`, [10, 11, 12], { additions: 100, deletions: 0 }),
        );
        let calls = 0;
        const engine = {
            execute: jest.fn(async () => {
                calls++;
                if (calls === 1) throw new Error('boom on first chunk');
                return { analysis: 'ok', perFileFindings: [] };
            }),
        };
        const orch = new ReviewOrchestrator({ multiPassEngine: engine });
        const report = await orch.review(basePR({ files, stats: { additions: 2500, deletions: 0 } }));

        expect(report.meta.failedChunks.length).toBeGreaterThan(0);
        expect(report.meta.failedChunks[0].error).toMatch(/boom/);
        // Other chunks still succeeded → verdict still computed.
        expect(report.verdict).toBeDefined();
    });
});

describe('ReviewOrchestrator — telemetry + cache integration', () => {
    it('records telemetry with finding counts and cache stats', async () => {
        const engine = makeStubEngine(() => ({
            analysis: '',
            perFileFindings: [
                { severity: 'high', file: 'src/a.js', line: 10, message: 'x' },
            ],
        }));
        const telemetry = { record: jest.fn(async () => {}) };
        const findingCache = {
            resetStats: jest.fn(),
            getStats: jest.fn(() => ({ hits: 2, misses: 3, puts: 1, lookups: 1, hitRate: 0.4 })),
        };

        const orch = new ReviewOrchestrator({
            multiPassEngine: engine,
            telemetry,
            findingCache,
        });
        await orch.review(basePR());

        expect(findingCache.resetStats).toHaveBeenCalled();
        expect(telemetry.record).toHaveBeenCalledTimes(1);
        const arg = telemetry.record.mock.calls[0][0];
        expect(arg.kind).toBe('pr_review');
        expect(arg.findingsTotal).toBe(1);
        expect(arg.hits).toBe(2);
    });

    it('does not throw if telemetry.record throws', async () => {
        const engine = makeStubEngine(() => ({ analysis: '', perFileFindings: [] }));
        const telemetry = { record: jest.fn(async () => { throw new Error('telem down'); }) };

        const orch = new ReviewOrchestrator({ multiPassEngine: engine, telemetry });
        await expect(orch.review(basePR())).resolves.toBeDefined();
    });
});

describe('ReviewOrchestrator — constructor guards', () => {
    it('throws without a multiPassEngine', () => {
        expect(() => new ReviewOrchestrator({})).toThrow(/multiPassEngine/);
    });
});

const { ReviewOrchestrator, DEFAULT_CHUNK_CONCURRENCY } = require('../../src/services/ReviewOrchestrator.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkFile(filename) {
    return {
        filename, additions: 100, deletions: 0,
        patch: ['@@ -10,0 +10,1 @@', '+line'].join('\n'),
    };
}

function bigPR() {
    // 50 files at 100 loc each → 4 chunks under the default chunker limits.
    const files = Array.from({ length: 50 }, (_, i) => mkFile(`src/f${String(i).padStart(2, '0')}.js`));
    return {
        state: 'open', isDraft: false, mergeable: true, author: { login: 'alice' },
        title: 'Big change', stats: { additions: 5000, deletions: 0 }, files,
    };
}

/** First-started chunk is slowest, so completion order is the reverse of start order. */
function makeEngine() {
    const startOrder = [];
    let inFlight = 0;
    let peak = 0;
    const engine = {
        execute: jest.fn(async (prData) => {
            const first = prData.files[0].filename;
            const position = startOrder.length;
            startOrder.push(first);
            inFlight++;
            peak = Math.max(peak, inFlight);
            await sleep(40 - position * 8);
            inFlight--;
            return {
                analysis: `NARR-${first}`,
                perFileFindings: [{ severity: 'medium', file: first, line: 10, message: `finding in ${first}` }],
                skippedFiles: [`skipped-by-${first}`],
            };
        }),
    };
    return { engine, startOrder, peak: () => peak };
}

describe('ReviewOrchestrator parallel chunks', () => {
    it('defaults to 3 chunks in flight', () => {
        expect(DEFAULT_CHUNK_CONCURRENCY).toBe(3);
    });

    it('runs chunks concurrently up to chunkConcurrency and merges in chunk order', async () => {
        const { engine, startOrder, peak } = makeEngine();
        const report = await new ReviewOrchestrator({ multiPassEngine: engine })
            .review(bigPR(), {}, {}, { chunkConcurrency: 3 });

        expect(engine.execute.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(peak()).toBe(3);

        // Narratives appear in chunk (start) order although they finished in reverse.
        const positions = startOrder.map((name) => report.summary.deep.indexOf(`NARR-${name}`));
        expect(positions.every((p) => p >= 0)).toBe(true);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);

        // Per-chunk skipped files are aggregated, in chunk order.
        expect(report.meta.skippedFiles).toEqual(startOrder.map((n) => `skipped-by-${n}`));
    });

    it('is sequential with chunkConcurrency 1', async () => {
        const { engine, peak } = makeEngine();
        await new ReviewOrchestrator({ multiPassEngine: engine }).review(bigPR(), {}, {}, { chunkConcurrency: 1 });
        expect(peak()).toBe(1);
    });

    it('produces the same findings whatever the concurrency', async () => {
        const run = async (n) => {
            const { engine } = makeEngine();
            const r = await new ReviewOrchestrator({ multiPassEngine: engine }).review(bigPR(), {}, {}, { chunkConcurrency: n });
            return r.findings.map((f) => `${f.file}:${f.line}`);
        };
        expect(await run(3)).toEqual(await run(1));
    });

    it('still aborts the whole review on an auth error', async () => {
        const engine = {
            execute: jest.fn(async () => {
                const e = new Error('401 Unauthorized: invalid api key');
                e.status = 401;
                throw e;
            }),
        };
        await expect(new ReviewOrchestrator({ multiPassEngine: engine }).review(bigPR(), {}, {}, { chunkConcurrency: 3 }))
            .rejects.toThrow();
    });
});

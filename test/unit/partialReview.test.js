/**
 * Oversized MRs are reviewed, not silently dropped — and the truncation is stated.
 *
 * The gate used to return SKIP above 200 files / 5000 LOC, so a large refactor —
 * the change most in need of a second reader — produced nothing, even though
 * MRChunker exists specifically to review large MRs in pieces. Worse, the handler
 * then reported the empty result as APPROVED.
 */

const { ReviewOrchestrator } = require('../../src/services/ReviewOrchestrator.js');

/** A file whose patch adds `adds` lines starting at line 1. */
function file(filename, adds) {
    const body = Array.from({ length: adds }, (_, i) => `+line${i}`).join('\n');
    return {
        filename,
        additions: adds,
        deletions: 0,
        patch: `@@ -0,0 +1,${adds} @@\n${body}\n`,
    };
}

/** Engine stub that records which files it was asked to review. */
function stubEngine(seen) {
    return {
        execute: jest.fn(async (prData) => {
            for (const f of prData.files) seen.push(f.filename);
            return {
                analysis: 'looked at it',
                perFileFindings: [],
                failedFiles: [],
            };
        }),
    };
}

describe('oversized MR → partial review', () => {
    const oversized = () => {
        const files = Array.from({ length: 260 }, (_, i) => file(`src/mod${i}.js`, 40));
        return {
            title: 'Big refactor',
            state: 'open',
            files,
            stats: { additions: 260 * 40, deletions: 0 },
        };
    };

    it('reviews a bounded subset instead of skipping', async () => {
        const seen = [];
        const orchestrator = new ReviewOrchestrator({ multiPassEngine: stubEngine(seen) });
        const report = await orchestrator.review(oversized());

        expect(report.verdict).not.toBe('SKIP');
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.length).toBeLessThan(260);
    });

    it('records the partial budget in report meta', async () => {
        const orchestrator = new ReviewOrchestrator({ multiPassEngine: stubEngine([]) });
        const report = await orchestrator.review(oversized());

        expect(report.meta.partial).toBeTruthy();
        expect(report.meta.partial.totalFiles).toBe(260);
        expect(report.meta.partial.skippedFileCount).toBeGreaterThan(0);
    });

    it('states the truncation at the top of the narrative', async () => {
        // Silence here reads as "we looked at everything", which is the one thing a
        // partial review must never imply.
        const orchestrator = new ReviewOrchestrator({ multiPassEngine: stubEngine([]) });
        const report = await orchestrator.review(oversized());

        expect(report.summary.deep).toMatch(/Partial review/);
        expect(report.summary.deep).toMatch(/were not read/);
        expect(report.summary.deep).toMatch(/not evidence they are correct/);
    });

    it('only reviews files the gate actually selected', async () => {
        const seen = [];
        const orchestrator = new ReviewOrchestrator({ multiPassEngine: stubEngine(seen) });
        const report = await orchestrator.review(oversized());

        const selected = new Set(report.meta.partial.reviewedFiles);
        for (const filename of seen) expect(selected.has(filename)).toBe(true);
    });
});

describe('normal-sized MR is unaffected', () => {
    it('reviews every file and adds no partial note', async () => {
        const seen = [];
        const orchestrator = new ReviewOrchestrator({ multiPassEngine: stubEngine(seen) });
        const report = await orchestrator.review({
            title: 'Small change',
            state: 'open',
            files: [file('src/a.js', 5), file('src/b.js', 5)],
            stats: { additions: 10, deletions: 0 },
        });

        expect(seen.sort()).toEqual(['src/a.js', 'src/b.js']);
        expect(report.meta.partial).toBeNull();
        expect(report.summary.deep).not.toMatch(/Partial review/);
    });
});

describe('tests-only MR now reaches the engine', () => {
    it('is reviewed rather than auto-approved', async () => {
        // The gate auto-APPROVED before, which also meant the dedicated
        // `test-quality` finder lens could never run.
        const seen = [];
        const orchestrator = new ReviewOrchestrator({ multiPassEngine: stubEngine(seen) });
        const report = await orchestrator.review({
            title: 'Add coverage',
            state: 'open',
            files: [file('test/user.test.js', 30)],
            stats: { additions: 30, deletions: 0 },
        });

        expect(seen).toEqual(['test/user.test.js']);
        expect(report.meta.gate.action).toBe('REVIEW');
        expect(report.meta.gate.testsOnly).toBe(true);
    });
});

describe('true short-circuits still short-circuit', () => {
    it('does not call the engine for a draft', async () => {
        const engine = stubEngine([]);
        const orchestrator = new ReviewOrchestrator({ multiPassEngine: engine });
        const report = await orchestrator.review({
            title: 'WIP', state: 'open', isDraft: true,
            files: [file('src/a.js', 5)], stats: { additions: 5, deletions: 0 },
        });

        expect(engine.execute).not.toHaveBeenCalled();
        expect(report.verdict).toBe('SKIP');
    });

    it('does not call the engine for a docs-only change', async () => {
        const engine = stubEngine([]);
        const orchestrator = new ReviewOrchestrator({ multiPassEngine: engine });
        const report = await orchestrator.review({
            title: 'Docs', state: 'open',
            files: [{ filename: 'docs/intro.md', additions: 3, deletions: 0, patch: '@@ -0,0 +1,3 @@\n+a\n+b\n+c\n' }],
            stats: { additions: 3, deletions: 0 },
        });

        expect(engine.execute).not.toHaveBeenCalled();
        expect(report.verdict).toBe('APPROVE');
    });
});

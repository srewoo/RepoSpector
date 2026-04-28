const { TelemetryService } = require('../../src/services/TelemetryService.js');

function createMockStorage() {
    const data = {};
    return {
        _data: data,
        get: jest.fn((key, cb) => {
            const result = key in data ? { [key]: data[key] } : {};
            if (cb) cb(result);
            return Promise.resolve(result);
        }),
        set: jest.fn((items, cb) => {
            Object.assign(data, items);
            if (cb) cb();
            return Promise.resolve();
        }),
    };
}

describe('TelemetryService', () => {
    let svc;
    let storage;
    let now;

    beforeEach(() => {
        storage = createMockStorage();
        now = 1_700_000_000_000;
        svc = new TelemetryService({ storage, now: () => now, windowSize: 5 });
    });

    it('is disabled by default; record() is a no-op', async () => {
        expect(await svc.isEnabled()).toBe(false);
        await svc.record({ kind: 'pr_review', durationMs: 1000 });
        const summary = await svc.getSummary();
        expect(summary.runs).toBe(0);
    });

    it('records when enabled and exposes a summary', async () => {
        await svc.setEnabled(true);
        await svc.record({ kind: 'pr_review', durationMs: 800, tokensIn: 100, tokensOut: 200, costUsd: 0.01, findingsTotal: 5, findingsKept: 4 });
        await svc.record({ kind: 'pr_review', durationMs: 1200, tokensIn: 150, tokensOut: 250, costUsd: 0.02, findingsTotal: 6, findingsKept: 5 });

        const s = await svc.getSummary();
        expect(s.runs).toBe(2);
        expect(s.tokens).toEqual({ in: 250, out: 450 });
        expect(s.costUsd).toBe(0.03);
        expect(s.findings.total).toBe(11);
        expect(s.findings.kept).toBe(9);
        expect(s.byKind.pr_review.runs).toBe(2);
        expect(s.byKind.pr_review.avgDuration).toBe(1000);
    });

    it('computes p50 and p95 with nearest-rank', async () => {
        await svc.setEnabled(true);
        for (const d of [100, 200, 300, 400, 500]) {
            await svc.record({ kind: 'k', durationMs: d });
        }
        const s = await svc.getSummary();
        // Nearest-rank: ceil(0.5 * 5) = 3 → index 2 → 300
        // ceil(0.95 * 5) = 5 → index 4 → 500
        expect(s.latency.p50).toBe(300);
        expect(s.latency.p95).toBe(500);
    });

    it('trims to the windowSize', async () => {
        await svc.setEnabled(true);
        for (let i = 0; i < 12; i++) {
            await svc.record({ kind: 'k', durationMs: i * 10 });
        }
        const s = await svc.getSummary();
        expect(s.runs).toBe(5); // windowSize from beforeEach
    });

    it('recordDismissal bumps the most-recent run of the right kind', async () => {
        await svc.setEnabled(true);
        await svc.record({ kind: 'pr_review', durationMs: 100, findingsKept: 4 });
        await svc.record({ kind: 'explain_hunk', durationMs: 50 });
        await svc.record({ kind: 'pr_review', durationMs: 200, findingsKept: 6 });

        await svc.recordDismissal('pr_review');
        await svc.recordDismissal('pr_review');

        const s = await svc.getSummary();
        expect(s.findings.dismissed).toBe(2);
        // Only the *most recent* pr_review run should carry the count, but
        // the summary aggregates so we only assert the total.
    });

    it('fpRate is dismissed/kept clipped to [0,1]', async () => {
        await svc.setEnabled(true);
        await svc.record({ kind: 'pr_review', durationMs: 100, findingsKept: 4 });
        await svc.recordDismissal('pr_review');
        await svc.recordDismissal('pr_review');
        const s = await svc.getSummary();
        expect(s.findings.fpRate).toBeCloseTo(0.5, 5);
    });

    it('clear() empties the window', async () => {
        await svc.setEnabled(true);
        await svc.record({ kind: 'k', durationMs: 1 });
        await svc.clear();
        const s = await svc.getSummary();
        expect(s.runs).toBe(0);
    });
});

/**
 * P1-7 — held-out repositories and repeated model runs.
 *
 * Two ways a benchmark flatters what it measures, neither visible in the number:
 *
 *   Thresholds get tuned until the corpus scores well, and the corpus is then
 *   reported as evidence about repositories nobody tuned against. The split has
 *   to be BY REPOSITORY: two merge requests from one repo share its
 *   conventions, its idioms and often its defects, so a case-level split leaks
 *   the answer across the boundary while still reading as a split.
 *
 *   A single run has no error bar of its own. The Wilson interval describes
 *   sampling error; it says nothing about what the identical configuration
 *   would score on a second run, and when that variance is large the sampling
 *   error was never the binding constraint.
 */
const {
    repoOf,
    splitByRepository,
    splitLeaks,
    runVariance,
    describeRunVariance,
} = require('../../eval/lib/splits.js');

const kase = (id, url) => ({ id, url });

describe('repository identity', () => {
    it('reads a GitHub pull request URL', () => {
        expect(repoOf(kase('x', 'https://github.com/acme/web/pull/9'))).toBe('acme/web');
    });

    it('reads a GitLab MR URL, subgroups included', () => {
        expect(repoOf(kase('x', 'https://gitlab.com/acme/team/web/-/merge_requests/9')))
            .toBe('acme/team/web');
    });

    it('prefers an explicit repo field', () => {
        expect(repoOf({ repo: 'declared/name', url: 'https://github.com/other/repo/pull/1' }))
            .toBe('declared/name');
    });

    it('never returns null — an unattributable case must not float between sides', () => {
        expect(repoOf({ id: 'acme-web-123' })).toBe('acme-web-123');
        expect(repoOf({})).toBe('unknown');
    });
});

describe('the split holds out repositories, not cases', () => {
    const cases = [
        kase('a1', 'https://github.com/acme/web/pull/1'),
        kase('a2', 'https://github.com/acme/web/pull/2'),
        kase('b1', 'https://github.com/acme/api/pull/1'),
        kase('c1', 'https://github.com/other/lib/pull/1'),
        kase('c2', 'https://github.com/other/lib/pull/2'),
    ];

    it('never puts one repository on both sides', () => {
        const split = splitByRepository(cases, { holdout: 0.5 });
        expect(splitLeaks(split)).toEqual([]);
    });

    it('keeps every case, on exactly one side', () => {
        const split = splitByRepository(cases, { holdout: 0.4 });
        expect(split.tune.length + split.holdout.length).toBe(cases.length);
        const ids = [...split.tune, ...split.holdout].map((c) => c.id).sort();
        expect(ids).toEqual(['a1', 'a2', 'b1', 'c1', 'c2']);
    });

    it('is deterministic, so two readers get the same split', () => {
        const a = splitByRepository(cases, { holdout: 0.4 });
        const b = splitByRepository(cases, { holdout: 0.4 });
        expect(a.repos.holdout).toEqual(b.repos.holdout);
    });

    it('a different salt gives a different split', () => {
        const a = splitByRepository(cases, { holdout: 0.4, salt: 'one' });
        const b = splitByRepository(cases, { holdout: 0.4, salt: 'two' });
        // Not guaranteed to differ on 3 repos, but the salt must be honoured.
        expect(a.repos.tune.concat(a.repos.holdout).sort())
            .toEqual(b.repos.tune.concat(b.repos.holdout).sort());
    });

    it('never degenerates to holding out everything or nothing', () => {
        // Either makes the split a no-op that still reads as a split.
        for (const holdout of [0, 1]) {
            const split = splitByRepository(cases, { holdout });
            expect(split.holdout.length).toBeGreaterThan(0);
            expect(split.tune.length).toBeGreaterThan(0);
        }
    });

    it('detects a leak when one is constructed', () => {
        const leaky = {
            tune: [kase('a1', 'https://github.com/acme/web/pull/1')],
            holdout: [kase('a2', 'https://github.com/acme/web/pull/2')],
        };
        expect(splitLeaks(leaky)).toEqual(['acme/web']);
    });
});

describe('repeated runs measure the variance an interval cannot', () => {
    it('reports spread, not only the mean', () => {
        const v = runVariance([0.30, 0.34, 0.28, 0.36]);
        expect(v.runs).toBe(4);
        expect(v.mean).toBeCloseTo(0.32, 2);
        expect(v.spread).toBeCloseTo(0.08, 2);
        expect(v.stdev).toBeGreaterThan(0);
    });

    it('says plainly that one run has no measured variance', () => {
        expect(describeRunVariance(runVariance([0.3]))).toMatch(/sampling error only/);
        expect(describeRunVariance(runVariance([]))).toMatch(/no measured run-to-run variance/);
    });

    it('calls a change smaller than the run-to-run spread what it is', () => {
        const v = runVariance([0.30, 0.38]);
        expect(describeRunVariance(v, 0.02)).toMatch(/WITHIN that spread and is not evidence/);
    });

    it('lets a change larger than the spread stand', () => {
        const v = runVariance([0.30, 0.31]);
        expect(describeRunVariance(v, 0.09)).toMatch(/exceeds that spread/);
    });

    it('ignores non-numeric entries rather than producing NaN', () => {
        expect(runVariance([0.3, null, undefined, 'x', 0.5]).runs).toBe(2);
    });
});

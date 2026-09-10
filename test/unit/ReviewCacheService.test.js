const {
    ReviewCacheService,
    CACHE_STATUS,
    cacheKeyForUrl,
    renderPrimingContext,
} = require('../../src/services/ReviewCacheService.js');

function fakeStorage() {
    const data = {};
    return {
        data,
        async get(key) { return key in data ? { [key]: data[key] } : {}; },
        async set(obj) { Object.assign(data, obj); },
    };
}

const report = (over = {}) => ({
    verdict: 'BLOCK',
    findings: [{ file: 'src/a.js', line: 10, severity: 'blocking', title: 'Null deref' }],
    ...over,
});

describe('cacheKeyForUrl', () => {
    it('normalizes query strings, fragments and trailing slashes to one key', () => {
        const base = cacheKeyForUrl('https://gitlab.com/g/p/-/merge_requests/9');
        expect(cacheKeyForUrl('https://gitlab.com/g/p/-/merge_requests/9/')).toBe(base);
        expect(cacheKeyForUrl('https://gitlab.com/g/p/-/merge_requests/9?tab=diffs')).toBe(base);
        expect(cacheKeyForUrl('https://gitlab.com/g/p/-/merge_requests/9#note_1')).toBe(base);
    });

    it('keeps different PRs distinct', () => {
        expect(cacheKeyForUrl('https://gitlab.com/g/p/-/merge_requests/9'))
            .not.toBe(cacheKeyForUrl('https://gitlab.com/g/p/-/merge_requests/10'));
    });

    it('returns null for an empty url', () => {
        expect(cacheKeyForUrl('')).toBeNull();
        expect(cacheKeyForUrl(null)).toBeNull();
    });
});

describe('ReviewCacheService', () => {
    const URL = 'https://gitlab.com/g/p/-/merge_requests/9';

    it('misses on an empty cache', async () => {
        const c = new ReviewCacheService({ storage: fakeStorage() });
        expect((await c.lookup(URL, 'sha1')).status).toBe(CACHE_STATUS.MISS);
    });

    // Deliberately flipped for P1-4. Freshness used to rest on the head SHA
    // alone, so a rebase onto a new base, a model change, a lowered threshold
    // or an edited CLAUDE.md all served the previous review as the current one.
    // The head SHA is now necessary and no longer sufficient.
    it('is FRESH when the head SHA AND the review inputs are unchanged', async () => {
        const c = new ReviewCacheService({ storage: fakeStorage() });
        await c.store(URL, { headSha: 'sha1', fingerprint: 'fp1', report: report() });

        const hit = await c.lookup(URL, 'sha1', 'fp1');
        expect(hit.status).toBe(CACHE_STATUS.FRESH);
        expect(hit.entry.payload.findings).toHaveLength(1);
    });

    it('is STALE on the same head SHA when the review inputs changed', async () => {
        const c = new ReviewCacheService({ storage: fakeStorage() });
        await c.store(URL, { headSha: 'sha1', fingerprint: 'fp1', report: report() });

        const hit = await c.lookup(URL, 'sha1', 'fp2');
        expect(hit.status).toBe(CACHE_STATUS.STALE);
        expect(hit.staleReason).toMatch(/review inputs changed/);
    });

    it('never grandfathers an entry stored without a fingerprint into FRESH', async () => {
        const c = new ReviewCacheService({ storage: fakeStorage() });
        await c.store(URL, { headSha: 'sha1', report: report() });

        const hit = await c.lookup(URL, 'sha1', 'fp1');
        expect(hit.status).toBe(CACHE_STATUS.STALE);
        // Still useful as priming context, which is what STALE is for.
        expect(hit.entry.payload.findings).toHaveLength(1);
    });

    it('is STALE when the PR has moved', async () => {
        const c = new ReviewCacheService({ storage: fakeStorage() });
        await c.store(URL, { headSha: 'sha1', report: report() });

        expect((await c.lookup(URL, 'sha2')).status).toBe(CACHE_STATUS.STALE);
    });

    it('treats an unknown SHA as stale rather than fresh', async () => {
        const c = new ReviewCacheService({ storage: fakeStorage() });
        await c.store(URL, { headSha: null, report: report() });

        // Cannot prove freshness → must not serve as current.
        expect((await c.lookup(URL, null)).status).toBe(CACHE_STATUS.STALE);
    });

    it('expires past its TTL', async () => {
        const storage = fakeStorage();
        const c = new ReviewCacheService({ storage, ttlMs: 1000 });
        await c.store(URL, { headSha: 'sha1', report: report() });

        // Age the entry rather than sleeping.
        const key = cacheKeyForUrl(URL);
        storage.data.repospectorReviewCache[key].createdAt = Date.now() - 5000;

        expect((await c.lookup(URL, 'sha1')).status).toBe(CACHE_STATUS.MISS);
    });

    it('refuses to cache a SKIP verdict, so a draft marked ready gets a real review', async () => {
        const c = new ReviewCacheService({ storage: fakeStorage() });
        expect(await c.store(URL, { headSha: 'sha1', report: report({ verdict: 'SKIP' }) })).toBe(false);
        expect((await c.lookup(URL, 'sha1')).status).toBe(CACHE_STATUS.MISS);
    });

    it('refuses to cache a DEFER verdict, so a red pipeline going green gets re-reviewed', async () => {
        const c = new ReviewCacheService({ storage: fakeStorage() });
        expect(await c.store(URL, { headSha: 'sha1', report: report({ verdict: 'DEFER' }) })).toBe(false);
    });

    it('enforces maxEntries', async () => {
        const storage = fakeStorage();
        const c = new ReviewCacheService({ storage, maxEntries: 2 });

        for (const n of [1, 2, 3, 4]) {
            await c.store(`https://gitlab.com/g/p/-/merge_requests/${n}`, { headSha: 's', report: report() });
        }

        expect(Object.keys(storage.data.repospectorReviewCache)).toHaveLength(2);
    });

    it('keeps the most recently stored entry when evicting', async () => {
        const storage = fakeStorage();
        const c = new ReviewCacheService({ storage, maxEntries: 1 });

        await c.store('https://gitlab.com/g/p/-/merge_requests/1', { headSha: 's', report: report() });
        // Age the first entry so the ordering is unambiguous.
        const k1 = cacheKeyForUrl('https://gitlab.com/g/p/-/merge_requests/1');
        storage.data.repospectorReviewCache[k1].createdAt = Date.now() - 60_000;

        await c.store('https://gitlab.com/g/p/-/merge_requests/2', { headSha: 's', report: report() });

        const keys = Object.keys(storage.data.repospectorReviewCache);
        expect(keys).toEqual([cacheKeyForUrl('https://gitlab.com/g/p/-/merge_requests/2')]);
    });

    it('invalidates a single PR', async () => {
        const c = new ReviewCacheService({ storage: fakeStorage() });
        await c.store(URL, { headSha: 'sha1', report: report() });
        await c.invalidate(URL);
        expect((await c.lookup(URL, 'sha1')).status).toBe(CACHE_STATUS.MISS);
    });

    it('degrades to a miss when no storage backend is available', async () => {
        const c = new ReviewCacheService({ storage: null });
        await c.store(URL, { headSha: 'sha1', report: report() });
        expect((await c.lookup(URL, 'sha1')).status).toBe(CACHE_STATUS.MISS);
    });
});

describe('renderPrimingContext', () => {
    it('is empty with no entry', () => {
        expect(renderPrimingContext(null)).toBe('');
        expect(renderPrimingContext({ payload: { findings: [] } })).toBe('');
    });

    it('lists prior findings and instructs keep/drop/add', () => {
        const md = renderPrimingContext({
            headSha: 'abcdef1234',
            payload: { findings: [{ file: 'src/a.js', line: 10, severity: 'blocking', title: 'Null deref' }] },
        });

        expect(md).toContain('abcdef12');
        expect(md).toContain('`src/a.js:10`');
        expect(md).toContain('Null deref');
        expect(md).toContain('**Keep**');
        expect(md).toContain('**Drop**');
        expect(md).toContain('**Add**');
        // Must not be presented as verified truth.
        expect(md).toContain('Do NOT treat these as verified');
    });

    it('drops unanchored findings, which cannot be re-checked against the new diff', () => {
        const md = renderPrimingContext({
            headSha: 'x',
            payload: { findings: [{ severity: 'blocking', title: 'vague architectural concern' }] },
        });
        expect(md).toBe('');
    });

    it('accepts the code_feedback key as well as findings', () => {
        const md = renderPrimingContext({
            headSha: 'x',
            payload: { code_feedback: [{ relevant_file: 'a.go', line_number: 3, severity: 'blocking', suggestion: 'fix it' }] },
        });
        expect(md).toContain('`a.go:3`');
    });

    it('caps the number of carried findings', () => {
        const many = Array.from({ length: 50 }, (_, i) => ({ file: 'a.js', line: i, title: `f${i}` }));
        const md = renderPrimingContext({ headSha: 'x', payload: { findings: many } }, { maxFindings: 5 });
        expect(md.split('\n').filter(l => l.startsWith('- [')).length).toBe(5);
    });
});

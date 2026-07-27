const {
    IncrementalReviewService,
    REVIEW_MODE,
    hashPatch,
    fingerprintFiles,
} = require('../../src/services/IncrementalReviewService.js');

/** In-memory chrome.storage.local stand-in. */
function makeStorage(initial = {}) {
    let data = { ...initial };
    return {
        get: jest.fn(async (key) => (key in data ? { [key]: data[key] } : {})),
        set: jest.fn(async (obj) => { data = { ...data, ...obj }; }),
        _dump: () => data,
    };
}

const file = (name, patch) => ({ filename: name, patch });

const prAt = (sha, files, commits = []) => ({ headSha: sha, files, commits });

describe('hashPatch / fingerprintFiles', () => {
    it('is stable and content-sensitive', () => {
        expect(hashPatch('abc')).toBe(hashPatch('abc'));
        expect(hashPatch('abc')).not.toBe(hashPatch('abd'));
    });

    it('fingerprints by filename', () => {
        const fp = fingerprintFiles([file('a.js', '+x'), file('b.js', '+y')]);
        expect(Object.keys(fp).sort()).toEqual(['a.js', 'b.js']);
        expect(fp['a.js']).not.toBe(fp['b.js']);
    });

    it('ignores files with no name', () => {
        expect(fingerprintFiles([{ patch: '+x' }])).toEqual({});
    });
});

describe('IncrementalReviewService.plan', () => {
    const svc = new IncrementalReviewService({ storage: makeStorage() });

    it('is a full review when nothing was recorded before', () => {
        const plan = svc.plan(prAt('sha1', [file('a.js', '+a')]), null);
        expect(plan.mode).toBe(REVIEW_MODE.FULL);
        expect(plan.filesToReview).toHaveLength(1);
    });

    it('is a full review when forced', () => {
        const prev = { headSha: 'sha1', fileHashes: fingerprintFiles([file('a.js', '+a')]), findings: [] };
        const plan = svc.plan(prAt('sha2', [file('a.js', '+a')]), prev, { force: true });
        expect(plan.mode).toBe(REVIEW_MODE.FULL);
    });

    it('falls back to full when a head SHA is unavailable', () => {
        const prev = { headSha: 'sha1', fileHashes: {}, findings: [] };
        expect(svc.plan(prAt(null, [file('a.js', '+a')]), prev).mode).toBe(REVIEW_MODE.FULL);
    });

    it('reports UNCHANGED when the head SHA has not moved', () => {
        const files = [file('a.js', '+a')];
        const prev = { headSha: 'sha1', fileHashes: fingerprintFiles(files), findings: [{ file: 'a.js' }] };
        const plan = svc.plan(prAt('sha1', files), prev);
        expect(plan.mode).toBe(REVIEW_MODE.UNCHANGED);
        expect(plan.filesToReview).toHaveLength(0);
    });

    it('reports UNCHANGED when the SHA moved but no diff did', () => {
        // e.g. an empty merge commit, or a rebase that preserved every patch
        const files = [file('a.js', '+a'), file('b.js', '+b')];
        const prev = { headSha: 'sha1', fileHashes: fingerprintFiles(files), findings: [] };
        const plan = svc.plan(prAt('sha2', files), prev);
        expect(plan.mode).toBe(REVIEW_MODE.UNCHANGED);
        expect(plan.reason).toMatch(/no file diff changed/);
    });

    it('reviews only the changed file and carries the rest', () => {
        const before = [file('a.js', '+a'), file('b.js', '+b')];
        const prev = {
            headSha: 'sha1',
            fileHashes: fingerprintFiles(before),
            findings: [
                { file: 'a.js', line: 1, title: 'stale', source: 'llm' },
                { file: 'b.js', line: 2, title: 'still valid', source: 'llm' },
            ],
        };
        const after = [file('a.js', '+a CHANGED'), file('b.js', '+b')];
        const plan = svc.plan(prAt('sha2', after), prev);

        expect(plan.mode).toBe(REVIEW_MODE.INCREMENTAL);
        expect(plan.changedFiles).toEqual(['a.js']);
        expect(plan.unchangedFiles).toEqual(['b.js']);
        expect(plan.filesToReview.map(f => f.filename)).toEqual(['a.js']);

        // The finding on the CHANGED file must be re-derived (it may be fixed);
        // the one on the untouched file is carried.
        expect(plan.carriedFindings).toHaveLength(1);
        expect(plan.carriedFindings[0].file).toBe('b.js');
    });

    it('never carries static findings — they are re-derived free every run', () => {
        const before = [file('a.js', '+a'), file('b.js', '+b')];
        const prev = {
            headSha: 'sha1',
            fileHashes: fingerprintFiles(before),
            findings: [
                { file: 'b.js', line: 2, title: 'lint', source: 'static' },
                { file: 'b.js', line: 3, title: 'ai', source: 'llm' },
            ],
        };
        const plan = svc.plan(prAt('sha2', [file('a.js', '+CHANGED'), file('b.js', '+b')]), prev);
        expect(plan.carriedFindings.map(f => f.source)).toEqual(['llm']);
    });

    it('escalates to a full review when every diff changed', () => {
        const prev = {
            headSha: 'sha1',
            fileHashes: fingerprintFiles([file('a.js', '+a'), file('b.js', '+b')]),
            findings: [],
        };
        const plan = svc.plan(prAt('sha2', [file('a.js', '+A'), file('b.js', '+B')]), prev);
        expect(plan.mode).toBe(REVIEW_MODE.FULL);
    });

    it('treats a newly added file as changed', () => {
        const prev = { headSha: 'sha1', fileHashes: fingerprintFiles([file('a.js', '+a')]), findings: [] };
        const plan = svc.plan(prAt('sha2', [file('a.js', '+a'), file('new.js', '+n')]), prev);
        expect(plan.mode).toBe(REVIEW_MODE.INCREMENTAL);
        expect(plan.changedFiles).toEqual(['new.js']);
    });
});

describe('IncrementalReviewService persistence', () => {
    it('round-trips state through storage', async () => {
        const storage = makeStorage();
        const svc = new IncrementalReviewService({ storage });
        const files = [file('a.js', '+a')];

        await svc.record('https://github.com/o/r/pull/1', prAt('sha1', files), [
            { file: 'a.js', line: 1, title: 'x', source: 'llm' },
        ]);

        const state = await svc.getState('https://github.com/o/r/pull/1');
        expect(state.headSha).toBe('sha1');
        expect(state.findings).toHaveLength(1);
        expect(state.findings[0].carriedFromSha).toBe('sha1');
        expect(state.fileHashes['a.js']).toBeDefined();
    });

    it('records then plans incrementally on the next push', async () => {
        const storage = makeStorage();
        const svc = new IncrementalReviewService({ storage });
        const url = 'https://github.com/o/r/pull/2';

        await svc.record(url, prAt('sha1', [file('a.js', '+a'), file('b.js', '+b')]), [
            { file: 'b.js', line: 1, title: 'keep', source: 'llm' },
        ]);

        const plan = svc.plan(
            prAt('sha2', [file('a.js', '+CHANGED'), file('b.js', '+b')]),
            await svc.getState(url)
        );
        expect(plan.mode).toBe(REVIEW_MODE.INCREMENTAL);
        expect(plan.carriedFindings[0].title).toBe('keep');
    });

    it('expires state past its TTL', async () => {
        const storage = makeStorage();
        const svc = new IncrementalReviewService({ storage, ttlMs: 1000 });
        await svc.record('u', prAt('sha1', [file('a.js', '+a')]), []);

        const all = storage._dump().repospectorIncrementalReviewState;
        all['u'].reviewedAt = Date.now() - 5000; // age it past the TTL

        expect(await svc.getState('u')).toBeNull();
    });

    it('bounds how many PRs it retains', async () => {
        const storage = makeStorage();
        const svc = new IncrementalReviewService({ storage, maxEntries: 2 });
        for (let i = 0; i < 5; i++) {
            await svc.record(`pr-${i}`, prAt(`sha${i}`, [file('a.js', `+${i}`)]), []);
        }
        const kept = Object.keys(storage._dump().repospectorIncrementalReviewState);
        expect(kept).toHaveLength(2);
    });

    it('clear() forgets a PR', async () => {
        const svc = new IncrementalReviewService({ storage: makeStorage() });
        await svc.record('u', prAt('sha1', [file('a.js', '+a')]), []);
        await svc.clear('u');
        expect(await svc.getState('u')).toBeNull();
    });

    it('degrades to full review when storage is unavailable', async () => {
        const svc = new IncrementalReviewService({ storage: null });
        await expect(svc.record('u', prAt('sha1', []), [])).resolves.toBeUndefined();
        expect(await svc.getState('u')).toBeNull();
    });
});

describe('describePlan', () => {
    it('describes an incremental run', () => {
        const text = IncrementalReviewService.describePlan({
            mode: REVIEW_MODE.INCREMENTAL,
            prevHeadSha: 'abcdef1234',
            changedFiles: ['a.js'],
            unchangedFiles: ['b.js'],
            carriedFindings: [{}],
        });
        expect(text).toContain('abcdef1');
        expect(text).toContain('1 changed file');
    });

    it('returns empty for a full review', () => {
        expect(IncrementalReviewService.describePlan({ mode: REVIEW_MODE.FULL })).toBe('');
    });
});

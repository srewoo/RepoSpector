const { FindingCache } = require('../../src/services/FindingCache.js');

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
        remove: jest.fn(),
    };
}

describe('FindingCache', () => {
    const prInfo = { platform: 'github', owner: 'acme', repo: 'web', prNumber: 42 };

    describe('hashHunk', () => {
        it('returns a stable 8-char hex hash', () => {
            const h = FindingCache.hashHunk('+ const x = 1;');
            expect(h).toMatch(/^[0-9a-f]{8}$/);
            expect(FindingCache.hashHunk('+ const x = 1;')).toBe(h);
        });

        it('is insensitive to trailing whitespace and CRLF', () => {
            const a = FindingCache.hashHunk('+ const x = 1;\n+ const y = 2;');
            const b = FindingCache.hashHunk('+ const x = 1;   \r\n+ const y = 2;\t\t');
            expect(a).toBe(b);
        });

        it('changes when content changes', () => {
            expect(FindingCache.hashHunk('+ const x = 1;'))
                .not.toBe(FindingCache.hashHunk('+ const x = 2;'));
        });

        it('handles empty input', () => {
            expect(FindingCache.hashHunk('')).toMatch(/^[0-9a-f]{8}$/);
            expect(FindingCache.hashHunk(null)).toMatch(/^[0-9a-f]{8}$/);
        });
    });

    describe('prKey', () => {
        it('formats deterministically', () => {
            expect(FindingCache.prKey(prInfo)).toBe('github:acme/web#42');
        });
        it('throws on missing fields', () => {
            expect(() => FindingCache.prKey({ platform: 'github', owner: 'a', repo: 'b' }))
                .toThrow();
        });
    });

    describe('lookup / put', () => {
        let cache;
        let storage;
        let now;

        beforeEach(() => {
            storage = createMockStorage();
            now = 1_700_000_000_000;
            cache = new FindingCache({ storage, now: () => now });
        });

        it('returns all misses when cache is empty', async () => {
            const hunks = [
                { file: 'a.js', hunkHash: 'aaaa' },
                { file: 'b.js', hunkHash: 'bbbb' },
            ];
            const { hits, misses } = await cache.lookup(prInfo, hunks);
            expect(hits.size).toBe(0);
            expect(misses).toEqual(hunks);
        });

        it('returns a hit after put()', async () => {
            await cache.put(prInfo, 'a.js', 'aaaa', [{ severity: 'high', message: 'oops' }]);
            const { hits, misses } = await cache.lookup(prInfo, [
                { file: 'a.js', hunkHash: 'aaaa' },
                { file: 'b.js', hunkHash: 'bbbb' },
            ]);
            expect(hits.get('a.js::aaaa')).toEqual([{ severity: 'high', message: 'oops' }]);
            expect(misses).toEqual([{ file: 'b.js', hunkHash: 'bbbb' }]);
        });

        it('partitions findings per PR', async () => {
            await cache.put(prInfo, 'a.js', 'aaaa', [{ id: 1 }]);
            const otherPR = { ...prInfo, prNumber: 99 };
            const { hits } = await cache.lookup(otherPR, [{ file: 'a.js', hunkHash: 'aaaa' }]);
            expect(hits.size).toBe(0);
        });

        it('treats expired entries as misses', async () => {
            await cache.put(prInfo, 'a.js', 'aaaa', [{ id: 1 }]);
            // Advance clock past TTL (30 days).
            now += 31 * 24 * 60 * 60 * 1000;
            const { hits, misses } = await cache.lookup(prInfo, [{ file: 'a.js', hunkHash: 'aaaa' }]);
            expect(hits.size).toBe(0);
            expect(misses).toHaveLength(1);
        });

        it('putMany writes multiple entries in one round trip', async () => {
            await cache.putMany(prInfo, [
                { file: 'a.js', hunkHash: 'aaaa', findings: [{ id: 1 }] },
                { file: 'b.js', hunkHash: 'bbbb', findings: [{ id: 2 }] },
            ]);
            // One read + one write only.
            expect(storage.set).toHaveBeenCalledTimes(1);
            const { hits } = await cache.lookup(prInfo, [
                { file: 'a.js', hunkHash: 'aaaa' },
                { file: 'b.js', hunkHash: 'bbbb' },
            ]);
            expect(hits.size).toBe(2);
        });

        it('clearPR drops the partition', async () => {
            await cache.put(prInfo, 'a.js', 'aaaa', [{ id: 1 }]);
            await cache.clearPR(prInfo);
            const { hits } = await cache.lookup(prInfo, [{ file: 'a.js', hunkHash: 'aaaa' }]);
            expect(hits.size).toBe(0);
        });

        it('pruneExpired removes only expired entries', async () => {
            await cache.put(prInfo, 'a.js', 'aaaa', [{ id: 1 }]); // fresh
            now -= 31 * 24 * 60 * 60 * 1000;                       // travel back
            await cache.put(prInfo, 'b.js', 'bbbb', [{ id: 2 }]); // stale
            now += 31 * 24 * 60 * 60 * 1000;                       // back to "now"
            const removed = await cache.pruneExpired();
            expect(removed).toBe(1);
            const { hits, misses } = await cache.lookup(prInfo, [
                { file: 'a.js', hunkHash: 'aaaa' },
                { file: 'b.js', hunkHash: 'bbbb' },
            ]);
            expect(hits.size).toBe(1);
            expect(misses).toHaveLength(1);
        });
    });
});

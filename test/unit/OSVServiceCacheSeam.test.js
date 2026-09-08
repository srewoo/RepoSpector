/**
 * OSVService's cache seam.
 *
 * OSVService is the one analysis service with a Chrome dependency, and it is
 * only persistence — `chrome.storage.local.set`/`.get` in `persistCache` and
 * `loadCache`. Because those were called directly, the MCP server could not
 * use the service at all: `packages/mcp/src/adapters/osvCache.js` was written
 * as a file-backed replacement and left unwired, and every `review_pr` bundle
 * reported its dependency section as `unavailable`.
 *
 * An injectable cache is the whole fix. Nothing else in the service touches
 * Chrome.
 */

const { OSVService } = require('../../src/services/OSVService.js');

/** The `{save, load}` shape `createFileOsvCache` already returns. */
function memoryCache(initial = null) {
    let stored = initial;
    const calls = { save: 0, load: 0 };
    return {
        save(data) { stored = data; calls.save += 1; return true; },
        load() { calls.load += 1; return stored; },
        calls,
        get stored() { return stored; },
    };
}

describe('an injected cache is used instead of chrome.storage', () => {
    it('persists through the injected cache', async () => {
        const cache = memoryCache();
        const svc = new OSVService({ cache });
        svc.cache.set('npm:lodash@4.17.20', { queriedAt: Date.now(), vulns: [] });

        await svc.persistCache();

        expect(cache.calls.save).toBe(1);
        expect(Object.keys(cache.stored)).toEqual(['npm:lodash@4.17.20']);
    });

    it('loads through the injected cache', async () => {
        const cache = memoryCache({
            'npm:lodash@4.17.20': { queriedAt: Date.now(), vulns: [{ id: 'GHSA-x' }] },
        });
        const svc = new OSVService({ cache });

        await svc.loadCache();

        expect(svc.cache.get('npm:lodash@4.17.20').vulns).toEqual([{ id: 'GHSA-x' }]);
    });

    it('does not persist entries older than the TTL', async () => {
        const cache = memoryCache();
        const svc = new OSVService({ cache, cacheTTL: 1000 });
        svc.cache.set('stale', { queriedAt: Date.now() - 5000, vulns: [] });
        svc.cache.set('fresh', { queriedAt: Date.now(), vulns: [] });

        await svc.persistCache();

        expect(Object.keys(cache.stored)).toEqual(['fresh']);
    });

    it('ignores loaded entries older than the TTL', async () => {
        const cache = memoryCache({
            stale: { queriedAt: Date.now() - 5000, vulns: [] },
        });
        const svc = new OSVService({ cache, cacheTTL: 1000 });

        await svc.loadCache();

        expect(svc.cache.size).toBe(0);
    });

    it('a cache that cannot be read does not fail the service', async () => {
        const svc = new OSVService({
            cache: { save: () => false, load: () => { throw new Error('disk gone'); } },
        });

        await expect(svc.loadCache()).resolves.not.toThrow();
        expect(svc.cache.size).toBe(0);
    });

    it('never touches chrome.storage when a cache is injected', async () => {
        // Outside the extension there is no `chrome` at all — reaching for it
        // throws, which is what kept the MCP path from using OSV. Here the test
        // harness provides a mock, so assert on the mock not being called.
        globalThis.chrome.storage.local.set.mockClear();
        globalThis.chrome.storage.local.get.mockClear();

        const cache = memoryCache();
        const svc = new OSVService({ cache });
        svc.cache.set('k', { queriedAt: Date.now(), vulns: [] });

        await svc.persistCache();
        await svc.loadCache();

        expect(cache.calls.save).toBe(1);
        expect(cache.calls.load).toBe(1);
        expect(globalThis.chrome.storage.local.set).not.toHaveBeenCalled();
        expect(globalThis.chrome.storage.local.get).not.toHaveBeenCalled();
    });
});

describe('without an injected cache the existing behaviour is kept', () => {
    it('a missing chrome.storage is survivable, not fatal', async () => {
        const svc = new OSVService({});
        await expect(svc.persistCache()).resolves.not.toThrow();
        await expect(svc.loadCache()).resolves.not.toThrow();
    });
});

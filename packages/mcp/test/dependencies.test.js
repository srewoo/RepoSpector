import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDependencySection } from '../src/tools/dependencies.js';

/**
 * The dependency section, which claimed a lookup it never performed.
 *
 * After wiring `OSVService`'s new cache seam, the section built the service,
 * called `loadCache()`, parsed the manifest — and never called `queryBatch`.
 * It then reported "OSV lookups are cached on disk beside the index", which
 * reads as "these packages were checked against OSV". Nothing was checked.
 * That is the class of false claim this whole effort exists to remove,
 * introduced by the effort itself.
 *
 * A second trap is in `queryBatch` itself: it catches its own network errors
 * (`OSVService.js`, "Don't fail - results will just not have these entries")
 * and returns a Map missing those packages. An unreachable OSV is therefore
 * indistinguishable from a clean result unless the caller compares what it
 * ASKED for against what came back. These tests are written to that real
 * contract — a `Map` keyed by `ecosystem:name:version` — not to a friendlier
 * invented one.
 */

const DEPS = [
    { name: 'lodash', version: '4.17.20', type: 'production' },
    { name: 'express', version: '4.17.1', type: 'production' },
];

const analyzer = {
    isDependencyFile: (p) => /package\.json$/.test(p),
    analyze: () => ({ findings: [], fileType: 'npm', dependencies: DEPS }),
};

const files = [{ path: 'package.json', content: '{"dependencies":{"lodash":"4.17.20"}}' }];

/** An OSV double honouring the real Map contract. */
const osvReturning = (entries, onCall) => ({
    mapEcosystem: (fileType) => (fileType === 'npm' ? 'npm' : null),
    getCacheKey: (name, version, ecosystem) => `${ecosystem}:${name}:${version || 'unknown'}`,
    queryBatch: async (packages) => {
        if (onCall) onCall(packages);
        return new Map(entries);
    },
    loadCache: async () => {},
});

test('no manifest in the change means not applicable, and no lookup', async () => {
    let called = false;
    const osv = osvReturning([], () => { called = true; });

    const section = await buildDependencySection({
        manifests: [], files: [], analyzer, osv,
    });

    assert.equal(section.applicable, false);
    assert.equal(called, false, 'queried OSV for a change that touches no manifest');
    assert.match(section.note, /manifest/i);
});

test('a manifest in the change is actually looked up', async () => {
    let asked = null;
    const osv = osvReturning(
        [['npm:lodash:4.17.20', []], ['npm:express:4.17.1', []]],
        (packages) => { asked = packages; },
    );

    const section = await buildDependencySection({
        manifests: [{ filename: 'package.json' }], files, analyzer, osv,
    });

    assert.equal(section.applicable, true);
    assert.equal(section.lookup.performed, true, 'reported applicable without querying anything');
    assert.deepEqual(asked.map((p) => p.name), ['lodash', 'express']);
    assert.deepEqual(asked.map((p) => p.ecosystem), ['npm', 'npm']);
    assert.equal(section.packagesChecked, 2);
});

test('vulnerabilities found are reported against their package', async () => {
    const osv = osvReturning([
        ['npm:lodash:4.17.20', [{ id: 'GHSA-x', severity: 'high', fixedVersions: ['4.17.21'] }]],
        ['npm:express:4.17.1', []],
    ]);

    const section = await buildDependencySection({
        manifests: [{ filename: 'package.json' }], files, analyzer, osv,
    });

    assert.equal(section.vulnerabilities.length, 1);
    assert.equal(section.vulnerabilities[0].package, 'lodash');
    assert.equal(section.vulnerabilities[0].version, '4.17.20');
    assert.equal(section.vulnerabilities[0].vulnerabilities[0].id, 'GHSA-x');
});

test('a clean lookup says it ran and found nothing', async () => {
    const osv = osvReturning([['npm:lodash:4.17.20', []], ['npm:express:4.17.1', []]]);

    const section = await buildDependencySection({
        manifests: [{ filename: 'package.json' }], files, analyzer, osv,
    });

    assert.equal(section.lookup.performed, true);
    assert.deepEqual(section.vulnerabilities, []);
    assert.equal(section.packagesUnchecked, 0);
    assert.match(section.note, /no known|clean|nothing/i);
});

test('packages missing from the response are reported unchecked, not clean', async () => {
    // The real failure mode: `queryBatch` swallows its network error and simply
    // omits those packages. Reading that as "no vulnerabilities" is the lie.
    const osv = osvReturning([['npm:lodash:4.17.20', []]]);

    const section = await buildDependencySection({
        manifests: [{ filename: 'package.json' }], files, analyzer, osv,
    });

    assert.equal(section.packagesChecked, 1);
    assert.equal(section.packagesUnchecked, 1);
    assert.deepEqual(section.uncheckedPackages, ['express@4.17.1']);
    assert.match(section.note, /unchecked|not checked|partial/i);
});

test('a thrown lookup is named as a failure, never as a clean result', async () => {
    const osv = {
        ...osvReturning([]),
        queryBatch: async () => { throw new Error('getaddrinfo ENOTFOUND api.osv.dev'); },
    };

    const section = await buildDependencySection({
        manifests: [{ filename: 'package.json' }], files, analyzer, osv,
    });

    assert.equal(section.lookup.performed, false);
    assert.match(section.lookup.reason, /ENOTFOUND|failed/i);
    assert.equal(
        section.vulnerabilities, null,
        'an unreachable OSV must not read as "no vulnerabilities"',
    );
});

test('a lookup that hangs is bounded and reported as unfinished', async () => {
    const osv = { ...osvReturning([]), queryBatch: () => new Promise(() => {}) };

    const section = await buildDependencySection({
        manifests: [{ filename: 'package.json' }], files, analyzer, osv, timeoutMs: 50,
    });

    assert.equal(section.lookup.performed, false);
    assert.match(section.lookup.reason, /timed out|timeout/i);
    assert.equal(section.vulnerabilities, null);
});

test('a manifest with no parsable dependencies says so rather than querying nothing', async () => {
    const empty = { ...analyzer, analyze: () => ({ findings: [], fileType: 'npm', dependencies: [] }) };
    const osv = {
        ...osvReturning([]),
        queryBatch: async () => { throw new Error('should not be called'); },
    };

    const section = await buildDependencySection({
        manifests: [{ filename: 'package.json' }], files, analyzer: empty, osv,
    });

    assert.equal(section.packagesChecked, 0);
    assert.equal(section.lookup.performed, false);
    assert.match(section.lookup.reason, /no (parsable |parsed )?dependenc/i);
});

test('an ecosystem the analyzer cannot map is reported, not silently dropped', async () => {
    const osv = { ...osvReturning([]), mapEcosystem: () => null };

    const section = await buildDependencySection({
        manifests: [{ filename: 'package.json' }], files, analyzer, osv,
    });

    assert.equal(section.lookup.performed, false);
    assert.match(section.lookup.reason, /ecosystem/i);
});

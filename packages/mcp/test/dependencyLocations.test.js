import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateDependency, buildDependencySection } from '../src/tools/dependencies.js';

// An advisory must name the lines where the vulnerable version is pinned —
// the lockfile as well as the manifest — or the reviewer anchors it on one
// file and the line that resolves the version goes unflagged.

const lock = '{\n  "packages": {\n    "node_modules/lodash": {\n      "version": "4.17.15",\n      "resolved": "x"\n    },\n    "node_modules/lodash-es": {\n      "version": "4.17.21"\n    }\n  }\n}';

test('finds the pinned version in package.json, package-lock, yarn.lock and requirements.txt', () => {
    assert.deepEqual(locateDependency('{\n  "dependencies": {\n    "lodash": "4.17.15"\n  }\n}', 'lodash', '4.17.15'), [3]);
    assert.deepEqual(locateDependency(lock, 'lodash', '4.17.15'), [4]);
    assert.deepEqual(locateDependency('lodash@^4.17.0:\n  version "4.17.15"\n', 'lodash', '4.17.15'), [2]);
    assert.deepEqual(locateDependency('flask==2.0.1\nrequests==2.31.0\n', 'flask', '2.0.1'), [1]);
});

test('a similarly named package or a different version is not a match', () => {
    assert.deepEqual(locateDependency(lock, 'lodash', '4.17.21'), []);
    assert.deepEqual(locateDependency('"lodash-es": "4.17.15"', 'lodash', '4.17.15'), []);
});

test('the section marks which pinned locations this change wrote', async () => {
    const manifests = [{ filename: 'package-lock.json', patch: '@@ -1,4 +1,4 @@\n {\n   "packages": {\n     "node_modules/lodash": {\n-      "version": "4.18.1",\n+      "version": "4.17.15",' }];
    const osv = {
        mapEcosystem: () => 'npm',
        getCacheKey: (n, v, e) => `${e}:${n}@${v}`,
        queryBatch: async () => new Map([['npm:lodash@4.17.15', [{ id: 'GHSA-x' }]]]),
    };
    const analyzer = { analyze: () => ({ fileType: 'packageLock', dependencies: [{ name: 'lodash', version: '4.17.15' }] }) };
    const section = await buildDependencySection({ manifests, files: [{ path: 'package-lock.json', content: lock }], analyzer, osv });
    assert.deepEqual(section.vulnerabilities[0].locations, [{ file: 'package-lock.json', line: 4, changed: true }]);
});

test('a change touching package.json and package-lock.json is a dependency change, and the lockfile is queried', async () => {
    const { DependencyAnalyzer } = await import('../../../src/services/DependencyAnalyzer.js');
    const analyzer = new DependencyAnalyzer({});
    assert.equal(analyzer.isDependencyFile('package.json'), true);
    assert.equal(analyzer.isDependencyFile('web/package-lock.json'), true);
    assert.equal(analyzer.isDependencyFile('src/app.js'), false);

    const lockfile = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lodash': { version: '4.17.15' } } }, null, 2);
    const asked = [];
    const osv = {
        mapEcosystem: (t) => ({ npm: 'npm' })[t] ?? null,
        getCacheKey: (n, v, e) => `${e}:${n}@${v}`,
        queryBatch: async (pkgs) => { asked.push(...pkgs); return new Map(pkgs.map((p) => [`${p.ecosystem}:${p.name}@${p.version}`, []])); },
    };
    const section = await buildDependencySection({
        manifests: [{ filename: 'package-lock.json', patch: '' }],
        files: [{ path: 'package-lock.json', content: lockfile }],
        analyzer, osv,
    });
    assert.deepEqual(asked.map((p) => `${p.ecosystem}:${p.name}@${p.version}`), ['npm:lodash@4.17.15']);
    assert.equal(section.packagesChecked, 1);
});

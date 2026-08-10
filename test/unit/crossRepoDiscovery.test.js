/**
 * The discovery fallback is the difference between cross-repo impact being a
 * capability and being a capability that runs. Before it, `run()` returned null
 * unless the user had written a `.repospector.yaml` — so the feature shipped,
 * was tested, and in practice never fired.
 */

const { ReviewCrossRepoService } = require('../../src/services/ReviewCrossRepoService.js');

const PR_DATA = {
    files: [{
        filename: 'src/db.js',
        patch: '@@ -1 +1 @@\n+export function save(a, b, c) { return a; }\n',
    }],
};

/** A graph double whose findReferences reports hits for the given symbols. */
function graphWith(hits) {
    return {
        nodeCount: 42,
        findReferences: (symbol) => (hits[symbol] || []),
    };
}

function makeService({ indexedRepos = [], graphs = {}, listIndexedRepos } = {}) {
    return new ReviewCrossRepoService({
        listIndexedRepos: listIndexedRepos || (async () => indexedRepos),
        isRepoIndexed: async (repoId) => !!graphs[repoId],
        loadGraph: async (repoId) => graphs[repoId] || null,
    });
}

describe('discovery fallback', () => {
    it('checks other indexed repos when no workspace is declared', async () => {
        const svc = makeService({
            indexedRepos: ['gh:acme/api', 'gh:acme/web'],
            graphs: {
                'gh:acme/web': graphWith({ save: [{ filePath: 'src/app.js', line: 12 }] }),
            },
        });

        const out = await svc.run({
            prData: PR_DATA,
            customConfig: {},
            currentRepoId: 'gh:acme/api',
        });

        expect(out).not.toBeNull();
        expect(out.stats.workspaceDeclared).toBe(false);
        expect(out.stats.discoveredRepos).toBe(1);
        expect(out.dependents.map(d => d.repoId)).toContain('gh:acme/web');
    });

    it('never treats the repo under review as its own dependent', async () => {
        const svc = makeService({ indexedRepos: ['gh:acme/api'] });
        const out = await svc.run({
            prData: PR_DATA, customConfig: {}, currentRepoId: 'gh:acme/api',
        });
        expect(out).toBeNull();
    });

    it('returns null when nothing is declared and nothing else is indexed', async () => {
        const svc = makeService({ indexedRepos: [] });
        expect(await svc.run({
            prData: PR_DATA, customConfig: {}, currentRepoId: 'gh:acme/api',
        })).toBeNull();
    });

    it('caps how many discovered repos it will walk', async () => {
        // Every discovered repo costs a graph load on the review's critical
        // path; someone with twenty indexed repos does not want twenty walked.
        const many = Array.from({ length: 20 }, (_, i) => `gh:acme/r${i}`);
        const graphs = Object.fromEntries(many.map(id => [id, graphWith({})]));
        const svc = makeService({ indexedRepos: many, graphs });

        const out = await svc.run({
            prData: PR_DATA, customConfig: {}, currentRepoId: 'gh:acme/current',
        });
        expect(out.stats.discoveredRepos).toBe(5);
    });

    it('prefers a declared workspace over discovery', async () => {
        // `parseWorkspace` derives the repoId from the URL, so the declared id
        // is 'acme/declared' rather than whatever an entry claims.
        const svc = makeService({
            indexedRepos: ['gh:acme/discovered'],
            graphs: {
                'acme/declared': graphWith({ save: [{ filePath: 'a.js' }] }),
                'gh:acme/discovered': graphWith({ save: [{ filePath: 'b.js' }] }),
            },
        });

        const out = await svc.run({
            prData: PR_DATA,
            customConfig: {
                workspace: { repos: [{ url: 'https://github.com/acme/declared' }] },
            },
            currentRepoId: 'gh:acme/api',
        });

        expect(out.stats.workspaceDeclared).toBe(true);
        expect(out.stats.discoveredRepos).toBe(0);
        // The discovered repo is not consulted at all when one is declared.
        expect(out.dependents.map(d => d.repoId)).toEqual(['acme/declared']);
    });

    it('survives a store that cannot list repos', async () => {
        const svc = makeService({
            listIndexedRepos: async () => { throw new Error('IndexedDB unavailable'); },
        });
        expect(await svc.run({
            prData: PR_DATA, customConfig: {}, currentRepoId: 'gh:acme/api',
        })).toBeNull();
    });

    it('reports a clean result rather than a silent null when nothing references the change', async () => {
        // "No dependents" and "the feature did not run" must not look the same;
        // that ambiguity is what the stats block exists to remove.
        const svc = makeService({
            indexedRepos: ['gh:acme/web'],
            graphs: { 'gh:acme/web': graphWith({}) },
        });
        const out = await svc.run({
            prData: PR_DATA, customConfig: {}, currentRepoId: 'gh:acme/api',
        });

        expect(out.dependents).toEqual([]);
        expect(out.stats.discoveredRepos).toBe(1);
        expect(out.stats.linkedReposChecked).toBe(1);
        expect(out.stats.symbolsExtracted).toBeGreaterThan(0);
    });

    it('counts an empty graph as unavailable instead of as no references', async () => {
        const svc = makeService({
            indexedRepos: ['gh:acme/web'],
            graphs: { 'gh:acme/web': { nodeCount: 0, findReferences: () => [] } },
        });
        const out = await svc.run({
            prData: PR_DATA, customConfig: {}, currentRepoId: 'gh:acme/api',
        });
        expect(out.stats.graphsEmpty).toBe(1);
    });
});

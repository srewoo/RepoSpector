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

    it('accepts the {repoId, chunksCount} shape the real vector store returns', async () => {
        // VectorStore.getAllRepoIds() resolves objects, not strings. Treating an
        // entry as a bare id made the progress line read "Checking [object
        // Object]..." and let the repo under review be walked against itself.
        const svc = makeService({
            indexedRepos: [
                { repoId: 'gh:acme/api', chunksCount: 900 },
                { repoId: 'gh:acme/web', chunksCount: 120 },
            ],
            graphs: {
                'gh:acme/web': graphWith({ save: [{ filePath: 'src/app.js', line: 12 }] }),
            },
        });

        const messages = [];
        const out = await svc.run({
            prData: PR_DATA,
            customConfig: {},
            currentRepoId: 'gh:acme/api',
            onProgress: (p) => messages.push(p.message),
        });

        expect(out.stats.discoveredRepos).toBe(1); // the current repo is excluded
        expect(out.dependents.map(d => d.repoId)).toEqual(['gh:acme/web']);
        expect(messages.join(' ')).not.toContain('[object Object]');
    });

    it('coerces a numeric repoId (GitLab project ids) to a string without crashing', async () => {
        // A bare numeric id carries no owner, so discovery cannot prove it is
        // related to anything and skips it. It must skip, not throw.
        const svc = makeService({
            indexedRepos: [{ repoId: 12345, chunksCount: 7 }],
            graphs: { '12345': graphWith({ save: [{ filePath: 'a.js' }] }) },
        });
        const out = await svc.run({
            prData: PR_DATA, customConfig: {}, currentRepoId: 'gh:acme/api',
        });
        expect(out).toBeNull();
    });

    describe('same-org gate', () => {
        // The bug: an MR on mindtickle/supportops/hermes printed
        // "Checking srewoo/speeDB..." and walked a personal repo in a different
        // organisation, purely because both were in the local index.
        it('ignores indexed repos outside the current repo owner', async () => {
            const svc = makeService({
                indexedRepos: ['mindtickle/supportops/hermes', 'srewoo/speeDB'],
                graphs: {
                    // speeDB would have "referenced" the symbol by bare name.
                    'srewoo/speeDB': graphWith({ save: [{ filePath: 'src/db.js' }] }),
                },
            });

            const messages = [];
            const out = await svc.run({
                prData: PR_DATA,
                customConfig: {},
                currentRepoId: 'mindtickle/supportops/hermes',
                onProgress: (p) => messages.push(p.message),
            });

            expect(out).toBeNull();
            expect(messages.join(' ')).not.toContain('speeDB');
        });

        it('still walks sibling repos under the same owner', async () => {
            const svc = makeService({
                indexedRepos: ['mindtickle/supportops/hermes', 'mindtickle/platform/api', 'srewoo/speeDB'],
                graphs: {
                    'mindtickle/platform/api': graphWith({ save: [{ filePath: 'src/app.js' }] }),
                    'srewoo/speeDB': graphWith({ save: [{ filePath: 'src/db.js' }] }),
                },
            });

            const out = await svc.run({
                prData: PR_DATA,
                customConfig: {},
                currentRepoId: 'mindtickle/supportops/hermes',
            });

            expect(out.stats.discoveredRepos).toBe(1);
            expect(out.stats.discoveryFiltered).toBe(1);
            expect(out.dependents.map(d => d.repoId)).toEqual(['mindtickle/platform/api']);
        });

        it('treats the same owner on different hosts as unrelated', async () => {
            const svc = makeService({
                indexedRepos: ['gl:acme/web'],
                graphs: { 'gl:acme/web': graphWith({ save: [{ filePath: 'a.js' }] }) },
            });
            const out = await svc.run({
                prData: PR_DATA, customConfig: {}, currentRepoId: 'gh:acme/api',
            });
            expect(out).toBeNull();
        });

        it('compares owners case-insensitively', async () => {
            const svc = makeService({
                indexedRepos: ['gh:Acme/web'],
                graphs: { 'gh:Acme/web': graphWith({ save: [{ filePath: 'a.js' }] }) },
            });
            const out = await svc.run({
                prData: PR_DATA, customConfig: {}, currentRepoId: 'gh:acme/api',
            });
            expect(out.dependents.map(d => d.repoId)).toEqual(['gh:Acme/web']);
        });

        it('never filters a DECLARED workspace by owner', async () => {
            // An explicit .repospector.yaml is the user stating the relationship;
            // cross-org is legitimate there.
            const svc = makeService({
                indexedRepos: [],
                graphs: { 'other-org/consumer': graphWith({ save: [{ filePath: 'a.js' }] }) },
            });
            const out = await svc.run({
                prData: PR_DATA,
                customConfig: { workspace: { repos: ['https://github.com/other-org/consumer'] } },
                currentRepoId: 'mindtickle/supportops/hermes',
            });
            expect(out.dependents.map(d => d.repoId)).toEqual(['other-org/consumer']);
        });
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

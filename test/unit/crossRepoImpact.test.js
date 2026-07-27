/**
 * Tests for the cross-repo impact FOUNDATION: workspace parsing + impact resolver.
 */
const { repoIdFromUrl, parseWorkspace, linkedRepos } = require('../../src/utils/workspaceConfig.js');
const { CrossRepoImpactService } = require('../../src/services/CrossRepoImpactService.js');
const { KnowledgeGraphService } = require('../../src/services/KnowledgeGraphService.js');
const { ReviewCrossRepoService } = require('../../src/services/ReviewCrossRepoService.js');

describe('workspaceConfig', () => {
    it('derives repoId from GitHub/GitLab URLs', () => {
        expect(repoIdFromUrl('https://github.com/acme/consumer-a')).toBe('acme/consumer-a');
        expect(repoIdFromUrl('https://github.com/acme/consumer-a.git')).toBe('acme/consumer-a');
        expect(repoIdFromUrl('https://gitlab.com/acme/team/shared-lib')).toBe('acme/team/shared-lib');
        expect(repoIdFromUrl('not a url')).toBeNull();
    });

    it('parses string and object repo entries, dedupes, reads autoIndex', () => {
        const cfg = { workspace: { autoIndex: true, repos: [
            'https://github.com/acme/a',
            { url: 'https://github.com/acme/b', role: 'library' },
            'https://github.com/acme/a' // dup
        ] } };
        const ws = parseWorkspace(cfg);
        expect(ws.autoIndex).toBe(true);
        expect(ws.repos).toHaveLength(2);
        expect(ws.repos[1]).toMatchObject({ repoId: 'acme/b', role: 'library' });
    });

    it('linkedRepos excludes the current repo', () => {
        const cfg = { workspace: { repos: ['https://github.com/acme/a', 'https://github.com/acme/b'] } };
        const links = linkedRepos(cfg, 'acme/a');
        expect(links.map(r => r.repoId)).toEqual(['acme/b']);
    });

    it('empty/missing workspace yields no repos', () => {
        expect(parseWorkspace({}).repos).toEqual([]);
        expect(parseWorkspace(null).repos).toEqual([]);
    });
});

describe('CrossRepoImpactService.extractChangedSymbols', () => {
    it('pulls exported/public declarations from added lines', () => {
        const prData = { files: [{ patch: [
            '+ export function computeTax(x) {',
            '+ export class Ledger {}',
            '+ def process_order(o):',
            '+ func HandleWebhook(w http.ResponseWriter) {',
            '  unchanged line'
        ].join('\n') }] };
        const syms = CrossRepoImpactService.extractChangedSymbols(prData);
        expect(syms).toEqual(expect.arrayContaining(['computeTax', 'Ledger', 'process_order', 'HandleWebhook']));
    });
});

describe('CrossRepoImpactService.analyze', () => {
    const linked = [
        { url: 'https://github.com/acme/consumer', repoId: 'acme/consumer', role: 'consumer' },
        { url: 'https://github.com/acme/unrelated', repoId: 'acme/unrelated', role: 'related' }
    ];

    it('reports a linked repo that references a changed symbol', async () => {
        const svc = new CrossRepoImpactService({
            isRepoIndexed: async () => true,
            loadGraph: async (repoId) => ({
                findReferences: (sym) => (repoId === 'acme/consumer' && sym === 'computeTax' ? [{ file: 'billing.js' }] : [])
            })
        });
        const res = await svc.analyze({ changedSymbols: ['computeTax'], linkedRepos: linked });
        expect(res.dependents).toHaveLength(1);
        expect(res.dependents[0]).toMatchObject({ repoId: 'acme/consumer' });
        expect(res.dependents[0].hits[0].files).toContain('billing.js');
    });

    it('auto-indexes an unindexed linked repo when autoIndex is on', async () => {
        const indexed = new Set();
        const svc = new CrossRepoImpactService({
            isRepoIndexed: async (id) => indexed.has(id),
            indexRepo: async (url) => { indexed.add(url.includes('consumer') ? 'acme/consumer' : 'acme/unrelated'); },
            loadGraph: async () => ({ findReferences: () => [{ file: 'x.js' }] })
        });
        const res = await svc.analyze({ changedSymbols: ['computeTax'], linkedRepos: linked, autoIndex: true });
        expect(res.indexedNow).toContain('acme/consumer');
        expect(res.dependents.length).toBeGreaterThan(0);
    });

    it('lists needsIndexing when a linked repo is not indexed and autoIndex is off', async () => {
        const svc = new CrossRepoImpactService({
            isRepoIndexed: async () => false,
            loadGraph: async () => null
        });
        const res = await svc.analyze({ changedSymbols: ['computeTax'], linkedRepos: linked, autoIndex: false });
        expect(res.needsIndexing.map(r => r.repoId)).toEqual(['acme/consumer', 'acme/unrelated']);
        expect(res.dependents).toHaveLength(0);
    });

    it('no changed symbols or no links → empty result', async () => {
        const svc = new CrossRepoImpactService({ isRepoIndexed: async () => true, loadGraph: async () => ({ findReferences: () => [] }) });
        expect((await svc.analyze({ changedSymbols: [], linkedRepos: linked })).dependents).toHaveLength(0);
        expect((await svc.analyze({ changedSymbols: ['x'], linkedRepos: [] })).dependents).toHaveLength(0);
    });
});

describe('KnowledgeGraphService.findReferences (P1 primitive)', () => {
    it('finds a named node and a CALLS site referencing the symbol', () => {
        const g = new KnowledgeGraphService();
        g.addNode({ id: 'n1', label: 'Function', properties: { name: 'computeTax', filePath: 'billing.js', startLine: 10 } });
        g.addNode({ id: 'n2', label: 'Function', properties: { name: 'checkout', filePath: 'app.js', startLine: 2 } });
        g.addRelationship({ id: 'r1', type: 'CALLS', sourceId: 'n2', targetId: 'n1', properties: { line: 5 } });

        const refs = g.findReferences('computeTax');
        const files = refs.map(r => r.file);
        expect(files).toEqual(expect.arrayContaining(['billing.js', 'app.js']));
        expect(g.referencesSymbol('computeTax')).toBe(true);
        expect(g.referencesSymbol('doesNotExist')).toBe(false);
        expect(g.findReferences('')).toEqual([]);
    });
});

describe('ReviewCrossRepoService (P2 wiring)', () => {
    const config = { workspace: { repos: ['https://github.com/acme/consumer'], autoIndex: false } };
    const prData = { files: [{ patch: '+ export function computeTax(x) { return x; }' }] };

    it('reports a dependent linked repo using injected stores, and renders a section', async () => {
        const fakeGraph = { findReferences: (s) => (s === 'computeTax' ? [{ file: 'billing.js', kind: 'call', line: 5 }] : []) };
        const svc = new ReviewCrossRepoService({
            isRepoIndexed: async () => true,
            loadGraph: async () => fakeGraph
        });
        const report = await svc.run({ prData, customConfig: config, currentRepoId: 'acme/main' });
        expect(report.changedSymbols).toContain('computeTax');
        expect(report.dependents[0].repoId).toBe('acme/consumer');

        const section = ReviewCrossRepoService.renderSection(report);
        expect(section).toContain('Cross-Repo Impact');
        expect(section).toContain('acme/consumer');
        expect(section).toContain('computeTax');
    });

    it('returns null when no workspace is declared (zero cost)', async () => {
        const svc = new ReviewCrossRepoService({ isRepoIndexed: async () => true, loadGraph: async () => ({ findReferences: () => [] }) });
        expect(await svc.run({ prData, customConfig: {}, currentRepoId: 'x' })).toBeNull();
    });

    it('renderSection is empty when there are no dependents', () => {
        expect(ReviewCrossRepoService.renderSection({ dependents: [] })).toBe('');
        expect(ReviewCrossRepoService.renderSection(null)).toBe('');
    });
});

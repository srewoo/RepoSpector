/**
 * P1-4 — a cached or carried review must expire when its evidence does.
 *
 * Freshness rested on one input: does the PR's head SHA equal the stored one?
 * Everything else a review's output depends on was invisible. Same head,
 * rebased onto a different base — served as current. Different model, lowered
 * threshold, new fail level, edited CLAUDE.md, rebuilt index, a scanner report
 * that landed since — all served as current.
 *
 * And per finding: reuse was decided by "is this finding's own file
 * byte-identical?", which cannot see that the callee it cited was fixed.
 */
const {
    buildReviewFingerprint,
    evidenceDependencies,
    partitionCarriedFindings,
    withEvidenceDeps,
    PIPELINE_VERSION,
} = require('../../src/utils/reviewFingerprint.js');
const { IncrementalReviewService, REVIEW_MODE } = require('../../src/services/IncrementalReviewService.js');

const inputs = (over = {}) => ({
    baseSha: 'base1',
    headSha: 'head1',
    model: 'openai:gpt-4o',
    provider: 'openai',
    config: { minConfidence: 0.8, minScore: 7, failLevel: 'high', filterMode: 'added' },
    instructions: 'instr-hash-1',
    contextSnapshot: 'index-1',
    ...over,
});

describe('the fingerprint covers everything the answer depended on', () => {
    it('is stable for identical inputs, whatever the key order', () => {
        const a = buildReviewFingerprint(inputs());
        const b = buildReviewFingerprint({
            ...inputs(),
            config: { filterMode: 'added', failLevel: 'high', minScore: 7, minConfidence: 0.8 },
        });
        expect(a.hash).toBe(b.hash);
    });

    const changes = [
        ['a rebase onto a different base', { baseSha: 'base2' }],
        ['a different model', { model: 'anthropic:claude-sonnet-5' }],
        ['a different provider', { provider: 'anthropic' }],
        ['a lowered score threshold', { config: { ...inputs().config, minScore: 4 } }],
        ['a changed fail level', { config: { ...inputs().config, failLevel: 'any' } }],
        ['an edited instruction file', { instructions: 'instr-hash-2' }],
        ['a rebuilt index snapshot', { contextSnapshot: 'index-2' }],
        ['an ingested scanner report', { scanners: ['codeql@run-9'] }],
    ];

    for (const [label, over] of changes) {
        it(`changes on ${label}`, () => {
            expect(buildReviewFingerprint(inputs(over)).hash)
                .not.toBe(buildReviewFingerprint(inputs()).hash);
        });
    }

    it('is unaffected by settings that do not change what a review says', () => {
        const withNoise = buildReviewFingerprint({
            ...inputs(),
            config: { ...inputs().config, theme: 'dark', panelWidth: 400 },
        });
        expect(withNoise.hash).toBe(buildReviewFingerprint(inputs()).hash);
    });

    it('changes when the pipeline version does, so a shipped fix is not masked', () => {
        expect(PIPELINE_VERSION).toBeGreaterThan(0);
        expect(buildReviewFingerprint(inputs()).parts.pipelineVersion).toBe(PIPELINE_VERSION);
    });

    it('scanner identities are order-independent', () => {
        expect(buildReviewFingerprint(inputs({ scanners: ['a', 'b'] })).hash)
            .toBe(buildReviewFingerprint(inputs({ scanners: ['b', 'a'] })).hash);
    });
});

describe('what a finding rests on', () => {
    it('includes its own file', () => {
        expect(evidenceDependencies({ file: 'src/a.js', line: 3 })).toContain('src/a.js');
    });

    it('includes the call sites a graph rule read', () => {
        const deps = evidenceDependencies({
            file: 'src/pay.js',
            callSites: [{ filePath: 'src/checkout.js', line: 10 }],
        });
        expect(deps).toEqual(expect.arrayContaining(['src/pay.js', 'src/checkout.js']));
    });

    it('includes paths named in a graph evidence block', () => {
        const deps = evidenceDependencies({
            file: 'src/pay.js',
            evidence: 'src/checkout.js:10\nsrc/refund.js:22',
        });
        expect(deps).toEqual(expect.arrayContaining(['src/checkout.js', 'src/refund.js']));
    });

    it('includes structured evidence locations', () => {
        const deps = evidenceDependencies({
            file: 'a.js',
            claim: { evidenceLocations: [{ file: 'src/contract.ts' }, 'src/other.ts'] },
        });
        expect(deps).toEqual(expect.arrayContaining(['src/contract.ts', 'src/other.ts']));
    });

    it('attaches the set once so it survives into the cache entry', () => {
        const [f] = withEvidenceDeps([{ file: 'a.js', evidence: 'b.js:1' }]);
        expect(f.evidenceDeps).toEqual(expect.arrayContaining(['a.js', 'b.js']));
    });
});

describe('a carried finding is invalidated by a change to what it cited', () => {
    const callerFinding = {
        file: 'src/caller.js',
        line: 5,
        title: 'passes the old argument list',
        evidenceDeps: ['src/caller.js', 'src/callee.js'],
    };

    it('a fixed callee invalidates the caller finding, with no edit to the caller', () => {
        const { reusable, invalidated } = partitionCarriedFindings([callerFinding], ['src/callee.js']);
        expect(reusable).toHaveLength(0);
        expect(invalidated).toHaveLength(1);
        expect(invalidated[0]._invalidatedBy).toBe('src/callee.js');
    });

    it('an unchanged evidence set is still reused', () => {
        const { reusable } = partitionCarriedFindings([callerFinding], ['src/unrelated.js']);
        expect(reusable).toHaveLength(1);
    });

    it('derives the dependency set when the finding has none recorded', () => {
        const legacy = { file: 'src/caller.js', evidence: 'src/callee.js:12' };
        const { invalidated } = partitionCarriedFindings([legacy], ['src/callee.js']);
        expect(invalidated).toHaveLength(1);
    });
});

describe('incremental reuse respects evidence dependencies', () => {
    const prData = (over = {}) => ({
        headSha: 'head2',
        files: [
            { filename: 'src/caller.js', patch: '@@ -1 +1 @@\n-a\n+a' },
            { filename: 'src/callee.js', patch: '@@ -1 +1 @@\n-b\n+c' },
        ],
        ...over,
    });

    const prevState = {
        headSha: 'head1',
        fileHashes: null,
        findings: [{
            file: 'src/caller.js',
            line: 1,
            source: 'llm',
            title: 'passes an argument the callee no longer accepts',
            evidenceDeps: ['src/caller.js', 'src/callee.js'],
        }],
    };

    it('does not carry a finding whose cited callee changed in this push', () => {
        const svc = new IncrementalReviewService();
        const current = prData();
        // Previous run saw caller.js exactly as it is now, and callee.js differently.
        const { fingerprintFiles } = require('../../src/services/IncrementalReviewService.js');
        const state = {
            ...prevState,
            fileHashes: {
                ...fingerprintFiles(current.files),
                'src/callee.js': 'a-different-hash',
            },
        };

        const plan = svc.plan(current, state);
        expect(plan.mode).toBe(REVIEW_MODE.INCREMENTAL);
        expect(plan.changedFiles).toContain('src/callee.js');
        expect(plan.carriedFindings).toHaveLength(0);
        expect(plan.invalidatedFindings).toHaveLength(1);
        expect(plan.invalidatedFindings[0]._invalidatedBy).toBe('src/callee.js');
    });

    it('still carries a finding whose evidence is entirely unchanged', () => {
        const svc = new IncrementalReviewService();
        const current = prData();
        const { fingerprintFiles } = require('../../src/services/IncrementalReviewService.js');
        const state = {
            headSha: 'head1',
            fileHashes: {
                ...fingerprintFiles(current.files),
                'src/callee.js': 'a-different-hash',
            },
            findings: [{
                file: 'src/caller.js', line: 1, source: 'llm',
                title: 'local problem', evidenceDeps: ['src/caller.js'],
            }],
        };

        const plan = svc.plan(current, state);
        expect(plan.carriedFindings).toHaveLength(1);
        expect(plan.invalidatedFindings).toHaveLength(0);
    });

    it('says so in the narrative when findings were re-derived', () => {
        const text = IncrementalReviewService.describePlan({
            mode: REVIEW_MODE.INCREMENTAL,
            prevHeadSha: 'abcdef1234',
            changedFiles: ['a.js'],
            unchangedFiles: ['b.js'],
            carriedFindings: [],
            invalidatedFindings: [{ file: 'b.js' }],
        });
        expect(text).toMatch(/re-derived because the code they cited changed/);
    });
});

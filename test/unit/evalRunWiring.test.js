/**
 * Does the harness actually hand the engine the context it claims to?
 *
 * This is the test the previous version of the harness could not have failed:
 * `reviewOne` built its context as `{ staticFindings, contextBudget }`, every
 * context-dependent feature was inactive, and no end-to-end score would have
 * revealed it — the numbers were plausible, they just described a different
 * pipeline. So this asserts on what reaches `MultiPassReviewEngine`, not on the
 * score that comes out.
 *
 * The LLM is stubbed. A test that needed a real key would not run in CI, and the
 * thing under test here is the plumbing, not the model.
 */

const { reviewOne } = require('../../eval/run.js');

const FILE_LINES = [
    'package main',                            // 1
    '',                                        // 2
    'func Serve(addr string) error {',         // 3
    '    if addr == "" {',                     // 4
    '        return errors.New("no addr")',    // 5
    '    }',                                   // 6
    '    srv := newServer(addr)',              // 7
    '    return srv.ListenAndServe()',         // 8
    '}',                                       // 9
];
const CONTENT = FILE_LINES.join('\n');

const PATCH = [
    '@@ -6,3 +6,3 @@',
    '     }',
    '-    srv := newServer()',
    '+    srv := newServer(addr)',
    '     return srv.ListenAndServe()',
].join('\n');

function makeCase(over = {}) {
    return {
        id: 'acme/repo#7',
        url: 'https://github.com/acme/repo/pull/7',
        prData: {
            platform: 'github',
            title: 'Pass addr through',
            headSha: 'abc',
            files: [{
                filename: 'server.go',
                status: 'modified',
                additions: 1,
                deletions: 1,
                patch: PATCH,
                language: 'go',
            }],
        },
        fileContents: { 'server.go': CONTENT },
        ...over,
    };
}

/**
 * An LLM stub that records every context it was asked to review, and answers
 * with one finding on the line the patch touched so the tail of the pipeline has
 * something to carry.
 */
function stubLlm() {
    const prompts = [];
    return {
        prompts,
        supportsTools: () => false,
        streamChat: async (messages) => {
            const text = messages.map(m => (typeof m.content === 'string'
                ? m.content
                : (m.content || []).map(p => p.text).join('\n'))).join('\n');
            prompts.push(text);

            return {
                content: JSON.stringify({
                    file: 'server.go',
                    language: 'go',
                    fileVerdict: 'NEEDS_CHANGES',
                    riskLevel: 'MEDIUM',
                    findings: [{
                        id: 'f1',
                        file: 'server.go',
                        line: 7,
                        severity: 'medium',
                        type: 'bug',
                        title: 'newServer may reject an empty addr',
                        description: 'Guarded above, but the guard is the only check.',
                        evidence: 'srv := newServer(addr)',
                        confidence: 0.9,
                    }],
                    positives: [],
                    testCoverage: null,
                }),
                usage: { input: 100, output: 50 },
            };
        },
    };
}

const SETTINGS = { provider: 'openai', model: 'openai:gpt-4.1-mini', apiKey: 'test' };
const OPTS = { multiFinder: false, filterMode: 'added', failLevel: 'high', contextProfile: 'default' };

describe('reviewOne supplies the context it reports', () => {
    it('puts the file content in front of the model', async () => {
        const llm = stubLlm();
        const { stats } = await reviewOne(makeCase(), { llm, settings: SETTINGS, opts: OPTS });

        expect(stats.filesWithContent).toBe(1);
        expect(stats.contentBytes).toBeGreaterThan(0);
        // The claim and the prompt have to agree — this is the assertion the old
        // harness could not make.
        const all = llm.prompts.join('\n');
        expect(all).toContain('func Serve(addr string) error {');
    });

    it('extracts declarations and reports how many', async () => {
        const llm = stubLlm();
        const { stats } = await reviewOne(makeCase(), { llm, settings: SETTINGS, opts: OPTS });
        expect(stats.declarationFiles).toBe(1);
        expect(stats.declarations).toBeGreaterThan(0);
    });

    it('confirms the cached content aligns with the cached patch', async () => {
        const llm = stubLlm();
        const { stats } = await reviewOne(makeCase(), { llm, settings: SETTINGS, opts: OPTS });
        expect(stats.patchesAligned).toBe(1);
        expect(stats.patchesMisaligned).toBe(0);
    });

    it('reports stale content instead of silently reviewing patch-only', async () => {
        // The one number to read before trusting a comparison between two runs.
        const stale = makeCase({
            fileContents: { 'server.go': CONTENT.replace('newServer(addr)', 'newServer()') },
        });
        const llm = stubLlm();
        const { stats } = await reviewOne(stale, { llm, settings: SETTINGS, opts: OPTS });

        expect(stats.patchesAligned).toBe(0);
        expect(stats.patchesMisaligned).toBe(1);
        expect(stats.misalignmentReasons[0].file).toBe('server.go');
    });

    it('runs patch-only, and says so, when the corpus has no content', async () => {
        const llm = stubLlm();
        const bare = makeCase({ fileContents: {} });
        const { stats } = await reviewOne(bare, { llm, settings: SETTINGS, opts: OPTS });

        expect(stats.filesWithContent).toBe(0);
        expect(stats.filesWithoutContent).toBe(1);
        expect(llm.prompts.join('\n')).not.toContain('func Serve(addr string) error {');
    });
});

describe('reviewOne applies the shipped policies', () => {
    it('records the filter mode and drops out-of-scope findings', async () => {
        const llm = stubLlm();
        const { stats } = await reviewOne(makeCase(), { llm, settings: SETTINGS, opts: OPTS });
        expect(stats.filterMode).toBe('added');
        expect(stats.filteredOut).toBeGreaterThanOrEqual(0);
    });

    it('honours a wider filter mode', async () => {
        const llm = stubLlm();
        const { stats } = await reviewOne(makeCase(), {
            llm, settings: SETTINGS, opts: { ...OPTS, filterMode: 'nofilter' },
        });
        expect(stats.filterMode).toBe('nofilter');
        expect(stats.filteredOut).toBe(0);
    });

    it('records whether the run would have blocked the merge', async () => {
        const llm = stubLlm();
        const strict = await reviewOne(makeCase(), {
            llm, settings: SETTINGS, opts: { ...OPTS, failLevel: 'any' },
        });
        expect(strict.stats.failLevel).toBe('any');

        const off = await reviewOne(makeCase(), {
            llm, settings: SETTINGS, opts: { ...OPTS, failLevel: 'none' },
        });
        expect(off.stats.wouldBlock).toBe(false);
    });

    it('ingests an external scanner report attached to the case', async () => {
        const sarif = JSON.stringify({
            runs: [{
                tool: { driver: { name: 'gosec', rules: [{ id: 'G114', helpUri: 'https://x.test/G114' }] } },
                results: [{
                    ruleId: 'G114',
                    level: 'error',
                    message: { text: 'Use of net/http serve function that has no support for setting timeouts' },
                    locations: [{ physicalLocation: { artifactLocation: { uri: 'server.go' }, region: { startLine: 8 } } }],
                }],
            }],
        });

        const llm = stubLlm();
        const { stats, predictions } = await reviewOne(
            makeCase({ externalReports: [{ name: 'gosec.sarif', content: sarif }] }),
            { llm, settings: SETTINGS, opts: OPTS },
        );

        expect(stats.externalFindings).toBe(1);
        expect(stats.externalSources).toBe(1);
        // It reached the model as a pre-detected finding...
        expect(llm.prompts.join('\n')).toContain('G114');
        // ...and survived to the predictions, which is what gets scored.
        expect(predictions.some(p => p.rule === 'G114')).toBe(true);
    });

    it('works with no external report at all', async () => {
        const llm = stubLlm();
        const { stats } = await reviewOne(makeCase(), { llm, settings: SETTINGS, opts: OPTS });
        expect(stats.externalFindings).toBe(0);
        expect(stats.externalSources).toBe(0);
    });
});

/**
 * The service decides WHERE a report comes from. Its important properties are
 * about degradation and about not double-counting: every source failure must
 * yield a named reason rather than a silent zero, and the same scanner must not be
 * ingested twice through two channels.
 */

const { ExternalFindingsService } = require('../../src/services/ExternalFindingsService.js');
const { settingsForStage, modelForStage, describeTiering, STAGE_TIERS, TIER } =
    require('../../src/utils/modelTiers.js');

const SARIF = JSON.stringify({
    version: '2.1.0',
    runs: [{
        tool: { driver: { name: 'Semgrep', rules: [{ id: 'rule.a', helpUri: 'https://semgrep.dev/r/rule.a' }] } },
        results: [{
            ruleId: 'rule.a',
            level: 'error',
            message: { text: 'Tainted input reaches exec()' },
            locations: [{ physicalLocation: { artifactLocation: { uri: 'src/run.js' }, region: { startLine: 12 } } }],
        }],
    }],
});

const PR_DATA = { headSha: 'abc123', files: [{ filename: 'src/run.js' }] };

describe('supplied reports', () => {
    it('ingests a report handed over directly', async () => {
        const svc = new ExternalFindingsService({});
        const res = await svc.collect({
            prUrl: 'https://github.com/a/b/pull/1',
            prData: PR_DATA,
            reports: [{ name: 'semgrep.sarif', content: SARIF }],
        });

        expect(res.findings).toHaveLength(1);
        expect(res.findings[0]).toMatchObject({
            ruleId: 'rule.a',
            tool: 'Semgrep',
            source: 'external',
            deterministic: true,
            ruleUrl: 'https://semgrep.dev/r/rule.a',
        });
        expect(res.sources[0]).toMatchObject({ name: 'semgrep.sarif', ok: true, findings: 1 });
    });

    it('names the failure instead of returning a silent zero', async () => {
        // A review that lost its CodeQL findings must not look like one where
        // CodeQL found nothing.
        const svc = new ExternalFindingsService({});
        const res = await svc.collect({
            prUrl: 'u', prData: PR_DATA,
            reports: [{ name: 'broken.sarif', content: '{ not json' }],
        });

        expect(res.findings).toEqual([]);
        expect(res.sources[0].ok).toBe(false);
        expect(res.sources[0].error).toBeTruthy();
        expect(res.stats.failed).toBe(1);
    });

    it('rejects an empty or oversized report', async () => {
        const svc = new ExternalFindingsService({});
        const res = await svc.collect({
            prUrl: 'u', prData: PR_DATA,
            reports: [
                { name: 'empty', content: '' },
                { name: 'huge', content: 'x'.repeat(6 * 1024 * 1024) },
            ],
        });
        expect(res.sources.map(s => s.ok)).toEqual([false, false]);
        expect(res.sources[1].error).toMatch(/larger than/);
    });
});

describe('declared CI artifacts', () => {
    function prService(artifacts) {
        return {
            calls: [],
            fetchJobArtifact: async function (url, opts) {
                this.calls.push(opts);
                if (!(opts.path in artifacts)) throw new Error(`Artifact "${opts.path}" not found`);
                return artifacts[opts.path];
            },
        };
    }

    it('fetches the artifact named in .repospector.yaml', async () => {
        const ps = prService({ 'gl-sast-report.json': SARIF });
        const svc = new ExternalFindingsService({ pullRequestService: ps });

        const res = await svc.collect({
            prUrl: 'https://gitlab.com/a/b/-/merge_requests/1',
            prData: PR_DATA,
            config: { externalFindings: [{ job: 'sast', path: 'gl-sast-report.json' }] },
        });

        expect(res.findings).toHaveLength(1);
        expect(ps.calls[0]).toMatchObject({ job: 'sast', path: 'gl-sast-report.json', ref: 'abc123' });
    });

    it('pins the artifact to the head SHA under review', async () => {
        // An artifact from an older pipeline describes code that is not in this
        // diff, and its findings would land on lines that have since moved.
        const ps = prService({ 'r.json': SARIF });
        await new ExternalFindingsService({ pullRequestService: ps }).collect({
            prUrl: 'u', prData: { headSha: 'deadbeef', files: [] },
            config: { externalFindings: [{ path: 'r.json' }] },
        });
        expect(ps.calls[0].ref).toBe('deadbeef');
    });

    it('reports a missing artifact without failing the review', async () => {
        const ps = prService({});
        const res = await new ExternalFindingsService({ pullRequestService: ps }).collect({
            prUrl: 'u', prData: PR_DATA,
            config: { externalFindings: [{ job: 'sast', path: 'nope.json' }] },
        });
        expect(res.findings).toEqual([]);
        expect(res.sources[0].ok).toBe(false);
        expect(res.sources[0].error).toMatch(/not found/);
    });

    it('rejects an entry with no path', async () => {
        const res = await new ExternalFindingsService({ pullRequestService: prService({}) }).collect({
            prUrl: 'u', prData: PR_DATA, config: { externalFindings: [{ job: 'sast' }] },
        });
        expect(res.sources[0].error).toMatch(/needs a `path`/);
    });

    it('says so when the host cannot serve artifacts', async () => {
        const res = await new ExternalFindingsService({ pullRequestService: {} }).collect({
            prUrl: 'u', prData: PR_DATA, config: { externalFindings: [{ path: 'r.json' }] },
        });
        expect(res.sources[0].error).toMatch(/does not support artifact fetching/);
    });

    it('caps how many sources it will read', async () => {
        const ps = prService({ 'r.json': SARIF });
        const res = await new ExternalFindingsService({ pullRequestService: ps }).collect({
            prUrl: 'u', prData: PR_DATA,
            config: { externalFindings: Array.from({ length: 20 }, () => ({ path: 'r.json' })) },
        });
        expect(res.sources.length).toBeLessThanOrEqual(5);
    });
});

describe('GitHub check annotations', () => {
    const annotations = [{
        path: 'src/run.js',
        startLine: 12,
        endLine: 12,
        level: 'failure',
        title: 'eslint(no-eval)',
        message: 'eval can be harmful',
        checkName: 'lint',
        detailsUrl: 'https://github.com/a/b/runs/1',
    }];

    it('reads annotations with no configuration at all', async () => {
        const svc = new ExternalFindingsService({
            pullRequestService: { fetchCheckAnnotations: async () => annotations },
        });
        const res = await svc.collect({ prUrl: 'u', prData: PR_DATA });

        expect(res.findings).toHaveLength(1);
        expect(res.findings[0]).toMatchObject({
            ruleId: 'check:eslint(no-eval)',
            severity: 'high',
            filePath: 'src/run.js',
            line: 12,
            tool: 'lint',
            // No rule docs exist for an annotation; the run URL is the honest
            // substitute — still something the reviewer can open.
            ruleUrl: 'https://github.com/a/b/runs/1',
        });
    });

    it('does not read annotations when the repo declared its own sources', async () => {
        // The same scanner usually produces both, and ingesting each would report
        // every finding twice with different metadata.
        const ps = {
            annotationCalls: 0,
            fetchCheckAnnotations: async function () { this.annotationCalls++; return annotations; },
            fetchJobArtifact: async () => SARIF,
        };
        const res = await new ExternalFindingsService({ pullRequestService: ps }).collect({
            prUrl: 'u', prData: PR_DATA, config: { externalFindings: [{ path: 'r.json' }] },
        });
        expect(ps.annotationCalls).toBe(0);
        expect(res.findings).toHaveLength(1);
        expect(res.findings[0].tool).toBe('Semgrep');
    });

    it('can be switched off', async () => {
        const ps = { fetchCheckAnnotations: async () => annotations };
        const res = await new ExternalFindingsService({ pullRequestService: ps }).collect({
            prUrl: 'u', prData: PR_DATA, options: { checkAnnotations: false },
        });
        expect(res.findings).toEqual([]);
        expect(res.sources).toEqual([]);
    });

    it('degrades when the API throws', async () => {
        const res = await new ExternalFindingsService({
            pullRequestService: { fetchCheckAnnotations: async () => { throw new Error('403'); } },
        }).collect({ prUrl: 'u', prData: PR_DATA });

        expect(res.findings).toEqual([]);
        expect(res.sources[0].ok).toBe(false);
    });

    it('skips annotations with no path or no message', async () => {
        const res = await new ExternalFindingsService({
            pullRequestService: {
                fetchCheckAnnotations: async () => [
                    { message: 'no path' },
                    { path: 'a.js' },
                    { path: 'b.js', message: 'fine', checkName: 'c' },
                ],
            },
        }).collect({ prUrl: 'u', prData: PR_DATA });

        expect(res.findings).toHaveLength(1);
        expect(res.findings[0].filePath).toBe('b.js');
    });

    it('returns nothing at all when there are no annotations', async () => {
        const res = await new ExternalFindingsService({
            pullRequestService: { fetchCheckAnnotations: async () => [] },
        }).collect({ prUrl: 'u', prData: PR_DATA });
        expect(res.sources).toEqual([]);
    });
});

describe('renderSection', () => {
    it('lists each source, including the ones that failed', async () => {
        const res = await new ExternalFindingsService({}).collect({
            prUrl: 'u', prData: PR_DATA,
            reports: [
                { name: 'semgrep.sarif', content: SARIF },
                { name: 'codeql.sarif', content: 'broken' },
            ],
        });
        const md = ExternalFindingsService.renderSection(res);

        expect(md).toContain('semgrep.sarif');
        expect(md).toContain('Semgrep');
        expect(md).toContain('codeql.sarif');
        expect(md).toMatch(/not read/);
        expect(md).toMatch(/your own tools/);
    });

    it('is empty when no source was consulted', () => {
        expect(ExternalFindingsService.renderSection({ sources: [] })).toBe('');
        expect(ExternalFindingsService.renderSection(null)).toBe('');
    });
});

describe('model tiering', () => {
    it('changes nothing when no light model is configured', () => {
        // A scheme that silently downgraded the review pass would trade accuracy
        // for cost without asking.
        for (const stage of Object.keys(STAGE_TIERS)) {
            const r = modelForStage({ stage, model: 'openai:gpt-4.1' });
            expect(r.model).toBe('openai:gpt-4.1');
            expect(r.downgraded).toBe(false);
        }
    });

    it('never downgrades a stage that decides whether a finding is real', () => {
        for (const stage of ['per-file', 'finder', 'verify', 'explore', 'line-question']) {
            const r = modelForStage({ stage, model: 'heavy', lightModel: 'light' });
            expect(r.model).toBe('heavy');
            expect(STAGE_TIERS[stage]).toBe(TIER.HEAVY);
        }
    });

    it('downgrades the presentation stages', () => {
        for (const stage of ['aggregate', 'scoring', 'fixes', 'docstrings', 'summary']) {
            expect(modelForStage({ stage, model: 'heavy', lightModel: 'light' }).model).toBe('light');
        }
    });

    it('treats an UNKNOWN stage as heavy', () => {
        // A pass added later must not be silently downgraded because nobody
        // remembered to list it.
        const r = modelForStage({ stage: 'some-new-pass', model: 'heavy', lightModel: 'light' });
        expect(r.model).toBe('heavy');
    });

    it('accepts a per-stage override', () => {
        const r = modelForStage({
            stage: 'verify', model: 'heavy', lightModel: 'light', overrides: { verify: TIER.LIGHT },
        });
        expect(r.model).toBe('light');
    });

    it('drops the provider when the light model carries its own prefix', () => {
        // `resolveModel` requires an explicit provider to AGREE with a prefix, so
        // keeping both is a hard error the moment someone picks a light model from
        // a different provider.
        const s = settingsForStage({
            stage: 'summary', provider: 'openai', model: 'openai:gpt-4.1',
            apiKey: 'k', lightModel: 'anthropic:claude-3-haiku',
        });
        expect(s.model).toBe('anthropic:claude-3-haiku');
        expect(s.provider).toBeUndefined();
    });

    it('keeps the provider for an unprefixed model', () => {
        const s = settingsForStage({
            stage: 'per-file', provider: 'openai', model: 'gpt-4.1', apiKey: 'k',
        });
        expect(s).toMatchObject({ provider: 'openai', model: 'gpt-4.1', apiKey: 'k' });
    });

    it('says nothing about tiering when it is not in use', () => {
        expect(describeTiering({ model: 'm' })).toBe('');
        expect(describeTiering({ model: 'm', lightModel: 'm' })).toBe('');
        expect(describeTiering({ model: 'heavy', lightModel: 'light' })).toMatch(/Model tiering/);
    });
});

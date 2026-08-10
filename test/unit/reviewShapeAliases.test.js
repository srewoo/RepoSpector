/**
 * Finding-shape aliasing.
 *
 * A recurring bug class in this codebase: a consumer reads ONE key name for the
 * file path or the code snippet, static analysis and the LLM paths use different
 * ones, and the mismatch does not throw — the filter simply matches nothing and
 * the whole stage becomes dead code. These tests pin the aliases.
 */

const { PullRequestService } = require('../../src/services/PullRequestService.js');
const { FindingVerificationService } = require('../../src/services/FindingVerificationService.js');
const { CustomRulesService } = require('../../src/services/CustomRulesService.js');

describe('generateFixSuggestions accepts LLM finding shapes', () => {
    const llm = () => ({
        streamChat: jest.fn().mockResolvedValue({ content: 'const x = safe();' }),
    });

    it('generates a fix for a verified LLM finding (file + evidence)', async () => {
        // Filtered on `filePath` && `codeSnippet` — keys only static findings carry —
        // so for verified LLM findings this pass produced nothing at all.
        const svc = new PullRequestService();
        const service = llm();
        const findings = [{
            file: 'src/a.js', line: 10, evidence: 'const x = unsafe();', severity: 'high',
            title: 'Unsafe call',
        }];
        await svc.generateFixSuggestions(findings, service, {});
        expect(service.streamChat).toHaveBeenCalledTimes(1);
        expect(findings[0].suggestedFix).toBe('const x = safe();');
    });

    it('still generates a fix for a static finding (filePath + codeSnippet)', async () => {
        const svc = new PullRequestService();
        const service = llm();
        const findings = [{
            filePath: 'src/a.js', line: 10, codeSnippet: 'const x = unsafe();',
            severity: 'critical', message: 'Unsafe call',
        }];
        await svc.generateFixSuggestions(findings, service, {});
        expect(findings[0].suggestedFix).toBe('const x = safe();');
    });

    it('treats canonical `blocking` as fixable', async () => {
        const svc = new PullRequestService();
        const service = llm();
        const findings = [{
            file: 'src/a.js', line: 3, evidence: 'x == null', severity: 'blocking', title: 'Loose eq',
        }];
        await svc.generateFixSuggestions(findings, service, {});
        expect(findings[0].suggestedFix).toBeDefined();
    });

    it('skips non-blocking findings', async () => {
        const svc = new PullRequestService();
        const service = llm();
        const findings = [{ file: 'a.js', line: 1, evidence: 'x', severity: 'nitpick' }];
        await svc.generateFixSuggestions(findings, service, {});
        expect(service.streamChat).not.toHaveBeenCalled();
    });
});

describe('FindingVerificationService._buildDiffsByFile', () => {
    const svc = new FindingVerificationService({});

    it('reads the normalized shape', () => {
        expect(svc._buildDiffsByFile({ files: [{ filename: 'a.js', patch: 'P' }] })).toEqual({ 'a.js': 'P' });
    });

    it('reads raw GitLab shapes', () => {
        // An empty map means every gate sees patch === '' and fails open, which
        // silently disables the ONLY false-positive filter enabled by default.
        expect(svc._buildDiffsByFile({ files: [{ new_path: 'a.js', diff: 'P' }] })).toEqual({ 'a.js': 'P' });
    });

    it('reads a `path`/`file` keyed shape', () => {
        expect(svc._buildDiffsByFile({ files: [{ path: 'a.js', patch: 'P' }] })).toEqual({ 'a.js': 'P' });
        expect(svc._buildDiffsByFile({ files: [{ file: 'a.js', diff: 'P' }] })).toEqual({ 'a.js': 'P' });
    });

    it('tolerates missing input', () => {
        expect(svc._buildDiffsByFile(null)).toEqual({});
        expect(svc._buildDiffsByFile({ files: [{}, null] })).toEqual({});
    });
});

describe('formatReviewSummary includes canonical severities', () => {
    it('lists a cross-repo `blocking` finding in Key Findings', () => {
        // The table matched `critical|high|medium` literally, so every cross-repo
        // impact finding — emitted as canonical `blocking` — was omitted.
        const svc = new PullRequestService();
        const body = svc.formatReviewSummary({
            findings: [{
                severity: 'blocking', file: 'src/api.js', line: 12,
                message: 'Breaking change to `getUser`',
            }],
        }, null);
        expect(body).toContain('Key Findings');
        expect(body).toContain('Breaking change to `getUser`');
    });
});

describe('CustomRulesService.fetchConfig host and ref handling', () => {
    afterEach(() => { global.fetch = undefined; });

    it('targets the self-hosted API base and the full subgroup path', async () => {
        const calls = [];
        global.fetch = jest.fn(async (url) => {
            calls.push(url);
            return { ok: false, status: 404, text: async () => '' };
        });

        const svc = new CustomRulesService();
        await svc.fetchConfig('gitlab', 'eng/platform', 'core', 'tok', {
            projectPath: 'eng/platform/core',
            apiBase: 'https://gitlab.internal.acme.com/api/v4',
        });

        // Hardcoded `https://gitlab.com/api/v4` + `${owner}/${repo}` meant an
        // internal subgroup repo could never load its config.
        expect(calls[0]).toContain('https://gitlab.internal.acme.com/api/v4');
        expect(calls[0]).toContain(encodeURIComponent('eng/platform/core'));
    });

    it('tries more than just ref=main', async () => {
        const refs = new Set();
        global.fetch = jest.fn(async (url) => {
            const m = String(url).match(/ref=([^&]+)/);
            if (m) refs.add(decodeURIComponent(m[1]));
            return { ok: false, status: 404, text: async () => '' };
        });

        const svc = new CustomRulesService();
        await svc.fetchConfig('gitlab', 'acme', 'widgets', null, {
            apiBase: 'https://gitlab.com/api/v4',
        });

        // A repo whose default branch is master/develop silently had no config.
        expect(refs.has('main')).toBe(true);
        expect(refs.has('master')).toBe(true);
    });

    it('returns the config on the first ref that resolves', async () => {
        global.fetch = jest.fn(async (url) => {
            const ok = String(url).includes('ref=master');
            return { ok, status: ok ? 200 : 404, text: async () => 'severityThreshold: high\n' };
        });

        const svc = new CustomRulesService();
        const cfg = await svc.fetchConfig('gitlab', 'acme', 'widgets', null, {
            apiBase: 'https://gitlab.com/api/v4',
        });
        expect(cfg).toBeTruthy();
    });
});

/**
 * Tests for the extracted settings / validate / finding-followup handlers
 * (src/background/handlers/settingsHandlers.js), using a mock svc.
 */

const { createSettingsHandlers } = require('../../src/background/handlers/settingsHandlers.js');

class FakeFollowup {
    constructor({ llmService }) { this.llmService = llmService; }
    async explain() { return { kind: 'explain' }; }
    async suggestFix() { return { kind: 'fix' }; }
}

function makeSvc(overrides = {}) {
    return {
        errorHandler: { logError: jest.fn() },
        getErrorMessage: (e) => e.message,
        encryptionService: {
            encrypt: jest.fn(async (v) => `enc(${v})`),
            decrypt: jest.fn(async (v) => v.replace(/^enc\((.*)\)$/, '$1')),
        },
        ragService: { apiKey: null },
        githubService: { token: null },
        gitlabService: { token: null },
        ensureRagEmbeddingProvider: jest.fn(async () => {}),
        getStoredSettings: jest.fn(async () => ({ apiKey: 'sk-x', provider: 'openai', model: 'gpt-4.1-mini' })),
        llmService: {},
        findingFollowupService: null,
        ...overrides,
    };
}

function build(svc) {
    return createSettingsHandlers({ svc, FindingFollowupService: FakeFollowup });
}

describe('settingsHandlers', () => {
    afterEach(() => { global.fetch.mockReset?.(); });

    it('exposes the expected message types', () => {
        expect(Object.keys(build(makeSvc())).sort()).toEqual(
            ['EXPLAIN_FINDING', 'FETCH_MODELS', 'GET_SETTINGS', 'PROBE_OLLAMA', 'SAVE_SETTINGS', 'SUGGEST_FIX', 'TEST_GIT_TOKEN', 'VALIDATE_API_KEY']);
    });

    describe('PROBE_OLLAMA', () => {
        it('answers "is Ollama reachable" without a model selected, unlike VALIDATE_API_KEY', async () => {
            global.fetch = jest.fn(async () => ({
                ok: true,
                json: async () => ({ models: [{ name: 'qwen2.5-coder:7b' }] }),
            }));
            const send = jest.fn();
            await build(makeSvc()).PROBE_OLLAMA({ data: {} }, send);

            expect(global.fetch).toHaveBeenCalledWith(
                'http://localhost:11434/api/tags',
                expect.objectContaining({ method: 'GET' }),
            );
            const response = send.mock.calls[0][0];
            expect(response.success).toBe(true);
            expect(response.verdict).toBe('ok');
        });

        it('reports not_running without throwing when nothing answers', async () => {
            global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
            const send = jest.fn();
            await build(makeSvc()).PROBE_OLLAMA({ data: {} }, send);

            const response = send.mock.calls[0][0];
            expect(response.success).toBe(true);
            expect(response.verdict).toBe('not_running');
        });
    });


    describe('TEST_GIT_TOKEN', () => {
        const call = async (data, fetchImpl) => {
            global.fetch = fetchImpl;
            const send = jest.fn();
            await build(makeSvc()).TEST_GIT_TOKEN({ data }, send);
            return send.mock.calls[0][0];
        };

        const okResponse = (body = {}, headers = {}) => jest.fn(async () => ({
            ok: true,
            status: 200,
            headers: { get: (h) => headers[h.toLowerCase()] ?? null },
            json: async () => body,
        }));

        it('tests what is typed rather than what is stored, so a token can be checked before saving', async () => {
            const fetchImpl = okResponse({ login: 'octocat' }, { 'x-oauth-scopes': 'repo, gist' });
            const res = await call({ platform: 'github', token: 'ghp_typed' }, fetchImpl);

            const [url, init] = fetchImpl.mock.calls[0];
            expect(url).toBe('https://api.github.com/user');
            expect(init.headers.Authorization).toBe('Bearer ghp_typed');
            expect(res.success).toBe(true);
            expect(res.state).toBe('ok');
            expect(res.message).toContain('octocat');
        });

        it('reports a GitHub token missing "repo" scope as valid-but-limited, not as working', async () => {
            const res = await call(
                { platform: 'github', token: 'ghp_x' },
                okResponse({ login: 'octocat' }, { 'x-oauth-scopes': 'gist, read:org' }),
            );
            expect(res.state).toBe('scope-insufficient');
            expect(res.keyProven).toBe(true);
        });

        it('sends the GitLab token in the PRIVATE-TOKEN header, not as a bearer', async () => {
            const fetchImpl = okResponse({ username: 'sharaj' });
            const res = await call({ platform: 'gitlab', token: 'glpat_x' }, fetchImpl);

            const [url, init] = fetchImpl.mock.calls[0];
            expect(url).toBe('https://gitlab.com/api/v4/user');
            expect(init.headers['PRIVATE-TOKEN']).toBe('glpat_x');
            expect(init.headers.Authorization).toBeUndefined();
            expect(res.message).toContain('sharaj');
        });

        it('uses Basic auth over email:token for Jira and strips a trailing slash from the site', async () => {
            const fetchImpl = okResponse({ displayName: 'Sharaj R' });
            const res = await call(
                { platform: 'jira', baseUrl: 'https://team.atlassian.net/', email: 'a@b.com', token: 'jt' },
                fetchImpl,
            );

            const [url, init] = fetchImpl.mock.calls[0];
            expect(url).toBe('https://team.atlassian.net/rest/api/3/myself');
            expect(init.headers.Authorization).toBe(`Basic ${btoa('a@b.com:jt')}`);
            expect(res.state).toBe('ok');
            expect(res.message).toContain('Sharaj R');
        });

        it('refuses Jira without all three fields instead of firing a doomed request', async () => {
            const fetchImpl = okResponse();
            const res = await call({ platform: 'jira', baseUrl: 'https://team.atlassian.net' }, fetchImpl);
            expect(fetchImpl).not.toHaveBeenCalled();
            expect(res.success).toBe(true);
            expect(res.message).toMatch(/all three/i);
        });

        it('honours a GitHub Enterprise host so the test hits the API the review would', async () => {
            const fetchImpl = okResponse({ login: 'ghe-user' });
            await call({ platform: 'github', token: 't', baseUrl: 'https://github.acme.com' }, fetchImpl);
            expect(fetchImpl.mock.calls[0][0]).toBe('https://github.acme.com/api/v3/user');
        });

        it('reports a thrown request as unreachable, never as an invalid token', async () => {
            const res = await call(
                { platform: 'github', token: 't' },
                jest.fn(async () => { throw new Error('Failed to fetch'); }),
            );
            expect(res.state).toBe('unreachable');
            expect(res.keyProven).toBe(false);
        });

        it('still reports success when the body cannot be parsed', async () => {
            const res = await call({ platform: 'gitlab', token: 't' }, jest.fn(async () => ({
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: async () => { throw new Error('not json'); },
            })));
            expect(res.state).toBe('ok');
        });
    });

    describe('VALIDATE_API_KEY', () => {
        // Was a hardcoded GET to api.openai.com/v1/models, which reported every
        // non-OpenAI key as invalid and proved nothing about invoke access even
        // for OpenAI. It now sends the smallest real request the review would
        // send, to the provider and model actually selected.
        const chatOk = () => jest.fn(async () => ({
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'OK' } }], usage: {} }),
        }));

        it('probes the selected provider and model, not OpenAI', async () => {
            global.fetch = chatOk();
            const send = jest.fn();
            await build(makeSvc()).VALIDATE_API_KEY(
                { data: { provider: 'nvidia', model: 'nvidia:meta/llama-3.3-70b-instruct', apiKey: 'nvapi-x' } },
                send,
            );

            const [url, init] = global.fetch.mock.calls[0];
            expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
            expect(init.headers.Authorization).toBe('Bearer nvapi-x');
            // A probe must be cheap enough that pressing the button is free.
            expect(JSON.parse(init.body).max_tokens).toBe(16);

            expect(send).toHaveBeenCalledWith(expect.objectContaining({
                success: true, state: 'ok', keyProven: true,
            }));
        });

        it('falls back to the stored key when the field is masked', async () => {
            global.fetch = chatOk();
            const send = jest.fn();
            // The popup never gets the stored secret back, so it sends ''.
            await build(makeSvc()).VALIDATE_API_KEY(
                { data: { provider: 'openai', model: 'openai:gpt-4.1-mini', apiKey: '' } },
                send,
            );
            expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-x');
            expect(send).toHaveBeenCalledWith(expect.objectContaining({ keyProven: true }));
        });

        it('says a key is missing without calling the provider', async () => {
            global.fetch = jest.fn();
            const send = jest.fn();
            const svc = makeSvc({ getStoredSettings: jest.fn(async () => ({})) });
            await build(svc).VALIDATE_API_KEY(
                { data: { provider: 'openai', model: 'openai:gpt-4.1-mini', apiKey: '' } },
                send,
            );
            expect(global.fetch).not.toHaveBeenCalled();
            expect(send).toHaveBeenCalledWith(expect.objectContaining({
                state: 'key-invalid', keyProven: false, message: 'Enter an API key first.',
            }));
        });

        it('reports a rejected key as a verdict, not as a failed request', async () => {
            global.fetch = jest.fn(async () => ({
                ok: false, status: 401, text: async () => 'invalid api key',
            }));
            const send = jest.fn();
            await build(makeSvc()).VALIDATE_API_KEY(
                { data: { provider: 'openai', model: 'openai:gpt-4.1-mini', apiKey: 'sk-bad' } },
                send,
            );
            // `success: true` — the test RAN. The popup renders the verdict
            // rather than a generic "the request failed".
            expect(send).toHaveBeenCalledWith(expect.objectContaining({
                success: true, state: 'key-invalid', keyProven: false, status: 401,
            }));
        });

        it('distinguishes an out-of-credit account from a bad key', async () => {
            global.fetch = jest.fn(async () => ({
                ok: false, status: 402, text: async () => 'insufficient credits',
            }));
            const send = jest.fn();
            await build(makeSvc()).VALIDATE_API_KEY(
                { data: { provider: 'openrouter', model: 'openrouter:openai/gpt-4o', apiKey: 'sk-or-v1-x' } },
                send,
            );
            expect(send).toHaveBeenCalledWith(expect.objectContaining({
                state: 'billing', keyProven: true,
            }));
        });

        it('does not retry: one press is one request', async () => {
            global.fetch = jest.fn(async () => ({
                ok: false, status: 503, text: async () => 'unavailable',
            }));
            const send = jest.fn();
            await build(makeSvc()).VALIDATE_API_KEY(
                { data: { provider: 'openai', model: 'openai:gpt-4.1-mini', apiKey: 'sk-x' } },
                send,
            );
            // A 503 is retryable in the review path; here it would only make the
            // user wait ~30s to be told what the first response already said.
            expect(global.fetch).toHaveBeenCalledTimes(1);
            expect(send).toHaveBeenCalledWith(expect.objectContaining({ state: 'unreachable' }));
        });

        it('gives a reasoning model room to answer, in the parameter it accepts', async () => {
            global.fetch = chatOk();
            const send = jest.fn();
            await build(makeSvc()).VALIDATE_API_KEY(
                { data: { provider: 'openai', model: 'openai:o4-mini', apiKey: 'sk-x' } },
                send,
            );

            const body = JSON.parse(global.fetch.mock.calls[0][1].body);
            // A 16-token cap is spent entirely on reasoning, so the probe would
            // report "empty reply" for a call that worked perfectly.
            expect(body.max_completion_tokens).toBe(256);
            // And `max_tokens` on this family is a flat 400 — which the probe
            // would have reported as a model problem on a working key.
            expect(body).not.toHaveProperty('max_tokens');
            expect(send).toHaveBeenCalledWith(expect.objectContaining({ state: 'ok' }));
        });

        it('refuses to probe when no model is selected', async () => {
            global.fetch = jest.fn();
            const send = jest.fn();
            await build(makeSvc()).VALIDATE_API_KEY(
                { data: { provider: 'openai', model: '', apiKey: 'sk-x' } },
                send,
            );
            expect(global.fetch).not.toHaveBeenCalled();
            expect(send).toHaveBeenCalledWith(expect.objectContaining({ keyProven: false }));
        });
    });

    describe('SAVE_SETTINGS', () => {
        it('encrypts sensitive keys, updates tokens, and applies embedding provider', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await build(svc).SAVE_SETTINGS(
                { data: { settings: { apiKey: 'sk-live', githubToken: 'ghp_x', theme: 'dark' } } }, send);
            // sensitive keys encrypted before storage
            expect(svc.encryptionService.encrypt).toHaveBeenCalledWith('sk-live');
            expect(svc.encryptionService.encrypt).toHaveBeenCalledWith('ghp_x');
            expect(chrome.storage.local.set).toHaveBeenCalled();
            // RAG + platform tokens updated (decrypted)
            expect(svc.ragService.apiKey).toBe('sk-live');
            expect(svc.githubService.token).toBe('ghp_x');
            expect(svc.ensureRagEmbeddingProvider).toHaveBeenCalled();
            expect(send).toHaveBeenCalledWith({ success: true });
        });
    });

    describe('GET_SETTINGS', () => {
        it('returns stored settings', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await build(svc).GET_SETTINGS({}, send);
            expect(send).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ apiKey: 'sk-x' }) });
        });
    });

    describe('finding follow-up', () => {
        it('EXPLAIN_FINDING calls explain and returns the result', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await build(svc).EXPLAIN_FINDING({ data: { finding: { id: 1 }, code: 'x' } }, send);
            expect(send).toHaveBeenCalledWith({ success: true, data: { kind: 'explain' } });
        });

        it('SUGGEST_FIX calls suggestFix', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await build(svc).SUGGEST_FIX({ data: { finding: { id: 1 } } }, send);
            expect(send).toHaveBeenCalledWith({ success: true, data: { kind: 'fix' } });
        });

        it('requires a finding', async () => {
            const send = jest.fn();
            await build(makeSvc()).EXPLAIN_FINDING({ data: {} }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'finding required' });
        });

        it('requires a configured API key', async () => {
            const svc = makeSvc({ getStoredSettings: jest.fn(async () => ({})) });
            const send = jest.fn();
            await build(svc).EXPLAIN_FINDING({ data: { finding: { id: 1 } } }, send);
            expect(send).toHaveBeenCalledWith({
                success: false,
                error: expect.stringContaining('No API key configured'),
            });
        });

        // A keyless provider has no apiKey by design, and callOllama /
        // callChromeAI ignore the argument entirely. Gating on the key alone
        // made follow-ups unreachable for exactly the users the keyless work
        // was for, so these two pin that the gate is provider-aware.
        it.each(['local', 'chrome-ai'])(
            'does NOT require an API key for the keyless provider %s',
            async (provider) => {
                const svc = makeSvc({ getStoredSettings: jest.fn(async () => ({ provider })) });
                const send = jest.fn();
                await build(svc).EXPLAIN_FINDING({ data: { finding: { id: 1 } } }, send);
                expect(send).toHaveBeenCalledWith({ success: true, data: { kind: 'explain' } });
            },
        );

        it('still requires an API key for a keyed provider', async () => {
            const svc = makeSvc({ getStoredSettings: jest.fn(async () => ({ provider: 'openai' })) });
            const send = jest.fn();
            await build(svc).EXPLAIN_FINDING({ data: { finding: { id: 1 } } }, send);
            expect(send).toHaveBeenCalledWith({
                success: false,
                error: expect.stringContaining('No API key configured'),
            });
        });
    });
});

const { ensureHostAccess } = require('../../src/background/handlers/settingsHandlers.js');

describe('ensureHostAccess with both forges', () => {
    const ORIGINAL_CHROME = global.chrome;

    beforeEach(() => {
        global.chrome = {
            permissions: {
                contains: jest.fn().mockResolvedValue(false),
                request: jest.fn().mockResolvedValue(true),
            },
            scripting: {
                unregisterContentScripts: jest.fn().mockResolvedValue(undefined),
                registerContentScripts: jest.fn().mockResolvedValue(undefined),
            },
        };
    });

    afterEach(() => {
        // Restore so a test appended later in the file (or run in the same
        // worker) doesn't silently inherit this block's chrome stub.
        if (ORIGINAL_CHROME === undefined) {
            delete global.chrome;
        } else {
            global.chrome = ORIGINAL_CHROME;
        }
    });

    it('requests exactly the two non-public origins, each once', async () => {
        const out = await ensureHostAccess({
            gitlabHosts: 'gitlab.acme.com',
            githubHosts: 'github.acme.com',
        });
        expect(out.granted).toBe(true);
        expect(chrome.permissions.request).toHaveBeenCalledWith({
            origins: ['https://gitlab.acme.com/*', 'https://github.acme.com/*'],
        });
    });

    it('dedupes a host that appears in both lists to a single origin', async () => {
        const out = await ensureHostAccess({
            gitlabHosts: 'code.acme.com',
            githubHosts: 'code.acme.com',
        });
        expect(out.hosts).toEqual(['code.acme.com']);
        expect(chrome.permissions.request).toHaveBeenCalledWith({
            origins: ['https://code.acme.com/*'],
        });
    });

    it('filters the public hosts of both forges', async () => {
        const out = await ensureHostAccess({
            gitlabHosts: 'gitlab.com',
            githubHosts: 'github.com',
        });
        expect(out.hosts).toEqual([]);
        expect(chrome.permissions.request).not.toHaveBeenCalled();
    });

    it('still accepts a bare GitLab list, as before', async () => {
        const out = await ensureHostAccess('gitlab.acme.com');
        expect(out.granted).toBe(true);
        expect(out.hosts).toEqual(['gitlab.acme.com']);
    });

    it('does not fail the save when the user rejects the prompt', async () => {
        chrome.permissions.request.mockResolvedValue(false);
        const out = await ensureHostAccess({ githubHosts: 'github.acme.com' });
        expect(out.granted).toBe(false);
        expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
    });

    it('does not tear down an existing registration when a NEW non-empty list is rejected', async () => {
        // github.acme.com is already granted and working.
        await ensureHostAccess({ githubHosts: 'github.acme.com' });
        chrome.scripting.unregisterContentScripts.mockClear();
        chrome.scripting.registerContentScripts.mockClear();

        // Adding a GitLab host in the same save; the combined prompt is denied.
        chrome.permissions.contains.mockResolvedValue(false);
        chrome.permissions.request.mockResolvedValue(false);
        const out = await ensureHostAccess({
            gitlabHosts: 'gitlab.acme.com',
            githubHosts: 'github.acme.com',
        });

        expect(out.granted).toBe(false);
        expect(chrome.scripting.unregisterContentScripts).not.toHaveBeenCalled();
        expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
    });

    it('unregisters the content script when the host list becomes empty', async () => {
        await ensureHostAccess({ githubHosts: 'github.acme.com' });
        chrome.scripting.unregisterContentScripts.mockClear();
        chrome.scripting.registerContentScripts.mockClear();

        const out = await ensureHostAccess({ githubHosts: '' });

        expect(out).toEqual({ granted: false, hosts: [] });
        expect(chrome.scripting.unregisterContentScripts)
            .toHaveBeenCalledWith({ ids: ['repospector-selfhosted'] });
        expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
    });
});

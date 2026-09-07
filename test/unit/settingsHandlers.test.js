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
            ['EXPLAIN_FINDING', 'FETCH_MODELS', 'GET_SETTINGS', 'SAVE_SETTINGS', 'SUGGEST_FIX', 'VALIDATE_API_KEY']);
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
            expect(send).toHaveBeenCalledWith({ success: false, error: 'LLM API key not configured' });
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

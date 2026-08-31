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
        it('reports valid when the OpenAI models endpoint returns ok', async () => {
            global.fetch = jest.fn(async () => ({ ok: true }));
            const send = jest.fn();
            await build(makeSvc()).VALIDATE_API_KEY({ data: { apiKey: 'sk-x' } }, send);
            expect(send).toHaveBeenCalledWith({ success: true, valid: true });
        });

        it('reports invalid when the request throws', async () => {
            global.fetch = jest.fn(async () => { throw new Error('network'); });
            const send = jest.fn();
            await build(makeSvc()).VALIDATE_API_KEY({ data: { apiKey: 'sk-x' } }, send);
            expect(send).toHaveBeenCalledWith({ success: false, valid: false, error: 'network' });
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

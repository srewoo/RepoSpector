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
            ['EXPLAIN_FINDING', 'GET_SETTINGS', 'SAVE_SETTINGS', 'SUGGEST_FIX', 'VALIDATE_API_KEY']);
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

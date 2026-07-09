/**
 * Tests for the extracted chat-with-code handler
 * (src/background/handlers/chatHandlers.js). Uses a mock svc + mock chrome so the
 * handler is exercised without instantiating the whole BackgroundService or
 * performing real I/O.
 */

const { createChatHandlers } = require('../../src/background/handlers/chatHandlers.js');

function makeSvc(overrides = {}) {
    return {
        registerActiveTab: jest.fn(),
        unregisterActiveTab: jest.fn(),
        getStoredSettings: jest.fn(async () => ({ apiKey: 'sk-test', model: 'gpt-4.1-mini' })),
        languageDetector: { detect: jest.fn(() => ({ language: 'javascript' })) },
        contextAnalyzer: {
            extractRepoIdFromUrl: jest.fn(() => 'owner/repo'),
            buildSmartRAGQuery: jest.fn(() => 'context'),
        },
        ragService: null,
        codeGraphPipeline: null,
        getModelId: jest.fn(() => 'gpt-4.1-mini'),
        buildChatMessages: jest.fn(() => [{ role: 'user', content: 'q' }]),
        callOpenAI: jest.fn(async () => 'assistant answer'),
        _lastTruncationInfo: null,
        errorHandler: { logError: jest.fn() },
        getErrorMessage: (e) => e.message,
        ...overrides,
    };
}

function setupChrome({ extraction } = {}) {
    global.chrome = {
        tabs: {
            sendMessage: jest.fn(async () => extraction || {
                success: true,
                data: { code: 'const x = 1;', context: { url: 'https://github.com/owner/repo', platform: 'github', filePath: 'a.js' } },
            }),
            get: jest.fn(async () => ({ url: 'https://github.com/owner/repo' })),
        },
    };
}

describe('chatHandlers', () => {
    afterEach(() => {
        delete global.chrome;
        jest.clearAllMocks();
    });

    it('should register the CHAT_WITH_CODE message type', () => {
        const h = createChatHandlers(makeSvc());
        expect(Object.keys(h)).toEqual(['CHAT_WITH_CODE']);
        expect(typeof h.CHAT_WITH_CODE).toBe('function');
    });

    it('CHAT_WITH_CODE delegates and responds with success on the happy path', async () => {
        setupChrome();
        const svc = makeSvc();
        const send = jest.fn();
        const message = { payload: { tabId: 42, question: 'What does this do?', conversationHistory: [], useDeepContext: false } };

        await createChatHandlers(svc).CHAT_WITH_CODE(message, send, { tab: { id: 42 } });

        expect(svc.registerActiveTab).toHaveBeenCalledWith(42, 'code_chat');
        expect(svc.getStoredSettings).toHaveBeenCalled();
        expect(svc.buildChatMessages).toHaveBeenCalled();
        expect(svc.callOpenAI).toHaveBeenCalled();
        expect(svc.unregisterActiveTab).toHaveBeenCalledWith(42);
        expect(send).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            response: 'assistant answer',
            languageDetection: { language: 'javascript' },
        }));
    });

    it('responds with an error when no tabId is provided', async () => {
        setupChrome();
        const svc = makeSvc();
        const send = jest.fn();

        await createChatHandlers(svc).CHAT_WITH_CODE({ payload: { question: 'hi' } }, send, {});

        expect(svc.callOpenAI).not.toHaveBeenCalled();
        expect(svc.errorHandler.logError).toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith({ success: false, error: 'No tab ID provided' });
    });

    it('responds with an error when the API key is missing', async () => {
        setupChrome();
        const svc = makeSvc({ getStoredSettings: jest.fn(async () => ({})) });
        const send = jest.fn();

        await createChatHandlers(svc).CHAT_WITH_CODE({ payload: { tabId: 7, question: 'hi' } }, send, { tab: { id: 7 } });

        expect(svc.callOpenAI).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
        expect(send.mock.calls[0][0].error).toMatch(/API key/i);
    });
});

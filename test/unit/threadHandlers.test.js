/**
 * Tests for the extracted PR-thread handlers
 * (src/background/handlers/threadHandlers.js), using a mock svc.
 */

const { createThreadHandlers } = require('../../src/background/handlers/threadHandlers.js');

function makeSvc(overrides = {}) {
    const threads = new Map();
    return {
        errorHandler: { logError: jest.fn() },
        getErrorMessage: (e) => e.message,
        getStoredSettings: jest.fn(async () => ({ provider: 'openai', model: 'm', apiKey: 'sk-x' })),
        llmService: { streamChat: jest.fn(async () => ({ content: 'AI reply' })) },
        prSessionManager: {
            getSession: jest.fn(async () => null),
            createSession: jest.fn(async (pr) => ({ id: 's1', prIdentifier: pr })),
            getRecentSessions: jest.fn(async () => []),
        },
        prThreadManager: {
            _threads: threads,
            createThread: jest.fn(async (pr, finding) => {
                const t = { threadId: 't1', prIdentifier: pr, finding, messages: [] };
                threads.set('t1', t);
                return t;
            }),
            getThread: jest.fn(async (id) => threads.get(id) || null),
            addMessage: jest.fn(async (id, m) => { threads.get(id)?.messages.push(m); }),
            getConversationContext: jest.fn(async () => ({ messages: [] })),
            updateStatus: jest.fn(async () => true),
            getThreadsForPR: jest.fn(async () => []),
        },
        ...overrides,
    };
}

describe('threadHandlers', () => {
    it('registers the expected message types', () => {
        expect(Object.keys(createThreadHandlers(makeSvc())).sort()).toEqual([
            'CREATE_PR_THREAD', 'GET_OR_CREATE_THREAD', 'GET_PR_SESSION', 'GET_PR_THREAD',
            'SEND_THREAD_MESSAGE', 'THREAD_QUICK_ACTION', 'UPDATE_THREAD_STATUS',
        ]);
    });

    describe('CREATE_PR_THREAD', () => {
        it('requires a PR identifier', async () => {
            const send = jest.fn();
            await createThreadHandlers(makeSvc()).CREATE_PR_THREAD({ data: {} }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'PR identifier is required' });
        });

        it('creates a session + thread and returns the thread', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createThreadHandlers(svc).CREATE_PR_THREAD(
                { data: { prIdentifier: { url: 'u' }, finding: { id: 'f1' } } }, send);
            expect(svc.prSessionManager.createSession).toHaveBeenCalled();
            expect(svc.prThreadManager.createThread).toHaveBeenCalled();
            expect(send).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ threadId: 't1' }) });
        });

        it('processes an initial question through the LLM', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createThreadHandlers(svc).CREATE_PR_THREAD(
                { data: { prIdentifier: { url: 'u' }, finding: { id: 'f1' }, initialQuestion: 'why?' } }, send);
            expect(svc.llmService.streamChat).toHaveBeenCalled();
        });
    });

    describe('SEND_THREAD_MESSAGE', () => {
        it('validates required fields', async () => {
            const send = jest.fn();
            await createThreadHandlers(makeSvc()).SEND_THREAD_MESSAGE({ data: { threadId: 't1' } }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'Thread ID and message are required' });
        });

        it('adds the user message and returns an AI response', async () => {
            const svc = makeSvc();
            await svc.prThreadManager.createThread({ url: 'u' }, { id: 'f1' });
            const send = jest.fn();
            await createThreadHandlers(svc).SEND_THREAD_MESSAGE(
                { data: { threadId: 't1', message: 'hello' } }, send);
            expect(svc.prThreadManager.addMessage).toHaveBeenCalledWith('t1', expect.objectContaining({ role: 'user', content: 'hello' }));
            const arg = send.mock.calls[0][0];
            expect(arg.success).toBe(true);
            expect(arg.data.response).toBe('AI reply');
        });
    });

    describe('THREAD_QUICK_ACTION', () => {
        it('builds a prompt per action type and returns a response', async () => {
            const svc = makeSvc();
            await svc.prThreadManager.createThread({ url: 'u' }, { id: 'f1', message: 'bug' });
            const send = jest.fn();
            await createThreadHandlers(svc).THREAD_QUICK_ACTION(
                { data: { threadId: 't1', actionType: 'explain' } }, send);
            expect(svc.llmService.streamChat).toHaveBeenCalled();
            expect(send.mock.calls[0][0].success).toBe(true);
        });
    });

    describe('UPDATE_THREAD_STATUS', () => {
        it('rejects invalid statuses', async () => {
            const send = jest.fn();
            await createThreadHandlers(makeSvc()).UPDATE_THREAD_STATUS(
                { data: { threadId: 't1', status: 'bogus' } }, send);
            expect(send.mock.calls[0][0].success).toBe(false);
            expect(send.mock.calls[0][0].error).toMatch(/Invalid status/);
        });

        it('updates a valid status', async () => {
            const svc = makeSvc();
            await svc.prThreadManager.createThread({ url: 'u' }, { id: 'f1' });
            const send = jest.fn();
            await createThreadHandlers(svc).UPDATE_THREAD_STATUS(
                { data: { threadId: 't1', status: 'resolved' } }, send);
            expect(svc.prThreadManager.updateStatus).toHaveBeenCalledWith('t1', 'resolved');
            expect(send.mock.calls[0][0].success).toBe(true);
        });
    });
});

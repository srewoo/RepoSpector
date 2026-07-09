/**
 * Tests for the extracted context / diff / progress / tab-id / cancel handlers
 * (src/background/handlers/contextHandlers.js). Uses a mock svc so the handlers
 * are exercised without instantiating the whole BackgroundService.
 */

const { createContextHandlers } = require('../../src/background/handlers/contextHandlers.js');

function makeSvc(overrides = {}) {
    return {
        errorHandler: { logError: jest.fn() },
        getErrorMessage: (e) => e.message,
        contextAnalyzer: {
            analyzeWithContext: jest.fn(async () => ({ summary: 'ctx' })),
        },
        cancelRequest: jest.fn(),
        isProcessing: false,
        processingQueue: [],
        ...overrides,
    };
}

describe('contextHandlers', () => {
    it('should register the expected message types', () => {
        const h = createContextHandlers(makeSvc());
        expect(Object.keys(h).sort()).toEqual([
            'ANALYZE_CONTEXT', 'CANCEL_REQUEST', 'GET_PROGRESS',
            'GET_TAB_ID', 'PROCESS_DIFF',
        ]);
    });

    describe('ANALYZE_CONTEXT', () => {
        it('returns analyzed context on success', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createContextHandlers(svc).ANALYZE_CONTEXT(
                { data: { code: 'x', url: 'u', level: 'deep' } }, send);
            expect(svc.contextAnalyzer.analyzeWithContext).toHaveBeenCalledWith('x', { url: 'u', level: 'deep' });
            expect(send).toHaveBeenCalledWith({ success: true, data: { summary: 'ctx' } });
        });

        it('defaults level to smart', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createContextHandlers(svc).ANALYZE_CONTEXT({ data: { code: 'x', url: 'u' } }, send);
            expect(svc.contextAnalyzer.analyzeWithContext).toHaveBeenCalledWith('x', { url: 'u', level: 'smart' });
        });

        it('reports errors via errorHandler + getErrorMessage', async () => {
            const svc = makeSvc();
            svc.contextAnalyzer.analyzeWithContext = jest.fn(async () => { throw new Error('boom'); });
            const send = jest.fn();
            await createContextHandlers(svc).ANALYZE_CONTEXT({ data: {} }, send);
            expect(svc.errorHandler.logError).toHaveBeenCalled();
            expect(send).toHaveBeenCalledWith({ success: false, error: 'boom' });
        });
    });

    describe('PROCESS_DIFF', () => {
        it('analyzes with isDiff flag', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createContextHandlers(svc).PROCESS_DIFF({ data: { diffContent: 'd', url: 'u' } }, send);
            expect(svc.contextAnalyzer.analyzeWithContext).toHaveBeenCalledWith('d', { url: 'u', level: 'smart', isDiff: true });
            expect(send).toHaveBeenCalledWith({ success: true, data: { summary: 'ctx' } });
        });
    });

    describe('GET_PROGRESS', () => {
        it('reports processing state and queue length', async () => {
            const svc = makeSvc({ isProcessing: true, processingQueue: [1, 2] });
            const send = jest.fn();
            await createContextHandlers(svc).GET_PROGRESS({}, send);
            expect(send).toHaveBeenCalledWith({ success: true, data: { isProcessing: true, queueLength: 2 } });
        });
    });

    describe('GET_TAB_ID', () => {
        it('returns the sender tab id (router passes sender as 3rd arg)', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createContextHandlers(svc).GET_TAB_ID({}, send, { tab: { id: 42 } });
            expect(send).toHaveBeenCalledWith({ success: true, tabId: 42 });
        });
    });

    describe('CANCEL_REQUEST', () => {
        it('cancels a valid request', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createContextHandlers(svc).CANCEL_REQUEST({ data: { requestId: 'r1' } }, send);
            expect(svc.cancelRequest).toHaveBeenCalledWith('r1');
            expect(send).toHaveBeenCalledWith({ success: true, message: 'Request cancelled' });
        });

        it('validates that requestId is required', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createContextHandlers(svc).CANCEL_REQUEST({ data: {} }, send);
            expect(svc.cancelRequest).not.toHaveBeenCalled();
            expect(send).toHaveBeenCalledWith({ success: false, error: 'Request ID is required' });
        });
    });
});

/**
 * Tests for the extracted finding-cache + telemetry handlers
 * (src/background/handlers/cacheTelemetryHandlers.js). Uses a mock svc so the
 * handlers are exercised without instantiating the whole BackgroundService.
 */

const { createCacheTelemetryHandlers } = require('../../src/background/handlers/cacheTelemetryHandlers.js');

function makeSvc(overrides = {}) {
    return {
        errorHandler: { logError: jest.fn() },
        getErrorMessage: (e) => e.message,
        telemetry: {
            isEnabled: jest.fn(async () => true),
            getSummary: jest.fn(async () => ({ events: 3 })),
            setEnabled: jest.fn(async () => {}),
            clear: jest.fn(async () => {}),
        },
        findingCache: {
            lookup: jest.fn(async () => ({ hits: new Map([['k', [{ id: 1 }]]]), misses: ['m1'] })),
            putMany: jest.fn(async () => {}),
            clearPR: jest.fn(async () => {}),
        },
        ...overrides,
    };
}

describe('cacheTelemetryHandlers', () => {
    it('should register the expected message types', () => {
        const h = createCacheTelemetryHandlers(makeSvc());
        expect(Object.keys(h).sort()).toEqual([
            'CLEAR_FINDING_CACHE', 'CLEAR_TELEMETRY', 'GET_TELEMETRY',
            'LOOKUP_FINDING_CACHE', 'PUT_FINDING_CACHE', 'SET_TELEMETRY_ENABLED',
        ]);
    });

    describe('telemetry', () => {
        it('GET_TELEMETRY returns enabled + summary', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createCacheTelemetryHandlers(svc).GET_TELEMETRY({}, send);
            expect(send).toHaveBeenCalledWith({ success: true, data: { enabled: true, summary: { events: 3 } } });
        });

        it('SET_TELEMETRY_ENABLED coerces payload to boolean', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createCacheTelemetryHandlers(svc).SET_TELEMETRY_ENABLED({ payload: { enabled: 1 } }, send);
            expect(svc.telemetry.setEnabled).toHaveBeenCalledWith(true);
            expect(send).toHaveBeenCalledWith({ success: true });
        });

        it('reports errors via errorHandler + getErrorMessage', async () => {
            const svc = makeSvc();
            svc.telemetry.clear = jest.fn(async () => { throw new Error('boom'); });
            const send = jest.fn();
            await createCacheTelemetryHandlers(svc).CLEAR_TELEMETRY({}, send);
            expect(svc.errorHandler.logError).toHaveBeenCalled();
            expect(send).toHaveBeenCalledWith({ success: false, error: 'boom' });
        });
    });

    describe('finding cache', () => {
        it('LOOKUP converts the hits Map to a plain object', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createCacheTelemetryHandlers(svc).LOOKUP_FINDING_CACHE(
                { payload: { prInfo: { id: 1 }, hunks: [{}] } }, send);
            expect(send).toHaveBeenCalledWith({
                success: true,
                data: { hits: { k: [{ id: 1 }] }, misses: ['m1'] },
            });
        });

        it('LOOKUP validates required fields', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createCacheTelemetryHandlers(svc).LOOKUP_FINDING_CACHE({ payload: { prInfo: null, hunks: 'no' } }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'prInfo and hunks[] required' });
            expect(svc.findingCache.lookup).not.toHaveBeenCalled();
        });

        it('PUT validates and forwards entries', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            const entries = [{ a: 1 }];
            await createCacheTelemetryHandlers(svc).PUT_FINDING_CACHE({ payload: { prInfo: { id: 1 }, entries } }, send);
            expect(svc.findingCache.putMany).toHaveBeenCalledWith({ id: 1 }, entries);
            expect(send).toHaveBeenCalledWith({ success: true });
        });

        it('CLEAR requires prInfo', async () => {
            const svc = makeSvc();
            const send = jest.fn();
            await createCacheTelemetryHandlers(svc).CLEAR_FINDING_CACHE({ payload: {} }, send);
            expect(send).toHaveBeenCalledWith({ success: false, error: 'prInfo required' });
        });
    });
});

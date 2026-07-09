/**
 * Finding-cache and telemetry message handlers, extracted from BackgroundService.
 *
 * These are self-contained: they only touch `svc.findingCache`, `svc.telemetry`,
 * `svc.errorHandler`, and `svc.getErrorMessage`. The factory takes the
 * BackgroundService instance and returns the handler map for the router.
 */

/**
 * @param {object} svc - the BackgroundService instance
 * @returns {Record<string, Function>} handler map keyed by message type
 */
export function createCacheTelemetryHandlers(svc) {
    // ── Phase 6: telemetry (opt-in, local-only) ──────────────────────────────
    async function handleGetTelemetry(message, sendResponse) {
        try {
            const enabled = await svc.telemetry.isEnabled();
            const summary = await svc.telemetry.getSummary();
            sendResponse({ success: true, data: { enabled, summary } });
        } catch (error) {
            svc.errorHandler.logError('Get telemetry', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleSetTelemetryEnabled(message, sendResponse) {
        try {
            const { enabled } = message.payload || message.data || {};
            await svc.telemetry.setEnabled(!!enabled);
            sendResponse({ success: true });
        } catch (error) {
            svc.errorHandler.logError('Set telemetry enabled', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleClearTelemetry(message, sendResponse) {
        try {
            await svc.telemetry.clear();
            sendResponse({ success: true });
        } catch (error) {
            svc.errorHandler.logError('Clear telemetry', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    // ── Phase 3: incremental review cache ─────────────────────────────────────
    async function handleLookupFindingCache(message, sendResponse) {
        try {
            const { prInfo, hunks } = message.payload || message.data || {};
            if (!prInfo || !Array.isArray(hunks)) {
                sendResponse({ success: false, error: 'prInfo and hunks[] required' });
                return;
            }
            const { hits, misses } = await svc.findingCache.lookup(prInfo, hunks);
            // Map<string, findings[]> isn't structured-cloneable in some
            // runtimes — convert to a plain object before responding.
            const hitsObj = {};
            hits.forEach((v, k) => { hitsObj[k] = v; });
            sendResponse({ success: true, data: { hits: hitsObj, misses } });
        } catch (error) {
            svc.errorHandler.logError('Lookup finding cache', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handlePutFindingCache(message, sendResponse) {
        try {
            const { prInfo, entries } = message.payload || message.data || {};
            if (!prInfo || !Array.isArray(entries)) {
                sendResponse({ success: false, error: 'prInfo and entries[] required' });
                return;
            }
            await svc.findingCache.putMany(prInfo, entries);
            sendResponse({ success: true });
        } catch (error) {
            svc.errorHandler.logError('Put finding cache', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleClearFindingCache(message, sendResponse) {
        try {
            const { prInfo } = message.payload || message.data || {};
            if (!prInfo) {
                sendResponse({ success: false, error: 'prInfo required' });
                return;
            }
            await svc.findingCache.clearPR(prInfo);
            sendResponse({ success: true });
        } catch (error) {
            svc.errorHandler.logError('Clear finding cache', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    return {
        GET_TELEMETRY: handleGetTelemetry,
        SET_TELEMETRY_ENABLED: handleSetTelemetryEnabled,
        CLEAR_TELEMETRY: handleClearTelemetry,
        LOOKUP_FINDING_CACHE: handleLookupFindingCache,
        PUT_FINDING_CACHE: handlePutFindingCache,
        CLEAR_FINDING_CACHE: handleClearFindingCache,
    };
}

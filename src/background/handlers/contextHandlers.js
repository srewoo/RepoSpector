/**
 * Context-analysis / diff / progress / tab-id / cancel message handlers,
 * extracted from BackgroundService.
 *
 * These are self-contained: they only touch `svc.contextAnalyzer`,
 * `svc.errorHandler`, `svc.getErrorMessage`, `svc.isProcessing`,
 * `svc.processingQueue`, and `svc.cancelRequest`. The factory takes the
 * BackgroundService instance and returns the handler map for the router.
 */

/**
 * @param {object} svc - the BackgroundService instance
 * @returns {Record<string, Function>} handler map keyed by message type
 */
export function createContextHandlers(svc) {
    async function handleAnalyzeContext(message, sendResponse) {
        try {
            const { code, url, level } = message.data || {};

            const context = await svc.contextAnalyzer.analyzeWithContext(code, {
                url,
                level: level || 'smart'
            });

            sendResponse({
                success: true,
                data: context
            });
        } catch (error) {
            svc.errorHandler.logError('Context analysis', error);
            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        }
    }

    async function handleProcessDiff(message, sendResponse) {
        try {
            const { diffContent, url, options: _options } = message.data || {};

            // This will be enhanced in Phase 2.1
            const context = await svc.contextAnalyzer.analyzeWithContext(diffContent, {
                url,
                level: 'smart',
                isDiff: true
            });

            sendResponse({
                success: true,
                data: context
            });
        } catch (error) {
            svc.errorHandler.logError('Diff processing', error);
            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        }
    }

    async function handleGetProgress(message, sendResponse) {
        sendResponse({
            success: true,
            data: {
                isProcessing: svc.isProcessing,
                queueLength: svc.processingQueue.length
            }
        });
    }

    async function handleGetTabId(message, sender, sendResponse) {
        // Return the tab ID from the sender
        const tabId = sender?.tab?.id;
        console.log('📍 GET_TAB_ID request from tab:', tabId);
        sendResponse({
            success: true,
            tabId: tabId
        });
    }

    async function handleCancelRequest(message, sendResponse) {
        try {
            const { requestId } = message.data || message.payload || {};

            if (!requestId) {
                sendResponse({ success: false, error: 'Request ID is required' });
                return;
            }

            svc.cancelRequest(requestId);

            sendResponse({
                success: true,
                message: 'Request cancelled'
            });
        } catch (error) {
            svc.errorHandler.logError('Cancel request', error);
            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        }
    }

    return {
        ANALYZE_CONTEXT: (m, send) => handleAnalyzeContext(m, send),
        PROCESS_DIFF: (m, send) => handleProcessDiff(m, send),
        GET_PROGRESS: (m, send) => handleGetProgress(m, send),
        GET_TAB_ID: (m, send, sender) => handleGetTabId(m, sender, send),
        CANCEL_REQUEST: (m, send) => handleCancelRequest(m, send),
    };
}

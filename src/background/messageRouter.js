/**
 * messageRouter — typed registry-pattern dispatcher for the background service worker.
 *
 * Replaces the previous 54-case switch in `BackgroundService.handleMessage` and the
 * outer fallthrough switch in `background/index.js`. Centralizes:
 *   - Origin validation (rejects messages from other extensions and disallowed
 *     content-script origins).
 *   - Uniform error handling and JSON-shaped responses.
 *   - A single registration surface so feature modules can attach handlers.
 *
 * Handlers stay where they are during the migration; the router calls them by
 * name. Once a feature is fully extracted, its `register()` lives next to the
 * feature module instead of in `background/index.js`.
 */

// Origins that may send messages from a content script.
// Kept in sync with `manifest.json#content_scripts[0].matches`.
const ALLOWED_CONTENT_ORIGIN_PATTERNS = [
    /^https:\/\/github\.com$/,
    /^https:\/\/gitlab\.com$/,
    /^https:\/\/bitbucket\.org$/,
    /^https:\/\/dev\.azure\.com$/,
    /^https:\/\/[a-z0-9-]+\.visualstudio\.com$/,
    /^https:\/\/sourceforge\.net$/,
    /^https:\/\/codeberg\.org$/,
    /^https:\/\/[a-z0-9-]+\.gitea\.(io|com)$/,
    /^https:\/\/git\.sr\.ht$/,
    /^https:\/\/[a-z0-9-]+\.pagure\.io$/,
];

const handlers = new Map();

/**
 * Register a handler for a given message `type`.
 *
 * @param {string} type - e.g. "GENERATE_TESTS"
 * @param {(message: any, sendResponse: Function, sender: chrome.runtime.MessageSender, ctx: { isFromPopup: boolean }) => Promise<void> | void} fn
 * @param {{ allowContentScript?: boolean }} [opts]
 *   allowContentScript: if false (default for most handlers), reject messages
 *   originating from web pages — only popup/extension pages may invoke.
 */
export function registerHandler(type, fn, opts = {}) {
    if (handlers.has(type)) {
        console.warn(`[messageRouter] Overwriting handler for type "${type}"`);
    }
    handlers.set(type, {
        fn,
        allowContentScript: opts.allowContentScript === true,
    });
}

/**
 * Bulk-register a map of `{ type: fn }` or `{ type: { fn, ...opts } }`.
 */
export function registerHandlers(map) {
    for (const [type, value] of Object.entries(map)) {
        if (typeof value === 'function') {
            registerHandler(type, value);
        } else {
            registerHandler(type, value.fn, value);
        }
    }
}

export function hasHandler(type) {
    return handlers.has(type);
}

/**
 * Validate that a message's sender is allowed to invoke a handler.
 * Returns null if allowed, or an error string if rejected.
 */
function validateSender(message, sender, entry) {
    // Only reject if sender.id is present AND mismatched. Some Chrome versions
    // omit sender.id for messages from the extension's own popup — treating
    // "absent" as "trusted (popup/SW)" matches Chrome's documented behavior.
    if (sender && sender.id && sender.id !== chrome.runtime.id) {
        return 'Unauthorized sender (foreign extension)';
    }

    // Content-script messages always have sender.tab. The tab origin still
    // has to be on the allow-list — but the gate that says "this handler
    // doesn't accept content-script messages" is bypassed when the message
    // carries `isFromPopup: true`. That flag is set by content/index.js when
    // it relays messages from the floating-panel iframe (the popup app
    // rendered inside the host page). Those messages are popup-equivalent
    // even though the transport is a content script.
    if (sender && sender.tab && sender.tab.url) {
        const isPopupRelay = message && message.isFromPopup === true;

        try {
            const origin = new URL(sender.tab.url).origin;
            const ok = ALLOWED_CONTENT_ORIGIN_PATTERNS.some((re) => re.test(origin));
            if (!ok) return `Disallowed content-script origin: ${origin}`;
        } catch {
            return 'Malformed sender.tab.url';
        }

        if (!entry.allowContentScript && !isPopupRelay) {
            return `Handler does not accept content-script messages`;
        }
    }
    return null;
}

/**
 * Main entry point — wire this to `chrome.runtime.onMessage`.
 *
 * @param {any} message
 * @param {chrome.runtime.MessageSender} sender
 * @param {Function} sendResponse
 * @param {{ errorHandler?: { logError: Function } }} [ctx]
 */
export async function dispatch(message, sender, sendResponse, ctx = {}) {
    if (!message || typeof message.type !== 'string') {
        sendResponse({ success: false, error: 'Missing or invalid message.type' });
        return;
    }

    const entry = handlers.get(message.type);
    if (!entry) {
        sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
        return;
    }

    const rejection = validateSender(message, sender, entry);
    if (rejection) {
        console.warn(`[messageRouter] Rejected ${message.type}: ${rejection}`);
        sendResponse({ success: false, error: rejection });
        return;
    }

    const isFromPopup = !sender || !sender.tab || message.isFromPopup === true;

    try {
        await entry.fn(message, sendResponse, sender, { isFromPopup });
    } catch (error) {
        if (ctx.errorHandler && typeof ctx.errorHandler.logError === 'function') {
            ctx.errorHandler.logError(`Handler ${message.type}`, error);
        } else {
            console.error(`[messageRouter] Handler ${message.type} threw`, error);
        }
        sendResponse({
            success: false,
            error: (error && error.message) || 'Handler error',
        });
    }
}

/**
 * Test-only: clear all registered handlers. Not exported in production.
 */
export function __resetForTests() {
    handlers.clear();
}

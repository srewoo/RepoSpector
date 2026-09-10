/**
 * Keep the MV3 service worker alive while a message handler is still working.
 *
 * Chrome kills an idle service worker after ~30 seconds. Only an extension API
 * call resets that timer — an in-flight `fetch` does not, and neither does a
 * `setInterval` that touches nothing. A review against a local Ollama model
 * runs for minutes between API calls, so the worker was being torn down
 * mid-handler and the popup got Chrome's own message:
 *
 *   "A listener indicated an asynchronous response by returning true, but the
 *    message channel closed before a response was received"
 *
 * The fix is a ref-counted ping: the router holds the worker awake for the
 * lifetime of every handler and lets it sleep the moment the last one returns.
 * Ref-counting matters because reviews overlap (a review, a chat reply and an
 * indexing pass can all be in flight) — the first one in starts the ping, the
 * last one out stops it.
 */

/** Comfortably under the ~30s idle kill, with room for a missed tick. */
export const KEEPALIVE_INTERVAL_MS = 20000;

/** The cheapest extension API call there is. Its only job is to reset the timer. */
export function defaultPing() {
    // Optional-chained so the module stays importable in tests and in any
    // context where `chrome` is absent; a missing API just means no keepalive,
    // never a thrown error out of a timer.
    return globalThis.chrome?.runtime?.getPlatformInfo?.();
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.ping] - Extension API call that resets the idle timer.
 * @param {number} [opts.intervalMs]
 * @param {{setInterval: Function, clearInterval: Function}} [opts.timers]
 * @returns {{begin: () => (() => void), isRunning: () => boolean, activeCount: () => number}}
 */
export function createKeepAlive({
    ping = defaultPing,
    intervalMs = KEEPALIVE_INTERVAL_MS,
    timers = globalThis,
} = {}) {
    let active = 0;
    let handle = null;

    return {
        /** Hold the worker awake. Returns the release function; call it in a `finally`. */
        begin() {
            active += 1;
            if (handle === null) {
                handle = timers.setInterval(() => {
                    try {
                        // A rejected promise here (worker shutting down) must not
                        // become an unhandled rejection.
                        Promise.resolve(ping()).catch(() => { /* ping is best-effort */ });
                    } catch { /* ping is best-effort */ }
                }, intervalMs);
            }
            let released = false;
            return function end() {
                // Idempotent: a double release must not drop the count below the
                // work still in flight and let the worker die under it.
                if (released) return;
                released = true;
                active -= 1;
                if (active <= 0 && handle !== null) {
                    timers.clearInterval(handle);
                    handle = null;
                    active = 0;
                }
            };
        },
        isRunning: () => handle !== null,
        activeCount: () => active,
    };
}

/** The instance the message router uses. */
export const keepAlive = createKeepAlive();

export default keepAlive;

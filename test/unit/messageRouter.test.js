/**
 * Unit tests for src/background/messageRouter.js
 *
 * Covers:
 *   - Origin validation (foreign extension rejected, disallowed content-script
 *     origin rejected, allowed origin passes when handler opts in).
 *   - Unknown / malformed message types.
 *   - Handler error propagation.
 *   - The `isFromPopup` ctx flag.
 */

const {
    registerHandler,
    registerHandlers,
    hasHandler,
    dispatch,
    __resetForTests,
} = require('../../src/background/messageRouter.js');

beforeAll(() => {
    // The router compares sender.id against chrome.runtime.id; setup.js mocks
    // chrome.runtime but does not set an `id`. Pin it for these tests.
    global.chrome.runtime.id = 'test-extension-id';

    // setup.js replaces global.URL with an object literal that only carries
    // createObjectURL/revokeObjectURL — that breaks `new URL(...)`. Restore
    // the real URL constructor for this suite.
    global.URL = require('url').URL;
});

beforeEach(() => {
    __resetForTests();
    jest.clearAllMocks();
});

function makeSendResponse() {
    return jest.fn();
}

describe('messageRouter — registration', () => {
    it('registers and reports a handler', () => {
        registerHandler('PING', () => {});
        expect(hasHandler('PING')).toBe(true);
        expect(hasHandler('NOPE')).toBe(false);
    });

    it('warns when overwriting an existing handler', () => {
        registerHandler('PING', () => {});
        registerHandler('PING', () => {});
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining('Overwriting handler')
        );
    });

    it('bulk-registers via registerHandlers', () => {
        registerHandlers({
            A: () => {},
            B: { fn: () => {}, allowContentScript: true },
        });
        expect(hasHandler('A')).toBe(true);
        expect(hasHandler('B')).toBe(true);
    });
});

describe('messageRouter — dispatch', () => {
    it('rejects messages with no type', async () => {
        const send = makeSendResponse();
        await dispatch({}, null, send);
        expect(send).toHaveBeenCalledWith({
            success: false,
            error: expect.stringMatching(/missing|invalid/i),
        });
    });

    it('rejects unknown message types', async () => {
        const send = makeSendResponse();
        await dispatch({ type: 'NEVER_REGISTERED' }, null, send);
        expect(send).toHaveBeenCalledWith({
            success: false,
            error: expect.stringContaining('Unknown message type'),
        });
    });

    it('invokes a registered handler from popup (no sender.tab)', async () => {
        const fn = jest.fn((m, send) => send({ success: true, ok: 1 }));
        registerHandler('DO', fn);

        const send = makeSendResponse();
        // Popup messages: sender is { id: <our id> } with no tab
        await dispatch({ type: 'DO' }, { id: 'test-extension-id' }, send);

        expect(fn).toHaveBeenCalledTimes(1);
        const ctx = fn.mock.calls[0][3];
        expect(ctx.isFromPopup).toBe(true);
        expect(send).toHaveBeenCalledWith({ success: true, ok: 1 });
    });

    it('rejects messages from a foreign extension', async () => {
        registerHandler('DO', jest.fn());
        const send = makeSendResponse();
        await dispatch(
            { type: 'DO' },
            { id: 'evil-other-extension' },
            send
        );
        expect(send).toHaveBeenCalledWith({
            success: false,
            error: expect.stringContaining('Unauthorized sender'),
        });
    });

    it('rejects content-script messages when handler does not allow them', async () => {
        const fn = jest.fn();
        registerHandler('DO', fn); // default: allowContentScript = false
        const send = makeSendResponse();

        await dispatch(
            { type: 'DO' },
            { id: 'test-extension-id', tab: { id: 1, url: 'https://github.com/foo/bar' } },
            send
        );

        expect(fn).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith({
            success: false,
            error: expect.stringContaining('content-script'),
        });
    });

    it('accepts content-script messages from an allowed origin when opted in', async () => {
        const fn = jest.fn((m, send) => send({ success: true }));
        registerHandler('DO', fn, { allowContentScript: true });
        const send = makeSendResponse();

        await dispatch(
            { type: 'DO' },
            { id: 'test-extension-id', tab: { id: 1, url: 'https://github.com/foo/bar' } },
            send
        );

        expect(fn).toHaveBeenCalledTimes(1);
        const ctx = fn.mock.calls[0][3];
        expect(ctx.isFromPopup).toBe(false);
        expect(send).toHaveBeenCalledWith({ success: true });
    });

    it('rejects content-script messages from a disallowed origin even when opted in', async () => {
        const fn = jest.fn();
        registerHandler('DO', fn, { allowContentScript: true });
        const send = makeSendResponse();

        await dispatch(
            { type: 'DO' },
            { id: 'test-extension-id', tab: { id: 1, url: 'https://evil.example/page' } },
            send
        );

        expect(fn).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith({
            success: false,
            error: expect.stringContaining('Disallowed content-script origin'),
        });
    });

    it('treats message.isFromPopup=true as popup even with sender.tab present (relay case)', async () => {
        // Matches the comment in handleMessage: content scripts can relay
        // popup messages when the popup is rendered as an iframe.
        const fn = jest.fn((m, send) => send({ success: true }));
        registerHandler('DO', fn);
        const send = makeSendResponse();

        await dispatch(
            { type: 'DO', isFromPopup: true },
            { id: 'test-extension-id' }, // no tab — like a relayed popup msg
            send
        );

        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn.mock.calls[0][3].isFromPopup).toBe(true);
    });

    it('floating-panel relay: content script with isFromPopup=true bypasses the content-script gate', async () => {
        // Real-world case: src/content/index.js relays popup messages from
        // the floating-panel iframe via chrome.runtime.sendMessage with
        // `isFromPopup: true`. From the SW perspective sender.tab IS set
        // (the call originated from a tab), but the message is logically a
        // popup message and the handler must accept it.
        const fn = jest.fn((m, send) => send({ success: true, ok: 1 }));
        registerHandler('GET_SETTINGS', fn); // default: allowContentScript=false

        const send = makeSendResponse();
        await dispatch(
            { type: 'GET_SETTINGS', isFromPopup: true },
            {
                id: 'test-extension-id',
                tab: { id: 7, url: 'https://gitlab.com/mindtickle/foo/bar' },
            },
            send
        );

        expect(fn).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith({ success: true, ok: 1 });
    });

    it('extension-page iframe (sender.url = chrome-extension://OUR_ID/...) is trusted even without isFromPopup flag', async () => {
        // The floating panel embeds the popup page as a chrome-extension://
        // iframe inside a host page. Chrome sets sender.tab on messages from
        // that iframe even though it's our own page. Trusting sender.url is
        // what lets handlers like SAVE_SETTINGS work without every caller
        // remembering to add isFromPopup: true.
        const fn = jest.fn((m, send) => send({ success: true }));
        registerHandler('SAVE_SETTINGS', fn); // default: allowContentScript=false

        const send = makeSendResponse();
        await dispatch(
            { type: 'SAVE_SETTINGS', data: { settings: {} } },
            {
                id: 'test-extension-id',
                tab: { id: 7, url: 'https://gitlab.com/foo/bar' },
                url: 'chrome-extension://test-extension-id/src/popup/index.html?mode=iframe',
            },
            send
        );

        expect(fn).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith({ success: true });
    });

    it('a forged sender.url to a foreign extension is rejected by the id check before the URL trust path', async () => {
        // Defense in depth: the id check fires first, so even if Chrome
        // somehow populated a foreign sender.url we'd still reject because
        // sender.id mismatches. This test pins that ordering.
        const fn = jest.fn();
        registerHandler('SAVE_SETTINGS', fn);

        const send = makeSendResponse();
        await dispatch(
            { type: 'SAVE_SETTINGS' },
            {
                id: 'evil-extension',
                url: 'chrome-extension://test-extension-id/src/popup/index.html', // forged
            },
            send
        );

        expect(fn).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith({
            success: false,
            error: expect.stringContaining('Unauthorized sender'),
        });
    });

    it('floating-panel relay still enforces origin allow-list', async () => {
        // isFromPopup must NOT let a malicious page bypass origin validation.
        const fn = jest.fn();
        registerHandler('GET_SETTINGS', fn);

        const send = makeSendResponse();
        await dispatch(
            { type: 'GET_SETTINGS', isFromPopup: true },
            {
                id: 'test-extension-id',
                tab: { id: 7, url: 'https://evil.example/page' },
            },
            send
        );

        expect(fn).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith({
            success: false,
            error: expect.stringContaining('Disallowed content-script origin'),
        });
    });

    it('catches handler exceptions and responds with success:false', async () => {
        const errorHandler = { logError: jest.fn() };
        registerHandler('BOOM', () => {
            throw new Error('handler exploded');
        });
        const send = makeSendResponse();

        await dispatch(
            { type: 'BOOM' },
            { id: 'test-extension-id' },
            send,
            { errorHandler }
        );

        expect(errorHandler.logError).toHaveBeenCalledWith(
            'Handler BOOM',
            expect.any(Error)
        );
        expect(send).toHaveBeenCalledWith({
            success: false,
            error: 'handler exploded',
        });
    });

    it('catches async handler rejections', async () => {
        registerHandler('BOOM', async () => {
            throw new Error('async boom');
        });
        const send = makeSendResponse();

        await dispatch({ type: 'BOOM' }, { id: 'test-extension-id' }, send);
        expect(send).toHaveBeenCalledWith({
            success: false,
            error: 'async boom',
        });
    });
});

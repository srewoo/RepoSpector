// Jest setup file for AI RepoSpector tests

// Setup global mocks for Chrome APIs
global.chrome = {
    storage: {
        sync: {
            get: jest.fn((keys, callback) => {
                const result = {};
                if (callback) callback(result);
                return Promise.resolve(result);
            }),
            set: jest.fn((items, callback) => {
                if (callback) callback();
                return Promise.resolve();
            }),
            remove: jest.fn((keys, callback) => {
                if (callback) callback();
                return Promise.resolve();
            })
        },
        local: {
            get: jest.fn((keys, callback) => {
                const result = {};
                if (callback) callback(result);
                return Promise.resolve(result);
            }),
            set: jest.fn((items, callback) => {
                if (callback) callback();
                return Promise.resolve();
            })
        }
    },
    runtime: {
        sendMessage: jest.fn((message, callback) => {
            if (callback) callback();
            return Promise.resolve();
        }),
        onMessage: {
            addListener: jest.fn()
        },
        getURL: jest.fn((path) => `chrome-extension://extension-id/${path}`)
    },
    tabs: {
        query: jest.fn((queryInfo, callback) => {
            const tabs = [{ id: 1, url: 'https://example.com' }];
            if (callback) callback(tabs);
            return Promise.resolve(tabs);
        }),
        sendMessage: jest.fn((tabId, message, callback) => {
            if (callback) callback({ success: true, code: 'function test() {}' });
            return Promise.resolve({ success: true, code: 'function test() {}' });
        })
    },
    action: {
        setIcon: jest.fn(),
        setBadgeText: jest.fn(),
        setBadgeBackgroundColor: jest.fn()
    }
};

// Real WebCrypto (Node's implementation) so production crypto — AES-GCM,
// PBKDF2, SubtleCrypto — actually runs under the test harness instead of a
// Math.random stub. Provides both getRandomValues and crypto.subtle.
// jsdom installs a read-only `crypto` accessor (getRandomValues only, no
// subtle), so a plain assignment is silently ignored — defineProperty is
// required to replace it.
const { webcrypto } = require('crypto');
Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true,
});

// Mock fetch API
global.fetch = jest.fn(() =>
    Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
        status: 200,
        statusText: 'OK'
    })
);

// Mock DOM APIs
global.document = {
    createElement: jest.fn((tagName) => {
        const element = {
            tagName,
            innerHTML: '',
            textContent: '',
            style: {},
            classList: {
                add: jest.fn(),
                remove: jest.fn(),
                contains: jest.fn()
            },
            appendChild: jest.fn(),
            click: jest.fn(),
            addEventListener: jest.fn()
        };
        if (tagName === 'a') {
            element.href = '';
            element.download = '';
        }
        return element;
    }),
    querySelector: jest.fn(),
    querySelectorAll: jest.fn(() => []),
    getElementById: jest.fn(),
    body: {
        innerHTML: '',
        appendChild: jest.fn(),
        removeChild: jest.fn()
    }
};

// Fix window mock with proper getSelection
global.window = {
    getSelection: jest.fn(() => ({
        toString: () => '',
        rangeCount: 0,
        removeAllRanges: jest.fn(),
        addRange: jest.fn()
    })),
    location: {
        href: 'https://example.com',
        hostname: 'example.com',
        pathname: '/',
        search: '',
        hash: ''
    }
};

// Mock navigator
global.navigator = {
    clipboard: {
        writeText: jest.fn(() => Promise.resolve()),
        readText: jest.fn(() => Promise.resolve(''))
    }
};

// Use the REAL URL constructor (Node's) so production code that does
// `new URL(...)` for parsing/validation works, and attach the object-URL
// helpers as mocks. The previous plain-object mock broke every `new URL()`.
const { URL: NodeURL } = require('url');
NodeURL.createObjectURL = jest.fn(() => 'blob:mock-url');
NodeURL.revokeObjectURL = jest.fn();
global.URL = NodeURL;

// Mock console methods to avoid noise in tests
global.console = {
    ...console,
    error: jest.fn(),
    warn: jest.fn(),
    log: jest.fn()
};

// Add custom matchers
expect.extend({
    toBeValidApiKey(received) {
        const pass = /^sk-[A-Za-z0-9]{48}$/.test(received);
        return {
            pass,
            message: () => pass
                ? `expected ${received} not to be a valid API key`
                : `expected ${received} to be a valid API key (format: sk-[48 alphanumeric chars])`
        };
    },

    toBeEncrypted(received) {
        // Check if string looks encrypted (base64 with non-ASCII chars)
        const pass = /^[A-Za-z0-9+/]+=*$/.test(received) && received.length > 20;
        return {
            pass,
            message: () => pass
                ? `expected ${received} not to be encrypted`
                : `expected ${received} to be encrypted (base64 format)`
        };
    },

    toContainTestCase(received, testCasePattern) {
        const pass = received.includes(testCasePattern);
        return {
            pass,
            message: () => pass
                ? `expected test cases not to contain "${testCasePattern}"`
                : `expected test cases to contain "${testCasePattern}"`
        };
    }
});

// Helper function to reset all mocks
global.resetAllMocks = () => {
    jest.clearAllMocks();
    document.body.innerHTML = '';
};

// Polyfill TextEncoder/TextDecoder for js-tiktoken
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder; 
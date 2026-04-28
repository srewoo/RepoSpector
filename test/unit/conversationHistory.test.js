const { ConversationHistoryManager } = require('../../src/services/conversationHistory');

// Mock chrome.storage.local
const mockStorage = {};
global.chrome = {
    storage: {
        local: {
            get: jest.fn((keys, callback) => {
                const result = {};
                keys.forEach(key => {
                    result[key] = mockStorage[key];
                });
                callback(result);
            }),
            set: jest.fn((items, callback) => {
                Object.assign(mockStorage, items);
                if (callback) callback();
            })
        }
    }
};

describe('ConversationHistoryManager', () => {
    let manager;

    beforeEach(() => {
        manager = new ConversationHistoryManager();
        // Clear mock storage
        for (const key in mockStorage) delete mockStorage[key];
    });

    test('should initialize correctly', async () => {
        await manager.initialize();
        expect(manager.sessionId).toBeDefined();
        expect(manager.initialized).toBe(true);
    });

    test('should count tokens accurately using tiktoken', () => {
        const text = "Hello, world!";
        const tokens = manager.countTokens(text);
        // "Hello, world!" is 4 tokens in gpt-4o-mini (Hello, ,, world, !)
        // Note: exact count might vary slightly depending on tokenizer version, but should be close
        expect(tokens).toBeGreaterThan(0);
        expect(tokens).toBeLessThan(10);
    });

    test('should prune history based on token limit', async () => {
        // Use a small budget so the test doesn't need to generate 32K of
        // text to exercise the pruning path.
        const tightManager = new ConversationHistoryManager({ maxContextTokens: 8000 });
        await tightManager.initialize();

        const longText = 'This is a test message. '.repeat(100); // ~500 tokens
        const msgTokens = tightManager.countTokens(longText);
        const numMessages = Math.ceil(8000 / msgTokens) + 2;

        for (let i = 0; i < numMessages; i++) {
            await tightManager.addMessage({ id: i, role: 'user', content: longText });
        }

        const formattedHistory = tightManager.getFormattedHistory(false);
        const totalTokens = formattedHistory.reduce(
            (sum, msg) => sum + tightManager.countTokens(msg.content),
            0
        );

        expect(totalTokens).toBeLessThanOrEqual(8000);
        expect(formattedHistory.length).toBeLessThan(numMessages);
    });
});

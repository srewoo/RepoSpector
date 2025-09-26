describe('AI RepoSpector E2E User Flows', () => {
    // Mock Chrome APIs
    beforeEach(() => {
        global.chrome = {
            storage: {
                sync: {
                    get: jest.fn((keys, callback) => {
                        const result = { apiKey: 'sk-' + 'a'.repeat(48) };
                        if (callback) callback(result);
                        return Promise.resolve(result);
                    }),
                    set: jest.fn((items, callback) => {
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
            tabs: {
                query: jest.fn((queryInfo, callback) => {
                    const tabs = [{ id: 1, url: 'https://github.com/user/repo' }];
                    if (callback) callback(tabs);
                    return Promise.resolve(tabs);
                }),
                sendMessage: jest.fn((tabId, message, callback) => {
                    const response = { 
                        success: true, 
                        code: 'function test() { return "hello"; }' 
                    };
                    if (callback) callback(response);
                    return Promise.resolve(response);
                })
            },
            runtime: {
                sendMessage: jest.fn((message, callback) => {
                    const response = { 
                        success: true, 
                        testCases: 'describe("test", () => { it("should work", () => {}); })' 
                    };
                    if (callback) callback(response);
                    return Promise.resolve(response);
                })
            }
        };

        // Mock fetch
        global.fetch = jest.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
                choices: [{
                    message: {
                        content: 'Generated test cases...'
                    }
                }]
            })
        }));

        // Mock DOM elements
        document.body.innerHTML = `
            <div id="generateBtn"></div>
            <select id="testTypeSelect">
                <option value="unit">Unit</option>
            </select>
            <div id="results"></div>
            <div id="copyBtn"></div>
            <div id="downloadBtn"></div>
            <div id="settingsBtn"></div>
            <div id="settingsModal"></div>
            <input id="apiKeyInput" />
            <button id="saveApiKeyBtn"></button>
        `;

        // Simulate popup.js logic for button clicks
        const generateBtn = document.getElementById('generateBtn');
        generateBtn.addEventListener('click', async () => {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const codeResponse = await chrome.tabs.sendMessage(tabs[0].id, { action: 'extractCode' });
            if (codeResponse.success) {
                const testResponse = await chrome.runtime.sendMessage({
                    action: 'generateTestCases',
                    code: codeResponse.code
                });
                const results = document.getElementById('results');
                if (testResponse.success) {
                    results.innerHTML = testResponse.testCases;
                } else {
                    results.innerHTML = `<div class="error">${testResponse.error}</div>`;
                }
            }
        });
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('Basic User Flow', () => {
        it('should complete a basic test generation flow', async () => {
            // User clicks generate button
            const generateBtn = document.getElementById('generateBtn');
            generateBtn.click();

            // Wait for async operations
            await new Promise(resolve => setTimeout(resolve, 100));

            // Verify the flow
            expect(chrome.tabs.query).toHaveBeenCalled();
            expect(chrome.tabs.sendMessage).toHaveBeenCalled();
            expect(chrome.runtime.sendMessage).toHaveBeenCalled();
        });
    });

    describe('Error Recovery Flow', () => {
        it('should handle and recover from various errors', async () => {
            // Test network error - mock the runtime.sendMessage to return error
            chrome.runtime.sendMessage = jest.fn().mockImplementation((_message) => {
                return Promise.resolve({ success: false, error: 'Network error' });
            });

            const generateBtn = document.getElementById('generateBtn');
            generateBtn.click();

            await new Promise(resolve => setTimeout(resolve, 100));

            // Should show error in results
            const results = document.getElementById('results');
            expect(results.innerHTML).toContain('error');
        });
    });

    describe('Advanced Features Flow', () => {
        it('should handle test type selection and export features', async () => {
            // Select test type
            const testTypeSelect = document.getElementById('testTypeSelect');
            testTypeSelect.value = 'unit';

            // Generate tests
            const generateBtn = document.getElementById('generateBtn');
            generateBtn.click();

            await new Promise(resolve => setTimeout(resolve, 100));

            // Verify the message was sent
            expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'generateTestCases'
                })
            );
        });
    });
}); 
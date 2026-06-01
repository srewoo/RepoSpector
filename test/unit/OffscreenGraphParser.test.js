const { OffscreenGraphParser } = require('../../src/services/OffscreenGraphParser.js');

describe('OffscreenGraphParser', () => {
    const origChrome = global.chrome;
    afterEach(() => { global.chrome = origChrome; });

    it('should return null when chrome.offscreen is unavailable (regex fallback)', async () => {
        global.chrome = {};
        const parser = new OffscreenGraphParser();
        const result = await parser.analyzeFiles([{ path: 'a.js', content: 'x' }]);
        expect(result).toBeNull();
    });

    it('should return an empty map when there are no parseable files', async () => {
        global.chrome = { offscreen: {} };
        const parser = new OffscreenGraphParser();
        const result = await parser.analyzeFiles([{ path: 'a.js' }]); // no content
        expect(result).toBeInstanceOf(Map);
        expect(result.size).toBe(0);
    });

    it('should aggregate analyses across batches and report availability', async () => {
        const analysisFor = (path) => ({
            symbols: [{ name: path, label: 'Function', startLine: 1, endLine: 1, isExported: true }],
            imports: [], calls: [], heritage: []
        });
        global.chrome = {
            offscreen: {},
            runtime: {
                getContexts: jest.fn().mockResolvedValue([{}]), // doc already exists
                sendMessage: jest.fn((msg, cb) => {
                    const analyses = {};
                    for (const f of msg.files) analyses[f.path] = analysisFor(f.path);
                    cb({ success: true, available: true, analyses });
                }),
                lastError: null
            }
        };

        const parser = new OffscreenGraphParser();
        const files = Array.from({ length: 95 }, (_, i) => ({ path: `f${i}.js`, content: 'x' }));
        const result = await parser.analyzeFiles(files);

        expect(result.size).toBe(95);
        expect(parser.available).toBe(true);
        // 95 files / batch 40 → 3 batches
        expect(global.chrome.runtime.sendMessage).toHaveBeenCalledTimes(3);
    });

    it('should fall back to null if the first offscreen message fails', async () => {
        global.chrome = {
            offscreen: {},
            runtime: {
                getContexts: jest.fn().mockResolvedValue([{}]),
                sendMessage: jest.fn((msg, cb) => cb({ success: false, error: 'boom' })),
                lastError: null
            }
        };
        const parser = new OffscreenGraphParser();
        const result = await parser.analyzeFiles([{ path: 'a.js', content: 'x' }]);
        expect(result).toBeNull();
    });
});

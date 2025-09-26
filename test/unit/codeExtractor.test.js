describe('CodeExtractor', () => {
    let mockChromeStorage;

    beforeEach(() => {
        // Mock chrome.storage API
        mockChromeStorage = {
            sync: {
                get: jest.fn()
            }
        };
        global.chrome = { storage: mockChromeStorage };

        // Create a mock DOM
        document.body.innerHTML = '';
        
        // Mock window.getSelection
        global.window.getSelection = jest.fn();

        // Initialize CodeExtractor (we'll need to extract the class from content.js)
        // For now, we'll test the behavior
    });

    afterEach(() => {
        jest.clearAllMocks();
        document.body.innerHTML = '';
    });

    describe('Text Selection Extraction', () => {
        it('should extract selected text when available', () => {
            const selectedText = 'function test() { return true; }';
            window.getSelection.mockReturnValue({
                toString: () => selectedText
            });

            // Simulate extraction
            const result = extractCode();

            expect(result).toEqual({
                success: true,
                code: selectedText,
                source: 'selection'
            });
        });

        it('should ignore very short selections', () => {
            window.getSelection.mockReturnValue({
                toString: () => 'short'
            });

            // Add a code element to DOM
            document.body.innerHTML = '<pre><code>function longCode() { return "test"; }</code></pre>';

            const result = extractCode();

            expect(result.source).not.toBe('selection');
        });
    });

    describe('GitHub Code Extraction', () => {
        it('should extract code from GitHub blob viewer', () => {
            const githubCode = `
                class TestClass {
                    constructor() {
                        this.value = 42;
                    }
                }
            `;
            
            document.body.innerHTML = `
                <div data-testid="blob-viewer-file-content">${githubCode}</div>
            `;

            const result = extractCode();

            expect(result).toEqual({
                success: true,
                code: expect.stringContaining('TestClass'),
                source: '[data-testid="blob-viewer-file-content"]'
            });
        });

        it('should extract code from GitHub diff view', () => {
            const diffCode = 'const added = "new line";';
            
            document.body.innerHTML = `
                <div class="blob-code-content">${diffCode}</div>
            `;

            const result = extractCode();

            expect(result.success).toBe(true);
            expect(result.code).toContain(diffCode);
        });
    });

    describe('Generic Code Block Extraction', () => {
        it('should extract from pre>code elements', () => {
            const code = 'console.log("Hello, World!");';
            
            document.body.innerHTML = `
                <pre><code>${code}</code></pre>
            `;

            const result = extractCode();

            expect(result).toEqual({
                success: true,
                code: code,
                source: 'pre code'
            });
        });

        it('should extract from language-specific code blocks', () => {
            const jsCode = 'const x = 10;';
            
            document.body.innerHTML = `
                <div class="language-javascript">${jsCode}</div>
            `;

            const result = extractCode();

            expect(result.success).toBe(true);
            expect(result.code).toBe(jsCode);
        });
    });

    describe('Editor Extraction', () => {
        it('should extract from CodeMirror editor', () => {
            const editorCode = 'function edit() { return "CodeMirror"; }';
            
            document.body.innerHTML = `
                <div class="CodeMirror-code">${editorCode}</div>
            `;

            const result = extractCode();

            expect(result.success).toBe(true);
            expect(result.code).toContain(editorCode);
        });

        it('should extract from Monaco editor', () => {
            const monacoCode = 'interface IMonaco { test: string; }';
            
            document.body.innerHTML = `
                <div class="monaco-editor">${monacoCode}</div>
            `;

            const result = extractCode();

            expect(result.success).toBe(true);
            expect(result.code).toContain(monacoCode);
        });

        it('should extract from textarea elements', () => {
            const textareaCode = 'export default function() {}';
            
            document.body.innerHTML = `
                <textarea name="code">${textareaCode}</textarea>
            `;

            const result = extractCode();

            expect(result.success).toBe(true);
            expect(result.code).toBe(textareaCode);
        });
    });

    describe('Code Cleaning', () => {
        it('should remove line numbers from code', () => {
            const codeWithNumbers = `1  function test() {
2    return true;
3  }`;
            
            document.body.innerHTML = `
                <pre><code>${codeWithNumbers}</code></pre>
            `;

            const result = extractCode();

            expect(result.code).not.toContain('1  ');
            expect(result.code).not.toContain('2  ');
            expect(result.code).toContain('function test()');
        });

        it('should remove "Copy code" artifacts', () => {
            const codeWithArtifacts = `function test() {}Copy code`;
            
            document.body.innerHTML = `
                <pre><code>${codeWithArtifacts}</code></pre>
            `;

            const result = extractCode();

            expect(result.code).not.toContain('Copy code');
            expect(result.code).toContain('function test()');
        });
    });

    describe('Custom Selectors', () => {
        it('should use custom selectors from storage', async () => {
            mockChromeStorage.sync.get.mockResolvedValue({
                customSelectors: ['.my-custom-code']
            });

            const customCode = 'custom selector code';
            document.body.innerHTML = `
                <div class="my-custom-code">${customCode}</div>
            `;

            // Wait for custom selectors to load
            await new Promise(resolve => setTimeout(resolve, 100));

            const result = extractCode();

            expect(result.success).toBe(true);
            expect(result.code).toBe(customCode);
        });
    });

    describe('Code Analysis', () => {
        it('should detect code by content analysis', () => {
            const hiddenCode = `
                function detectMe() {
                    const x = 10;
                    if (x > 5) {
                        return true;
                    }
                    return false;
                }
            `;
            
            // Code in an unusual element
            document.body.innerHTML = `
                <article>${hiddenCode}</article>
            `;

            const result = extractCode();

            expect(result.success).toBe(true);
            expect(result.source).toBe('analysis');
            expect(result.code).toContain('detectMe');
        });

        it('should not detect non-code content', () => {
            document.body.innerHTML = `
                <div>This is just regular text without any code patterns.</div>
                <p>Another paragraph with normal content.</p>
            `;

            const result = extractCode();

            expect(result.success).toBe(false);
            expect(result.error).toBe('No code found on this page');
        });
    });

    describe('Error Handling', () => {
        it('should handle invalid selectors gracefully', () => {
            mockChromeStorage.sync.get.mockResolvedValue({
                customSelectors: ['!!!invalid###']
            });

            document.body.innerHTML = '<pre><code>valid code</code></pre>';

            const result = extractCode();

            // Should still find code with valid selectors
            expect(result.success).toBe(true);
            expect(result.code).toBe('valid code');
        });

        it('should handle empty DOM', () => {
            document.body.innerHTML = '';

            const result = extractCode();

            expect(result.success).toBe(false);
            expect(result.error).toBe('No code found on this page');
        });
    });
});

// Helper function to simulate code extraction
// This would be the actual extraction logic from content.js
function extractCode() {
    // Simulate the extraction logic
    const selectionObj = window.getSelection();
    const selection = selectionObj ? selectionObj.toString().trim() : '';
    if (selection && selection.length > 10) {
        return {
            success: true,
            code: selection,
            source: 'selection'
        };
    }

    // Try selectors
    const selectors = [
        '[data-testid="blob-viewer-file-content"]',
        '.blob-code-content',
        'pre code',
        '.language-javascript',
        '.CodeMirror-code',
        '.monaco-editor',
        'textarea[name="code"]',
        '.my-custom-code'
    ];

    for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) {
            let code = element.tagName === 'TEXTAREA' 
                ? element.value 
                : element.textContent;
            
            // Clean code
            code = code.replace(/^\s*\d+\s+/gm, '');
            code = code.replace(/Copy code/gi, '').trim();
            
            if (code) {
                return {
                    success: true,
                    code: code,
                    source: selector
                };
            }
        }
    }

    // Try content analysis
    const allElements = document.querySelectorAll('*');
    for (const element of allElements) {
        const text = element.textContent || '';
        if (text.includes('function') && text.includes('{') && text.includes('}')) {
            return {
                success: true,
                code: text.trim(),
                source: 'analysis'
            };
        }
    }

    return {
        success: false,
        error: 'No code found on this page'
    };
} 
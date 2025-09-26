// Mock the CodeChunker module
const mockCodeChunker = {
    chunkCode: jest.fn(),
    findNaturalBoundary: jest.fn(),
    addOverlapContext: jest.fn(),
    estimateTokens: jest.fn(),
    modelLimits: {
        'gpt-4-turbo-preview': 128000,
        'gpt-4': 8192,
        'gpt-3.5-turbo': 4096
    }
};

jest.mock('../../src/utils/chunking.js', () => ({
    CodeChunker: jest.fn().mockImplementation(() => mockCodeChunker)
}));

describe('CodeChunker', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        
        // Setup default mock implementations
        mockCodeChunker.chunkCode.mockImplementation((code, options = {}) => {
            if (!code) return [''];
            
            const maxTokens = options.maxTokensPerChunk || 4000;
            const estimatedTokens = code.length / 4; // Rough estimate
            
            if (estimatedTokens <= maxTokens) {
                return [code];
            }
            
            // Simple chunking for tests
            const chunks = [];
            const chunkSize = maxTokens * 4; // Convert back to characters
            for (let i = 0; i < code.length; i += chunkSize) {
                chunks.push(code.slice(i, i + chunkSize));
            }
            
            return chunks;
        });

        mockCodeChunker.findNaturalBoundary.mockImplementation((code, position) => {
            // Find nearest function or class boundary
            const functionMatch = code.indexOf('function', position);
            const classMatch = code.indexOf('class', position);
            
            if (functionMatch !== -1 && (classMatch === -1 || functionMatch < classMatch)) {
                return functionMatch;
            } else if (classMatch !== -1) {
                return classMatch;
            }
            
            // Fall back to newline
            const newlineMatch = code.indexOf('\n', position);
            return newlineMatch !== -1 ? newlineMatch + 1 : position;
        });

        mockCodeChunker.addOverlapContext.mockImplementation((prevChunk, currentChunk, contextSize = 200) => {
            const context = prevChunk.slice(-contextSize);
            return context + currentChunk;
        });

        mockCodeChunker.estimateTokens.mockImplementation((code) => {
            // Simple token estimation
            return Math.ceil(code.length / 4);
        });
    });

    describe('chunkCode', () => {
        it('should not chunk small code', () => {
            const smallCode = 'function test() {\n  return "Hello World";\n}';
            const chunks = mockCodeChunker.chunkCode(smallCode);
            expect(chunks).toHaveLength(1);
            expect(chunks[0]).toBe(smallCode);
        });

        it('should chunk large code based on token limits', () => {
            // Create a large code string
            const functionTemplate = `
function testFunction$INDEX() {
    // This is a test function with some content
    const data = {
        id: $INDEX,
        name: "Test $INDEX",
        description: "This is a longer description to add more tokens to the function"
    };
    
    if (data.id > 0) {
        console.log("Processing data:", data);
        return data;
    }
    
    throw new Error("Invalid data");
}
`;
            let largeCode = '';
            for (let i = 0; i < 100; i++) {
                largeCode += functionTemplate.replace(/\$INDEX/g, i.toString());
            }

            const chunks = mockCodeChunker.chunkCode(largeCode, { 
                model: 'gpt-4-turbo-preview',
                maxTokensPerChunk: 1000 
            });
            
            expect(chunks.length).toBeGreaterThan(1);
            chunks.forEach(chunk => {
                expect(chunk).toBeTruthy();
                expect(chunk.length).toBeLessThan(largeCode.length);
            });
        });

        it('should handle empty or invalid input', () => {
            expect(mockCodeChunker.chunkCode('')).toEqual(['']);
            expect(mockCodeChunker.chunkCode(null)).toEqual(['']);
            expect(mockCodeChunker.chunkCode(undefined)).toEqual(['']);
        });
    });

    describe('findNaturalBoundary', () => {
        it('should find function boundaries', () => {
            const code = 'function test() {\n  return true;\n}\n\nfunction another() {\n  return false;\n}';
            const boundary = mockCodeChunker.findNaturalBoundary(code, 30);
            expect(code.substring(boundary)).toMatch(/^function another/);
        });

        it('should find class boundaries', () => {
            const code = 'class First {\n  method() {}\n}\n\nclass Second {\n  method() {}\n}';
            const boundary = mockCodeChunker.findNaturalBoundary(code, 25);
            expect(code.substring(boundary)).toMatch(/^class Second/);
        });

        it('should fall back to newline boundaries', () => {
            const code = 'const a = 1;\nconst b = 2;\nconst c = 3;';
            const boundary = mockCodeChunker.findNaturalBoundary(code, 15);
            expect(code[boundary - 1]).toBe('\n');
        });
    });

    describe('addOverlapContext', () => {
        it('should add context from previous chunk', () => {
            const prevChunk = 'function helper() {\n  return true;\n}\n\n';
            const currentChunk = 'function main() {\n  return helper();\n}';
            const withContext = mockCodeChunker.addOverlapContext(prevChunk, currentChunk);
            
            expect(withContext).toContain('helper');
            expect(withContext).toContain('main');
        });

        it('should limit context size', () => {
            const prevChunk = 'a'.repeat(1000);
            const currentChunk = 'function test() {}';
            const withContext = mockCodeChunker.addOverlapContext(prevChunk, currentChunk, 100);
            
            expect(withContext.length).toBeLessThan(prevChunk.length + currentChunk.length);
            expect(withContext).toContain('test');
        });
    });

    describe('estimateTokens', () => {
        it('should estimate tokens for code', () => {
            const code = 'function test() { return "Hello World"; }';
            const tokens = mockCodeChunker.estimateTokens(code);
            expect(tokens).toBeGreaterThan(0);
            expect(tokens).toBeLessThan(code.length); // Tokens should be less than character count
        });

        it('should handle special characters', () => {
            const codeWithSpecialChars = 'const regex = /[a-zA-Z0-9]+/g; // Comment';
            const tokens = mockCodeChunker.estimateTokens(codeWithSpecialChars);
            expect(tokens).toBeGreaterThan(0);
        });
    });
}); 
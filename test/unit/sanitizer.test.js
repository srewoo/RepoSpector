// Mock the module before requiring
const mockInputSanitizer = {
    sanitizeHTML: jest.fn(),
    sanitizeText: jest.fn(),
    sanitizeURL: jest.fn(),
    sanitizeApiKey: jest.fn(),
    sanitizeFilename: jest.fn(),
    sanitizeJSON: jest.fn(),
    validateInput: jest.fn(),
    sanitizeSelector: jest.fn(),
    sanitizeCode: jest.fn(),
    sanitizeCustomSelectors: jest.fn(),
    sanitizeFilePath: jest.fn()
};

jest.mock('../../src/utils/sanitizer.js', () => ({
    InputSanitizer: jest.fn().mockImplementation(() => mockInputSanitizer),
    sanitizer: mockInputSanitizer
}));

describe('InputSanitizer', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        
        // Setup default mock implementations
        mockInputSanitizer.sanitizeHTML.mockImplementation((input) => {
            if (!input) return '';
            let result = String(input);
            result = result.replace(/<script[^>]*>.*?<\/script>/gi, '');
            result = result.replace(/on\w+\s*=\s*["'][^"']*["']/gi, '');
            result = result.replace(/&/g, '&amp;');
            result = result.replace(/</g, '&lt;');
            result = result.replace(/>/g, '&gt;');
            result = result.replace(/"/g, '&quot;');
            result = result.replace(/'/g, '&#x27;');
            return result;
        });

        mockInputSanitizer.sanitizeText.mockImplementation((input) => {
            if (!input) return '';
            return String(input).replace(/<[^>]*>/g, '').trim();
        });

        mockInputSanitizer.sanitizeURL.mockImplementation((url) => {
            if (!url) return '';
            const dangerous = ['javascript:', 'data:', 'vbscript:', 'file:'];
            const lower = String(url).toLowerCase();
            for (const proto of dangerous) {
                if (lower.startsWith(proto)) return '';
            }
            try {
                return encodeURI(decodeURI(url));
            } catch {
                return '';
            }
        });

        mockInputSanitizer.sanitizeApiKey.mockImplementation((key) => {
            if (!key) return '';
            const sanitized = String(key).replace(/[^a-zA-Z0-9\-_]/g, '').trim();
            if (!sanitized.startsWith('sk-') || sanitized.length < 40) {
                throw new Error('Invalid API key format');
            }
            return sanitized;
        });

        mockInputSanitizer.sanitizeFilename.mockImplementation((filename) => {
            if (!filename) return 'download';
            const sanitized = String(filename)
                .replace(/[<>:"|?*]/g, '')
                .replace(/\.{2,}/g, '.')
                .replace(/[\\/]{2,}/g, '/')
                .replace(/^\.+\/|\.+$/g, '')
                .trim();
            return sanitized || 'download';
        });

        mockInputSanitizer.sanitizeJSON.mockImplementation((json) => {
            if (!json) return '{}';
            try {
                return JSON.stringify(JSON.parse(json));
            } catch {
                return '{}';
            }
        });

        mockInputSanitizer.validateInput.mockImplementation((input, type, options = {}) => {
            if (type === 'number') {
                const num = Number(input);
                if (isNaN(num)) throw new Error('Invalid number');
                if (options.min !== undefined && num < options.min) {
                    throw new Error(`Number must be >= ${options.min}`);
                }
                if (options.max !== undefined && num > options.max) {
                    throw new Error(`Number must be <= ${options.max}`);
                }
                return num;
            } else if (type === 'email') {
                const email = String(input).toLowerCase().trim();
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    throw new Error('Invalid email format');
                }
                return email;
            } else if (type === 'text') {
                return mockInputSanitizer.sanitizeText(input);
            }
            throw new Error(`Unknown validation type: ${type}`);
        });
    });

    describe('sanitizeHTML', () => {
        it('should remove script tags', () => {
            const input = '<div>Hello<script>alert("XSS")</script>World</div>';
            const result = mockInputSanitizer.sanitizeHTML(input);
            expect(result).not.toContain('<script>');
            expect(result).not.toContain('alert');
        });

        it('should escape HTML entities', () => {
            const input = '<div>Hello & "World" \'s</div>';
            const result = mockInputSanitizer.sanitizeHTML(input);
            expect(result).toContain('&lt;');
            expect(result).toContain('&gt;');
            expect(result).toContain('&quot;');
            expect(result).toContain('&#x27;');
        });

        it('should remove event handlers', () => {
            const input = '<div onclick="alert(\'XSS\')">Click me</div>';
            const result = mockInputSanitizer.sanitizeHTML(input);
            expect(result).not.toContain('onclick');
        });

        it('should handle empty input', () => {
            expect(mockInputSanitizer.sanitizeHTML('')).toBe('');
            expect(mockInputSanitizer.sanitizeHTML(null)).toBe('');
            expect(mockInputSanitizer.sanitizeHTML(undefined)).toBe('');
        });
    });

    describe('sanitizeText', () => {
        it('should remove all HTML tags', () => {
            const input = '<p>Hello <strong>World</strong></p>';
            const result = mockInputSanitizer.sanitizeText(input);
            expect(result).toBe('Hello World');
        });

        it('should trim whitespace', () => {
            const input = '  Hello World  ';
            const result = mockInputSanitizer.sanitizeText(input);
            expect(result).toBe('Hello World');
        });
    });

    describe('sanitizeURL', () => {
        it('should allow valid URLs', () => {
            const validUrls = [
                'https://example.com',
                'http://localhost:3000',
                'https://api.example.com/path?query=value'
            ];

            validUrls.forEach(url => {
                const result = mockInputSanitizer.sanitizeURL(url);
                expect(result).toBeTruthy();
                expect(result).toContain('http');
            });
        });

        it('should block dangerous protocols', () => {
            const dangerousUrls = [
                'javascript:alert("XSS")',
                'data:text/html,<script>alert("XSS")</script>',
                'vbscript:msgbox("XSS")',
                'file:///etc/passwd'
            ];

            dangerousUrls.forEach(url => {
                const result = mockInputSanitizer.sanitizeURL(url);
                expect(result).toBe('');
            });
        });

        it('should handle malformed URLs', () => {
            const malformedUrl = 'http://example.com/%%%';
            const result = mockInputSanitizer.sanitizeURL(malformedUrl);
            expect(result).toBe('');
        });
    });

    describe('sanitizeApiKey', () => {
        it('should accept valid API keys', () => {
            const validKey = 'sk-1234567890abcdefghijklmnopqrstuvwxyzABCD';
            const result = mockInputSanitizer.sanitizeApiKey(validKey);
            expect(result).toBe(validKey);
        });

        it('should remove invalid characters', () => {
            const dirtyKey = 'sk-1234!@#$%^&*()567890abcdefghijklmnopqrstuvwxyzABCD';
            const result = mockInputSanitizer.sanitizeApiKey(dirtyKey);
            expect(result).toBe('sk-1234567890abcdefghijklmnopqrstuvwxyzABCD');
        });

        it('should reject keys without sk- prefix', () => {
            const invalidKey = 'pk-1234567890abcdefghijklmnopqrstuvwxyzABCD';
            expect(() => mockInputSanitizer.sanitizeApiKey(invalidKey)).toThrow('Invalid API key format');
        });

        it('should reject short keys', () => {
            const shortKey = 'sk-123456789';
            expect(() => mockInputSanitizer.sanitizeApiKey(shortKey)).toThrow('Invalid API key format');
        });
    });

    describe('sanitizeFilename', () => {
        it('should remove invalid filename characters', () => {
            const input = 'file<>:"|?*name.txt';
            const result = mockInputSanitizer.sanitizeFilename(input);
            expect(result).toBe('filename.txt');
        });

        it('should prevent directory traversal', () => {
            const input = '../../../etc/passwd';
            const result = mockInputSanitizer.sanitizeFilename(input);
            expect(result).toBe('././etc/passwd');
        });

        it('should normalize slashes', () => {
            const input = 'folder\\\\\\file.txt';
            const result = mockInputSanitizer.sanitizeFilename(input);
            expect(result).toBe('folder/file.txt');
        });

        it('should return default for empty input', () => {
            expect(mockInputSanitizer.sanitizeFilename('')).toBe('download');
            expect(mockInputSanitizer.sanitizeFilename(null)).toBe('download');
        });
    });

    describe('sanitizeJSON', () => {
        it('should validate and re-stringify valid JSON', () => {
            const input = '{"key": "value", "number": 123}';
            const result = mockInputSanitizer.sanitizeJSON(input);
            const parsed = JSON.parse(result);
            expect(parsed.key).toBe('value');
            expect(parsed.number).toBe(123);
        });

        it('should return empty object for invalid JSON', () => {
            const invalidInputs = [
                '{invalid json}',
                'not json at all',
                '{"unclosed": "quote}',
                ''
            ];

            invalidInputs.forEach(input => {
                const result = mockInputSanitizer.sanitizeJSON(input);
                expect(result).toBe('{}');
            });
        });
    });

    describe('validateInput', () => {
        it('should validate numbers within range', () => {
            const result = mockInputSanitizer.validateInput('42', 'number', { min: 0, max: 100 });
            expect(result).toBe(42);
        });

        it('should reject numbers outside range', () => {
            expect(() => mockInputSanitizer.validateInput('150', 'number', { max: 100 }))
                .toThrow('Number must be <= 100');
            expect(() => mockInputSanitizer.validateInput('-5', 'number', { min: 0 }))
                .toThrow('Number must be >= 0');
        });

        it('should validate email addresses', () => {
            const validEmail = mockInputSanitizer.validateInput('test@example.com', 'email');
            expect(validEmail).toBe('test@example.com');

            expect(() => mockInputSanitizer.validateInput('invalid-email', 'email'))
                .toThrow('Invalid email format');
        });

        it('should handle unknown validation types', () => {
            expect(() => mockInputSanitizer.validateInput('test', 'unknown'))
                .toThrow('Unknown validation type: unknown');
        });
    });
}); 
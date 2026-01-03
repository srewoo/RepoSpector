// Unit tests for GitLab Modern Selectors (2024+)
// Tests the DiffParser selectors and BatchProcessor parallel processing

// Mock the modules
const mockSanitizer = {
    sanitizeInput: jest.fn((input) => input)
};

const mockErrorHandler = {
    logError: jest.fn()
};

jest.mock('../../src/utils/sanitizer.js', () => ({
    Sanitizer: jest.fn().mockImplementation(() => mockSanitizer)
}));

jest.mock('../../src/utils/errorHandler.js', () => ({
    ErrorHandler: jest.fn().mockImplementation(() => mockErrorHandler)
}));

// Import the actual modules after mocking
const { DiffParser } = require('../../src/utils/diffParser.js');
const { BatchProcessor } = require('../../src/utils/batchProcessor.js');

describe('GitLab Modern Selectors', () => {
    let diffParser;

    beforeEach(() => {
        diffParser = new DiffParser();
        jest.clearAllMocks();
    });

    describe('Platform Detection', () => {
        it('should detect GitLab from URL', () => {
            expect(diffParser.detectPlatform('https://gitlab.com/user/repo')).toBe('gitlab');
        });

        it('should detect GitLab from self-hosted instance', () => {
            expect(diffParser.detectPlatform('https://gitlab.company.com/user/repo')).toBe('gitlab');
        });

        it('should detect GitLab MR page', () => {
            const url = 'https://gitlab.com/test/project/-/merge_requests/123/diffs';
            expect(diffParser.detectPlatform(url)).toBe('gitlab');
        });
    });

    describe('Platform Patterns - GitLab', () => {
        it('should have modern diff container selectors', () => {
            const gitlabPatterns = diffParser.platformPatterns.gitlab;

            expect(gitlabPatterns.diffContainer).toContain('[data-diff-file]');
            expect(gitlabPatterns.diffContainer).toContain('.diff-file');
            expect(gitlabPatterns.diffContainer).toContain('.diffs-batch');
            expect(gitlabPatterns.diffContainer).toContain('.diff-files-holder');
        });

        it('should have modern file header selectors', () => {
            const gitlabPatterns = diffParser.platformPatterns.gitlab;

            expect(gitlabPatterns.fileHeader).toContain('.diff-file-header');
            expect(gitlabPatterns.fileHeader).toContain('[data-path]');
            expect(gitlabPatterns.fileHeader).toContain('.file-header-content');
        });

        it('should have modern added line selectors', () => {
            const gitlabPatterns = diffParser.platformPatterns.gitlab;

            expect(gitlabPatterns.addedLines).toContain('.diff-tr.line_holder.new .line_content');
            expect(gitlabPatterns.addedLines).toContain('td.line_content.new');
            expect(gitlabPatterns.addedLines).toContain('.line_content.right-side.new');
        });

        it('should have modern removed line selectors', () => {
            const gitlabPatterns = diffParser.platformPatterns.gitlab;

            expect(gitlabPatterns.removedLines).toContain('.diff-tr.line_holder.old .line_content');
            expect(gitlabPatterns.removedLines).toContain('td.line_content.old');
            expect(gitlabPatterns.removedLines).toContain('.line_content.left-side.old');
        });

        it('should have modern line number selectors', () => {
            const gitlabPatterns = diffParser.platformPatterns.gitlab;

            expect(gitlabPatterns.lineNumber).toContain('.diff-line-num');
            expect(gitlabPatterns.lineNumber).toContain('[data-line-number]');
            expect(gitlabPatterns.lineNumber).toContain('.old_line');
            expect(gitlabPatterns.lineNumber).toContain('.new_line');
        });

        it('should have modern file name selectors', () => {
            const gitlabPatterns = diffParser.platformPatterns.gitlab;

            expect(gitlabPatterns.fileName).toContain('.diff-file-header .file-title-name');
            expect(gitlabPatterns.fileName).toContain('[data-path]');
            expect(gitlabPatterns.fileName).toContain('.file-header-content .file-path');
        });
    });

    describe('Platform Patterns - GitHub', () => {
        it('should have modern GitHub diff selectors', () => {
            const githubPatterns = diffParser.platformPatterns.github;

            expect(githubPatterns.diffContainer).toContain('[data-testid="diff-view"]');
            expect(githubPatterns.diffContainer).toContain('[data-hpc="true"]');
            expect(githubPatterns.addedLines).toContain('[data-code-marker="+"]');
            expect(githubPatterns.removedLines).toContain('[data-code-marker="-"]');
            expect(githubPatterns.fileName).toContain('[data-tagsearch-path]');
        });
    });

    describe('Language Detection', () => {
        it('should detect JavaScript', () => {
            expect(diffParser.detectLanguage('src/app.js')).toBe('javascript');
            expect(diffParser.detectLanguage('component.jsx')).toBe('javascript');
        });

        it('should detect TypeScript', () => {
            expect(diffParser.detectLanguage('src/app.ts')).toBe('typescript');
            expect(diffParser.detectLanguage('component.tsx')).toBe('typescript');
        });

        it('should detect Python', () => {
            expect(diffParser.detectLanguage('main.py')).toBe('python');
        });

        it('should detect Java', () => {
            expect(diffParser.detectLanguage('App.java')).toBe('java');
        });

        it('should detect Go', () => {
            expect(diffParser.detectLanguage('main.go')).toBe('go');
        });

        it('should return text for unknown extensions', () => {
            expect(diffParser.detectLanguage('readme.unknown')).toBe('text');
        });
    });

    describe('Change Type Detection', () => {
        it('should detect added files', () => {
            const mockElement = {
                className: 'file added',
                textContent: 'new file mode 100644'
            };
            expect(diffParser.detectChangeType(mockElement)).toBe('added');
        });

        it('should detect deleted files', () => {
            const mockElement = {
                className: 'file deleted',
                textContent: 'deleted file mode 100644'
            };
            expect(diffParser.detectChangeType(mockElement)).toBe('deleted');
        });

        it('should detect renamed files', () => {
            const mockElement = {
                className: 'file renamed',
                textContent: 'renamed from old.js to new.js'
            };
            expect(diffParser.detectChangeType(mockElement)).toBe('renamed');
        });

        it('should default to modified', () => {
            const mockElement = {
                className: 'file',
                textContent: 'some changes'
            };
            expect(diffParser.detectChangeType(mockElement)).toBe('modified');
        });
    });

    describe('Diff Summary Generation', () => {
        it('should generate summary from files', () => {
            const files = [
                { type: 'added', language: 'javascript', changes: { additions: 10, deletions: 0 } },
                { type: 'modified', language: 'javascript', changes: { additions: 5, deletions: 3 } },
                { type: 'deleted', language: 'typescript', changes: { additions: 0, deletions: 20 } }
            ];

            const summary = diffParser.generateDiffSummary(files);

            expect(summary.totalFiles).toBe(3);
            expect(summary.addedFiles).toBe(1);
            expect(summary.modifiedFiles).toBe(1);
            expect(summary.deletedFiles).toBe(1);
            expect(summary.languages).toContain('javascript');
            expect(summary.languages).toContain('typescript');
        });
    });

    describe('Diff Content Detection', () => {
        it('should detect valid diff content', () => {
            const diffContent = `diff --git a/file.js b/file.js
--- a/file.js
+++ b/file.js
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;`;

            expect(diffParser.isDiffContent(diffContent)).toBe(true);
        });

        it('should reject non-diff content', () => {
            const regularCode = `function test() {
    return 42;
}`;

            expect(diffParser.isDiffContent(regularCode)).toBe(false);
        });
    });
});

describe('BatchProcessor Parallel Processing', () => {
    let processor;

    beforeEach(() => {
        processor = new BatchProcessor({
            initialConcurrent: 3,
            minConcurrent: 1,
            maxConcurrentLimit: 5
        });
        jest.clearAllMocks();
    });

    describe('Adaptive Concurrency Settings', () => {
        it('should initialize with default concurrency settings', () => {
            const defaultProcessor = new BatchProcessor();

            expect(defaultProcessor.maxConcurrent).toBe(3);
            expect(defaultProcessor.minConcurrent).toBe(1);
            expect(defaultProcessor.maxConcurrentLimit).toBe(5);
            expect(defaultProcessor.currentConcurrent).toBe(3);
        });

        it('should respect custom concurrency settings', () => {
            expect(processor.minConcurrent).toBe(1);
            expect(processor.maxConcurrentLimit).toBe(5);
            expect(processor.currentConcurrent).toBe(3);
        });

        it('should have success rate threshold', () => {
            expect(processor.successRateThreshold).toBe(0.8);
        });

        it('should have average time threshold', () => {
            expect(processor.avgTimeThreshold).toBe(10000);
        });
    });

    describe('Test Signature Creation', () => {
        it('should create consistent signatures for same tests', () => {
            const test1 = `it('should add numbers', () => { expect(add(1, 2)).toBe(3); });`;
            const test2 = `it('should add numbers', () => { expect(add(1, 2)).toBe(3); });`;

            const sig1 = processor.createTestSignature(test1);
            const sig2 = processor.createTestSignature(test2);

            expect(sig1).toBe(sig2);
        });

        it('should create different signatures for different tests', () => {
            const test1 = `it('should add numbers', () => { expect(add(1, 2)).toBe(3); });`;
            const test2 = `it('should subtract numbers', () => { expect(sub(3, 1)).toBe(2); });`;

            const sig1 = processor.createTestSignature(test1);
            const sig2 = processor.createTestSignature(test2);

            expect(sig1).not.toBe(sig2);
        });

        it('should handle whitespace differences', () => {
            const test1 = `it('test', () => {});`;
            const test2 = `it('test',   ()   =>   {});`;

            const sig1 = processor.createTestSignature(test1);
            const sig2 = processor.createTestSignature(test2);

            expect(sig1).toBe(sig2);
        });
    });

    describe('Simple Hash Function', () => {
        it('should generate consistent hashes', () => {
            const hash1 = processor.simpleHash('test string');
            const hash2 = processor.simpleHash('test string');

            expect(hash1).toBe(hash2);
        });

        it('should generate different hashes for different strings', () => {
            const hash1 = processor.simpleHash('test string');
            const hash2 = processor.simpleHash('different string');

            expect(hash1).not.toBe(hash2);
        });

        it('should return hexadecimal string', () => {
            const hash = processor.simpleHash('test');

            expect(hash).toMatch(/^[0-9a-f]+$/);
        });
    });

    describe('Test Extraction', () => {
        it('should extract Jest-style tests', () => {
            const content = `
                it('should work', () => {
                    expect(true).toBe(true);
                });
            `;

            const tests = processor.extractTests(content);

            expect(tests.length).toBeGreaterThan(0);
        });

        it('should extract describe blocks', () => {
            const content = `
                describe('MyModule', () => {
                    it('should work', () => {});
                });
            `;

            const tests = processor.extractTests(content);

            expect(tests.length).toBeGreaterThan(0);
        });

        it('should return whole content if no tests found', () => {
            const content = 'function helper() { return 42; }';

            const tests = processor.extractTests(content);

            expect(tests).toContain(content);
        });

        it('should handle empty content', () => {
            const tests = processor.extractTests('');

            expect(tests).toEqual([]);
        });

        it('should handle null content', () => {
            const tests = processor.extractTests(null);

            expect(tests).toEqual([]);
        });
    });

    describe('Test Deduplication', () => {
        it('should deduplicate identical test results', () => {
            const results = [
                { success: true, data: `it('test1', () => {});` },
                { success: true, data: `it('test1', () => {});` },
                { success: true, data: `it('test2', () => {});` },
            ];

            const deduped = processor.deduplicateTestResults(results);

            // Should have less than 3 tests due to deduplication
            expect(deduped.length).toBeLessThanOrEqual(2);
        });

        it('should skip failed results', () => {
            const results = [
                { success: true, data: `it('test1', () => {});` },
                { success: false, data: null },
                { success: true, data: `it('test2', () => {});` },
            ];

            const deduped = processor.deduplicateTestResults(results);

            expect(deduped.length).toBe(2);
        });
    });

    describe('Stats Tracking', () => {
        it('should return correct stats structure', () => {
            const stats = processor.getStats();

            expect(stats).toHaveProperty('totalRequests');
            expect(stats).toHaveProperty('completedRequests');
            expect(stats).toHaveProperty('failedRequests');
            expect(stats).toHaveProperty('activeRequests');
            expect(stats).toHaveProperty('successRate');
            expect(stats).toHaveProperty('averageProcessingTime');
            expect(stats).toHaveProperty('totalProcessingTime');
        });
    });

    describe('Non-Retryable Error Detection', () => {
        it('should identify API key errors as non-retryable', () => {
            const error = new Error('Invalid API key');
            expect(processor.isNonRetryableError(error)).toBe(true);
        });

        it('should identify authentication errors as non-retryable', () => {
            const error = new Error('Authentication failed');
            expect(processor.isNonRetryableError(error)).toBe(true);
        });

        it('should identify authorization errors as non-retryable', () => {
            const error = new Error('Authorization required');
            expect(processor.isNonRetryableError(error)).toBe(true);
        });

        it('should identify bad request errors as non-retryable', () => {
            const error = new Error('Bad request: invalid parameter');
            expect(processor.isNonRetryableError(error)).toBe(true);
        });

        it('should allow retry for network errors', () => {
            const error = new Error('Network timeout');
            expect(processor.isNonRetryableError(error)).toBe(false);
        });
    });
});

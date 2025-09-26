import { ErrorHandler } from './errorHandler.js';

// Batch processor for parallel OpenAI API requests
export class BatchProcessor {
    constructor(options = {}) {
        this.errorHandler = new ErrorHandler();
        
        // Configuration
        this.maxConcurrent = options.maxConcurrent || 3;
        this.retryAttempts = options.retryAttempts || 2;
        this.retryDelay = options.retryDelay || 1000;
        this.timeout = options.timeout || 30000; // 30 seconds per request
        
        // Processing state
        this.activeRequests = 0;
        this.completedRequests = 0;
        this.failedRequests = 0;
        this.totalRequests = 0;
        
        // Queue management
        this.queue = [];
        this.results = [];
        this.errors = [];
        
        // Performance tracking
        this.startTime = null;
        this.endTime = null;
        this.processingTimes = [];
    }
    
    /**
     * Process batches of items in parallel with intelligent concurrency control
     */
    async processBatches(batches, processingFunction, progressCallback = null) {
        try {
            this.resetStats();
            this.startTime = Date.now();
            this.totalRequests = batches.reduce((total, batch) => total + batch.length, 0);

            const allPromises = [];
            const semaphore = this.createSemaphore(this.maxConcurrent);

            // Process each batch with concurrency control
            for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
                const batch = batches[batchIndex];
                
                for (let itemIndex = 0; itemIndex < batch.length; itemIndex++) {
                    const item = batch[itemIndex];
                    const promise = this.processWithSemaphore(
                        semaphore,
                        item,
                        processingFunction,
                        batchIndex,
                        itemIndex,
                        progressCallback
                    );
                    allPromises.push(promise);
                }
            }

            // Wait for all processing to complete
            const results = await Promise.allSettled(allPromises);
            
            this.endTime = Date.now();
            
            // Analyze results
            const processedResults = this.analyzeResults(results);
            
            // Final progress update
            if (progressCallback) {
                progressCallback({
                    completed: this.completedRequests,
                    failed: this.failedRequests,
                    total: this.totalRequests,
                    percentage: 100,
                    duration: this.endTime - this.startTime,
                    averageTime: this.getAverageProcessingTime()
                });
            }

            return processedResults;

        } catch (error) {
            this.errorHandler.logError('Batch processing', error);
            throw error;
        }
    }
    
    /**
     * Create a semaphore to control concurrency
     */
    createSemaphore(maxConcurrent) {
        let current = 0;
        const queue = [];

        return {
            async acquire() {
                return new Promise((resolve) => {
                    if (current < maxConcurrent) {
                        current++;
                        resolve();
                    } else {
                        queue.push(resolve);
                    }
                });
            },

            release() {
                current--;
                if (queue.length > 0) {
                    current++;
                    const resolve = queue.shift();
                    resolve();
                }
            }
        };
    }
    
    /**
     * Process an item with semaphore control and retry logic
     */
    async processWithSemaphore(semaphore, item, processingFunction, batchIndex, itemIndex, progressCallback) {
        await semaphore.acquire();
        
        try {
            this.activeRequests++;
            const itemStartTime = Date.now();
            
            const result = await this.processWithRetry(item, processingFunction);
            
            const itemEndTime = Date.now();
            this.processingTimes.push(itemEndTime - itemStartTime);
            
            this.completedRequests++;
            this.activeRequests--;
            
            // Progress update
            if (progressCallback) {
                const percentage = Math.round((this.completedRequests / this.totalRequests) * 100);
                progressCallback({
                    completed: this.completedRequests,
                    failed: this.failedRequests,
                    total: this.totalRequests,
                    percentage,
                    currentBatch: batchIndex,
                    currentItem: itemIndex,
                    activeRequests: this.activeRequests,
                    averageTime: this.getAverageProcessingTime()
                });
            }
            
            return {
                success: true,
                data: result,
                batchIndex,
                itemIndex,
                processingTime: itemEndTime - itemStartTime
            };

        } catch (error) {
            this.failedRequests++;
            this.activeRequests--;
            
            this.errorHandler.logError(`Batch item ${batchIndex}-${itemIndex}`, error);
            
            return {
                success: false,
                error: error.message,
                batchIndex,
                itemIndex
            };

        } finally {
            semaphore.release();
        }
    }
    
    /**
     * Process with retry logic
     */
    async processWithRetry(item, processingFunction) {
        let lastError;
        
        for (let attempt = 0; attempt <= this.retryAttempts; attempt++) {
            try {
                // Add timeout to prevent hanging requests
                return await this.withTimeout(
                    processingFunction(item),
                    this.timeout
                );
                
            } catch (error) {
                lastError = error;
                
                // Don't retry on certain types of errors
                if (this.isNonRetryableError(error)) {
                    throw error;
                }
                
                // Wait before retry (exponential backoff)
                if (attempt < this.retryAttempts) {
                    const delay = this.retryDelay * Math.pow(2, attempt);
                    await this.sleep(delay);
                }
            }
        }
        
        throw lastError;
    }
    
    /**
     * Add timeout to a promise
     */
    async withTimeout(promise, timeoutMs) {
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        
        return Promise.race([promise, timeoutPromise]);
    }
    
    /**
     * Check if an error should not be retried
     */
    isNonRetryableError(error) {
        const nonRetryablePatterns = [
            /API key/i,
            /authentication/i,
            /authorization/i,
            /forbidden/i,
            /bad request/i,
            /invalid.*parameter/i
        ];
        
        return nonRetryablePatterns.some(pattern => pattern.test(error.message));
    }
    
    /**
     * Sleep utility
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    /**
     * Analyze processing results
     */
    analyzeResults(results) {
        const successful = [];
        const failed = [];
        
        results.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value.success) {
                successful.push(result.value);
            } else {
                failed.push({
                    index,
                    error: result.reason || result.value?.error || 'Unknown error'
                });
            }
        });
        
        return {
            successful,
            failed,
            totalProcessed: results.length,
            successRate: (successful.length / results.length) * 100,
            processingTime: this.endTime - this.startTime,
            averageTime: this.getAverageProcessingTime()
        };
    }
    
    /**
     * Get average processing time
     */
    getAverageProcessingTime() {
        if (this.processingTimes.length === 0) return 0;
        return this.processingTimes.reduce((sum, time) => sum + time, 0) / this.processingTimes.length;
    }
    
    /**
     * Reset statistics
     */
    resetStats() {
        this.activeRequests = 0;
        this.completedRequests = 0;
        this.failedRequests = 0;
        this.totalRequests = 0;
        this.processingTimes = [];
        this.startTime = null;
        this.endTime = null;
    }
    
    /**
     * Merge processing results intelligently based on merge strategy
     */
    mergeResults(results, strategy = 'concat') {
        try {
            if (!results || !results.successful || results.successful.length === 0) {
                throw new Error('No successful results to merge');
            }

            const successfulData = results.successful.map(r => r.data);

            switch (strategy) {
                case 'intelligent':
                    return this.intelligentMerge(successfulData);
                    
                case 'concat':
                    return this.concatMerge(successfulData);
                    
                case 'deduplicate':
                    return this.deduplicateMerge(successfulData);
                    
                case 'prioritized':
                    return this.prioritizedMerge(successfulData);
                    
                case 'structured':
                    return this.structuredMerge(successfulData);
                    
                default:
                    return this.concatMerge(successfulData);
            }

        } catch (error) {
            this.errorHandler.logError('Result merging', error);
            throw error;
        }
    }
    
    /**
     * Intelligent merge - detects content type and merges accordingly
     */
    intelligentMerge(results) {
        if (results.length === 1) {
            return results[0];
        }

        // Detect if results are test cases
        if (this.isTestContent(results[0])) {
            return this.mergeTestCases(results);
        }
        
        // Detect if results are code snippets
        if (this.isCodeContent(results[0])) {
            return this.mergeCodeSnippets(results);
        }
        
        // Default to structured merge
        return this.structuredMerge(results);
    }
    
    /**
     * Check if content appears to be test cases
     */
    isTestContent(content) {
        const testIndicators = [
            /test\s*\(/i,
            /describe\s*\(/i,
            /it\s*\(/i,
            /expect\s*\(/i,
            /assert/i,
            /@Test/,
            /\.should\./,
            /\.toBe\(/,
            /\.toEqual\(/
        ];
        
        return testIndicators.some(pattern => pattern.test(content));
    }
    
    /**
     * Check if content appears to be code
     */
    isCodeContent(content) {
        const codeIndicators = [
            /function\s+\w+/,
            /class\s+\w+/,
            /const\s+\w+/,
            /let\s+\w+/,
            /var\s+\w+/,
            /def\s+\w+/,
            /public\s+\w+/,
            /private\s+\w+/
        ];
        
        return codeIndicators.some(pattern => pattern.test(content));
    }
    
    /**
     * Merge test cases with intelligent organization
     */
    mergeTestCases(results) {
        let mergedTests = '';
        let _testCount = 0;
        
        // Extract setup/teardown sections
        const setups = [];
        const teardowns = [];
        const tests = [];
        
        results.forEach((result, _index) => {
            // Split into sections
            const sections = this.parseTestSections(result);
            
            if (sections.setup) setups.push(sections.setup);
            if (sections.teardown) teardowns.push(sections.teardown);
            if (sections.tests) tests.push(sections.tests);
        });
        
        // Build merged test file
        mergedTests += this.generateTestHeader();
        
        // Merge setups (deduplicated)
        if (setups.length > 0) {
            mergedTests += '\n// Setup\n';
            mergedTests += this.deduplicateCode(setups);
            mergedTests += '\n';
        }
        
        // Add all tests
        tests.forEach(testSection => {
            mergedTests += '\n' + testSection + '\n';
        });
        
        // Merge teardowns (deduplicated)
        if (teardowns.length > 0) {
            mergedTests += '\n// Teardown\n';
            mergedTests += this.deduplicateCode(teardowns);
        }
        
        return mergedTests;
    }
    
    /**
     * Parse test file into sections
     */
    parseTestSections(testContent) {
        const sections = {
            setup: '',
            tests: '',
            teardown: ''
        };
        
        // Simple heuristic-based parsing
        const lines = testContent.split('\n');
        let currentSection = 'tests'; // default
        
        lines.forEach(line => {
            if (/beforeEach|beforeAll|setUp|@Before/i.test(line)) {
                currentSection = 'setup';
            } else if (/afterEach|afterAll|tearDown|@After/i.test(line)) {
                currentSection = 'teardown';
            } else if (/describe|test|it\s*\(|@Test/i.test(line)) {
                currentSection = 'tests';
            }
            
            sections[currentSection] += line + '\n';
        });
        
        return sections;
    }
    
    /**
     * Generate test file header
     */
    generateTestHeader() {
        return `// Merged Test Suite
// Generated by RepoSpector
// Date: ${new Date().toISOString()}

`;
    }
    
    /**
     * Deduplicate code sections
     */
    deduplicateCode(codeArrays) {
        const uniqueLines = new Set();
        let result = '';
        
        codeArrays.forEach(code => {
            const lines = code.split('\n');
            lines.forEach(line => {
                const trimmed = line.trim();
                if (trimmed && !uniqueLines.has(trimmed)) {
                    uniqueLines.add(trimmed);
                    result += line + '\n';
                }
            });
        });
        
        return result;
    }
    
    /**
     * Merge code snippets
     */
    mergeCodeSnippets(results) {
        let merged = '';
        
        results.forEach((result, index) => {
            merged += `// Chunk ${index + 1}\n`;
            merged += result;
            merged += '\n\n' + '='.repeat(50) + '\n\n';
        });
        
        return merged;
    }
    
    /**
     * Simple concatenation merge
     */
    concatMerge(results) {
        return results.join('\n\n');
    }
    
    /**
     * Deduplicate merge
     */
    deduplicateMerge(results) {
        const unique = [...new Set(results)];
        return unique.join('\n\n');
    }
    
    /**
     * Prioritized merge - keeps results from earlier chunks first
     */
    prioritizedMerge(results) {
        // Sort by processing time or batch index if available
        const sorted = results.sort((a, b) => {
            // Prefer shorter results (likely more focused)
            return a.length - b.length;
        });
        
        return sorted.join('\n\n');
    }
    
    /**
     * Structured merge - organizes results by type/category
     */
    structuredMerge(results) {
        const structure = {
            imports: [],
            constants: [],
            functions: [],
            classes: [],
            tests: [],
            other: []
        };
        
        results.forEach(result => {
            const category = this.categorizeCode(result);
            structure[category].push(result);
        });
        
        let merged = '';
        
        // Build in logical order
        if (structure.imports.length > 0) {
            merged += '// Imports\n' + structure.imports.join('\n') + '\n\n';
        }
        
        if (structure.constants.length > 0) {
            merged += '// Constants\n' + structure.constants.join('\n') + '\n\n';
        }
        
        if (structure.classes.length > 0) {
            merged += '// Classes\n' + structure.classes.join('\n\n') + '\n\n';
        }
        
        if (structure.functions.length > 0) {
            merged += '// Functions\n' + structure.functions.join('\n\n') + '\n\n';
        }
        
        if (structure.tests.length > 0) {
            merged += '// Tests\n' + structure.tests.join('\n\n') + '\n\n';
        }
        
        if (structure.other.length > 0) {
            merged += '// Other\n' + structure.other.join('\n\n');
        }
        
        return merged;
    }
    
    /**
     * Categorize code content
     */
    categorizeCode(code) {
        if (/^import|^from.*import|^require\(/.test(code.trim())) {
            return 'imports';
        }
        
        if (/^const\s+[A-Z_]+|^let\s+[A-Z_]+|^var\s+[A-Z_]+/.test(code.trim())) {
            return 'constants';
        }
        
        if (/class\s+\w+/.test(code)) {
            return 'classes';
        }
        
        if (/function\s+\w+|const\s+\w+\s*=.*=>/.test(code)) {
            return 'functions';
        }
        
        if (this.isTestContent(code)) {
            return 'tests';
        }
        
        return 'other';
    }
    
    /**
     * Get processing statistics
     */
    getStats() {
        return {
            totalRequests: this.totalRequests,
            completedRequests: this.completedRequests,
            failedRequests: this.failedRequests,
            activeRequests: this.activeRequests,
            successRate: this.totalRequests > 0 ? (this.completedRequests / this.totalRequests) * 100 : 0,
            averageProcessingTime: this.getAverageProcessingTime(),
            totalProcessingTime: this.endTime ? this.endTime - this.startTime : Date.now() - (this.startTime || Date.now())
        };
    }
} 
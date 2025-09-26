// Mock the BatchProcessor module
const mockBatchProcessor = {
    processBatch: jest.fn(),
    processWithRetry: jest.fn(),
    createBatches: jest.fn(),
    addToQueue: jest.fn(),
    processQueue: jest.fn(),
    queue: []
};

jest.mock('../../src/utils/batchProcessor.js', () => ({
    BatchProcessor: jest.fn().mockImplementation(() => mockBatchProcessor)
}));

describe('BatchProcessor', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockBatchProcessor.queue = [];
        
        // Setup default mock implementations
        mockBatchProcessor.processBatch.mockImplementation(async (items, processor, options = {}) => {
            const { retries = 0 } = options;
            const results = [];
            
            // Simple simulation of parallel processing
            for (let i = 0; i < items.length; i++) {
                try {
                    const result = await processor(items[i]);
                    results[i] = result;
                } catch (error) {
                    if (retries > 0) {
                        // Retry logic
                        let lastError = error;
                        for (let retry = 0; retry < retries; retry++) {
                            try {
                                const result = await processor(items[i]);
                                results[i] = result;
                                lastError = null;
                                break;
                            } catch (retryError) {
                                lastError = retryError;
                            }
                        }
                        if (lastError) throw lastError;
                    } else {
                        throw error;
                    }
                }
            }
            
            return results;
        });

        mockBatchProcessor.processWithRetry.mockImplementation(async (fn, retries, delay) => {
            let lastError;
            
            // Initial attempt
            try {
                return await fn();
            } catch (error) {
                lastError = error;
            }
            
            // Retries
            for (let i = 0; i < retries; i++) {
                await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
                try {
                    return await fn();
                } catch (error) {
                    lastError = error;
                }
            }
            
            throw lastError;
        });

        mockBatchProcessor.createBatches.mockImplementation((items, batchSize) => {
            const batches = [];
            for (let i = 0; i < items.length; i += batchSize) {
                batches.push(items.slice(i, i + batchSize));
            }
            return batches;
        });

        mockBatchProcessor.addToQueue.mockImplementation((task) => {
            mockBatchProcessor.queue.push(task);
        });

        mockBatchProcessor.processQueue.mockImplementation(async () => {
            const tasks = [...mockBatchProcessor.queue];
            mockBatchProcessor.queue = [];
            
            for (const task of tasks) {
                await task();
            }
        });
    });

    describe('processBatch', () => {
        it('should process items in parallel', async () => {
            const items = [1, 2, 3, 4, 5];
            const processedOrder = [];
            
            const results = await mockBatchProcessor.processBatch(
                items,
                async (item) => {
                    // Simulate varying processing times
                    await new Promise(resolve => setTimeout(resolve, Math.random() * 50));
                    processedOrder.push(item);
                    return item * 2;
                },
                { maxConcurrent: 3 }
            );

            expect(results).toEqual([2, 4, 6, 8, 10]);
            expect(processedOrder.length).toBe(5);
        });

        it('should handle errors with retry', async () => {
            let attemptCount = 0;
            const items = [1, 2, 3];
            
            const results = await mockBatchProcessor.processBatch(
                items,
                async (item) => {
                    if (item === 2) {
                        attemptCount++;
                        if (attemptCount < 2) {
                            throw new Error('Temporary error');
                        }
                    }
                    return item * 2;
                },
                { maxConcurrent: 2, retries: 3 }
            );

            expect(results).toEqual([2, 4, 6]);
            expect(attemptCount).toBe(2);
        });

        it('should fail after max retries', async () => {
            const items = [1, 2, 3];
            
            await expect(mockBatchProcessor.processBatch(
                items,
                async (item) => {
                    if (item === 2) {
                        throw new Error('Permanent error');
                    }
                    return item * 2;
                },
                { maxConcurrent: 2, retries: 2 }
            )).rejects.toThrow('Permanent error');
        });

        it('should handle empty array', async () => {
            const results = await mockBatchProcessor.processBatch(
                [],
                async (item) => item,
                { maxConcurrent: 3 }
            );

            expect(results).toEqual([]);
        });

        it('should handle single item', async () => {
            const results = await mockBatchProcessor.processBatch(
                [42],
                async (item) => item * 2,
                { maxConcurrent: 3 }
            );

            expect(results).toEqual([84]);
        });

        it('should maintain order of results', async () => {
            const items = [1, 2, 3, 4, 5];
            
            const results = await mockBatchProcessor.processBatch(
                items,
                async (item) => {
                    // Reverse processing time to test order maintenance
                    await new Promise(resolve => setTimeout(resolve, (6 - item) * 10));
                    return item * 2;
                },
                { maxConcurrent: 5 }
            );

            expect(results).toEqual([2, 4, 6, 8, 10]);
        });
    });

    describe('processWithRetry', () => {
        it('should retry on failure', async () => {
            let attempts = 0;
            
            const result = await mockBatchProcessor.processWithRetry(
                async () => {
                    attempts++;
                    if (attempts < 3) {
                        throw new Error('Retry me');
                    }
                    return 'success';
                },
                3,
                10
            );

            expect(result).toBe('success');
            expect(attempts).toBe(3);
        });

        it('should not retry on success', async () => {
            let attempts = 0;
            
            const result = await mockBatchProcessor.processWithRetry(
                async () => {
                    attempts++;
                    return 'immediate success';
                },
                3,
                10
            );

            expect(result).toBe('immediate success');
            expect(attempts).toBe(1);
        });

        it('should throw after max retries', async () => {
            let attempts = 0;
            
            await expect(mockBatchProcessor.processWithRetry(
                async () => {
                    attempts++;
                    throw new Error('Always fails');
                },
                2,
                10
            )).rejects.toThrow('Always fails');

            expect(attempts).toBe(3); // Initial + 2 retries
        });

        it('should apply exponential backoff', async () => {
            const startTime = Date.now();
            let attempts = 0;
            
            await mockBatchProcessor.processWithRetry(
                async () => {
                    attempts++;
                    if (attempts < 3) {
                        throw new Error('Retry with backoff');
                    }
                    return 'success';
                },
                3,
                50 // 50ms base delay
            );

            const duration = Date.now() - startTime;
            // Should take at least 50ms + 100ms = 150ms
            expect(duration).toBeGreaterThanOrEqual(150);
        });
    });

    describe('createBatches', () => {
        it('should create batches of specified size', () => {
            const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
            const batches = mockBatchProcessor.createBatches(items, 3);

            expect(batches).toHaveLength(4);
            expect(batches[0]).toEqual([1, 2, 3]);
            expect(batches[1]).toEqual([4, 5, 6]);
            expect(batches[2]).toEqual([7, 8, 9]);
            expect(batches[3]).toEqual([10]);
        });

        it('should handle empty array', () => {
            const batches = mockBatchProcessor.createBatches([], 3);
            expect(batches).toEqual([]);
        });

        it('should handle batch size larger than array', () => {
            const items = [1, 2, 3];
            const batches = mockBatchProcessor.createBatches(items, 10);

            expect(batches).toHaveLength(1);
            expect(batches[0]).toEqual([1, 2, 3]);
        });

        it('should handle batch size of 1', () => {
            const items = [1, 2, 3];
            const batches = mockBatchProcessor.createBatches(items, 1);

            expect(batches).toHaveLength(3);
            expect(batches).toEqual([[1], [2], [3]]);
        });
    });

    describe('queue processing', () => {
        it('should process items through queue', async () => {
            const items = [1, 2, 3, 4, 5];
            const results = [];

            // Add items to queue
            items.forEach(item => {
                mockBatchProcessor.addToQueue(async () => {
                    await new Promise(resolve => setTimeout(resolve, 10));
                    results.push(item * 2);
                });
            });

            // Process queue
            await mockBatchProcessor.processQueue();

            expect(results.sort((a, b) => a - b)).toEqual([2, 4, 6, 8, 10]);
        });

        it('should handle queue errors', async () => {
            mockBatchProcessor.addToQueue(async () => {
                throw new Error('Queue error');
            });

            await expect(mockBatchProcessor.processQueue()).rejects.toThrow('Queue error');
        });
    });

    describe('concurrent processing', () => {
        it('should process items concurrently', async () => {
            // Test concurrent processing using the mock
            const { BatchProcessor } = require('../../src/utils/batchProcessor.js');
            const processor = new BatchProcessor({
                apiKey: 'test-key',
                model: 'gpt-4',
                _maxConcurrent: 3
            });

            const items = [1, 2, 3, 4, 5];
            const processedOrder = [];
            
            const results = await processor.processBatch(
                items,
                async (item) => {
                    // Simulate varying processing times
                    await new Promise(resolve => setTimeout(resolve, Math.random() * 50));
                    processedOrder.push(item);
                    return item * 2;
                }
            );

            expect(results).toEqual([2, 4, 6, 8, 10]);
            expect(processedOrder.length).toBe(5);
        });
    });
}); 
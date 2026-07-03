/**
 * Tests for the REAL BatchProcessor (src/utils/batchProcessor.js) — no mocks.
 * Previously this suite jest.mock'd the subject and tested inline fakes with
 * methods ('processBatch', 'createBatches', 'addToQueue') that do not exist in
 * production. The real class uses a semaphore-based processBatches API.
 */

const { BatchProcessor } = require('../../src/utils/batchProcessor.js');

describe('BatchProcessor', () => {
    describe('processBatches', () => {
        it('should process all items and report a 100% success rate', async () => {
            const bp = new BatchProcessor({ maxConcurrent: 2 });
            const batches = [['a', 'b'], ['c']];
            const results = await bp.processBatches(batches, async (item) => `done:${item}`);

            expect(results.totalProcessed).toBe(3);
            expect(results.successful).toHaveLength(3);
            expect(results.failed).toHaveLength(0);
            expect(results.successRate).toBe(100);
            expect(results.successful.map(r => r.data).sort()).toEqual(['done:a', 'done:b', 'done:c']);
        });

        it('should capture failures without throwing', async () => {
            const bp = new BatchProcessor({ maxConcurrent: 2, retryAttempts: 0 });
            const results = await bp.processBatches([['ok', 'boom']], async (item) => {
                if (item === 'boom') throw new Error('network glitch');
                return item;
            });
            expect(results.successful).toHaveLength(1);
            expect(results.failed).toHaveLength(1);
            expect(results.successRate).toBe(50);
        });

        it('should invoke the progress callback', async () => {
            const bp = new BatchProcessor({ maxConcurrent: 1 });
            const progress = jest.fn();
            await bp.processBatches([['a', 'b']], async (x) => x, progress);
            expect(progress).toHaveBeenCalled();
            const last = progress.mock.calls[progress.mock.calls.length - 1][0];
            expect(last.percentage).toBe(100);
        });
    });

    describe('processWithRetry', () => {
        it('should retry retryable failures then succeed', async () => {
            const bp = new BatchProcessor({ retryAttempts: 2, retryDelay: 1 });
            let calls = 0;
            const fn = async () => {
                calls += 1;
                if (calls < 3) throw new Error('temporary network error');
                return 'ok';
            };
            const out = await bp.processWithRetry('item', fn);
            expect(out).toBe('ok');
            expect(calls).toBe(3);
        });

        it('should not retry non-retryable errors', async () => {
            const bp = new BatchProcessor({ retryAttempts: 3, retryDelay: 1 });
            let calls = 0;
            const fn = async () => {
                calls += 1;
                throw new Error('Invalid API key');
            };
            await expect(bp.processWithRetry('item', fn)).rejects.toThrow(/API key/);
            expect(calls).toBe(1);
        });
    });

    describe('isNonRetryableError', () => {
        it('should classify auth/validation errors as non-retryable', () => {
            const bp = new BatchProcessor();
            expect(bp.isNonRetryableError(new Error('Invalid API key'))).toBe(true);
            expect(bp.isNonRetryableError(new Error('403 forbidden'))).toBe(true);
            expect(bp.isNonRetryableError(new Error('bad request'))).toBe(true);
            expect(bp.isNonRetryableError(new Error('socket timeout'))).toBe(false);
            expect(bp.isNonRetryableError('rate limited')).toBe(false);
        });
    });

    describe('mergeResults', () => {
        it('should concat successful string results with blank-line separators', () => {
            const bp = new BatchProcessor();
            const merged = bp.mergeResults(
                { successful: [{ data: 'one' }, { data: 'two' }] },
                'concat'
            );
            expect(merged).toBe('one\n\ntwo');
        });

        it('should throw when there are no successful results', () => {
            const bp = new BatchProcessor();
            expect(() => bp.mergeResults({ successful: [] }, 'concat')).toThrow(/No successful results/);
        });
    });

    describe('createSemaphore', () => {
        it('should limit concurrency to the configured maximum', async () => {
            const bp = new BatchProcessor();
            const sem = bp.createSemaphore(2);
            let active = 0;
            let maxActive = 0;

            const task = async () => {
                await sem.acquire();
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise(r => setTimeout(r, 5));
                active -= 1;
                sem.release();
            };

            await Promise.all(Array.from({ length: 6 }, task));
            expect(maxActive).toBeLessThanOrEqual(2);
        });
    });
});

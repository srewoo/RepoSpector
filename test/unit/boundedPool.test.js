const { mapPool } = require('../../src/utils/boundedPool.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('mapPool', () => {
    it('returns results in input order under shuffled completion', async () => {
        const delays = [30, 5, 20, 1, 10];
        const out = await mapPool(delays, 3, async (ms, i) => { await sleep(ms); return `r${i}`; });
        expect(out).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    });

    it('never exceeds the limit', async () => {
        let inFlight = 0;
        let peak = 0;
        await mapPool(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await sleep(5);
            inFlight--;
        });
        expect(peak).toBe(3);
    });

    it('rejects with the first error and starts nothing after it', async () => {
        const started = [];
        await expect(mapPool([0, 1, 2, 3, 4], 1, async (x) => {
            started.push(x);
            if (x === 1) throw new Error('auth');
            return x;
        })).rejects.toThrow('auth');
        expect(started).toEqual([0, 1]);
    });

    it('treats a bad limit as 1 and handles an empty list', async () => {
        expect(await mapPool([], 3, async (x) => x)).toEqual([]);
        expect(await mapPool([1, 2], NaN, async (x) => x * 2)).toEqual([2, 4]);
    });
});

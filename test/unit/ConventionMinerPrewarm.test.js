/**
 * The miner is the highest-leverage recall component and, before this, it never
 * ran in time to affect the review that needed it. The failure mode a test can
 * actually catch is the opposite one: warming twice, or blocking a review
 * forever on a mine that never settles.
 */
const { ConventionMiner } = require('../../src/services/ConventionMiner.js');

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

describe('ConventionMiner prewarm', () => {
    let storage;

    beforeEach(() => {
        ConventionMiner.resetInFlight();
        const data = {};
        storage = {
            get: jest.fn(async (key) => ({ [key]: data[key] })),
            set: jest.fn(async (items) => { Object.assign(data, items); }),
        };
    });

    it('collapses concurrent prewarms into one mine', async () => {
        const miner = new ConventionMiner({ storage, llmService: {} });
        const mine = jest.spyOn(miner, 'mine').mockResolvedValue({ repoId: 'r', rules: [], minedAt: Date.now() });
        const fetcher = jest.fn().mockResolvedValue([{ author: 'a', body: 'use tenant_id' }]);

        await Promise.all([
            miner.prewarm('r', fetcher),
            miner.prewarm('r', fetcher),
            miner.prewarm('r', fetcher),
        ]);

        expect(mine).toHaveBeenCalledTimes(1);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('exposes the in-flight promise to a later, separate instance', async () => {
        const first = new ConventionMiner({ storage, llmService: {} });
        const gate = deferred();
        jest.spyOn(first, 'mine').mockReturnValue(gate.promise);

        first.prewarm('r', async () => []);
        expect(ConventionMiner.inFlight('r')).not.toBeNull();

        gate.resolve({ repoId: 'r', rules: [], minedAt: Date.now() });
        await ConventionMiner.inFlight('r');
    });

    it('clears the registry entry once mining settles', async () => {
        const miner = new ConventionMiner({ storage, llmService: {} });
        jest.spyOn(miner, 'mine').mockResolvedValue({ repoId: 'r', rules: [], minedAt: Date.now() });
        await miner.prewarm('r', async () => []);
        expect(ConventionMiner.inFlight('r')).toBeNull();
    });

    it('clears the registry entry when mining rejects, so a retry is possible', async () => {
        const miner = new ConventionMiner({ storage, llmService: {} });
        jest.spyOn(miner, 'mine').mockRejectedValue(new Error('provider down'));
        await expect(miner.prewarm('r', async () => [])).resolves.toBeNull();
        expect(ConventionMiner.inFlight('r')).toBeNull();
    });

    it('skips mining entirely when the cache is warm', async () => {
        const miner = new ConventionMiner({ storage, llmService: {} });
        jest.spyOn(miner, 'getCached').mockResolvedValue({ repoId: 'r', rules: [{ rule: 'x' }], minedAt: Date.now() });
        const mine = jest.spyOn(miner, 'mine');
        const out = await miner.prewarm('r', async () => []);
        expect(mine).not.toHaveBeenCalled();
        expect(out.rules).toHaveLength(1);
    });

    it('resolves null rather than throwing when the notes fetch fails', async () => {
        const miner = new ConventionMiner({ storage, llmService: {} });
        await expect(
            miner.prewarm('r', async () => { throw new Error('403'); })
        ).resolves.toBeNull();
    });
});

describe('awaitWarm', () => {
    beforeEach(() => ConventionMiner.resetInFlight());

    it('returns the mined result when it beats the deadline', async () => {
        const miner = new ConventionMiner({ storage: { get: async () => ({}), set: async () => {} }, llmService: {} });
        jest.spyOn(miner, 'mine').mockResolvedValue({ repoId: 'r', rules: [{ rule: 'x' }], minedAt: Date.now() });
        miner.prewarm('r', async () => []);
        const out = await ConventionMiner.awaitWarm('r', 1000);
        expect(out.rules).toHaveLength(1);
    });

    it('gives up at the deadline instead of blocking the review', async () => {
        const miner = new ConventionMiner({ storage: { get: async () => ({}), set: async () => {} }, llmService: {} });
        jest.spyOn(miner, 'mine').mockReturnValue(new Promise(() => {})); // never settles
        miner.prewarm('r', async () => []);
        const out = await ConventionMiner.awaitWarm('r', 20);
        expect(out).toBeNull();
    });

    it('returns null immediately when nothing is in flight', async () => {
        expect(await ConventionMiner.awaitWarm('nobody', 1000)).toBeNull();
    });
});

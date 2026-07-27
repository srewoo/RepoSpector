const {
    ConventionMiner,
    reviewerRequests,
    isBotAuthor,
} = require('../../src/services/ConventionMiner.js');

function makeStorage(initial = {}) {
    let data = { ...initial };
    return {
        get: jest.fn(async (k) => (k in data ? { [k]: data[k] } : {})),
        set: jest.fn(async (o) => { data = { ...data, ...o }; }),
        _dump: () => data,
    };
}

const note = (author, body, file) => ({ author, body, file });

const RULES_JSON = JSON.stringify({
    rules: [
        { rule: 'Use tenant_id as the naming convention for tenant identifiers', rationale: 'consistency across services', occurrences: 3, example: 'Follow tenant_id...', category: 'naming' },
        { rule: 'Use the shared http status library instead of numeric literals', rationale: 'readability', occurrences: 2, example: 'Better use http status library', category: 'library-usage' },
    ],
});

describe('isBotAuthor', () => {
    it.each(['baymax-mt', 'bito-ai', 'coderabbitai', 'group_6877322_bot_3b8bbac', 'dependabot'])(
        'treats %s as a bot', (a) => expect(isBotAuthor(a)).toBe(true)
    );

    it.each(['arin.srivastava', 'prateek-patel-mt', 'vipul0194'])(
        'treats %s as human', (a) => expect(isBotAuthor(a)).toBe(false)
    );
});

describe('reviewerRequests', () => {
    it('excludes bot comments — an AI reviewer is not team convention', () => {
        // Mining a bot's output would compound its own mistakes into every
        // future review of the repo.
        const kept = reviewerRequests([
            note('baymax-mt', 'CWE-20: Missing env var default causes a crash at startup here'),
            note('arin.srivastava', 'Better use the http status library for http status codes.'),
        ]);
        expect(kept).toHaveLength(1);
        expect(kept[0].author).toBe('arin.srivastava');
    });

    it('excludes author replies and resolutions', () => {
        const kept = reviewerRequests([
            note('a.dev', 'valid - fixed in 96edc81. Replaced the context import.'),
            note('a.dev', 'Agreed — removed. Its two jobs now live on the closure table.'),
            note('a.dev', 'Resolved by reverting the fetch into the lock.'),
            note('b.dev', 'For naming the route, it is better to follow REST norms here.'),
        ]);
        expect(kept.map(n => n.author)).toEqual(['b.dev']);
    });

    it('excludes chatter and very short comments', () => {
        const kept = reviewerRequests([
            note('a', 'LGTM'), note('a', '+1'), note('a', 'thanks!'), note('a', 'ok'),
            note('b', 'Please use the mindtickle default date formatter for consistency.'),
        ]);
        expect(kept).toHaveLength(1);
    });
});

describe('ConventionMiner.mine', () => {
    const settings = { provider: 'openai', model: 'openai:gpt-4.1-mini', apiKey: 'k' };

    const manyRequests = () => Array.from({ length: 12 }, (_, i) =>
        note('rev' + i, `Please follow the tenant_id naming convention here, occurrence ${i} with enough length.`)
    );

    it('mines rules and caches them', async () => {
        const llm = { streamChat: jest.fn().mockResolvedValue({ content: RULES_JSON, usage: {} }) };
        const storage = makeStorage();
        const miner = new ConventionMiner({ llmService: llm, storage });

        const res = await miner.mine('acme/repo', manyRequests(), { settings });
        expect(res.rules).toHaveLength(2);
        expect(res.rules[0].category).toBe('naming');
        expect(storage.set).toHaveBeenCalled();

        // second call is served from cache — mining is per-repo, not per-review
        const again = await miner.mine('acme/repo', manyRequests(), { settings });
        expect(again.rules).toHaveLength(2);
        expect(llm.streamChat).toHaveBeenCalledTimes(1);
    });

    it('refuses to generalise from too little history', async () => {
        // Three comments cannot establish a convention. Inventing one here would
        // put confident nonsense into every future review prompt.
        const llm = { streamChat: jest.fn() };
        const miner = new ConventionMiner({ llmService: llm, storage: makeStorage() });

        const res = await miner.mine('acme/thin', [
            note('a', 'Please rename this variable to something clearer than x.'),
            note('b', 'Consider extracting this into a helper function please.'),
        ], { settings });

        expect(res.rules).toEqual([]);
        expect(res.stats.reason).toBe('insufficient history');
        expect(llm.streamChat).not.toHaveBeenCalled();
    });

    it('counts bots as excluded rather than silently dropping them', async () => {
        const llm = { streamChat: jest.fn().mockResolvedValue({ content: RULES_JSON, usage: {} }) };
        const miner = new ConventionMiner({ llmService: llm, storage: makeStorage() });
        const notes = [...manyRequests(), note('baymax-mt', 'Some long automated bot finding about a CWE issue.')];

        const res = await miner.mine('acme/repo', notes, { settings });
        expect(res.stats.botsExcluded).toBe(1);
    });

    it('survives a malformed LLM response without throwing', async () => {
        const llm = { streamChat: jest.fn().mockResolvedValue({ content: 'not json at all', usage: {} }) };
        const miner = new ConventionMiner({ llmService: llm, storage: makeStorage() });
        const res = await miner.mine('acme/repo', manyRequests(), { settings });
        expect(res.rules).toEqual([]);
    });

    it('survives an LLM error', async () => {
        const llm = { streamChat: jest.fn().mockRejectedValue(new Error('rate limited')) };
        const miner = new ConventionMiner({ llmService: llm, storage: makeStorage() });
        const res = await miner.mine('acme/repo', manyRequests(), { settings });
        expect(res.rules).toEqual([]);
        expect(res.stats.reason).toBe('llm error');
    });

    it('re-mines when forced', async () => {
        const llm = { streamChat: jest.fn().mockResolvedValue({ content: RULES_JSON, usage: {} }) };
        const miner = new ConventionMiner({ llmService: llm, storage: makeStorage() });
        await miner.mine('acme/repo', manyRequests(), { settings });
        await miner.mine('acme/repo', manyRequests(), { settings, force: true });
        expect(llm.streamChat).toHaveBeenCalledTimes(2);
    });

    it('expires the cache past its TTL', async () => {
        const llm = { streamChat: jest.fn().mockResolvedValue({ content: RULES_JSON, usage: {} }) };
        const storage = makeStorage();
        const miner = new ConventionMiner({ llmService: llm, storage, ttlMs: 1000 });
        await miner.mine('acme/repo', manyRequests(), { settings });

        storage._dump().repospectorMinedConventions['acme/repo'].minedAt = Date.now() - 5000;
        expect(await miner.getCached('acme/repo')).toBeNull();
    });
});

describe('ConventionMiner.renderBlock', () => {
    it('renders mined rules for the prompt', () => {
        const block = ConventionMiner.renderBlock({
            rules: [{ rule: 'Use tenant_id', rationale: 'consistency', occurrences: 3 }],
        });
        expect(block).toContain('Team conventions for this repository');
        expect(block).toContain('Use tenant_id');
        expect(block).toContain('raised 3×');
    });

    it('returns empty string when nothing was mined, so callers can concatenate blindly', () => {
        expect(ConventionMiner.renderBlock({ rules: [] })).toBe('');
        expect(ConventionMiner.renderBlock(null)).toBe('');
    });
});

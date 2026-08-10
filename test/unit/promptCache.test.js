const {
    estimateTokens,
    isWorthCaching,
    buildAnthropicSystem,
    flattenContent,
    toAnthropicContent,
    extractCacheUsage,
    MIN_CACHEABLE_TOKENS,
} = require('../../src/utils/promptCache.js');

/** A system prompt comfortably over the caching minimum. */
const long = (n = MIN_CACHEABLE_TOKENS * 4 + 100) => 'x'.repeat(n);

describe('estimateTokens', () => {
    it('approximates 4 characters per token', () => {
        expect(estimateTokens('abcd')).toBe(1);
        expect(estimateTokens('x'.repeat(400))).toBe(100);
    });

    it('treats missing input as empty rather than throwing', () => {
        expect(estimateTokens(undefined)).toBe(0);
        expect(estimateTokens(null)).toBe(0);
        expect(estimateTokens('')).toBe(0);
    });
});

describe('isWorthCaching', () => {
    it('rejects a prefix below the provider minimum', () => {
        expect(isWorthCaching('short instructions')).toBe(false);
    });

    it('accepts a prefix at or above the minimum', () => {
        expect(isWorthCaching(long())).toBe(true);
    });

    it('honours an explicit lower threshold', () => {
        expect(isWorthCaching('abcdefgh', { minTokens: 2 })).toBe(true);
    });
});

describe('buildAnthropicSystem', () => {
    it('returns null when there are no system messages', () => {
        expect(buildAnthropicSystem([{ role: 'user', content: 'hi' }])).toBeNull();
        expect(buildAnthropicSystem([])).toBeNull();
        expect(buildAnthropicSystem()).toBeNull();
    });

    it('returns a plain string below the minimum, so short calls are unchanged', () => {
        const out = buildAnthropicSystem([{ role: 'system', content: 'be brief' }]);
        expect(out).toBe('be brief');
    });

    it('returns blocks with a breakpoint on the last one once above the minimum', () => {
        const out = buildAnthropicSystem([{ role: 'system', content: long() }]);
        expect(Array.isArray(out)).toBe(true);
        expect(out).toHaveLength(1);
        expect(out[0].type).toBe('text');
        expect(out[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('preserves order across several system messages and marks only the last', () => {
        const out = buildAnthropicSystem([
            { role: 'system', content: 'rules' },
            { role: 'user', content: 'ignored' },
            { role: 'system', content: long() },
        ]);
        expect(out.map(b => b.text)).toEqual(['rules', long()]);
        // A prefix match means marking the last block covers the first too.
        expect(out[0].cache_control).toBeUndefined();
        expect(out[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('sizes the decision on the combined text, not on any single message', () => {
        const half = 'y'.repeat(MIN_CACHEABLE_TOKENS * 2 + 8);
        // Neither message clears the bar alone; together they do.
        expect(isWorthCaching(half)).toBe(false);
        const out = buildAnthropicSystem([
            { role: 'system', content: half },
            { role: 'system', content: half },
        ]);
        expect(Array.isArray(out)).toBe(true);
        expect(out[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('omits the breakpoint when caching is explicitly disabled', () => {
        const out = buildAnthropicSystem(
            [{ role: 'system', content: long() }],
            { cache: false },
        );
        expect(typeof out).toBe('string');
    });

    it('ignores empty system messages rather than emitting empty blocks', () => {
        const out = buildAnthropicSystem([
            { role: 'system', content: '' },
            { role: 'system', content: 'rules' },
        ]);
        expect(out).toBe('rules');
    });
});

describe('flattenContent', () => {
    it('passes a string through unchanged', () => {
        expect(flattenContent('hello')).toBe('hello');
    });

    it('joins parts with no separator, reproducing the original single string', () => {
        expect(flattenContent([{ text: 'a\n\n' }, { text: 'b' }])).toBe('a\n\nb');
    });

    it('coerces absent input to empty', () => {
        expect(flattenContent(undefined)).toBe('');
        expect(flattenContent([{}, { text: null }])).toBe('');
    });
});

describe('toAnthropicContent', () => {
    it('passes a string through unchanged', () => {
        expect(toAnthropicContent('hello')).toBe('hello');
    });

    it('marks the requested part once the prefix clears the minimum', () => {
        const out = toAnthropicContent([
            { text: long(), cache: true },
            { text: 'per-call tail' },
        ]);
        expect(Array.isArray(out)).toBe(true);
        expect(out[0].cache_control).toEqual({ type: 'ephemeral' });
        expect(out[1].cache_control).toBeUndefined();
    });

    it('falls back to a plain string when the prefix is too short to cache', () => {
        // A marker below the minimum is silently ignored by the API, so the
        // block form would be overhead with no benefit.
        const out = toAnthropicContent([{ text: 'tiny', cache: true }, { text: '!' }]);
        expect(out).toBe('tiny!');
    });

    it('counts preceding system text toward the minimum', () => {
        // Anthropic renders system before messages and matches on the whole
        // prefix, so a user part that is short on its own can still be worth a
        // breakpoint once the system prompt ahead of it is counted.
        const half = 'y'.repeat(MIN_CACHEABLE_TOKENS * 2 + 8);
        expect(toAnthropicContent([{ text: half, cache: true }])).toBe(half);

        const out = toAnthropicContent(
            [{ text: half, cache: true }],
            { prefixText: half },
        );
        expect(Array.isArray(out)).toBe(true);
        expect(out[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('marks at most one part even when several ask', () => {
        const out = toAnthropicContent([
            { text: long(), cache: true },
            { text: long(), cache: true },
        ]);
        expect(out.filter(b => b.cache_control)).toHaveLength(1);
    });

    it('drops empty parts rather than emitting empty blocks', () => {
        const out = toAnthropicContent([
            { text: '' },
            { text: long(), cache: true },
        ]);
        expect(out).toHaveLength(1);
    });

    it('honours an explicit opt-out', () => {
        const out = toAnthropicContent(
            [{ text: long(), cache: true }, { text: 'tail' }],
            { cache: false },
        );
        expect(typeof out).toBe('string');
        expect(out).toBe(long() + 'tail');
    });

    it('never changes the text a provider ends up seeing', () => {
        const parts = [{ text: long(), cache: true }, { text: 'tail' }];
        const blocks = toAnthropicContent(parts);
        expect(blocks.map(b => b.text).join('')).toBe(flattenContent(parts));
    });
});

describe('extractCacheUsage', () => {
    it('reconciles Anthropic usage, whose input_tokens excludes cached tokens', () => {
        const out = extractCacheUsage(
            {
                input_tokens: 300,
                output_tokens: 50,
                cache_creation_input_tokens: 1000,
                cache_read_input_tokens: 2000,
            },
            'anthropic',
        );
        expect(out).toEqual({ cacheWrite: 1000, cacheRead: 2000, promptTotal: 3300 });
    });

    it('reads the cached slice out of an OpenAI prompt total', () => {
        const out = extractCacheUsage(
            { prompt_tokens: 5000, prompt_tokens_details: { cached_tokens: 4096 } },
            'openai',
        );
        expect(out).toEqual({ cacheWrite: 0, cacheRead: 4096, promptTotal: 5000 });
    });

    it('reports zeroes for a provider that returns no cache fields', () => {
        expect(extractCacheUsage({ prompt_tokens: 120 }, 'mistral'))
            .toEqual({ cacheWrite: 0, cacheRead: 0, promptTotal: 120 });
    });

    it('never throws on missing usage', () => {
        expect(extractCacheUsage(undefined, 'anthropic'))
            .toEqual({ cacheWrite: 0, cacheRead: 0, promptTotal: 0 });
        expect(extractCacheUsage(null, 'openai'))
            .toEqual({ cacheWrite: 0, cacheRead: 0, promptTotal: 0 });
    });
});

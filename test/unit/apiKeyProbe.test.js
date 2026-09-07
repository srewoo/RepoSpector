/**
 * The "Test key" verdict.
 *
 * The whole value of this feature is that it distinguishes failures that a
 * boolean cannot: a key that is wrong, an account with no money, a model the
 * key cannot reach, and a network that never delivered the request. Each sends
 * the user somewhere different, so each classification is pinned here.
 */

const {
    PROBE_STATE,
    keyProven,
    httpStatusOf,
    classifyProbeFailure,
    describeProbeSuccess,
} = require('../../src/utils/apiKeyProbe.js');
const { markAuthError } = require('../../src/utils/authErrors.js');

describe('httpStatusOf', () => {
    it('reads the parenthesised status every LLMService adapter emits', () => {
        expect(httpStatusOf(new Error('OpenRouter API error (402): no credits'))).toBe(402);
        expect(httpStatusOf(new Error('NVIDIA NIM API error (401): unauthorized'))).toBe(401);
    });

    it('prefers an explicit numeric status field', () => {
        const e = Object.assign(new Error('nope'), { status: 429 });
        expect(httpStatusOf(e)).toBe(429);
    });

    it('finds a bare status in provider prose', () => {
        expect(httpStatusOf('AccessDeniedException 403 from bedrock')).toBe(403);
    });

    it('does not mistake digits inside a model id for a status', () => {
        // `nvidia/llama-3.3-nemotron-super-49b-v1` and friends are full of
        // three-digit runs; an unanchored \\d{3} turned one of them into a
        // "status" and classified a working key as a model error.
        expect(httpStatusOf(new Error('model nvidia/nemotron-400b-v1 said something'))).toBeNull();
        expect(httpStatusOf(new Error('used 402431 tokens'))).toBeNull();
    });

    it('returns null when there is no status at all', () => {
        expect(httpStatusOf(new Error('Failed to fetch'))).toBeNull();
        expect(httpStatusOf(undefined)).toBeNull();
    });
});

describe('classifyProbeFailure', () => {
    it('a tagged auth error is a bad key, and names the provider', () => {
        const e = markAuthError(new Error('OpenRouter API error (401): invalid'));
        const v = classifyProbeFailure(e, { provider: 'openrouter' });
        expect(v.state).toBe(PROBE_STATE.KEY_INVALID);
        expect(v.message).toMatch(/OpenRouter API key/);
        expect(keyProven(v.state)).toBe(false);
    });

    it('a 401 is a bad key even when untagged', () => {
        const v = classifyProbeFailure(new Error('NVIDIA NIM API error (401): x'), { provider: 'nvidia' });
        expect(v.state).toBe(PROBE_STATE.KEY_INVALID);
    });

    it('402 / no credits proves the key and blames the balance', () => {
        const v = classifyProbeFailure(
            new Error('OpenRouter API error (402): insufficient credits'),
            { provider: 'openrouter' },
        );
        expect(v.state).toBe(PROBE_STATE.BILLING);
        // The point of the whole enum: do NOT send this user to make a new key.
        expect(keyProven(v.state)).toBe(true);
        expect(v.message).toMatch(/key is valid/i);
    });

    it('429 proves the key and blames the rate limit', () => {
        const v = classifyProbeFailure(new Error('API error (429): slow down'), { provider: 'groq' });
        expect(v.state).toBe(PROBE_STATE.RATE_LIMITED);
        expect(keyProven(v.state)).toBe(true);
    });

    it('404 on the model proves the key and points at Refresh models', () => {
        const v = classifyProbeFailure(
            new Error('NVIDIA NIM API error (404): model not found'),
            { provider: 'nvidia', model: 'nvidia:moonshotai/kimi-k3' },
        );
        expect(v.state).toBe(PROBE_STATE.MODEL_UNAVAILABLE);
        expect(keyProven(v.state)).toBe(true);
        expect(v.message).toMatch(/Refresh models/);
        expect(v.message).toMatch(/kimi-k3/);
    });

    it('400 is a model/request problem, not a key problem', () => {
        // e.g. a reasoning model that rejects `max_tokens`. The key plainly
        // authenticated to get that far.
        const v = classifyProbeFailure(new Error('OpenAI API error (400): unsupported parameter'), { provider: 'openai' });
        expect(v.state).toBe(PROBE_STATE.MODEL_UNAVAILABLE);
        expect(keyProven(v.state)).toBe(true);
    });

    it('a timeout says explicitly that it is not about the key', () => {
        const e = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
        const v = classifyProbeFailure(e, { provider: 'local' });
        expect(v.state).toBe(PROBE_STATE.UNREACHABLE);
        expect(v.message).toMatch(/says nothing about your key/i);
        expect(keyProven(v.state)).toBe(false);
    });

    it('a network failure is unreachable, not invalid', () => {
        const v = classifyProbeFailure(new Error('Failed to fetch'), { provider: 'nvidia' });
        expect(v.state).toBe(PROBE_STATE.UNREACHABLE);
        expect(v.message).toMatch(/not a rejected key/i);
    });

    it('a 5xx blames the provider', () => {
        const v = classifyProbeFailure(new Error('API error (503): unavailable'), { provider: 'mistral' });
        expect(v.state).toBe(PROBE_STATE.UNREACHABLE);
        expect(v.message).toMatch(/server error/i);
    });

    it('falls back to the raw message rather than inventing a diagnosis', () => {
        const v = classifyProbeFailure(new Error('something odd happened'), { provider: 'openai' });
        expect(v.state).toBe(PROBE_STATE.UNKNOWN);
        expect(v.message).toBe('something odd happened');
        expect(keyProven(v.state)).toBe(false);
    });
});

describe('describeProbeSuccess', () => {
    it('reports the model and latency', () => {
        expect(describeProbeSuccess({ model: 'meta/llama-3.3-70b-instruct', latencyMs: 412, content: 'OK' }))
            .toBe('meta/llama-3.3-70b-instruct replied in 412 ms. Your key works.');
    });

    it('still confirms the key when the completion is empty', () => {
        // An empty completion is not a failure: the call was authorised and
        // answered. `max_tokens: 16` plus a reasoning preamble can produce one.
        const msg = describeProbeSuccess({ model: 'openai/o4-mini', latencyMs: 90, content: '   ' });
        expect(msg).toMatch(/empty reply/);
        expect(msg).toMatch(/Your key works/);
    });
});

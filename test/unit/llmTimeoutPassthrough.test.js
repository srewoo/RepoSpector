/**
 * `streamChat` must honour a caller-supplied timeout.
 *
 * It did not. The options object was destructured without `timeout`, so a caller
 * that passed one had it silently dropped and every request used the 120s
 * provider default. Measured consequence: the two finder lenses with the longest
 * prompts (`systemic`, `intent-implementation`) aborted on a reasoning model
 * while MultiFinderService believed it had granted them five minutes — and an
 * aborted lens returns an empty array, which is indistinguishable from a lens
 * that looked and found nothing.
 *
 * A knob that cannot turn is worse than no knob, because it reads as configured.
 */

const { LLMService } = require('../../src/services/LLMService.js');

function harness() {
    const svc = new LLMService();
    const seen = {};
    svc.callLLM = async (_req, _key, options) => {
        Object.assign(seen, { options });
        return 'ok';
    };
    return { svc, seen };
}

describe('streamChat timeout passthrough', () => {
    it('forwards an explicit timeout to the provider call', async () => {
        const { svc, seen } = harness();
        await svc.streamChat([{ role: 'user', content: 'x' }], {
            model: 'openai:gpt-5', apiKey: 'k', timeout: 300000,
        });
        expect(seen.options.timeout).toBe(300000);
    });

    it('omits timeout entirely when the caller does not ask', async () => {
        // Each provider adapter has its own default; passing `undefined` through
        // would override nothing but is noise, and passing `null` would break the
        // adapters' default-parameter destructuring.
        const { svc, seen } = harness();
        await svc.streamChat([{ role: 'user', content: 'x' }], { model: 'openai:gpt-5', apiKey: 'k' });
        expect('timeout' in seen.options).toBe(false);
    });

    it('ignores a non-numeric timeout rather than forwarding garbage', async () => {
        const { svc, seen } = harness();
        await svc.streamChat([{ role: 'user', content: 'x' }], {
            model: 'openai:gpt-5', apiKey: 'k', timeout: 'soon',
        });
        expect('timeout' in seen.options).toBe(false);
    });
});

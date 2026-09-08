/**
 * The keyless work taught checkOllamaStatus to diagnose a CORS refusal, but the
 * CHAT path still threw `Ollama API error (403): ` with an empty body — so the
 * same failure read as two different bugs depending on where you hit it. A real
 * user hit it during a review: five review lenses failed with that bare message
 * while Settings would have named the cause.
 */
const { LLMService } = require('../../src/services/LLMService.js');
const { OLLAMA_ORIGINS_VALUE } = require('../../src/utils/ollamaProbe.js');

function respond({ ok, status, body = '' }) {
    global.fetch = jest.fn(async () => ({
        ok, status,
        text: async () => body,
        json: async () => ({ message: { content: 'ok' } }),
    }));
}

const req = { model: 'qwen2.5-coder:32b', messages: [{ role: 'user', content: 'hi' }] };

describe('callOllama failure diagnosis', () => {
    let svc;
    beforeEach(() => { svc = new LLMService(); svc.maxRetries = 0; });

    test('a 403 names the origin refusal and OLLAMA_ORIGINS, not a bare status', async () => {
        respond({ ok: false, status: 403, body: '' });
        await expect(svc.callOllama(req)).rejects.toThrow(/refusing requests from this extension/i);
        await expect(svc.callOllama(req)).rejects.toThrow(new RegExp(OLLAMA_ORIGINS_VALUE.replace(/[*/]/g, '\\$&')));
    });

    test('the 403 message does NOT read as a generic API error', async () => {
        respond({ ok: false, status: 403, body: '' });
        await expect(svc.callOllama(req)).rejects.not.toThrow(/^Ollama API error \(403\)/);
    });

    test('other statuses still report the status and body, unchanged', async () => {
        respond({ ok: false, status: 500, body: 'boom' });
        await expect(svc.callOllama(req)).rejects.toThrow(/500/);
        await expect(svc.callOllama(req)).rejects.toThrow(/boom/);
    });

    test('a model-not-pulled 404 is not mistaken for an origin problem', async () => {
        respond({ ok: false, status: 404, body: 'model not found' });
        await expect(svc.callOllama(req)).rejects.toThrow(/model not found/);
        await expect(svc.callOllama(req)).rejects.not.toThrow(/OLLAMA_ORIGINS/);
    });

    test('a successful call is unaffected', async () => {
        respond({ ok: true, status: 200 });
        await expect(svc.callOllama(req)).resolves.toBe('ok');
    });
});

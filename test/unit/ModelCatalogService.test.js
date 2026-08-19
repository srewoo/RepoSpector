/**
 * Tests for ModelCatalogService — live model listing per provider (fetch mocked).
 */
const { ModelCatalogService } = require('../../src/services/ModelCatalogService.js');

function mockFetch(payload, ok = true, status = 200) {
    global.fetch = jest.fn().mockResolvedValue({
        ok, status,
        json: async () => payload,
        text: async () => JSON.stringify(payload)
    });
}

afterEach(() => { delete global.fetch; });

describe('ModelCatalogService', () => {
    it('OpenAI: normalizes ids and drops non-chat models', async () => {
        mockFetch({ data: [
            { id: 'gpt-4.1' }, { id: 'o1-mini' },
            { id: 'text-embedding-3-small' }, { id: 'whisper-1' }, { id: 'dall-e-3' }
        ] });
        const models = await ModelCatalogService.fetchModels('openai', 'sk-test');
        const ids = models.map(m => m.id);
        expect(ids).toContain('openai:gpt-4.1');
        expect(ids).toContain('openai:o1-mini');
        expect(ids).not.toContain('openai:text-embedding-3-small');
        expect(ids).not.toContain('openai:whisper-1');
        expect(ids).not.toContain('openai:dall-e-3');
    });

    it('Anthropic: uses display_name and normalizes', async () => {
        mockFetch({ data: [{ id: 'claude-x', display_name: 'Claude X' }] });
        const models = await ModelCatalogService.fetchModels('anthropic', 'sk-ant');
        // `recommended` is added by rankModels to the top entry of every provider's
        // list, so the dropdown can star the newest model. Asserted with
        // toMatchObject rather than toEqual: this test is about normalisation
        // (display_name -> name), not about the ranking flag.
        expect(models[0]).toMatchObject({ id: 'anthropic:claude-x', name: 'Claude X' });
    });

    it('Google: keeps only generateContent models', async () => {
        mockFetch({ models: [
            { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }
        ] });
        const ids = (await ModelCatalogService.fetchModels('google', 'key')).map(m => m.id);
        expect(ids).toContain('google:gemini-2.5-pro');
        expect(ids).not.toContain('google:text-embedding-004');
    });

    it('Local (Ollama): needs no key, lists pulled models', async () => {
        mockFetch({ models: [{ name: 'llama3.3' }, { name: 'qwen2.5-coder' }] });
        const ids = (await ModelCatalogService.fetchModels('local')).map(m => m.id);
        expect(ids).toEqual(expect.arrayContaining(['local:llama3.3', 'local:qwen2.5-coder']));
    });

    it('throws when a key is missing for a non-local provider', async () => {
        await expect(ModelCatalogService.fetchModels('openai', '')).rejects.toThrow(/key required/i);
    });

    it('throws on a non-ok API response', async () => {
        mockFetch({ error: 'unauthorized' }, false, 401);
        await expect(ModelCatalogService.fetchModels('openai', 'sk-bad')).rejects.toThrow(/401/);
    });

    it('throws for an unknown provider', async () => {
        await expect(ModelCatalogService.fetchModels('cohere', 'k')).rejects.toThrow(/No model catalog/);
    });
});

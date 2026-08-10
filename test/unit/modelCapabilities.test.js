const { isReasoningModel, shouldExplore } = require('../../src/utils/modelCapabilities.js');

describe('isReasoningModel', () => {
    it.each([
        'openai:o1',
        'openai:o3-mini',
        'openai:o4-mini',
        'openai:gpt-5',
        'openai:gpt-5-mini',
        'anthropic:claude-opus-5',
        'anthropic:claude-sonnet-5',
        'anthropic:claude-opus-4-8',
        'anthropic:claude-sonnet-4-6',
        'anthropic:claude-haiku-4-5',
        'anthropic:claude-fable-5',
        'anthropic:claude-3-7-sonnet-20250219',
        'google:gemini-2.5-pro',
        'groq:deepseek-r1-distill-llama-70b',
        'mistral:magistral-medium',
        'local:deepseek-r1:14b',
    ])('recognises %s', (id) => {
        expect(isReasoningModel(id)).toBe(true);
    });

    it.each([
        'openai:gpt-4.1',
        'openai:gpt-4o',
        'openai:gpt-4o-mini',
        'anthropic:claude-3-5-sonnet-20241022',
        'anthropic:claude-3-haiku-20240307',
        'google:gemini-1.5-pro',
        'groq:llama-3.3-70b-versatile',
        'mistral:mistral-large-latest',
        'local:llama3',
    ])('does not misclassify %s', (id) => {
        expect(isReasoningModel(id)).toBe(false);
    });

    it('distinguishes Claude versions rather than matching the family name', () => {
        // `claude-3-5-sonnet` does not think and `claude-sonnet-4-6` does, so
        // matching on "sonnet" would be wrong in both directions over time.
        expect(isReasoningModel('anthropic:claude-3-5-sonnet-20241022')).toBe(false);
        expect(isReasoningModel('anthropic:claude-sonnet-4-6')).toBe(true);
    });

    it('uses the provider hint when the identifier has no prefix', () => {
        expect(isReasoningModel('gpt-5', 'openai')).toBe(true);
        expect(isReasoningModel('gpt-4o', 'openai')).toBe(false);
    });

    it('tries every pattern set for an unknown provider', () => {
        // A self-hosted OpenAI-compatible endpoint serving deepseek-r1 is still
        // a reasoning model.
        expect(isReasoningModel('selfhosted:deepseek-r1')).toBe(true);
    });

    it('treats an unrecognised model as NOT reasoning', () => {
        // The conservative direction: a model we fail to recognise loses a
        // feature; the opposite mistake spends the user's money unasked.
        expect(isReasoningModel('openai:some-future-model')).toBe(false);
        expect(isReasoningModel('')).toBe(false);
        expect(isReasoningModel(undefined)).toBe(false);
    });

    it('is case-insensitive', () => {
        expect(isReasoningModel('OpenAI:GPT-5')).toBe(true);
    });
});

describe('shouldExplore', () => {
    const reasoning = { model: 'openai:gpt-5', provider: 'openai', supportsTools: true };
    const plain = { model: 'openai:gpt-4o', provider: 'openai', supportsTools: true };

    it('runs by default on a reasoning model', () => {
        const out = shouldExplore({ setting: undefined, ...reasoning });
        expect(out.enabled).toBe(true);
        expect(out.reason).toContain('reasoning model');
    });

    it('stays off by default on a non-reasoning model', () => {
        const out = shouldExplore({ setting: undefined, ...plain });
        expect(out.enabled).toBe(false);
        // The message has to tell the user how to get it anyway.
        expect(out.reason).toContain('repoExploration');
    });

    it('honours an explicit enable on a non-reasoning model', () => {
        expect(shouldExplore({ setting: true, ...plain }).enabled).toBe(true);
    });

    it('honours an explicit disable on a reasoning model', () => {
        // Switching models must not silently re-enable something turned off.
        const out = shouldExplore({ setting: false, ...reasoning });
        expect(out.enabled).toBe(false);
        expect(out.reason).toBe('disabled in settings');
    });

    it('cannot run without tool support, whatever the model', () => {
        // Exploration IS a tool loop; Google and Ollama have no implementation.
        const out = shouldExplore({
            setting: undefined, model: 'google:gemini-2.5-pro',
            provider: 'google', supportsTools: false,
        });
        expect(out.enabled).toBe(false);
        expect(out.reason).toContain('no tool support');
    });

    it('explains itself when settings ask for something the provider cannot do', () => {
        const out = shouldExplore({
            setting: true, model: 'local:deepseek-r1',
            provider: 'local', supportsTools: false,
        });
        expect(out.enabled).toBe(false);
        expect(out.reason).toContain('enabled in settings');
        expect(out.reason).toContain('no tool support');
    });

    it('treats null the same as unset, not as a disable', () => {
        expect(shouldExplore({ setting: null, ...reasoning }).enabled).toBe(true);
    });
});

/**
 * The extension must call ONLY the model selected in Settings.
 *
 * These tests exist because four separate silent fallbacks shipped:
 *   - LLMService.streamChat  `model || 'openai:gpt-4.1-mini'`
 *   - LLMService.getProvider  returned OPENAI for any unprefixed identifier
 *   - LLMService.getModelId   returned 'gpt-4.1-mini' when the id was missing
 *   - BackgroundService.getModelId  same
 *
 * Each meant a user could be billed on their own key for a model they never
 * chose, and — worse for the getProvider case — an Anthropic model name could
 * be POSTed to api.openai.com. Any regression here is a correctness AND a
 * billing bug, so the assertions are deliberately unforgiving.
 */

const {
    resolveModel,
    isModelSelected,
    ModelNotSelectedError,
} = require('../../src/utils/modelResolver.js');

describe('resolveModel — no fallbacks, ever', () => {
    it.each([undefined, null, '', '   ', 0, false, {}, []])(
        'throws instead of defaulting for %p',
        (bad) => {
            expect(() => resolveModel(bad)).toThrow(ModelNotSelectedError);
        }
    );

    it('never yields a model the caller did not ask for', () => {
        // The specific regression: any of these used to silently become
        // openai / gpt-4.1-mini.
        for (const bad of [undefined, '', null]) {
            let resolved = null;
            try { resolved = resolveModel(bad); } catch { /* expected */ }
            expect(resolved).toBeNull();
        }
    });

    it('names the calling context so the error is actionable', () => {
        expect(() => resolveModel('', { context: 'PR review' }))
            .toThrow(/No model is selected for PR review/);
    });
});

describe('resolveModel — canonical provider:model', () => {
    it('splits a known model and uses the catalog wire name', () => {
        const r = resolveModel('openai:gpt-4.1-mini');
        expect(r.provider).toBe('openai');
        expect(r.modelId).toBe('gpt-4.1-mini');
        expect(r.modelIdentifier).toBe('openai:gpt-4.1-mini');
    });

    it('resolves each provider to itself, not to openai', () => {
        expect(resolveModel('anthropic:claude-sonnet-4').provider).toBe('anthropic');
        expect(resolveModel('google:gemini-2.0-flash').provider).toBe('google');
        expect(resolveModel('groq:llama-3.3-70b').provider).toBe('groq');
        expect(resolveModel('local:llama3.3').provider).toBe('local');
    });

    it('passes through a custom model id not in the catalog', () => {
        // Self-hosted / newly released models must still work.
        const r = resolveModel('local:my-finetune:v2');
        expect(r.provider).toBe('local');
        expect(r.modelId).toBe('my-finetune:v2');
    });

    it('rejects an unknown provider rather than guessing', () => {
        expect(() => resolveModel('sketchyai:some-model')).toThrow(/Unknown provider/);
    });

    it('rejects a malformed identifier', () => {
        expect(() => resolveModel('openai:')).toThrow(ModelNotSelectedError);
        expect(() => resolveModel(':gpt-4.1')).toThrow(ModelNotSelectedError);
    });
});

describe('resolveModel — unprefixed identifiers', () => {
    it('does NOT assume openai for a bare model name', () => {
        // The exact old bug: a bare anthropic model routed to OpenAI.
        expect(() => resolveModel('claude-sonnet-4')).toThrow(ModelNotSelectedError);
        expect(() => resolveModel('gpt-4.1')).toThrow(ModelNotSelectedError);
    });

    it('uses the explicit provider when one is configured', () => {
        const r = resolveModel('claude-sonnet-4', { explicitProvider: 'anthropic' });
        expect(r.provider).toBe('anthropic');
        expect(r.modelId).toBe('claude-sonnet-4');
        expect(r.modelIdentifier).toBe('anthropic:claude-sonnet-4');
    });

    it('ignores an unknown explicit provider rather than trusting it', () => {
        expect(() => resolveModel('some-model', { explicitProvider: 'nonsense' }))
            .toThrow(ModelNotSelectedError);
    });
});

describe('resolveModel — provider/model disagreement', () => {
    it('refuses to guess when settings contradict the model prefix', () => {
        // Picking either side silently would send the request to the wrong
        // provider with the wrong key.
        expect(() => resolveModel('anthropic:claude-sonnet-4', { explicitProvider: 'openai' }))
            .toThrow(/Provider mismatch/);
    });

    it('accepts a matching explicit provider', () => {
        const r = resolveModel('anthropic:claude-sonnet-4', { explicitProvider: 'anthropic' });
        expect(r.provider).toBe('anthropic');
    });
});

describe('isModelSelected', () => {
    it('reports selection state without throwing', () => {
        expect(isModelSelected('openai:gpt-4.1')).toBe(true);
        expect(isModelSelected('')).toBe(false);
        expect(isModelSelected(undefined)).toBe(false);
        expect(isModelSelected('claude-sonnet-4')).toBe(false);
    });
});

/**
 * The documented Ollama setup cannot work: a fetch from an extension page
 * carries a chrome-extension:// Origin, Chrome sends a preflight, and Ollama
 * rejects any origin not in OLLAMA_ORIGINS. The old probe reported that as
 * "server not running" — the one diagnosis that is certainly wrong, and the
 * reason users abandon the keyless path. These tests pin the distinction.
 */
const {
    OLLAMA_VERDICT,
    classifyOllamaProbe,
    matchesOllamaModel,
} = require('../../src/utils/ollamaProbe.js');

const tagsOk = (names) => ({ ok: true, models: names.map((name) => ({ name })) });
const tagsFailed = { ok: false, error: 'Failed to fetch' };

describe('classifyOllamaProbe', () => {
    test('tags returned and model present is ok', () => {
        const r = classifyOllamaProbe({
            tagsResult: tagsOk(['qwen2.5-coder:latest']),
            opaqueReachable: true,
            selectedModel: 'local:qwen2.5-coder',
        });
        expect(r.verdict).toBe(OLLAMA_VERDICT.OK);
        expect(r.fix).toBe('');
    });

    test('no selected model only checks that the server answered', () => {
        expect(classifyOllamaProbe({
            tagsResult: tagsOk([]), opaqueReachable: true, selectedModel: null,
        }).verdict).toBe(OLLAMA_VERDICT.OK);
    });

    test('fetch failed but the server answered opaquely is cors_blocked', () => {
        const r = classifyOllamaProbe({
            tagsResult: tagsFailed, opaqueReachable: true, selectedModel: 'local:qwen2.5-coder',
        });
        expect(r.verdict).toBe(OLLAMA_VERDICT.CORS_BLOCKED);
        expect(r.fix).toContain('OLLAMA_ORIGINS');
        expect(r.message).not.toMatch(/not running/i);
    });

    test('fetch failed and nothing answered is not_running', () => {
        const r = classifyOllamaProbe({
            tagsResult: tagsFailed, opaqueReachable: false, selectedModel: null,
        });
        expect(r.verdict).toBe(OLLAMA_VERDICT.NOT_RUNNING);
        expect(r.fix).toContain('ollama serve');
    });

    test('an unknown opaque result is not_running, never cors_blocked', () => {
        // Claiming CORS without evidence would send the user to fix a
        // non-problem, which is the failure this whole task is correcting.
        expect(classifyOllamaProbe({
            tagsResult: tagsFailed, opaqueReachable: null, selectedModel: null,
        }).verdict).toBe(OLLAMA_VERDICT.NOT_RUNNING);
    });

    test('tags returned without the selected model is model_missing', () => {
        const r = classifyOllamaProbe({
            tagsResult: tagsOk(['llama3.3:latest']),
            opaqueReachable: true,
            selectedModel: 'local:qwen2.5-coder',
        });
        expect(r.verdict).toBe(OLLAMA_VERDICT.MODEL_MISSING);
        expect(r.fix).toContain('ollama pull qwen2.5-coder');
    });

    test('model_missing lists what IS installed, so the user can just pick one', () => {
        const r = classifyOllamaProbe({
            tagsResult: tagsOk(['llama3.3:latest', 'phi4:latest']),
            opaqueReachable: true,
            selectedModel: 'local:qwen2.5-coder',
        });
        expect(r.message).toContain('llama3.3:latest');
        expect(r.message).toContain('phi4:latest');
    });

    test('every verdict carries displayable copy', () => {
        const cases = [
            { tagsResult: tagsOk(['m:latest']), opaqueReachable: true, selectedModel: 'local:m' },
            { tagsResult: tagsFailed, opaqueReachable: true, selectedModel: null },
            { tagsResult: tagsFailed, opaqueReachable: false, selectedModel: null },
            { tagsResult: tagsOk(['other']), opaqueReachable: true, selectedModel: 'local:m' },
        ];
        for (const c of cases) {
            const r = classifyOllamaProbe(c);
            expect(typeof r.message).toBe('string');
            expect(r.message.length).toBeGreaterThan(0);
            expect(Object.values(OLLAMA_VERDICT)).toContain(r.verdict);
        }
    });
});

describe('matchesOllamaModel', () => {
    test('matches across the local: prefix and the :tag suffix', () => {
        expect(matchesOllamaModel('qwen2.5-coder:latest', 'local:qwen2.5-coder')).toBe(true);
        expect(matchesOllamaModel('qwen2.5-coder:32b', 'local:qwen2.5-coder:32b')).toBe(true);
        expect(matchesOllamaModel('qwen2.5-coder:latest', 'qwen2.5-coder')).toBe(true);
    });

    test('does not match a different model', () => {
        expect(matchesOllamaModel('llama3.3:latest', 'local:qwen2.5-coder')).toBe(false);
    });

    test('tolerates missing values', () => {
        expect(matchesOllamaModel(null, 'local:m')).toBe(false);
        expect(matchesOllamaModel('m:latest', null)).toBe(false);
    });

    test('a tagged selection does not match a different installed tag of the same model', () => {
        // Reported false positive: selecting :32b must not be satisfied by a
        // :7b install just because the base names agree. Once the exact-tag
        // branch fails, the fallback must not silently ignore the tag.
        expect(matchesOllamaModel('qwen2.5-coder:7b', 'local:qwen2.5-coder:32b')).toBe(false);
    });
});

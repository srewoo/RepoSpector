/**
 * Settings said "Ollama is running and the selected model is installed" while
 * the review died with `model 'qwen2.5-coder:32b' not found`. The probe checks
 * the SELECTION (`local:qwen2.5-coder`, tag-agnostic, satisfied by the
 * `ollama pull qwen2.5-coder` the setup steps tell you to run), but the request
 * went out with the catalogue's hardcoded `:32b` tag. Two different names for
 * one model is the bug; these tests pin them together.
 */
const { MODELS } = require('../../src/utils/constants.js');
const { resolveModel } = require('../../src/utils/modelResolver.js');
const { matchesOllamaModel } = require('../../src/utils/ollamaProbe.js');

const localEntries = Object.entries(MODELS).filter(([id]) => id.startsWith('local:'));

describe('local (Ollama) catalogue wire names', () => {
    test('there is at least one local model to check', () => {
        expect(localEntries.length).toBeGreaterThan(0);
    });

    test.each(localEntries)('%s sends the name it was selected as', (id, entry) => {
        expect(entry.modelId).toBe(id.slice('local:'.length));
        expect(resolveModel(id).modelId).toBe(id.slice('local:'.length));
    });

    test.each(localEntries)('%s: a probe-satisfying install can serve the request', (id, entry) => {
        // The probe accepts `qwen2.5-coder:latest` for `local:qwen2.5-coder`.
        // Whatever it accepts, Ollama must be able to resolve the wire name too:
        // an untagged wire name resolves to :latest, a tagged one must match.
        const installed = `${id.slice('local:'.length).split(':')[0]}:latest`;
        expect(matchesOllamaModel(installed, id)).toBe(true);
        expect(matchesOllamaModel(installed, entry.modelId)).toBe(true);
    });
});

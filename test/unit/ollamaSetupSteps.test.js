/**
 * The old instructions were a three-step list that could not work: they omitted
 * OLLAMA_ORIGINS, so a user who followed them exactly still could not reach the
 * server. These tests pin the missing step and its per-platform forms, because
 * "set an environment variable" is exactly where a non-shell user stalls.
 */
const { OLLAMA_SETUP_STEPS } = require('../../src/popup/components/settings/ollamaSetupSteps.js');
const { OLLAMA_ORIGINS_VALUE } = require('../../src/utils/ollamaProbe.js');

describe('OLLAMA_SETUP_STEPS', () => {
    test('has four steps, in order', () => {
        expect(OLLAMA_SETUP_STEPS).toHaveLength(4);
        expect(OLLAMA_SETUP_STEPS.map((s) => s.id))
            .toEqual(['install', 'pull', 'origins', 'verify']);
    });

    test('the origins step covers all three platforms', () => {
        const origins = OLLAMA_SETUP_STEPS.find((s) => s.id === 'origins');
        const platforms = origins.commands.map((c) => c.platform);
        expect(platforms).toEqual(expect.arrayContaining(['macos-linux', 'macos-service', 'windows']));
    });

    test('every origins command carries the wildcard origin value', () => {
        const origins = OLLAMA_SETUP_STEPS.find((s) => s.id === 'origins');
        for (const { command } of origins.commands) {
            expect(command).toContain(OLLAMA_ORIGINS_VALUE);
        }
    });

    test('pulls the code model, not the general chat model', () => {
        const pull = OLLAMA_SETUP_STEPS.find((s) => s.id === 'pull');
        expect(pull.commands[0].command).toBe('ollama pull qwen2.5-coder');
    });

    test('every command is copyable — non-empty string, no placeholders', () => {
        for (const step of OLLAMA_SETUP_STEPS) {
            for (const { command } of step.commands || []) {
                expect(command.trim().length).toBeGreaterThan(0);
                expect(command).not.toMatch(/<|TODO|TBD/);
            }
        }
    });
});

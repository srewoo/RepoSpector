/**
 * Ollama setup instructions, as data.
 *
 * The instructions this replaces were missing step 3, which is the step that
 * makes the whole path work: a fetch from an extension page carries a
 * chrome-extension:// Origin, and Ollama refuses any origin absent from
 * OLLAMA_ORIGINS. Wrong copy shipped once already, so it lives in a plain .js
 * module where a test can assert it — tests cannot load .jsx.
 */

import { OLLAMA_ORIGINS_VALUE } from '../../../utils/ollamaProbe.js';

export const OLLAMA_SETUP_STEPS = Object.freeze([
    {
        id: 'install',
        title: 'Install Ollama',
        detail: 'Download it from ollama.ai',
        commands: [],
    },
    {
        id: 'pull',
        title: 'Pull a code model',
        detail: 'Code-specialised and a much smaller download than a general chat model.',
        commands: [{ platform: 'all', command: 'ollama pull qwen2.5-coder' }],
    },
    {
        id: 'origins',
        title: 'Allow this extension to connect',
        detail: 'Without this, Ollama runs but refuses the extension — the requests never reach a model.',
        commands: [
            { platform: 'macos-linux', label: 'macOS / Linux', command: `OLLAMA_ORIGINS=${OLLAMA_ORIGINS_VALUE} ollama serve` },
            { platform: 'macos-service', label: 'macOS (running as a service)', command: `launchctl setenv OLLAMA_ORIGINS "${OLLAMA_ORIGINS_VALUE}"` },
            { platform: 'windows', label: 'Windows (then restart Ollama)', command: `setx OLLAMA_ORIGINS "${OLLAMA_ORIGINS_VALUE}"` },
        ],
    },
    {
        id: 'verify',
        title: 'Test the connection',
        detail: 'Confirms the server is up, allows this extension, and has your model.',
        commands: [],
    },
]);

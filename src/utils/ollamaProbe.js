/**
 * Turn Ollama probe outcomes into a verdict the user can act on.
 *
 * The old check collapsed every failure into "not reachable", and the most
 * common failure is not that: a fetch from an extension page carries a
 * chrome-extension:// Origin, so Chrome sends a preflight and Ollama refuses
 * any origin absent from OLLAMA_ORIGINS. Reporting that as a stopped server
 * points the user at a step they already completed.
 */

export const OLLAMA_VERDICT = Object.freeze({
    OK: 'ok',
    CORS_BLOCKED: 'cors_blocked',
    NOT_RUNNING: 'not_running',
    MODEL_MISSING: 'model_missing',
});

/** `chrome-extension://*` — wildcard so it survives reinstalls and unpacked builds. */
export const OLLAMA_ORIGINS_VALUE = 'chrome-extension://*';

/** Strip the `local:` provider prefix and any `:tag` suffix. */
function baseName(id) {
    if (!id) return '';
    const withoutProvider = String(id).startsWith('local:') ? String(id).slice(6) : String(id);
    return withoutProvider.split(':')[0];
}

/**
 * Does an installed Ollama model satisfy a selected model id?
 *
 * Installed names carry a tag (`qwen2.5-coder:latest`); selections carry the
 * provider prefix (`local:qwen2.5-coder`) and may or may not carry a tag of
 * their own. An untagged selection is tag-agnostic — any installed tag of
 * that model satisfies it. A tagged selection (`local:qwen2.5-coder:32b`)
 * must match the installed name exactly: comparing only base names would let
 * a differently-tagged install (`:7b`) falsely satisfy it, and Ollama itself
 * would then reject the mismatched tag at chat time.
 */
export function matchesOllamaModel(installedName, selectedId) {
    if (!installedName || !selectedId) return false;
    const selected = String(selectedId).startsWith('local:')
        ? String(selectedId).slice(6)
        : String(selectedId);
    if (installedName === selected) return true;
    if (selected.includes(':')) return false;
    return baseName(installedName) === baseName(selectedId);
}

/**
 * @param {object} probe
 * @param {{ok: boolean, models?: Array<{name: string}>, error?: string}} probe.tagsResult
 *   Outcome of a normal CORS fetch of /api/tags.
 * @param {boolean|null} probe.opaqueReachable
 *   Outcome of a `mode: 'no-cors'` fetch. True means the server answered even
 *   though the CORS fetch failed — that is the CORS signature. Null means the
 *   second probe was not run or was itself inconclusive.
 * @param {string|null} probe.selectedModel
 * @returns {{verdict: string, message: string, fix: string}}
 */
export function classifyOllamaProbe({ tagsResult, opaqueReachable = null, selectedModel = null }) {
    if (tagsResult && tagsResult.ok) {
        const models = Array.isArray(tagsResult.models) ? tagsResult.models : [];
        if (selectedModel && !models.some((m) => matchesOllamaModel(m.name, selectedModel))) {
            const installed = models.map((m) => m.name).join(', ') || 'none';
            return {
                verdict: OLLAMA_VERDICT.MODEL_MISSING,
                message: `Ollama is running but "${baseName(selectedModel)}" is not installed. Installed: ${installed}.`,
                fix: `ollama pull ${baseName(selectedModel)}`,
            };
        }
        return { verdict: OLLAMA_VERDICT.OK, message: 'Ollama is running and the selected model is installed.', fix: '' };
    }

    // The CORS fetch failed. Only the opaque probe can say why.
    if (opaqueReachable === true) {
        return {
            verdict: OLLAMA_VERDICT.CORS_BLOCKED,
            message: 'Ollama is running but refusing requests from this extension. '
                + 'It needs to allow the extension origin.',
            fix: `Restart Ollama with OLLAMA_ORIGINS set to ${OLLAMA_ORIGINS_VALUE} (see setup step 3)`,
        };
    }

    // No evidence the server answered. Do not claim CORS without evidence —
    // sending the user to fix a non-problem is the bug being corrected here.
    return {
        verdict: OLLAMA_VERDICT.NOT_RUNNING,
        message: 'No Ollama server responded on localhost:11434.',
        fix: 'Start it with: ollama serve',
    };
}

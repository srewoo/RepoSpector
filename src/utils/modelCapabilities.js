/**
 * modelCapabilities — is the selected model a reasoning model?
 *
 * Used to decide whether repository exploration runs by default. The reasoning
 * behind that gate:
 *
 *   - A user who has selected a reasoning model has already accepted higher
 *     cost and latency. That was the objection to enabling exploration for
 *     everyone: extra round trips on someone else's API key, on a review they
 *     are waiting for. On a model already thinking for tens of seconds per
 *     call, a few tool calls are not the thing making it slow.
 *   - Reasoning models are also the ones that use tools well — they decide what
 *     to look up and stop when they have it, rather than calling every tool
 *     once because the tools exist.
 *
 * ── Why this is a pattern list and not a lookup ──
 *
 * Neither `ModelCatalogService` nor any provider's `/models` endpoint reports
 * "is a reasoning model" in a form we can rely on across six providers, so
 * there is nothing to query. That makes this list the kind of thing that goes
 * stale, so the default is deliberately conservative: an unrecognised model is
 * NOT treated as reasoning, which leaves exploration off — the previous
 * behaviour. A new model family that we fail to recognise loses a feature it
 * could have had; the opposite mistake spends the user's money without asking.
 *
 * Users are never stuck with the classification: `reviewSettings.repoExploration`
 * set explicitly to `true` or `false` overrides it in either direction.
 */

/**
 * Per-provider tests against the bare model id (no `provider:` prefix),
 * lower-cased.
 *
 * Version-aware where a family spans both kinds — `claude-3-5-sonnet` does not
 * think and `claude-sonnet-4-6` does, so matching on "sonnet" alone would be
 * wrong in both directions over time.
 */
export const REASONING_PATTERNS = Object.freeze({
    openai: [
        /^o\d/,           // o1, o3, o4-mini — the reasoning series
        /^gpt-5/,         // GPT-5 family reasons by default
    ],
    anthropic: [
        /^claude-(fable|mythos)-/,           // always-on thinking
        /^claude-(opus|sonnet|haiku)-[45]/,  // 4.x and 5.x support adaptive/extended thinking
        /^claude-3-7-sonnet/,                // the first Claude with extended thinking
    ],
    google: [
        /thinking/,
        /^gemini-(2\.5|[3-9])/,
    ],
    groq: [
        /deepseek-r1/,
        /qwq/,
        /^o\d/,
    ],
    mistral: [
        /^magistral/,
    ],
    local: [
        /deepseek-r1/,
        /qwq/,
        /reasoning/,
    ],
});

/**
 * Split `provider:model` into its parts, tolerating a missing prefix.
 *
 * @param {string} identifier
 * @returns {{provider: string, modelId: string}}
 */
function split(identifier) {
    const raw = String(identifier ?? '').trim().toLowerCase();
    const colon = raw.indexOf(':');
    if (colon === -1) return { provider: '', modelId: raw };
    return { provider: raw.slice(0, colon), modelId: raw.slice(colon + 1) };
}

/**
 * Does this model reason before answering?
 *
 * @param {string} identifier - `provider:model`, or a bare model id
 * @param {string} [providerHint] - used when the identifier carries no prefix
 * @returns {boolean}
 */
export function isReasoningModel(identifier, providerHint = '') {
    const { provider, modelId } = split(identifier);
    if (!modelId) return false;

    const key = provider || String(providerHint || '').toLowerCase();
    const patterns = REASONING_PATTERNS[key];

    // Unknown provider: test every pattern set rather than returning false.
    // A self-hosted OpenAI-compatible endpoint serving `deepseek-r1` should
    // still be recognised as reasoning.
    const candidates = patterns || Object.values(REASONING_PATTERNS).flat();
    return candidates.some(re => re.test(modelId));
}

/**
 * Should repository exploration run, given the model and the user's setting?
 *
 * Tri-state on purpose. An explicit `true`/`false` in settings always wins; only
 * `undefined`/`null` falls through to the model-based default. A user who
 * turned it off does not get it back by switching models.
 *
 * `supportsTools` is required regardless: exploration is a tool loop, and a
 * reasoning model on a provider whose tool protocol we do not implement
 * (Google, Ollama) cannot run one.
 *
 * @param {Object} opts
 * @param {boolean|undefined|null} opts.setting - explicit user preference
 * @param {string} opts.model - `provider:model`
 * @param {string} opts.provider
 * @param {boolean} opts.supportsTools
 * @returns {{enabled: boolean, reason: string}} `reason` is logged, so a user
 *   who expected exploration to run can find out why it did not.
 */
export function shouldExplore({ setting, model, provider, supportsTools }) {
    if (setting === true) {
        return supportsTools
            ? { enabled: true, reason: 'enabled in settings' }
            : { enabled: false, reason: `enabled in settings, but provider "${provider}" has no tool support` };
    }
    if (setting === false) {
        return { enabled: false, reason: 'disabled in settings' };
    }

    if (!supportsTools) {
        return { enabled: false, reason: `provider "${provider}" has no tool support` };
    }
    if (isReasoningModel(model, provider)) {
        return { enabled: true, reason: `${model} is a reasoning model` };
    }
    return {
        enabled: false,
        reason: `${model} is not a reasoning model — set reviewSettings.repoExploration to enable anyway`,
    };
}

export default { REASONING_PATTERNS, isReasoningModel, shouldExplore };

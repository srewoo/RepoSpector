/**
 * modelTiers — spend the strong model where accuracy is decided, and the cheap
 * one everywhere else.
 *
 * Every LLM call in the pipeline currently uses one model
 * (`multiPassModel = pinned || settings.model`). But the calls are not remotely
 * alike:
 *
 *   Finding a race condition in a 200-line diff        needs the best model available.
 *   Summarising a PR whose findings are already known  does not.
 *   Re-ranking a list of findings by reviewer value    does not.
 *   Writing a docstring for a function you can see     does not.
 *
 * coderabbit's ai-pr-reviewer splits this into a light and a heavy model. The
 * accuracy argument for doing the same is indirect but real: the reason not to
 * run the expensive model on the review pass is cost, and the cheapest way to
 * buy that headroom is to stop paying it for summarisation and re-ranking.
 * Roughly, on a typical review, the non-review passes are a third of the calls.
 *
 * ── Deliberately conservative default ──
 *
 * With no light model configured, every tier resolves to the single configured
 * model, so nothing changes for anyone who does not opt in. A tiering scheme that
 * silently downgraded the review pass would trade accuracy for cost without
 * asking, which is the opposite of the point.
 */

/** The stages a call can belong to — same names the call budget uses. */
export const TIER = Object.freeze({
    /** Reasoning about code correctness. Never downgraded. */
    HEAVY: 'heavy',
    /** Restating, ranking or formatting work already done. */
    LIGHT: 'light',
});

/**
 * Which tier each budget stage belongs to.
 *
 * The rule for reading this table: does the stage DECIDE whether a finding is
 * real, or does it present findings someone else decided on? Deciding is heavy.
 */
export const STAGE_TIERS = Object.freeze({
    // Produces findings, or judges whether one is real.
    'per-file': TIER.HEAVY,
    finder: TIER.HEAVY,
    verify: TIER.HEAVY,
    explore: TIER.HEAVY,
    'line-question': TIER.HEAVY,

    // Works on findings that already exist.
    aggregate: TIER.LIGHT,
    scoring: TIER.LIGHT,
    fixes: TIER.LIGHT,
    docstrings: TIER.LIGHT,
    summary: TIER.LIGHT,
    'pr-description': TIER.LIGHT,
    changelog: TIER.LIGHT,
    labels: TIER.LIGHT,
    convention: TIER.LIGHT,
});

/**
 * `verify` is heavy, which is worth defending: it is the stage that decides
 * whether a finding survives to be posted. Running it on a weaker model than the
 * one that generated the finding means the refuter is outmatched by the thing it
 * is refuting — and the failure mode is a false positive reaching the reviewer,
 * which costs more than the call it saved.
 *
 * `aggregate` is light despite writing the review narrative: by then every
 * finding is fixed, cited and verified, and the call is composition.
 */

/**
 * Resolve the model for a stage.
 *
 * @param {Object} args
 * @param {string} args.stage - a budget stage name
 * @param {string} args.model - the configured (heavy) model
 * @param {string} [args.lightModel] - optional cheaper model
 * @param {Object} [args.overrides] - {stage: tier} to reassign a stage
 * @returns {{model:string, tier:string, downgraded:boolean}}
 */
export function modelForStage({ stage, model, lightModel = null, overrides = null } = {}) {
    const tier = overrides?.[stage] || STAGE_TIERS[stage] || TIER.HEAVY;

    // No light model configured, or the stage is heavy: use the one model. An
    // UNKNOWN stage resolves to heavy on purpose — a new pass added later must
    // not be silently downgraded because nobody remembered to list it here.
    if (!lightModel || tier === TIER.HEAVY) {
        return { model, tier: TIER.HEAVY, downgraded: false };
    }

    return { model: lightModel, tier: TIER.LIGHT, downgraded: true };
}

/**
 * Settings for one stage's LLM call, ready to spread into `streamChat` options.
 *
 * Keeps the shape `{provider, model, apiKey}` that every service already passes,
 * so tiering is a change at the call site and nowhere else.
 *
 * IMPORTANT: `provider` is dropped when the light model carries its own prefix.
 * `resolveModel` requires the explicit provider to AGREE with a prefix, so
 * passing `provider: 'openai'` alongside `model: 'anthropic:claude-...'` is a
 * hard error — which is exactly the mistake a user makes when they set a light
 * model from a different provider and leave the provider field alone.
 *
 * @param {Object} args - as modelForStage, plus {provider, apiKey}
 * @returns {{provider?:string, model:string, apiKey:string, _tier:string}}
 */
export function settingsForStage({ stage, provider, model, apiKey, lightModel = null, overrides = null } = {}) {
    const resolved = modelForStage({ stage, model, lightModel, overrides });
    const hasPrefix = typeof resolved.model === 'string' && resolved.model.includes(':');

    return {
        ...(hasPrefix ? {} : { provider }),
        model: resolved.model,
        apiKey,
        _tier: resolved.tier,
    };
}

/**
 * One line for the review output. '' when tiering is not in use, so nothing is
 * said about a feature nobody turned on.
 */
export function describeTiering({ model, lightModel } = {}) {
    if (!lightModel || lightModel === model) return '';
    const light = Object.entries(STAGE_TIERS)
        .filter(([, t]) => t === TIER.LIGHT)
        .map(([s]) => s);
    return `Model tiering: \`${model}\` for review and verification; `
        + `\`${lightModel}\` for ${light.length} presentation stage(s).`;
}

export default { TIER, STAGE_TIERS, modelForStage, settingsForStage, describeTiering };

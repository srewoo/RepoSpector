/**
 * configPrecedence — one documented answer to "which setting won, and why".
 *
 * Review behaviour is configurable from four places today: the extension's own
 * Settings, a repo's `.repospector.yaml` `settings` block, the per-call options a
 * slash command or the panel passes in, and the built-in defaults. The merge was
 * a spread — `{ ...reviewSettings, ...customConfig?.settings }` — followed by a
 * scatter of `rqCfg.x !== false && options.x !== false` tests at each use site.
 *
 * Two things were wrong with that:
 *
 *   1. The order was implicit and stated nowhere, so "why did verification run
 *      when I turned it off?" could only be answered by reading the call site.
 *      Every `&& options.x !== false` is also a silent AND, not an override: a
 *      layer could only ever turn a feature OFF, never back ON.
 *
 *   2. There was no ORG tier. A team that wants "inline comments always post on
 *      security findings, and no repo may switch that off" had nowhere to say it.
 *      An org tier that any repo can override is decoration, so this one supports
 *      LOCKING: the piece pr-agent's org-level config leaves out, and the only
 *      part that makes the tier worth having.
 *
 * ── Precedence, lowest to highest ──
 *
 *   defaults  built-in, in code
 *   user      the extension's Settings (this machine, this person)
 *   org       organization policy (from the standards sync / Aegis tenant)
 *   repo      `.repospector.yaml` — reviewed, versioned, per-project
 *   call      one invocation: a slash-command flag, a panel toggle
 *
 * `repo` above `user` is deliberate and preserves existing behaviour: a project's
 * committed config represents a team decision, whereas Settings is one person's
 * machine. `call` is highest because it is an explicit, momentary instruction.
 *
 * A key named in the org layer's `enforce` list is pinned: `repo` and `call` are
 * ignored for it, and `provenance` records `org (enforced)` so the UI can explain
 * why a toggle did not take.
 */

/** Layer names, lowest precedence first. `defaults` is applied outside the list. */
export const LAYERS = Object.freeze(['defaults', 'user', 'org', 'repo', 'call']);

/**
 * Keys an organization may pin. Deliberately a closed list: an org that can lock
 * ANY key can lock a user out of their own model choice or API key, which is not
 * a policy decision, it is a lockout. Everything here is about what the review
 * DOES, never about credentials, cost, or which provider the user pays.
 */
export const ENFORCEABLE_KEYS = Object.freeze([
    'severityThreshold',
    'enablePostInlineComments',
    'enableAutoPostReview',
    'enableUpdatePRDescription',
    'verifyFindings',
    'llmRefutation',
    'enableOSV',
    'enableEOL',
    'orchestratedReview',
    'enableDynamicContext',
    'graphContext',
    'graphFindings',
    'multiFinder',
    'autofix',
    'fullFileContext',
    'reviewCache',
    // Where a review's findings may land, and what blocks a merge. Both are
    // statements about how a team ships rather than personal preferences, which
    // is exactly what an org tier is for: "security findings block, and no repo
    // may lower that" is not enforceable unless these are pinnable.
    'filterMode',
    'failLevel',
    'externalFindings',
    'checkAnnotations',
    'persistentSummary',
    'priorFindings',
]);

/**
 * Keys never taken from anything but the user's own Settings, whatever a repo
 * config or an org policy claims.
 *
 * A `.repospector.yaml` is attacker-controlled content on any public repo: it
 * arrives over the network from a project the user merely opened a PR page for.
 * Letting it set an API key, a token, or a host list would let a hostile repo
 * redirect the user's credentials to a server it controls. `model` is
 * intentionally NOT here — pinning a model is an existing, wanted feature
 * (`customConfig.settings.model`) and spends the user's own key on the user's own
 * provider.
 */
export const USER_ONLY_KEYS = Object.freeze([
    'apiKey', 'googleApiKey', 'githubToken', 'gitlabToken',
    'jiraToken', 'jiraEmail', 'jiraBaseUrl',
    'gitlabHosts', 'githubEnterpriseHosts',
]);

/**
 * Merge the layers into one config, recording where each key came from.
 *
 * Only OWN, DEFINED keys of a layer participate: `{ verifyFindings: undefined }`
 * is silence, not an instruction. This is what makes a partially-filled layer
 * (the common case for `call`) safe to pass in whole.
 *
 * @param {Object} layers
 * @param {Object} [layers.defaults]
 * @param {Object} [layers.user]
 * @param {Object} [layers.org] - may carry `enforce: string[]`
 * @param {Object} [layers.repo]
 * @param {Object} [layers.call]
 * @returns {{config:Object, provenance:Object<string,string>, enforced:string[], rejected:Array}}
 */
export function resolveConfig(layers = {}) {
    const config = {};
    /** key -> layer name that last set it */
    const provenance = {};
    /** keys an org pinned AND that a later layer tried to change */
    const enforced = [];
    /** {key, layer, reason} for every value refused */
    const rejected = [];

    const orgEnforce = new Set(
        (Array.isArray(layers.org?.enforce) ? layers.org.enforce : [])
            .filter(k => ENFORCEABLE_KEYS.includes(k)),
    );

    // An org naming a key it is not allowed to pin is worth reporting: silently
    // ignoring it means a team believes a policy is in force when it is not.
    for (const k of (Array.isArray(layers.org?.enforce) ? layers.org.enforce : [])) {
        if (!ENFORCEABLE_KEYS.includes(k)) {
            rejected.push({ key: k, layer: 'org', reason: 'not an enforceable key' });
        }
    }

    for (const layer of LAYERS) {
        const source = layers[layer];
        if (!source || typeof source !== 'object') continue;

        for (const [key, value] of Object.entries(source)) {
            if (key === 'enforce') continue; // metadata, not a setting
            if (value === undefined) continue;

            if (USER_ONLY_KEYS.includes(key) && layer !== 'user' && layer !== 'defaults') {
                rejected.push({ key, layer, reason: 'credentials come only from Settings' });
                continue;
            }

            // Pinned by the org: layers above `org` cannot move it.
            if (orgEnforce.has(key) && LAYERS.indexOf(layer) > LAYERS.indexOf('org')) {
                rejected.push({ key, layer, reason: 'enforced by organization policy' });
                if (!enforced.includes(key)) enforced.push(key);
                continue;
            }

            config[key] = value;
            provenance[key] = orgEnforce.has(key) && layer === 'org'
                ? 'org (enforced)'
                : layer;
        }
    }

    return { config, provenance, enforced, rejected };
}

/**
 * A boolean that defaults to ON unless a layer said otherwise.
 *
 * Replaces the `cfg.x !== false && options.x !== false` idiom, which is an AND of
 * layers rather than a precedence chain: under it a repo enabling something the
 * user had disabled stayed disabled, silently.
 *
 * @param {Object} resolved - the `config` from resolveConfig
 * @param {string} key
 * @param {boolean} [whenUnset=true]
 */
export function flag(resolved, key, whenUnset = true) {
    const v = resolved?.[key];
    if (v === undefined || v === null) return whenUnset;
    if (typeof v === 'boolean') return v;
    // Tolerate YAML's spellings — `.repospector.yaml` is hand-written.
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (['false', 'off', 'no', '0'].includes(s)) return false;
        if (['true', 'on', 'yes', '1'].includes(s)) return true;
    }
    return !!v;
}

/**
 * One human-readable line per key whose value did NOT come from where the user
 * would expect. Rendered in the review's stats so a toggle that had no effect is
 * explainable rather than mysterious.
 *
 * @param {ReturnType<typeof resolveConfig>} resolution
 * @returns {string[]}
 */
export function explainOverrides(resolution) {
    const out = [];
    for (const { key, layer, reason } of resolution?.rejected || []) {
        out.push(`\`${key}\` from ${layer} ignored — ${reason}.`);
    }
    return out;
}

export default { resolveConfig, flag, explainOverrides, LAYERS, ENFORCEABLE_KEYS, USER_ONLY_KEYS };

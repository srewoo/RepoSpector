/**
 * repoSettingsSchema — the keys a `.repospector.yaml` `settings` block may set,
 * and their types (spec §4.1).
 *
 * A repo file is attacker-controlled on any public repo, and hand-written on
 * every other one. So each key is type-checked, credentials are always
 * refused, and every key that is dropped is REPORTED — a silently ignored
 * `multiFinder: false` is a team believing a setting is in force when it is not.
 */

import { ENFORCEABLE_KEYS, USER_ONLY_KEYS } from './configPrecedence.js';
import { FAIL_LEVEL } from './failLevel.js';
import { FILTER_MODE } from './findingFilterMode.js';

const TRUE_WORDS = ['true', 'on', 'yes', '1'];
const FALSE_WORDS = ['false', 'off', 'no', '0'];

// Each checker returns the normalised value, or undefined when unacceptable.
const bool = (v) => {
    if (typeof v === 'boolean') return v;
    const s = typeof v === 'string' ? v.trim().toLowerCase() : null;
    if (TRUE_WORDS.includes(s)) return true;
    if (FALSE_WORDS.includes(s)) return false;
    return undefined;
};
const int = (min, max) => (v) => (Number.isInteger(v) && v >= min && v <= max ? v : undefined);
const num = (min, max) => (v) => (typeof v === 'number' && v >= min && v <= max ? v : undefined);
const oneOf = (values) => (v) => {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : null;
    return values.includes(s) ? s : undefined;
};
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

const BOOL = { check: bool, expected: 'true or false' };
const enumOf = (values) => ({ check: oneOf(values), expected: `one of ${values.join(', ')}` });
const intIn = (min, max) => ({ check: int(min, max), expected: `an integer ${min}-${max}` });

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'all'];

/**
 * ENFORCEABLE_KEYS (all boolean except the three enums below), the
 * review-quality keys, and the two pre-existing repo keys `model`/`diffAnchored`.
 */
export const REPO_SETTING_TYPES = Object.freeze({
    ...Object.fromEntries(ENFORCEABLE_KEYS.map(k => [k, BOOL])),
    severityThreshold: enumOf(SEVERITIES),
    filterMode: enumOf(Object.values(FILTER_MODE)),
    failLevel: enumOf(Object.values(FAIL_LEVEL)),
    model: { check: str, expected: 'a non-empty string such as "openai:gpt-4.1-mini"' },
    diffAnchored: BOOL,
    minRubricScore: intIn(0, 100),
    lightModel: { check: str, expected: 'a non-empty model name' },
    verificationVotes: intIn(1, 10),
    finderRounds: intIn(1, 10),
    minConfidence: { check: num(0, 1), expected: 'a number 0-1' },
    lensHistory: BOOL,
    lensCodeComments: BOOL,
    lensRulesCompliance: BOOL,
    lensPriorPrComments: BOOL,
    priorPrLimit: intIn(1, 20),
    chunkConcurrency: intIn(1, 8),
    valueScoring: BOOL,
    hypothesisValidation: BOOL,
    repoExploration: BOOL,
    explorationIterations: intIn(1, 10),
    teamConventions: BOOL,
});

/**
 * Validate a repo config's `settings` block. Flat keys only — the hand-rolled
 * YAML parser handles two levels and no YAML library is added.
 *
 * @param {unknown} raw - `config.settings` as parsed
 * @returns {{settings: Object, warnings: string[]}} only the keys that passed
 */
export function validateRepoSettings(raw) {
    const settings = {};
    const warnings = [];
    if (raw === undefined || raw === null) return { settings, warnings };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        warnings.push('`settings` must be a mapping of key: value — ignored.');
        return { settings, warnings };
    }
    for (const [key, value] of Object.entries(raw)) {
        if (USER_ONLY_KEYS.includes(key)) {
            warnings.push(`\`${key}\` is only read from your own Settings, never from a repo file — ignored.`);
            continue;
        }
        const type = REPO_SETTING_TYPES[key];
        if (!type) {
            warnings.push(`Unknown setting \`${key}\` — ignored.`);
            continue;
        }
        const normalised = type.check(value);
        if (normalised === undefined) {
            warnings.push(`\`${key}\` must be ${type.expected}; got ${JSON.stringify(value)} — ignored.`);
            continue;
        }
        settings[key] = normalised;
    }
    return { settings, warnings };
}

export default { REPO_SETTING_TYPES, validateRepoSettings };

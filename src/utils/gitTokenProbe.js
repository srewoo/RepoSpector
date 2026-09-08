/**
 * Classify the outcome of a git-platform token test.
 *
 * Kept separate from the fetch that feeds it so the decision table is testable
 * without a network, in the same shape `apiKeyProbe`/`ollamaProbe` already use.
 *
 * Emits `{ state, keyProven, message }` — the shape `KeyTestVerdict` renders,
 * so a git token gets the same three tones as an LLM key: green when the token
 * works, amber when it authenticated but something else will stop the review,
 * red when the credential itself was rejected. The amber tier is the reason
 * this file exists: a GitHub token missing `repo` scope authenticates fine and
 * then fails on the first private repository, so painting it green would
 * promise a review that cannot run.
 */

import { PROBE_STATE } from './apiKeyProbe.js';

export const GIT_PLATFORM = Object.freeze({
    GITHUB: 'github',
    GITLAB: 'gitlab',
    JIRA: 'jira',
});

/**
 * Token authenticated, but its grants are too narrow for what RepoSpector does.
 *
 * Deliberately a git-specific state rather than an addition to PROBE_STATE:
 * that enum describes LLM-provider outcomes and nothing there means "the
 * credential is fine but under-scoped". `keyProven: true` is what drives the
 * amber tone, so this renders correctly without touching the shared enum.
 */
export const SCOPE_INSUFFICIENT = 'scope-insufficient';

/** The scope a classic GitHub PAT needs for private repositories. */
const GITHUB_REQUIRED_SCOPE = 'repo';

const PLATFORM_LABEL = Object.freeze({
    [GIT_PLATFORM.GITHUB]: 'GitHub',
    [GIT_PLATFORM.GITLAB]: 'GitLab',
    [GIT_PLATFORM.JIRA]: 'Jira',
});

function label(platform) {
    return PLATFORM_LABEL[platform] || platform;
}

/**
 * Does a classic GitHub PAT's scope list cover private repositories?
 *
 * Fine-grained PATs return an EMPTY `x-oauth-scopes` header — they carry
 * per-resource permissions the header cannot express. So an absent or empty
 * header means "cannot determine", never "missing scope": reporting amber for
 * every fine-grained token would train users to ignore the warning.
 *
 * @param {string|null|undefined} scopeHeader Raw `x-oauth-scopes` value.
 * @returns {boolean|null} true covered, false missing, null undeterminable.
 */
export function githubScopeCovers(scopeHeader) {
    if (scopeHeader === null || scopeHeader === undefined) return null;
    const scopes = String(scopeHeader)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (scopes.length === 0) return null;
    return scopes.includes(GITHUB_REQUIRED_SCOPE);
}

/**
 * @param {object} probe
 * @param {string} probe.platform One of GIT_PLATFORM.
 * @param {number|null} probe.status HTTP status, or null if the request threw.
 * @param {string|null} [probe.networkError] Message when the request threw.
 * @param {string|null} [probe.identity] Who the token belongs to, on success.
 * @param {string|null} [probe.scopeHeader] GitHub `x-oauth-scopes`.
 * @param {string|null} [probe.rateLimitRemaining] GitHub `x-ratelimit-remaining`.
 * @returns {{state: string, keyProven: boolean, message: string}}
 */
export function classifyGitTokenProbe({
    platform,
    status = null,
    networkError = null,
    identity = null,
    scopeHeader = null,
    rateLimitRemaining = null,
}) {
    const name = label(platform);

    // The request never completed. Distinct from a rejected token: telling
    // someone their token is invalid when the network failed sends them to
    // regenerate a working credential.
    if (status === null) {
        return {
            state: PROBE_STATE.UNREACHABLE,
            keyProven: false,
            message: networkError
                ? `Could not reach ${name}: ${networkError}`
                : `Could not reach ${name}.`,
        };
    }

    if (status === 200) {
        if (platform === GIT_PLATFORM.GITHUB) {
            const covered = githubScopeCovers(scopeHeader);
            if (covered === false) {
                return {
                    state: SCOPE_INSUFFICIENT,
                    keyProven: true,
                    message: `Token works${identity ? ` as ${identity}` : ''}, but it is missing the `
                        + `"${GITHUB_REQUIRED_SCOPE}" scope, so private repositories will fail. `
                        + `Regenerate it with "${GITHUB_REQUIRED_SCOPE}" checked.`,
                };
            }
        }
        return {
            state: PROBE_STATE.OK,
            keyProven: true,
            message: identity
                ? `${name} token verified — authenticated as ${identity}.`
                : `${name} token verified.`,
        };
    }

    if (status === 401) {
        return {
            state: PROBE_STATE.KEY_INVALID,
            keyProven: false,
            message: platform === GIT_PLATFORM.JIRA
                ? 'Jira rejected these credentials. Check the email and that the API token '
                    + 'was created for that account.'
                : `${name} rejected this token. It may be expired, revoked, or mistyped.`,
        };
    }

    if (status === 403) {
        // GitHub signals rate limiting with 403 plus an exhausted remaining
        // count, so the header is the only thing separating "throttled" from
        // "forbidden" — both authenticate successfully.
        if (rateLimitRemaining !== null && Number(rateLimitRemaining) === 0) {
            return {
                state: PROBE_STATE.RATE_LIMITED,
                keyProven: true,
                message: `${name} accepted the token but the rate limit is exhausted. `
                    + 'Try again shortly.',
            };
        }
        return {
            state: SCOPE_INSUFFICIENT,
            keyProven: true,
            message: `${name} accepted the token but refused this request (403). `
                + 'The token is likely under-scoped, or SSO authorisation is required for '
                + 'the organisation.',
        };
    }

    if (status === 404 && platform === GIT_PLATFORM.JIRA) {
        // A wrong base URL is the common Jira mistake, and it is not a
        // credential problem — the token was never even evaluated.
        return {
            state: PROBE_STATE.UNREACHABLE,
            keyProven: false,
            message: 'No Jira API at that address. Check the site URL '
                + '(for example https://your-team.atlassian.net).',
        };
    }

    return {
        state: PROBE_STATE.UNREACHABLE,
        keyProven: false,
        message: `${name} returned an unexpected status (${status}).`,
    };
}

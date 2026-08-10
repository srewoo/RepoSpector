/**
 * gitHosts — the single place that decides "which forge is this URL on, and
 * where is its API?".
 *
 * Platform detection used to be `url.includes('gitlab.com')` repeated at a
 * dozen call sites, and the API base was the hardcoded string
 * `https://gitlab.com/api/v4`. Together those made self-hosted GitLab — the way
 * most companies actually run GitLab — impossible to review: the URL fell
 * through to the GitHub branch and then 404'd against api.github.com.
 *
 * Two mechanisms, in priority order:
 *
 *   1. STRUCTURE. `/-/merge_requests/<n>` is a GitLab route on any host, and
 *      `/pull/<n>` under github.com is a GitHub route. This needs no
 *      configuration and is why a user can review an MR on a host they never
 *      registered.
 *   2. CONFIGURATION. Repository URLs (indexing, cross-repo impact) carry no
 *      such marker, so a host list is consulted. It is seeded from settings and
 *      grows as MR URLs are parsed, so indexing a repo on an internal host works
 *      after the first MR from it is seen.
 *
 * Hostnames are compared case-insensitively and include subdomain matching for
 * configured suffixes, so `gitlab.internal.example.com` matches a configured
 * `example.com` only if that suffix was configured deliberately — never by
 * accident, since the default list is exactly `gitlab.com`.
 */

export const PLATFORM = Object.freeze({
    GITHUB: 'github',
    GITLAB: 'gitlab',
});

const DEFAULT_GITLAB_HOSTS = ['gitlab.com'];

/** Configured GitLab hosts, lower-cased. Seeded with the public instance. */
let gitlabHosts = new Set(DEFAULT_GITLAB_HOSTS);

/** Parse a URL without throwing; returns null for anything unparseable. */
function toUrl(value) {
    if (!value || typeof value !== 'string') return null;
    try {
        // Tolerate a bare host or a scheme-less URL — settings are hand-typed.
        return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
        return null;
    }
}

/** Hostname of a URL string, lower-cased, or null. */
export function hostOf(url) {
    return toUrl(url)?.hostname.toLowerCase() ?? null;
}

/**
 * Replace the configured GitLab host list.
 *
 * Called when settings load or change. Always keeps gitlab.com, so turning on a
 * self-hosted instance never breaks review of a public MR.
 *
 * @param {string|string[]|null|undefined} hosts - hostnames or full URLs
 */
export function setGitLabHosts(hosts) {
    const next = new Set(DEFAULT_GITLAB_HOSTS);
    const list = Array.isArray(hosts) ? hosts : (hosts ? [hosts] : []);
    for (const entry of list) {
        const host = hostOf(entry);
        if (host) next.add(host);
    }
    gitlabHosts = next;
}

/** Register a host discovered at runtime (e.g. from a parsed MR URL). */
export function rememberGitLabHost(hostOrUrl) {
    const host = hostOf(hostOrUrl);
    if (host) gitlabHosts.add(host);
}

/** The currently configured GitLab hosts, for display and diagnostics. */
export function getGitLabHosts() {
    return [...gitlabHosts];
}

/** Reset to defaults. Test seam — production code has no reason to call this. */
export function resetGitLabHosts() {
    gitlabHosts = new Set(DEFAULT_GITLAB_HOSTS);
}

/** Is this host a configured GitLab instance (exact match or subdomain)? */
export function isKnownGitLabHost(hostOrUrl) {
    const host = hostOf(hostOrUrl);
    if (!host) return false;
    for (const known of gitlabHosts) {
        if (host === known || host.endsWith(`.${known}`)) return true;
    }
    return false;
}

/**
 * Which forge does this URL belong to?
 *
 * @param {string} url
 * @returns {'github'|'gitlab'|null} null when it is neither, so callers can
 *          report an unsupported URL instead of guessing GitHub and 404ing.
 */
export function detectPlatform(url) {
    const parsed = toUrl(url);
    if (!parsed) return null;
    const host = parsed.hostname.toLowerCase();

    if (host === 'github.com' || host === 'www.github.com' || host === 'api.github.com') {
        return PLATFORM.GITHUB;
    }

    // Structural signal — a GitLab route on ANY host, including one that has
    // never been configured. This is what makes a first visit to an internal
    // instance work.
    if (/\/-\/(merge_requests|tree|blob|commit|issues)\//.test(parsed.pathname)) {
        return PLATFORM.GITLAB;
    }

    if (isKnownGitLabHost(host)) return PLATFORM.GITLAB;

    return null;
}

/**
 * Same as `detectPlatform`, but never returns null.
 *
 * Several existing call sites are shaped as a binary choice and have no branch
 * for "unknown". They keep their historical GitHub default; new code should
 * prefer `detectPlatform` and handle null.
 */
export function detectPlatformOrGitHub(url) {
    return detectPlatform(url) ?? PLATFORM.GITHUB;
}

/**
 * REST API base for the GitLab instance serving `url`.
 *
 * @param {string} [url] - any URL on the instance; defaults to gitlab.com
 * @returns {string} e.g. `https://gitlab.example.com/api/v4`
 */
export function gitlabApiBase(url) {
    const parsed = toUrl(url);
    if (!parsed) return 'https://gitlab.com/api/v4';
    // Preserve a non-default port (self-hosted instances often run on one) and
    // the scheme, so an internal http-only instance still resolves.
    return `${parsed.protocol}//${parsed.host}/api/v4`;
}

/**
 * Web origin for the instance serving `url` — used to build browse links.
 * @param {string} [url]
 * @returns {string}
 */
export function originOf(url) {
    const parsed = toUrl(url);
    return parsed ? `${parsed.protocol}//${parsed.host}` : 'https://gitlab.com';
}

/**
 * Owner / repo / full project path for a PR or MR URL, on ANY host.
 *
 * Replaces the regex that was copy-pasted at each config-fetch call site:
 *
 *     prUrl.match(/(?:github\.com|gitlab\.com)\/([^/]+)\/([^/]+)/)
 *
 * That had two failures, both silent because the caller wrapped it in a
 * try/catch that only warned:
 *
 *   1. It never matched a self-hosted GitLab URL, so `.repospector.yaml` was
 *      ignored on internal instances — no custom rules, no model pin, no
 *      severity floor, no cross-repo workspace. The feature simply did not
 *      exist for the way most companies run GitLab.
 *   2. It took exactly two path segments, so a GitLab subgroup path
 *      `group/subgroup/project` parsed as owner=`group`, repo=`subgroup` and
 *      the config fetch 404'd against a project that does not exist. Nested
 *      groups are the norm in enterprise GitLab.
 *
 * GitLab's project path is everything before the `/-/` route marker (or before
 * `/merge_requests` on legacy URLs), which is how a path of any depth resolves.
 * GitHub is always exactly `owner/repo`.
 *
 * @param {string} url
 * @returns {{platform:'github'|'gitlab', owner:string, repo:string, projectPath:string, host:string}|null}
 */
export function parseRepoRef(url) {
    const parsed = toUrl(url);
    if (!parsed) return null;

    const platform = detectPlatform(url);
    if (!platform) return null;

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return null;

    if (platform === PLATFORM.GITHUB) {
        const [owner, rawRepo] = segments;
        const repo = rawRepo.replace(/\.git$/, '');
        return { platform, owner, repo, projectPath: `${owner}/${repo}`, host: parsed.hostname.toLowerCase() };
    }

    // GitLab: everything up to the `-` route separator is the project path.
    let pathSegments = segments;
    const dashIndex = segments.indexOf('-');
    if (dashIndex > 0) {
        pathSegments = segments.slice(0, dashIndex);
    } else {
        // Legacy URL without `/-/`: cut at the first known route keyword.
        const routeIndex = segments.findIndex(s =>
            ['merge_requests', 'issues', 'tree', 'blob', 'commit', 'commits'].includes(s),
        );
        if (routeIndex > 0) pathSegments = segments.slice(0, routeIndex);
    }
    if (pathSegments.length < 2) return null;

    const projectPath = pathSegments.join('/').replace(/\.git$/, '');
    return {
        platform,
        // `owner` is the immediate parent group; `projectPath` is what the API wants.
        owner: pathSegments.slice(0, -1).join('/'),
        repo: pathSegments[pathSegments.length - 1].replace(/\.git$/, ''),
        projectPath,
        host: parsed.hostname.toLowerCase(),
    };
}

export default {
    PLATFORM,
    detectPlatform,
    detectPlatformOrGitHub,
    parseRepoRef,
    gitlabApiBase,
    originOf,
    hostOf,
    isKnownGitLabHost,
    setGitLabHosts,
    rememberGitLabHost,
    getGitLabHosts,
    resetGitLabHosts,
};

/**
 * Workspace / repo-link model — the foundation for cross-repo impact analysis.
 *
 * RepoSpector is single-repo today (every graph/index is keyed to one repoId). To
 * reason about impact ACROSS repos, we first need a declared set of related repos:
 * downstream consumers, shared libraries, or sibling services. That set is declared
 * per-repo in `.repospector.yaml`:
 *
 *   workspace:
 *     repos:
 *       - https://github.com/acme/consumer-a       # a downstream consumer
 *       - url: https://gitlab.com/acme/shared-lib
 *         role: library
 *       - url: https://github.com/acme/service-b
 *         role: consumer
 *     autoIndex: true          # index a linked repo on demand when impact is found
 *
 * This module parses/normalizes that block. It is pure and side-effect free.
 */

const GH = /github\.com[/:]([^/]+)\/([^/.]+)/i;
const GL = /gitlab\.com[/:]([^/]+(?:\/[^/]+)*)\/([^/.]+)/i;

/**
 * Derive a stable repoId ("owner/name") from a repo URL, or null.
 * @param {string} url
 * @returns {string|null}
 */
export function repoIdFromUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const clean = url.trim().replace(/\.git$/i, '').replace(/\/$/, '');
    let m = clean.match(GH);
    if (m) return `${m[1]}/${m[2]}`;
    m = clean.match(GL);
    if (m) return `${m[1]}/${m[2]}`;
    return null;
}

/**
 * Normalize the `workspace` block of a parsed .repospector.yaml config.
 * Accepts entries as bare URL strings or objects { url, role }.
 * @param {Object} config - parsed .repospector.yaml (or its `.workspace`)
 * @returns {{ repos: Array<{url:string, repoId:string|null, role:string}>, autoIndex: boolean }}
 */
export function parseWorkspace(config) {
    const ws = (config && (config.workspace || config)) || {};
    const rawRepos = Array.isArray(ws.repos) ? ws.repos : [];
    const seen = new Set();
    const repos = [];
    for (const entry of rawRepos) {
        const url = typeof entry === 'string' ? entry : entry?.url;
        if (!url || typeof url !== 'string') continue;
        const repoId = repoIdFromUrl(url);
        const key = repoId || url;
        if (seen.has(key)) continue;
        seen.add(key);
        repos.push({
            url: url.trim(),
            repoId,
            role: (typeof entry === 'object' && entry?.role) ? String(entry.role) : 'related'
        });
    }
    return { repos, autoIndex: ws.autoIndex === true };
}

/**
 * The linked repos OTHER than the current one (never include self).
 * @param {Object} config
 * @param {string} currentRepoId
 * @returns {Array<{url:string, repoId:string|null, role:string}>}
 */
export function linkedRepos(config, currentRepoId) {
    const { repos } = parseWorkspace(config);
    return repos.filter(r => r.repoId !== currentRepoId);
}

export default { repoIdFromUrl, parseWorkspace, linkedRepos };

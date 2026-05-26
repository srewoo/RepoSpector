/**
 * Parse a GitHub PR URL or GitLab MR URL into structured fields.
 * Returns null if the URL doesn't match a known shape.
 *
 *   https://github.com/owner/repo/pull/123
 *   https://gitlab.com/group/subgroup/repo/-/merge_requests/45
 */
export function parseMrUrl(url) {
    if (typeof url !== 'string') return null;

    let m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
    if (m) {
        return {
            platform: 'github',
            owner: m[1],
            repo: m[2].replace(/\.git$/, ''),
            repoFullName: `${m[1]}/${m[2].replace(/\.git$/, '')}`,
            mrIid: parseInt(m[3], 10),
            cloneUrl: `https://github.com/${m[1]}/${m[2].replace(/\.git$/, '')}.git`,
        };
    }

    m = url.match(/^https?:\/\/(?:www\.)?gitlab\.com\/(.+?)\/-\/merge_requests\/(\d+)/i);
    if (m) {
        const projectPath = m[1];
        const parts = projectPath.split('/');
        return {
            platform: 'gitlab',
            owner: parts.slice(0, -1).join('/'),
            repo: parts.at(-1),
            repoFullName: projectPath,
            mrIid: parseInt(m[2], 10),
            cloneUrl: `https://gitlab.com/${projectPath}.git`,
        };
    }

    return null;
}

import { parseRepoRef } from '../utils/gitHosts.js';

/**
 * permalink — a link to the exact lines a finding is about, pinned to the
 * reviewed commit.
 *
 * Pinned to the full head SHA, never a branch: a branch link drifts as soon as
 * the PR gets another push, and then points the reader at the wrong code. A
 * short or missing SHA therefore yields null rather than a link that drifts.
 *
 * One line of context each side, clamped to [1, fileLength].
 */

const FULL_SHA = /^[0-9a-f]{40}$/i;

/** Encode each path segment (spaces, '#', '?') while keeping the slashes. */
function encodePath(path) {
    return String(path).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
}

/**
 * @param {Object} args
 * @param {'github'|'gitlab'} args.platform
 * @param {string} args.host - e.g. github.com, ghe.acme.com, gitlab.acme.com:8443
 * @param {string} args.projectPath - owner/repo or group/subgroup/project
 * @param {string} args.headSha - 40-hex commit SHA
 * @param {string} args.path - repo-relative file path
 * @param {number} args.startLine - 1-based
 * @param {number} [args.endLine]
 * @param {number} [args.fileLength] - lines in the file at headSha, for clamping
 * @returns {string|null}
 */
export function buildPermalink({ platform, host, projectPath, headSha, path, startLine, endLine, fileLength } = {}) {
    if (!FULL_SHA.test(headSha || '') || !host || !projectPath || !path) return null;
    if (!Number.isInteger(startLine) || startLine < 1) return null;

    const last = Number.isInteger(endLine) && endLine >= startLine ? endLine : startLine;
    const max = Number.isInteger(fileLength) && fileLength > 0 ? fileLength : Infinity;
    const a = Math.max(1, Math.min(startLine - 1, max));
    const b = Math.max(a, Math.min(last + 1, max));
    const file = encodePath(path);

    if (platform === 'github') return `https://${host}/${projectPath}/blob/${headSha}/${file}#L${a}-L${b}`;
    if (platform === 'gitlab') return `https://${host}/${projectPath}/-/blob/${headSha}/${file}#L${a}-${b}`;
    return null;
}

/**
 * Return a copy of `findings`, each with `permalink` (string or null).
 *
 * @param {Array<Object>} findings - {file|filePath, line, endLine?}
 * @param {Object} repo - {platform, host, projectPath, headSha, fileLengths?: Record<string, number>}
 * @returns {Array<Object>}
 */
export function attachPermalinks(findings, { platform, host, projectPath, headSha, fileLengths = {} } = {}) {
    return (findings || []).map((f) => {
        const path = f?.file || f?.filePath || null;
        const permalink = path
            ? buildPermalink({
                platform, host, projectPath, headSha, path,
                startLine: Number(f.line),
                endLine: f.endLine == null ? undefined : Number(f.endLine),
                fileLength: fileLengths?.[path],
            })
            : null;
        return { ...f, permalink };
    });
}

/**
 * {platform, host, projectPath} from a PR/MR URL or a repo URL.
 *
 * Delegates platform and project-path parsing to `gitHosts.parseRepoRef`, so
 * the same rules apply as everywhere else: GitLab is recognised structurally
 * (`/-/`) on any host, GitHub Enterprise only once its host is configured.
 * `host` keeps a non-default port, which internal instances often run on.
 *
 * @param {string} url
 * @returns {{platform:'github'|'gitlab', host:string, projectPath:string}|null}
 */
export function parseRepoUrl(url) {
    const ref = parseRepoRef(url);
    if (!ref) return null;
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host.toLowerCase();
    return { platform: ref.platform, host, projectPath: ref.projectPath };
}

export default { buildPermalink, attachPermalinks, parseRepoUrl };

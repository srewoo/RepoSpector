import { ctxOk, ctxNotRun } from '../../review-core/context/contextPort.js';

/**
 * Extension implementation of the review-core ContextPort, over
 * PullRequestService (GitHub/GitLab APIs with the user's own token).
 *
 * One port per review: results are memoised for the port's lifetime (the
 * promise is cached, so concurrent lenses asking the same question share one
 * request), and thrown away with it.
 *
 * @param {Object} args
 * @param {Object} args.prData - normalized PR ({number, baseSha, headSha})
 * @param {string} args.prUrl
 * @param {Object} args.pullRequestService - carries the tokens
 * @returns {import('../../review-core/context/contextPort.js').ContextPort}
 */
export function createExtensionContextPort({ prData = {}, prUrl, pullRequestService } = {}) {
    const cache = new Map();

    const run = (what, key, fn) => {
        if (!prUrl || !pullRequestService) {
            return Promise.resolve(ctxNotRun(`${what}: no PR URL or pull-request service`));
        }
        if (!cache.has(key)) {
            cache.set(key, (async () => {
                try {
                    return ctxOk(await fn());
                } catch (e) {
                    return ctxNotRun(`${what}: ${e?.message || e}`);
                }
            })());
        }
        return cache.get(key);
    };

    return {
        blame(path, { ref, startLine, endLine } = {}) {
            const at = ref || prData.baseSha;
            if (!at) return Promise.resolve(ctxNotRun('blame: base SHA unknown'));
            return run('blame', `blame|${path}|${at}|${startLine}|${endLine}`, async () => ({
                ranges: await pullRequestService.fetchBlame(prUrl, path, at, startLine, endLine),
            }));
        },

        recentCommits(path, { ref, limit = 5 } = {}) {
            const at = ref || prData.baseSha || null;
            return run('recent commits', `commits|${path}|${at}|${limit}`, async () => ({
                commits: await pullRequestService.fetchRecentCommits(prUrl, path, at, limit),
            }));
        },

        priorPrComments(path, { limitPrs = 5 } = {}) {
            return run('prior PR comments', `prior|${path}|${limitPrs}`, async () => ({
                comments: await pullRequestService.fetchPriorPrComments(prUrl, path, {
                    limitPrs,
                    excludeNumber: prData.number ?? null,
                }),
            }));
        },

        fileContent(path, ref) {
            const at = ref || prData.headSha || null;
            return run('file content', `file|${path}|${at}`, async () => ({
                text: (await pullRequestService.fetchFullFileContent(prUrl, path, at)).content,
            }));
        },
    };
}

export default createExtensionContextPort;

/**
 * prHistory — blame, file history and prior review comments for the review
 * lenses (history, priorPrComments). Exposed through PullRequestService
 * (`fetchBlame`, `fetchRecentCommits`, `fetchPriorPrComments`); kept in its own
 * module so the 2k-line service does not grow by another subsystem.
 *
 * Every function THROWS on failure with a message naming the call and status.
 * The context adapter turns that into a `not-run` reason; nothing here decides
 * that a failed lookup means "no history".
 *
 * Deliberately plain `fetch`, not `fetchAllPages*`: those record diff
 * completeness incidents, and a missing blame is not a gap in the diff.
 */

const BLAME_QUERY = `query($owner: String!, $name: String!, $expr: String!, $path: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expr) {
      ... on Commit {
        blame(path: $path) {
          ranges { startingLine endingLine commit { oid message committedDate } }
        }
      }
    }
  }
}`;

/** GraphQL endpoint for a REST base: api.github.com -> /graphql; GHE <host>/api/v3 -> <host>/api/graphql. */
export function githubGraphqlUrl(apiBase) {
    return apiBase.endsWith('/api/v3') ? `${apiBase.slice(0, -'v3'.length)}graphql` : `${apiBase}/graphql`;
}

function ghHeaders(svc) {
    return {
        Accept: 'application/vnd.github.v3+json',
        ...(svc.githubToken ? { Authorization: `token ${svc.githubToken}` } : {}),
    };
}

function glHeaders(svc) {
    return svc.gitlabToken ? { 'PRIVATE-TOKEN': svc.gitlabToken } : {};
}

function ghRepoBase(svc, prInfo) {
    return `${svc.githubApiFor(prInfo)}/repos/${prInfo.owner}/${prInfo.repo}`;
}

function glProjectBase(svc, prInfo) {
    return `${svc.gitlabApiFor(prInfo)}/projects/${encodeURIComponent(prInfo.projectPath || `${prInfo.owner}/${prInfo.repo}`)}`;
}

async function getJson(url, init, what) {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`${what}: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    return res.json();
}

const overlaps = (r, a, b) => !(a && b) || (r.end >= a && r.start <= b);
const trimmed = (s) => (typeof s === 'string' ? s.trim() : '');

async function githubBlame(svc, prInfo, path, ref) {
    if (!svc.githubToken) {
        throw new Error('GitHub blame needs a GitHub token (the GraphQL API refuses anonymous calls)');
    }
    const data = await getJson(githubGraphqlUrl(svc.githubApiFor(prInfo)), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `bearer ${svc.githubToken}` },
        body: JSON.stringify({ query: BLAME_QUERY, variables: { owner: prInfo.owner, name: prInfo.repo, expr: ref, path } }),
    }, 'GitHub blame');
    if (data?.errors?.length) throw new Error(`GitHub blame: ${data.errors[0]?.message || 'GraphQL error'}`);
    const ranges = data?.data?.repository?.object?.blame?.ranges;
    if (!Array.isArray(ranges)) throw new Error(`GitHub blame: no blame for ${path} at ${ref}`);
    return ranges.map(r => ({
        start: r.startingLine,
        end: r.endingLine,
        sha: r.commit?.oid || null,
        message: trimmed(r.commit?.message),
        date: r.commit?.committedDate || null,
    }));
}

async function gitlabBlame(svc, prInfo, path, ref, startLine, endLine) {
    const qs = new URLSearchParams({ ref });
    const windowed = Boolean(startLine && endLine);
    if (windowed) {
        qs.set('range[start]', String(startLine));
        qs.set('range[end]', String(endLine));
    }
    const groups = await getJson(
        `${glProjectBase(svc, prInfo)}/repository/files/${encodeURIComponent(path)}/blame?${qs}`,
        { headers: glHeaders(svc) },
        'GitLab blame',
    );
    // GitLab returns consecutive groups of lines per commit; line numbers are implied.
    let line = windowed ? startLine : 1;
    const out = [];
    for (const g of groups || []) {
        const n = (g?.lines || []).length;
        if (!n) continue;
        out.push({
            start: line,
            end: line + n - 1,
            sha: g.commit?.id || null,
            message: trimmed(g.commit?.message),
            date: g.commit?.committed_date || null,
        });
        line += n;
    }
    return out;
}

/** @returns {Promise<Array<{start:number,end:number,sha:string,message:string,date:string}>>} */
export async function fetchBlame(svc, prInfo, path, ref, startLine, endLine) {
    if (!ref) throw new Error('blame: no ref (base SHA) given');
    const ranges = prInfo.platform === 'gitlab'
        ? await gitlabBlame(svc, prInfo, path, ref, startLine, endLine)
        : await githubBlame(svc, prInfo, path, ref);
    return ranges.filter(r => overlaps(r, startLine, endLine));
}

/** A finite number, else `fallback` ('' / null / NaN never reach a query string). */
function finiteOr(value, fallback) {
    if (value === null || value === undefined || String(value).trim() === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/** @returns {Promise<Array<{sha:string,message:string,date:string}>>} */
export async function fetchRecentCommits(svc, prInfo, path, ref, limit = 5) {
    const perPage = String(Math.max(1, Math.min(100, finiteOr(limit, 5))));
    if (prInfo.platform === 'gitlab') {
        const qs = new URLSearchParams({ path, per_page: perPage, ...(ref ? { ref_name: ref } : {}) });
        const list = await getJson(`${glProjectBase(svc, prInfo)}/repository/commits?${qs}`, { headers: glHeaders(svc) }, 'GitLab commits');
        return (list || []).map(c => ({ sha: c.id, message: trimmed(c.message), date: c.committed_date || null }));
    }
    const qs = new URLSearchParams({ path, per_page: perPage, ...(ref ? { sha: ref } : {}) });
    const list = await getJson(`${ghRepoBase(svc, prInfo)}/commits?${qs}`, { headers: ghHeaders(svc) }, 'GitHub commits');
    return (list || []).map(c => ({ sha: c.sha, message: trimmed(c.commit?.message), date: c.commit?.author?.date || null }));
}

/** First `limit` unique values, in order. */
function firstUnique(values, limit) {
    return [...new Set(values)].slice(0, limit);
}

async function githubPriorComments(svc, prInfo, path, limitPrs, excludeNumber, scan) {
    const base = ghRepoBase(svc, prInfo);
    const headers = ghHeaders(svc);
    const commits = await getJson(`${base}/commits?${new URLSearchParams({ path, per_page: String(scan) })}`, { headers }, 'GitHub commits');
    const pullLists = await Promise.all((commits || []).map(c =>
        getJson(`${base}/commits/${c.sha}/pulls`, { headers }, 'GitHub commit pulls')));
    const numbers = firstUnique(
        pullLists.flat().filter(p => p?.merged_at && p.number !== excludeNumber).map(p => p.number),
        limitPrs,
    );
    const perPr = await Promise.all(numbers.map(async (n) => {
        const comments = await getJson(`${base}/pulls/${n}/comments?per_page=100`, { headers }, 'GitHub PR comments');
        return (comments || []).filter(c => c.path === path).map(c => ({
            path, prRef: `#${n}`, author: c.user?.login || '', body: c.body || '', line: c.line ?? c.original_line ?? null,
        }));
    }));
    return perPr.flat();
}

async function gitlabPriorComments(svc, prInfo, path, limitPrs, excludeNumber, scan) {
    const base = glProjectBase(svc, prInfo);
    const headers = glHeaders(svc);
    const commits = await getJson(`${base}/repository/commits?${new URLSearchParams({ path, per_page: String(scan) })}`, { headers }, 'GitLab commits');
    const mrLists = await Promise.all((commits || []).map(c =>
        getJson(`${base}/repository/commits/${c.id}/merge_requests`, { headers }, 'GitLab commit MRs')));
    const iids = firstUnique(
        mrLists.flat().filter(m => m?.state === 'merged' && m.iid !== excludeNumber).map(m => m.iid),
        limitPrs,
    );
    const perMr = await Promise.all(iids.map(async (iid) => {
        const discussions = await getJson(`${base}/merge_requests/${iid}/discussions?per_page=100`, { headers }, 'GitLab MR discussions');
        return (discussions || []).flatMap(d => d?.notes || [])
            .filter(n => !n.system && n.type === 'DiffNote' && (n.position?.new_path === path || n.position?.old_path === path))
            .map(n => ({
                path, prRef: `!${iid}`, author: n.author?.username || '', body: n.body || '',
                line: n.position?.new_line ?? n.position?.old_line ?? null,
            }));
    }));
    return perMr.flat();
}

/**
 * Review comments on `path` from recent MERGED PRs/MRs that touched it,
 * excluding the PR under review. Scans at most 2 x limitPrs commits (cap 10)
 * so one file costs a bounded number of calls.
 *
 * @returns {Promise<Array<{path:string, prRef:string, author:string, body:string, line:number|null}>>}
 */
export async function fetchPriorPrComments(svc, prInfo, path, { limitPrs: rawLimit = 5, excludeNumber = null } = {}) {
    const limitPrs = Math.max(1, finiteOr(rawLimit, 5));
    const scan = Math.min(10, Math.max(1, limitPrs * 2));
    return prInfo.platform === 'gitlab'
        ? gitlabPriorComments(svc, prInfo, path, limitPrs, excludeNumber, scan)
        : githubPriorComments(svc, prInfo, path, limitPrs, excludeNumber, scan);
}

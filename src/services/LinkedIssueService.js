/**
 * LinkedIssueService — fetch the ticket a PR claims to implement.
 *
 * `reviewIntentContext.buildIntentBlock` has always accepted an `issue` and
 * rendered its acceptance criteria into the review prompt, with an explicit
 * instruction that an unaddressed criterion is a finding. Nothing ever passed
 * one. The parameter was threaded from `handleMultiPassPRReview` as
 * `options.issue || null` and no caller set it, so the whole
 * "does this diff do what was asked?" branch was unreachable code — the
 * reviewer could only ever ask "is this code correct?".
 *
 * This closes that gap using data both hosts already expose:
 *
 *   GitLab  — `/merge_requests/{iid}/closes_issues` is authoritative. GitLab
 *             resolves the closing references itself; no parsing, no guessing.
 *   GitHub  — has no equivalent REST endpoint (the linkage lives in GraphQL,
 *             which needs a token even for public repos). So we parse the
 *             closing keywords GitHub itself documents out of the PR body and
 *             title, then fetch each referenced issue.
 *
 * Fail-soft throughout. A missing token, a private issue tracker, a rate limit,
 * a 404 — every one of these returns null and the review proceeds exactly as it
 * did before. A ticket lookup must never be the reason a review does not run.
 */

// Jira key extraction is shared with the intent block, which already has a
// tuned regex and a denylist (CVE-2021-1 is not a ticket). Reusing it keeps one
// definition of "looks like a Jira key" rather than two that drift.
import { extractIssueKeys as extractJiraKeys } from '../utils/reviewIntentContext.js';

/**
 * GitHub's documented closing keywords, and the reference forms it accepts.
 * Deliberately anchored to those keywords rather than matching bare `#123`:
 * a PR body that merely mentions "#42" in passing is not implementing #42, and
 * treating it as the spec would invent acceptance criteria for the reviewer to
 * check the diff against.
 */
const CLOSING_REF_RE =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+(?:([\w.-]+)\/([\w.-]+))?#(\d+)/gi;

/** Never chase more than this many tickets — one PR, a handful of issues. */
const MAX_ISSUES = 3;

/**
 * Extract closing issue references from a PR's title and body.
 *
 * @param {Object} prData
 * @returns {Array<{owner: string|null, repo: string|null, number: number}>}
 */
export function extractClosingRefs(prData) {
    const out = [];
    const seen = new Set();

    for (const text of [prData?.title, prData?.description]) {
        if (!text) continue;
        CLOSING_REF_RE.lastIndex = 0;
        let m;
        while ((m = CLOSING_REF_RE.exec(String(text))) !== null) {
            const [, owner = null, repo = null, num] = m;
            const number = parseInt(num, 10);
            if (!Number.isFinite(number)) continue;
            const key = `${owner || ''}/${repo || ''}#${number}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ owner, repo, number });
        }
    }

    return out.slice(0, MAX_ISSUES);
}

/**
 * Normalize a GitHub issue payload into the shape `buildIntentBlock` reads.
 *
 * `acceptanceCriteria` is deliberately left off: `buildIntentBlock` parses it
 * from `description` via `parseAcceptanceCriteria`, which already handles the
 * three formats teams actually write. Duplicating that here would give us two
 * parsers to keep in agreement.
 *
 * @param {Object} issue - raw GitHub issue
 * @returns {Object|null}
 */
export function normalizeGitHubIssue(issue) {
    if (!issue || typeof issue.number !== 'number') return null;
    const labels = (issue.labels || [])
        .map(l => (typeof l === 'string' ? l : l?.name))
        .filter(Boolean);

    return {
        key: `#${issue.number}`,
        summary: issue.title || '',
        description: issue.body || '',
        // GitHub has no type/priority fields; teams encode both as labels, so
        // surface the labels and let the model read them rather than inventing
        // a mapping that would be wrong for most repos.
        type: labels.find(l => /^(bug|feature|enhancement|task|chore)$/i.test(l)) || null,
        priority: labels.find(l => /^(p[0-4]|critical|high|medium|low)$/i.test(l)) || null,
        status: issue.state || null,
        url: issue.html_url || null,
    };
}

/**
 * Normalize a GitLab issue payload.
 *
 * @param {Object} issue - raw GitLab issue
 * @returns {Object|null}
 */
export function normalizeGitLabIssue(issue) {
    if (!issue || typeof issue.iid !== 'number') return null;
    const labels = issue.labels || [];

    return {
        key: `#${issue.iid}`,
        summary: issue.title || '',
        description: issue.description || '',
        type: issue.issue_type
            || labels.find(l => /^(bug|feature|enhancement|task|chore)$/i.test(l))
            || null,
        priority: labels.find(l => /^(p[0-4]|critical|high|medium|low)$/i.test(l)) || null,
        status: issue.state || null,
        url: issue.web_url || null,
    };
}

/**
 * Flatten Atlassian Document Format into markdown-ish text.
 *
 * Jira Cloud's v3 API returns `description` as an ADF node tree, not a string.
 * `parseAcceptanceCriteria` works on text and recognises headings, bullets, and
 * task-list checkboxes — so the structure has to survive the conversion or the
 * acceptance criteria, which are almost always a bulleted or checkbox list,
 * come through as one unbroken paragraph and parse as nothing.
 *
 * Only the node types that carry criteria are handled; everything else
 * contributes its text. Unknown nodes recurse rather than being dropped.
 *
 * @param {Object|string} node
 * @returns {string}
 */
export function flattenADF(node) {
    if (typeof node === 'string') return node;
    if (!node || typeof node !== 'object') return '';

    const kids = Array.isArray(node.content) ? node.content : [];
    const inner = () => kids.map(flattenADF).join('');

    switch (node.type) {
        case 'text':
            return node.text || '';
        case 'hardBreak':
            return '\n';
        case 'paragraph':
            return `${inner()}\n`;
        case 'heading':
            return `\n${'#'.repeat(node.attrs?.level || 2)} ${inner()}\n`;
        case 'listItem':
            return `- ${inner().trim()}\n`;
        case 'taskItem':
            // The checkbox form parseAcceptanceCriteria looks for.
            return `- [${node.attrs?.state === 'DONE' ? 'x' : ' '}] ${inner().trim()}\n`;
        case 'codeBlock':
            return `\n\`\`\`\n${inner()}\n\`\`\`\n`;
        case 'rule':
            return '\n---\n';
        default:
            return inner();
    }
}

/**
 * Normalize a Jira issue payload.
 *
 * @param {Object} issue - raw Jira issue (v2 or v3)
 * @returns {Object|null}
 */
export function normalizeJiraIssue(issue) {
    if (!issue || !issue.key) return null;
    const f = issue.fields || {};
    return {
        key: issue.key,
        summary: f.summary || '',
        // v2 returns a string, v3 an ADF tree. Accept either.
        description: typeof f.description === 'string'
            ? f.description
            : flattenADF(f.description),
        type: f.issuetype?.name || null,
        priority: f.priority?.name || null,
        status: f.status?.name || null,
        url: null,
    };
}

export class LinkedIssueService {
    /**
     * @param {Object} [opts]
     * @param {string|null} [opts.githubToken]
     * @param {string|null} [opts.gitlabToken]
     * @param {string} [opts.githubBaseUrl]
     * @param {string} [opts.gitlabBaseUrl]
     * @param {Function} [opts.fetchImpl] - injectable for tests
     */
    constructor(opts = {}) {
        this.githubToken = opts.githubToken || null;
        this.gitlabToken = opts.gitlabToken || null;
        this.githubBaseUrl = opts.githubBaseUrl || 'https://api.github.com';
        this.gitlabBaseUrl = opts.gitlabBaseUrl || 'https://gitlab.com/api/v4';
        // Jira is optional and independent of the host: a GitHub PR whose title
        // carries a Jira key is the common case in teams that use both.
        this.jiraBaseUrl = (opts.jiraBaseUrl || '').replace(/\/+$/, '');
        this.jiraEmail = opts.jiraEmail || null;
        this.jiraToken = opts.jiraToken || null;
        this.fetchImpl = opts.fetchImpl || ((...args) => fetch(...args));
    }

    /** Are Jira credentials configured? */
    get jiraConfigured() {
        return !!(this.jiraBaseUrl && this.jiraEmail && this.jiraToken);
    }

    /**
     * Fetch a Jira issue by key.
     *
     * `reviewIntentContext.extractIssueKeys` has always found keys like
     * `PROJ-123` in the branch and title; with nothing able to fetch them the
     * intent block rendered "(details unavailable)" and the acceptance criteria
     * — the whole point — were never available for Jira teams.
     *
     * Only the fields the intent block renders are requested, so a large issue
     * with dozens of custom fields costs one small response.
     *
     * @param {string} key - e.g. "PROJ-123"
     * @returns {Promise<Object|null>}
     */
    async fetchJiraIssue(key) {
        if (!this.jiraConfigured || !key) return null;
        try {
            const auth = base64(`${this.jiraEmail}:${this.jiraToken}`);
            const fields = 'summary,description,issuetype,priority,status';
            const res = await this.fetchImpl(
                `${this.jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`,
                {
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Accept': 'application/json',
                    },
                },
            );
            if (!res.ok) {
                // 404 is the ordinary case for a key that matched the regex but
                // is not a real issue — not worth a warning.
                if (res.status !== 404) {
                    console.warn(`Jira: ${key} returned ${res.status}`);
                }
                return null;
            }
            const issue = normalizeJiraIssue(await res.json());
            if (issue) issue.url = `${this.jiraBaseUrl}/browse/${issue.key}`;
            return issue;
        } catch (e) {
            console.warn(`Jira: lookup for ${key} failed:`, e?.message);
            return null;
        }
    }

    /**
     * The single most relevant linked issue for a PR, or null.
     *
     * Returns one issue rather than all of them on purpose. `buildIntentBlock`
     * renders acceptance criteria as a numbered list the reviewer checks the
     * diff against; concatenating three tickets' criteria produces a list where
     * most entries are legitimately unmet by this diff, and every one of those
     * is a false finding.
     *
     * @param {Object} prData - normalized PR data from PullRequestService
     * @param {Object} prInfo - parsed URL info { platform, owner, repo, projectPath, mrNumber }
     * @returns {Promise<Object|null>}
     */
    async fetchForPR(prData, prInfo) {
        try {
            // Jira first when configured. A team that runs Jira puts the
            // requirement there, not in a GitHub issue — so when both exist,
            // the Jira ticket is the one carrying the acceptance criteria.
            if (this.jiraConfigured) {
                for (const key of extractJiraKeys(prData)) {
                    const issue = await this.fetchJiraIssue(key);
                    if (issue) return issue;
                }
            }

            if (prInfo?.platform === 'gitlab') {
                return await this._fetchGitLab(prInfo);
            }
            if (prInfo?.platform === 'github') {
                return await this._fetchGitHub(prData, prInfo);
            }
            return null;
        } catch (e) {
            // Soft by contract — see the module note.
            console.warn('LinkedIssueService: lookup failed, reviewing without ticket context:', e?.message);
            return null;
        }
    }

    async _fetchGitHub(prData, prInfo) {
        const refs = extractClosingRefs(prData);
        if (refs.length === 0) return null;

        const headers = { 'Accept': 'application/vnd.github.v3+json' };
        if (this.githubToken) headers['Authorization'] = `token ${this.githubToken}`;

        for (const ref of refs) {
            const owner = ref.owner || prInfo.owner;
            const repo = ref.repo || prInfo.repo;
            if (!owner || !repo) continue;

            const res = await this.fetchImpl(
                `${this.githubBaseUrl}/repos/${owner}/${repo}/issues/${ref.number}`,
                { headers },
            );
            if (!res.ok) continue;
            const raw = await res.json();

            // `/issues/{n}` also serves pull requests — a PR that says
            // "Closes #12" where 12 is another PR would otherwise be presented
            // to the reviewer as this change's specification.
            if (raw.pull_request) continue;

            const issue = normalizeGitHubIssue(raw);
            if (issue) return issue;
        }
        return null;
    }

    async _fetchGitLab(prInfo) {
        const projectId = encodeURIComponent(
            prInfo.projectPath || `${prInfo.owner}/${prInfo.repo}`,
        );
        const api = prInfo.apiBase || this.gitlabBaseUrl;
        const headers = { 'Content-Type': 'application/json' };
        if (this.gitlabToken) headers['PRIVATE-TOKEN'] = this.gitlabToken;

        const res = await this.fetchImpl(
            `${api}/projects/${projectId}/merge_requests/${prInfo.mrNumber}/closes_issues`,
            { headers },
        );
        if (!res.ok) return null;

        const list = await res.json();
        if (!Array.isArray(list) || list.length === 0) return null;
        return normalizeGitLabIssue(list[0]);
    }
}

/**
 * Base64 for HTTP Basic auth, safe for non-ASCII.
 *
 * `btoa` throws on any code point above 0xFF, so an email or token containing
 * one would take down the lookup rather than merely failing to authenticate.
 */
function base64(input) {
    const bytes = new TextEncoder().encode(input);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

export default LinkedIssueService;

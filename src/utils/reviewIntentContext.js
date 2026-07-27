/**
 * reviewIntentContext — tell the reviewer what the change was SUPPOSED to do.
 *
 * A reviewer with only a diff can ask one question: "is this code correct?"
 * A reviewer who also knows the ticket, the pipeline state and the discussion
 * can ask the questions humans actually ask:
 *
 *   - does this diff cover the acceptance criteria, or only some of them?
 *   - CI is red on `test_kafka_consumer` — does this diff explain that?
 *   - a reviewer already objected to this approach in the discussion.
 *
 * Bastion pre-computes exactly three blocks and injects them before the LLM
 * runs (`<jira_context>`, `<gitlab_context>`, `<mr_stats>`), and its workflow
 * step 4 states outright that "acceptance criterion 2 (error retry) is not
 * addressed in this diff" is a legitimate finding. Grepping RepoSpector for
 * `acceptanceCriteria` / `pipeline_status` returned nothing — a whole class of
 * finding it structurally could not produce.
 *
 * Everything here is derived from data `PullRequestService.fetchPullRequest`
 * already returns (description, pipeline, reviews, discussion, comments) plus an
 * optional Jira issue supplied by the caller. Pure and synchronous: no fetches,
 * so it cannot fail a review.
 */

/** Jira-style keys: PROJ-123. Deliberately strict to avoid matching CVE-2021-1. */
const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g;

/** Keys that look like a ticket but never are. */
const JIRA_KEY_DENYLIST = /^(CVE|CWE|RFC|UTF|SHA|HTTP|ISO|IEC|AES|RSA|JIRA|TODO|FIXME)$/;

/**
 * Extract candidate Jira issue keys from a PR's title, branch and description.
 *
 * Ordered by trust: the branch name and title are deliberate references; the
 * description often quotes unrelated tickets ("similar to ABC-1"), so keys found
 * only there rank last.
 *
 * @param {Object} prData
 * @returns {string[]} unique keys, most likely first
 */
export function extractIssueKeys(prData) {
    const scan = (text) => {
        const out = [];
        if (!text) return out;
        JIRA_KEY_RE.lastIndex = 0;
        let m;
        while ((m = JIRA_KEY_RE.exec(String(text))) !== null) {
            if (JIRA_KEY_DENYLIST.test(m[1])) continue;
            out.push(`${m[1]}-${m[2]}`);
        }
        return out;
    };

    const ordered = [
        ...scan(prData?.branches?.source),
        ...scan(prData?.title),
        ...scan(prData?.description),
    ];

    return [...new Set(ordered)];
}

/**
 * Pull acceptance criteria out of a free-text issue description.
 *
 * Teams write these three ways and we support all of them, because a criteria
 * list the model never sees is worth nothing:
 *   - a heading ("Acceptance Criteria:") followed by bullets or a numbered list
 *   - GitHub/Jira task-list checkboxes anywhere in the body
 *   - "Given/When/Then" lines
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseAcceptanceCriteria(text) {
    const body = String(text ?? '');
    if (!body.trim()) return [];

    const criteria = [];

    // 1. Explicit heading, then consume the list under it.
    const headingRe = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?\s*acceptance\s+criteri(?:a|on)\s*:?\s*(?:\*\*)?\s*\n/i;
    const hm = body.match(headingRe);
    if (hm) {
        const after = body.slice(hm.index + hm[0].length);
        for (const rawLine of after.split('\n')) {
            const line = rawLine.trim();
            if (!line) continue;
            // Stop at the next heading — the AC section has ended.
            if (/^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*:?$/.test(line)) break;
            const item = line.replace(/^[-*+]\s*(\[[ xX]\]\s*)?/, '').replace(/^\d+[.)]\s*/, '').trim();
            if (item) criteria.push(item);
            else break;
        }
    }

    // 2. Checkboxes anywhere — common when there is no heading at all.
    if (criteria.length === 0) {
        for (const m of body.matchAll(/^\s*[-*+]\s*\[[ xX]\]\s+(.+?)\s*$/gm)) {
            criteria.push(m[1].trim());
        }
    }

    // 3. Gherkin.
    if (criteria.length === 0) {
        for (const m of body.matchAll(/^\s*(given|when|then)\b.*$/gim)) {
            criteria.push(m[0].trim());
        }
    }

    // Cap and de-noise: a 60-item list is a spec document, not criteria, and
    // pasting it whole would crowd out the diff.
    return [...new Set(criteria)].filter(c => c.length > 3).slice(0, 15);
}

/**
 * Summarise the host's view of the change: pipeline, approvals, open threads.
 *
 * @param {Object} prData
 * @returns {Object}
 */
export function buildHostContext(prData) {
    const pipeline = prData?.pipeline || null;

    // Unresolved inline threads authored by humans are the strongest signal that
    // this PR is contested — the reviewer should not re-litigate settled points
    // but should notice unaddressed ones.
    const openThreads = (prData?.comments || []).filter(c => c && c.resolved !== true).length;

    return {
        platform: prData?.platform || null,
        state: prData?.state || null,
        isDraft: !!prData?.isDraft,
        mergeable: prData?.mergeable ?? null,
        pipelineStatus: pipeline?.status || null,
        pipelineUrl: pipeline?.webUrl || null,
        failedJobs: Array.isArray(prData?.failedJobs) ? prData.failedJobs : [],
        approvals: (prData?.reviews || []).filter(r => r.state === 'APPROVED').length,
        changesRequested: (prData?.reviews || []).filter(r => r.state === 'CHANGES_REQUESTED').length,
        openDiscussions: openThreads,
        labels: prData?.labels || [],
        filesChanged: prData?.stats?.changedFiles ?? (prData?.files || []).length,
        additions: prData?.stats?.additions ?? 0,
        deletions: prData?.stats?.deletions ?? 0,
    };
}

/** Trim a description to something that informs without dominating the prompt. */
function summariseDescription(description, maxChars = 1200) {
    const text = String(description ?? '')
        // Strip HTML comments and PR-template boilerplate checklists, which are
        // noise in nearly every repo that ships a template.
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/^\s*[-*]\s*\[[ xX]\]\s*(I have|My code|This PR follows).*$/gim, '')
        .trim();

    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n… (description truncated)`;
}

/**
 * Render the intent block that gets inlined into the review prompt.
 *
 * Returns '' when there is genuinely nothing to say, so the caller can
 * concatenate unconditionally without leaving an empty heading behind.
 *
 * @param {Object} prData
 * @param {Object} [options]
 * @param {Object|null} [options.issue] - { key, summary, description, type,
 *        priority, status, acceptanceCriteria? } supplied by the caller. When
 *        `acceptanceCriteria` is absent it is parsed from `description`.
 * @returns {string} markdown block
 */
export function buildIntentBlock(prData, options = {}) {
    const { issue = null } = options;
    const host = buildHostContext(prData);
    const lines = [];

    const description = summariseDescription(prData?.description);

    // ── Ticket ────────────────────────────────────────────────────────────
    if (issue?.key) {
        lines.push('## Intent — the ticket this change implements', '');
        lines.push(`- **Issue**: ${issue.key}${issue.summary ? ` — ${issue.summary}` : ''}`);
        if (issue.type) lines.push(`- **Type**: ${issue.type}`);
        if (issue.priority) lines.push(`- **Priority**: ${issue.priority}`);
        if (issue.status) lines.push(`- **Status**: ${issue.status}`);

        const criteria = issue.acceptanceCriteria?.length
            ? issue.acceptanceCriteria
            : parseAcceptanceCriteria(issue.description);

        if (criteria.length) {
            lines.push('', '**Acceptance criteria:**');
            criteria.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
            lines.push(
                '',
                '**Check the diff against these.** If a criterion is not addressed by ' +
                'this change, that is a finding (severity: medium, category: logic) — ' +
                'state which criterion and what is missing. Do NOT invent criteria that ' +
                'are not listed above, and do not flag a criterion as unmet if it is ' +
                'plainly satisfied elsewhere in the diff.'
            );
        }
        lines.push('');
    } else {
        const keys = extractIssueKeys(prData);
        if (keys.length) {
            lines.push('## Intent', '', `- **Referenced issue(s)**: ${keys.join(', ')} (details unavailable)`, '');
        }
    }

    // ── Author's stated purpose ───────────────────────────────────────────
    if (description) {
        if (!lines.length) lines.push('## Intent', '');
        lines.push("**Author's description:**", '', description, '');
    }

    // ── Host state ────────────────────────────────────────────────────────
    const hostBits = [];
    if (host.pipelineStatus) hostBits.push(`- **CI pipeline**: ${host.pipelineStatus}`);
    if (host.failedJobs.length) hostBits.push(`- **Failed jobs**: ${host.failedJobs.slice(0, 5).join(', ')}`);
    if (host.changesRequested) hostBits.push(`- **Changes requested by**: ${host.changesRequested} reviewer(s)`);
    if (host.approvals) hostBits.push(`- **Approvals**: ${host.approvals}`);
    if (host.openDiscussions) hostBits.push(`- **Open discussion threads**: ${host.openDiscussions}`);
    if (host.mergeable === false) hostBits.push('- **Merge status**: conflicts present');
    if (host.labels.length) hostBits.push(`- **Labels**: ${host.labels.slice(0, 8).join(', ')}`);

    if (hostBits.length) {
        lines.push('**Repository state:**', '', ...hostBits, '');

        if (host.pipelineStatus === 'failed') {
            lines.push(
                'CI is failing. Consider whether this diff explains the failure. If it ' +
                'plainly does (e.g. a renamed symbol its callers still use), report it ' +
                'as a blocking finding. If it does not, say so in one line rather than ' +
                'speculating.',
                ''
            );
        }
    }

    if (!lines.length) return '';

    return lines.join('\n');
}

export default {
    extractIssueKeys,
    parseAcceptanceCriteria,
    buildHostContext,
    buildIntentBlock,
};

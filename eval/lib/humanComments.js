/**
 * humanComments — turn a PR's inline comments into recall ground truth.
 *
 * Recall is "of the things a human said, how many did we also say?", so the
 * denominator decides the score. Two ways to get it wrong:
 *
 *   Too generous — count bot comments and "LGTM" and recall looks impossible,
 *   understating the reviewer.
 *   Too strict — drop anything that does not look like a defect report and
 *   recall looks flattering, because the hard comments (design, naming,
 *   "why not reuse X") are exactly the ones that get filtered.
 *
 * The rule here is: exclude only what is mechanically identifiable as noise —
 * known bots, and comments too short to carry a request. Everything else counts
 * against us. Borderline calls resolve toward `substantive: true`, which is the
 * harder direction for the tool being measured.
 */

/**
 * Accounts whose comments are machine-generated. Matched case-insensitively as
 * a whole login, plus the universal `[bot]` suffix GitHub appends to Apps.
 */
const BOT_LOGINS = new Set([
    'dependabot', 'renovate', 'codecov', 'coderabbitai', 'sonarcloud',
    'sonarqubecloud', 'github-actions', 'stale', 'netlify', 'vercel',
    'copilot-pull-request-reviewer', 'greptile-apps', 'gemini-code-assist',
    'codiumai-pr-agent', 'ellipsis-dev', 'sourcery-ai', 'deepsource-autofix',
    'pre-commit-ci', 'allcontributors', 'mergify', 'kodiakhq',
]);

export function isBot(login) {
    const name = String(login ?? '').toLowerCase();
    if (!name) return false;
    if (name.endsWith('[bot]')) return true;
    return BOT_LOGINS.has(name.replace(/\[bot\]$/, ''));
}

/**
 * Comments with no request in them. Kept deliberately narrow — this is a
 * hand-checkable list of pure acknowledgements, not a topic filter.
 */
const ACK_ONLY = /^\s*(lgtm|looks good( to me)?|ship it|nice|thanks?|thank you|ty|done|fixed|ok(ay)?|\+1|👍|🚀|✅|same|agreed?|sgtm)[\s.!👍🚀✅]*$/i;

/** Minimum length for a comment to plausibly contain a review request. */
const MIN_SUBSTANTIVE_CHARS = 25;

/**
 * Strip quoted reply blocks and code fences before judging length: a two-word
 * reply under a 40-line quote is still a two-word reply.
 */
function meaningfulText(body) {
    return String(body ?? '')
        .replace(/^>.*$/gm, '')            // quoted text
        .replace(/```[\s\S]*?```/g, ' ')   // fenced code
        .replace(/`[^`]*`/g, ' ')          // inline code
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')  // images
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Is this comment a review request a tool could reasonably be expected to make?
 *
 * Thread REPLIES are excluded, and this matters more than it sounds. GitHub
 * returns every message in a review thread as a separate comment at the same
 * path and line, so a single disputed issue arrives as four or five entries.
 * Counting them all inflates the recall denominator with the same issue
 * repeated, and fills it with conversation a reviewer could not produce and
 * should not be scored on — "does `block_fast_lane` match what you had in
 * mind?", "my plan is to do a refactor PR after the 2 current PRs merge".
 *
 * The defensible denominator is *distinct review threads a human opened*, so
 * only thread roots count.
 *
 * @param {{body?:string, author?:string, inReplyTo?:number|null}} comment
 */
export function isSubstantive(comment) {
    if (isBot(comment?.author)) return false;
    if (comment?.inReplyTo) return false;
    const text = meaningfulText(comment?.body);
    if (!text) return false;
    if (ACK_ONLY.test(text)) return false;
    return text.length >= MIN_SUBSTANTIVE_CHARS;
}

/**
 * Convert normalized PR comments into scoreable references.
 *
 * Non-substantive comments are KEPT with `substantive: false` rather than
 * dropped. The scorer excludes them from the denominator, and keeping them
 * means the corpus records what was filtered and why — a denominator you
 * cannot audit is a denominator you cannot trust.
 *
 * @param {Array<{path?:string, line?:number, body?:string, author?:string}>} comments
 * @returns {Array<{file:string, line:number|null, body:string, author:string, substantive:boolean, reason?:string}>}
 */
export function toReferences(comments = []) {
    const out = [];
    for (const c of comments) {
        // A comment with no file cannot be located, so it cannot be matched
        // against a finding. Counting it would make recall unreachable by
        // construction; it is excluded and the reason recorded.
        const file = c?.path ?? c?.file ?? null;
        const substantive = !!file && isSubstantive(c);

        let reason;
        if (!file) reason = 'no file (PR-level comment)';
        else if (isBot(c.author)) reason = 'bot';
        else if (c.inReplyTo) reason = 'thread reply (root already counted)';
        else if (!substantive) reason = 'acknowledgement or too short';

        out.push({
            file: file ?? '',
            line: Number.isFinite(Number(c?.line)) ? Number(c.line) : null,
            body: String(c?.body ?? '').slice(0, 500),
            author: c?.author ?? '',
            inReplyTo: c?.inReplyTo ?? null,
            substantive,
            ...(reason ? { excludedReason: reason } : {}),
        });
    }
    return out;
}

export default { toReferences, isSubstantive, isBot };

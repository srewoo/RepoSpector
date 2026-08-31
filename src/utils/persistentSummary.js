/**
 * persistentSummary — one review summary per PR, updated in place.
 *
 * Every run posted a NEW summary comment. A PR reviewed five times accumulates
 * five summaries, four of which describe code that no longer exists, and the
 * reader has to work out which is current from timestamps. `commentDedupe`
 * already handles duplicate INLINE comments; nothing handled the summary.
 *
 * pr-agent solves this with `persistent_comment`: find the previous one, edit it.
 * That is what this does, and the machinery mostly exists already —
 * `collectPriorBotComments` finds our own comments by marker, and both hosts have
 * an edit endpoint for issue comments.
 *
 * ── Why a marker and not "the last comment by our user" ──
 *
 * The token may be a shared bot account, or a human's PAT that also writes
 * ordinary review comments. Editing "the most recent comment by this user"
 * would eventually overwrite something a person wrote. A marker is an explicit
 * claim of ownership over one comment, and nothing else can match it.
 *
 * ── Why the previous body is kept, collapsed ──
 *
 * Replacing the text outright destroys the record of what the review said about
 * an earlier commit, and someone reading a thread of replies to that review is
 * left with responses to text that no longer exists. The previous body is folded
 * into a collapsed `<details>` block instead: current review on top, history one
 * click away, nothing lost. Capped, because a PR reviewed thirty times must not
 * grow an unbounded comment.
 */

/**
 * Identifies the one comment this module owns. Versioned so a future format
 * change can migrate rather than orphan every existing summary.
 */
export const SUMMARY_MARKER = '<!-- repospector-summary-v1 -->';

/** How many previous revisions to keep folded away. */
export const MAX_HISTORY = 3;

/** Only the newest N revisions are kept; older ones are summarised as a count. */
const HISTORY_OPEN = '<details><summary>Previous review';
const HISTORY_RE = /<details><summary>Previous review[\s\S]*?<\/details>/g;

/**
 * Is this comment the persistent summary?
 * @param {string} body
 */
export function isSummaryComment(body) {
    return typeof body === 'string' && body.includes(SUMMARY_MARKER);
}

/**
 * Find our summary among a PR's comments.
 *
 * Takes the OLDEST match, not the newest: if two ever exist (a race between two
 * open tabs, or a version migration), the older one is the one replies are
 * attached to, and consolidating into it preserves the conversation.
 *
 * @param {Array<{id:*, body:string}>} comments
 * @returns {Object|null}
 */
export function findSummaryComment(comments = []) {
    const matches = (comments || []).filter(c => isSummaryComment(c?.body));
    if (!matches.length) return null;
    return matches[0];
}

/**
 * Build the body to write.
 *
 * @param {Object} args
 * @param {string} args.summary - the new summary text
 * @param {string} [args.previousBody] - the existing comment's body, if updating
 * @param {string} [args.headSha] - the commit this review describes
 * @param {number} [args.maxHistory=MAX_HISTORY]
 * @returns {string}
 */
export function buildSummaryBody({ summary, previousBody = null, headSha = null, maxHistory = MAX_HISTORY } = {}) {
    const stamp = headSha
        ? `<sub>Reviewed \`${String(headSha).slice(0, 8)}\` · updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</sub>`
        : '';

    const parts = [SUMMARY_MARKER, String(summary || '').trim()];
    if (stamp) parts.push('', stamp);

    if (previousBody) {
        const history = extractHistory(previousBody, maxHistory);
        if (history) parts.push('', history);
    }

    return parts.join('\n');
}

/**
 * Fold the previous body into the collapsed history block.
 *
 * The previous body already contains its own history block, so the new one is
 * built from: the previous body's CURRENT section, wrapped, followed by the
 * previous body's existing (already-wrapped) revisions, trimmed to the cap.
 */
function extractHistory(previousBody, maxHistory) {
    const body = String(previousBody);

    // Pull out the already-folded revisions first, so the remaining text is the
    // section that WAS current.
    const older = body.match(HISTORY_RE) || [];
    let current = body.replace(HISTORY_RE, '').replace(SUMMARY_MARKER, '').trim();

    if (!current) return older.slice(0, maxHistory - 1).join('\n\n') || '';

    // A previously-stamped revision names its own commit; reuse that label so the
    // history reads as a list of commits rather than of anonymous edits.
    const shaMatch = current.match(/Reviewed `([0-9a-f]{6,})`/i);
    const label = shaMatch ? ` of \`${shaMatch[1]}\`` : '';

    // Trim: a PR reviewed thirty times must not grow an unbounded comment.
    if (current.length > 6000) current = `${current.slice(0, 6000)}\n\n_…truncated._`;

    const wrapped = `${HISTORY_OPEN}${label}</summary>\n\n${current}\n\n</details>`;
    const kept = [wrapped, ...older].slice(0, maxHistory);

    const dropped = older.length + 1 - kept.length;
    return dropped > 0
        ? `${kept.join('\n\n')}\n\n<sub>${dropped} older revision(s) not kept.</sub>`
        : kept.join('\n\n');
}

/**
 * Decide what to do with a summary, given the PR's existing comments.
 *
 * Pure, so the decision is testable without a network: the caller performs
 * whichever action comes back.
 *
 * @param {Object} args
 * @param {string} args.summary
 * @param {Array} [args.comments] - existing PR comments (needs {id, body})
 * @param {string} [args.headSha]
 * @param {boolean} [args.enabled=true] - false reproduces the old post-every-time
 *        behaviour, for anyone who wants a comment per run
 * @returns {{action:'create'|'update', commentId:*, body:string}}
 */
export function planSummary({ summary, comments = [], headSha = null, enabled = true } = {}) {
    if (!enabled) {
        // No marker either: an unmarked comment will never be picked up for
        // editing later, which is what "a comment per run" means.
        return { action: 'create', commentId: null, body: String(summary || '').trim() };
    }

    const existing = findSummaryComment(comments);

    if (!existing) {
        return {
            action: 'create',
            commentId: null,
            body: buildSummaryBody({ summary, headSha }),
        };
    }

    return {
        action: 'update',
        commentId: existing.id,
        body: buildSummaryBody({ summary, previousBody: existing.body, headSha }),
    };
}

export default {
    SUMMARY_MARKER,
    isSummaryComment,
    findSummaryComment,
    buildSummaryBody,
    planSummary,
};

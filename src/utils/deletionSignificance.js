/**
 * deletionSignificance — which removals are behaviour changes, and which are
 * genuinely nothing to review. P1-1.
 *
 * `stripDeletionOnlyHunks` (pr-agent's `handle_patch_deletions`) rests on a
 * claim that is true most of the time and catastrophic the rest of it: "a hunk
 * that only removes lines has nothing to review". Deleting an authorization
 * check, a rollback, a resource cleanup, an exported symbol or the only test
 * covering a branch is a behaviour change — often the most consequential one in
 * the merge request — and the reviewer never saw it, because the hunk was
 * stripped before the prompt was built and the prompt then told the model never
 * to report against a removed line.
 *
 * So removals are classified rather than assumed. A removal that matches a
 * behavioural signal is KEPT and reviewable; everything else is still stripped,
 * which is what keeps the token saving on the refactors and file moves the
 * original guard was written for.
 *
 * The signals are deliberately conservative. A false "significant" costs a few
 * hundred tokens; a false "insignificant" costs the finding entirely, and does
 * so invisibly.
 */

/** A removed line that is only a comment or blank carries no behaviour. */
function isInert(text) {
    const t = String(text ?? '').trim();
    if (!t) return true;
    return /^(\/\/|\/\*|\*|#|--|<!--)/.test(t);
}

/**
 * Signals, each with the reason it is worth the tokens.
 *
 * `test` is present as a matter of policy, not correctness: deleting the only
 * test for a branch does not change production behaviour, but it removes the
 * evidence that the behaviour still holds, and a reviewer wants to be asked
 * about it.
 */
export const DELETION_SIGNALS = Object.freeze([
    {
        name: 'authorization',
        why: 'an access-control or authentication check was removed',
        re: /\b(authoriz\w*|authentic\w*|permission|isAdmin|hasRole|hasPermission|hasScope|canAccess|requireAuth|checkAuth|ensureAuth|acl|rbac|verifyToken|verifySignature|csrf|sameOrigin)\b/i,
    },
    {
        name: 'validation',
        why: 'input validation or sanitisation was removed',
        re: /\b(validate\w*|validator|sanitiz\w*|escapeHtml|isValid|schema\.(parse|validate)|zod|joi\.|yup\.|assertValid|checkArgs)\b/i,
    },
    {
        name: 'error-path',
        why: 'a thrown error or rejection was removed, so a failure now passes silently',
        re: /\b(throw|reject|raise|panic|fatal|abort)\b/,
    },
    {
        name: 'cleanup',
        why: 'a resource release was removed, which leaks it',
        re: /\b(close|dispose|destroy|release|unsubscribe|removeEventListener|removeListener|clearTimeout|clearInterval|clearImmediate|cancelAnimationFrame|revokeObjectURL|shutdown|teardown|cleanup|finally)\b/i,
    },
    {
        name: 'transaction',
        why: 'transaction or lock handling was removed, which risks partial writes',
        re: /\b(commit|rollback|beginTransaction|begin_transaction|savepoint|transaction|mutex|semaphore|acquireLock|releaseLock|withLock)\b/i,
    },
    {
        name: 'exported-api',
        why: 'a symbol other code may import was removed',
        re: /^\s*(export\s|export$|module\.exports|exports\.[A-Za-z_$]|public\s+(static\s+)?[A-Za-z_$]|@Public\b)/,
    },
    {
        name: 'test',
        why: 'a test was removed, so the behaviour it pinned is no longer covered',
        re: /^\s*(it|test|describe|context|scenario)\s*[.(]|^\s*(def\s+test_|func\s+Test[A-Z])|\b(expect|assert\w*|should\.)\s*\(/,
    },
    {
        name: 'secrets-and-crypto',
        why: 'a cryptographic or secret-handling step was removed',
        re: /\b(encrypt\w*|decrypt\w*|hmac|createHash|pbkdf2|bcrypt|scrypt|nonce|salt|signRequest|verifySignature)\b/i,
    },
    {
        name: 'rate-limiting',
        why: 'a throttle or quota check was removed',
        re: /\b(rateLimit\w*|throttle|debounce|quota|backoff|retryLimit|circuitBreaker)\b/i,
    },
    {
        name: 'null-check',
        why: 'a null or undefined guard was removed',
        re: /([!=]==?\s*(null|undefined|nil|None))|(\?\?)|\bisNil\b|\bisNullOrUndefined\b/,
    },
]);

/**
 * A guard clause needs both halves to be a guard: an `if` on its own is
 * ordinary control flow, and treating every removed `if` as significant would
 * keep almost every deletion hunk and give back the whole token saving.
 */
const GUARD_CONDITION = /^\s*(if|else\s+if|unless|guard|when)\s*[\s(]/;
const GUARD_CONSEQUENCE = /\b(throw|return|reject|continue|break|exit|abort|raise|panic|die|halt)\b/;

/**
 * Classify a set of removed lines.
 *
 * @param {string[]} removedLines - the text of the removed lines, WITHOUT the
 *   leading `-`.
 * @returns {{significant: boolean, signals: Array<{name:string, why:string, line:string}>}}
 */
export function classifyRemovedLines(removedLines = []) {
    const lines = (Array.isArray(removedLines) ? removedLines : [])
        .map((l) => String(l ?? ''))
        .filter((l) => !isInert(l));

    const signals = [];
    const seen = new Set();

    for (const line of lines) {
        for (const signal of DELETION_SIGNALS) {
            if (seen.has(signal.name)) continue;
            if (!signal.re.test(line)) continue;
            seen.add(signal.name);
            signals.push({ name: signal.name, why: signal.why, line: line.trim().slice(0, 200) });
        }
    }

    if (!seen.has('guard')) {
        const condition = lines.find((l) => GUARD_CONDITION.test(l));
        if (condition && lines.some((l) => GUARD_CONSEQUENCE.test(l))) {
            signals.push({
                name: 'guard',
                why: 'a guard clause was removed, so a case it rejected now proceeds',
                line: condition.trim().slice(0, 200),
            });
        }
    }

    return { significant: signals.length > 0, signals };
}

/**
 * Classify a whole hunk given its raw diff lines (`-`/`+`/context, headers
 * included). Only the removed lines are consulted; a hunk with additions is not
 * this module's business, since it is never stripped in the first place.
 */
export function classifyDeletionHunk(hunkLines = []) {
    const removed = (Array.isArray(hunkLines) ? hunkLines : [])
        .filter((l) => typeof l === 'string' && l.startsWith('-') && !l.startsWith('---'))
        .map((l) => l.slice(1));
    return classifyRemovedLines(removed);
}

/** One line naming why a removal was kept, for the prompt and the report. */
export function describeDeletionSignals(signals = []) {
    if (!signals.length) return '';
    const names = [...new Set(signals.map((s) => s.name))];
    return names.join(', ');
}

export default {
    DELETION_SIGNALS,
    classifyRemovedLines,
    classifyDeletionHunk,
    describeDeletionSignals,
};

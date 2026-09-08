/**
 * What each task needs from a model, and why a provider cannot do it.
 *
 * The numbers are context requirements, not quality judgements. A provider
 * fails a task here only because the prompt would not fit — which is the one
 * failure mode that is invisible at the call site, because the API truncates
 * and answers anyway.
 */

import { effectiveContextTokens } from './providerCapabilities.js';

export const TASKS = Object.freeze({
    FILE_SUMMARY: 'file_summary',
    COMMIT_MESSAGE: 'commit_message',
    LABEL_GENERATION: 'label_generation',
    DOCSTRING: 'docstring',
    SINGLE_FILE_CHAT: 'single_file_chat',
    PR_REVIEW: 'pr_review',
    MULTI_PASS_AUDIT: 'multi_pass_audit',
    REPO_CHAT: 'repo_chat',
});

/**
 * Minimum usable input context per task, in tokens.
 *
 * Cheap tasks see one file or one hunk. The expensive three see a diff plus
 * retrieved context plus graph neighbours, which is why they sit an order of
 * magnitude higher.
 */
export const TASK_MIN_CONTEXT_TOKENS = Object.freeze({
    [TASKS.FILE_SUMMARY]: 4096,
    [TASKS.COMMIT_MESSAGE]: 2048,
    [TASKS.LABEL_GENERATION]: 2048,
    [TASKS.DOCSTRING]: 2048,
    [TASKS.SINGLE_FILE_CHAT]: 4096,
    [TASKS.PR_REVIEW]: 40960,
    [TASKS.MULTI_PASS_AUDIT]: 40960,
    [TASKS.REPO_CHAT]: 32768,
});

/** Tokens → "6k", for copy. */
function toK(tokens) {
    return `${Math.round(tokens / 1024)}k`;
}

export function isTaskSupported(provider, task, liveQuota = null) {
    const ceiling = effectiveContextTokens(provider, liveQuota);
    if (ceiling === null) return true;              // unconstrained provider
    const need = TASK_MIN_CONTEXT_TOKENS[task];
    // An unknown task has no declared requirement. Permit it: a new task that
    // silently stops working is worse than one that is merely unmeasured.
    if (typeof need !== 'number') return true;
    return ceiling >= need;
}

/**
 * Why the task is disabled, phrased for a tooltip. Null when it is not.
 *
 * Quotes the live ceiling rather than a literal so the sentence stays true if
 * Chrome changes the quota.
 */
export function taskGateReason(provider, task, liveQuota = null) {
    if (isTaskSupported(provider, task, liveQuota)) return null;
    const ceiling = effectiveContextTokens(provider, liveQuota);
    const need = TASK_MIN_CONTEXT_TOKENS[task];
    return `needs ~${toK(need)} context, this model has ${toK(ceiling)}`;
}

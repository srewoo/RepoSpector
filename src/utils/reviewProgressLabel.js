/**
 * reviewProgressLabel — map a review-pipeline progress event to the short phase
 * label the on-page indicator shows.
 *
 * Lives in its own module so the content script and its test share ONE
 * implementation. Inlining it on the content-script class meant the test had to
 * re-declare the mapping, which makes the test pass by construction and blind to
 * drift — the same duplicate-logic trap `patchLines` was created to close.
 *
 * Ordering matters: indexing is checked first because a first review now blocks
 * on it, and it is the phase most likely to be mistaken for a hang.
 */

/**
 * @param {object|null} event - a `PR_REVIEW_PROGRESS` payload
 * @returns {string|null} label, or null when the event should not change the phase
 */
export function phaseLabelFor(event) {
    if (!event || typeof event !== 'object') return null;

    if (event.step === 'indexing' || event.phase === 'indexing') {
        // Indexing gave up; the review continues without repo context, so stop
        // claiming to index. The review output states the degradation separately.
        if (event.failed) return 'Reviewing';
        const { current, total } = event;
        if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
            return `Indexing ${current}/${total}`;
        }
        return 'Indexing';
    }

    if (event.step === 'partial_review') return 'Reviewing (partial)';
    if (event.phase === 'verifying') return 'Verifying';
    if (event.phase === 'finding') return 'Finding';
    if (event.phase === 'scoring') return 'Scoring';
    if (event.step === 'deep_review' || event.phase === 'reviewing') return 'Reviewing';

    return null;
}

export default { phaseLabelFor };

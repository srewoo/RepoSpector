/**
 * feedbackFooter — the flywheel.
 *
 * Every inline comment RepoSpector posts carries a marker-delimited task list.
 * The author ticks one box; on the NEXT review run the collector reads the tick
 * plus any thread replies back out and turns it into a labelled example.
 *
 * Why this matters more than any prompt change: RepoSpector runs on the user's
 * own model. It cannot out-model a hosted competitor. The one thing it can have
 * that they cannot is ground truth from *this* team on *this* code — which
 * findings they accepted, which they rejected, and why. That is what
 * `ConventionMiner` and `AdaptiveLearningService` need and have never been fed.
 *
 * Ported from pr-agent's `pr_agent/feedback/{options,renderer,parser}.py`,
 * including its hard-won details:
 *
 *   - `optionKey` strings are IMMUTABLE. To retire an option set
 *     `isActive: false`; the entry stays in the registry forever so the parser
 *     can still resolve ticks on comments posted years ago.
 *   - The renderer is idempotent — a body already carrying the marker is
 *     returned unchanged.
 *   - Blank lines between blocks are load-bearing. GitLab's task-list extension
 *     only makes checkboxes interactive when the list parses as its own block;
 *     tight paragraph→list coupling silently demotes them to static glyphs.
 */

/**
 * Marker delimiting the footer. Immutable — see the module note.
 * Distinct from `REPOSPECTOR_MARKER` in commentDedupe.js: that one identifies
 * authorship, this one identifies the start of the parseable footer region.
 */
export const FEEDBACK_MARKER = '<!-- repospector-feedback-v1 -->';

/**
 * @typedef {Object} FeedbackOption
 * @property {string} optionKey        - immutable identity
 * @property {string} label            - rendered text; also the parse key
 * @property {boolean} requiresReasoning
 * @property {number} displayOrder
 * @property {boolean} isActive
 * @property {number} weight           - training signal: +1 accepted, -1 rejected, 0 neutral
 */

/** @type {FeedbackOption[]} */
const OPTIONS = [
    {
        optionKey: 'valid_will_fix',
        label: 'Valid — will fix',
        requiresReasoning: false,
        displayOrder: 1,
        isActive: true,
        weight: 1,
    },
    {
        optionKey: 'valid_wont_fix',
        label: "Valid — won't fix (reply with explanation)",
        requiresReasoning: true,
        displayOrder: 2,
        isActive: true,
        // Correct finding, deliberate non-action. Not a precision failure, so it
        // must not train the rule down the way a false positive does.
        weight: 0,
    },
    {
        optionKey: 'invalid_wrong_context',
        label: 'Invalid — false positive: wrong context (reply with explanation)',
        requiresReasoning: true,
        displayOrder: 3,
        isActive: true,
        weight: -1,
    },
    {
        optionKey: 'invalid_outdated_rule',
        label: 'Invalid — false positive: outdated rule (reply with explanation)',
        requiresReasoning: true,
        displayOrder: 4,
        isActive: true,
        weight: -1,
    },
    {
        optionKey: 'needs_discussion',
        label: 'Needs discussion',
        requiresReasoning: false,
        displayOrder: 5,
        isActive: true,
        weight: 0,
    },
];

/** Every registered option, including retired ones. */
export function allOptions() {
    return [...OPTIONS];
}

/** Active options in display order — what the renderer emits. */
export function activeOptions() {
    return OPTIONS.filter(o => o.isActive).sort((a, b) => a.displayOrder - b.displayOrder);
}

export function lookupOption(optionKey) {
    return OPTIONS.find(o => o.optionKey === optionKey) || null;
}

export function lookupOptionByLabel(label) {
    const norm = String(label ?? '').trim();
    return OPTIONS.find(o => o.label === norm) || null;
}

/**
 * Append the feedback footer to a comment body.
 * Idempotent: a body already carrying the marker is returned unchanged.
 *
 * @param {string} body
 * @param {Object} [options]
 * @param {string} [options.findingId] - embedded in a second HTML comment so the
 *        collector can tie a tick back to the exact finding that produced it,
 *        rather than re-deriving identity from file+line (which drifts on push).
 */
export function attachFeedbackFooter(body, options = {}) {
    const base = String(body ?? '');
    if (base.includes(FEEDBACK_MARKER)) return base;

    const { findingId = null } = options;

    const lines = [
        FEEDBACK_MARKER,
        ...(findingId ? [`<!-- repospector-finding-id: ${findingId} -->`] : []),
        '',
        '---',
        '',
        '**Author response (tick exactly one):**',
        '',
    ];

    for (const opt of activeOptions()) lines.push(`- [ ] ${opt.label}`);

    lines.push('');
    lines.push(
        '*Use **Reply** on this thread to add context — replies are collected as ' +
        'part of the feedback signal and used to tune future reviews.*'
    );

    const footer = lines.join('\n');
    const sep = base && !base.endsWith('\n\n') ? '\n\n' : '';
    return `${base}${sep}${footer}`;
}

const TICK_RE = /^\s*-\s*\[[xX]\]\s+(.+?)\s*$/gm;
const FINDING_ID_RE = /<!--\s*repospector-finding-id:\s*([^\s>]+)\s*-->/;

/**
 * @typedef {Object} ParsedFeedback
 * @property {string|null} optionKey
 * @property {boolean} multiTicked   - two or more boxes ticked; caller should skip
 * @property {boolean} unknownLabel  - ticked text not in the registry
 * @property {string|null} findingId
 */

/**
 * Parse a comment body's footer for the ticked option.
 *
 * Tolerant by design — every ambiguous case resolves to `optionKey: null` with a
 * flag set, so the caller can log and skip rather than record a wrong label.
 *
 * @param {string} body
 * @returns {ParsedFeedback}
 */
export function parseFeedback(body) {
    const empty = { optionKey: null, multiTicked: false, unknownLabel: false, findingId: null };
    if (!body || typeof body !== 'string' || !body.includes(FEEDBACK_MARKER)) return empty;

    const idMatch = body.match(FINDING_ID_RE);
    const findingId = idMatch ? idMatch[1] : null;

    const footer = body.slice(body.indexOf(FEEDBACK_MARKER) + FEEDBACK_MARKER.length);

    const ticked = [];
    TICK_RE.lastIndex = 0;
    let m;
    while ((m = TICK_RE.exec(footer)) !== null) ticked.push(m[1].trim());

    if (ticked.length === 0) return { ...empty, findingId };
    if (ticked.length > 1) return { optionKey: null, multiTicked: true, unknownLabel: false, findingId };

    const opt = lookupOptionByLabel(ticked[0]);
    if (!opt) return { optionKey: null, multiTicked: false, unknownLabel: true, findingId };

    return { optionKey: opt.optionKey, multiTicked: false, unknownLabel: false, findingId };
}

/**
 * Strip the footer from a body — used when comparing a prior comment's text to a
 * new finding, so the boilerplate options don't inflate the similarity score.
 */
export function stripFeedbackFooter(body) {
    const s = String(body ?? '');
    const i = s.indexOf(FEEDBACK_MARKER);
    return i < 0 ? s : s.slice(0, i).trimEnd();
}

export default {
    FEEDBACK_MARKER,
    allOptions,
    activeOptions,
    lookupOption,
    lookupOptionByLabel,
    attachFeedbackFooter,
    parseFeedback,
    stripFeedbackFooter,
};

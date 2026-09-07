/**
 * reviewProvenance — tell the reader what this review looked at, and who found
 * what.
 *
 * Every policy added recently reported itself to `console.log` and to
 * `reviewQuality`, and neither is read by the person the review is for:
 *
 *   filterMode   "Findings scoped to lines this PR added" — the stated promise
 *                that was the entire justification for naming the scope
 *   failLevel    why the review did or did not request changes
 *   callBudget   which passes were skipped when the ceiling was hit
 *   external     that a finding came from the team's own CodeQL, not from us
 *
 * A guarantee nobody can see is not a guarantee, it is a comment in a source
 * file. This renders them into the summary comment.
 *
 * ── Why one block, at the bottom, in <sub> ──
 *
 * These are provenance, not findings. Put them at the top and every review opens
 * with three lines of machinery before the reader reaches the defect they came
 * for; leave them out and the reader cannot distinguish "clean" from "out of
 * scope". Bottom, small, and only when there is something to say — the same
 * shape `renderPolicyNote` already established, so the summary keeps one voice.
 *
 * Every function returns '' when it has nothing to say, so callers concatenate
 * unconditionally.
 */

import { describeFilterMode } from './findingFilterMode.js';
import { describeFailLevel } from './failLevel.js';

/**
 * The external-scanner section: which of the team's own tools were read.
 *
 * Rendered whenever a source was CONSULTED, including failures. A review that
 * silently lost its CodeQL findings looks identical to one where CodeQL found
 * nothing, and the second is a far stronger claim than the first.
 *
 * @param {Object} externalFindings - reviewQuality.externalFindings
 * @returns {string}
 */
export function renderExternalSection(externalFindings) {
    const sources = externalFindings?.sources || [];
    if (!sources.length) return '';

    const ok = sources.filter(s => s.ok);
    const failed = sources.filter(s => !s.ok);
    const total = ok.reduce((n, s) => n + (s.findings || 0), 0);

    const lines = [];

    if (total > 0) {
        const tools = [...new Set(ok.flatMap(s => s.tools || []).filter(Boolean))];
        lines.push(
            `### From your own scanners`,
            '',
            `${total} finding(s) below came from ${tools.length ? tools.join(', ') : 'your CI'}, `
            + `not from this review's model. Each links to its own rule where the tool provides one.`,
        );
    }

    // A failed source is the more important half of this block.
    if (failed.length) {
        lines.push('', ...failed.map(s => `- ⚠️ **${s.name}** could not be read: ${s.error}`));
        if (total === 0) {
            lines.unshift(
                '### External scanner findings unavailable',
                '',
                'This review did not include findings from your own tools, because:',
            );
        }
    }

    return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * The code-graph section: what the graph checked, what it found, what it cut.
 *
 * A clean check is stated positively — "no incompatible signature changes" is
 * information a reviewer acts on, and it is invisible if only findings render.
 *
 * @param {{stats: Object, rules: Object}|null} graphFindings
 * @returns {string}
 */
export function renderGraphSection(graphFindings) {
    const s = graphFindings?.stats;
    if (!s || !s.symbols) return '';

    const found = [];
    if (s.signatureChanges) found.push(`${s.signatureChanges} signature change(s) with callers outside this PR`);
    if (s.escalations) found.push(`${s.escalations} widely-used symbol(s) flagged for a human`);
    if (s.untested) found.push(`${s.untested} untested dependency set(s)`);

    const lines = [
        '### From the code graph',
        '',
        `${s.symbols} changed symbol(s) were checked against the repository's call graph and test-coverage edges. `
        + (found.length
            ? `Found: ${found.join('; ')}. These findings are facts read from the graph, not model judgement.`
            : 'Found no incompatible signature changes, no untested dependents, and no high-risk symbols.'),
    ];
    if (s.capped) lines.push('', `Note: only the first findings by severity are shown; the rest were cut by the per-review cap.`);
    return `${lines.join('\n')}\n`;
}

/**
 * The provenance footnote: scope, merge gate, and any pass the budget cut.
 *
 * @param {Object} reviewQuality - the review's reviewQuality block
 * @returns {string}
 */
export function renderProvenanceNote(reviewQuality) {
    if (!reviewQuality) return '';

    const bits = [];

    // Scope first: it bounds everything else the review says.
    const scope = reviewQuality.filterModeNote
        || (reviewQuality.filterMode ? describeFilterMode(reviewQuality.filterMode) : '');
    if (scope) bits.push(scope.replace(/\.$/, ''));

    const gate = reviewQuality.failLevelNote
        || (reviewQuality.failLevel ? describeFailLevel(reviewQuality.failLevel) : '');
    if (gate) bits.push(gate.replace(/\.$/, ''));

    // Only when it actually got in the way — `describeIfConstrained` is already
    // '' otherwise, and announcing an unhit ceiling is noise.
    if (reviewQuality.callBudgetNote) bits.push(reviewQuality.callBudgetNote.replace(/\.$/, ''));

    // A setting that had no effect is worth one line: a reviewer who turned
    // something on and saw nothing happen should be able to find out why here
    // rather than by reading the source.
    const enforced = reviewQuality.configEnforced || [];
    if (enforced.length) {
        bits.push(`\`${enforced.join('`, `')}\` set by organization policy`);
    }

    if (!bits.length) return '';
    return `<sub>${bits.join(' · ')}.</sub>`;
}

/**
 * How much of each file the reviewer actually saw.
 *
 * Separate from the note above because it is a statement about CONTEXT rather
 * than policy, and because it is the one line that tells a reader whether a
 * "looks fine" on a 2,000-line file was informed. Only rendered when the review
 * genuinely had less than the whole picture.
 *
 * @param {Object} reviewQuality
 * @returns {string}
 */
export function renderContextNote(reviewQuality) {
    const ext = reviewQuality?.externalFindings;
    const omitted = reviewQuality?.filterMode?.droppedUnknownFile;

    const bits = [];

    if (reviewQuality?.repoContextAvailable === false) {
        bits.push('reviewed without repository context (retrieval and code graph unavailable)');
    }
    if (omitted) {
        bits.push(`${omitted} finding(s) referenced files outside this PR and were not reported`);
    }
    if (ext && ext.stats?.failed) {
        bits.push(`${ext.stats.failed} external scanner source(s) unreadable`);
    }

    if (!bits.length) return '';
    return `<sub>⚠️ ${bits.join('; ')}.</sub>`;
}

export default { renderExternalSection, renderProvenanceNote, renderContextNote };

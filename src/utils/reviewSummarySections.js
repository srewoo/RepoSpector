/**
 * reviewSummarySections — how the summary comment is written.
 *
 * Split out of `reviewPostingPolicy`, which had grown two distinct jobs: DECIDING
 * what gets posted (severity floors, confidence and score gates, the inline cap)
 * and RENDERING what did not go inline into markdown sections. Those change for
 * unrelated reasons — a new gate is a policy question, a new section is a
 * presentation one — and the file was over the 300-line ceiling with both in it.
 *
 * Every function here returns '' when it has nothing to say, so callers can
 * concatenate unconditionally without guarding each one.
 */

import { findingPath, findingLine } from './inlineCommentFormatter.js';

/** One summary bullet: `path:line — headline` plus an optional rationale. */
function renderBullet(f) {
    const path = findingPath(f);
    const line = findingLine(f);
    const loc = path ? (line != null ? `\`${path}:${line}\`` : `\`${path}\``) : '_(no location)_';

    const headline = String(f.title || f.message || f.description || 'Issue')
        .split('\n')[0]
        .trim();

    // Rationale only when it says something the headline didn't.
    const detail = String(f.suggestion || f.description || f.message || '')
        .split('\n')[0]
        .trim();

    const rule = f.rule || f.ruleId;
    const ruleTag = rule ? ` \`${rule}\`` : '';

    const tail = detail && detail !== headline ? ` — ${detail}` : '';
    return `- ${loc}${ruleTag} — ${headline}${tail}`;
}

/**
 * Render the demoted findings as the `### Suggestions` / `### Nitpicks`
 * sections that get appended to the summary comment.
 *
 * Returns '' when there is nothing to render, so the caller can concatenate
 * unconditionally.
 *
 * @param {Array<Object>} suggestions
 * @param {Array<Object>} nitpicks
 * @param {Object} [options]
 * @param {number} [options.maxPerSection=40] - keeps the comment under GitHub's
 *        65 536-character body limit on pathological reviews.
 */
export function renderDeferredSections(suggestions = [], nitpicks = [], options = {}) {
    const { maxPerSection = 40 } = options;
    const out = [];

    const section = (title, items) => {
        if (!items.length) return;
        out.push('', `### ${title}`, '');
        for (const f of items.slice(0, maxPerSection)) out.push(renderBullet(f));
        if (items.length > maxPerSection) {
            out.push(`- _…and ${items.length - maxPerSection} more (see the RepoSpector panel)._`);
        }
    };

    section('Suggestions', suggestions);
    section('Nitpicks', nitpicks);

    return out.join('\n');
}

/**
 * Render the escalation section — the questions a human has to answer.
 *
 * Kept separate from Suggestions and Nitpicks on purpose. Those are things the
 * reviewer believes are wrong; these are things it could not determine. Merging
 * them trains readers to skim both, and the escalations are the half that
 * actually needs a person.
 *
 * Grouped by expertise so the section doubles as routing: a reader scanning for
 * "Security" sees the two questions meant for them without reading the rest.
 *
 * @param {Array<Object>} escalations
 * @param {Object} [options]
 * @param {number} [options.maxItems=20]
 */
export function renderEscalationSection(escalations = [], options = {}) {
    const { maxItems = 20 } = options;
    if (!escalations.length) return '';

    const byExpertise = new Map();
    for (const f of escalations.slice(0, maxItems)) {
        const key = f.escalation?.expertise || f.expertise || 'domain';
        if (!byExpertise.has(key)) byExpertise.set(key, []);
        byExpertise.get(key).push(f);
    }

    const out = [
        '',
        '### Needs a human decision',
        '',
        '_These could not be settled from the diff. They are open questions, not defects._',
        '',
    ];

    for (const [expertise, items] of byExpertise) {
        const label = expertise.charAt(0).toUpperCase() + expertise.slice(1);
        out.push(`**${label}**`);
        for (const f of items) {
            const loc = findingPath(f)
                ? `\`${findingPath(f)}${findingLine(f) != null ? `:${findingLine(f)}` : ''}\` — `
                : '';
            const reason = f.escalation?.reason || f.escalationReason || f.title || '';
            out.push(`- ${loc}${reason}`);
        }
        out.push('');
    }

    if (escalations.length > maxItems) {
        out.push(`- _…and ${escalations.length - maxItems} more (see the RepoSpector panel)._`);
    }

    return out.join('\n');
}

/**
 * Human-readable one-liner for the summary footer, so a reviewer can tell that
 * silence on a line is a policy decision rather than the tool missing things.
 */
export function renderPolicyNote(stats) {
    if (!stats) return '';
    const bits = [];
    if (stats.demotedToSummary) bits.push(`${stats.demotedToSummary} non-blocking finding(s) listed above rather than posted inline`);
    if (stats.droppedBySeverityFloor) bits.push(`${stats.droppedBySeverityFloor} below the configured severity floor`);
    if (stats.droppedByConfidence) bits.push(`${stats.droppedByConfidence} below the confidence floor`);
    if (stats.droppedByScore) bits.push(`${stats.droppedByScore} below the value-score floor`);
    if (stats.suppressedAsDuplicate) bits.push(`${stats.suppressedAsDuplicate} already commented on`);
    if (!bits.length) return '';
    return `<sub>Only blocking findings are posted inline — ${bits.join('; ')}.</sub>`;
}

export default { renderDeferredSections, renderEscalationSection, renderPolicyNote };

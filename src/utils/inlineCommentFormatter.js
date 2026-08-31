/**
 * inlineCommentFormatter — turn review findings into host-ready inline comments.
 *
 * This is the last mile of the review: the only part a reviewer actually reads on
 * the PR. It previously required `f.filePath`, a key only static-analysis findings
 * carry, so every LLM finding was silently filtered out and the posted review was
 * 100% regex lint. Producers disagree on shape, so normalize here rather than
 * asking every producer to conform:
 *
 *   static analysis            -> { filePath, line, severity, message, ruleId, tool }
 *   LLM per-file engine        -> [{ file, findings: [{ file?, line, severity, ... }] }]
 *   orchestrator adapter       -> { file, line, severity, title, message, codeSnippet }
 *   verified/post-processed    -> { file, line, severity, title, description,
 *                                   suggestion, rule, evidence, suggestedFix }
 *
 * Also enforces the two host rules that silently break posting:
 *   1. a comment must target a line present in the diff (else GitHub 422s the
 *      whole review) — see `patchLines.commentableLines`;
 *   2. one comment per line reads as noise — near-duplicates are merged.
 */

import { liftEngineFindings } from '../services/engineContract.js';
import { snapToCommentableLine } from './patchLines.js';
import { withMarker } from './commentDedupe.js';
import { attachFeedbackFooter } from './feedbackFooter.js';
import { relocationNote } from './findingFilterMode.js';

/** Canonical severities (blocking/suggestion/nitpick) mapped onto legacy names. */
const SEVERITY_ALIAS = {
    blocking: 'high',
    suggestion: 'medium',
    nitpick: 'low',
    critical: 'critical',
    high: 'high',
    medium: 'medium',
    low: 'low',
    info: 'low',
    warning: 'medium',
    error: 'high',
};

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
const SEVERITY_EMOJI = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };

/** Read a finding's file path regardless of which producer emitted it. */
export function findingPath(f) {
    return f?.file || f?.filePath || f?.path || null;
}

/** Read a finding's severity, normalized to critical|high|medium|low. */
export function findingSeverity(f) {
    const raw = String(f?.severity || '').toLowerCase();
    return SEVERITY_ALIAS[raw] || 'medium';
}

/** Read a finding's line as a positive integer, or null. */
export function findingLine(f) {
    const n = parseInt(f?.line ?? f?.lineNumber ?? f?.startLine, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Strip surrounding blank lines but PRESERVE leading indentation — a
 * ```suggestion block replaces the target line verbatim, so trimming the indent
 * would commit wrongly-indented code the moment someone clicks "Apply".
 */
function trimBlankLines(code) {
    const lines = String(code).split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join('\n');
}

/**
 * Extract the replacement code for a GitHub/GitLab ```suggestion block.
 * FixRecommendationService attaches an object; older paths attach a raw string.
 */
function extractSuggestedCode(f) {
    const fix = f?.suggestedFix;
    if (!fix) return null;
    const raw = typeof fix === 'string'
        ? fix
        : (fix.replacement ?? fix.code ?? fix.patch ?? fix.suggestion);
    if (typeof raw !== 'string' || !raw.trim()) return null;

    // A model that ignores "no code fences" would otherwise nest fences and
    // break the suggestion block entirely.
    const unfenced = raw.replace(/^\s*```[a-zA-Z0-9]*\n?/, '').replace(/\n?```\s*$/, '');
    const code = trimBlankLines(unfenced);
    return code || null;
}

/**
 * Build the markdown body for one finding.
 *
 * LLM findings carry far more than a one-line message — rationale, a rule
 * citation, evidence, a suggested patch. The old formatter emitted only
 * `severity: message`, discarding all of it. Rendering the full structure is
 * what makes an AI comment more useful than a lint warning.
 */
export function buildCommentBody(f) {
    const severity = findingSeverity(f);
    const emoji = SEVERITY_EMOJI[severity] || '⚪';

    const tool = f.tool ? ` \`${f.tool}\`` : '';
    const rule = f.rule || f.ruleId;
    const ruleInfo = rule ? ` (\`${rule}\`)` : '';

    const headline = (f.title || f.message || f.description || 'Issue').split('\n')[0].trim();

    // A rule id the reader can look up beats one they have to trust. External
    // scanners carry `helpUri`; linking it is the difference between a checkable
    // claim and an assertion. See utils/externalFindings.js.
    const ruleLink = f.ruleUrl && rule ? ` ([\`${rule}\`](${f.ruleUrl}))` : ruleInfo;

    const lines = [`${emoji} **${severity.toUpperCase()}**${tool}${ruleLink}: ${headline}`];

    // Who actually found this. A finding from the team's own CodeQL run should not
    // read as this tool's opinion — the attribution is most of why it is credible.
    if (f.source === 'external' && f.attribution) {
        lines.push('', `_${f.attribution}._`);
    }

    // If the comment is not on the line the finding named, say so. Moving a
    // comment onto a line nobody chose and staying quiet about it is a small
    // dishonesty that compounds. See utils/findingFilterMode.js.
    const moved = relocationNote(f);
    if (moved) lines.push('', moved.trim());

    // Rationale — only when it adds something beyond the headline.
    const detail = (f.description || f.message || '').trim();
    if (detail && detail !== headline) {
        lines.push('', detail);
    }

    // Evidence: the specific code the finding is about.
    const evidence = (f.evidence || f.codeSnippet || '').trim();
    if (evidence && !evidence.includes('```')) {
        lines.push('', '<details><summary>Evidence</summary>', '', '```', evidence, '```', '', '</details>');
    }

    // One-click fix. GitHub renders ```suggestion as an applyable patch; GitLab
    // renders it as a plain block, which is still readable.
    const suggestedCode = extractSuggestedCode(f);
    if (suggestedCode) {
        lines.push('', '```suggestion', suggestedCode, '```');
        const rationale = typeof f.suggestedFix === 'object' ? f.suggestedFix?.rationale : null;
        if (rationale) lines.push('', `_${rationale}_`);
    } else {
        const remediation = (f.suggestion || f.remediation || f.recommendation || '').trim();
        if (remediation && remediation !== detail) {
            lines.push('', `**Fix:** ${remediation}`);
        }
    }

    // Provenance: reviewers trust a comment more when they know what produced it
    // and whether it survived verification.
    const marks = [];
    if (f.source === 'llm') marks.push('AI review');
    else if (f.source === 'static') marks.push('static analysis');
    if (f.verified === true || f.verdict === 'confirmed') marks.push('verified');
    if (f.confidence != null) {
        const pct = f.confidence <= 1 ? Math.round(f.confidence * 100) : Math.round(f.confidence);
        marks.push(`confidence ${pct}%`);
    }
    if (marks.length) lines.push('', `<sub>🛡️ RepoSpector · ${marks.join(' · ')}</sub>`);

    return lines.join('\n');
}

/**
 * Format findings as inline review comments.
 *
 * @param {Array<Object>} findings - any producer shape, flat or per-file nested
 * @param {Object} [options]
 * @param {number} [options.maxInlineComments=30]
 * @param {Map<string,Set<number>>} [options.commentableLines] - from
 *        `patchLines.buildCommentableLineMap(prData.files)`. When supplied,
 *        comments are validated (and snapped) to lines that exist in the diff.
 *        When omitted, validation is skipped for backwards compatibility.
 * @param {number} [options.snapDistance=5]
 * @param {string[]|null} [options.severities] - which severities to post. Pass
 *        `null` to skip the severity filter entirely — the caller has already
 *        decided (see `reviewPostingPolicy.partitionForPosting`, which is now
 *        the authority on inline-vs-summary). The default is kept only for
 *        callers that still format findings directly.
 * @param {boolean} [options.feedbackFooter=false] - append the tick-box footer
 *        that `FeedbackCollectorService` reads back on the next run.
 * @returns {Array<{path:string, line:number, body:string, severity:string, findingId:string|null}>}
 */
export function formatInlineComments(findings, options = {}) {
    const {
        maxInlineComments = 30,
        commentableLines = null,
        snapDistance = 5,
        severities = ['critical', 'high', 'medium'],
        feedbackFooter = false,
    } = options;

    // `null` means "no filter" — distinct from an empty array, which would mean
    // "allow nothing" and silently post zero comments.
    const allowedSeverities = severities == null ? null : new Set(severities);

    // Accept per-file containers as well as flat lists — the multi-pass engine
    // returns containers, and callers used to pass them straight through, which
    // produced zero comments because a container has no line or path.
    const flat = liftEngineFindings(findings || []);

    const candidates = [];
    for (const f of flat) {
        if (!f || typeof f !== 'object') continue;

        const path = findingPath(f);
        const rawLine = findingLine(f);
        if (!path || rawLine == null) continue;

        const severity = findingSeverity(f);
        if (allowedSeverities && !allowedSeverities.has(severity)) continue;

        // Validate against the diff. A finding pointing outside the diff cannot
        // be posted inline; snapping recovers the common off-by-a-few case, and
        // anything further away is dropped (it still appears in the summary).
        let line = rawLine;
        if (commentableLines) {
            const allowed = commentableLines.get(path);
            if (!allowed) continue;
            const snapped = snapToCommentableLine(rawLine, allowed, snapDistance);
            if (snapped == null) continue;
            line = snapped;
        }

        candidates.push({ f, path, line, severity });
    }

    // Highest severity first, so the cap keeps what matters.
    candidates.sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));

    // Collapse duplicates on the same line — multiple finders and the static
    // layer frequently flag the same defect, and N comments on one line reads
    // as noise. Keep the most severe; append the others as sub-bullets.
    const byLocation = new Map();
    for (const c of candidates) {
        const key = `${c.path}:${c.line}`;
        const prev = byLocation.get(key);
        if (!prev) {
            byLocation.set(key, { ...c, extras: [] });
            continue;
        }
        const prevHead = (prev.f.title || prev.f.message || '').trim().toLowerCase();
        const curHead = (c.f.title || c.f.message || '').trim().toLowerCase();
        if (prevHead && prevHead === curHead) continue; // true duplicate
        prev.extras.push(c.f);
    }

    return [...byLocation.values()]
        .slice(0, maxInlineComments)
        .map(({ f, path, line, severity, extras }) => {
            let body = buildCommentBody(f);
            if (extras.length) {
                const also = extras
                    .slice(0, 3)
                    .map(e => `- ${SEVERITY_EMOJI[findingSeverity(e)] || '⚪'} ${(e.title || e.message || '').split('\n')[0]}`)
                    .join('\n');
                body += `\n\n<details><summary>${extras.length} more finding(s) on this line</summary>\n\n${also}\n\n</details>`;
            }

            // Feedback footer BEFORE the authorship marker: `withMarker` prepends,
            // so the marker stays on line 1 where a cheap `startsWith` finds it.
            const findingId = f.id ?? null;
            if (feedbackFooter) body = attachFeedbackFooter(body, { findingId });

            // Every comment we post is stamped, so the next run can recognise it
            // and neither repost it nor mistake it for a human's comment.
            body = withMarker(body);

            return { path, line, body, severity, findingId };
        });
}

export default { formatInlineComments, buildCommentBody, findingPath, findingSeverity, findingLine };

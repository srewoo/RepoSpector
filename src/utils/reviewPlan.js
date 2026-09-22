/**
 * reviewPlan — a cheap structured risk pass before the per-file review.
 *
 * Ported from open-code-review's `plan_task`. The observation behind it: on a
 * large unit a single review call has to notice the risk, hold it, and write it
 * up in one pass, and what it drops it drops silently. Measured on this corpus,
 * one 12-file case returned `0 base` findings — the per-file pass read the whole
 * change and reported nothing at all.
 *
 * Splitting the work makes the first half cheap and explicit: name the risks and
 * rank them, produce no prose, and hand that list to the review call as an
 * agenda. The review still decides what is real — the plan carries no findings
 * and is never reported to the user.
 *
 * Gated on size, because a small diff does not need an agenda and the call is
 * not free. Thresholds mirror OCR's (50 changed lines for a single file, 100 for
 * a multi-file group).
 *
 * Fail-open in every direction: no LLM, a refusal, a timeout or unparseable
 * output all yield '' and the review proceeds exactly as it does today.
 */

import { PRIORITY } from './callBudget.js';

export const PLAN_LINE_THRESHOLD = 50;
export const PLAN_GROUP_LINE_THRESHOLD = 100;

export const PLAN_SYSTEM_PROMPT = `You are planning a code review. You do not perform it.

Analyse the change and produce a ranked list of the risk points a reviewer should check.

## Output format
Plain text, exactly this shape. No preamble, no closing remarks, no markdown headings, no code fences:

Summary: (one sentence on the purpose and scope of this change)

Issues

1. [high|medium|low] (the specific risk: where it is, what could be wrong, and what the consequence would be)
2. [high|medium|low] (...)

## Rules
- Only newly added and modified lines. Ignore deleted code except as context.
- Number continuously, ordered by severity descending (high → medium → low).
- Severity: high = security, data loss, crash, or broken functionality. medium = performance, edge cases, maintainability. low = style or minor best practice.
- Every entry names a location, the nature of the problem, and its impact.
- These are things to CHECK, not defects to report. You are not asserting any of them is real.
- If the change carries no identifiable risk, output the Summary line, then \`Issues\`, then \`(none)\`. Never invent risks to fill the list.`;

/** Added + removed lines across a unit's files. */
export function changedLineCount(unit) {
    let n = 0;
    for (const f of unit?.files ?? []) {
        const patch = f.patch ?? f.diff ?? '';
        for (const line of String(patch).split('\n')) {
            if (/^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)) n++;
        }
    }
    return n;
}

/** Whether this unit is big enough that an agenda earns its call. */
export function shouldPlan(unit, opts = {}) {
    const files = unit?.files?.length ?? 0;
    if (files === 0) return false;
    const threshold = files > 1
        ? (opts.groupThreshold ?? PLAN_GROUP_LINE_THRESHOLD)
        : (opts.threshold ?? PLAN_LINE_THRESHOLD);
    return changedLineCount(unit) >= threshold;
}

/** The planning user prompt: the diffs, and what the change claims to do. */
export function buildPlanPrompt(unit, { prContext } = {}) {
    const diffs = (unit?.files ?? [])
        .map(f => `--- ${f.filename ?? f.path}\n${f.patch ?? f.diff ?? ''}`)
        .join('\n\n');
    return [
        prContext?.title ? `Change title: ${prContext.title}` : '',
        prContext?.purpose ? `Stated purpose: ${prContext.purpose}` : '',
        '',
        diffs,
        '',
        'Produce the review plan for the change above.',
    ].filter(Boolean).join('\n');
}

/**
 * Run the plan pass for one unit.
 *
 * @returns {Promise<string>} the plan text, or '' when it did not run
 */
export async function runReviewPlan({ llmService, unit, settings = {}, prContext, options = {} } = {}) {
    if (!llmService || !shouldPlan(unit, options)) return '';

    try {
        const response = await llmService.streamChat(
            [
                { role: 'system', content: PLAN_SYSTEM_PROMPT },
                { role: 'user', content: buildPlanPrompt(unit, { prContext }) },
            ],
            {
                provider: settings.provider,
                model: settings.model,
                apiKey: settings.apiKey,
                budgetStage: 'review-plan',
                // Never at the cost of the review itself: if the budget is tight
                // the agenda is what should be dropped, not a file's review.
                budgetPriority: PRIORITY.OPTIONAL ?? PRIORITY.ESSENTIAL,
                stream: false,
            },
        );
        const text = String(response?.content ?? response ?? '').trim();
        // A plan that does not have the shape we asked for is not a plan.
        return /Issues/i.test(text) ? text : '';
    } catch {
        return '';
    }
}

export default { runReviewPlan, shouldPlan, changedLineCount, buildPlanPrompt, PLAN_SYSTEM_PROMPT };

/**
 * `priorPrComments` lens — does review feedback already given on these files in
 * recent merged pull requests apply again? Context: those review comments.
 */
import { CONTEXT_STATUS, ctxNotRun } from '../context/contextPort.js';

export const priorPrCommentsLens = Object.freeze({
    key: 'priorPrComments',
    title: 'Prior-review-feedback specialist',
    needs: ['priorPr'],
    instruction: `Hunt ONLY repeats of feedback reviewers already gave on these files in recent
merged pull requests. You are given those review comments and the PR each came from.
- The same mistake a previous reviewer flagged (same pattern, same API misuse, same
  missing guard) appears again in this diff.
- A convention a previous reviewer asked for on this file that this diff breaks.

Hard rules for this lens:
- Cite the prior comment (its PR ref and author) and the diff line where it applies
  again. No cited comment means no finding.
- Feedback about code this diff does not touch is not a finding.`,
});

const clip = (s, n) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * @param {{targets: Array, contextPort: Object, limits: Object}} args
 */
export async function resolvePriorPr({ targets, contextPort, limits }) {
    const reasons = [];
    const sections = await Promise.all(targets.map(async (t) => {
        const res = await contextPort.priorPrComments(t.path, { limitPrs: limits.priorPrLimit });
        if (res?.status !== CONTEXT_STATUS.OK) {
            reasons.push(res?.reason || 'prior PR comments unavailable');
            return null;
        }
        const comments = res.comments || [];
        if (!comments.length) return null;
        const lines = comments.map(c =>
            `- [${c.prRef}] @${c.author || 'unknown'}${c.line ? ` (L${c.line})` : ''}: ${clip(c.body, 300)}`);
        return `### ${t.path}\n${lines.join('\n')}`;
    }));

    const text = sections.filter(Boolean).join('\n\n');
    if (text) return { status: CONTEXT_STATUS.OK, text };
    return ctxNotRun(reasons[0] || 'no prior PR review comments on the changed files');
}

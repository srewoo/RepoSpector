/**
 * `history` lens — does this change undo an earlier fix or break an invariant
 * that earlier commits established? Context: blame of the base-side lines
 * around each changed hunk, plus the file's recent commit messages.
 */
import { CONTEXT_STATUS, ctxNotRun } from '../context/contextPort.js';

export const historyLens = Object.freeze({
    key: 'history',
    title: 'History & regression specialist',
    needs: ['history'],
    instruction: `Hunt ONLY regressions against this file's own history. You are given blame
for the base-side lines around each changed hunk (commit sha, date, message) and the
file's most recent commit messages.
- A change that undoes or weakens an earlier fix: a blamed line or a recent commit
  names a fix (a guard, retry, null check, race, bound, security fix) and this diff
  removes, bypasses or reorders that code.
- A change that breaks an invariant an earlier commit established — ordering, locking,
  validation, a limit — as stated in that commit's message.
- A pattern a recent commit explicitly removed, re-introduced by this diff.

Hard rules for this lens:
- Cite the commit (short sha AND its message) that establishes the fix or invariant,
  and the diff line that undoes it. No cited commit means no finding.
- Old code being changed is not by itself a regression. Report only where the
  history says WHY the code was that way and the diff contradicts that reason.`,
});

const firstLine = (s) => String(s ?? '').split('\n')[0].slice(0, 120);
const short = (sha) => String(sha ?? '').slice(0, 7);

/**
 * @param {{targets: Array, contextPort: Object, baseSha: string|null, limits: Object}} args
 * @returns {Promise<{status:string, text?:string, reason?:string}>}
 */
export async function resolveHistory({ targets, contextPort, baseSha, limits }) {
    // Added files have no base side to blame.
    const withBase = targets.filter(t => t.oldSpan);
    if (!withBase.length) return ctxNotRun('no changed file has base-side lines to blame');

    const reasons = [];
    const sections = await Promise.all(withBase.map(async (t) => {
        const [blame, commits] = await Promise.all([
            contextPort.blame(t.path, { ref: baseSha, startLine: t.oldSpan.start, endLine: t.oldSpan.end }),
            contextPort.recentCommits(t.path, { ref: baseSha, limit: limits.recentCommits }),
        ]);
        const lines = [];
        if (blame?.status === CONTEXT_STATUS.OK) {
            for (const r of blame.ranges || []) {
                lines.push(`- L${r.start}-${r.end} ${short(r.sha)} ${r.date || ''} "${firstLine(r.message)}"`);
            }
        } else {
            reasons.push(blame?.reason || 'blame unavailable');
        }
        if (commits?.status === CONTEXT_STATUS.OK) {
            if (commits.commits?.length) lines.push('Recent commits:');
            for (const c of commits.commits || []) lines.push(`- ${short(c.sha)} ${c.date || ''} ${firstLine(c.message)}`);
        } else {
            reasons.push(commits?.reason || 'commit log unavailable');
        }
        return lines.length ? `### ${t.path} (base ${short(baseSha)})\n${lines.join('\n')}` : null;
    }));

    const text = sections.filter(Boolean).join('\n\n');
    if (!text) return ctxNotRun(reasons[0] || 'no blame or commit history for the changed lines');
    return { status: CONTEXT_STATUS.OK, text };
}

/**
 * `codeComments` lens — does the change violate guidance written in comments
 * near it? Context: every comment within ±radius lines of each changed hunk in
 * the post-change file, with no keyword filter.
 */
import { CONTEXT_STATUS, ctxNotRun } from '../context/contextPort.js';
import { extractComments } from '../context/commentExtractor.js';

export const codeCommentsLens = Object.freeze({
    key: 'codeComments',
    title: 'Code-comment guidance specialist',
    needs: ['comments'],
    instruction: `Hunt ONLY places where this diff violates guidance written in code comments
near the change. You are given the comments within a few dozen lines of each changed
hunk, as they read AFTER the change, with their line numbers.
- A comment states a constraint (must, never, always, do not, keep in sync, order
  matters, not thread-safe, caller holds the lock, units, an invariant) that the
  changed code now breaks.
- A TODO / FIXME / NOTE / WARNING describes a hazard that this diff now triggers.
- A comment says two places must change together, and the diff changes only one.

Hard rules for this lens:
- Quote the comment (with its line number) AND the diff line that violates it.
  No quoted comment means no finding.
- A comment that is merely out of date is not your finding unless the code now
  violates a constraint the comment states.`,
});

/**
 * @param {{targets: Array, contextPort: Object, headSha: string|null, limits: Object}} args
 */
export async function resolveComments({ targets, contextPort, headSha, limits }) {
    const reasons = [];
    const sections = await Promise.all(targets.map(async (t) => {
        if (!t.newLines.length) return null;
        const file = await contextPort.fileContent(t.path, headSha);
        if (file?.status !== CONTEXT_STATUS.OK) {
            reasons.push(file?.reason || 'file content unavailable');
            return null;
        }
        const comments = extractComments(file.text || '', t.path, {
            aroundLines: t.newLines,
            radius: limits.commentRadius,
        });
        if (!comments.length) return null;
        return `### ${t.path}\n${comments.map(c => `L${c.line}: ${c.text}`).join('\n')}`;
    }));

    const text = sections.filter(Boolean).join('\n\n');
    if (text) return { status: CONTEXT_STATUS.OK, text };
    return ctxNotRun(reasons[0] || 'no code comments near the changed lines');
}

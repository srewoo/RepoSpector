/**
 * Prompts for LineQuestionService.
 *
 * The context is ordered by relevance — the line, then its enclosing component,
 * then the diff — and the model is told where each piece came from. The point of
 * saying so is that "I cannot tell from what I was given" becomes an available
 * answer, which is the answer a reviewer can act on when the alternative is a
 * confident guess.
 */

export const LINE_QUESTION_SYSTEM_PROMPT = `You answer a specific question about a specific line of code in a pull request.

You are given: the line itself, the function or class containing it, and the
diff for its file. That is all you can see — there may be callers, tests, and
configuration you were not shown.

Rules:
1. Answer the question that was asked. Do not review the code, do not list
   unrelated issues, do not suggest refactors nobody asked about.
2. Ground every claim in what you were given, and cite line numbers.
3. If the answer depends on code you cannot see, say exactly what you would need
   ("this depends on what validate() does, which is not in the context I have").
   That is a useful answer. A plausible guess presented as fact is not.
4. If the line was NOT changed by this PR, say so before answering — the reader
   usually assumes it was.
5. Be brief. Two or three sentences unless the question genuinely needs more.
   No preamble, no restating the question, no closing summary.

Write prose, not JSON. Markdown is fine for code references.`;

/**
 * @param {string} question
 * @param {Object} ctx - from LineQuestionService.buildContext
 * @returns {string}
 */
export function buildLineQuestionPrompt(question, ctx) {
    let out = `# Question about ${ctx.filename}:${ctx.line}\n\n`;
    out += `**Question:** ${question}\n\n`;

    if (ctx.prTitle) out += `PR: ${ctx.prTitle}\n\n`;

    out += `---\n\n## The line\n\n`;
    if (ctx.lineContent !== null && ctx.lineContent !== undefined) {
        out += `\`\`\`${ctx.language}\n${ctx.line}: ${ctx.lineContent}\n\`\`\`\n\n`;
    } else {
        out += `(The file's content could not be read; only the diff below is available.)\n\n`;
    }

    out += ctx.inDiff
        ? `This line IS part of this PR's diff.\n\n`
        : `**This line is NOT part of this PR's diff** — it is existing code in a changed file. `
          + `Say so in your answer.\n\n`;

    if (ctx.scope) {
        const what = ctx.scope.name
            ? `${ctx.scope.kind || 'Declaration'} \`${ctx.scope.name}\``
            : `Surrounding code`;
        out += `---\n\n## ${what} (lines ${ctx.scope.startLine}-${ctx.scope.endLine})\n\n`;
        out += `Line numbers are real file lines — cite them directly.\n\n`;
        out += `\`\`\`\n${ctx.scope.source}\n\`\`\`\n\n`;
    }

    out += `---\n\n## Diff for this file\n\n`;
    out += `\`\`\`\n${ctx.diff}\n\`\`\`\n\n`;

    out += `---\n\nAnswer the question. Cite line numbers. Say what you cannot determine.\n`;

    return out;
}

export default { LINE_QUESTION_SYSTEM_PROMPT, buildLineQuestionPrompt };

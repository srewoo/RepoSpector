/**
 * LineQuestionService — answer a question about ONE line of a diff.
 *
 * pr-agent has this as `pr_line_questions`, and it is the question people
 * actually ask on a PR: not "review this MR" but "why does line 214 catch
 * Exception here?". `PRThreadManager` already handles follow-up on a FINDING the
 * review produced; this handles a line the review said nothing about.
 *
 * What makes it worth a separate service rather than a chat message with a line
 * number in it: the context is assembled from the line outward, deterministically.
 * The answer sees the enclosing function (via the same declaration-bounded
 * expansion the review uses), the file, and the diff — in that order of
 * relevance — instead of whatever the retriever happened to return for the words
 * in the question.
 *
 * The answer is grounded or absent. A question about a line whose file the PR
 * does not touch, or whose content cannot be read, gets a refusal that says what
 * is missing — not a plausible answer from the model's imagination.
 */

import { expandPatch, enclosingDeclaration } from '../utils/dynamicContext.js';
import { parsePatchHunks, formatPatchWithLineNumbers } from '../utils/patchLines.js';
import { LINE_QUESTION_SYSTEM_PROMPT, buildLineQuestionPrompt } from '../utils/lineQuestionPrompts.js';
import { PRIORITY } from '../utils/callBudget.js';

/** Lines of the file shown around the target when there is no declaration. */
const FALLBACK_WINDOW = 25;

export class LineQuestionService {
    constructor({ llmService, symbolExtractor = null } = {}) {
        this.llmService = llmService;
        this.symbolExtractor = symbolExtractor;
    }

    /**
     * Parse `path/to/file.js:214` — the form people paste from a host's UI.
     *
     * Windows-style paths with a drive letter are not a case worth handling (a
     * repo path is always POSIX here), but a path containing a colon would break
     * a naive split, so the LAST colon wins.
     *
     * @param {string} raw
     * @returns {{filename:string, line:number}|null}
     */
    static parseTarget(raw) {
        if (!raw || typeof raw !== 'string') return null;
        const trimmed = raw.trim();
        const idx = trimmed.lastIndexOf(':');
        if (idx <= 0) return null;

        const filename = trimmed.slice(0, idx).trim();
        const line = Number(trimmed.slice(idx + 1).trim());
        if (!filename || !Number.isInteger(line) || line < 1) return null;
        return { filename, line };
    }

    /**
     * Assemble the context for a line, without calling a model.
     *
     * @returns {{ok:true, context:Object} | {ok:false, reason:string}}
     */
    buildContext({ prData, fileContext, declarationsByFile = null, target } = {}) {
        if (!target) return { ok: false, reason: 'No line given. Use `file.js:214`.' };

        const file = (prData?.files || []).find(f => f.filename === target.filename)
            // A user pasting from a host UI often gives a partial path.
            || (prData?.files || []).find(f => (f.filename || '').endsWith(target.filename));

        if (!file) {
            return {
                ok: false,
                reason: `\`${target.filename}\` is not one of the ${(prData?.files || []).length} file(s) `
                    + 'this PR changes, so there is no diff context for it.',
            };
        }

        const ctx = fileContext?.get?.(file.filename) || null;
        const hunks = parsePatchHunks(file.patch || '');

        // Is the line in the diff at all? A question about an untouched line is
        // legitimate — but the answer must not imply the PR changed it.
        let inDiff = false;
        for (const h of hunks) {
            for (const l of h.lines) {
                if (l.number.new === target.line) {
                    inDiff = true;
                    break;
                }
            }
        }

        const content = ctx?.fullContent || null;
        const lines = content ? content.split('\n') : null;

        if (!lines && !hunks.length) {
            return { ok: false, reason: `Neither the diff nor the content of \`${file.filename}\` could be read.` };
        }

        // Range-check BEFORE coercing, or the check cannot fire: `?? null` turns
        // an out-of-range index into a legitimate-looking null, and the answer
        // then describes a line that does not exist.
        if (lines && target.line > lines.length) {
            return {
                ok: false,
                reason: `\`${file.filename}\` has ${lines.length} lines; there is no line ${target.line}.`,
            };
        }
        const lineContent = lines?.[target.line - 1] ?? null;

        const declarations = declarationsByFile?.get?.(file.filename)
            || declarationsByFile?.[file.filename]
            || (content && file.language
                ? this.symbolExtractor?.extractSymbols?.(content, file.language, file.filename)
                : null)
            || [];

        const decl = enclosingDeclaration(declarations, target.line);

        // The enclosing component, or a window around the line when there is none
        // (a top-level constant, a config file).
        let scope = null;
        if (lines) {
            const start = decl ? decl.startLine : Math.max(1, target.line - FALLBACK_WINDOW);
            const end = decl ? decl.endLine : Math.min(lines.length, target.line + FALLBACK_WINDOW);
            scope = {
                name: decl?.name || null,
                kind: decl?.label || null,
                startLine: start,
                endLine: end,
                // Numbered, for the same reason the review's diff is: the answer
                // should be able to cite a line without counting.
                source: lines.slice(start - 1, end)
                    .map((text, i) => `${String(start + i).padStart(6)}  ${text}`)
                    .join('\n'),
            };
        }

        // The diff, expanded to the enclosing declaration where possible so the
        // change reads in context rather than as three lines of git default.
        const expansion = content
            ? expandPatch({
                patch: file.patch,
                filename: file.filename,
                fileContent: content,
                declarations,
            })
            : { patch: file.patch, expanded: false };

        return {
            ok: true,
            context: {
                filename: file.filename,
                language: file.language || '',
                line: target.line,
                lineContent,
                inDiff,
                scope,
                diff: formatPatchWithLineNumbers(expansion.patch, file.filename),
                prTitle: prData?.title || '',
            },
        };
    }

    /**
     * @param {Object} args
     * @param {string} args.question
     * @param {string} args.rawTarget - "file.js:214"
     * @returns {Promise<{answer:string, grounded:boolean, context?:Object, usage:Object}>}
     */
    async ask({ question, rawTarget, prData, fileContext, declarationsByFile = null, settings = {} } = {}) {
        const usage = { input: 0, output: 0 };
        const target = LineQuestionService.parseTarget(rawTarget);

        const built = this.buildContext({ prData, fileContext, declarationsByFile, target });
        if (!built.ok) {
            // A refusal, not an answer. Answering anyway is how a tool that cannot
            // see the code ends up inventing what is on line 214.
            return { answer: built.reason, grounded: false, usage };
        }

        if (!this.llmService) {
            return { answer: 'No model is configured.', grounded: false, usage };
        }

        const resp = await this.llmService.streamChat(
            [
                { role: 'system', content: LINE_QUESTION_SYSTEM_PROMPT },
                { role: 'user', content: buildLineQuestionPrompt(question, built.context) },
            ],
            {
                provider: settings.provider,
                model: settings.model,
                apiKey: settings.apiKey,
                stream: false,
                budgetStage: 'line-question',
                // A question the user asked in the moment is what they are waiting
                // for; it outranks any background polish pass.
                budgetPriority: PRIORITY.ESSENTIAL,
            },
        );

        usage.input += resp?.usage?.input || 0;
        usage.output += resp?.usage?.output || 0;

        return {
            answer: String(resp?.content ?? resp ?? '').trim(),
            grounded: true,
            context: {
                filename: built.context.filename,
                line: built.context.line,
                scope: built.context.scope?.name || null,
                inDiff: built.context.inDiff,
            },
            usage,
        };
    }
}

export default LineQuestionService;

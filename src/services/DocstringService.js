/**
 * DocstringService — write docstrings for the declarations this PR added.
 *
 * pr-agent's `/add_docs`, with the scope narrowed on purpose. Two rules decide
 * what it touches, and both exist to keep the output reviewable:
 *
 *   1. Only declarations the PR ADDED or CHANGED. Documenting a file's untouched
 *      functions produces a diff nobody asked for, buried in a review of
 *      something else.
 *   2. Only declarations that have NO doc comment already. Rewriting an existing
 *      docstring is an opinion about someone's prose; adding a missing one is a
 *      gap being filled. The first starts arguments, the second gets merged.
 *
 * The model is given the declaration's full source (not the hunk) because a
 * docstring has to describe parameters, return values and thrown errors, none of
 * which are reliably visible in a diff. Detection of what to document, and of
 * what already has docs, is deterministic — the model writes prose and nothing
 * else.
 */

import { DOCSTRING_SYSTEM_PROMPT, buildDocstringPrompt } from '../utils/docstringPrompts.js';
import { addedLines } from '../utils/patchLines.js';
import { PRIORITY } from '../utils/callBudget.js';

/** Comment syntax per language: what a doc comment looks like above a decl. */
const DOC_STYLES = Object.freeze({
    javascript: { style: 'jsdoc', opens: ['/**'], line: '//' },
    typescript: { style: 'jsdoc', opens: ['/**'], line: '//' },
    java: { style: 'javadoc', opens: ['/**'], line: '//' },
    csharp: { style: 'xmldoc', opens: ['///'], line: '//' },
    go: { style: 'godoc', opens: ['//'], line: '//' },
    rust: { style: 'rustdoc', opens: ['///', '//!'], line: '//' },
    python: { style: 'docstring', opens: ['"""', "'''"], line: '#' },
    c: { style: 'doxygen', opens: ['/**', '/*!'], line: '//' },
    cpp: { style: 'doxygen', opens: ['/**', '/*!'], line: '//' },
});

/** Trivial declarations nobody wants a docstring on. */
const MIN_BODY_LINES = 3;

export class DocstringService {
    /**
     * @param {Object} deps
     * @param {Object} deps.llmService
     * @param {Object} [deps.symbolExtractor] - anything with extractSymbols()
     */
    constructor({ llmService, symbolExtractor = null } = {}) {
        this.llmService = llmService;
        this.symbolExtractor = symbolExtractor;
    }

    /**
     * Which declarations in this PR need a docstring?
     *
     * Pure and synchronous: no model, no network. Exported separately from
     * `generate` so the candidate set can be inspected (and tested) without
     * spending a call on it.
     *
     * @param {Object} args
     * @param {Object} args.prData
     * @param {Map<string, {fullContent?:string}>} args.fileContext
     * @param {Map<string, Array>|Object} [args.declarationsByFile]
     * @param {Object} [args.options]
     * @returns {Array<{filename, language, name, startLine, endLine, source, docStyle}>}
     */
    findUndocumented({ prData, fileContext, declarationsByFile = null, options = {} } = {}) {
        const out = [];
        const maxPerFile = options.maxPerFile ?? 10;
        const maxTotal = options.maxTotal ?? 25;

        for (const file of (prData?.files || [])) {
            if (out.length >= maxTotal) break;

            const ctx = fileContext?.get?.(file.filename);
            const content = ctx?.fullContent;
            if (!content) continue;

            const language = file.language;
            const styleInfo = DOC_STYLES[language];
            // An unknown language means unknown comment syntax. Guessing it
            // produces a docstring in the wrong dialect, which is worse than none.
            if (!styleInfo) continue;

            const declarations = declarationsByFile?.get?.(file.filename)
                || declarationsByFile?.[file.filename]
                || this.symbolExtractor?.extractSymbols?.(content, language, file.filename)
                || [];
            if (!declarations.length) continue;

            const lines = content.split('\n');
            const touched = addedLines(file.patch || '');
            let perFile = 0;

            for (const decl of declarations) {
                if (perFile >= maxPerFile || out.length >= maxTotal) break;

                const start = Number(decl.startLine);
                const end = Number(decl.endLine);
                if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

                // Rule 1: the PR must have touched this declaration.
                let isTouched = false;
                for (const line of touched) {
                    if (line >= start && line <= end) { isTouched = true; break; }
                }
                if (!isTouched) continue;

                // Skip one-liners: a docstring longer than the function is noise.
                if (end - start < MIN_BODY_LINES) continue;

                // Rule 2: no doc comment already.
                if (hasDocComment(lines, start, styleInfo)) continue;

                out.push({
                    filename: file.filename,
                    language,
                    name: decl.name || '(anonymous)',
                    kind: decl.label || 'Function',
                    startLine: start,
                    endLine: end,
                    source: lines.slice(start - 1, end).join('\n'),
                    docStyle: styleInfo.style,
                    isExported: !!decl.isExported,
                });
                perFile++;
            }
        }

        // Exported declarations first: a missing docstring on a public symbol
        // costs every caller, on a private one it costs the next reader of one file.
        return out.sort((a, b) => Number(b.isExported) - Number(a.isExported));
    }

    /**
     * Write docstrings for the undocumented declarations.
     *
     * One call per BATCH of declarations from the same file, not one per
     * declaration: a file's functions share vocabulary and conventions, and the
     * model writes more consistent prose seeing them together — the same reason
     * `SuggestionScorer` scores findings as a set.
     *
     * @returns {Promise<{docstrings:Array, stats:Object, usage:{input:number,output:number}}>}
     */
    async generate({ prData, fileContext, declarationsByFile = null, settings = {}, options = {}, onProgress = null } = {}) {
        const candidates = this.findUndocumented({ prData, fileContext, declarationsByFile, options });
        const usage = { input: 0, output: 0 };
        const stats = { candidates: candidates.length, documented: 0, failedBatches: 0, batches: 0 };

        if (!candidates.length || !this.llmService) {
            return { docstrings: [], stats, usage };
        }

        const byFile = new Map();
        for (const c of candidates) {
            if (!byFile.has(c.filename)) byFile.set(c.filename, []);
            byFile.get(c.filename).push(c);
        }

        const docstrings = [];

        for (const [filename, decls] of byFile.entries()) {
            stats.batches++;
            onProgress?.({ phase: 'docstrings', message: `Documenting ${decls.length} declaration(s) in ${filename}...` });

            try {
                const resp = await this.llmService.streamChat(
                    [
                        { role: 'system', content: DOCSTRING_SYSTEM_PROMPT },
                        { role: 'user', content: buildDocstringPrompt(filename, decls) },
                    ],
                    {
                        provider: settings.provider,
                        model: settings.model,
                        apiKey: settings.apiKey,
                        stream: false,
                        budgetStage: 'docstrings',
                        // Documentation never blocks a merge, so it must never
                        // consume the allowance a finding-producing pass needs.
                        budgetPriority: PRIORITY.OPTIONAL,
                    },
                );

                usage.input += resp?.usage?.input || 0;
                usage.output += resp?.usage?.output || 0;

                for (const written of parseDocstringResponse(resp.content || resp)) {
                    const match = decls.find(d => d.name === written.name);
                    // A docstring for a declaration we never asked about cannot be
                    // placed: there is no line to insert it above. Dropped rather
                    // than guessed at.
                    if (!match) continue;
                    docstrings.push({
                        filename,
                        name: match.name,
                        // Insert ABOVE the declaration, at its own indentation —
                        // except Python, where the docstring goes INSIDE the body.
                        insertAtLine: match.language === 'python' ? match.startLine + 1 : match.startLine,
                        placement: match.language === 'python' ? 'inside' : 'above',
                        indent: leadingWhitespace(match.source),
                        docstring: written.docstring,
                        docStyle: match.docStyle,
                    });
                    stats.documented++;
                }
            } catch (e) {
                stats.failedBatches++;
                console.warn(`[Docstrings] ${filename}: ${e?.message}`);
            }
        }

        return { docstrings, stats, usage };
    }
}

/**
 * Is there already a doc comment immediately above `startLine`?
 *
 * Walks upward past blank lines and decorators/annotations, which sit between a
 * docstring and the declaration it documents (`@Override`, `@pytest.fixture`,
 * `#[derive(...)]`). Without that step every annotated function reads as
 * undocumented.
 */
function hasDocComment(lines, startLine, styleInfo) {
    // Python's docstring is the first statement INSIDE the body.
    if (styleInfo.style === 'docstring') {
        const first = (lines[startLine] || '').trim();
        return first.startsWith('"""') || first.startsWith("'''");
    }

    for (let i = startLine - 2; i >= 0; i--) {
        const t = (lines[i] || '').trim();
        if (!t) continue;
        if (t.startsWith('@') || t.startsWith('#[')) continue; // annotation/attribute
        if (styleInfo.opens.some(o => t.startsWith(o))) return true;
        // A closing `*/` means the line above ends a block comment — which for
        // these languages is the docstring's last line.
        if (t.startsWith('*/') || t.startsWith('*')) return true;
        return false;
    }
    return false;
}

function leadingWhitespace(source) {
    const m = String(source).match(/^([ \t]*)/);
    return m ? m[1] : '';
}

/**
 * Parse the model's JSON response.
 *
 * Tolerant of a fenced block, because "JSON ONLY" is advice rather than a
 * guarantee. Returns [] rather than throwing: a malformed batch loses its
 * docstrings, not the whole command.
 */
export function parseDocstringResponse(raw) {
    if (!raw) return [];
    const text = String(raw).trim();
    const body = text.startsWith('```')
        ? text.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '')
        : text;

    try {
        const parsed = JSON.parse(body);
        const list = Array.isArray(parsed) ? parsed : parsed?.docstrings;
        if (!Array.isArray(list)) return [];
        return list
            .filter(d => d && typeof d.name === 'string' && typeof d.docstring === 'string')
            .map(d => ({ name: d.name, docstring: d.docstring }));
    } catch {
        return [];
    }
}

export default DocstringService;

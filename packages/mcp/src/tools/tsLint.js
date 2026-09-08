import { createNodeParser } from '../adapters/treeSitter.js';

/**
 * AST linting for TypeScript, which this package had none of.
 *
 * `ASTLintEngine` (acorn) claims only `.js/.jsx/.mjs/.cjs`, so every `.ts` file
 * fell through to the regex rules. A measured review of a TypeScript monorepo
 * reported `engines: {regex: 15}` — not one parsed analysis — with six findings
 * withheld as mis-mapped and eleven false criticals from a single loose
 * pattern. On a TS codebase that made the static section almost pure noise.
 *
 * `TreeSitterLintEngine` already carries TypeScript queries and was wired only
 * into the extension's offscreen document. Nothing in it is browser-specific:
 * it wants a `TreeSitterParser`, and this package already builds one for the
 * graph, from the same wasm grammars.
 *
 * Findings are labelled `engine: 'tree-sitter'` so the bundle's engine
 * attribution stays honest — a parsed finding and a pattern match are different
 * kinds of evidence and the reader is told which is which.
 *
 * `filesParsed` is returned alongside them because a CLEAN pass and NO pass are
 * different facts. Measured on the real merge request: this engine parsed three
 * TypeScript files of 9KB, 19KB and 68KB with `ok: true` and legitimately found
 * nothing — and the bundle's histogram then read `{regex: 15}` with no mention
 * of tree-sitter, so a reader could not tell the AST pass had happened. Silence
 * reading as a pass is the defect this whole effort exists to remove.
 */

let engine = null;

async function getEngine() {
    if (engine) return engine;
    const { TreeSitterLintEngine } = await import(
        '../../../../src/services/TreeSitterLintEngine.js'
    );
    // `createNodeParser()` returns the batch wrapper the graph uses; the lint
    // engine wants the underlying parser, which that wrapper exposes.
    engine = new TreeSitterLintEngine({ parser: createNodeParser().parser });
    return engine;
}

/**
 * @param {Array<{path: string, content: string}>} files
 * @returns {Promise<{findings: Array<object>, filesParsed: number}>}
 */
export async function lintTypeScript(files = []) {
    const applicable = files.filter((f) => f?.content && /\.tsx?$/i.test(f.path || ''));
    if (applicable.length === 0) return { findings: [], filesParsed: 0 };

    let lint;
    try {
        lint = await getEngine();
    } catch {
        // No grammar available. `filesParsed: 0` is what makes this
        // distinguishable from a clean pass.
        return { findings: [], filesParsed: 0 };
    }

    const findings = [];
    let filesParsed = 0;
    for (const file of applicable) {
        try {
            if (!lint.supports(file.path)) continue;
            const result = await lint.analyze(file.content, { filePath: file.path });
            if (!result?.ok) continue;
            filesParsed += 1;
            for (const finding of result.findings || []) {
                findings.push({
                    ...finding,
                    filePath: finding.filePath || file.path,
                    tool: 'tree-sitter-lint',
                    engine: 'tree-sitter',
                });
            }
        } catch {
            // One unparseable file must not fail the section; the engine
            // already returns `ok: false` for a parse failure, and this covers
            // anything it throws instead.
        }
    }
    return { findings, filesParsed };
}

export default { lintTypeScript };

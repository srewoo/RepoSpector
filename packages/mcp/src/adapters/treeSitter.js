import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TreeSitterParser } from '../../../../src/services/TreeSitterParser.js';

const require_ = createRequire(import.meta.url);

/**
 * Tree-sitter parsing in Node, satisfying the same contract `CodeGraphPipeline`
 * expects from `OffscreenGraphParser`:
 *   analyzeFiles(files, onProgress) → Promise<Map<path, analysis> | null>
 *
 * TreeSitterParser has no `analyzeFiles` batch method of its own — its actual
 * public contract, as used by the extension's own offscreen host
 * (src/offscreen/offscreen.js:49-59), is: call `preloadFromFiles(files)` once
 * to load the grammars this batch needs, then per file call `isReadyForPath`
 * and, if ready, the underscore-prefixed `_analyze(content, path)`. The
 * offscreen host already treats `_analyze` as its contract with this parser,
 * so this adapter follows the same established usage rather than inventing a
 * new one; it is used knowingly, not as a layering violation. This adapter
 * does the looping itself and converts the offscreen host's plain-object
 * result into a Map, because CodeGraphPipeline reads `analyses.size` and
 * iterates entries — a plain object would silently look empty
 * (`undefined > 0` is false) and the pipeline would fall back to regex
 * extraction while reporting nothing wrong.
 *
 * TreeSitterParser is already runtime-agnostic — it takes the wasm runtime and
 * the grammar loader by injection — so this supplies filesystem versions of
 * both. The extension supplies chrome.runtime.getURL + fetch instead. There is
 * a working precedent for exactly this injection in
 * test/unit/TreeSitterLintEngine.test.js.
 *
 * Paths resolve from the installed package via createRequire, NOT from
 * process.cwd(): this runs under `npx` from whatever directory the user
 * happens to be in, and a cwd-relative path would find nothing.
 */

/** Absolute path to the tree-sitter wasm runtime inside the installed package. */
function runtimeWasmPath() {
    return require_.resolve('web-tree-sitter/tree-sitter.wasm');
}

/** Directory holding the per-language grammar wasm files. */
function grammarDir() {
    // The package exposes its grammars under out/; resolve via its manifest so
    // the location follows the dependency rather than being guessed.
    return path.join(path.dirname(require_.resolve('tree-sitter-wasms/package.json')), 'out');
}

export function createNodeParser() {
    const parser = new TreeSitterParser({
        module: require_('web-tree-sitter'),
        runtimeLocator: () => runtimeWasmPath(),
        grammarLoader: async (grammar) => new Uint8Array(
            fs.readFileSync(path.join(grammarDir(), `tree-sitter-${grammar}.wasm`)),
        ),
    });

    return {
        parser,
        get available() { return parser.available; },

        /**
         * Analyse a batch. Mirrors OffscreenGraphParser's contract, including
         * returning an empty Map for an empty batch — CodeGraphPipeline treats
         * null as "parser unavailable, use regex", so an empty batch must not
         * be reported as a parser failure.
         */
        async analyzeFiles(files, onProgress) {
            if (!Array.isArray(files) || files.length === 0) return new Map();

            await parser.preloadFromFiles(files);

            const analyses = new Map();
            const total = files.length;
            for (let i = 0; i < files.length; i += 1) {
                const file = files[i];
                if (file?.content && parser.isReadyForPath(file.path)) {
                    const analysis = parser._analyze(file.content, file.path);
                    if (analysis) analyses.set(file.path, analysis);
                }
                if (typeof onProgress === 'function') onProgress(i + 1, total, file?.path);
            }
            return analyses;
        },
    };
}

/**
 * Turn a corpus case's cached `fileContents` into the exact structures the
 * shipped review path passes to `MultiPassReviewEngine`.
 *
 * Two of them, and both have to be right or the features they feed go untested
 * while appearing to be exercised:
 *
 *   fileContext         Map<filename, {fullContent, truncated, testPath,
 *                       testContent, testFileMissing}> — what
 *                       `ReviewFileContextService.build()` returns.
 *   declarationsByFile  Map<filename, [{name, startLine, endLine, ...}]> — what
 *                       `prReviewHandlers` derives with `SymbolExtractor`, and
 *                       what `dynamicContext` needs to expand a hunk to its
 *                       enclosing function.
 *
 * Built here rather than inline in `run.js` so the harness and the extension
 * agree on the shape by construction, and so `alignmentReport` can be run on a
 * corpus without doing a review.
 */

import { SymbolExtractor } from '../../src/services/SymbolExtractor.js';
import { detectLanguageFromPath } from '../../src/utils/languageMap.js';
import { verifyAlignment } from '../../src/utils/dynamicContext.js';
import { parsePatchHunks } from '../../src/utils/patchLines.js';
import { isTestFile, testCandidatesForProduction } from '../../src/services/testFileUtils.js';

/**
 * @param {Object} kase - a corpus case
 * @returns {{fileContext: Map, stats: Object}}
 */
export function buildFileContext(kase) {
    const contents = kase?.fileContents || {};
    const files = kase?.prData?.files || [];
    const fileContext = new Map();
    const stats = { withContent: 0, withoutContent: 0, testsFound: 0, testsMissing: 0, bytes: 0 };

    for (const file of files) {
        const fullContent = contents[file.filename];
        if (typeof fullContent !== 'string' || !fullContent) {
            stats.withoutContent++;
            continue;
        }

        const entry = {
            fullContent,
            // The fetcher caps at 60 kB, the same cap the service applies. A file
            // at exactly the cap is assumed truncated: claiming otherwise would
            // let `dynamicContext` expand into content that stops mid-file.
            truncated: fullContent.length >= 60_000,
            testPath: null,
            testContent: null,
            testFileMissing: false,
        };

        // The test file, from the corpus itself. `ReviewFileContextService` probes
        // the repo for candidate paths; the harness can only see what the PR
        // changed, so a test that exists but was not touched by this PR reads as
        // missing here. That is a KNOWN understatement of the shipped context —
        // it makes the harness slightly pessimistic about coverage findings, which
        // is the safe direction, but it is not the same as production.
        if (!isTestFile(file.filename)) {
            const candidates = new Set(testCandidatesForProduction(file.filename) || []);
            const hit = Object.keys(contents).find(p => candidates.has(p) || (isTestFile(p) && sharesStem(p, file.filename)));
            if (hit) {
                entry.testPath = hit;
                entry.testContent = contents[hit];
                stats.testsFound++;
            } else {
                entry.testFileMissing = true;
                stats.testsMissing++;
            }
        }

        fileContext.set(file.filename, entry);
        stats.withContent++;
        stats.bytes += fullContent.length;
    }

    return { fileContext, stats };
}

/** Do two paths name the same module (`src/a.js` / `src/a.test.js`)? */
function sharesStem(testPath, sourcePath) {
    const stem = (p) => p.split('/').pop().replace(/\.(test|spec)\./, '.').replace(/_test\.(go|py)$/, '.$1');
    return stem(testPath) === stem(sourcePath);
}

/**
 * Declaration ranges per file, from the same extractor the extension uses.
 *
 * @param {Map} fileContext
 * @returns {{declarationsByFile: Map, stats: Object}}
 */
export function buildDeclarations(fileContext) {
    const declarationsByFile = new Map();
    const stats = { files: 0, declarations: 0, unknownLanguage: 0 };
    const extractor = new SymbolExtractor();

    for (const [filename, ctx] of fileContext.entries()) {
        if (!ctx?.fullContent) continue;
        const language = detectLanguageFromPath(filename);
        if (!language || language === 'unknown') { stats.unknownLanguage++; continue; }

        try {
            const symbols = extractor.extractSymbols(ctx.fullContent, language, filename);
            if (symbols?.length) {
                declarationsByFile.set(filename, symbols);
                stats.files++;
                stats.declarations += symbols.length;
            }
        } catch {
            // Same soft failure as the handler: expansion falls back to a fixed
            // window rather than the run dying over one unparseable file.
        }
    }

    return { declarationsByFile, stats };
}

/**
 * Would `dynamicContext` actually expand anything for this case?
 *
 * This is the check that makes the wiring falsifiable. Cached content that does
 * not match the cached patch is refused by `verifyAlignment` — correctly — and
 * the run then falls back to patch-only while every log line claims file context
 * was supplied. Reporting alignment per case turns that from a silent
 * regression into a number.
 *
 * @param {Object} kase
 * @param {Map} fileContext
 * @returns {{aligned:number, misaligned:number, noContent:number, reasons:Array}}
 */
export function alignmentReport(kase, fileContext) {
    const out = { aligned: 0, misaligned: 0, noContent: 0, reasons: [] };

    for (const file of (kase?.prData?.files || [])) {
        const ctx = fileContext.get(file.filename);
        if (!ctx?.fullContent) { out.noContent++; continue; }

        const hunks = parsePatchHunks(file.patch || '');
        if (!hunks.length) { out.noContent++; continue; }

        const res = verifyAlignment(hunks, ctx.fullContent.split('\n'));
        if (res.aligned) {
            out.aligned++;
        } else {
            out.misaligned++;
            out.reasons.push({ file: file.filename, reason: res.reason });
        }
    }

    return out;
}

export default { buildFileContext, buildDeclarations, alignmentReport };

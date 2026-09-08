import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFilesAtRev } from '../repo/source.js';
import { extractAddedLines } from '../../../../src/utils/patchLines.js';
import { isIndexableCodeFile } from '../../../../src/utils/codeFileFilter.js';

const exec = promisify(execFile);

/**
 * Which revision a review's file contents should come from.
 *
 * `review_pr` used to lint the working tree for every target. The hunks came
 * from the range or the PR; the linter read whatever happened to be checked
 * out. On a real review that was 537 commits away from the range's base, and
 * three of the four findings pointed at a schema the change deletes.
 *
 * So the revision is resolved explicitly, and when it cannot be, this says so
 * and falls back to the one source that is correct by construction: the added
 * lines of the patch itself. Never back to the worktree — a wrong revision
 * reads as fact, while a narrower source reads as what it is.
 */

/** The head side of a revision range: `a..b` and `a...b` both mean `b`. */
export function headSpecOf(range) {
    const spec = String(range ?? '').trim();
    if (!spec) return null;
    const threeDot = spec.indexOf('...');
    if (threeDot >= 0) return spec.slice(threeDot + 3).trim() || 'HEAD';
    const twoDot = spec.indexOf('..');
    if (twoDot >= 0) return spec.slice(twoDot + 2).trim() || 'HEAD';
    return spec;
}

/**
 * @param {{diff?: string, pr_url?: string, range?: string}} args
 * @param {string} repo
 * @param {{headSha?: string|null}} [opts] A pull request's head sha, when the
 *   caller already fetched it. Used only if that object exists locally.
 * @returns {Promise<{kind: 'revision'|'added-lines', rev: string|null, spec?: string, reason: string}>}
 */
export async function resolveReviewRev(args = {}, repo, opts = {}) {
    const verify = async (spec) => {
        try {
            const { stdout } = await exec('git', ['rev-parse', '--verify', `${spec}^{commit}`], {
                cwd: repo,
            });
            return stdout.trim();
        } catch {
            return null;
        }
    };

    if (args.range) {
        const spec = headSpecOf(args.range);
        const rev = spec ? await verify(spec) : null;
        if (rev) {
            return {
                kind: 'revision',
                rev,
                spec,
                reason: `file contents read at ${spec} (${rev.slice(0, 12)}), the head of the range`,
            };
        }
        return {
            kind: 'added-lines',
            rev: null,
            reason: `range head '${spec}' does not resolve in this repository, so whole-file `
                + 'contents for that revision are unavailable; analysing the patch\'s added lines',
        };
    }

    if (args.pr_url) {
        const rev = opts.headSha ? await verify(opts.headSha) : null;
        if (rev) {
            return {
                kind: 'revision',
                rev,
                spec: opts.headSha,
                reason: `file contents read at the pull request head ${rev.slice(0, 12)}, `
                    + 'which is present locally',
            };
        }
        return {
            kind: 'added-lines',
            rev: null,
            reason: 'the pull request head is not present in this local repository '
                + '(fetch it to widen this), so analysing the patch\'s added lines',
        };
    }

    return {
        kind: 'added-lines',
        rev: null,
        reason: 'a pasted diff names no revision in this repository, '
            + 'so analysing the patch\'s added lines',
    };
}

/**
 * File contents to hand the analyzers, plus what they actually describe.
 *
 * On the `added-lines` path each entry carries `lineNumbers`, which
 * `StaticAnalysisService.analyzeFiles` uses to map a finding's line in the
 * added-lines block back to its real line in the file. Without that map every
 * finding would cite a line number that means nothing in any file.
 *
 * @returns {Promise<{files: Array<{path: string, content: string, lineNumbers?: number[]}>, source: {kind: string, rev: string|null, reason: string, missing?: string[], skipped?: Array<object>}}>}
 */
export async function filesForStaticAnalysis(args, repo, diffFiles = [], opts = {}) {
    const source = await resolveReviewRev(args, repo, opts);

    // `readRepoFiles` filtered by `isIndexableCodeFile`, so lockfiles, minified
    // bundles and binaries never reached the analyzers. Reading blobs at a
    // revision has to keep that filter or a change touching
    // `package-lock.json` hands a megabyte of generated JSON to the linter.
    // `filter: 'none'` is for the caller whose subject IS the manifest.
    const wanted = opts.filter === 'none'
        ? diffFiles
        : diffFiles.filter((f) => f.filename && isIndexableCodeFile(f.filename));
    const paths = wanted.map((f) => f.filename).filter(Boolean);

    if (source.kind === 'revision') {
        const { files, missing, skipped } = await readFilesAtRev(repo, source.rev, paths);
        return { files, source: { ...source, missing, skipped } };
    }

    const files = [];
    for (const file of wanted) {
        const patch = file.patch || file.diff || '';
        if (!patch || !file.filename) continue;
        const { code, lineNumbers } = extractAddedLines(patch);
        if (!code) continue;
        files.push({ path: file.filename, content: code, lineNumbers });
    }
    return { files, source: { ...source, missing: [], skipped: [] } };
}

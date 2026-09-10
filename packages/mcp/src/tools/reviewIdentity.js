import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDiffTarget, diffRangeArgs } from './diff.js';
import { headSpecOf, resolveReviewRev } from './reviewRevision.js';
import { baseSpecOf } from './provenance.js';

const exec = promisify(execFile);

/**
 * One revision identity for a whole review bundle — P0-2.
 *
 * Every section of `review_pr` is an answer about a specific pair of commits,
 * and before this each one resolved that pair for itself, in the order the
 * sections happened to be pushed. `surviving_references` chose its revision
 * from `staticSource?.rev || 'HEAD'` while `staticSource` was still `null`,
 * because the static section is assembled AFTER it — so a pull request review
 * searched for surviving references in whatever the local worktree happened to
 * have checked out, then reported linting results from the PR head. Two
 * sections, two revisions, one bundle, no way for the reader to tell.
 *
 * So identity is resolved once, up front, and passed down. Sections read it;
 * none of them re-derives it, and none of them may substitute local `HEAD`
 * when it is unknown. An unresolved revision makes the dependent evidence
 * unavailable, which is a fact a reviewer can act on; a silent fallback to the
 * worktree is a wrong answer that reads as a measurement.
 */

async function revParse(repo, spec) {
    if (!spec) return null;
    try {
        const { stdout } = await exec('git', ['rev-parse', '--verify', `${spec}^{commit}`], { cwd: repo });
        return stdout.trim();
    } catch {
        return null;
    }
}

async function mergeBase(repo, a, b) {
    if (!a || !b) return null;
    try {
        const { stdout } = await exec('git', ['merge-base', a, b], { cwd: repo });
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

/**
 * @param {object} input
 * @param {{diff?: string, pr_url?: string, range?: string}} input.args
 * @param {string} input.repo            absolute path to the repository
 * @param {string|null} [input.headSha]  the PR head, when the diff fetch found one
 * @returns {Promise<object>} an immutable snapshot; every section reads it
 */
export async function resolveReviewIdentity({ args = {}, repo, headSha = null } = {}) {
    const target = parseDiffTarget(args);
    const kind = target.error ? 'unknown' : target.kind;
    const diffMode = args.range ? diffRangeArgs(args.range).mode : null;

    const baseSpec = args.range ? baseSpecOf(args.range) : null;
    const headSpec = args.range ? headSpecOf(args.range) : (headSha || null);

    const baseResolved = await revParse(repo, baseSpec);
    const headResolved = await revParse(repo, headSpec);

    // The EFFECTIVE base of a three-dot comparison is the merge base, not the
    // left endpoint. `baseSpecOf` reports the endpoint, and provenance reported
    // that as "the base" — on a target branch that has advanced since the
    // branch was cut those are different commits, and a caller lookup against
    // the wrong one is wrong in exactly the direction that invents regressions.
    let effectiveBase = baseResolved;
    let effectiveBaseSource = baseResolved ? 'endpoint' : null;
    if (diffMode === 'merge-base' && baseResolved && headResolved) {
        const mb = await mergeBase(repo, baseResolved, headResolved);
        if (mb) {
            effectiveBase = mb;
            effectiveBaseSource = 'merge-base';
        } else {
            effectiveBaseSource = 'endpoint (merge base unavailable)';
        }
    }

    // Which revision file CONTENTS come from. Shared by static analysis,
    // reference search and any other section that reads whole files, so they
    // cannot disagree.
    const source = await resolveReviewRev(args, repo, { headSha });

    const worktreeHead = await revParse(repo, 'HEAD');
    let dirty = null;
    try {
        const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: repo });
        dirty = stdout.trim().length > 0;
    } catch {
        dirty = null;
    }

    const unresolved = [];
    if (source.kind !== 'revision') unresolved.push(source.reason);
    if (args.range && !baseResolved) unresolved.push(`base '${baseSpec}' does not resolve in this repository`);
    if (kind === 'pr' && !headResolved) {
        unresolved.push('the pull request head is not present locally, so revision-scoped evidence is limited to the patch');
    }

    return Object.freeze({
        kind,
        repo,
        diffMode,
        baseSpec,
        headSpec,
        baseSha: baseResolved,
        headSha: headResolved ?? (headSha || null),
        effectiveBase,
        effectiveBaseSource,
        // `source.rev` is the ONLY revision a section may read files at.
        // Null means unknown, and null must stay null — see the note above.
        source,
        worktree: { head: worktreeHead, dirty },
        unresolved,
        /** True when whole-file evidence at the reviewed revision is available. */
        get hasRevision() { return this.source.kind === 'revision' && !!this.source.rev; },
    });
}

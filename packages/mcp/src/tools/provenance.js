import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDiffTarget } from './diff.js';
import { headSpecOf } from './reviewRevision.js';

const exec = promisify(execFile);

/**
 * Which revision each part of the bundle describes.
 *
 * The bundle never said, and its parts did not agree: hunks from a range,
 * static analysis from the working tree, the graph from an index built at a
 * third commit. On the review that exposed this, the indexed worktree was 537
 * commits behind the range's own base and three of four findings pointed at
 * code the change deletes. Every fact needed to catch that in one glance was
 * available and none of it was reported.
 *
 * Anything unresolvable is `null` with a note. A provenance block that guesses
 * is worse than none, because it is read as a measurement.
 */

/** Commits between `from` and `to`, or null when either end is unknown. */
async function distance(repo, from, to) {
    if (!from || !to) return null;
    try {
        const { stdout } = await exec('git', ['rev-list', '--count', `${from}..${to}`], {
            cwd: repo,
        });
        const n = Number.parseInt(stdout.trim(), 10);
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

async function revParse(repo, spec) {
    if (!spec) return null;
    try {
        const { stdout } = await exec('git', ['rev-parse', '--verify', `${spec}^{commit}`], {
            cwd: repo,
        });
        return stdout.trim();
    } catch {
        return null;
    }
}

/** The base side of a range: `a..b` and `a...b` both mean `a`. */
export function baseSpecOf(range) {
    const spec = String(range ?? '').trim();
    if (!spec) return null;
    const threeDot = spec.indexOf('...');
    if (threeDot >= 0) return spec.slice(0, threeDot).trim() || null;
    const twoDot = spec.indexOf('..');
    if (twoDot >= 0) return spec.slice(0, twoDot).trim() || null;
    // A single revision means "this commit", whose base is its parent.
    return `${spec}^`;
}

/**
 * @param {{args: object, repo: string, indexer: object, staticSource?: object,
 *          budget?: object, diffMode?: string}} input
 */
export async function buildProvenance({
    args = {}, repo, indexer, staticSource = null, budget = null, diffMode = null,
    identity = null,
} = {}) {
    const target = parseDiffTarget(args);
    const kind = target.error ? 'unknown' : target.kind;

    const spec = args.range ? String(args.range) : null;

    // P0-2: prefer the bundle's single resolved identity. Re-deriving base and
    // head here is what left `target.base` / `target.head` null for every pull
    // request — the one target kind where the reader most needs to see which
    // two commits were actually compared — and reported a three-dot range's
    // LEFT ENDPOINT as its base when the effective base is the merge base.
    const baseSpec = identity?.baseSpec ?? (spec ? baseSpecOf(spec) : null);
    const headSpec = identity?.headSpec ?? (spec ? headSpecOf(spec) : null);

    const base = identity ? identity.effectiveBase : (spec ? await revParse(repo, baseSpec) : null);
    const head = identity ? identity.headSha : (spec ? await revParse(repo, headSpec) : null);

    const worktreeHead = identity?.worktree?.head ?? await revParse(repo, 'HEAD');
    let dirty = identity?.worktree?.dirty ?? null;
    if (dirty === null && !identity) {
        try {
            const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: repo });
            dirty = stdout.trim().length > 0;
        } catch {
            dirty = null;
        }
    }

    const indexedCommit = typeof indexer?.indexedCommit === 'function'
        ? await indexer.indexedCommit()
        : null;

    // Distance is measured to the reviewed BASE, not to the worktree: the base
    // is what the graph has to describe for a caller lookup to mean anything.
    const behindReviewedBase = await distance(repo, indexedCommit, base);

    return {
        target: {
            kind,
            spec,
            base,
            head,
            // Which git diff semantics produced the hunks. `a..b` reports the
            // base's own commits inverted when the base has moved on; `a...b`
            // compares against the merge base, which is what a review means.
            diffMode,
            // Which commit `base` actually is. A three-dot comparison's base is
            // the merge base; the range's left endpoint is a different commit
            // whenever the target branch has advanced.
            baseResolvedFrom: identity?.effectiveBaseSource ?? null,
            endpointBase: identity && identity.effectiveBase !== identity.baseSha
                ? identity.baseSha
                : undefined,
            ...(target.url ? { url: target.url } : {}),
        },
        // Everything the bundle could NOT pin down. Sections that depend on a
        // revision report themselves unavailable rather than answering about
        // the worktree, so this is the reader's index of what is missing.
        unresolved: identity?.unresolved?.length ? identity.unresolved : undefined,
        worktree: { head: worktreeHead, dirty },
        index: {
            commit: indexedCommit,
            parser: typeof indexer?.parserMode === 'function' ? indexer.parserMode() : null,
            graph: typeof indexer?.stats === 'function' ? indexer.stats() : null,
            behindReviewedBase,
            stale: behindReviewedBase === null ? null : behindReviewedBase > 0,
            note: indexedCommit
                ? 'the graph and retrieval sections describe this commit'
                : 'the commit this index was built from is not recorded, so its distance '
                    + 'from the reviewed base is unknown — treat graph and retrieval '
                    + 'sections as possibly describing other code',
        },
        staticAnalysis: staticSource
            ? {
                kind: staticSource.kind,
                rev: staticSource.rev ?? null,
                reason: staticSource.reason,
                ...(staticSource.missing?.length
                    ? { pathsAbsentAtRevision: staticSource.missing }
                    : {}),
            }
            : null,
        budget,
    };
}

/**
 * Render provenance to fit a grant, shedding decoration before facts.
 *
 * Found by the over-the-wire acceptance test at 1200 tokens: this section was
 * cut at a line boundary and left unparseable — the fourth section to hit that,
 * and the worst one to lose, since it is what tells a reader whether to trust
 * the others. Its critical facts are a dozen lines; its bulk is the graph stats
 * blob and the list of paths absent at the revision, both decoration.
 *
 * Tiers, in order: full; without the graph blob; without the absent-path list;
 * essentials only. Each tier is complete JSON, and what went is named.
 */
export function renderProvenance(provenance, maxTokens) {
    const fits = (obj) => Math.ceil(JSON.stringify(obj, null, 2).length / 4) <= maxTokens;

    if (fits(provenance)) return JSON.stringify(provenance, null, 2);

    const withoutGraph = {
        ...provenance,
        index: { ...provenance.index, graph: undefined },
        note: 'graph totals dropped to fit the token limit',
    };
    if (fits(withoutGraph)) return JSON.stringify(withoutGraph, null, 2);

    const withoutPaths = {
        ...withoutGraph,
        staticAnalysis: provenance.staticAnalysis
            ? { ...provenance.staticAnalysis, pathsAbsentAtRevision: undefined }
            : null,
        note: 'graph totals and the absent-path list dropped to fit the token limit',
    };
    if (fits(withoutPaths)) return JSON.stringify(withoutPaths, null, 2);

    // Essentials. Whether the index is stale, and which revisions are being
    // compared, are the last things to go — a reader who loses those cannot
    // tell whether any other section describes the code under review.
    const essentials = {
        target: {
            kind: provenance.target?.kind ?? null,
            base: provenance.target?.base ?? null,
            head: provenance.target?.head ?? null,
            diffMode: provenance.target?.diffMode ?? null,
        },
        worktree: provenance.worktree ?? null,
        index: {
            commit: provenance.index?.commit ?? null,
            behindReviewedBase: provenance.index?.behindReviewedBase ?? null,
            stale: provenance.index?.stale ?? null,
        },
        staticAnalysis: provenance.staticAnalysis
            ? { kind: provenance.staticAnalysis.kind, rev: provenance.staticAnalysis.rev ?? null }
            : null,
        note: 'reduced to essentials to fit the token limit: graph totals, absent paths, '
            + 'reasons and budget were dropped — raise --max-tool-tokens for the full block',
    };
    return JSON.stringify(essentials, null, 2);
}

export default { buildProvenance, baseSpecOf, renderProvenance };

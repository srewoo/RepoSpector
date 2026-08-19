/**
 * prSplitSuggester — "this could have been three PRs."
 *
 * PR-Agent asks the model for this (`can_be_split`, up to three sub-PRs). We do
 * it deterministically, for the same reason `ReviewOrchestrator.consolidateNarratives`
 * does its job without a model call: a BYOK user pays for every call, and the
 * question here is structural rather than semantic. Whether two file sets are
 * independent is a property of the paths and the imports between them — code can
 * decide it exactly, and unlike a model it cannot propose a split that shares a
 * file between two "independent" halves.
 *
 * ── The bar for saying anything ─────────────────────────────────────────────
 *
 * A split suggestion is unsolicited advice about how someone should have done
 * their work, arriving after they have already done it. It is worth saying only
 * when it is obviously true, so every threshold here is deliberately
 * conservative and the default answer is silence:
 *
 *   - the PR must be genuinely large (`minFiles`)
 *   - it must fall into at least two clusters, none trivial (`minClusterFiles`)
 *   - no cluster may import from another — a split that breaks the build is
 *     worse than no suggestion at all
 *
 * Test files travel with the code they test rather than forming a "tests"
 * cluster, since splitting an implementation from its tests is exactly the
 * wrong advice.
 */

import { isTestFile, testCandidatesForProduction } from '../services/testFileUtils.js';
import { addedLines } from './declaredSymbols.js';

export const SPLIT_DEFAULTS = Object.freeze({
    /** Below this, no PR is worth splitting regardless of shape. */
    minFiles: 10,
    /** A cluster smaller than this is noise, not a sub-PR. */
    minClusterFiles: 2,
    /** Never propose more than this many; beyond it the advice is unusable. */
    maxClusters: 4,
});

/** Strip a path to its directory, '' for a root-level file. */
function dirOf(path) {
    const i = String(path).lastIndexOf('/');
    return i === -1 ? '' : path.slice(0, i);
}

/**
 * The grouping key for a file: its second-level directory.
 *
 * Full directory paths fragment a PR into one cluster per leaf folder, which
 * proposes twelve "sub-PRs" for a change to twelve sibling modules. The top
 * level alone collapses everything under `src/`. Two levels is where real
 * feature boundaries usually sit (`src/billing`, `packages/web`).
 */
function clusterKeyFor(path) {
    const parts = dirOf(path).split('/').filter(Boolean);
    if (!parts.length) return '(root)';
    return parts.slice(0, 2).join('/');
}

/**
 * Does `patch` import from anything in `paths`?
 *
 * Deliberately crude: it matches a module specifier against the basename of each
 * candidate path. Crude in the SAFE direction — a false "yes" suppresses a split
 * suggestion, a false "no" would propose a split that breaks the build. When
 * unsure, stay quiet.
 */
function importsAnyOf(patch, paths) {
    if (!patch || !paths.length) return false;
    const specifiers = [];
    const patterns = [
        /(?:^|\s)import\s+[^;'"]*from\s+['"]([^'"]+)['"]/gm,   // js/ts
        /(?:^|\s)import\s+['"]([^'"]+)['"]/gm,                  // side-effect import
        /require\(\s*['"]([^'"]+)['"]\s*\)/gm,                  // cjs
        /(?:^|\s)from\s+([\w.]+)\s+import\b/gm,                 // python
        /(?:^|\s)import\s+"([^"]+)"/gm,                         // go
    ];
    for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(patch)) !== null) specifiers.push(m[1]);
    }
    if (!specifiers.length) return false;

    const basenames = new Set();
    for (const p of paths) {
        const base = String(p).split('/').pop().replace(/\.\w+$/, '');
        if (base) basenames.add(base);
    }

    // Compare against EVERY segment of the specifier, splitting on both `/` and
    // `.`. Taking only the last segment breaks on Python's dotted modules:
    // `from reporting.mod3 import x` yields `reporting.mod3`, whose trailing
    // `.mod3` looks like a file extension and gets stripped, leaving
    // `reporting` — so the real reference to `mod3` was invisible.
    //
    // Matching any segment over-matches slightly (a shared `utils` segment
    // counts as a reference), which errs toward suppressing a suggestion. That
    // is the safe direction.
    return specifiers.some((spec) => spec
        .split(/[/.]/)
        .filter(Boolean)
        .some(segment => basenames.has(segment)));
}

/**
 * Suggest independent sub-PRs, or nothing.
 *
 * @param {Object} prData - needs `files[].filename`, and `files[].patch` for the
 *        dependency check (absent patches make the check conservative, not wrong)
 * @param {Partial<typeof SPLIT_DEFAULTS>} [opts]
 * @returns {{splittable: boolean, reason: string|null,
 *            clusters: Array<{title: string, files: string[]}>}}
 */
export function suggestSplit(prData, opts = {}) {
    const o = { ...SPLIT_DEFAULTS, ...opts };
    const none = (reason) => ({ splittable: false, reason, clusters: [] });

    const files = (prData?.files || []).filter(f => f?.filename);
    if (files.length < o.minFiles) return none('too-few-files');

    const byName = new Map(files.map(f => [f.filename, f]));
    const production = files.filter(f => !isTestFile(f.filename));
    if (production.length < o.minClusterFiles * 2) return none('too-few-production-files');

    // ── Cluster production files, then attach each one's tests ──
    const clusters = new Map();
    for (const file of production) {
        const key = clusterKeyFor(file.filename);
        if (!clusters.has(key)) clusters.set(key, new Set());
        clusters.get(key).add(file.filename);
    }

    // A test file joins the cluster of the code it covers, not a "tests"
    // cluster — proposing that implementation and tests ship separately is
    // exactly the wrong advice.
    const testFiles = files.filter(f => isTestFile(f.filename));
    const unassignedTests = [];
    for (const test of testFiles) {
        let placed = false;
        for (const [, members] of clusters) {
            for (const member of members) {
                if (testCandidatesForProduction(member).some(c => c === test.filename)) {
                    members.add(test.filename);
                    placed = true;
                    break;
                }
            }
            if (placed) break;
        }
        // Fall back to path proximity before giving up on it.
        if (!placed) {
            const key = clusterKeyFor(test.filename);
            if (clusters.has(key)) clusters.get(key).add(test.filename);
            else unassignedTests.push(test.filename);
        }
    }

    let groups = [...clusters.entries()]
        .map(([title, members]) => ({ title, files: [...members] }))
        .filter(g => g.files.length >= o.minClusterFiles)
        .sort((a, b) => b.files.length - a.files.length);

    if (groups.length < 2) return none('single-cluster');

    // Every file must land somewhere. A suggestion that silently omits files
    // reads as "these can be dropped", so anything left over disqualifies it.
    const covered = new Set(groups.flatMap(g => g.files));
    const orphans = [...byName.keys()].filter(n => !covered.has(n));
    if (orphans.length || unassignedTests.length) return none('incomplete-coverage');

    if (groups.length > o.maxClusters) return none('too-fragmented');

    // ── Independence: no cluster may import from another ──
    for (const group of groups) {
        const others = groups.filter(g => g !== group).flatMap(g => g.files);
        // Strip the diff prefixes before matching. Run against the raw patch,
        // every pattern's leading `(?:^|\s)` fails on the `+` that starts an
        // added line, so nothing ever matched and every PR looked independent.
        // Added lines only, since it is the imports this PR INTRODUCES that
        // would couple the proposed halves.
        const patch = group.files.map(n => addedLines(byName.get(n)?.patch || '')).join('\n');
        if (importsAnyOf(patch, others)) return none('clusters-are-coupled');
    }

    return {
        splittable: true,
        reason: null,
        clusters: groups.map(g => ({ title: g.title, files: g.files.sort() })),
    };
}

/**
 * Render the suggestion, or '' when there is nothing worth saying.
 *
 * Phrased as an observation rather than an instruction: the work is already
 * done, and "you should have split this" helps nobody at review time. The useful
 * framing is that it can be reviewed in independent parts.
 *
 * @param {ReturnType<typeof suggestSplit>} split
 */
export function renderSplitSuggestion(split) {
    if (!split?.splittable || !split.clusters?.length) return '';

    const out = [
        '',
        '### This PR looks separable',
        '',
        `These ${split.clusters.length} groups share no imports with each other, so they `
        + 'could be reviewed — or in future shipped — independently:',
        '',
    ];
    for (const cluster of split.clusters) {
        const shown = cluster.files.slice(0, 6);
        const more = cluster.files.length - shown.length;
        out.push(`- **${cluster.title}** (${cluster.files.length} files): `
            + shown.map(f => `\`${f}\``).join(', ')
            + (more > 0 ? `, +${more} more` : ''));
    }
    return out.join('\n');
}

export default { suggestSplit, renderSplitSuggestion, SPLIT_DEFAULTS };

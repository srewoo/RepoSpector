import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowFile } from '../../../../src/services/HunkWindower.js';
import { getIndexer } from '../repo/indexer.js';
import { resolveRepo, REPO_ARG } from '../repo/resolveRepo.js';
import { capText, estimateTokens, allocateTokens } from './cap.js';
import { parseUnifiedDiff } from './unifiedDiff.js';

export { parseUnifiedDiff };
import { guarded } from './guarded.js';

const exec = promisify(execFile);

/** Which target the caller asked for, or a message naming both options. */
export function parseDiffTarget(args = {}) {
    // `diff` first: it is a diff the caller already holds, so honouring it
    // costs no network call and no token. A client with a GitLab or GitHub MCP
    // connected can fetch the diff there and hand it straight over, which is
    // why this is the preferred path rather than a fallback.
    if (args.diff) return { kind: 'diff', diff: String(args.diff) };
    if (args.pr_url) return { kind: 'pr', url: String(args.pr_url) };
    if (args.range) return { kind: 'range', range: String(args.range) };
    return {
        error: 'Pass one of: diff (unified diff text, e.g. fetched by another '
            + 'MCP server), pr_url (a GitHub PR or GitLab MR link), or range '
            + '(a local git revision range such as main..HEAD).',
    };
}

/**
 * The git arguments for a range, and which comparison they express.
 *
 * `git diff a..b` compares the two endpoints. When `a` has advanced since `b`
 * was cut, that reports `a`'s own commits INVERTED — as though the change under
 * review deleted them. A review asks "what did this branch do", which is the
 * three-dot form: `git diff a...b` diffs against the merge base. So a two-dot
 * range is normalised, and the mode is reported rather than assumed.
 *
 * A single revision is left exactly as given: `git diff HEAD` means "the
 * working tree against HEAD", which is a legitimate thing to review and is not
 * a range at all.
 */
export function diffRangeArgs(range) {
    const spec = String(range ?? '').trim();
    if (spec.includes('...')) {
        return { args: ['diff', '--unified=3', spec], mode: 'merge-base' };
    }
    if (spec.includes('..')) {
        const [base, head] = spec.split('..');
        return {
            args: ['diff', '--unified=3', `${base.trim()}...${(head || '').trim() || 'HEAD'}`],
            mode: 'merge-base',
        };
    }
    return { args: ['diff', '--unified=3', spec], mode: 'worktree' };
}

/** Local diff via git, so the common case needs no network and no token. */
async function localDiff(repo, range) {
    const { args } = diffRangeArgs(range);
    const { stdout } = await exec('git', args, {
        cwd: repo,
        maxBuffer: 64 * 1024 * 1024,
    });
    return parseUnifiedDiff(stdout);
}

/**
 * Real symbols touched in `filename`, annotated with their known callers.
 *
 * `getSymbolContext` takes a symbol NAME, not a file path — calling it with
 * `file.filename` (as this tool originally did) always returns null, since
 * no symbol is ever named after its own file. `KnowledgeGraphService
 * .getNodesByFile(filePath)` is the actual entry point for "what's in this
 * file"; it also returns the File node itself, which is not a symbol, so
 * nodes are filtered by `label !== 'File'` — the same discriminator
 * `CodeGraphPipeline._rebuildSymbolTable` uses to skip non-symbol nodes
 * (it excludes 'File', 'Community' and 'Process' labels; only 'File' can
 * appear here since `getNodesByFile` matches on `properties.filePath`, which
 * Community/Process nodes don't carry).
 *
 * Full `getSymbolContext` prose (impact + processes + community, several
 * paragraphs per symbol) is too verbose to embed for every symbol of every
 * window in a diff without crowding the patch itself out of the token cap,
 * so this renders a compact "name (called by: ...)" line per symbol instead
 * — strictly better than the always-null it replaces, and small enough that
 * `capList` keeps showing whole diff hunks rather than truncating mid-context.
 *
 * @param {{pipeline?: {graph?: import('../../../../src/services/KnowledgeGraphService.js').KnowledgeGraphService}}} indexer
 * @param {string} filename
 * @returns {string} empty string when the graph has nothing for this file
 */
export function graphAnnotationForFile(indexer, filename) {
    const graph = indexer?.pipeline?.graph;
    if (!graph?.getNodesByFile) return '';

    const symbolNodes = (graph.getNodesByFile(filename) || [])
        .filter((node) => node.label !== 'File');
    if (symbolNodes.length === 0) return '';

    const parts = symbolNodes
        .map((node) => {
            const name = node.properties?.name;
            if (!name) return null;
            const callers = (graph.getRelationshipsTo(node.id) || [])
                .filter((r) => r.type === 'CALLS')
                .map((r) => graph.getNode(r.sourceId)?.properties?.name)
                .filter(Boolean);
            const uniqueCallers = [...new Set(callers)].slice(0, 5);
            return uniqueCallers.length ? `${name} (called by: ${uniqueCallers.join(', ')})` : name;
        })
        .filter(Boolean);

    return parts.length ? `\n[graph] ${filename} symbols: ${parts.join('; ')}` : '';
}

/**
 * Resolve args to a flat list of changed files, whether the target is a
 * pull/merge request URL or a local revision range.
 *
 * Factored out of the tool handler so `review_pr` (task 8) can feed the same
 * parsed file list into its analyzers instead of the rendered text — one
 * fetch-and-parse path, one place for the shapes to be right.
 *
 * @param {{pr_url?: string, range?: string}} args
 * @param {{config: {repo: string, githubToken?: string|null, gitlabToken?: string|null}}} ctx
 * @returns {Promise<Array<{filename: string, patch: string, [key: string]: any}>>}
 */
export async function collectDiffFiles(args, ctx) {
    const { files } = await collectDiffWithMeta(args, ctx);
    return files;
}

/**
 * The changed files AND the revision they live at, when there is one.
 *
 * `collectDiffFiles` kept only `files` and discarded the rest of the pull
 * request, so the head sha — the revision whose file contents a reviewer
 * actually wants linted — was thrown away. Every `pr_url` review therefore
 * fell back to reading the patch's added lines even when the head had been
 * fetched and was sitting in the local repository. `headSha` is reported here;
 * whether it exists locally is `resolveReviewRev`'s question to answer.
 *
 * @returns {Promise<{files: Array<object>, headSha: string|null}>}
 */
export async function collectDiffWithMeta(args, ctx) {
    const target = parseDiffTarget(args);
    if (target.error) throw new Error(target.error);

    if (target.kind === 'diff') {
        return { files: parseUnifiedDiff(target.diff), headSha: null };
    }
    if (target.kind === 'range') {
        return { files: await localDiff(resolveRepo(ctx, args), target.range), headSha: null };
    }

    // Imported lazily: the PR services reach the network, and a local-range
    // call should not pay for loading them.
    const { PullRequestService } = await import(
        '../../../../src/services/PullRequestService.js'
    );
    const svc = new PullRequestService({
        githubToken: ctx.config.githubToken,
        gitlabToken: ctx.config.gitlabToken,
    });
    const pr = await svc.fetchPullRequest(target.url);
    return { files: pr?.files || [], headSha: pr?.headSha || null };
}

/**
 * Window each file's patch, template on its graph annotation, and cap to the
 * token budget — the exact rendering `GET_DIFF_CONTEXT_TOOL.handler` returns.
 *
 * Exported (rather than left inline in the handler) so a test can drive this
 * wiring directly with a hand-built file list, bypassing `localDiff` /
 * `collectDiffFiles` entirely. That matters because the fixture repo used to
 * verify `graphAnnotationForFile` is not tracked in git, so it cannot drive
 * a `range`-based end-to-end call — this is the seam that lets a test still
 * prove the annotation reaches actual tool output rather than only the
 * helper that produces it.
 *
 * @param {Array<{filename: string, patch?: string, additions?: number, deletions?: number}>} files
 * @param {*} indexer - as returned by `getIndexer(ctx)`, already `ensureIndexed`
 * @param {number} maxToolTokens
 * @returns {{text: string, shown: number, total: number, truncated: boolean}}
 */
export function renderDiffFiles(files, indexer, maxToolTokens) {
    const windows = [];
    for (const file of files) {
        for (const w of windowFile(file) || []) windows.push({ file, window: w });
    }
    const items = windows.length
        ? windows
        : files.map((f) => ({ file: f, window: null }));

    // Review value decides order, not git's alphabetical file order. A stable
    // sort keeps the original order within a tier, so hunks of one file stay
    // together and in sequence.
    const ordered = items
        .map((item, i) => ({ item, i, rank: reviewPriority(item.file.filename) }))
        .sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
        .map(({ item }) => item);

    const render = ({ file, window }) => {
        const neighbours = graphAnnotationForFile(indexer, file.filename);
        const patch = window?.patch || file.patch || '';
        // A file git considers binary has no textual hunks, so it rendered as a
        // bare `--- path` header with nothing under it — indistinguishable from
        // a bug that dropped the patch. Say which it is: RepoSpector's own
        // `src/utils/sarifExport.js` is treated as binary and appeared blank in
        // a real review.
        if (!patch.trim()) {
            const reason = file.binary === true || /^Binary files /m.test(String(file.rawPatch || ''))
                ? 'binary file — git reports no textual diff'
                : 'no textual hunks in this change (mode change, rename, or empty patch)';
            return `--- ${file.filename}\n[${reason}]${neighbours}`;
        }
        return `--- ${file.filename}\n${patch}${neighbours}`;
    };

    const bodies = ordered.map(render);
    const desired = bodies.map((b) => estimateTokens(b));
    const wanted = desired.reduce((a, b) => a + b, 0);

    if (wanted <= maxToolTokens) {
        return {
            text: bodies.join('\n\n'),
            shown: bodies.length,
            total: bodies.length,
            truncated: false,
        };
    }

    // Water-fill across windows instead of rendering greedily until the budget
    // runs out. Greedy-in-order let one 5KB prose line consume the whole grant
    // and drop the remaining 25 windows of a 22-file review; every changed file
    // trimmed beats one file whole and the rest invisible.
    //
    // A floor per window keeps a small share for every file even when one is
    // enormous, since "this file changed and here is a little of it" is still
    // the fact a reviewer needs.
    const floor = Math.max(1, Math.floor(maxToolTokens / (bodies.length * 4)));
    const granted = allocateTokens(desired, maxToolTokens, {
        floors: bodies.map(() => floor),
    });

    let trimmed = 0;
    const parts = bodies.map((body, i) => {
        const capped = capText(body, granted[i]);
        if (!capped.truncated) return capped.text;
        trimmed += 1;
        const header = `--- ${ordered[i].file.filename}`;
        return capped.text.startsWith(header)
            ? `${capped.text}\n[trimmed to fit the token limit — raise --max-tool-tokens for the full hunk]`
            : `${header}\n[trimmed to fit the token limit — raise --max-tool-tokens for the full hunk]`;
    });

    const header = `Showing all ${bodies.length} windows, ${trimmed} trimmed to fit `
        + '(token limit) — raise --max-tool-tokens for untrimmed hunks.\n\n';

    return {
        text: header + parts.join('\n\n'),
        shown: bodies.length,
        total: bodies.length,
        truncated: trimmed > 0,
    };
}

/**
 * Review value of a path, lowest first. Ordering only — nothing is excluded.
 *
 * A review bundle that must trim should trim the least consequential thing.
 * Generated output and lockfiles are last because a reviewer reads a diff of
 * them as a fact about a dependency change, not as code to judge; docs sit
 * between because prose is worth seeing but never at the cost of the source it
 * describes. The tiers are coarse on purpose: any finer judgement about which
 * source file matters most belongs to the reader, not to a sort key.
 *
 * `EXCLUDE_PATH_RE` in `src/utils/codeFileFilter.js` covers the same
 * generated/lockfile ground for indexing but is not exported, so the patterns
 * are restated here rather than reaching into that module's internals.
 */
export function reviewPriority(filename) {
    const name = String(filename || '');
    if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/i.test(name)) {
        return 3;
    }
    if (/(\.min\.(js|css)|\.map|\.snap)$/i.test(name)) return 3;
    if (/\.(md|markdown|mdx|txt|rst|adoc|asciidoc|org)$/i.test(name)) return 2;
    return 1;
}

export const GET_DIFF_CONTEXT_TOOL = {
    name: 'get_diff_context',
    description:
        'Return a diff as windowed hunks, each paired with its graph neighbours. Takes a diff you '
        + 'already have (preferred — pass `diff`, e.g. one fetched by a GitLab or GitHub MCP '
        + 'server, needing no token here), a pull request URL, or a local revision range. '
        + 'GITHUB_TOKEN / GITLAB_TOKEN are read from the environment only when fetching a URL.',
    inputSchema: {
        type: 'object',
        properties: {
            diff: {
                type: 'string',
                description: 'Unified diff text. Preferred: needs no network call and no token. '
                    + 'Use this when another MCP server has already fetched the diff.',
            },
            pr_url: { type: 'string', description: 'GitHub PR or GitLab MR URL.' },
            range: { type: 'string', description: 'Local git revision range, e.g. main..HEAD.' },
            ...REPO_ARG,
        },
    },

    handler: guarded('get_diff_context', async (args, ctx) => {
        const target = parseDiffTarget(args);
        if (target.error) {
            return { isError: true, content: [{ type: 'text', text: target.error }] };
        }

        const files = await collectDiffFiles(args, ctx);

        if (files.length === 0) {
            return {
                content: [{ type: 'text', text: 'No changed files found for that target.' }],
            };
        }

        const indexer = await getIndexer(ctx, resolveRepo(ctx, args));
        await indexer.ensureIndexed({});

        const capped = renderDiffFiles(files, indexer, ctx.config.maxToolTokens);

        return { content: [{ type: 'text', text: capped.text }] };
    }),
};

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowFile } from '../../../../src/services/HunkWindower.js';
import { getIndexer } from '../repo/indexer.js';
import { resolveRepo, REPO_ARG } from '../repo/resolveRepo.js';
import { capList } from './cap.js';
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

/** Local diff via git, so the common case needs no network and no token. */
async function localDiff(repo, range) {
    const { stdout } = await exec('git', ['diff', '--unified=3', range], {
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
    const target = parseDiffTarget(args);
    if (target.error) throw new Error(target.error);

    if (target.kind === 'diff') {
        return parseUnifiedDiff(target.diff);
    }
    if (target.kind === 'range') {
        return localDiff(resolveRepo(ctx, args), target.range);
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
    return pr?.files || [];
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

    return capList(
        windows.length ? windows : files.map((f) => ({ file: f, window: null })),
        ({ file, window }) => {
            const neighbours = graphAnnotationForFile(indexer, file.filename);
            const patch = window?.patch || file.patch || '';
            return `--- ${file.filename}\n${patch}${neighbours}`;
        },
        maxToolTokens,
    );
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

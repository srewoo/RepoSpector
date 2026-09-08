import { getIndexer } from '../repo/indexer.js';
import { resolveRepo, REPO_ARG } from '../repo/resolveRepo.js';
import { readRepoFiles } from '../repo/source.js';
import { parseDiffTarget, GET_DIFF_CONTEXT_TOOL, collectDiffFiles } from './diff.js';
import { buildRubric } from './rubric.js';
import { capText, estimateTokens, allocateTokens } from './cap.js';
import { guarded } from './guarded.js';

/**
 * Assemble the material for a review. Does NOT produce one.
 *
 * The orchestrator in the extension needs an LLM callable and this package has
 * none by design, so this hands Claude the evidence and lets Claude reason.
 * `static_analysis` is the part Claude cannot produce for itself — real linter,
 * tree-sitter and secret-scan output, no model involved.
 *
 * Every section is assembled defensively and, when a source fails, is reported
 * as unavailable with the reason. A silently absent section reads as "that check
 * passed", which is the worst possible failure for a security section.
 */

/**
 * A section may return either a string, or `{text, refit}` where `refit(tokens)`
 * re-renders it to fit a budget. Refitting beats truncating: cutting the joined
 * text drops whole trailing items (and can slice a JSON body mid-structure),
 * while a refit keeps every item and trims each one.
 */
async function safely(label, fn) {
    try {
        const value = await fn();
        if (value && typeof value === 'object' && typeof value.refit === 'function') {
            return { label, value: value.text, refit: value.refit, ok: true };
        }
        return { label, value, ok: true };
    } catch (error) {
        return { label, value: null, ok: false, reason: error.message };
    }
}

/**
 * `SecretsScanner.scanPRFiles` and `StaticAnalysisService.analyzeFiles` want
 * two different shapes and neither can be built from the other:
 *
 * - `scanPRFiles` reads `file.patch` (via `extractAddedLines`) and
 *   `file.filename` — exactly what `collectDiffFiles` already produces, so it
 *   is fed those entries directly.
 * - `analyzeFiles` reads `file.content` and `file.path` (StaticAnalysisService
 *   .js:166, `analyzeFile(file.content, {filePath: file.path, ...})`) — whole
 *   file CONTENTS, which a patch is not. Those come from the working tree via
 *   `readRepoFiles`, filtered down to the files the diff actually touched so
 *   only changed files are linted. A changed file that cannot be read (the
 *   range deleted it) is simply absent — you cannot lint a file that no
 *   longer exists.
 *
 * Neither analyzer's outcome depends on `status`: `collectDiffFiles` only
 * sets it for hunkless entries (renames, empty adds/deletes), leaving it
 * `undefined` for every ordinary changed file. `scanPRFiles` checks
 * `status === 'removed'` to skip deletions, but a deletion's patch has no
 * added lines anyway, so the result is identical either way. No logic here
 * branches on `status`.
 */
async function runStaticAnalysis(diffFiles, ctx, repo) {
    const { StaticAnalysisService } = await import(
        '../../../../src/services/StaticAnalysisService.js'
    );
    const { SecretsScanner } = await import(
        '../../../../src/services/SecretsScanner.js'
    );

    const secrets = new SecretsScanner().scanPRFiles(diffFiles);

    const changed = new Set(diffFiles.map((f) => f.filename));
    const { files: repoFiles } = await readRepoFiles(repo, {
        maxFiles: ctx.config.maxFiles,
    });
    const lintInput = repoFiles.filter((f) => changed.has(f.path));

    const svc = new StaticAnalysisService({});
    const lint = await svc.analyzeFiles(lintInput, {});

    return { lint, secrets, filesLinted: lintInput.map((f) => f.path) };
}

export const REVIEW_PR_TOOL = {
    name: 'review_pr',
    description:
        'Assemble everything needed to review a change: windowed diff hunks, graph context for the '
        + 'touched symbols, comparable code, covering tests, prior findings on this repository, and '
        + 'deterministic static-analysis output (linters, tree-sitter, secret scan). Give it a diff '
        + 'you already have (preferred — pass `diff`, e.g. fetched by a GitLab or GitHub MCP '
        + 'server, so no token is needed here), a pull request URL, or a local revision range. '
        + 'Returns this material for you to reason over — it does not itself write findings.',
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

    handler: guarded('review_pr', async (args, ctx) => {
        const target = parseDiffTarget(args);
        if (target.error) {
            return { isError: true, content: [{ type: 'text', text: target.error }] };
        }

        const repo = resolveRepo(ctx, args);
        const indexer = await getIndexer(ctx, repo);
        await indexer.ensureIndexed({});

        // Reuse get_diff_context rather than duplicating the fetch and the
        // windowing: one code path means one place for the shapes to be right.
        const diff = await GET_DIFF_CONTEXT_TOOL.handler(args, ctx);
        if (diff.isError) return diff;
        const hunks = diff.content[0].text;

        const diffFiles = await collectDiffFiles(args, ctx);

        const sections = [];
        sections.push({ label: 'rubric', value: buildRubric(), ok: true });
        sections.push({ label: 'hunks', value: hunks, ok: true });

        sections.push(await safely('similar_code', async () => {
            // retrieveContext returns a FLAT ARRAY of chunks. Reading `.chunks`
            // or `.results` off it yields undefined, and this section silently
            // shipped `[]` on every review. It only returns `{chunks, sources}`
            // when called with `formatOutput: true`, which this is not.
            const chunks = await indexer.rag.retrieveContext(
                indexer.repoId, hunks.slice(0, 2000), 5,
            );
            // Two levels of budgeting are needed. Fair allocation at assembly
            // stops this section starving the others; this refit stops one
            // chunk starving its neighbours. The chunker emits whole-file
            // chunks, and on a real repo a single 8KB doc file consumed the
            // whole section and the other four were cut off mid-JSON. Five
            // short excerpts beat one long one for judging convention, so
            // water-fill across chunks within whatever the section is granted.
            const list = Array.isArray(chunks) ? chunks : [];

            // Project to what a reviewer can act on; matchInfo and
            // scoreBreakdown are scorer internals that only burn context.
            const render = (sectionTokens) => {
                const bodies = list.map((c) => c.content ?? '');
                const granted = sectionTokens === null
                    ? bodies.map((b) => estimateTokens(b))
                    : allocateTokens(bodies.map((b) => estimateTokens(b)), sectionTokens);

                return JSON.stringify(list.map((c, i) => {
                    const body = capText(bodies[i], granted[i]);
                    return {
                        filePath: c.filePath,
                        startLine: c.startLine ?? null,
                        score: Number((c.relevanceScore ?? c.score ?? 0).toFixed(3)),
                        truncated: body.truncated || undefined,
                        content: body.text,
                    };
                }), null, 2);
            };
            return { text: render(null), refit: render };
        }));

        sections.push(await safely('graph_context', async () => {
            const stats = indexer.pipeline.getStats();
            return JSON.stringify({ graph: stats, parser: indexer.parserMode() }, null, 2);
        }));

        sections.push(await safely('covering_tests', async () => {
            const { TestCoverageBuilder } = await import(
                '../../../../src/services/TestCoverageBuilder.js'
            );
            const builder = new TestCoverageBuilder(indexer.pipeline.graph);
            return JSON.stringify(builder.build?.() ?? {}, null, 2);
        }));

        sections.push(await safely('prior_findings', async () => {
            const { PriorFindingService } = await import(
                '../../../../src/services/PriorFindingService.js'
            );
            const svc = new PriorFindingService({});
            const related = await svc.relatedPRs({ files: diffFiles }, {
                repoId: indexer.repoId,
                limit: 5,
            });
            return JSON.stringify(related || [], null, 2);
        }));

        sections.push(await safely('static_analysis', async () => {
            const result = await runStaticAnalysis(diffFiles, ctx, repo);
            return JSON.stringify(result, null, 2);
        }));

        // OSVService (dependency vulnerability lookups) is the one analysis
        // service with a Chrome dependency, and it is only cache persistence:
        // `chrome.storage.local.set`/`.get` (OSVService.js:252/263), called
        // directly with no injectable seam. Adding one would mean editing
        // src/services/OSVService.js, outside this plan's src/ budget. A
        // file-backed cache adapter exists (src/adapters/osvCache.js) ready
        // for the day OSVService grows a seam, but until then this section is
        // named as unavailable rather than silently missing or crashing.
        sections.push({
            label: 'dependencies',
            ok: false,
            reason: 'OSV cache requires extension storage; see plan Task 8',
        });

        const rendered = sections.map((s) => (s.ok
            ? `${s.label}:\n${s.value}`
            : `${s.label}: unavailable — ${s.reason}`));

        // Budget per section, not once over the concatenation. Capping the
        // joined text truncates from the end, so a large diff used to delete
        // every section after `hunks` — the reader cannot tell a cut section
        // from one that found nothing. Fair allocation caps the greedy section
        // instead and keeps every label present.
        const granted = allocateTokens(
            rendered.map((r) => estimateTokens(r)),
            ctx.config.maxToolTokens,
        );
        const parts = rendered.map((r, i) => {
            const section = sections[i];
            // A refittable section re-renders inside its grant rather than
            // being cut from the end. Leave room for the `label:\n` prefix.
            if (section.refit && estimateTokens(r) > granted[i]) {
                const overhead = estimateTokens(`${section.label}:\n`);
                const refitted = section.refit(Math.max(1, granted[i] - overhead));
                return `${section.label}:\n${refitted}`;
            }
            const capped = capText(r, granted[i]);
            return capped.truncated ? `${capped.text}\n[${capped.note}]` : capped.text;
        });
        return { content: [{ type: 'text', text: parts.join('\n\n') }] };
    }),
};

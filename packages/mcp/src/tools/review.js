import { getIndexer } from '../repo/indexer.js';
import { resolveRepo, REPO_ARG } from '../repo/resolveRepo.js';
import {
    parseDiffTarget, collectDiffWithMeta, diffRangeArgs, renderDiffFiles,
} from './diff.js';
import { touchedSymbolContext, coverageForDiff, retrievalQueryFor } from './reviewScope.js';
import { buildProvenance, renderProvenance } from './provenance.js';
import { buildDependencySection } from './dependencies.js';
import { findSurvivingReferences } from './survivors.js';
import { filesForStaticAnalysis, headSpecOf } from './reviewRevision.js';
import { applyPremiseGate, renderStaticSection } from './staticFindings.js';
import { lintTypeScript } from './tsLint.js';
import { buildRubric } from './rubric.js';
import {
    capText, estimateTokens, allocateTokens, renderJsonSection,
} from './cap.js';
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
 *   file CONTENTS, which a patch is not.
 *
 * Where those contents come from is the whole correctness question, and it used
 * to be answered wrong: `readRepoFiles` reads the WORKING TREE, so a review of
 * a range or a pull request was linted against whatever happened to be checked
 * out. On a real merge request that worktree was 537 commits behind the range's
 * base and the linter reported three findings on a schema the change DELETES.
 * `filesForStaticAnalysis` resolves the reviewed revision instead, and falls
 * back to the patch's own added lines — never to the worktree — when no
 * revision resolves. It reports which, so the section can say what it describes.
 *
 * Neither analyzer's outcome depends on `status`: `collectDiffFiles` only
 * sets it for hunkless entries (renames, empty adds/deletes), leaving it
 * `undefined` for every ordinary changed file. `scanPRFiles` checks
 * `status === 'removed'` to skip deletions, but a deletion's patch has no
 * added lines anyway, so the result is identical either way. No logic here
 * branches on `status`.
 *
 * Exported so a test can drive the real analyzers over a purpose-built repo
 * whose worktree disagrees with the branch under review — the shape of the
 * defect above, which no assertion on the whole bundle expresses as directly.
 */
export async function runStaticAnalysis(diffFiles, ctx, repo, args = {}, opts = {}) {
    const { StaticAnalysisService } = await import(
        '../../../../src/services/StaticAnalysisService.js'
    );
    const { SecretsScanner } = await import(
        '../../../../src/services/SecretsScanner.js'
    );

    const secrets = new SecretsScanner().scanPRFiles(diffFiles);

    const { files: lintInput, source } = await filesForStaticAnalysis(
        args, repo, diffFiles, { headSha: opts.headSha ?? null },
    );

    const svc = new StaticAnalysisService({});
    const raw = await svc.analyzeFiles(lintInput, {});

    // TypeScript gets a parsed pass too. `ASTLintEngine` claims only `.js`, so
    // on a TS codebase every finding above came from the regex rules — a
    // measured review produced `engines: {regex: 15}` and nothing parsed.
    const { findings: tsFindings, filesParsed: tsFilesParsed } = await lintTypeScript(lintInput);
    if (tsFindings.length > 0) {
        const byPath = new Map((raw.files || []).map((f) => [f.filePath, f]));
        for (const finding of tsFindings) {
            const file = byPath.get(finding.filePath);
            if (file) file.findings = [...(file.findings || []), finding];
        }
        raw.findings = [...(raw.findings || []), ...tsFindings];
        raw.totalFindings = raw.findings.length;
    }

    // The premise gate: a rule whose own construct is absent where it fired is
    // mis-mapped, not a defect. This module had one caller in the extension and
    // none here, which is how four wrong findings reached a reader under a
    // rubric calling them facts. Refusals are reported, not swallowed.
    const { lint, refuted, outsideDiff } = applyPremiseGate(raw, diffFiles);

    // Which engine actually produced these. The regex fallback and the AST
    // engine carry very different weight, and the section is read as ground
    // truth either way unless it says so.
    //
    // Counted off the findings and `individualResults`, NOT off the aggregated
    // per-file object — that object carries no engine field, so reading it
    // reported `{none: n}` for every review no matter which engine ran, which
    // is exactly the false comfort this attribution is meant to remove.
    const engines = {};
    const bump = (engine) => { engines[engine] = (engines[engine] || 0) + 1; };
    for (const finding of lint.findings || []) {
        if (finding?.engine) bump(finding.engine);
    }
    for (const file of lint.files || []) {
        // A file with no findings still ran an engine; name it, so a clean file
        // is distinguishable from one nothing could parse.
        if ((file?.findings || []).length > 0) continue;
        const eslint = file?.individualResults?.eslint;
        if (eslint) bump(eslint.engine || 'regex');
    }
    // Engines that RAN, not only engines that spoke. A clean tree-sitter pass
    // over 15 TypeScript files is a fact about the review; reporting nothing
    // let it read as "no AST analysis happened".
    if (tsFilesParsed > 0) {
        engines['tree-sitter'] = Math.max(engines['tree-sitter'] || 0, tsFilesParsed);
    }

    return {
        lint,
        secrets,
        source,
        engines,
        premiseRefuted: refuted,
        outsideDiff,
        filesLinted: lintInput.map((f) => f.path),
    };
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

        // `headSha` is kept, not discarded: for a pull request it is the
        // revision whose file contents the static section should read.
        const { files: diffFiles, headSha } = await collectDiffWithMeta(args, ctx);
        if (diffFiles.length === 0) {
            return {
                content: [{ type: 'text', text: 'No changed files found for that target.' }],
            };
        }

        // Which revision the static section settled on, filled in when that
        // section runs and reported by `provenance` below.
        let staticSource = null;

        // File contents at the reviewed revision, read ONCE and shared with
        // both the static section and the graph scoping. `removed` is decided
        // against them: guessing from patch text reported two kept symbols as
        // removed because a comment mentioning them was rewritten.
        let headContentByPath = null;
        try {
            const { files: headFiles } = await filesForStaticAnalysis(
                args, repo, diffFiles, { headSha },
            );
            headContentByPath = new Map(headFiles.map((f) => [f.path, f.content]));
        } catch {
            headContentByPath = null; // the section below reports the reason
        }

        // Resolved once and shared: the graph, coverage and retrieval sections
        // are all answers about the SAME touched symbols, and deriving them
        // separately is how three sections came to describe different things.
        //
        // The caps scale with the response budget rather than sitting at a
        // constant: 60 symbols was still `truncated: true` at a 90k grant.
        const symbolContext = touchedSymbolContext(indexer.pipeline.graph, diffFiles, {
            stats: indexer.pipeline.getStats(),
            parser: indexer.parserMode(),
            headContentByPath,
            maxSymbols: Math.max(40, Math.floor(ctx.config.maxToolTokens / 200)),
            maxEdges: Math.max(8, Math.floor(ctx.config.maxToolTokens / 4000)),
        });

        const sections = [];
        sections.push({ label: 'rubric', value: buildRubric(), ok: true });

        // Rendered through `renderDiffFiles` directly, and REFITTABLE, rather
        // than borrowing `get_diff_context`'s finished string. That string is
        // fitted to the whole `--max-tool-tokens`, and the bundle then capped
        // it again to this section's ~50% share with a line-boundary cut — so
        // at 12000 tokens on a 22-file review the section showed 15 of 26
        // windows and the other 11 were simply gone. Budgeting the same text
        // twice, the second time bluntly, is how whole files disappear.
        const renderHunks = (tokens) => renderDiffFiles(
            diffFiles, indexer, tokens === null ? ctx.config.maxToolTokens : tokens,
        ).text;
        sections.push({
            label: 'hunks',
            value: renderHunks(null),
            refit: renderHunks,
            ok: true,
        });

        sections.push(await safely('similar_code', async () => {
            // retrieveContext returns a FLAT ARRAY of chunks. Reading `.chunks`
            // or `.results` off it yields undefined, and this section silently
            // shipped `[]` on every review. It only returns `{chunks, sources}`
            // when called with `formatOutput: true`, which this is not.
            //
            // The QUERY is built from the touched symbols and paths, not from
            // the rendered `hunks` text. Querying the rendering meant that on a
            // 22-file review the search terms were a prose file's
            // auto-generated header, and not one of the five hits touched a
            // symbol the change deleted.
            const chunks = await indexer.rag.retrieveContext(
                indexer.repoId, retrievalQueryFor(diffFiles, symbolContext), 5,
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

        // Callers and callees of the touched symbols — what the rubric has
        // always promised. This used to be `pipeline.getStats()`: repo-wide
        // node and edge counts, which answer nothing about a change. Those
        // totals are still here, as provenance, under `graph`.
        sections.push(await safely('graph_context', async () => {
            // Refittable: once the symbol cap scaled with the budget this
            // section overran and was cut at a line boundary, leaving JSON a
            // reader cannot parse. `removed` and the basis stay whatever the
            // grant; `symbols` sheds.
            const { symbols, ...head } = symbolContext;
            const render = (tokens) => renderJsonSection(
                head,
                [{ key: 'symbols', items: symbols }],
                tokens === null ? Number.MAX_SAFE_INTEGER : tokens,
            );
            return { text: render(null), refit: render };
        }));

        // Coverage OF THE CHANGE. `TestCoverageBuilder.build()` reports the
        // whole graph — on a real review, `coverageRatio: 0.04` across 360 test
        // files, true and useless — and says nothing about the five test files
        // that review deleted. Both are reported now: the scoped answer first,
        // the repo-wide ratio kept as background.
        sections.push(await safely('covering_tests', async () => {
            const scoped = coverageForDiff(indexer.pipeline.graph, diffFiles);
            let repoWide = null;
            try {
                const { TestCoverageBuilder } = await import(
                    '../../../../src/services/TestCoverageBuilder.js'
                );
                repoWide = new TestCoverageBuilder(indexer.pipeline.graph).build?.() ?? null;
            } catch {
                repoWide = null; // background only; never fail the section for it
            }
            const { covered, untested, ...head } = scoped;
            const render = (tokens) => renderJsonSection(
                { ...head, repoWide },
                // Priority order: the deleted test files are in `head` and
                // never shed; per-symbol coverage goes before the untested
                // list, which on a large diff is the longest and least
                // actionable part.
                [{ key: 'covered', items: covered }, { key: 'untested', items: untested }],
                tokens === null ? Number.MAX_SAFE_INTEGER : tokens,
            );
            return { text: render(null), refit: render };
        }));

        // The one section that looks OUTSIDE the diff, and the only one that
        // can: a deleted symbol still referenced by a file this change never
        // opened is invisible to every diff-scoped section, and that shape
        // accounted for four of six findings on the review this bundle was
        // rebuilt for.
        sections.push(await safely('surviving_references', async () => {
            const names = symbolContext.removed.map((r) => r.name);
            if (names.length === 0) {
                return JSON.stringify({
                    references: [],
                    note: 'this change removes no symbol the graph knows about, so there is '
                        + 'nothing to look for elsewhere',
                }, null, 2);
            }
            const rev = staticSource?.rev || (args.range ? headSpecOf(args.range) : 'HEAD');
            const found = await findSurvivingReferences(
                repo, rev, names, diffFiles.map((f) => f.filename).filter(Boolean),
            );
            const { references, ...head } = found;
            const render = (tokens) => renderJsonSection(
                head,
                [{ key: 'references', items: references }],
                tokens === null ? Number.MAX_SAFE_INTEGER : tokens,
            );
            return { text: render(null), refit: render };
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
            const list = Array.isArray(related) ? related : [];
            // A bare `[]` cannot say whether anything was checked — and here
            // nothing can be. `PriorFindingService` reads a
            // `feedbackCollector.getLedger()`; this server wires no collector,
            // and being keyless it authors no findings to record in one, so the
            // section is structurally empty rather than empty today. Saying
            // "none recorded for this repository" implied a store that happens
            // to be empty, which is a different and more reassuring claim.
            return JSON.stringify({
                related: list,
                note: list.length === 0
                    ? 'unavailable: no feedback ledger is wired into this server (and it '
                        + 'authors no findings to record in one), so a repeated finding '
                        + 'cannot be detected at all — this is not evidence that none repeat'
                    : `${list.length} prior finding set(s) touch these files`,
            }, null, 2);
        }));

        const staticSection = await safely('static_analysis', async () => {
            const result = await runStaticAnalysis(diffFiles, ctx, repo, args, { headSha });
            staticSource = result.source;
            // Refittable: at a 90k budget the raw object still overran and was
            // cut at a line boundary, which deleted `engines`, `premiseRefuted`
            // and `source` — the fields that qualify everything above them —
            // while keeping per-file analyzer dumps. It now sheds findings from
            // the tail instead, and stays parseable at any grant.
            const render = (tokens) => renderStaticSection(
                result, tokens === null ? Number.MAX_SAFE_INTEGER : tokens,
            );
            return { text: render(null), refit: render };
        });
        sections.push(staticSection);

        // OSV dependency lookups. `OSVService` now takes an injectable cache
        // (`options.cache`), so the file-backed adapter written for this purpose
        // can finally be handed over — before that, every bundle reported this
        // section as unavailable. It runs only when the change actually touches
        // a dependency manifest: a network call on a change that alters no
        // dependency buys nothing, and "not applicable" is a real answer.
        sections.push(await safely('dependencies', async () => {
            const { DependencyAnalyzer } = await import(
                '../../../../src/services/DependencyAnalyzer.js'
            );
            const analyzer = new DependencyAnalyzer({});
            const manifests = diffFiles.filter(
                (f) => f.filename && analyzer.isDependencyFile?.(f.filename),
            );
            const { files: manifestFiles } = manifests.length > 0
                ? await filesForStaticAnalysis(args, repo, manifests, { headSha, filter: 'none' })
                : { files: [] };

            const { createFileOsvCache } = await import('../adapters/osvCache.js');
            const { OSVService } = await import('../../../../src/services/OSVService.js');
            const osv = new OSVService({ cache: createFileOsvCache(indexer.snapshotPath) });
            if (manifests.length > 0) await osv.loadCache();

            const section = await buildDependencySection({
                manifests, files: manifestFiles, analyzer, osv,
            });
            if (section.lookup?.performed) await osv.persistCache();
            return JSON.stringify(section, null, 2);
        }));

        // Assembled last, because it describes everything above it — including
        // which revision the static section settled on.
        sections.push(await safely('provenance', async () => {
            const p = await buildProvenance({
                args,
                repo,
                indexer,
                staticSource,
                diffMode: args.range ? diffRangeArgs(args.range).mode : null,
                budget: { maxToolTokens: ctx.config.maxToolTokens },
            });
            // Refittable, and the last section that should ever be cut: it is
            // what tells the reader whether to trust the rest. Shedding order
            // is graph totals, then absent paths, then everything but the
            // revisions and the staleness flag.
            const render = (tokens) => renderProvenance(
                p, tokens === null ? Number.MAX_SAFE_INTEGER : tokens,
            );
            return { text: render(null), refit: render };
        }));

        const rendered = sections.map((s) => (s.ok
            ? `${s.label}:\n${s.value}`
            : `${s.label}: unavailable — ${s.reason}`));

        // Budget per section, not once over the concatenation. Capping the
        // joined text truncates from the end, so a large diff used to delete
        // every section after `hunks` — the reader cannot tell a cut section
        // from one that found nothing. Fair allocation caps the greedy section
        // instead and keeps every label present.
        //
        // `hunks` carries a floor, because equal shares are wrong when one
        // section IS the evidence: an eighth of the budget left room for a
        // single window of a 22-file review, and the window it kept was a
        // prose file's. Everything else still water-fills what remains.
        const HUNKS_SHARE = 0.5;
        const floors = sections.map((s) => (s.label === 'hunks'
            ? Math.floor(ctx.config.maxToolTokens * HUNKS_SHARE)
            : 0));
        const granted = allocateTokens(
            rendered.map((r) => estimateTokens(r)),
            ctx.config.maxToolTokens,
            { floors },
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

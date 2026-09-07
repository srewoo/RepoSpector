#!/usr/bin/env node
/**
 * Run the REAL review pipeline over a cached corpus and record what it found.
 *
 *   node eval/run.js --corpus eval/corpus/public-prs.json
 *
 * This is deliberately not a reimplementation. It calls the same
 * StaticAnalysisService, MultiPassReviewEngine, citation enforcer, evidence
 * gates and posting policy the extension calls, in the same order, with the
 * same defaults — so a number produced here describes the shipped reviewer and
 * not a lookalike. The only things stubbed are the two `chrome.*` touchpoints,
 * which are already try/catch-guarded in the services themselves.
 *
 * Output is written back into the corpus as `predictions`, ready for
 * `eval/score.js` (recall, immediately) and human adjudication (precision).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

import { env, requireKey } from './lib/env.js';
import { StaticAnalysisService } from '../src/services/StaticAnalysisService.js';
import { MultiPassReviewEngine } from '../src/services/MultiPassReviewEngine.js';
import { FindingVerificationService } from '../src/services/FindingVerificationService.js';
import { MultiFinderService } from '../src/services/MultiFinderService.js';
import { LLMService } from '../src/services/LLMService.js';
import { buildCanonicalFindings } from '../src/utils/findingsFlatten.js';
import { enforceCitations } from '../src/utils/citationEnforcer.js';
import { partitionForPosting } from '../src/utils/reviewPostingPolicy.js';
import { resolveBudget } from '../src/utils/reviewContextBudget.js';
import { applyFilterMode } from '../src/utils/findingFilterMode.js';
import { decideFailure } from '../src/utils/failLevel.js';
import { ExternalFindingsService } from '../src/services/ExternalFindingsService.js';
import { buildFileContext, buildDeclarations, alignmentReport } from './lib/fileContext.js';
import { graphFindingsForCase } from './lib/graphContext.js';

export function parseArgs(argv) {
    const args = {
        corpus: 'eval/corpus/public-prs.json', limit: Infinity, only: null,
        finderMode: 'default', multiFinder: true, finderRounds: 2, label: null,
        // Defaults match the shipped defaults. A harness that runs a
        // configuration nobody ships measures a product nobody has.
        dynamicContext: true, filterMode: 'added', failLevel: 'high',
        // Graph findings are on by default, matching the shipped reviewer
        // (see GraphImpactFindingsService wiring in prReviewHandlers).
        graphFindings: true,
        // A full run is hours of LLM time. Resume is the difference between a
        // crash costing one case and costing the whole run.
        resume: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--corpus') args.corpus = argv[++i];
        else if (a === '--limit') args.limit = Number(argv[++i]);
        else if (a === '--only') args.only = argv[++i];
        else if (a === '--finder-mode') args.finderMode = argv[++i];
        else if (a === '--no-multi-finder') args.multiFinder = false;
        else if (a === '--finder-rounds') args.finderRounds = Number(argv[++i]);
        else if (a === '--label') args.label = argv[++i];
        else if (a === '--resume') args.resume = true;
        else if (a === '--no-dynamic-context') args.dynamicContext = false;
        else if (a === '--no-graph-findings') args.graphFindings = false;
        else if (a === '--filter-mode') args.filterMode = argv[++i];
        else if (a === '--fail-level') args.failLevel = argv[++i];
        else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`Unknown argument: ${a}`);
    }
    return args;
}

/** Flatten a finding to the scoreable record, keeping enough to adjudicate it. */
function toPrediction(f, posted) {
    return {
        file: f.file || f.filePath || '',
        line: f.line ?? null,
        severity: f.severity ?? null,
        title: (f.title || f.message || '').slice(0, 200),
        description: (f.description || '').slice(0, 400),
        suggestion: (f.suggestion || '').slice(0, 300),
        rule: f.rule ?? f.ruleId ?? null,
        source: f.source ?? null,
        // Whether a reviewer would actually SEE this inline, per the posting
        // policy. Precision on posted findings is the number that matters;
        // precision over everything generated is the diagnostic.
        posted,
    };
}

/**
 * Review one case. Exported so the harness's own wiring is testable: the failure
 * mode this guards against is a run that reports "file context supplied" while
 * passing an empty Map to the engine, which no end-to-end score would reveal.
 */
export async function reviewOne(kase, { llm, settings, opts }) {
    const prData = kase.prData;

    // Network-dependent analyzers off: OSV and endoflife.date measure
    // dependency hygiene, not review quality, and would make the run
    // non-reproducible on a plane.
    const staticService = new StaticAnalysisService({
        enableDependency: false,
        enableEOL: false,
    });

    const staticResult = await staticService.analyzePullRequest(prData, {
        enableESLint: true,
        enableSemgrep: true,
        enableDependency: false,
        severityThreshold: 'all',
    });

    // ── File context, declarations, external findings, graph findings ──────
    //
    // Everything below this comment was previously ABSENT from the harness, so
    // every feature that depends on seeing the file rather than the hunk went
    // untested by the suite that exists to test it, and the documented
    // `REPOSPECTOR_CONTEXT_PROFILE` A/B was guaranteed to produce a null diff
    // (see reviewContextBudget.js's header, and eval/fetch-content.js). The
    // graph is the newest addition: `graphContext.js` builds an in-memory,
    // regex-extracted code graph from this case's own `fileContents` and turns
    // it into findings via `GraphImpactFindingsService`. It supplies graph
    // FINDINGS, not the graph prompt CONTEXT that `reviewContextBudget.js`
    // still cannot exercise here — see that file's header for the boundary.
    const { fileContext, stats: fcStats } = buildFileContext(kase);
    const { declarationsByFile, stats: declStats } = buildDeclarations(fileContext);

    // Alignment is the falsifiability check. Cached content that disagrees with
    // the cached patch is refused by `verifyAlignment` — correctly — and the run
    // then quietly falls back to patch-only. Recording it per case means a corpus
    // that has silently gone stale shows up as a number instead of as an
    // unexplained score drop.
    const alignment = alignmentReport(kase, fileContext);

    // External scanner findings, when the case carries a report. Cases without
    // one exercise the same path with zero sources, which is the common case in
    // production too.
    let external = null;
    if (kase.externalReports?.length) {
        external = await new ExternalFindingsService({}).collect({
            prUrl: kase.url,
            prData,
            reports: kase.externalReports,
            options: { checkAnnotations: false },   // no network in the harness
        });
    }

    // Graph findings are computed here but injected AFTER the gates, below —
    // not into staticFindings — matching where the shipped handler's
    // `3a-graph` block appends them (after `verifier.verify()`).
    const graph = opts.graphFindings !== false ? graphFindingsForCase(kase) : { findings: [], stats: null };
    const staticFindings = [
        ...staticResult.findings,
        ...(external?.findings || []),
    ];

    const engine = new MultiPassReviewEngine({ llmService: llm });
    const result = await engine.execute(
        prData,
        {
            staticFindings,
            contextBudget: opts.contextBudget,
            fileContext,
            declarationsByFile,
            dynamicContext: { enabled: opts.dynamicContext !== false },
        },
        settings,
        {
            focusAreas: ['security', 'bugs', 'performance', 'style'],
            maxConcurrent: 3,
            // Was 20 — a fifth of what the extension sends (prReviewHandlers uses
            // `options.maxFiles || 100`). Every number this harness produced was
            // therefore measuring a reviewer that sees far less of the PR than the
            // shipped one does, which is the exact failure this file's own header
            // warns about ("a number produced here describes the shipped reviewer
            // and not a lookalike").
            maxFilesToReview: 100,
        },
        null,
    );

    // Same post-processing order as prReviewHandlers, same defaults.
    let findings = buildCanonicalFindings(result.perFileFindings || [], staticFindings);
    const baseline = findings.length;

    // Multi-finder. This was MISSING from the first version of this runner while
    // being ON by default in the shipped handler, so the 6-findings-per-5-PRs
    // figure it produced measured a pipeline nobody runs. Any eval that does not
    // mirror the shipped defaults is measuring a different product.
    let finderAdded = 0;
    if (opts.multiFinder) {
        const finder = new MultiFinderService({ llmService: llm });
        const fres = await finder.findAdditional(findings, {
            prData,
            settings,
            maxRounds: opts.finderRounds,
            promptMode: opts.finderMode,
        });
        findings = [...findings, ...fres.findings];
        finderAdded = fres.stats.added;
    }
    const generated = findings.length;

    findings = enforceCitations(findings).findings;

    const verifier = new FindingVerificationService({ llmService: llm });
    const verified = await verifier.verify(findings, {
        prData,
        settings,
        llmRefutation: false,   // shipped default: deterministic gates only
    });
    findings = verified.findings;

    // Re-add external scanner findings after the gates, exactly as the handler
    // does. Those gates demand cited evidence from findings a MODEL asserted; a
    // gosec match is not an assertion, and it carries no `evidence` field to
    // cite, so judging it by that standard drops it every time.
    //
    // Without this the harness scored external findings as if the extension
    // suppressed them, when the extension does not — the precise class of
    // divergence this file's header warns about ("a number produced here
    // describes the shipped reviewer and not a lookalike").
    if (external?.findings?.length) {
        const present = new Set(findings.map(f => `${f.file || f.filePath}:${f.line}:${f.ruleId || f.rule}`));
        const readd = external.findings.filter(
            f => !present.has(`${f.filePath}:${f.line}:${f.ruleId}`)
        );
        findings = [...findings, ...readd];
    }

    // Graph findings enter AFTER the gates, exactly where the shipped handler
    // puts them (its `3a-graph` block runs after `verifier.verify()`).
    //
    // Routing them through the gates instead would diverge from production in
    // two measurable ways. First, `enforceCitations` and the evidence/
    // speculation gates judge findings a MODEL asserted; a graph finding is a
    // fact read from the call graph, so those gates drop it and the harness
    // would score the reviewer as suppressing findings it actually posts.
    // Second, `normalizeStaticFinding` (`src/utils/findingsFlatten.js:69`)
    // relabels every non-'external' source to 'static', so `source: 'graph'`
    // would be erased and every exported prediction would misreport where it
    // came from.
    if (graph.findings.length) {
        findings = [...findings, ...graph.findings];
    }

    // Diff scope, exactly as the handler applies it. Without this the harness
    // scored findings the extension would never have shown a reviewer, which
    // inflates recall and makes precision incomparable to the shipped product.
    const filtered = applyFilterMode(findings, prData.files || [], { mode: opts.filterMode });
    findings = filtered.kept;

    // The merge gate. Recorded rather than acted on — the harness has no PR to
    // block — but a run that cannot say whether it would have blocked cannot be
    // used to tune the threshold.
    const failDecision = decideFailure(findings, { failLevel: opts.failLevel });

    const policy = partitionForPosting(findings, { blockingOnlyInline: true, maxInline: 15 });
    const postedKeys = new Set(policy.inline.map(f => `${f.file || f.filePath}:${f.line}`));

    return {
        predictions: findings.map(f => toPrediction(f, postedKeys.has(`${f.file || f.filePath}:${f.line}`))),
        stats: {
            baseline,
            finderAdded,
            finderMode: opts.multiFinder ? opts.finderMode : 'off',
            generated,
            afterGates: findings.length,
            droppedByGates: verified.stats.dropped,
            duplicates: verified.stats.duplicates,
            evidenceRefuted: verified.stats.evidenceRefuted,
            inline: policy.stats.inline,
            demotedToSummary: policy.stats.demotedToSummary,
            staticFindings: staticResult.findings.length,
            externalFindings: external?.findings?.length ?? 0,
            externalSources: external?.stats?.sources ?? 0,
            graphFindings: graph.findings.length,
            graphStats: graph.stats,

            // ── Context actually supplied (was: none of it) ──
            filesWithContent: fcStats.withContent,
            filesWithoutContent: fcStats.withoutContent,
            contentBytes: fcStats.bytes,
            testFilesFound: fcStats.testsFound,
            declarationFiles: declStats.files,
            declarations: declStats.declarations,
            // Alignment gates hunk expansion. `patchesAligned === 0` on a corpus
            // that HAS content means the content is stale and every context
            // feature is silently off — the one number to read before trusting a
            // comparison between two runs.
            patchesAligned: alignment.aligned,
            patchesMisaligned: alignment.misaligned,
            misalignmentReasons: alignment.reasons.slice(0, 3),

            // ── Policies applied ──
            filterMode: filtered.stats.mode,
            filteredOut: filtered.stats.droppedOutsideDiff + filtered.stats.droppedUnknownFile,
            relocated: filtered.stats.relocated,
            failLevel: failDecision.level,
            wouldBlock: failDecision.blocks,

            tokens: result.tokenUsage,
            hunkWindowing: !!settings.hunkWindowing,
            contextProfile: opts.contextProfile,
            // Proxy for LLM call count: one per-file/window pass + one aggregation
            // call. If windowing engaged, this rises for the case containing the
            // split file relative to the control run.
            reviewUnits: result.reviewUnits,
        },
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log([
            'Usage: node eval/run.js [options]',
            '',
            '  --corpus <file>       Corpus to review (default eval/corpus/public-prs.json)',
            '  --resume              Skip cases already reviewed under this configuration',
            '  --limit <n>           Review at most n cases',
            '  --only <case-id>      Review just one case',
            '  --finder-mode <m>     Multi-finder rule set: default | recall',
            '  --no-multi-finder     Disable the multi-finder pass',
            '  --finder-rounds <n>   Multi-finder rounds (default 2)',
            '  --no-dynamic-context  Disable hunk expansion (A/B against the default)',
            '  --no-graph-findings   Disable graph findings (A/B against the default)',
            '  --filter-mode <m>     added | diff_context | file | nofilter (default added)',
            '  --fail-level <l>      none | info | low | medium | high | critical | any (default high)',
            '',
            'File context comes from the corpus. Populate it first:',
            '  node eval/fetch-content.js --corpus <file>',
            'Without it every context feature is inactive and the run says so.',
        ].join('\n'));
        return;
    }

    const vars = env();
    const apiKey = requireKey(vars, 'OPENAI_API_KEY', 'Add OPENAI_API_KEY to .env.');
    const model = vars.OPENAI_MODEL || 'gpt-4.1-mini';
    // An eval-only env override threaded straight into `settings`, which
    // MultiPassReviewEngine already reads as
    // `settings?.hunkWindowing ?? HUNK_WINDOWING` — the shipped default stays
    // false in constants.js regardless of what this run used.
    const hunkWindowing = process.env.REPOSPECTOR_HUNK_WINDOWING === '1';

    // REPOSPECTOR_CONTEXT_PROFILE: 'legacy' selects the pre-raise budget from
    // reviewContextBudget.js; anything else (including unset) is 'default'.
    //
    // PARTIALLY meaningful now, and it is worth being exact about which part.
    // `reviewOne` supplies `fileContext`, so the keys governing full-file context
    // and hunk expansion (`fullFileFetch`, `callerSource`) genuinely differ
    // between the two profiles and an A/B over them is real. `ragChunks`,
    // `ragChunkChars` and `graphContextChars` are still INERT here: they gate
    // retrieval and code-graph slices, which need an INDEXED repository, and the
    // harness has only the changed files. Building a graph from those alone would
    // be a graph of 12 files presented as a graph of the repo — a worse lie than
    // the absence.
    //
    // So: read a profile comparison as a statement about file context, not about
    // retrieval. See eval/README.md.
    const contextProfile = process.env.REPOSPECTOR_CONTEXT_PROFILE === 'legacy' ? 'legacy' : 'default';
    const contextBudget = resolveBudget({ profile: contextProfile });
    const settings = { provider: 'openai', model: `openai:${model}`, apiKey, hunkWindowing };

    const path = resolve(args.corpus);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const cases = Array.isArray(parsed) ? parsed : parsed.cases;

    // A case already carrying runStats from THIS configuration is finished.
    // Comparing the finder mode too means `--resume` after a config change
    // re-runs the affected cases instead of silently mixing two pipelines into
    // one score — which would be a corpus nobody could interpret.
    const isDone = (c) => !!c.runStats
        && c.runStats.baseline !== undefined
        && c.runStats.finderMode === (args.multiFinder ? args.finderMode : 'off')
        && !!c.runStats.hunkWindowing === hunkWindowing
        && c.runStats.contextProfile === contextProfile
        // The context switches belong in the resume key for the same reason the
        // finder mode does: without them `--resume` after flipping one of these
        // silently mixes two pipelines into one score, producing a corpus nobody
        // can interpret. `filesWithContent === undefined` also re-runs every case
        // scored before file context existed at all.
        && c.runStats.filesWithContent !== undefined
        && c.runStats.filterMode === args.filterMode
        && c.runStats.failLevel === args.failLevel;

    const all = cases.filter(c => (args.only ? c.id === args.only : true));
    const skipped = args.resume ? all.filter(isDone) : [];
    const selected = all
        .filter(c => !(args.resume && isDone(c)))
        .slice(0, args.limit);

    if (skipped.length) {
        console.log(`Resuming: ${skipped.length} case(s) already done, ${selected.length} to go`);
    }

    console.log(
        `Model: openai:${model}   Cases: ${selected.length}   ` +
        `Multi-finder: ${args.multiFinder ? `${args.finderMode} × ${args.finderRounds} round(s)` : 'off'}   ` +
        `Hunk windowing: ${hunkWindowing ? 'ON (REPOSPECTOR_HUNK_WINDOWING=1)' : 'off'}   ` +
        `Context profile: ${contextProfile}${contextProfile === 'legacy' ? ' (REPOSPECTOR_CONTEXT_PROFILE=legacy)' : ''} ` +
        `[ragChunks=${contextBudget.ragChunks} graphContextChars=${contextBudget.graphContextChars}] ` +
        `— RAG/graph keys inert (no indexed repo offline); file-context keys active\n`
    );

    // A run without cached content is a run with every context feature off. That
    // was the silent status quo; making it loud is the point. Refusing outright
    // would be wrong — a patch-only baseline is a legitimate thing to measure —
    // but it must never be mistaken for a measurement of the shipped reviewer.
    const withContent = selected.filter(c => c.fileContents && Object.keys(c.fileContents).length).length;
    // `selected.length` guard: with nothing selected (--limit 0, or --resume on a
    // finished corpus) `withContent` is trivially 0, and warning about missing
    // content then is a false alarm that teaches the reader to ignore the warning.
    if (selected.length > 0 && withContent === 0) {
        console.log(
            `⚠️  NO cached file content in this corpus. Full-file context and hunk\n`
            + `    expansion are INACTIVE for this run, so it measures the patch-only\n`
            + `    pipeline — not what the extension ships. Populate it with:\n`
            + `      node eval/fetch-content.js --corpus ${args.corpus}\n`
        );
    } else if (withContent < selected.length) {
        console.log(`ℹ️  ${withContent}/${selected.length} case(s) have cached file content; the rest run patch-only.\n`);
    }

    const llm = new LLMService();
    const totals = {
        baseline: 0, finderAdded: 0, generated: 0, afterGates: 0, inline: 0,
        tokensIn: 0, tokensOut: 0,
        aligned: 0, misaligned: 0, filteredOut: 0, relocated: 0, wouldBlock: 0,
    };

    for (const kase of selected) {
        const started = Date.now();
        process.stdout.write(`${kase.id} … `);
        try {
            const { predictions, stats } = await reviewOne(kase, { llm, settings, opts: { ...args, contextProfile, contextBudget } });
            kase.predictions = predictions;
            kase.runStats = stats;

            totals.baseline += stats.baseline;
            totals.finderAdded += stats.finderAdded;
            totals.generated += stats.generated;
            totals.afterGates += stats.afterGates;
            totals.aligned += stats.patchesAligned || 0;
            totals.misaligned += stats.patchesMisaligned || 0;
            totals.filteredOut += stats.filteredOut || 0;
            totals.relocated += stats.relocated || 0;
            if (stats.wouldBlock) totals.wouldBlock++;
            totals.inline += stats.inline;
            totals.tokensIn += stats.tokens?.input ?? 0;
            totals.tokensOut += stats.tokens?.output ?? 0;

            const ctxNote = stats.filesWithContent
                ? `[ctx ${stats.filesWithContent}f/${stats.patchesAligned}aligned`
                  + `${stats.patchesMisaligned ? `/${stats.patchesMisaligned}STALE` : ''}] `
                : '[ctx none] ';
            console.log(
                `${ctxNote}` +
                `${stats.baseline} base +${stats.finderAdded} finder = ${stats.generated} → ` +
                `${stats.afterGates} kept (${stats.droppedByGates} cut` +
                `${stats.filteredOut ? `, ${stats.filteredOut} out of scope` : ''}) → ${stats.inline} inline  ` +
                `${Math.round((Date.now() - started) / 1000)}s`
            );
        } catch (e) {
            console.log(`FAILED: ${e.message}`);
            kase.runError = e.message;
        }
        // Persist after every case: an LLM run is slow and expensive, and
        // losing four completed reviews to a crash on the fifth is avoidable.
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
    }

    console.log(
        `\nTotals: ${totals.baseline} baseline + ${totals.finderAdded} multi-finder = ` +
        `${totals.generated} generated, ${totals.afterGates} after gates, ${totals.inline} inline`
    );
    console.log(
        `Context: ${totals.aligned} patch(es) aligned with cached content`
        + `${totals.misaligned ? `, ${totals.misaligned} STALE (expansion refused — re-run fetch-content)` : ''}`
    );
    console.log(
        `Policy:  filter-mode=${args.filterMode} (${totals.filteredOut} out of scope, `
        + `${totals.relocated} relocated), fail-level=${args.failLevel} `
        + `(${totals.wouldBlock}/${selected.length} case(s) would block)`
    );
    console.log(`Tokens: ${totals.tokensIn} in / ${totals.tokensOut} out`);

    // The single most important line when comparing two runs. A corpus whose
    // content has drifted from its patches produces a perfectly plausible score
    // that measures the patch-only pipeline.
    if (selected.length > 0 && withContent > 0 && totals.aligned === 0) {
        console.log(
            `\n⚠️  Content was cached but NOTHING aligned — hunk expansion was refused for\n`
            + `    every file, so this run measured patch-only context. Re-run:\n`
            + `      node eval/fetch-content.js --corpus ${args.corpus} --force\n`
            + `    (and re-run eval/inject.js if this is an injected corpus)`
        );
    }
    console.log(`\nWritten to ${args.corpus}`);
    console.log('Next: node eval/score.js --corpus ' + args.corpus + '   (recall now; precision needs adjudication)');
}

// Only run when invoked directly — importing this module (from a test) must not
// start a review. Same guard as eval/adjudicate.js.
if (process.argv[1] && process.argv[1].endsWith('run.js')) {
    main().catch((e) => {
        console.error(`\n${e.message}`);
        process.exit(1);
    });
}

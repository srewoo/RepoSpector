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

function parseArgs(argv) {
    const args = {
        corpus: 'eval/corpus/public-prs.json', limit: Infinity, only: null,
        finderMode: 'default', multiFinder: true, finderRounds: 2, label: null,
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

async function reviewOne(kase, { llm, settings, opts }) {
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

    const engine = new MultiPassReviewEngine({ llmService: llm });
    const result = await engine.execute(
        prData,
        { staticFindings: staticResult.findings, contextBudget: opts.contextBudget },
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
    let findings = buildCanonicalFindings(result.perFileFindings || [], staticResult.findings || []);
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
    // NOTE: see reviewContextBudget.js's header — this comparison is currently
    // INERT in this harness, because reviewOne() below supplies no ragContext,
    // graphContext, or fileContext for the budget to gate. Wiring the env var
    // makes the switch real; it does not make the A/B meaningful yet.
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
        && c.runStats.contextProfile === contextProfile;

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
        `— inert until the harness supplies ragContext/graphContext/fileContext (see reviewContextBudget.js)\n`
    );

    const llm = new LLMService();
    const totals = { baseline: 0, finderAdded: 0, generated: 0, afterGates: 0, inline: 0, tokensIn: 0, tokensOut: 0 };

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
            totals.inline += stats.inline;
            totals.tokensIn += stats.tokens?.input ?? 0;
            totals.tokensOut += stats.tokens?.output ?? 0;

            console.log(
                `${stats.baseline} base +${stats.finderAdded} finder = ${stats.generated} → ` +
                `${stats.afterGates} kept (${stats.droppedByGates} cut) → ${stats.inline} inline  ` +
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
    console.log(`Tokens: ${totals.tokensIn} in / ${totals.tokensOut} out`);
    console.log(`\nWritten to ${args.corpus}`);
    console.log('Next: node eval/score.js --corpus ' + args.corpus + '   (recall now; precision needs adjudication)');
}

main().catch((e) => {
    console.error(`\n${e.message}`);
    process.exit(1);
});

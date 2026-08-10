#!/usr/bin/env node
/**
 * Score a review run and, with --gate, fail on regression.
 *
 *   node eval/score.js --corpus eval/corpus/mr-50.json
 *   node eval/score.js --corpus eval/fixtures/synthetic.json --gate
 *   node eval/score.js --corpus <f> --write-baseline
 *
 * The gate compares the LOWER BOUND of each rate's 95% interval against
 * eval/baseline.json. Comparing point estimates would let a small run ratchet
 * the threshold to a number the next run cannot reach.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateCorpus } from './lib/corpus.js';
import { scoreRun, formatReport, pct } from './lib/scoring.js';

const BASELINE_PATH = resolve('eval/baseline.json');

function parseArgs(argv) {
    const args = { corpus: null, gate: false, writeBaseline: false, json: false, tolerance: undefined };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--corpus') args.corpus = argv[++i];
        else if (a === '--gate') args.gate = true;
        else if (a === '--write-baseline') args.writeBaseline = true;
        else if (a === '--json') args.json = true;
        else if (a === '--misses') args.misses = true;
        else if (a === '--include-unreviewed') args.includeUnreviewed = true;
        else if (a === '--tolerance') args.tolerance = Number(argv[++i]);
        else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`Unknown argument: ${a}`);
    }
    return args;
}

const USAGE = `
Usage: node eval/score.js --corpus <file> [--gate] [--write-baseline] [--json]

  --corpus <file>     Corpus JSON (see eval/README.md for the shape)
  --gate              Exit 1 if the run regresses against eval/baseline.json
  --write-baseline    Overwrite eval/baseline.json with this run
  --json              Emit the raw result object instead of a report
  --tolerance <n>     Line-match tolerance (default 5)
  --misses            List the human comments the run did not raise
  --include-unreviewed  Score un-run cases as total misses (default: exclude)
`.trim();

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
        throw new Error(`Could not read ${path}: ${e.message}`);
    }
}

/**
 * Compare a run against the baseline's lower bounds.
 * @returns {{passed: boolean, lines: string[]}}
 */
export function gate(result, baseline) {
    const lines = [];
    let passed = true;

    const check = (label, observedLow, requiredLow, sample) => {
        if (requiredLow == null) {
            lines.push(`  ${label}: no threshold recorded — skipped`);
            return;
        }
        if (sample === 0) {
            // Nothing to measure is not a pass. A run that produced no
            // adjudicated findings must not be reported as meeting the bar.
            passed = false;
            lines.push(`  ✗ ${label}: empty sample, cannot demonstrate ${pct(requiredLow)}`);
            return;
        }
        const ok = observedLow >= requiredLow - 1e-9;
        if (!ok) passed = false;
        lines.push(
            `  ${ok ? '✓' : '✗'} ${label}: lower bound ${pct(observedLow)} ` +
            `vs required ${pct(requiredLow)} (n=${sample})`
        );
    };

    check('precision', result.precision.low, baseline?.thresholds?.precisionLow, result.precision.adjudicated);
    check('recall', result.recall.low, baseline?.thresholds?.recallLow, result.recall.reference);

    return { passed, lines };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.corpus) {
        console.log(USAGE);
        process.exit(args.help ? 0 : 2);
    }

    const allCases = validateCorpus(readJson(resolve(args.corpus)));

    // A case with no predictions AND no recorded run is a case the pipeline
    // never saw. Scoring it counts every one of its human comments as a miss,
    // so a half-finished run reports a recall figure that looks like a result
    // and is really just "we did not run yet". Exclude and say so loudly —
    // silently deflating the numerator is exactly the failure this harness
    // exists to prevent.
    const unreviewed = allCases.filter(c => !c.runStats && (c.predictions ?? []).length === 0);
    const cases = args.includeUnreviewed
        ? allCases
        : allCases.filter(c => !unreviewed.includes(c));

    if (unreviewed.length) {
        console.warn(
            `WARNING: ${unreviewed.length} of ${allCases.length} case(s) have not been reviewed ` +
            `and are EXCLUDED from the score.\n` +
            `         Partial result over ${cases.length} case(s). ` +
            `Run \`node eval/run.js --corpus ${args.corpus} --resume\` to finish.\n` +
            `         Pass --include-unreviewed to score them as total misses instead.\n`
        );
    }
    if (cases.length === 0) {
        throw new Error('No reviewed cases in this corpus — run eval/run.js first');
    }

    const result = scoreRun(cases, { tolerance: args.tolerance });

    if (args.json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log(formatReport(result));
    }

    // A recall percentage tells you that you missed things; the list tells you
    // what kind of thing you miss, which is the only version you can act on.
    if (args.misses) {
        console.log('\nHuman comments this run did not raise:');
        for (const c of result.recall.missedExamples) {
            const at = c.line != null ? `${c.file}:${c.line}` : c.file;
            console.log(`  · ${at}\n      ${String(c.body ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);
        }
        const extra = result.recall.missed - result.recall.missedExamples.length;
        if (extra > 0) console.log(`  …and ${extra} more.`);
    }

    if (args.writeBaseline) {
        const baseline = {
            // Recorded so a future reader knows what these numbers describe.
            corpus: args.corpus,
            cases: result.cases,
            tolerance: result.tolerance,
            measured: {
                precision: result.precision.rate,
                precisionLow: result.precision.low,
                recall: result.recall.rate,
                recallLow: result.recall.low,
            },
            // The gate uses these. They start AT the measured lower bounds:
            // the bar is "do not get worse", not an aspiration.
            thresholds: {
                precisionLow: result.precision.low,
                recallLow: result.recall.low,
            },
        };
        writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
        console.log(`\nBaseline written to ${BASELINE_PATH}`);
        return;
    }

    if (args.gate) {
        const baseline = readJson(BASELINE_PATH);
        const { passed, lines } = gate(result, baseline);
        console.log(`\nGate vs ${BASELINE_PATH}:`);
        console.log(lines.join('\n'));
        if (!passed) {
            console.error('\nReview accuracy regressed. Investigate before merging.');
            process.exit(1);
        }
        console.log('\nNo regression.');
    }
}

// Only run as a CLI; importing this module for tests must not execute it.
if (process.argv[1] && process.argv[1].endsWith('score.js')) {
    try {
        main();
    } catch (e) {
        console.error(`\n${e.message}`);
        process.exit(2);
    }
}

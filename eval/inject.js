#!/usr/bin/env node
/**
 * Build an injected-defect corpus from a fetched one.
 *
 *   node eval/inject.js --in eval/corpus/public-prs.json --out eval/corpus/injected.json
 *   node eval/run.js   --corpus eval/corpus/injected.json
 *   node eval/score.js --corpus eval/corpus/injected.json --misses
 *
 * Every planted defect becomes a `humanComments` entry, so the existing scorer
 * reports detection rate as recall with no special-casing. That reuse is
 * deliberate: one matcher, one interval calculation, one definition of "same
 * location" across both benchmarks — a second scoring path would be a second
 * place for the numbers to quietly disagree.
 *
 * The original human comments are preserved under `originalHumanComments` so a
 * single corpus can answer both questions.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { injectIntoPr, DEFECTS } from './lib/defects.js';

function parseArgs(argv) {
    const args = {
        in: 'eval/corpus/public-prs.json',
        out: 'eval/corpus/injected.json',
        maxPerFile: 2,
        maxPerPr: 6,
        only: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--in') args.in = argv[++i];
        else if (a === '--out') args.out = argv[++i];
        else if (a === '--max-per-file') args.maxPerFile = Number(argv[++i]);
        else if (a === '--max-per-pr') args.maxPerPr = Number(argv[++i]);
        else if (a === '--only') args.only = argv[++i].split(',').map(s => s.trim());
        else if (a === '--list') args.list = true;
        else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`Unknown argument: ${a}`);
    }
    return args;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log('Usage: node eval/inject.js [--in <file>] [--out <file>] [--max-per-file n] [--max-per-pr n] [--only id,id] [--list]');
        return;
    }
    if (args.list) {
        console.log('Defect catalogue:\n');
        for (const d of DEFECTS) {
            console.log(`  ${d.id.padEnd(20)} ${d.category.padEnd(12)} ${d.languages.join(',').padEnd(18)} ${d.description}`);
        }
        return;
    }

    const parsed = JSON.parse(readFileSync(resolve(args.in), 'utf8'));
    const cases = Array.isArray(parsed) ? parsed : parsed.cases;

    const out = [];
    const byCategory = {};
    const byDefect = {};
    let total = 0;

    for (const kase of cases) {
        const { prData, injected, fileContents } = injectIntoPr(kase.prData, {
            maxPerFile: args.maxPerFile,
            maxPerPr: args.maxPerPr,
            only: args.only,
            // Cached post-change file content (from eval/fetch-content.js), if the
            // input corpus carries it. Injection rewrites it in step with the
            // patch — see injectIntoPr.
            fileContents: kase.fileContents || null,
        });

        if (injected.length === 0) {
            console.log(`  ${kase.id}: no injectable site found — excluded`);
            continue;
        }

        for (const d of injected) {
            byCategory[d.category] = (byCategory[d.category] ?? 0) + 1;
            byDefect[d.id] = (byDefect[d.id] ?? 0) + 1;
        }
        total += injected.length;
        console.log(`  ${kase.id}: ${injected.length} defect(s) — ${injected.map(d => d.id).join(', ')}`);

        out.push({
            id: `${kase.id}[injected]`,
            url: kase.url,
            prData,
            ...(fileContents ? { fileContents } : {}),
            // Ground truth, in the shape the scorer already understands.
            humanComments: injected.map(d => ({
                file: d.file,
                line: d.line,
                body: `[${d.id}] ${d.description}`,
                author: 'injected',
                substantive: true,
                // Lets the scorer break detection down by defect class. A single
                // rate hides that (say) every unchecked-error was missed while
                // every injection is found — which is the actionable part.
                tag: d.id,
                tagGroup: d.category,
            })),
            injectedDefects: injected,
            originalHumanComments: kase.humanComments,
            predictions: [],
            adjudications: [],
        });
    }

    if (out.length === 0) throw new Error('No defects could be injected — the corpus has no matching added lines');

    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(resolve(args.out), `${JSON.stringify({
        _comment: 'Injected-defect benchmark. Ground truth is planted, so recall here is detection rate. Gitignored.',
        generator: 'eval/inject.js',
        cases: out,
    }, null, 2)}\n`);

    console.log(`\n${total} defect(s) across ${out.length} PR(s) → ${args.out}`);
    console.log(`By category: ${Object.entries(byCategory).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    console.log(`By defect:   ${Object.entries(byDefect).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    console.log(`\nNext: node eval/run.js --corpus ${args.out}`);
}

if (process.argv[1] && process.argv[1].endsWith('inject.js')) {
    try {
        main();
    } catch (e) {
        console.error(`\n${e.message}`);
        process.exit(2);
    }
}

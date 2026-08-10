#!/usr/bin/env node
/**
 * Precision needs a human. This produces the worksheet, and reads it back.
 *
 *   node eval/adjudicate.js --corpus eval/corpus/public-prs.json --export sheet.csv
 *   # …fill in the `verdict` column: true_positive | false_positive | (blank = skip)
 *   node eval/adjudicate.js --corpus eval/corpus/public-prs.json --import sheet.csv
 *
 * Why not have a model do it: the pipeline's own LLM verifier was measured
 * passing 42 of 42 findings that human adjudication then rejected. An LLM
 * adjudicator would produce a precision figure with no demonstrated relationship
 * to correctness — worse than no figure, because it would get quoted.
 *
 * Blank verdicts stay blank. `scorePrecision` counts unadjudicated findings
 * separately and excludes them from the rate, so a partially-filled sheet gives
 * an honest number over what was actually judged.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const COLUMNS = ['case', 'file', 'line', 'severity', 'posted', 'rule', 'title', 'suggestion', 'verdict'];

function parseArgs(argv) {
    const args = { corpus: 'eval/corpus/public-prs.json', export: null, import: null, postedOnly: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--corpus') args.corpus = argv[++i];
        else if (a === '--export') args.export = argv[++i];
        else if (a === '--import') args.import = argv[++i];
        else if (a === '--posted-only') args.postedOnly = true;
        else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`Unknown argument: ${a}`);
    }
    return args;
}

/** RFC4180-ish quoting: findings routinely contain commas, quotes and newlines. */
function csvCell(value) {
    const s = String(value ?? '').replace(/\r?\n/g, ' ');
    return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Minimal RFC4180 parser — enough for a sheet round-tripped through Excel. */
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { cell += '"'; i++; }
                else quoted = false;
            } else cell += ch;
            continue;
        }
        if (ch === '"') { quoted = true; continue; }
        if (ch === ',') { row.push(cell); cell = ''; continue; }
        if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
        if (ch === '\r') continue;
        cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => c !== ''));
}

function loadCorpus(path) {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const cases = Array.isArray(parsed) ? parsed : parsed.cases;
    return { parsed, cases };
}

function doExport(args) {
    const { cases } = loadCorpus(resolve(args.corpus));

    const lines = [COLUMNS.join(',')];
    let count = 0;
    for (const kase of cases) {
        for (const p of kase.predictions ?? []) {
            if (args.postedOnly && !p.posted) continue;
            // Pre-fill any verdict already recorded, so re-exporting after a
            // partial pass does not throw away work.
            const existing = (kase.adjudications ?? []).find(
                a => a.file === p.file && Number(a.line) === Number(p.line)
            );
            lines.push([
                kase.id, p.file, p.line ?? '', p.severity ?? '', p.posted ? 'inline' : 'summary',
                p.rule ?? '', p.title ?? '', p.suggestion ?? '', existing?.verdict ?? '',
            ].map(csvCell).join(','));
            count++;
        }
    }

    writeFileSync(resolve(args.export), `${lines.join('\n')}\n`);
    console.log(`Wrote ${count} finding(s) to ${args.export}`);
    console.log('\nFill in the `verdict` column with true_positive or false_positive.');
    console.log('Judge against the diff, not against whether the wording sounds plausible.');
    console.log('Leave it blank to skip — blanks are excluded from the rate, not counted as wrong.');
    console.log(`\nThen: node eval/adjudicate.js --corpus ${args.corpus} --import ${args.export}`);
}

function doImport(args) {
    const path = resolve(args.corpus);
    const { parsed, cases } = loadCorpus(path);
    const rows = parseCsv(readFileSync(resolve(args.import), 'utf8'));

    const header = rows.shift();
    const idx = Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), i]));
    for (const required of ['case', 'file', 'verdict']) {
        if (idx[required] == null) throw new Error(`Worksheet is missing the \`${required}\` column`);
    }

    const byId = new Map(cases.map(c => [c.id, c]));
    let applied = 0;
    let blank = 0;
    const unknown = new Set();

    for (const row of rows) {
        const verdict = (row[idx.verdict] ?? '').trim().toLowerCase();
        if (!verdict) { blank++; continue; }
        if (verdict !== 'true_positive' && verdict !== 'false_positive') {
            throw new Error(`Unrecognised verdict "${row[idx.verdict]}" for ${row[idx.case]} ${row[idx.file]}. Use true_positive or false_positive.`);
        }

        const kase = byId.get((row[idx.case] ?? '').trim());
        if (!kase) { unknown.add(row[idx.case]); continue; }

        const file = (row[idx.file] ?? '').trim();
        const rawLine = (row[idx.line] ?? '').trim();
        const line = rawLine === '' ? null : Number(rawLine);

        kase.adjudications = kase.adjudications ?? [];
        const existing = kase.adjudications.find(a => a.file === file && Number(a.line) === Number(line));
        if (existing) existing.verdict = verdict;
        else kase.adjudications.push({ file, ...(line == null ? {} : { line }), verdict });
        applied++;
    }

    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
    console.log(`Applied ${applied} verdict(s); ${blank} left blank.`);
    if (unknown.size) console.log(`Ignored rows for unknown case id(s): ${[...unknown].join(', ')}`);
    console.log(`\nNow: node eval/score.js --corpus ${args.corpus}`);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || (!args.export && !args.import)) {
        console.log('Usage: node eval/adjudicate.js --corpus <file> (--export <csv> [--posted-only] | --import <csv>)');
        process.exit(args.help ? 0 : 2);
    }
    if (args.export) doExport(args);
    else doImport(args);
}

if (process.argv[1] && process.argv[1].endsWith('adjudicate.js')) {
    try {
        main();
    } catch (e) {
        console.error(`\n${e.message}`);
        process.exit(2);
    }
}

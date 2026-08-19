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
import { hunkForLine } from './lib/hunks.js';

const COLUMNS = ['case', 'file', 'line', 'severity', 'posted', 'rule', 'title', 'suggestion', 'verdict', 'source'];

function parseArgs(argv) {
    const args = {
        corpus: 'eval/corpus/public-prs.json',
        export: null, exportContext: null, import: null,
        postedOnly: false, source: 'human',
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--corpus') args.corpus = argv[++i];
        else if (a === '--export') args.export = argv[++i];
        else if (a === '--export-context') args.exportContext = argv[++i];
        else if (a === '--import') args.import = argv[++i];
        else if (a === '--posted-only') args.postedOnly = true;
        else if (a === '--source') args.source = argv[++i];
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

/**
 * A CommonMark fence of N backticks can contain a run of at most N-1
 * backticks without the run being read as closing the fence. A stored patch
 * is arbitrary file content — it can and (confirmed in this corpus) does
 * contain literal ``` sequences — so a hard-coded ``` fence is unsafe. This
 * picks a delimiter one backtick longer than the longest backtick run found
 * in the content, with a floor of 3.
 */
export function mdFence(text) {
    const runs = String(text ?? '').match(/`+/g) ?? [];
    const longest = runs.reduce((max, r) => Math.max(max, r.length), 0);
    return '`'.repeat(Math.max(3, longest + 1));
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
                existing?.source ?? '',
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

/**
 * A markdown worksheet with the actual diff beside each finding.
 *
 * The CSV cannot carry this: `csvCell` flattens newlines to spaces, and a diff
 * with its line structure removed is not something anyone can judge. So the
 * markdown is for reading and the CSV stays the verdict carrier.
 */
export function doExportContext(args) {
    const { cases } = loadCorpus(resolve(args.corpus));
    const out = [
        '# Adjudication worksheet',
        '',
        'For each finding: is it real, judged **against the diff below** and not',
        'against whether the wording sounds plausible? Record verdicts in the CSV',
        'worksheet — this file is for reading.',
        '',
    ];

    let count = 0;
    let noHunk = 0;
    for (const kase of cases) {
        const byName = new Map((kase.prData?.files ?? []).map(f => [f.filename, f]));
        for (const p of kase.predictions ?? []) {
            if (args.postedOnly && !p.posted) continue;
            count++;
            const hunk = hunkForLine(byName.get(p.file)?.patch, p.line);
            if (!hunk) noHunk++;
            // The fence must be longer than any backtick run inside the hunk
            // text itself, or a literal ``` in the stored patch (this corpus
            // has some) would close the fence early and misalign every
            // finding rendered after it.
            const fence = hunk ? mdFence(hunk.text) : '';
            out.push(
                `## ${kase.id} — \`${p.file}:${p.line ?? '?'}\``,
                '',
                `- **severity**: ${p.severity ?? '?'}  ·  **rule**: ${p.rule ?? '?'}  ·  **posted**: ${p.posted ? 'inline' : 'summary'}`,
                `- **title**: ${p.title ?? ''}`,
                `- **description**: ${(p.description ?? '').replace(/\s+/g, ' ')}`,
                `- **suggestion**: ${(p.suggestion ?? '').replace(/\s+/g, ' ')}`,
                '',
                hunk ? `${fence}diff` : '_No hunk in the stored patch covers this line._',
                ...(hunk ? [hunk.text, fence] : []),
                '',
            );
        }
    }

    writeFileSync(resolve(args.exportContext), `${out.join('\n')}\n`);
    console.log(`Wrote ${count} finding(s) with diff context to ${args.exportContext}`);
    if (noHunk) console.log(`${noHunk} finding(s) had no covering hunk — judge those from the file path alone, or skip them.`);
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

        const rowSource = (row[idx.source] ?? '').trim().toLowerCase();
        const source = rowSource === 'llm' || rowSource === 'human' ? rowSource : args.source;
        if (source !== 'human' && source !== 'llm') {
            throw new Error(`Unrecognised source "${source}". Use human or llm.`);
        }

        kase.adjudications = kase.adjudications ?? [];
        const existing = kase.adjudications.find(a => a.file === file && Number(a.line) === Number(line));
        if (existing) {
            existing.verdict = verdict;
            // Absent means human; only ever write the field for llm, so existing
            // corpora keep their exact committed shape.
            if (source === 'llm') existing.source = 'llm';
            else delete existing.source;
        } else {
            kase.adjudications.push({
                file,
                ...(line == null ? {} : { line }),
                verdict,
                ...(source === 'llm' ? { source: 'llm' } : {}),
            });
        }
        applied++;
    }

    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
    console.log(`Applied ${applied} verdict(s); ${blank} left blank.`);
    if (unknown.size) console.log(`Ignored rows for unknown case id(s): ${[...unknown].join(', ')}`);
    console.log(`\nNow: node eval/score.js --corpus ${args.corpus}`);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || (!args.export && !args.exportContext && !args.import)) {
        console.log('Usage: node eval/adjudicate.js --corpus <file> (--export <csv> | --export-context <md> | --import <csv> [--source human|llm]) [--posted-only]');
        process.exit(args.help ? 0 : 2);
    }
    if (args.exportContext) doExportContext(args);
    if (args.export) doExport(args);
    if (args.import) doImport(args);
}

if (process.argv[1] && process.argv[1].endsWith('adjudicate.js')) {
    try {
        main();
    } catch (e) {
        console.error(`\n${e.message}`);
        process.exit(2);
    }
}

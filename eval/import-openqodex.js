#!/usr/bin/env node
/**
 * Import OpenQodex's planted-bug benchmark as a RepoSpector corpus, so both
 * tools are scored on the same changes with the same answer key.
 *
 *   git clone --depth 1 https://github.com/openqodex/openqodex /tmp/oq
 *   node eval/import-openqodex.js --src /tmp/oq/benchmark/cases
 *   node eval/run.js   --corpus eval/corpus/openqodex-planted.json
 *   node eval/score.js --corpus eval/corpus/openqodex-planted.json --tolerance 1
 *
 * Each case is a base folder and a change folder written over it. Every bug
 * becomes a reference defect with its line range and its `mentions` (the words
 * a finding must use to count as naming it); each `extras` entry, a real side
 * issue the case accepts, becomes an accepted issue that counts as correct in
 * precision and never in recall. Clean cases keep `clean: true`.
 *
 * Nothing the reviewer sees may carry the answer: OpenQodex's case ids and
 * `guards` sentences describe the bug, so the title, description and URL are
 * neutral and the id stays in the corpus only.
 *
 * The cases are Apache-2.0 (OpenQodex). The output is gitignored with the rest
 * of eval/corpus/.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
    const args = { src: null, out: 'eval/corpus/openqodex-planted.json' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--src') args.src = argv[++i];
        else if (a === '--out') args.out = argv[++i];
        else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`Unknown argument: ${a}`);
    }
    return args;
}

function walk(dir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [full];
    });
}

/**
 * OpenQodex fills placeholders (a generated secret) in the change only, from
 * the case id, never at random: two imports must review the same code.
 */
function fillPlaceholders(text, generated, caseId) {
    let out = text;
    for (const g of generated ?? []) {
        const hex = createHash('sha256').update(`${caseId}:${g.placeholder}`).digest('hex');
        const value = g.kind === 'stripe-live-key' ? `sk_live_${hex.slice(0, 24)}` : hex.slice(0, 32);
        out = out.split(g.placeholder).join(value);
    }
    return out;
}

/** GitHub-style patch (hunks only, no headers) between two file bodies. */
export function patchOf(before, after) {
    const dir = mkdtempSync(join(tmpdir(), 'oq-'));
    try {
        const a = join(dir, 'a');
        const b = join(dir, 'b');
        writeFileSync(a, before ?? '');
        writeFileSync(b, after ?? '');
        const r = spawnSync('git', ['diff', '--no-index', '--no-color', '-U3', a, b], { encoding: 'utf8' });
        if (r.status !== 0 && r.status !== 1) throw new Error(`git diff failed: ${r.stderr}`);
        const at = r.stdout.indexOf('\n@@');
        return at === -1 ? '' : r.stdout.slice(at + 1).replace(/\n\\ No newline at end of file/g, '');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

function countLines(patch, mark) {
    return patch.split('\n').filter((l) => l.startsWith(mark) && !l.startsWith(mark.repeat(3))).length;
}

export function importCase(caseDir, index) {
    const spec = JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8'));
    const baseDir = spec.base ? resolve(caseDir, spec.base) : join(caseDir, 'base');
    const changeDir = spec.change ? resolve(caseDir, spec.change) : join(caseDir, 'change');
    if (!existsSync(baseDir) || !existsSync(changeDir)) throw new Error(`${spec.id}: base or change folder missing`);

    const deleted = existsSync(join(caseDir, 'delete.txt'))
        ? readFileSync(join(caseDir, 'delete.txt'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
        : [];

    const files = [];
    const fileContents = {};
    for (const full of walk(changeDir)) {
        const filename = relative(changeDir, full);
        const basePath = join(baseDir, filename);
        const before = existsSync(basePath) ? readFileSync(basePath, 'utf8') : null;
        const after = fillPlaceholders(readFileSync(full, 'utf8'), spec.generated, spec.id);
        if (before === after) continue;
        const patch = patchOf(before, after);
        files.push({
            filename,
            status: before == null ? 'added' : 'modified',
            additions: countLines(patch, '+'),
            deletions: countLines(patch, '-'),
            patch,
        });
        fileContents[filename] = after;
    }
    for (const filename of deleted) {
        const before = readFileSync(join(baseDir, filename), 'utf8');
        const patch = patchOf(before, '');
        files.push({ filename, status: 'removed', additions: 0, deletions: countLines(patch, '-'), patch });
    }
    if (files.length === 0) throw new Error(`${spec.id}: the change writes nothing over the base`);

    const reference = (r, body) => ({
        file: r.file,
        line: r.lines[0],
        lineEnd: r.lines[1],
        body,
        mentions: r.mentions ?? [],
    });

    return {
        id: `openqodex/${spec.id}`,
        url: `benchmark://case-${index + 1}`,
        prData: {
            platform: 'github',
            number: index + 1,
            title: `Change ${index + 1}`,
            description: '',
            state: 'open',
            isDraft: false,
            merged: false,
            author: 'benchmark',
            branches: { source: 'change', target: 'main' },
            headSha: null,
            baseSha: null,
            stats: {
                additions: files.reduce((n, f) => n + f.additions, 0),
                deletions: files.reduce((n, f) => n + f.deletions, 0),
                changedFiles: files.length,
            },
            labels: [],
            files,
            commits: [],
            url: `benchmark://case-${index + 1}`,
        },
        fileContents,
        clean: spec.clean === true,
        humanComments: (spec.bugs ?? []).map((b) => ({
            ...reference(b, b.truth),
            author: 'openqodex',
            substantive: true,
            tag: b.class,
            tagGroup: (b.kind ?? [])[0] ?? 'defect',
            severity: b.severity,
        })),
        acceptedIssues: (spec.extras ?? []).map((x) => reference(x, x.why)),
        language: spec.language,
        predictions: [],
        adjudications: [],
    };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.src) {
        console.log('Usage: node eval/import-openqodex.js --src <openqodex>/benchmark/cases [--out <file>]');
        process.exit(args.help ? 0 : 2);
    }
    const dirs = readdirSync(args.src)
        .map((d) => join(args.src, d))
        .filter((d) => existsSync(join(d, 'case.json')))
        .sort();
    const cases = dirs.map((d, i) => importCase(d, i));

    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(resolve(args.out), `${JSON.stringify({
        _comment: 'OpenQodex planted-bug benchmark (Apache-2.0), imported by eval/import-openqodex.js. Gitignored.',
        generator: 'eval/import-openqodex.js',
        cases,
    }, null, 2)}\n`);

    const bugs = cases.reduce((n, c) => n + c.humanComments.length, 0);
    const clean = cases.filter((c) => c.clean).length;
    console.log(`${cases.length} case(s), ${bugs} planted bug(s), ${clean} clean → ${args.out}`);
    console.log(`\nNext: node eval/run.js --corpus ${args.out}`);
}

if (process.argv[1] && process.argv[1].endsWith('import-openqodex.js')) {
    try {
        main();
    } catch (e) {
        console.error(`\n${e.message}`);
        process.exit(2);
    }
}

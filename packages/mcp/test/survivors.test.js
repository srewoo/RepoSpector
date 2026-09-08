import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findSurvivingReferences } from '../src/tools/survivors.js';

const exec = promisify(execFile);

/**
 * What a deletion leaves behind elsewhere.
 *
 * The structural blind spot: every section of the bundle is scoped to the diff,
 * so a reference to a deleted symbol in a file the change never opens is
 * invisible. On the merge request that drove all of this, FOUR of six findings
 * were exactly that — an entire dead retrieval channel in an untouched file, a
 * code comment citing a deleted function as a live precedent, and three
 * documents advertising a deleted HTTP route and a retired search mode.
 *
 * A diff-scoped tool cannot find those by reading the diff. It can find them by
 * taking the names it just established were removed and looking for them in the
 * rest of the repository at the reviewed revision — which is what this does.
 */

async function repoWithLeftovers() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repospector-surv-'));
    const git = (...args) => exec('git', args, { cwd: dir });

    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'test');

    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.mkdir(path.join(dir, 'docs'), { recursive: true });

    // The file the change edits.
    await fs.writeFile(path.join(dir, 'src/store.ts'), 'export const kept = 1;\n');
    // An untouched code file that still references the deleted symbol.
    await fs.writeFile(
        path.join(dir, 'src/retrieval.ts'),
        'export interface DenseCandidate { id: string }\n'
        + 'export function fuse(dense?: DenseCandidate[]) { return dense ?? []; }\n',
    );
    // An untouched comment citing it as a live precedent.
    await fs.writeFile(
        path.join(dir, 'src/sibling.ts'),
        '// Duplicate suppression uses findSimilar, a vector-store check.\n'
        + 'export const x = 1;\n',
    );
    // Untouched documentation advertising it.
    await fs.writeFile(
        path.join(dir, 'docs/SETUP.md'),
        '### Tool 8: search_test_cases\n\nUses findSimilar for semantic search.\n',
    );
    // A name that appears nowhere else.
    await fs.writeFile(path.join(dir, 'src/unrelated.ts'), 'export const y = 2;\n');

    await git('add', '-A');
    await git('commit', '-qm', 'base');
    return dir;
}

test('finds a deleted symbol still referenced in an untouched code file', async () => {
    const dir = await repoWithLeftovers();
    try {
        const out = await findSurvivingReferences(dir, 'HEAD', ['findSimilar'], ['src/store.ts']);

        const hit = out.references.find((r) => r.name === 'findSimilar');
        assert.ok(hit, 'no surviving reference reported at all');
        const paths = hit.files.map((f) => f.path);
        assert.ok(paths.includes('src/sibling.ts'), `missed the comment citation: ${paths}`);
        assert.ok(paths.includes('docs/SETUP.md'), `missed the documentation: ${paths}`);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('does not report the files the change itself touches', async () => {
    const dir = await repoWithLeftovers();
    try {
        const out = await findSurvivingReferences(
            dir, 'HEAD', ['kept'], ['src/store.ts'],
        );

        const hit = out.references.find((r) => r.name === 'kept');
        assert.equal(hit, undefined, 'reported a reference inside the diff as a leftover');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('separates code references from documentation ones', async () => {
    const dir = await repoWithLeftovers();
    try {
        const out = await findSurvivingReferences(dir, 'HEAD', ['findSimilar'], []);
        const hit = out.references.find((r) => r.name === 'findSimilar');

        const kinds = Object.fromEntries(hit.files.map((f) => [f.path, f.kind]));
        assert.equal(kinds['src/sibling.ts'], 'code');
        assert.equal(kinds['docs/SETUP.md'], 'docs');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a name with no surviving reference is not reported', async () => {
    const dir = await repoWithLeftovers();
    try {
        const out = await findSurvivingReferences(dir, 'HEAD', ['neverMentioned'], []);
        assert.deepEqual(out.references, []);
        assert.deepEqual(out.namesWithNoReferences, ['neverMentioned']);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('matches whole words only', async () => {
    const dir = await repoWithLeftovers();
    try {
        // `Dense` must not match `DenseCandidate`.
        const out = await findSurvivingReferences(dir, 'HEAD', ['Dense'], []);
        assert.deepEqual(out.references, []);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('carries the line so a reviewer can go straight to it', async () => {
    const dir = await repoWithLeftovers();
    try {
        const out = await findSurvivingReferences(dir, 'HEAD', ['DenseCandidate'], []);
        const hit = out.references.find((r) => r.name === 'DenseCandidate');
        const file = hit.files.find((f) => f.path === 'src/retrieval.ts');

        assert.ok(file.lines.length > 0);
        assert.equal(typeof file.lines[0].line, 'number');
        assert.match(file.lines[0].text, /DenseCandidate/);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a name too short or too common is skipped rather than flooding the section', async () => {
    const dir = await repoWithLeftovers();
    try {
        const out = await findSurvivingReferences(dir, 'HEAD', ['x', 'get', 'main'], []);
        assert.deepEqual(out.references, []);
        assert.deepEqual(out.namesSkipped, ['x', 'get', 'main']);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('bounded: neither the name list nor the hits can run away', async () => {
    const dir = await repoWithLeftovers();
    try {
        const many = Array.from({ length: 200 }, (_unused, i) => `symbolNumber${i}`);
        const out = await findSurvivingReferences(dir, 'HEAD', [...many, 'findSimilar'], [], {
            maxNames: 5,
        });

        assert.ok(out.namesQueried <= 5);
        assert.match(out.note || '', /capped|limit/i);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a revision with no such file tree fails soft rather than failing the bundle', async () => {
    const dir = await repoWithLeftovers();
    try {
        const out = await findSurvivingReferences(dir, 'no-such-rev', ['findSimilar'], []);
        assert.deepEqual(out.references, []);
        assert.match(out.note || '', /could not|unavailable/i);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('does not search data, lockfiles or fixtures', async () => {
    // From the real re-run: searching for `connect` returned
    // `data/vectors/case-index.json` (a 152k-case index), `package-lock.json`,
    // a k8s yaml and a conversation fixture — all labelled `code`. None of
    // them is a reference a reviewer can act on.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repospector-noise-'));
    try {
        const git = (...args) => exec('git', args, { cwd: dir });
        await git('init', '-q', '-b', 'main');
        await git('config', 'user.email', 'test@example.com');
        await git('config', 'user.name', 'test');
        await fs.mkdir(path.join(dir, 'data'), { recursive: true });
        await fs.mkdir(path.join(dir, 'src'), { recursive: true });
        await fs.writeFile(path.join(dir, 'data/index.json'), '{"note":"buildContext everywhere"}\n');
        await fs.writeFile(path.join(dir, 'package-lock.json'), '{"x":"buildContext"}\n');
        await fs.writeFile(path.join(dir, 'infra.yaml'), 'note: buildContext\n');
        await fs.writeFile(path.join(dir, 'src/real.ts'), 'export const x = buildContext();\n');
        await git('add', '-A');
        await git('commit', '-qm', 'base');

        const out = await findSurvivingReferences(dir, 'HEAD', ['buildContext'], []);
        const paths = out.references[0].files.map((f) => f.path);

        assert.deepEqual(paths, ['src/real.ts'], `searched non-source files: ${paths}`);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a name that matches half the repository is reported as generic, not listed', async () => {
    // `onModuleInit` and `connect` are framework hooks: they matched unrelated
    // processors, comments and cache services, burying the specific names.
    // Genericity is measured from the repository rather than guessed at.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repospector-generic-'));
    try {
        const git = (...args) => exec('git', args, { cwd: dir });
        await git('init', '-q', '-b', 'main');
        await git('config', 'user.email', 'test@example.com');
        await git('config', 'user.name', 'test');
        await fs.mkdir(path.join(dir, 'src'), { recursive: true });
        for (let i = 0; i < 12; i += 1) {
            await fs.writeFile(
                path.join(dir, `src/f${i}.ts`),
                'export class C { onModuleInit(): void {} }\n',
            );
        }
        await fs.writeFile(path.join(dir, 'src/only.ts'), 'export const y = verySpecificName();\n');
        await git('add', '-A');
        await git('commit', '-qm', 'base');

        const out = await findSurvivingReferences(
            dir, 'HEAD', ['onModuleInit', 'verySpecificName'], [], { maxFilesPerName: 4 },
        );

        assert.ok(
            !out.references.some((r) => r.name === 'onModuleInit'),
            'a name matching 12 files was listed file by file',
        );
        const generic = (out.namesTooCommonInRepo || []).find((n) => n.name === 'onModuleInit');
        assert.ok(generic, 'no genericity report for a name matching everything');
        assert.ok(generic.files >= 12);
        assert.ok(out.references.some((r) => r.name === 'verySpecificName'));
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

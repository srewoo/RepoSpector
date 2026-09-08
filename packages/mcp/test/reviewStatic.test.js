import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runStaticAnalysis } from '../src/tools/review.js';

const exec = promisify(execFile);

/**
 * `review_pr`'s static section, end to end through the real analyzers.
 *
 * The two defects this pins, both observed on one real merge request:
 *   1. it linted the WORKING TREE while the hunks came from a range, so it
 *      reported a duplicate key the change deletes;
 *   2. it never applied `staticRulePremise`, so mis-mapped rule hits reached
 *      the reader as "facts about the code".
 */

async function repoWithDivergentWorktree() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repospector-static-'));
    const git = (...args) => exec('git', args, { cwd: dir });

    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'test');

    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(
        path.join(dir, 'src/config.ts'),
        'export const config = { host: "a", port: 1, host: "b" };\n',
    );
    await git('add', '-A');
    await git('commit', '-qm', 'base with a duplicate key');

    await git('checkout', '-q', '-b', 'feature');
    await fs.writeFile(
        path.join(dir, 'src/config.ts'),
        'export const config = { host: "a", port: 1 };\n',
    );
    await git('add', '-A');
    await git('commit', '-qm', 'drop the duplicate key');

    await git('checkout', '-q', 'main'); // worktree left stale, as in the real case
    return dir;
}

const ctx = () => ({ config: { maxFiles: 200, maxToolTokens: 16384 } });

const diffFiles = () => ([{
    filename: 'src/config.ts',
    patch: [
        '@@ -1,1 +1,1 @@',
        '-export const config = { host: "a", port: 1, host: "b" };',
        '+export const config = { host: "a", port: 1 };',
    ].join('\n'),
}]);

test('reports no finding on code the change deletes', async () => {
    // Self-witnessing: first prove the rule DOES fire on the stale worktree
    // content, so "no findings" cannot pass because the rule never ran. The
    // fixture is `.ts` for that reason — the AST engine claims `.js` and has no
    // duplicate-key rule at all, so a `.js` fixture would assert nothing.
    const dir = await repoWithDivergentWorktree();
    try {
        const { ESLintAnalyzer } = await import(
            '../../../src/services/ESLintAnalyzer.js'
        );
        const stale = await fs.readFile(path.join(dir, 'src/config.ts'), 'utf8');
        const onStale = new ESLintAnalyzer({}).analyze(stale, { filePath: 'src/config.ts' });
        assert.ok(
            onStale.findings.some((f) => f.ruleId === 'no-dupe-keys'),
            'fixture is inert: the rule does not fire on the worktree content either',
        );

        const result = await runStaticAnalysis(
            diffFiles(), ctx(), dir, { range: 'main..feature' },
        );

        const dupes = (result.lint.findings || []).filter((f) => f.ruleId === 'no-dupe-keys');
        assert.deepEqual(
            dupes, [],
            'flagged the duplicate key that only exists in the stale worktree',
        );
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('states which revision the static section describes', async () => {
    const dir = await repoWithDivergentWorktree();
    try {
        const result = await runStaticAnalysis(
            diffFiles(), ctx(), dir, { range: 'main..feature' },
        );

        assert.equal(result.source.kind, 'revision');
        assert.match(result.source.reason, /head of the range/);
        assert.ok(result.source.rev, 'no revision recorded for the section');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('carries the premise gate outcome so a filtered file is not read as clean', async () => {
    const dir = await repoWithDivergentWorktree();
    try {
        const result = await runStaticAnalysis(
            diffFiles(), ctx(), dir, { range: 'main..feature' },
        );

        assert.ok(Array.isArray(result.premiseRefuted), 'no premise-gate outcome reported');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('names the engine that produced the lint findings', async () => {
    // The rubric calls this section "real linter ... facts about the code". When
    // the regex fallback ran rather than the AST engine, the bundle has to say
    // so — that sentence is why a pattern artifact got quoted as a defect.
    const dir = await repoWithDivergentWorktree();
    try {
        const result = await runStaticAnalysis(
            diffFiles(), ctx(), dir, { range: 'main..feature' },
        );

        assert.ok(result.engines, 'no engine attribution on the static section');
        // `.ts` is not supported by the AST engine, so the regex fallback is
        // what ran. Asserting the COUNT stops this passing on `{none: 1}`,
        // which is what an attribution read off the wrong field reports.
        assert.equal(
            result.engines.regex, 1,
            `engine attribution does not name the regex fallback: ${JSON.stringify(result.engines)}`,
        );
        assert.equal(result.engines.none, undefined);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a duplicate the change INTRODUCES is still reported', async () => {
    // The gate must not become a way to miss real defects.
    const dir = await repoWithDivergentWorktree();
    try {
        const git = (...args) => exec('git', args, { cwd: dir });
        await git('checkout', '-q', '-b', 'introduces', 'main');
        await fs.writeFile(
            path.join(dir, 'src/config.ts'),
            'export const config = { host: "a", port: 1 };\nexport const extra = { a: 1, a: 2 };\n',
        );
        await git('add', '-A');
        await git('commit', '-qm', 'add a duplicate key');
        await git('checkout', '-q', 'main');

        const files = [{
            filename: 'src/config.ts',
            patch: [
                '@@ -1,1 +1,2 @@',
                '-export const config = { host: "a", port: 1, host: "b" };',
                '+export const config = { host: "a", port: 1 };',
                '+export const extra = { a: 1, a: 2 };',
            ].join('\n'),
        }];

        const result = await runStaticAnalysis(files, ctx(), dir, { range: 'main..introduces' });

        const dupes = (result.lint.findings || []).filter((f) => f.ruleId === 'no-dupe-keys');
        assert.equal(dupes.length, 1, 'missed a duplicate key the change adds');
        assert.equal(dupes[0].line, 2);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

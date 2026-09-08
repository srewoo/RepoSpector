import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProvenance, renderProvenance } from '../src/tools/provenance.js';

const exec = promisify(execFile);

/**
 * What revision each section of the bundle describes.
 *
 * Nothing in the bundle said. The static section read the working tree, the
 * hunks came from a range, the graph came from an index built at yet another
 * commit — and the reader had no way to notice. On the review that exposed
 * this, the indexed worktree was 537 commits behind the range's own base; one
 * line saying so would have invalidated the static section immediately instead
 * of an hour later.
 */

async function repo() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repospector-prov-'));
    const git = (...args) => exec('git', args, { cwd: dir });

    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'test');

    await fs.writeFile(path.join(dir, 'a.js'), 'export const a = 1;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'one');

    // Three commits on main that the stale worktree will sit behind.
    for (const n of [2, 3, 4]) {
        await fs.writeFile(path.join(dir, 'a.js'), `export const a = ${n};\n`);
        await git('add', '-A');
        await git('commit', '-qm', `commit ${n}`);
    }

    await git('checkout', '-q', '-b', 'feature');
    await fs.writeFile(path.join(dir, 'b.js'), 'export const b = 1;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'feature work');

    return { dir, git };
}

const indexerAt = (commit) => ({
    parserMode: () => 'tree-sitter',
    stats: () => ({ nodeCount: 10, relationshipCount: 5 }),
    indexedCommit: async () => commit,
});

test('names the reviewed target and both of its ends', async () => {
    const { dir } = await repo();
    try {
        const p = await buildProvenance({
            args: { range: 'main..feature' },
            repo: dir,
            indexer: indexerAt(null),
        });

        assert.equal(p.target.kind, 'range');
        assert.equal(p.target.spec, 'main..feature');
        assert.ok(p.target.base, 'no base revision recorded');
        assert.ok(p.target.head, 'no head revision recorded');
        assert.notEqual(p.target.base, p.target.head);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('says how far the index is from the reviewed base', async () => {
    const { dir, git } = await repo();
    try {
        // An index built at the FIRST commit, reviewing main..feature.
        const { stdout } = await exec('git', ['rev-list', '--max-parents=0', 'main'], { cwd: dir });
        const root = stdout.trim();
        await git('checkout', '-q', 'main');

        const p = await buildProvenance({
            args: { range: 'main..feature' },
            repo: dir,
            indexer: indexerAt(root),
        });

        assert.equal(
            p.index.behindReviewedBase, 3,
            `expected the index to be 3 commits behind the base, got ${p.index.behindReviewedBase}`,
        );
        assert.ok(p.index.stale, 'a 3-commit-old index is not flagged as stale');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('an index at the reviewed base is not called stale', async () => {
    const { dir } = await repo();
    try {
        const { stdout } = await exec('git', ['rev-parse', 'main'], { cwd: dir });

        const p = await buildProvenance({
            args: { range: 'main..feature' },
            repo: dir,
            indexer: indexerAt(stdout.trim()),
        });

        assert.equal(p.index.behindReviewedBase, 0);
        assert.equal(p.index.stale, false);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('reports the worktree separately from the reviewed revision', async () => {
    const { dir, git } = await repo();
    try {
        await git('checkout', '-q', 'main');
        const p = await buildProvenance({
            args: { range: 'main..feature' },
            repo: dir,
            indexer: indexerAt(null),
        });

        assert.ok(p.worktree.head, 'no worktree head recorded');
        assert.equal(p.worktree.dirty, false);
        assert.notEqual(
            p.worktree.head, p.target.head,
            'fixture is inert: the worktree happens to be the reviewed head',
        );
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('an uncommitted change makes the worktree dirty', async () => {
    const { dir } = await repo();
    try {
        await fs.writeFile(path.join(dir, 'a.js'), 'export const a = 99;\n');

        const p = await buildProvenance({
            args: { range: 'main..feature' },
            repo: dir,
            indexer: indexerAt(null),
        });

        assert.equal(p.worktree.dirty, true);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('an unknown index commit is named as unknown, never assumed current', async () => {
    const { dir } = await repo();
    try {
        const p = await buildProvenance({
            args: { range: 'main..feature' },
            repo: dir,
            indexer: indexerAt(null),
        });

        assert.equal(p.index.commit, null);
        assert.equal(p.index.behindReviewedBase, null);
        assert.match(p.index.note, /unknown|not recorded/i);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('carries the static-analysis source and the token budget', async () => {
    const { dir } = await repo();
    try {
        const p = await buildProvenance({
            args: { range: 'main..feature' },
            repo: dir,
            indexer: indexerAt(null),
            staticSource: { kind: 'revision', rev: 'abc123', reason: 'read at the head' },
            budget: { maxToolTokens: 16384, grants: { hunks: 8000 } },
        });

        assert.equal(p.staticAnalysis.kind, 'revision');
        assert.equal(p.budget.maxToolTokens, 16384);
        assert.equal(p.budget.grants.hunks, 8000);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a pasted diff has no local ends and says so rather than inventing them', async () => {
    const { dir } = await repo();
    try {
        const p = await buildProvenance({
            args: { diff: 'diff --git a/x b/x\n' },
            repo: dir,
            indexer: indexerAt(null),
        });

        assert.equal(p.target.kind, 'diff');
        assert.equal(p.target.base, null);
        assert.equal(p.target.head, null);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

/**
 * Provenance under a tight budget.
 *
 * Found by the over-the-wire acceptance test at 1200 tokens: the section was
 * cut at a line boundary and left unparseable — the fourth section to hit this,
 * and the worst one to lose, because it is what tells a reader whether to trust
 * the others. Its critical facts are a dozen lines; its bulk is the graph stats
 * blob, which is decoration.
 */

const FULL = {
    target: { kind: 'range', spec: 'main..feature', base: 'a'.repeat(40), head: 'b'.repeat(40), diffMode: 'merge-base' },
    worktree: { head: 'c'.repeat(40), dirty: false },
    index: {
        commit: 'a'.repeat(40),
        parser: 'tree-sitter',
        graph: {
            nodeCount: 6037,
            relationshipCount: 15068,
            nodesByLabel: { File: 1110, Function: 2304, Class: 173, Method: 987, Interface: 742 },
            relationshipsByType: { DEFINES: 4433, CALLS: 7038, TESTED_BY: 1180, MEMBER_OF: 2047 },
            communities: 419,
            processes: 75,
            modularity: 0.381,
            buildTimeMs: 42979,
            coverage: { testedByEdges: 1180, coverableSymbols: 2875, coverageRatio: 0.283 },
        },
        behindReviewedBase: 0,
        stale: false,
        note: 'the graph and retrieval sections describe this commit',
    },
    staticAnalysis: {
        kind: 'revision',
        rev: 'b'.repeat(40),
        reason: 'file contents read at the head of the range',
        pathsAbsentAtRevision: Array.from({ length: 40 }, (_u, i) => `packages/x/test/deleted-${i}.test.ts`),
    },
    budget: { maxToolTokens: 1200 },
};

test('renders whole when it fits', () => {
    const parsed = JSON.parse(renderProvenance(FULL, 100000));
    assert.equal(parsed.index.graph.nodeCount, 6037);
    assert.equal(parsed.staticAnalysis.pathsAbsentAtRevision.length, 40);
});

test('stays parseable at a budget that cannot hold it', () => {
    const text = renderProvenance(FULL, 120);
    assert.doesNotThrow(() => JSON.parse(text), 'provenance was cut mid-structure');
});

test('keeps the facts a reader needs to distrust the other sections', () => {
    const parsed = JSON.parse(renderProvenance(FULL, 120));

    assert.equal(parsed.target.head, FULL.target.head);
    assert.equal(parsed.target.base, FULL.target.base);
    assert.equal(parsed.index.commit, FULL.index.commit);
    assert.equal(parsed.index.stale, false);
    assert.equal(parsed.staticAnalysis.kind, 'revision');
});

test('sheds the graph blob before anything that matters', () => {
    const parsed = JSON.parse(renderProvenance(FULL, 300));
    assert.equal(parsed.index.graph, undefined);
    assert.equal(parsed.target.diffMode, 'merge-base');
});

test('says what it dropped', () => {
    const parsed = JSON.parse(renderProvenance(FULL, 120));
    assert.match(parsed.note || '', /dropped|omitted|not shown/i);
});

test('a stale index survives every level of shedding', () => {
    const stale = { ...FULL, index: { ...FULL.index, behindReviewedBase: 537, stale: true } };
    const parsed = JSON.parse(renderProvenance(stale, 60));

    assert.equal(parsed.index.stale, true);
    assert.equal(parsed.index.behindReviewedBase, 537);
});

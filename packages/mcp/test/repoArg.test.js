import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveRepo, REPO_ARG } from '../src/repo/resolveRepo.js';
import { TOOLS } from '../src/tools/registry.js';
import { SEARCH_CODE_TOOL } from '../src/tools/search.js';
import { REPO_OVERVIEW_TOOL } from '../src/tools/impact.js';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'fixtures', 'mini-repo');
const TIMEOUT = 300000;

/**
 * Why this exists: `--repo` alone pins one repository per client entry, so a
 * user working across several had to edit their client config and restart to
 * switch — and Claude Desktop has no useful working directory to fall back on.
 */

test('every tool advertises the repo argument', () => {
    // A tool missing it silently analyses the wrong repository instead of erroring.
    for (const t of TOOLS) {
        assert.ok(
            'repo' in (t.inputSchema.properties || {}),
            `${t.name} does not accept a per-call repo`,
        );
    }
    // Grows with the registry; kept as an exact count so a tool added without
    // the repo argument fails here rather than in a user's multi-repo session.
    assert.equal(TOOLS.length, 11);
    assert.ok(REPO_ARG.repo.description.length > 0);
});

test('resolveRepo falls back to the configured repo', () => {
    const ctx = { config: { repo: '/configured/path' } };
    for (const args of [{}, { repo: undefined }, { repo: null }, { repo: '' }, undefined]) {
        assert.equal(resolveRepo(ctx, args), '/configured/path');
    }
});

test('resolveRepo expands ~, which no shell is around to do', () => {
    // The client spawns the server directly, so a literal ~ would otherwise
    // resolve against the cwd and point at a nonexistent ./~/... path.
    const ctx = { config: { repo: FIXTURE } };
    assert.equal(resolveRepo(ctx, { repo: '~' }), os.homedir());
});

test('resolveRepo rejects a path that does not exist, naming it', () => {
    const ctx = { config: { repo: FIXTURE } };
    assert.throws(
        () => resolveRepo(ctx, { repo: '/definitely/not/here' }),
        /does not exist: \/definitely\/not\/here/,
    );
});

test('resolveRepo rejects a file, and a non-string', () => {
    const ctx = { config: { repo: FIXTURE } };
    assert.throws(() => resolveRepo(ctx, { repo: path.join(FIXTURE, 'README.md') }), /not a directory/);
    assert.throws(() => resolveRepo(ctx, { repo: 42 }), /must be a path string/);
});

test('two repositories in one process do not contaminate each other', { timeout: TIMEOUT }, async () => {
    // The bug this pins: getIndexer held ONE indexer per process, so the first
    // repo's graph and index answered every later call for a different repo —
    // wrong answers rather than an error.
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'repospector-repo-'));
    const git = (...a) => exec('git', a, { cwd: other });
    await git('init', '-q', '.');
    await git('config', 'user.email', 't@t');
    await git('config', 'user.name', 't');
    await fs.mkdir(path.join(other, 'lib'), { recursive: true });
    await fs.writeFile(
        path.join(other, 'lib', 'telemetry.js'),
        'export function emitTelemetryEvent(name, payload) {\n'
        + "    return { name, payload, kafkaTopic: 'usage-tracking' };\n}\n",
    );
    await git('add', '.');
    await git('commit', '-qm', 'init');

    const ctx = {
        config: { repo: FIXTURE, maxFiles: 50, maxToolTokens: 4096 },
        indexer: null,
    };

    const first = await SEARCH_CODE_TOOL.handler({ query: 'validate a user password hash' }, ctx);
    assert.match(first.content[0].text, /auth\.js/);

    const second = await SEARCH_CODE_TOOL.handler(
        { query: 'emit a telemetry event to kafka', repo: other }, ctx,
    );
    assert.match(second.content[0].text, /telemetry\.js/);
    assert.doesNotMatch(second.content[0].text, /auth\.js/, 'leaked the default repo into the override');

    // Switching back must not have been clobbered by the override.
    const third = await SEARCH_CODE_TOOL.handler({ query: 'validate a user password hash' }, ctx);
    assert.match(third.content[0].text, /auth\.js/);
    assert.doesNotMatch(third.content[0].text, /telemetry\.js/);

    assert.equal(ctx.indexers.size, 2, 'expected one cached indexer per repository');

    const overview = await REPO_OVERVIEW_TOOL.handler({ repo: other }, ctx);
    assert.match(overview.content[0].text, new RegExp(`Path: ${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    await fs.rm(other, { recursive: true, force: true });
});

test('a bad repo argument surfaces as a tool error, not a wrong answer', { timeout: TIMEOUT }, async () => {
    const ctx = { config: { repo: FIXTURE, maxFiles: 50, maxToolTokens: 4096 }, indexer: null };
    const r = await SEARCH_CODE_TOOL.handler({ query: 'anything', repo: '/nope/not/here' }, ctx);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /does not exist/);
});

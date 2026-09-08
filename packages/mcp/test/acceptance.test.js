import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..');
const TIMEOUT = 600000;

/**
 * `review_pr` driven over the real MCP protocol, against the BUILT server.
 *
 * Every other test in this package imports `src/` directly. That leaves the
 * thing a client actually runs — `dist/index.js`, one bundled file — untested
 * for the tool that matters most, and this session proved the gap is not
 * theoretical: the session's own MCP server kept serving pre-fix output from
 * `dist` while every unit test passed against `src`.
 *
 * So: spawn the bundle, speak JSON-RPC to it, and assert the invariants the
 * bundle's own sections claim — one per input mode, because the three modes
 * resolve their revision differently and that resolution is where the worst
 * defect lived.
 */

let dir;
let base;
let head;

/** Minimal stdio JSON-RPC client: spawn, initialize, call, collect, kill. */
async function callTool(name, args, { repo, maxToolTokens = 16384 } = {}) {
    const child = spawn('node', [path.join(PKG, 'dist/index.js'), '--repo', repo || dir, '--max-tool-tokens', String(maxToolTokens)], {
        cwd: PKG,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GITHUB_TOKEN: '', GITLAB_TOKEN: '' },
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });

    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'acceptance', version: '0' },
        },
    });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });

    const frames = () => out.split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);

    const deadline = Date.now() + TIMEOUT - 30000;
    while (Date.now() < deadline && !frames().some((f) => f.id === 2)) {
        await new Promise((r) => setTimeout(r, 250));
        if (child.exitCode !== null && !frames().some((f) => f.id === 2)) break;
    }
    child.kill();

    const reply = frames().find((f) => f.id === 2);
    assert.ok(reply, `no reply to ${name}. stderr:\n${err.slice(0, 2000)}`);
    return { reply, rawStdout: out, stderr: err };
}

/** The bundle's text result, split into its labelled sections. */
function sectionsOf(reply) {
    const text = reply.result?.content?.[0]?.text ?? '';
    const parts = text.split(/\n\n(?=[a-z_]+:)/);
    const map = new Map();
    for (const part of parts) {
        const i = part.indexOf(':');
        if (i > 0) map.set(part.slice(0, i), part.slice(i + 1).trim());
    }
    return { text, map };
}

before(async () => {
    // Build the bundle under test, so this never passes against a stale dist.
    await exec('npm', ['run', 'build'], { cwd: PKG });

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repospector-accept-'));
    const git = (...args) => exec('git', args, { cwd: dir });

    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'test');
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.mkdir(path.join(dir, 'test'), { recursive: true });

    await fs.writeFile(
        path.join(dir, 'src/store.js'),
        'export function findSimilar(q) {\n  return embedText(q);\n}\n'
        + 'export function embedText(t) {\n  return [t.length];\n}\n',
    );
    // An untouched consumer, for surviving_references.
    await fs.writeFile(
        path.join(dir, 'src/consumer.js'),
        "import { findSimilar } from './store.js';\n"
        + 'export function ask(q) {\n  return findSimilar(q);\n}\n',
    );
    await fs.writeFile(
        path.join(dir, 'test/store.test.js'),
        "import { findSimilar } from '../src/store.js';\nit('x', () => findSimilar('a'));\n",
    );
    await fs.writeFile(path.join(dir, 'README.md'), `# Fixture\n\n${'prose '.repeat(800)}\n`);
    await git('add', '-A');
    await git('commit', '-qm', 'base');
    base = (await exec('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();

    await git('checkout', '-q', '-b', 'feature');
    await fs.writeFile(
        path.join(dir, 'src/store.js'),
        '// `findSimilar` was removed here.\n'
        + 'export function embedText(t) {\n  return [t.length];\n}\n',
    );
    await fs.rm(path.join(dir, 'test/store.test.js'));
    // The prose file is touched too, so the tight-budget test below actually
    // exercises it. An earlier version asserted README.md appeared in the
    // hunks while the change never modified it — the assertion was wrong, not
    // the code.
    await fs.writeFile(path.join(dir, 'README.md'), `# Fixture\n\n${'prose '.repeat(800)}x\n`);
    await git('add', '-A');
    await git('commit', '-qm', 'delete findSimilar and its test');
    head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    await git('checkout', '-q', 'main'); // stale worktree on purpose
});

after(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
});

test('range mode: every section is present and every JSON section parses', { timeout: TIMEOUT }, async () => {
    const { reply } = await callTool('review_pr', { range: 'main..feature' });
    assert.equal(reply.result?.isError, undefined, JSON.stringify(reply).slice(0, 600));

    const { map } = sectionsOf(reply);
    for (const label of ['rubric', 'hunks', 'similar_code', 'graph_context', 'covering_tests',
        'surviving_references', 'prior_findings', 'static_analysis', 'dependencies', 'provenance']) {
        assert.ok(map.has(label), `section missing over the wire: ${label}`);
    }
    for (const [label, body] of map) {
        if (!body.startsWith('{') && !body.startsWith('[')) continue;
        assert.doesNotThrow(
            () => JSON.parse(body),
            `${label} is not parseable JSON — it was cut mid-structure`,
        );
    }
});

test('range mode: reads file contents at the reviewed head, not the worktree', { timeout: TIMEOUT }, async () => {
    const { reply } = await callTool('review_pr', { range: 'main..feature' });
    const { map } = sectionsOf(reply);

    const provenance = JSON.parse(map.get('provenance'));
    assert.equal(provenance.target.head, head);
    assert.equal(provenance.target.base, base);
    assert.equal(provenance.target.diffMode, 'merge-base');
    assert.equal(provenance.worktree.head, base, 'fixture is inert: worktree is not stale');

    const stat = JSON.parse(map.get('static_analysis'));
    assert.equal(stat.source.kind, 'revision');
    assert.equal(stat.source.rev, head);
});

test('range mode: reports the removed symbol and its surviving consumer', { timeout: TIMEOUT }, async () => {
    const { reply } = await callTool('review_pr', { range: 'main..feature' });
    const { map } = sectionsOf(reply);

    const graph = JSON.parse(map.get('graph_context'));
    assert.ok(
        graph.removed.some((r) => r.name === 'findSimilar'),
        `findSimilar not reported removed: ${JSON.stringify(graph.removed)}`,
    );

    const survivors = JSON.parse(map.get('surviving_references'));
    const hit = (survivors.references || []).find((r) => r.name === 'findSimilar');
    assert.ok(hit, `no surviving reference: ${map.get('surviving_references').slice(0, 300)}`);
    assert.ok(
        hit.files.some((f) => f.path === 'src/consumer.js'),
        `the untouched consumer is missing: ${JSON.stringify(hit.files)}`,
    );

    const coverage = JSON.parse(map.get('covering_tests'));
    assert.deepEqual(coverage.testFilesDeleted, ['test/store.test.js']);
});

test('diff mode: falls back to the patch added lines and says so', { timeout: TIMEOUT }, async () => {
    const { stdout: patch } = await exec(
        'git', ['diff', `${base}...${head}`, '--', 'src/store.js'], { cwd: dir },
    );

    const { reply } = await callTool('review_pr', { diff: patch });
    assert.equal(reply.result?.isError, undefined);
    const { map } = sectionsOf(reply);

    const stat = JSON.parse(map.get('static_analysis'));
    assert.equal(stat.source.kind, 'added-lines');
    assert.equal(stat.source.rev, null);
    assert.match(stat.source.reason, /pasted diff|no revision/i);
});

test('pr_url mode with no token fails structurally, without crashing', { timeout: TIMEOUT }, async () => {
    const { reply } = await callTool('review_pr', {
        pr_url: 'https://github.com/anthropics/does-not-exist/pull/1',
    });

    // Either a structured tool error or a bundle that names the failure — never
    // a protocol crash and never a silent empty success.
    const text = reply.result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'empty reply for an unreachable PR');
    assert.match(text, /fail|error|unavailable|not found|404|unable/i);
});

test('a malformed range returns a structured error naming the cause', { timeout: TIMEOUT }, async () => {
    const { reply } = await callTool('review_pr', { range: 'main..no-such-ref' });
    const text = reply.result?.content?.[0]?.text ?? '';

    assert.equal(reply.result?.isError, true, `expected a tool error, got: ${text.slice(0, 300)}`);
    assert.match(text, /no-such-ref|unknown revision|bad revision|ambiguous/i);
});

test('neither target argument returns guidance, not a stack trace', { timeout: TIMEOUT }, async () => {
    const { reply } = await callTool('review_pr', {});
    const text = reply.result?.content?.[0]?.text ?? '';

    assert.match(text, /Pass one of: diff/);
    assert.doesNotMatch(text, /at Object\.|node:internal/);
});

test('a tight budget keeps every section present and parseable', { timeout: TIMEOUT }, async () => {
    // The invariant that failed three times in this session, over the wire and
    // at a quarter of the default budget.
    const { reply } = await callTool('review_pr', { range: 'main..feature' }, { maxToolTokens: 1200 });
    const { map } = sectionsOf(reply);

    for (const label of ['hunks', 'graph_context', 'covering_tests', 'static_analysis', 'provenance']) {
        assert.ok(map.has(label), `${label} vanished under a tight budget`);
    }
    for (const [label, body] of map) {
        if (!body.startsWith('{')) continue;
        assert.doesNotThrow(() => JSON.parse(body), `${label} cut mid-structure at 1200 tokens`);
    }
});

test('nothing but protocol frames reaches stdout', { timeout: TIMEOUT }, async () => {
    const { rawStdout } = await callTool('review_pr', { range: 'main..feature' });

    for (const line of rawStdout.split('\n').filter(Boolean)) {
        assert.doesNotThrow(
            () => JSON.parse(line),
            `non-protocol output on stdout would corrupt the client: ${line.slice(0, 200)}`,
        );
    }
});

test('a tight budget trims hunks but still names every changed file', { timeout: TIMEOUT }, async () => {
    // Measured at 12000 tokens on a real 22-file review: the hunks section
    // showed 15 of 26 windows and the other 11 were simply absent. Cause: the
    // section is budgeted TWICE — `renderDiffFiles` fits itself to the whole
    // `--max-tool-tokens`, then the bundle caps the finished string to the
    // section's ~50% share with a line-boundary cut, which drops whole trailing
    // windows. Trimming every window beats dropping some silently.
    const { reply } = await callTool('review_pr', { range: 'main..feature' }, { maxToolTokens: 2000 });
    const { map } = sectionsOf(reply);
    const hunks = map.get('hunks');

    for (const file of ['src/store.js', 'test/store.test.js', 'README.md']) {
        assert.match(
            hunks,
            new RegExp(file.replace('.', '\\.')),
            `${file} vanished from hunks under a tight budget instead of being trimmed`,
        );
    }
});

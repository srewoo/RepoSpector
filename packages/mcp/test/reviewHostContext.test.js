import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REVIEW_PR_TOOL } from '../src/tools/review.js';
import { clearSessions } from '../src/tools/verification.js';

const exec = promisify(execFile);
const TIMEOUT = 300000;

/**
 * `review_pr` takes platform context from the HOST (spec §1.2): the host
 * fetches PR comments, pipeline status and the PR ref with its own
 * GitHub/GitLab MCP and passes them in. This server makes no platform call for
 * them, and an absent argument is a not-run naming what to fetch.
 */

let dir;
let base;
let head;
const ctx = () => ({
    config: { repo: dir, maxFiles: 100, maxToolTokens: 60000, githubToken: null, gitlabToken: null },
    indexer: null,
});

function section(bundle, label) {
    const start = bundle.indexOf(`${label}:\n`);
    assert.ok(start >= 0, `no ${label} section`);
    const rest = bundle.slice(start + label.length + 2);
    const end = rest.search(/\n\n[a-z_]+:\n/);
    return JSON.parse(end >= 0 ? rest.slice(0, end) : rest);
}

before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repospector-hostctx-'));
    const git = (...args) => exec('git', args, { cwd: dir });
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'test');
    await fs.mkdir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), '# Rules\nAlways pass an initial value to reduce.\n');
    await fs.writeFile(
        path.join(dir, 'src/total.js'),
        '// keep the 0: empty carts must total 0\nexport function total(items) {\n'
        + '  return items.reduce((a, b) => a + b, 0);\n}\n',
    );
    await git('add', '-A');
    await git('commit', '-qm', 'fix: total of an empty cart is 0');
    base = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('checkout', '-q', '-b', 'feature');
    await fs.writeFile(
        path.join(dir, 'src/total.js'),
        '// keep the 0: empty carts must total 0\nexport function total(items) {\n'
        + '  return items.reduce((a, b) => a + b);\n}\n',
    );
    await git('add', '-A');
    await git('commit', '-qm', 'refactor: simplify total');
    head = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('checkout', '-q', 'main');
});

after(async () => {
    clearSessions();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
});

test('host-supplied context feeds lenses and skip rules with no platform call', { timeout: TIMEOUT }, async () => {
    const real = globalThis.fetch;
    const platformCalls = [];
    globalThis.fetch = async (url, init) => {
        const u = String(url?.url ?? url);
        if (/github|gitlab/i.test(u)) {
            platformCalls.push(u);
            throw new Error('platform call made');
        }
        return real(url, init);
    };
    let result;
    try {
        result = await REVIEW_PR_TOOL.handler({
            range: 'main..feature',
            pr_ref: { url: 'https://github.com/acme/shop/pull/9', head_sha: head, base_sha: base },
            prior_pr_comments: [
                { path: 'src/total.js', pr_ref: '#4', author: 'rev', body: 'Keep the initial 0 here.' },
            ],
            pipeline_status: 'failed',
        }, ctx());
    } finally {
        globalThis.fetch = real;
    }
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    assert.deepEqual(platformCalls, []);

    const bundle = result.content[0].text;
    const pipeline = section(bundle, 'pipeline');
    assert.equal(pipeline.status, 'failed');
    assert.equal(pipeline.deferred, true);

    const findings = section(bundle, 'findings');
    const byLens = Object.fromEntries(findings.lensReport.map((r) => [r.lens, r]));
    // No sampling in this ctx: lenses whose context resolved are handed to the host.
    assert.equal(byLens.priorPrComments.status, 'delegated');
    assert.equal(byLens.history.status, 'delegated');
    assert.equal(byLens.rulesCompliance.status, 'delegated');
    assert.ok(findings.delegatedLenses.some((d) => d.lens === 'priorPrComments'
        && /Keep the initial 0 here/.test(d.context)));
});

test('absent host arguments are not-run, each naming what to fetch', { timeout: TIMEOUT }, async () => {
    const result = await REVIEW_PR_TOOL.handler({ range: 'main..feature' }, ctx());
    const bundle = result.content[0].text;

    const pipeline = section(bundle, 'pipeline');
    assert.equal(pipeline.status, 'not-run');
    assert.match(pipeline.reason, /pipeline_status/);

    const findings = section(bundle, 'findings');
    const prior = findings.lensReport.find((r) => r.lens === 'priorPrComments');
    assert.equal(prior.status, 'not-run');
    assert.match(prior.reason, /prior_pr_comments/);
    assert.match(findings.permalinks, /pr_ref/);
});

test('the tool description tells the host what to fetch with its git MCP', () => {
    const d = REVIEW_PR_TOOL.description;
    for (const arg of ['prior_pr_comments', 'pipeline_status', 'pr_ref', 'intent', 'linked_requirements']) {
        assert.match(d, new RegExp(arg));
    }
    assert.match(d, /GitHub\/GitLab MCP/);
    const props = REVIEW_PR_TOOL.inputSchema.properties;
    assert.deepEqual(props.pipeline_status.enum, ['success', 'failed', 'running', 'none']);
    assert.deepEqual(Object.keys(props.pr_ref.properties).sort(), ['base_sha', 'head_sha', 'url']);
    assert.ok(props.prior_pr_comments.items.required.includes('path'));
});

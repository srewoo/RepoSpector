import '../testSupport/silenceServiceLogs.js'; // must be first: see file comment
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REVIEW_PR_TOOL } from '../src/tools/review.js';
import { loadRulesFiles, resolveMcpQuality } from '../src/tools/reviewQuality.js';
import { clearSessions, getSession } from '../src/tools/verification.js';

/**
 * I4: `.repospector.yaml` `settings` apply to MCP reviews as they do in the
 * extension — read from the indexed repo at the reviewed revision, validated
 * by the same schema, layered UNDER the call's `settings` argument.
 * M1: its rules text is the rule entries only, never the settings block.
 */

const exec = promisify(execFile);
const TIMEOUT = 300000;
const YAML = [
    'settings:',
    '  minRubricScore: 60',
    '  bogus: 1',
    '  githubToken: ghp_x',
    '',
].join('\n');

let dir;
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
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repospector-reposettings-'));
    const git = (...args) => exec('git', args, { cwd: dir });
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'test');
    await fs.mkdir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src/total.js'), 'export function total(items) {\n  return items.reduce((a, b) => a + b, 0);\n}\n');
    await git('add', '-A');
    await git('commit', '-qm', 'base');
    await git('checkout', '-q', '-b', 'feature');
    await fs.writeFile(path.join(dir, '.repospector.yaml'), YAML);
    await fs.writeFile(path.join(dir, 'src/total.js'), 'export function total(items) {\n  return items.reduce((a, b) => a + b);\n}\n');
    await git('add', '-A');
    await git('commit', '-qm', 'feature');
    head = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('checkout', '-q', 'main');
});

after(async () => {
    clearSessions();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
});

test('loadRulesFiles reads repo settings at the revision; settings never become rules text', async () => {
    const { rulesFiles, repoConfig } = await loadRulesFiles(dir, head, []);
    assert.equal(repoConfig.settings.minRubricScore, 60);
    assert.ok(repoConfig.configWarnings.some((w) => /bogus/.test(w)));
    assert.ok(repoConfig.configWarnings.some((w) => /githubToken/.test(w)), 'user-only keys stay rejected');
    assert.ok(!rulesFiles.some((r) => /minRubricScore/.test(r.text)));
});

test('no revision → no repo config', async () => {
    const { rulesFiles, repoConfig } = await loadRulesFiles(dir, null, []);
    assert.deepEqual(rulesFiles, []);
    assert.equal(repoConfig, null);
});

test('resolveMcpQuality layers repo settings under the call settings', () => {
    const repo = { settings: { minRubricScore: 60, priorPrLimit: 3 }, configWarnings: ['Unknown setting `bogus` — ignored.'] };
    const fromRepo = resolveMcpQuality(undefined, repo);
    assert.equal(fromRepo.minRubricScore, 60);
    assert.equal(fromRepo.lensLimits.priorPrLimit, 3);
    assert.ok(fromRepo.configWarnings.some((w) => /^\.repospector\.yaml: .*bogus/.test(w)));

    const overridden = resolveMcpQuality({ minRubricScore: 90 }, repo);
    assert.equal(overridden.minRubricScore, 90);
    assert.equal(overridden.lensLimits.priorPrLimit, 3);
});

test('review_pr applies the repo file, and the call settings override it', { timeout: TIMEOUT }, async () => {
    const fromRepo = await REVIEW_PR_TOOL.handler({ range: 'main..feature' }, ctx());
    assert.equal(fromRepo.isError, undefined, fromRepo.content?.[0]?.text);
    const findings = section(fromRepo.content[0].text, 'findings');
    assert.equal(findings.rubric.minRubricScore, 60);
    assert.ok(findings.configWarnings.some((w) => /bogus/.test(w)));
    const reviewId = findings.modelPass.reviewId;
    assert.equal(getSession(reviewId).session.minRubricScore, 60, 'the delegated session gates at 60 too');

    clearSessions();
    const overridden = await REVIEW_PR_TOOL.handler({ range: 'main..feature', settings: { minRubricScore: 90 } }, ctx());
    const f2 = section(overridden.content[0].text, 'findings');
    assert.equal(f2.rubric.minRubricScore, 90);
    assert.equal(getSession(f2.modelPass.reviewId).session.minRubricScore, 90);
});

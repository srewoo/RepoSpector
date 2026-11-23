import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { CliRunner } from '../src/hosts/index.js';
import { createServer } from '../src/server.js';
import { git, makeRepo } from './helpers.js';

const offByOne = {
  file: 'src/cart.js',
  startLine: 3,
  endLine: 4,
  severity: 'high',
  category: 'logic',
  reasoning: 'Loop runs while i <= length, so the last iteration reads items[length].',
  claim: 'TypeError on every call: loop reads one past the end of items',
  evidence: [{ file: 'src/cart.js', startLine: 3, endLine: 4 }],
  confidence: 0.95,
};

interface Call {
  cmd: string;
  args: string[];
  stdin?: unknown;
}

/** A GitHub that knows one PR whose head is `headSha` and whose diff is `diff`. */
function fakeGitHub(headSha: () => string, diff: () => string, existing: { body: string }[] = []): CliRunner & { calls: Call[] } {
  const calls: Call[] = [];
  const run: CliRunner = async (cmd, args, stdin) => {
    calls.push({ cmd, args: [...args], ...(stdin ? { stdin: JSON.parse(stdin) } : {}) });
    const a = args.join(' ');
    if (a.startsWith('auth status')) return 'Logged in to github.com';
    if (a.includes('Accept: application/vnd.github.v3.diff')) return diff();
    if (a.includes('--method POST')) return JSON.stringify({ html_url: 'https://github.com/o/r/pull/5#pullrequestreview-1', state: 'PENDING' });
    if (a.includes('/comments')) return JSON.stringify([existing]);
    if (a.includes('/reviews')) return JSON.stringify([[]]);
    if (a.endsWith('repos/o/r/pulls/5')) return JSON.stringify({ head: { sha: headSha() } });
    throw new Error(`unexpected ${cmd} ${a}`);
  };
  return Object.assign(run, { calls });
}

/** Repo on a feature branch with the off-by-one committed and nothing uncommitted. */
function committedRepo(): string {
  const { root } = makeRepo();
  git(root, 'checkout', '-q', '-b', 'feature');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'feature');
  return root;
}

async function finalizedRun(root: string, runner: CliRunner) {
  const server = await createServer({ root, cacheDir: mkdtempSync(join(tmpdir(), 'rs-cache-')), cliRunner: runner });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = res.content[0]?.text ?? '';
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* error text */
    }
    return { isError: res.isError === true, data, text };
  };
  const plan = await call('plan_review', {});
  const runId = plan.data.runId as string;
  await call('submit_findings', { runId, specialist: 'logic', findings: [offByOne] });
  const batch = await call('verify_batch', { runId });
  const id = (batch.data.findings as { id: string }[])[0]?.id;
  await call('finalize', { runId, batchId: batch.data.batchId, verdicts: [{ findingId: id, keep: true, reason: 'No guard.', citation: { file: 'src/cart.js', startLine: 3, endLine: 4 } }] });
  return { call, runId, client };
}

describe('post_review', () => {
  it('previews by default and posts nothing', async () => {
    const root = committedRepo();
    const gh = fakeGitHub(() => git(root, 'rev-parse', 'HEAD'), () => git(root, 'diff', 'main', 'HEAD'));
    const { call, runId } = await finalizedRun(root, gh);
    const res = await call('post_review', { runId, url: 'https://github.com/o/r/pull/5' });
    expect(res.isError).toBe(false);
    expect(res.data.dryRun).toBe(true);
    expect((res.data.wouldPost as { inline: { path: string; line: number }[] }).inline).toEqual([expect.objectContaining({ path: 'src/cart.js', line: 4 })]);
    expect(gh.calls.some((c) => c.args.includes('POST'))).toBe(false);
  });

  it('posts one pending review when dryRun is false, and nothing again on a second call', async () => {
    const root = committedRepo();
    const posted: { body: string }[] = [];
    const gh = fakeGitHub(() => git(root, 'rev-parse', 'HEAD'), () => git(root, 'diff', 'main', 'HEAD'), posted);
    const { call, runId } = await finalizedRun(root, gh);
    const res = await call('post_review', { runId, url: 'https://github.com/o/r/pull/5', dryRun: false });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ dryRun: false, posted: 1, url: expect.stringContaining('pullrequestreview') });
    const post = gh.calls.find((c) => c.args.includes('POST'));
    expect((post?.stdin as { comments: { body: string }[] }).comments[0]?.body).toContain('one past the end');
    // Simulate GitHub now showing the posted comment; a repeat call posts nothing.
    posted.push({ body: (post?.stdin as { comments: { body: string }[] }).comments[0]?.body ?? '' });
    const again = await call('post_review', { runId, url: 'https://github.com/o/r/pull/5', dryRun: false });
    expect(again.data).toMatchObject({ posted: 0, alreadyPosted: [expect.any(String)] });
    expect(gh.calls.filter((c) => c.args.includes('POST'))).toHaveLength(1);
  });

  it('refuses when the PR head is not the reviewed commit', async () => {
    const root = committedRepo();
    const gh = fakeGitHub(() => 'f'.repeat(40), () => '');
    const { call, runId } = await finalizedRun(root, gh);
    const res = await call('post_review', { runId, url: 'https://github.com/o/r/pull/5', dryRun: false });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not the reviewed commit/);
  });

  it('refuses a run reviewed with uncommitted changes, and a run not yet finalized', async () => {
    const { root } = makeRepo();
    const gh = fakeGitHub(() => git(root, 'rev-parse', 'HEAD'), () => '');
    const { call, runId } = await finalizedRun(root, gh);
    expect((await call('post_review', { runId, url: 'https://github.com/o/r/pull/5' })).text).toMatch(/uncommitted/);
    const fresh = await call('plan_review', {});
    expect((await call('post_review', { runId: fresh.data.runId, url: 'https://github.com/o/r/pull/5' })).text).toMatch(/finalize/);
  });

  it('rejects unknown finding ids and non-PR urls', async () => {
    const root = committedRepo();
    const gh = fakeGitHub(() => git(root, 'rev-parse', 'HEAD'), () => '');
    const { call, runId } = await finalizedRun(root, gh);
    expect((await call('post_review', { runId, url: 'https://github.com/o/r/pull/5', findingIds: ['nope'] })).text).toMatch(/unknown finding/);
    expect((await call('post_review', { runId, url: 'https://github.com/o/r/issues/5' })).isError).toBe(true);
    expect(gh.calls).toHaveLength(0);
  });
});

/** gh/glab missing or logged out: every call fails, as runCli does when the binary is absent. */
const noCli = (): CliRunner & { calls: Call[] } => {
  const calls: Call[] = [];
  const run: CliRunner = async (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    throw new Error(`${cmd} is not available: spawn ${cmd} ENOENT`);
  };
  return Object.assign(run, { calls });
};

describe('post_review without gh/glab (handoff to a GitHub or GitLab MCP)', () => {
  it('returns a ready pending-review payload from the local diff and calls no host', async () => {
    const root = committedRepo();
    const cli = noCli();
    const { call, runId } = await finalizedRun(root, cli);
    const res = await call('post_review', { runId, url: 'https://github.com/o/r/pull/5', dryRun: false });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ via: 'agent', posted: 0, commitId: git(root, 'rev-parse', 'HEAD') });
    expect(String(res.data.why)).toMatch(/gh is not available/);
    const handoff = res.data.handoff as { kind: string; owner: string; repo: string; pullNumber: number; commitId: string; body: string; comments: { path: string; line: number; side: string; body: string }[] };
    expect(handoff).toMatchObject({ kind: 'github-pending-review', owner: 'o', repo: 'r', pullNumber: 5 });
    expect(handoff.comments).toEqual([expect.objectContaining({ path: 'src/cart.js', line: 4, side: 'RIGHT' })]);
    expect(handoff.comments[0]?.body).toMatch(/<!-- repospector:[\w-]+ -->$/);
    const steps = (res.data.instructions as string[]).join(' ');
    expect(steps).toMatch(/head/i);
    expect(steps).toMatch(/repospector:/);
    expect(steps).toMatch(/do not submit/i);
    // Only the login check ran; nothing was read from or written to the host.
    expect(cli.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['auth status']);
  });

  it('gives draft notes with positions for GitLab', async () => {
    const root = committedRepo();
    const { call, runId } = await finalizedRun(root, noCli());
    const res = await call('post_review', { runId, url: 'https://gitlab.example.com/g/p/-/merge_requests/7', via: 'agent' });
    const handoff = res.data.handoff as { kind: string; project: string; mergeRequestIid: number; notes: { body: string; position?: { new_path: string; new_line: number } }[] };
    expect(handoff).toMatchObject({ kind: 'gitlab-draft-notes', project: 'g/p', mergeRequestIid: 7 });
    expect(handoff.notes[0]?.position).toMatchObject({ new_path: 'src/cart.js', new_line: 4 });
    expect(handoff.notes.at(-1)?.position).toBeUndefined(); // the summary note
  });

  it('with via "cli", reports the missing login instead of handing off', async () => {
    const root = committedRepo();
    const { call, runId } = await finalizedRun(root, noCli());
    const res = await call('post_review', { runId, url: 'https://github.com/o/r/pull/5', via: 'cli' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/gh auth login|not available/);
  });

  it('still refuses a run reviewed with uncommitted changes', async () => {
    const { root } = makeRepo();
    const { call, runId } = await finalizedRun(root, noCli());
    expect((await call('post_review', { runId, url: 'https://github.com/o/r/pull/5', via: 'agent' })).text).toMatch(/uncommitted/);
  });
});

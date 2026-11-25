import { describe, expect, it } from 'vitest';
import { GitHubHost, SUMMARY_PROMPT, type ApiClient, type ReviewTarget } from '@repospector/core';
import { newRun, runReview, type EngineDeps, type PrExtras, type ReviewFinding, type RunRecord } from '../src/pipeline/engine.js';
import { suggestFix } from '../src/pipeline/fix.js';
import { postFindings } from '../src/review/post.js';
import type { CompletionRequest, CompletionResult, ModelProvider } from '../src/providers/types.js';

const target: ReviewTarget = { kind: 'github', host: 'github.com', owner: 'o', repo: 'r', number: 5 };
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,3 @@\n a\n+b\n+c\ndiff --git a/src/z.ts b/src/z.ts\n--- a/src/z.ts\n+++ b/src/z.ts\n@@ -10,1 +10,2 @@\n x\n+y\n';

/** Answers each kind of prompt by a marker it contains; records every prompt. */
function provider(replies: { review?: string; rules?: string; requirements?: string; verify?: string; fix?: string }): ModelProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: 'anthropic',
    model: 'm',
    prompts,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      prompts.push(req.prompt);
      const p = req.prompt;
      const text = p.startsWith(SUMMARY_PROMPT) ? '{"overview":"o","files":[],"focus":[]}' : p.includes('<findings>') ? (replies.verify ?? '[]') : p.includes('<rules>') ? (replies.rules ?? '[]') : p.includes('<issues>') ? (replies.requirements ?? '[]') : p.includes('<finding>') ? (replies.fix ?? '{}') : (replies.review ?? '[]');
      return { text, model: 'm', usage: { inputTokens: 10, outputTokens: 1 }, stop: 'end', fallbackUsed: false };
    },
  };
}

function deps(p: ModelProvider, over: Partial<EngineDeps> = {}): EngineDeps {
  return { host: { info: async () => ({ headSha: 'new', title: 'T' }), diff: async () => DIFF }, provider: p, prices: null, feedback: [], save: async () => undefined, now: () => 1, ...over };
}

const extras = (over: Partial<PrExtras> = {}): PrExtras => ({ rules: { text: '--- CLAUDE.md ---\nNever use var.', files: ['CLAUDE.md'] }, issues: [{ ref: '#12', title: 'Totals', body: 'Must include tax.' }], ticketKeys: ['PAY-1'], checks: [{ name: 'lint', status: 'failed', diagnostics: [{ source: 'eslint', file: 'src/a.ts', line: 3, level: 'error', message: 'no-var' }, { source: 'eslint', file: 'src/a.ts', line: 1, level: 'error', message: 'context line' }] }], ...over });

describe('extension review with rules, linked issues and CI', () => {
  it('runs the rules and linked-issue passes, verifies their findings with the rest, and adds CI problems on changed lines', async () => {
    const p = provider({
      review: '[{"file":"src/a.ts","line":2,"claim":"plain"}]',
      rules: '[{"file":"src/z.ts","line":11,"claim":"breaks \\"Never use var\\""}]',
      requirements: '[{"file":"src/a.ts","line":20,"claim":"tax missing"}]',
      verify: '[{"index":0,"keep":true,"confidence":80,"reason":"r"},{"index":1,"keep":true,"confidence":70,"reason":"r"},{"index":2,"keep":false,"confidence":10,"reason":"r"}]',
    });
    const run = await runReview(newRun('r', target, p, 1), deps(p, { extras: async () => extras() }));
    expect(run.status).toBe('done');
    expect(run.findings?.map((f) => [f.claim, f.status, f.source ?? 'review', f.category])).toEqual([
      ['eslint: no-var', 'verified', 'ci', 'ci'],
      ['plain', 'verified', 'review', 'logic'],
      ['breaks "Never use var"', 'verified', 'rules', 'rules'],
      ['tax missing', 'suspected', 'requirements', 'requirements'],
    ]);
    expect(p.prompts.find((x) => x.includes('<rules>'))).toContain('Never use var.');
    expect(p.prompts.find((x) => x.includes('<issues>'))).toContain('Must include tax.');
    expect(run.notes.join('\n')).toMatch(/team rules in CLAUDE\.md[\s\S]*#12[\s\S]*PAY-1[\s\S]*CI: 1 failing \(lint\)/);
    // Texts are kept only while running.
    expect(run.extras?.rulesText).toBeUndefined();
    expect(run.extras?.issuesText).toBeUndefined();
    expect(run.summary?.overview).toBe('o');
  });

  it('goes on without extras when they cannot be read, with a note', async () => {
    const p = provider({ review: '[]' });
    const run = await runReview(newRun('r', target, p, 1), deps(p, { extras: async () => Promise.reject(new Error('403')) }));
    expect(run.status).toBe('done');
    expect(run.notes[0]).toMatch(/were not read \(403\)/);
    expect(p.prompts.some((x) => x.includes('<rules>'))).toBe(false);
  });
});

describe('re-review of new commits', () => {
  const previous: ReviewFinding[] = [
    { id: 'f1', file: 'src/a.ts', line: 2, claim: 'old in a', status: 'verified', fingerprint: 'x1', category: 'logic' },
    { id: 'f2', file: 'src/z.ts', line: 11, claim: 'old in z', status: 'verified', fingerprint: 'x2', category: 'logic' },
  ];

  it('reviews only files changed since the last review and lists earlier findings in other files last', async () => {
    const p = provider({ review: '[{"file":"src/z.ts","line":11,"claim":"new in z"}]', verify: '[{"index":0,"keep":true,"reason":"r"}]' });
    const run = await runReview(newRun('r', target, p, 1), deps(p, { previous: { headSha: 'old', findings: previous }, changedSince: async () => ['src/z.ts'] }));
    expect(p.prompts[0]).toContain('src/z.ts');
    expect(p.prompts[0]).not.toContain('src/a.ts');
    expect(run.incremental).toEqual({ since: 'old', files: 1, carried: 1 });
    expect(run.findings?.map((f) => [f.claim, f.carried ?? false])).toEqual([['new in z', false], ['old in a', true]]);
  });

  it('reviews everything when the history cannot be compared', async () => {
    const p = provider({});
    const run = await runReview(newRun('r', target, p, 1), deps(p, { previous: { headSha: 'old', findings: previous }, changedSince: async () => null }));
    expect(run.incremental).toBeUndefined();
    expect(p.prompts[0]).toContain('src/a.ts');
    expect(run.notes.join(' ')).toMatch(/history changed/);
  });
});

describe('suggested fixes', () => {
  const done = (findings: ReviewFinding[]): RunRecord => ({ ...newRun('r', target, provider({}), 1), status: 'done', headSha: 'abc', findings });
  const f: ReviewFinding = { id: 'f1', file: 'src/a.ts', line: 2, claim: 'b is wrong', status: 'verified', fingerprint: 'fp', category: 'logic' };

  it('stores a valid fix on the finding, and why there is none otherwise', async () => {
    let saved: RunRecord | undefined;
    const p = provider({ fix: '{"startLine":2,"endLine":2,"replacement":"B","explanation":"use B"}' });
    const out = await suggestFix(done([f]), 'f1', { provider: p, fileAt: async () => 'a\nb\nc', save: async (r) => void (saved = r) });
    expect(out.findings?.[0]?.fix).toEqual({ startLine: 2, endLine: 2, replacement: 'B', explanation: 'use B' });
    expect(saved?.usage.inputTokens).toBe(10);
    const none = await suggestFix(done([f]), 'f1', { provider: provider({ fix: '{"none":"needs a migration"}' }), fileAt: async () => 'a\nb\nc', save: async () => undefined });
    expect(none.findings?.[0]?.fixUnavailable).toBe('needs a migration');
  });

  it('posts the fix as a GitHub suggestion with the walkthrough in the review body', async () => {
    const posts: unknown[] = [];
    const api: ApiClient = {
      async get(path, opts) {
        if (opts?.accept === 'diff') return DIFF;
        if (path.endsWith('?per_page=100')) return '[]';
        return JSON.stringify({ head: { sha: 'abc' }, title: 'T' });
      },
      async post(_path, body) {
        posts.push(body);
        return '{}';
      },
    };
    const run = { ...done([{ ...f, fix: { startLine: 2, endLine: 3, replacement: 'B\nC', explanation: '' } }]), summary: { overview: 'Adds b.', files: [], focus: [] } };
    await postFindings(run, ['f1'], new GitHubHost(target, api), 'github');
    const body = posts[0] as { body: string; comments: { line: number; start_line?: number; body: string }[] };
    expect(body.body).toMatch(/^### What this change does\n\nAdds b\./);
    expect(body.comments[0]).toMatchObject({ line: 3, start_line: 2, start_side: 'RIGHT' });
    expect(body.comments[0]?.body).toContain('```suggestion\nB\nC\n```');
  });
});

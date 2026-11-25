import { describe, expect, it } from 'vitest';
import { diagnosticFingerprint, onChangedLines, parseToolOutput, checksLine } from '../src/checks.js';
import { FindingInputSchema } from '../src/finding.js';
import { carryOver, diffPaths, restrictDiff } from '../src/incremental.js';
import { extractIssueRefs, issueRefLabel, issuesText } from '../src/issues.js';
import { selectSpecialists } from '../src/plan.js';
import { buildPostPlan, commentBody, postableHunks, type PostableFinding } from '../src/post.js';
import { buildFixPrompt, buildRequirementsPrompt, buildRulesPrompt, parseFix, parseSummary, summaryMarkdown } from '../src/review/extras.js';
import { ReviewRun } from '../src/run.js';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 one
-two
+TWO
+three
 four
 five
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+x
+y
`;

describe('summary pass', () => {
  it('parses a walkthrough and renders it as markdown without breaking the table', () => {
    const s = parseSummary('Sure: {"overview":"Adds caching.","files":[{"path":"a|b.ts","change":"new | cache"}],"focus":["the TTL"]}');
    expect(s?.overview).toBe('Adds caching.');
    expect(summaryMarkdown(s!)).toContain('| `a b.ts` | new   cache |');
    expect(summaryMarkdown(s!)).toContain('- the TTL');
  });

  it('rejects unreadable replies and tolerates missing lists', () => {
    expect(parseSummary('no json')).toBeNull();
    expect(parseSummary('{"overview":"x","files":"nope"}')?.files).toEqual([]);
  });
});

describe('rules and requirements passes', () => {
  it('embed rules and issues as untrusted blocks with the diff', () => {
    expect(buildRulesPrompt('T', 'D', 'RULE')).toMatch(/<rules>\nRULE\n<\/rules>[\s\S]*<diff>\nD\n<\/diff>/);
    expect(buildRequirementsPrompt('T', 'D', 'ISSUE')).toMatch(/<issues>\nISSUE\n<\/issues>/);
  });
});

describe('suggested fixes', () => {
  const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
  const req = { file: 'a.ts', line: 50, claim: 'off by one', content };

  it('numbers a window of lines around the finding', () => {
    const p = buildFixPrompt('T', req);
    expect(p).toContain('lines="10-90"');
    expect(p).toContain('50: line 50');
    expect(p).not.toContain('9: line 9\n');
  });

  it('accepts a fix inside the window and refuses one outside it or too long', () => {
    expect(parseFix('{"startLine":50,"endLine":50,"replacement":"fixed","explanation":"e"}', req)).toEqual({ startLine: 50, endLine: 50, replacement: 'fixed', explanation: 'e' });
    expect(parseFix('{"startLine":5,"endLine":5,"replacement":"x"}', req)).toBeNull();
    expect(parseFix('{"startLine":20,"endLine":60,"replacement":"x"}', req)).toBeNull();
    expect(parseFix('{"none":"needs a schema change"}', req)).toEqual({ none: 'needs a schema change' });
    expect(parseFix('{"startLine":50,"endLine":50,"replacement":"line 50"}', req)).toEqual({ none: 'the suggested text is the same as the current code' });
  });
});

describe('issue references', () => {
  it('finds #N, owner/repo#N, same-host URLs and Jira keys, not code spans', () => {
    const refs = extractIssueRefs('Fixes #12 and acme/api#7, see https://github.com/acme/web/issues/3 and PAY-881. `#99` ```\n#100\n```', 'github.com');
    expect(refs.map(issueRefLabel)).toEqual(['acme/web#3', 'acme/api#7', '#12', 'PAY-881']);
  });

  it('drops dot segments that would walk API paths', () => {
    expect(extractIssueRefs('see ../..#4 and ./x#5', 'github.com').filter((r) => r.kind === 'host')).toEqual([]);
  });

  it('formats issues with secrets masked', () => {
    expect(issuesText([{ ref: '#1', title: 'T', body: 'key AKIAABCDEFGHIJKLMNOP' }])).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });
});

describe('check results', () => {
  it('parses common tool formats into repo paths', () => {
    const out = [
      'src/a.ts(3,5): error TS2322: Type string is not number.',
      '/repo/src/a.ts:2:1: W291 trailing whitespace',
      'src/b.ts',
      '  1:3  error  Unexpected var  no-var',
      'https://example.com:443: not a file',
      '/etc/passwd:1: outside',
    ].join('\n');
    const d = parseToolOutput('lint', out, '/repo');
    expect(d.map((x) => `${x.file}:${x.line}:${x.level}`)).toEqual(['src/a.ts:3:error', 'src/a.ts:2:warning', 'src/b.ts:1:error']);
  });

  it('keeps only problems on changed lines, once', () => {
    const d = parseToolOutput('lint', 'src/a.ts:2:1: error bad\nsrc/a.ts:2:1: error bad\nsrc/a.ts:5:1: error unchanged\nsrc/z.ts:1:1: error other file');
    expect(onChangedLines(d, DIFF).map((x) => x.line)).toEqual([2]);
    expect(diagnosticFingerprint(d[0]!)).toMatch(/^[0-9a-f]+$/);
  });

  it('summarises checks with failures first', () => {
    expect(checksLine([{ name: 'lint', status: 'failed', diagnostics: [] }, { name: 'test', status: 'passed', diagnostics: [] }, { name: 'e2e', status: 'pending', diagnostics: [] }])).toBe('CI: 1 failing (lint), 1 passed or skipped, 1 still running.');
  });
});

describe('incremental re-review', () => {
  it('keeps only changed files of the PR diff, with PR line numbers', () => {
    const only = restrictDiff(DIFF, new Set(['src/b.ts']));
    expect(only.startsWith('diff --git a/src/b.ts')).toBe(true);
    expect(only).not.toContain('src/a.ts');
    expect([...diffPaths(DIFF)].sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('carries earlier findings in untouched files that are still in the PR', () => {
    const prev = [{ file: 'src/a.ts', id: 1 }, { file: 'src/b.ts', id: 2 }, { file: 'gone.ts', id: 3 }];
    expect(carryOver(prev, new Set(['src/b.ts']), new Set(['src/a.ts', 'src/b.ts'])).map((f) => f.id)).toEqual([1]);
  });
});

describe('posting with suggestions, a cap and a walkthrough', () => {
  const f = (id: string, line: number, over: Partial<PostableFinding> = {}): PostableFinding => ({ id, fingerprint: `fp-${id}`, file: 'src/a.ts', startLine: line, endLine: line, claim: `claim ${id}`, status: 'verified', tags: ['high'], ...over });
  const hunks = postableHunks(DIFF);

  it('posts a one-click suggestion over the fix range on GitHub and GitLab', () => {
    const fix = { startLine: 2, endLine: 3, replacement: 'two\nthree' };
    const gh = buildPostPlan([f('a', 2, { fix })], hunks, new Set(), { flavor: 'github' });
    expect(gh.inline[0]).toMatchObject({ path: 'src/a.ts', line: 3, startLine: 2 });
    expect(gh.inline[0]?.body).toContain('```suggestion\ntwo\nthree\n```');
    const gl = buildPostPlan([f('a', 2, { fix })], hunks, new Set(), { flavor: 'gitlab' });
    expect(gl.inline[0]?.body).toContain('```suggestion:-1+0\ntwo\nthree\n```');
  });

  it('drops a suggestion that is outside one hunk or would be altered by cleaning', () => {
    const outside = buildPostPlan([f('a', 2, { fix: { startLine: 2, endLine: 9, replacement: 'x' } })], hunks, new Set(), { flavor: 'github' });
    expect(outside.inline[0]?.body).not.toContain('suggestion');
    const secret = buildPostPlan([f('a', 2, { fix: { startLine: 2, endLine: 2, replacement: 'k = "AKIAABCDEFGHIJKLMNOP"' } })], hunks, new Set(), { flavor: 'github' });
    expect(secret.inline[0]?.body).not.toContain('suggestion');
  });

  it('caps inline comments, lists the rest, and puts the walkthrough and CI line in the body', () => {
    const plan = buildPostPlan([f('a', 2), f('b', 3), f('c', 4)], hunks, new Set(), { maxInline: 2, walkthrough: '### What this change does\n\nping @octocat', extra: ['CI: 1 failing (lint).'] });
    expect(plan.inline.map((c) => c.findingId)).toEqual(['a', 'b']);
    expect(plan.inSummary).toEqual([{ findingId: 'c', reason: 'over the limit of 2 inline comments' }]);
    expect(plan.summary).toMatch(/^### What this change does/);
    expect(plan.summary).toContain('@​octocat');
    expect(plan.summary).toContain('CI: 1 failing (lint).');
    expect(plan.summary).toContain('More findings (inline comments are capped at 2');
  });

  it('keeps tags intact in the label', () => {
    expect(commentBody(f('a', 2, { tags: ['high', 'logic'] }))).toMatch(/^\*\*RepoSpector\*\* · high · logic · verified/);
  });
});

describe('specialist contract changes', () => {
  const base = { file: 'a.ts', startLine: 1, endLine: 1, severity: 'high', category: 'logic', claim: 'c', evidence: [{ file: 'a.ts', startLine: 1, endLine: 1 }], confidence: 0.5 };

  it('accepts basis (new) and reasoning (older prompts) as the same field', () => {
    expect(FindingInputSchema.safeParse({ ...base, basis: 'b' }).data?.reasoning).toBe('b');
    expect(FindingInputSchema.safeParse({ ...base, reasoning: 'r' }).data?.reasoning).toBe('r');
    expect(FindingInputSchema.safeParse(base).success).toBe(false);
  });

  it('accepts a small fix and refuses a long one', () => {
    expect(FindingInputSchema.safeParse({ ...base, basis: 'b', fix: { startLine: 1, endLine: 2, replacement: 'x' } }).success).toBe(true);
    expect(FindingInputSchema.safeParse({ ...base, basis: 'b', fix: { startLine: 1, endLine: 40, replacement: 'x' } }).success).toBe(false);
  });

  it('runs requirements whenever an issue is linked, except at quick depth', () => {
    expect(selectSpecialists({ tier: 'trivial', depth: 'standard', hasRules: false, hasIssue: true })).toEqual(['logic', 'requirements']);
    expect(selectSpecialists({ tier: 'standard', depth: 'standard', hasRules: false, hasIssue: true })).toContain('requirements');
    expect(selectSpecialists({ tier: 'standard', depth: 'quick', hasRules: false, hasIssue: true })).toEqual(['logic']);
  });

  it('adds a specialist only while reviewing', () => {
    const run = new ReviewRun('r', ['logic'], { lineCount: () => 10, lines: () => [] } as never);
    run.addSpecialist('requirements');
    expect(run.state().pendingSpecialists).toEqual(['logic', 'requirements']);
    run.submitFindings('logic', []);
    run.submitFindings('requirements', []);
    run.startVerification();
    expect(() => run.addSpecialist('security')).toThrow(/reviewing/);
  });
});

import { describe, expect, it } from 'vitest';
import { parseGoldenFile, parsePrUrl } from '../src/martian.js';
import { parseBaselineReply, candidateText } from '../src/baseline.js';
import { buildClaudeArgs, parseClaudeOutput } from '../src/llm.js';

describe('Martian import', () => {
  it('parses PR urls', () => {
    expect(parsePrUrl('https://github.com/grafana/grafana/pull/79265')).toEqual({ repo: 'grafana/grafana', number: 79265 });
    expect(() => parsePrUrl('https://evil.example/x/y/pull/1')).toThrow();
  });

  it('reads golden comment files', () => {
    const cases = parseGoldenFile([
      { pr_title: 'T', url: 'https://github.com/o/r/pull/3', comments: [{ comment: 'Race', severity: 'High', category: 'concurrency' }] },
    ]);
    expect(cases).toEqual([
      { id: 'https://github.com/o/r/pull/3', repo: 'o/r', number: 3, title: 'T', golden: [{ comment: 'Race', severity: 'High', category: 'concurrency' }] },
    ]);
  });
});

describe('baseline reviewer output', () => {
  it('reads a JSON array, tolerating code fences and prose around it', () => {
    const r = parseBaselineReply('Here you go:\n```json\n[{"file":"a.go","line":3,"claim":"nil deref"}]\n```');
    expect(r).toEqual([{ file: 'a.go', line: 3, claim: 'nil deref' }]);
  });

  it('returns null for output that is not a findings array, so failures are visible', () => {
    expect(parseBaselineReply('no issues found')).toBeNull();
    expect(parseBaselineReply('[{"nope":1}]')).toBeNull();
  });

  it('accepts an empty array as a clean review', () => {
    expect(parseBaselineReply('[]')).toEqual([]);
  });

  it('formats candidates for the judge with location', () => {
    expect(candidateText({ file: 'a.go', line: 3, claim: 'nil deref' })).toBe('a.go:3 — nil deref');
  });
});

describe('claude CLI client', () => {
  it('builds a minimal, tool-less, non-persistent call', () => {
    const args = buildClaudeArgs({ model: 'claude-sonnet-4-5-20250929', system: 'S' });
    expect(args).toEqual(
      expect.arrayContaining(['-p', '--model', 'claude-sonnet-4-5-20250929', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json', '--system-prompt', 'S']),
    );
  });

  it('parses the JSON envelope and surfaces errors', () => {
    expect(parseClaudeOutput('{"result":"hi","is_error":false,"total_cost_usd":0.01,"num_turns":4}')).toEqual({ text: 'hi', costUsd: 0.01, turns: 4 });
    expect(() => parseClaudeOutput('{"result":"boom","is_error":true}')).toThrow(/boom/);
    expect(() => parseClaudeOutput('not json')).toThrow();
  });
});

describe('pilotCases', () => {
  it('takes the first two PRs per repo in file order', async () => {
    const { pilotCases } = await import('../src/martian-cli.js');
    const mk = (repo: string, number: number) => ({ id: `${repo}#${number}`, repo, number, title: '', golden: [] });
    const picked = pilotCases([mk('a/x', 1), mk('a/x', 2), mk('a/x', 3), mk('b/y', 1)]);
    expect(picked.map((c) => c.id)).toEqual(['a/x#1', 'a/x#2', 'b/y#1']);
  });
});

describe('verifier pass', () => {
  it('parses verdicts and keeps findings the verifier did not mention, counting them', async () => {
    const { applyVerdicts } = await import('../src/verify.js');
    const findings = [
      { file: 'a', line: 1, claim: 'x' },
      { file: 'b', line: 2, claim: 'y' },
      { file: 'c', line: 3, claim: 'z' },
    ];
    const r = applyVerdicts(findings, '```json\n[{"index":0,"keep":true,"reason":"r"},{"index":1,"keep":false,"reason":"guarded"}]\n```');
    expect(r.kept.map((f) => f.file)).toEqual(['a', 'c']);
    expect(r.unverified).toBe(1);
    expect(r.dropped).toEqual([{ index: 1, reason: 'guarded' }]);
  });

  it('keeps everything and flags the failure when the reply is unparseable', async () => {
    const { applyVerdicts } = await import('../src/verify.js');
    const r = applyVerdicts([{ file: 'a', line: 1, claim: 'x' }], 'sorry');
    expect(r.kept).toHaveLength(1);
    expect(r.parseFailed).toBe(true);
  });
});

describe('heldoutCases', () => {
  it('is exactly the cases not in the pilot', async () => {
    const { pilotCases, heldoutCases } = await import('../src/martian-cli.js');
    const mk = (repo: string, number: number) => ({ id: `${repo}#${number}`, repo, number, title: '', golden: [] });
    const all = [mk('a/x', 1), mk('a/x', 2), mk('a/x', 3), mk('b/y', 1), mk('b/y', 2), mk('b/y', 3)];
    const held = heldoutCases(all).map((c) => c.id);
    expect(held).toEqual(['a/x#3', 'b/y#3']);
    expect(pilotCases(all).some((c) => held.includes(c.id))).toBe(false);
  });
});

describe('claude CLI client with repo access', () => {
  it('allows only the requested read-only tools and caps spend', () => {
    const args = buildClaudeArgs({ model: 'm', tools: ['Read', 'Grep', 'Glob'], maxBudgetUsd: 2 });
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at('--tools')).toBe('Read,Grep,Glob');
    expect(at('--allowedTools')).toBe('Read,Grep,Glob');
    expect(at('--max-budget-usd')).toBe('2');
    expect(at('--setting-sources')).toBe('');
  });
});

describe('claude CLI client matching the extension', () => {
  it('passes effort, and an explicitly empty system prompt (the extension sends none)', () => {
    const args = buildClaudeArgs({ model: 'claude-sonnet-5-5', effort: 'high', system: '' });
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at('--effort')).toBe('high');
    expect(args).toContain('--system-prompt');
    expect(at('--system-prompt')).toBe('');
  });
});

describe('claude CLI client with one MCP tool', () => {
  it('loads only the given MCP config, no built-in tools, and allows only the named MCP tools', () => {
    const args = buildClaudeArgs({ model: 'm', mcpConfig: '/tmp/ctx.json', mcpTools: ['mcp__ctx__get_context'], maxBudgetUsd: 2 });
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at('--tools')).toBe('');
    expect(at('--mcp-config')).toBe('/tmp/ctx.json');
    expect(args).toContain('--strict-mcp-config');
    expect(at('--allowedTools')).toBe('mcp__ctx__get_context');
  });
});

describe('mergeFindings (second pass, rule fixed before measuring)', () => {
  it('adds second-pass findings unless same file within 5 lines of one already kept', async () => {
    const { mergeFindings } = await import('../src/merge.js');
    const a = [{ file: 'x.ts', line: 10, claim: 'a' }];
    const b = [
      { file: 'x.ts', line: 14, claim: 'dup' },
      { file: 'x.ts', line: 30, claim: 'new far' },
      { file: 'y.ts', line: 10, claim: 'new file' },
      { file: 'y.ts', line: 12, claim: 'dup of the one just added' },
    ];
    expect(mergeFindings(a, b).map((f) => f.claim)).toEqual(['a', 'new far', 'new file']);
  });
});

describe('baseline prompt with repo context', () => {
  it('is unchanged without context and adds the addendum and a context block with it', async () => {
    const { buildBaselinePrompt, BASELINE_PROMPT, CONTEXT_ADDENDUM } = await import('../src/baseline.js');
    const plain = buildBaselinePrompt('T', 'DIFF');
    expect(plain).toBe(`${BASELINE_PROMPT}\n\nPR title: T\n\n<diff>\nDIFF\n</diff>`);
    const withCtx = buildBaselinePrompt('T', 'DIFF', 'src/x.ts:3\nfoo()');
    expect(withCtx.startsWith(`${BASELINE_PROMPT}\n\n${CONTEXT_ADDENDUM}`)).toBe(true);
    expect(withCtx).toContain('<repo_context>\nsrc/x.ts:3\nfoo()\n</repo_context>');
    expect(withCtx.indexOf('<repo_context>')).toBeLessThan(withCtx.indexOf('<diff>'));
    expect(buildBaselinePrompt('T', 'DIFF', '')).toBe(plain);
  });
});

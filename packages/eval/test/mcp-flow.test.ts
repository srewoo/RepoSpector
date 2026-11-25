import { describe, expect, it } from 'vitest';
import { flowPrompt, parseFlowStream } from '../src/mcp-flow.js';

const line = (v: unknown): string => JSON.stringify(v);
const use = (id: string, name: string, parent: string | null = null) => line({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const result = (id: string, body: unknown, parent: string | null = null) =>
  line({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }] }] } });

describe('parseFlowStream', () => {
  it('takes findings from the last successful finalize, including one made inside a subagent', () => {
    const stream = [
      use('p1', 'mcp__repospector__plan_review'),
      result('p1', { runId: 'r1', specialists: ['logic'], definitions: { used: 2 } }),
      use('f1', 'mcp__repospector__finalize', 'agent1'),
      result('f1', 'verdicts-missing: f1', 'agent1'),
      use('f2', 'mcp__repospector__finalize', 'agent1'),
      result('f2', { findings: [{ file: 'a.ts', startLine: 3, endLine: 4, claim: 'breaks', status: 'verified', severity: 'high', reasoning: 'x' }] }, 'agent1'),
      line({ type: 'result', total_cost_usd: 1.5, num_turns: 9, is_error: false, result: 'DONE' }),
    ].join('\n');
    const r = parseFlowStream(stream);
    expect(r.findings).toEqual([{ file: 'a.ts', startLine: 3, claim: 'breaks', status: 'verified', severity: 'high' }]);
    expect(r.definitions).toEqual({ used: 2 });
    expect(r.costUsd).toBe(1.5);
    expect(r.error).toBeUndefined();
  });

  it('reports an error when finalize never succeeded, and ignores non-JSON lines', () => {
    const r = parseFlowStream(['not json', use('p1', 'mcp__repospector__plan_review'), line({ type: 'result', is_error: true, result: 'budget exceeded' })].join('\n'));
    expect(r.findings).toBeNull();
    expect(r.error).toBe('budget exceeded');
  });

  it('ignores a finalize-shaped result from another tool', () => {
    const r = parseFlowStream([use('x', 'Read'), result('x', { findings: [{ file: 'a', startLine: 1, claim: 'c', status: 'verified' }] })].join('\n'));
    expect(r.findings).toBeNull();
  });
});

describe('flowPrompt', () => {
  it('pins base and head and stops before posting', () => {
    const p = flowPrompt('a'.repeat(40), 'b'.repeat(40));
    expect(p).toContain(`base "${'a'.repeat(40)}"`);
    expect(p).toContain(`head "${'b'.repeat(40)}"`);
    expect(p).not.toContain('Posting (only on request)');
    expect(p).toContain('skip_specialist');
  });
});

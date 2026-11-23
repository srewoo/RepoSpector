import { describe, expect, it } from 'vitest';
import { buildCrossFilePrompt, CROSSFILE_PROMPT, reviewCrossFile } from '../src/crossfile.js';
import type { LlmClient, LlmOptions } from '../src/llm.js';

class FakeLlm implements LlmClient {
  prompts: string[] = [];
  constructor(private readonly reply: string) {}
  async complete(prompt: string, _opts: LlmOptions) {
    this.prompts.push(prompt);
    return { text: this.reply, costUsd: 0, turns: 1 };
  }
}

describe('cross-file pass', () => {
  it('puts the context before the diff, both marked as untrusted blocks', () => {
    const p = buildCrossFilePrompt('T', 'DIFF', 'src/x.ts:3\nfoo()');
    expect(p.startsWith(CROSSFILE_PROMPT)).toBe(true);
    expect(p.indexOf('<repo_context>\nsrc/x.ts:3\nfoo()\n</repo_context>')).toBeLessThan(p.indexOf('<diff>\nDIFF\n</diff>'));
  });

  it('makes no model call when there is no context', async () => {
    const llm = new FakeLlm('[]');
    expect(await reviewCrossFile('T', 'DIFF', '', llm, 'sonnet')).toEqual({ findings: [], skipped: true, raw: '' });
    expect(llm.prompts).toHaveLength(0);
  });

  it('parses findings in the baseline format, including files outside the diff', async () => {
    const llm = new FakeLlm('[{"file":"src/caller.ts","line":12,"claim":"still passes two args"}]');
    const r = await reviewCrossFile('T', 'DIFF', 'ctx', llm, 'sonnet');
    expect(r.findings).toEqual([{ file: 'src/caller.ts', line: 12, claim: 'still passes two args' }]);
    expect(r.skipped).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { JUDGE_PROMPT, judgeReview, parseJudgeReply, totalsOf } from '../src/judge.js';
import type { LlmClient } from '../src/llm.js';

/** Fake judge: matches when the candidate text contains the golden's key word. */
function fakeLlm(confidences: Record<string, number> = {}): LlmClient & { calls: number } {
  const client = {
    calls: 0,
    async complete(prompt: string) {
      client.calls++;
      const golden = prompt.split('Golden Comment (the issue we\'re looking for):\n')[1]?.split('\n')[0] ?? '';
      const candidate = prompt.split('Candidate Issue (from the tool\'s review):\n')[1]?.split('\n')[0] ?? '';
      const key = golden.split(' ')[0] ?? '';
      const match = candidate.includes(key);
      return { text: `\`\`\`json\n{"reasoning":"r","match":${match},"confidence":${confidences[candidate] ?? 0.9}}\n\`\`\``, costUsd: 0.001, turns: 1 };
    },
  };
  return client;
}

describe('JUDGE_PROMPT', () => {
  it('is Martian\'s prompt verbatim', () => {
    expect(JUDGE_PROMPT).toContain('Accept semantic matches - different wording is fine if it\'s the same problem');
    expect(JUDGE_PROMPT).toContain('{{"reasoning": "brief explanation", "match": true/false, "confidence": 0.0-1.0}}'.replace(/\{\{/g, '{').replace(/\}\}/g, '}'));
  });
});

describe('parseJudgeReply', () => {
  it('strips code fences and reads match and confidence', () => {
    expect(parseJudgeReply('```json\n{"match": true, "confidence": 0.7, "reasoning": "x"}\n```')).toEqual({ match: true, confidence: 0.7, reasoning: 'x' });
  });
  it('returns null on unparseable replies so they count as errors, not as non-matches', () => {
    expect(parseJudgeReply('I think yes')).toBeNull();
  });
});

describe('judgeReview', () => {
  it('counts TP per matched golden, FP per unmatched candidate, FN per unmatched golden', async () => {
    const r = await judgeReview(['race in device check', 'cache stays set'], ['race: two requests pass', 'typo in log'], fakeLlm(), 'm');
    expect(r).toMatchObject({ tp: 1, fp: 1, fn: 1, errors: 0, pairs: 4 });
    expect(r.matches).toEqual([{ golden: 'race in device check', candidate: 'race: two requests pass' }]);
  });

  it('follows Martian: a candidate is marked matched only when it raises a golden\'s best confidence', async () => {
    // Both candidates match the same golden; the second has lower confidence, so it stays a false positive.
    const llm = fakeLlm({ 'race A': 0.9, 'race B': 0.5 });
    const r = await judgeReview(['race'], ['race A', 'race B'], llm, 'm');
    expect(r).toMatchObject({ tp: 1, fp: 1, fn: 0 });
  });

  it('handles no candidates without calling the model', async () => {
    const llm = fakeLlm();
    expect(await judgeReview(['a', 'b'], [], llm, 'm')).toMatchObject({ tp: 0, fp: 0, fn: 2 });
    expect(llm.calls).toBe(0);
  });

  it('reports judge errors separately', async () => {
    const broken: LlmClient = { complete: async () => ({ text: 'nonsense', costUsd: 0, turns: 1 }) };
    const r = await judgeReview(['a'], ['b'], broken, 'm');
    expect(r.errors).toBe(1);
  });

  it('uses the cache so reruns cost nothing', async () => {
    const llm = fakeLlm();
    const cache = new Map<string, string>();
    await judgeReview(['race'], ['race x'], llm, 'm', cache);
    await judgeReview(['race'], ['race x'], llm, 'm', cache);
    expect(llm.calls).toBe(1);
  });
});

describe('totalsOf', () => {
  it('micro-averages like Martian\'s dashboard', () => {
    const t = totalsOf([
      { tp: 2, fp: 2, fn: 0 },
      { tp: 0, fp: 0, fn: 2 },
    ]);
    expect(t).toMatchObject({ tp: 2, fp: 2, fn: 2, precision: 0.5, recall: 0.5, f1: 0.5 });
  });
});

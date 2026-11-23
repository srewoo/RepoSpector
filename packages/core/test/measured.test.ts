import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BASELINE_PROMPT, buildVerifyPrompt, parseBaselineReply, parseVerdicts, VERIFY_PROMPT } from '../src/review/measured.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

describe('measured prompts', () => {
  it('are byte-identical to the prompts scored in the eval runs', () => {
    // From eval/runs/*/manifest.json promptSha. Changing a prompt needs a new eval run first.
    expect(sha(BASELINE_PROMPT)).toBe('07c6d2be7bf3');
    expect(sha(VERIFY_PROMPT)).toBe('7b7b9ac08f33'); // with confidence for ranking (2026-11-22); was 197696df9a53
  });

  it('parses review findings and verdicts, and rejects malformed replies', () => {
    expect(parseBaselineReply('ok [{"file":"a.ts","line":3,"claim":"x"}]')).toEqual([{ file: 'a.ts', line: 3, claim: 'x' }]);
    expect(parseBaselineReply('nothing')).toBeNull();
    expect(parseVerdicts('[{"index":0,"keep":false,"reason":"guard at line 2"}]')).toEqual([{ index: 0, keep: false, reason: 'guard at line 2' }]);
    expect(parseVerdicts('[{"index":"0"}]')).toBeNull();
  });

  it('reads the verifier confidence, clamped to 0..100, and tolerates replies without it', () => {
    expect(parseVerdicts('[{"index":0,"keep":true,"confidence":85,"reason":"r"}]')).toEqual([{ index: 0, keep: true, confidence: 85, reason: 'r' }]);
    expect(parseVerdicts('[{"index":0,"keep":true,"confidence":140,"reason":"r"},{"index":1,"keep":false,"confidence":-3,"reason":"r"}]')?.map((v) => v.confidence)).toEqual([100, 0]);
    expect(parseVerdicts('[{"index":0,"keep":true,"reason":"r"}]')?.[0]?.confidence).toBeUndefined();
    expect(VERIFY_PROMPT).toContain('"confidence"');
  });

  it('lists findings by index in the verify prompt', () => {
    expect(buildVerifyPrompt('T', 'D', [{ file: 'a.ts', line: 3, claim: 'x' }])).toContain('<findings>\n0. a.ts:3');
  });
});

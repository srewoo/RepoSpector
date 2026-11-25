import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BASELINE_PROMPT, RECALL_PROMPT, buildDefinitionsPrompt, buildVerifyPrompt, DEFINITIONS_ADDENDUM, mergePasses, parseBaselineReply, parseVerdicts, VERIFY_PROMPT } from '../src/review/measured.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

describe('measured prompts', () => {
  it('are byte-identical to the prompts scored in the eval runs', () => {
    // From eval/runs/*/manifest.json promptSha. Changing a prompt needs a new eval run first.
    expect(sha(BASELINE_PROMPT)).toBe('07c6d2be7bf3');
    // + impact rating for display (2026-11-24, user request). NOT yet re-scored: keep rules and the
    // confidence text are unchanged, but the added field may shift verdicts. Was 7b7b9ac08f33 (confidence), 197696df9a53.
    expect(sha(VERIFY_PROMPT)).toBe('51f6a68f2b98');
    // The extension's review pass since 2026-11-24 (eval/runs/pilot-ext-s55-recall, regr-ext-s55-recall).
    expect(sha(RECALL_PROMPT)).toBe('1090099a6415');
  });

  it('keeps the repository-context pass identical to the measured "callee definitions" eval arm', () => {
    // eval/runs/*-definitions*/manifest.json promptSha (BASELINE_PROMPT + DEFINITIONS_ADDENDUM).
    expect(sha(BASELINE_PROMPT + DEFINITIONS_ADDENDUM)).toBe('6d1dc4d972fd');
    const p = buildDefinitionsPrompt('T', 'D', 'DEFS');
    expect(p.startsWith(`${BASELINE_PROMPT}\n\n${DEFINITIONS_ADDENDUM}\n\nPR title: T`)).toBe(true);
    expect(p).toContain('<definitions>\nDEFS\n</definitions>');
  });

  it('merges two passes: a later finding within 5 lines in the same file is a duplicate', () => {
    const a = [{ file: 'a.ts', line: 10, claim: 'x' }];
    const b = [{ file: 'a.ts', line: 15, claim: 'dup' }, { file: 'a.ts', line: 16, claim: 'new' }, { file: 'b.ts', line: 10, claim: 'other file' }];
    expect(mergePasses(a, b).map((f) => f.claim)).toEqual(['x', 'new', 'other file']);
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

  it('reads the impact rating case-insensitively, and treats a missing or unknown one as unrated', () => {
    const v = parseVerdicts('[{"index":0,"keep":true,"impact":"High","reason":"r"},{"index":1,"keep":true,"impact":"critical","reason":"r"},{"index":2,"keep":true,"reason":"r"}]');
    expect(v?.map((x) => x.impact)).toEqual(['high', undefined, undefined]);
    // An unknown impact never makes the whole reply unreadable.
    expect(v).toHaveLength(3);
    expect(VERIFY_PROMPT).toContain('"impact": "high"|"medium"|"low"');
  });

  it('lists findings by index in the verify prompt', () => {
    expect(buildVerifyPrompt('T', 'D', [{ file: 'a.ts', line: 3, claim: 'x' }])).toContain('<findings>\n0. a.ts:3');
  });
});

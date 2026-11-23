import { describe, expect, it } from 'vitest';
import { applyFeedback, feedbackEntry, mergeFeedback, parseFeedbackJsonl, toFeedbackJsonl, type FeedbackEntry } from '../src/feedback.js';
import type { JudgedFinding } from '../src/finding.js';

const finding = (over: Partial<JudgedFinding> = {}): JudgedFinding => ({
  id: 'f1',
  file: 'src/a.ts',
  startLine: 3,
  endLine: 3,
  severity: 'low',
  category: 'logic',
  reasoning: 'r',
  claim: 'Variable name total shadows the outer total and could confuse readers',
  evidence: [{ file: 'src/a.ts', startLine: 3, endLine: 3 }],
  confidence: 0.8,
  specialist: 'logic',
  fingerprint: 'fp-1',
  verdict: { findingId: 'f1', keep: true, reason: 'ok' },
  expectedPrecision: null,
  status: 'verified',
  ...over,
});

const rejected = (claim: string, fingerprint = 'other', category = 'logic'): FeedbackEntry =>
  feedbackEntry({ ...finding({ claim, fingerprint, category: category as JudgedFinding['category'] }) }, 'rejected', 'noise', new Date('2026-11-01T00:00:00Z'));

describe('applyFeedback', () => {
  it('demotes a finding the team rejected before (same fingerprint), even once', () => {
    const [f] = applyFeedback([finding()], [rejected('anything', 'fp-1')]);
    expect(f?.status).toBe('suspected');
    expect(f?.suspectedBecause).toMatch(/rejected this same finding before/);
  });

  it('demotes a finding similar to 3 or more rejected comments of the same category, but not 2', () => {
    const similar = 'Variable total shadows the outer total and may confuse readers';
    expect(applyFeedback([finding()], [rejected(similar), rejected(similar)])[0]?.status).toBe('verified');
    const [f] = applyFeedback([finding()], [rejected(similar), rejected(similar), rejected(similar)]);
    expect(f?.status).toBe('suspected');
    expect(f?.suspectedBecause).toMatch(/similar to 3 comments your team rejected/);
  });

  it('ignores rejections in another category or with different wording', () => {
    const similar = 'Variable total shadows the outer total and may confuse readers';
    const other = [rejected(similar, 'x', 'security'), rejected(similar, 'y', 'security'), rejected(similar, 'z', 'security')];
    expect(applyFeedback([finding()], other)[0]?.status).toBe('verified');
    const unrelated = [rejected('SQL query built by string concatenation'), rejected('SQL query built by string concatenation'), rejected('SQL query built by string concatenation')];
    expect(applyFeedback([finding()], unrelated)[0]?.status).toBe('verified');
  });

  it('lets acceptances outweigh rejections for similar comments', () => {
    const similar = 'Variable total shadows the outer total and may confuse readers';
    const accepted = feedbackEntry(finding({ claim: similar, fingerprint: 'a' }), 'accepted', '', new Date());
    const [f] = applyFeedback([finding()], [rejected(similar), rejected(similar), rejected(similar), accepted, accepted, accepted]);
    expect(f?.status).toBe('verified');
  });

  it('keeps every finding: demoted findings stay in the list, after verified ones', () => {
    const out = applyFeedback([finding({ id: 'a', fingerprint: 'fp-1' }), finding({ id: 'b', fingerprint: 'fp-2' })], [rejected('x', 'fp-1')]);
    expect(out.map((f) => `${f.id}:${f.status}`)).toEqual(['b:verified', 'a:suspected']);
  });
});

describe('feedback JSONL', () => {
  it('round-trips, skips malformed lines, and redacts secrets in reasons', () => {
    const e = feedbackEntry(finding(), 'rejected', 'token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa leaked', new Date('2026-11-01T00:00:00Z'));
    expect(e.reason).not.toContain('ghp_');
    const text = `${toFeedbackJsonl([e])}not json\n{"fingerprint":1}\n`;
    expect(parseFeedbackJsonl(text)).toEqual([e]);
  });

  it('merges without duplicating the same reaction', () => {
    const e = feedbackEntry(finding(), 'rejected', 'noise', new Date('2026-11-01T00:00:00Z'));
    expect(mergeFeedback([e], [e, { ...e, reaction: 'accepted' }])).toHaveLength(2);
  });
});

describe('applyFeedback with a meaning match', () => {
  it('also counts rejections that share meaning but not words, and only adds to word overlap', () => {
    const rejected = ['Variable name is unclear here', 'Identifier naming could be better', 'Rename this to something clearer'].map((claim, i) =>
      feedbackEntry({ ...finding({ claim, fingerprint: `r${i}` }) }, 'rejected', 'noise', new Date('2026-11-01T00:00:00Z')),
    );
    const f = { ...finding({ claim: 'Consider a more descriptive label for this value', fingerprint: 'new' }), status: 'verified' as const };
    expect(applyFeedback([f], rejected)[0]?.status).toBe('verified'); // no shared words: word overlap misses it
    const sameMeaning = (a: string, b: string) => b.startsWith('Consider a more descriptive') && /nam|clear/i.test(a);
    const [out] = applyFeedback([f], rejected, sameMeaning);
    expect(out).toMatchObject({ status: 'suspected', suspectedBecause: 'similar to 3 comments your team rejected' });
  });
});

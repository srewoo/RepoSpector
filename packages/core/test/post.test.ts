import { describe, expect, it } from 'vitest';
import type { JudgedFinding } from '../src/finding.js';
import { buildPostPlan as buildFromPostable, commentBody as bodyOf, fromJudged, markerFor, postableHunks, type PostableHunks } from '../src/post.js';

const commentBody = (f: JudgedFinding) => bodyOf(fromJudged(f));
const buildPostPlan = (fs: JudgedFinding[], h: PostableHunks, e: Set<string>) => buildFromPostable(fs.map(fromJudged), h, e);

const finding = (over: Partial<JudgedFinding> = {}): JudgedFinding => ({
  id: 'f1',
  file: 'src/cart.js',
  startLine: 3,
  endLine: 4,
  severity: 'high',
  category: 'logic',
  reasoning: 'Loop runs one past the end.',
  claim: 'TypeError: loop reads items[length]',
  evidence: [{ file: 'src/cart.js', startLine: 3, endLine: 4 }],
  confidence: 0.9,
  specialist: 'logic',
  fingerprint: 'fp-1',
  verdict: { findingId: 'f1', keep: true, reason: 'Confirmed at line 3.' },
  expectedPrecision: null,
  status: 'verified',
  ...over,
});

const DIFF = `diff --git a/src/cart.js b/src/cart.js
--- a/src/cart.js
+++ b/src/cart.js
@@ -1,6 +1,6 @@
 export function total(items) {
   let sum = 0;
-  for (let i = 0; i < items.length; i++) {
+  for (let i = 0; i <= items.length; i++) {
     sum += items[i].price;
   }
   return sum;
`;

describe('postableHunks', () => {
  it('lists the new-file line ranges of each hunk', () => {
    expect(postableHunks(DIFF).get('src/cart.js')).toEqual([[1, 6]]);
  });
});

describe('commentBody', () => {
  it('carries the claim, why, verifier note, label and a hidden marker', () => {
    const body = commentBody(finding());
    expect(body).toContain('TypeError: loop reads items[length]');
    expect(body).toContain('Loop runs one past the end.');
    expect(body).toContain('Confirmed at line 3.');
    expect(body).toContain('high');
    expect(body.endsWith(markerFor('fp-1'))).toBe(true);
  });

  it('labels suspected findings with the reason', () => {
    expect(commentBody(finding({ status: 'suspected', suspectedBecause: 'verifier found a guard' }))).toMatch(/suspected.*verifier found a guard/i);
  });

  it('defuses mentions, fake markers and secrets in model-written text', () => {
    const body = commentBody(finding({ claim: 'ping @octocat <!-- repospector:fake --> key AKIAABCDEFGHIJKLMNOP', reasoning: 'x' }));
    expect(body).not.toMatch(/@octocat/);
    expect(body.match(/<!--/g)).toHaveLength(1);
    expect(body).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });
});

describe('commentBody for a finding without severity or explanation (extension)', () => {
  it('labels with its tags and status only, and still ends with the marker', () => {
    const body = bodyOf({ id: 'f1', fingerprint: 'fp-2', file: 'a.ts', startLine: 2, endLine: 2, claim: 'Null deref', status: 'verified', tags: [] });
    expect(body).toBe(`**RepoSpector** · verified\n\nNull deref\n\n${markerFor('fp-2')}`);
  });
});

describe('buildPostPlan', () => {
  it('anchors a finding inside a hunk inline, at its last line', () => {
    const plan = buildPostPlan([finding()], postableHunks(DIFF), new Set());
    expect(plan.inline).toEqual([expect.objectContaining({ findingId: 'f1', path: 'src/cart.js', line: 4 })]);
    expect(plan.inSummary).toEqual([]);
  });

  it('falls back to the summary when no line of the finding is in the diff', () => {
    const plan = buildPostPlan([finding({ file: 'src/other.js', evidence: [{ file: 'src/other.js', startLine: 9, endLine: 9 }] })], postableHunks(DIFF), new Set());
    expect(plan.inline).toEqual([]);
    expect(plan.inSummary).toEqual([expect.objectContaining({ findingId: 'f1' })]);
    expect(plan.summary).toContain('src/other.js');
  });

  it('skips findings already posted, by fingerprint marker', () => {
    const plan = buildPostPlan([finding()], postableHunks(DIFF), new Set(['fp-1']));
    expect(plan.inline).toEqual([]);
    expect(plan.alreadyPosted).toEqual(['f1']);
  });

  it('writes a summary with counts even when everything is inline', () => {
    const plan = buildPostPlan([finding()], postableHunks(DIFF), new Set());
    expect(plan.summary).toMatch(/1 finding/);
  });
});

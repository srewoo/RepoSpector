import { describe, expect, it } from 'vitest';
import { CONCISE_CHECKLIST_PROMPT, CONCISE_PROMPT } from '../src/review/candidates.js';
import { parseBaselineReply, RECALL_PROMPT } from '../src/review/measured.js';

describe('review prompt arms', () => {
  it('keep the recall search and add the one-defect, 30-word claim rule', () => {
    const hunk = RECALL_PROMPT.split('\n\n')[1] ?? '';
    for (const p of [CONCISE_PROMPT, CONCISE_CHECKLIST_PROMPT]) {
      expect(p).toContain(hunk);
      expect(p).toContain('at most 30 words');
      expect(p).toContain('"assumes"');
    }
    expect(CONCISE_CHECKLIST_PROMPT).toContain('compare each removed line');
    expect(CONCISE_PROMPT).not.toContain('compare each removed line');
  });

  it('parse with the existing reader; "assumes" is dropped from the finding', () => {
    expect(parseBaselineReply('[{"file":"a.ts","line":2,"claim":"c","assumes":"x"}]')).toEqual([{ file: 'a.ts', line: 2, claim: 'c' }]);
  });
});

import { describe, expect, it } from 'vitest';
import { selectSpecialists } from '../src/plan.js';
import { splitDiffByFile } from '../src/diff.js';
import { specialistPrompt, verifierPrompt } from '../src/prompts.js';
import { CATEGORIES } from '../src/finding.js';

describe('selectSpecialists', () => {
  it('runs one combined pass for trivial changes and quick depth', () => {
    expect(selectSpecialists({ tier: 'trivial', depth: 'standard', hasRules: true, hasIssue: false })).toEqual(['logic']);
    expect(selectSpecialists({ tier: 'high', depth: 'quick', hasRules: true, hasIssue: false })).toEqual(['logic']);
  });

  it('adds concurrency for high risk and rules when the repo has them', () => {
    expect(selectSpecialists({ tier: 'standard', depth: 'standard', hasRules: false, hasIssue: false })).toEqual(['logic', 'security', 'tests']);
    expect(selectSpecialists({ tier: 'high', depth: 'standard', hasRules: true, hasIssue: false })).toEqual([
      'logic',
      'security',
      'concurrency',
      'tests',
      'rules',
    ]);
  });

  it('runs everything applicable at deep depth, and requirements only with an issue', () => {
    expect(selectSpecialists({ tier: 'trivial', depth: 'deep', hasRules: false, hasIssue: true })).toEqual([
      'logic',
      'security',
      'concurrency',
      'tests',
      'duplication',
      'requirements',
    ]);
  });

  it('runs nothing when the change is skipped', () => {
    expect(selectSpecialists({ tier: 'skip', depth: 'deep', hasRules: true, hasIssue: true })).toEqual([]);
  });
});

describe('splitDiffByFile', () => {
  it('splits raw diff text at file headers', () => {
    const parts = splitDiffByFile('diff --git a/x b/x\n+1\ndiff --git a/y b/y\n+2\n');
    expect(parts).toEqual(['diff --git a/x b/x\n+1\n', 'diff --git a/y b/y\n+2\n']);
  });
});

describe('prompts', () => {
  it.each(CATEGORIES)('has a %s prompt that treats repo content as data and asks for evidence', (c) => {
    const p = specialistPrompt(c);
    expect(p).toMatch(/untrusted/i);
    expect(p).toMatch(/evidence/);
    expect(p).toMatch(/submit_findings/);
  });

  it('has a verifier prompt that requires a citation either way', () => {
    expect(verifierPrompt()).toMatch(/citation/);
    expect(verifierPrompt()).toMatch(/disprove/i);
  });
});

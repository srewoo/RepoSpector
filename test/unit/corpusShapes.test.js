/**
 * P1-7 — the case shapes the public-PR corpus cannot contain.
 *
 * `public-prs.json` is sampled from pull requests that attracted human review
 * comments. That frame makes it useful and also makes it structurally silent
 * about four shapes: a clean PR (nobody comments, so it is never collected), a
 * deletion-only change (rarely commented on inline), a malformed provider
 * response and a truncated diff (both properties of a RUN, not of any PR).
 *
 * So those four are hand-authored, and every case says `synthetic: true`. This
 * file pins that label and the coverage arithmetic, because the failure mode is
 * quiet: a designed input pooled with a sampled one produces a figure that
 * describes neither, and nothing in a percentage says which it was.
 */
const fs = require('node:fs');
const path = require('node:path');
const { validateCorpus } = require('../../eval/lib/corpus.js');
const { coverageOf, categoriesOf, CATEGORIES } = require('../../eval/lib/caseCategories.js');
const { isCleanCase, classifyReference } = require('../../eval/lib/benchmarkReport.js');

const ROOT = path.join(__dirname, '..', '..');
const shapes = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval/corpus/shapes.json'), 'utf8'));
const publicPrs = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval/corpus/public-prs.json'), 'utf8'));

const casesOf = (c) => (Array.isArray(c) ? c : c.cases);

describe('the hand-authored corpus', () => {
    it('validates against the corpus schema', () => {
        expect(validateCorpus(shapes)).toHaveLength(casesOf(shapes).length);
    });

    it('labels every case synthetic, so it can never be quoted as sampled evidence', () => {
        for (const kase of casesOf(shapes)) {
            expect(kase.synthetic).toBe(true);
            expect(typeof kase.note).toBe('string');
        }
    });

    it('carries the four shapes the public corpus structurally cannot', () => {
        const present = coverageOf(casesOf(shapes)).present;
        for (const shape of [
            CATEGORIES.CLEAN,
            CATEGORIES.DELETIONS,
            CATEGORIES.MALFORMED_PROVIDER,
            CATEGORIES.INCOMPLETE_REPO,
        ]) {
            expect(present[shape]).toBeGreaterThan(0);
        }
    });

    it('together with the public corpus, covers every declared shape', () => {
        const combined = coverageOf([...casesOf(shapes), ...casesOf(publicPrs)]);
        expect(combined.missing).toEqual([]);
    });

    it('survives the loader with the fields the report needs', () => {
        const loaded = validateCorpus(shapes);
        expect(loaded.some((c) => Array.isArray(c.categories))).toBe(true);
        expect(loaded.filter((c) => c.incomplete === true)).toHaveLength(2);
    });
});

describe('the clean cases really are clean', () => {
    const clean = casesOf(shapes).filter((c) => (c.categories || []).includes(CATEGORIES.CLEAN));

    it('has more than one, so the per-clean-PR rate is not a single sample', () => {
        expect(clean.length).toBeGreaterThan(1);
    });

    it('carries no reference defect, so every finding on one is a cost', () => {
        for (const kase of clean) {
            expect(isCleanCase(kase)).toBe(true);
            expect(kase.humanComments).toHaveLength(0);
        }
    });
});

describe('the deletion cases pin both directions of P1-1', () => {
    const byId = Object.fromEntries(casesOf(shapes).map((c) => [c.id, c]));

    it('the positive control removes a guard and has no added line to anchor to', () => {
        const kase = byId['deletion-authorization-guard'];
        const patch = kase.prData.files[0].patch;
        expect(patch).toMatch(/-\s+if \(!req\.user\.canRead/);
        // No added lines at all: a finding here cannot be reported on a new-side
        // line, which is the whole difficulty.
        expect(patch.split('\n').filter((l) => l.startsWith('+'))).toHaveLength(0);
        expect(classifyReference(kase.humanComments[0])).toBe('defect');
    });

    it('the negative control removes only dead code and expects nothing', () => {
        const kase = byId['deletion-dead-code'];
        expect(kase.humanComments).toHaveLength(0);
        expect(categoriesOf(kase)).toContain(CATEGORIES.DELETIONS);
    });

    it('the removed-test case asks a question rather than asserting a break', () => {
        const kase = byId['deletion-sole-regression-test'];
        expect(kase.humanComments[0].body).toMatch(/deliberate/i);
    });
});

describe('the incompleteness cases are marked incomplete', () => {
    it('a malformed provider response is a run that could not finish', () => {
        const kase = casesOf(shapes).find((c) => c.id === 'malformed-provider-output');
        expect(kase.incomplete).toBe(true);
    });

    it('a truncated diff carries the provider\'s own omission record', () => {
        const kase = casesOf(shapes).find((c) => c.id === 'incomplete-repository-truncated-diff');
        expect(kase.incomplete).toBe(true);
        expect(kase.prData.completeness.omissions[0].kind).toBe('provider-truncated');
    });
});

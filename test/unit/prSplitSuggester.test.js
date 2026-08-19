/**
 * A split suggestion is unsolicited advice about work already finished, so the
 * default must be silence and every "yes" must be obviously right. These tests
 * are weighted accordingly: most of them assert the suggester stays quiet.
 */
const {
    suggestSplit,
    renderSplitSuggestion,
    SPLIT_DEFAULTS,
} = require('../../src/utils/prSplitSuggester.js');

/** Files with no imports, so independence holds unless a test adds one. */
const files = (...names) => names.map(filename => ({ filename, patch: '@@ -1 +1,2 @@\n+const x = 1;' }));

/** Two clean, independent feature areas of 6 files each. */
const twoFeatures = () => files(
    ...Array.from({ length: 6 }, (_, i) => `src/billing/mod${i}.js`),
    ...Array.from({ length: 6 }, (_, i) => `src/reporting/mod${i}.js`),
);

describe('suggestSplit — when it stays quiet', () => {
    it('says nothing about a small PR', () => {
        const res = suggestSplit({ files: files('src/a/x.js', 'src/b/y.js') });
        expect(res.splittable).toBe(false);
        expect(res.reason).toBe('too-few-files');
    });

    it('says nothing when everything is one feature area', () => {
        const res = suggestSplit({
            files: files(...Array.from({ length: 12 }, (_, i) => `src/billing/mod${i}.js`)),
        });
        expect(res.splittable).toBe(false);
        expect(res.reason).toBe('single-cluster');
    });

    it('says nothing when the clusters import from each other', () => {
        // A split that breaks the build is worse than no suggestion.
        const list = twoFeatures();
        list[0].patch = "@@ -1 +1,2 @@\n+import { helper } from '../reporting/mod3';";
        const res = suggestSplit({ files: list });
        expect(res.splittable).toBe(false);
        expect(res.reason).toBe('clusters-are-coupled');
    });

    it('detects coupling via require, python and go import forms too', () => {
        for (const stmt of [
            "+const h = require('../reporting/mod3');",
            '+from reporting.mod3 import helper',
            '+import "src/reporting/mod3"',
        ]) {
            const list = twoFeatures();
            list[0].patch = `@@ -1 +1,2 @@\n${stmt}`;
            expect(suggestSplit({ files: list }).reason).toBe('clusters-are-coupled');
        }
    });

    it('says nothing when a file would be left out of every group', () => {
        // A suggestion that omits files reads as "these can be dropped".
        const res = suggestSplit({
            files: files(
                ...Array.from({ length: 6 }, (_, i) => `src/billing/mod${i}.js`),
                ...Array.from({ length: 5 }, (_, i) => `src/reporting/mod${i}.js`),
                'stray.js', // root-level, alone, so its cluster is below the floor
            ),
        });
        expect(res.splittable).toBe(false);
        expect(res.reason).toBe('incomplete-coverage');
    });

    it('says nothing when the PR fragments into too many groups', () => {
        const many = [];
        for (let g = 0; g < 6; g++) {
            for (let i = 0; i < 2; i++) many.push(`src/area${g}/mod${i}.js`);
        }
        const res = suggestSplit({ files: files(...many) });
        expect(res.splittable).toBe(false);
        expect(res.reason).toBe('too-fragmented');
    });

    it('handles an empty or malformed PR without throwing', () => {
        expect(suggestSplit({}).splittable).toBe(false);
        expect(suggestSplit(null).splittable).toBe(false);
        expect(suggestSplit({ files: [{}, { filename: null }] }).splittable).toBe(false);
    });
});

describe('suggestSplit — when it speaks', () => {
    it('proposes two independent groups for two unrelated feature areas', () => {
        const res = suggestSplit({ files: twoFeatures() });

        expect(res.splittable).toBe(true);
        expect(res.clusters).toHaveLength(2);
        expect(res.clusters.map(c => c.title).sort()).toEqual(['src/billing', 'src/reporting']);
        // No file appears in two groups.
        const all = res.clusters.flatMap(c => c.files);
        expect(new Set(all).size).toBe(all.length);
        expect(all).toHaveLength(12);
    });

    it('keeps tests with the code they cover rather than in a tests group', () => {
        // Proposing that implementation and tests ship separately is exactly the
        // wrong advice.
        const list = files(
            ...Array.from({ length: 5 }, (_, i) => `src/billing/mod${i}.js`),
            ...Array.from({ length: 5 }, (_, i) => `src/reporting/mod${i}.js`),
            'src/billing/mod0.test.js',
            'src/reporting/mod0.test.js',
        );
        const res = suggestSplit({ files: list });

        expect(res.splittable).toBe(true);
        expect(res.clusters.map(c => c.title).sort()).toEqual(['src/billing', 'src/reporting']);
        const billing = res.clusters.find(c => c.title === 'src/billing');
        expect(billing.files).toContain('src/billing/mod0.test.js');
        expect(res.clusters.some(c => /test/i.test(c.title))).toBe(false);
    });

    it('respects an overridden file floor', () => {
        const small = files('src/a/one.js', 'src/a/two.js', 'src/b/one.js', 'src/b/two.js');
        expect(suggestSplit({ files: small }).splittable).toBe(false);
        expect(suggestSplit({ files: small }, { minFiles: 4 }).splittable).toBe(true);
    });

    it('exposes conservative defaults', () => {
        expect(SPLIT_DEFAULTS.minFiles).toBe(10);
        expect(SPLIT_DEFAULTS.minClusterFiles).toBe(2);
        expect(SPLIT_DEFAULTS.maxClusters).toBe(4);
    });
});

describe('renderSplitSuggestion', () => {
    it('renders nothing when there is no suggestion', () => {
        expect(renderSplitSuggestion({ splittable: false, clusters: [] })).toBe('');
        expect(renderSplitSuggestion(null)).toBe('');
    });

    it('names each group with its file count', () => {
        const out = renderSplitSuggestion(suggestSplit({ files: twoFeatures() }));
        expect(out).toContain('### This PR looks separable');
        expect(out).toContain('**src/billing** (6 files)');
        expect(out).toContain('**src/reporting** (6 files)');
    });

    it('frames it as reviewable in parts, not as a reprimand', () => {
        const out = renderSplitSuggestion(suggestSplit({ files: twoFeatures() }));
        expect(out).toMatch(/could be reviewed/i);
        expect(out).not.toMatch(/should have/i);
    });

    it('truncates a long file list per group', () => {
        const list = files(
            ...Array.from({ length: 10 }, (_, i) => `src/billing/mod${i}.js`),
            ...Array.from({ length: 10 }, (_, i) => `src/reporting/mod${i}.js`),
        );
        const out = renderSplitSuggestion(suggestSplit({ files: list }));
        expect(out).toContain('+4 more');
    });
});

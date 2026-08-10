const fs = require('fs');
const path = require('path');

const {
    detectLanguages,
    buildStandardsBlock,
} = require('../../src/utils/standardsLoader.js');
const { PERF_STANDARDS, HYGIENE_STANDARDS, JAVA_STANDARDS } = require('../../src/utils/standardsCorpus.js');

const STANDARDS_DIR = path.join(__dirname, '../../src/standards');

/** The regex buildStandardsBlock uses to harvest citable rule IDs. */
const RULE_ID_RE = /^## ([A-Z]+-[A-Z]+-\d+):/gm;

describe('detectLanguages', () => {
    it('recognises Java, which had no entry before', () => {
        expect(detectLanguages([{ filename: 'src/Main.java' }])).toEqual(new Set(['java']));
    });

    it('still recognises the original families', () => {
        const langs = detectLanguages([
            { filename: 'a.ts' }, { filename: 'b.py' }, { filename: 'c.go' },
        ]);
        expect(langs).toEqual(new Set(['javascript', 'python', 'go']));
    });

    it('ignores files with no known extension', () => {
        expect(detectLanguages([{ filename: 'README.md' }, { filename: 'Makefile' }]))
            .toEqual(new Set());
    });
});

describe('buildStandardsBlock', () => {
    it('emits every aspect for a detected language', () => {
        const { text } = buildStandardsBlock(new Set(['go']));
        expect(text).toContain('Go Coding Standards');
        expect(text).toContain('Go Testing Standards');
        expect(text).toContain('Go Performance Standards');
        expect(text).toContain('Go Hygiene Standards');
    });

    it('carries the diff-checkable lint rules for each language', () => {
        // The upstream corpus keeps these in linters.md alongside commands we
        // cannot run. These are the subset a reviewer can check by reading a
        // patch, which is the only part worth prompt weight.
        const { ruleIds } = buildStandardsBlock(new Set(['javascript', 'python', 'go']));
        expect(ruleIds).toEqual(expect.arrayContaining([
            'JS-CODING-030',  // unexplained eslint-disable
            'TS-CODING-010',  // unexplained @ts-ignore
            'PY-CODING-030',  // unexplained noqa / type: ignore
            'GO-CODING-030',  // unexplained nolint
        ]));
    });

    it('includes JavaScript testing standards for non-UI diffs', () => {
        // A gate used to sit here that appeared to withhold testing standards
        // from JavaScript unless a .jsx/.tsx file was present. Both of its
        // branches did the same thing, so it never had that effect — and the
        // effect was not wanted: a missing test on a service module is as much
        // a finding as one on a component.
        const { text } = buildStandardsBlock(new Set(['javascript']));
        expect(text).toContain('JavaScript / TypeScript Testing Standards');
    });

    it('emits the full Java family', () => {
        const { text, ruleIds } = buildStandardsBlock(new Set(['java']));
        expect(text).toContain('Java Coding Standards');
        expect(text).toContain('Java Testing Standards');
        expect(text).toContain('Java Performance Standards');
        expect(ruleIds).toContain('JAVA-CODING-001');
        expect(ruleIds).toContain('JAVA-TEST-001');
        expect(ruleIds).toContain('JAVA-PERF-001');
    });

    it('harvests every perf rule ID so citations to them are accepted', () => {
        const { ruleIds } = buildStandardsBlock(new Set(['javascript', 'python', 'go']));
        expect(ruleIds).toEqual(expect.arrayContaining([
            'JS-PERF-001', 'PY-PERF-001', 'GO-PERF-001',
        ]));
    });

    it('produces no duplicate rule IDs across the whole corpus', () => {
        // A duplicated ID means two different rules answer to one citation, and
        // the reviewer's `Rule:` reference stops identifying which was violated.
        const { ruleIds } = buildStandardsBlock(
            new Set(['javascript', 'python', 'go', 'java']),
        );
        expect(new Set(ruleIds).size).toBe(ruleIds.length);
    });

    it('ignores an unknown language rather than throwing', () => {
        const { text, ruleIds } = buildStandardsBlock(new Set(['cobol']));
        expect(text).toBe('');
        expect(ruleIds).toEqual([]);
    });

    it('returns empty for no detected languages', () => {
        expect(buildStandardsBlock(new Set()).text).toBe('');
    });
});

describe('corpus shape', () => {
    const sections = [
        ...Object.entries(PERF_STANDARDS).map(([k, v]) => [`perf:${k}`, v]),
        ...Object.entries(HYGIENE_STANDARDS).map(([k, v]) => [`hygiene:${k}`, v]),
        ['java:coding', JAVA_STANDARDS.coding],
        ['java:testing', JAVA_STANDARDS.testing],
    ];

    it.each(sections)('%s opens with a heading and defines rules', (_name, text) => {
        expect(text.startsWith('# ')).toBe(true);
        RULE_ID_RE.lastIndex = 0;
        expect([...text.matchAll(RULE_ID_RE)].length).toBeGreaterThan(0);
    });

    it.each(sections)('%s gives every rule a body, not just a title', (_name, text) => {
        // A rule ID with no explanation under it cites as authority but tells
        // the reviewer nothing about what to look for.
        const blocks = text.split(/^## /m).slice(1);
        for (const block of blocks) {
            const [title, ...rest] = block.split('\n');
            expect(rest.join('\n').trim().length).toBeGreaterThan(20);
            expect(title.length).toBeGreaterThan(10);
        }
    });
});

describe('markdown mirrors stay in sync with the embedded text', () => {
    // The .md files under src/standards are the readable source of truth, but
    // the service worker cannot read files — it ships the embedded strings. If
    // the two drift, the documented rules and the enforced rules diverge with
    // nothing to catch it.
    const cases = [
        ...Object.keys(PERF_STANDARDS).map(lang => [`${lang}/perf.md`, PERF_STANDARDS[lang]]),
        ...Object.keys(HYGIENE_STANDARDS).map(lang => [`${lang}/hygiene.md`, HYGIENE_STANDARDS[lang]]),
        ['java/coding.md', JAVA_STANDARDS.coding],
        ['java/testing.md', JAVA_STANDARDS.testing],
    ];

    it.each(cases)('%s matches the corpus', (relPath, text) => {
        const onDisk = fs.readFileSync(path.join(STANDARDS_DIR, relPath), 'utf8');
        expect(onDisk.trimEnd()).toBe(text.trimEnd());
    });
});

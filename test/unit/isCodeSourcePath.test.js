/**
 * Which paths hold code, for deciding whether a graph node can be a CALLER.
 *
 * The graph builds CALLS edges from any file it indexes, documentation
 * included, so a real review reported `findAppKnowledge` as "called by
 * AI-README.md, SETUP.md, ADR-007-….md". True of the graph, useless to a
 * reviewer, and actively misleading on a deletion: a prose mention looked like
 * a live call site.
 *
 * `isIndexableCodeFile` cannot answer this — it deliberately accepts `.md`,
 * because documentation IS worth retrieving. This is the narrower question.
 */

const { isCodeSourcePath } = require('../../src/utils/codeFileFilter.js');

describe('code', () => {
    it.each([
        'src/app.ts', 'src/app.tsx', 'a/b.js', 'a/b.mjs', 'a/b.cjs', 'x.jsx',
        'main.py', 'main.go', 'Main.java', 'lib.rb', 'lib.rs', 'a.php',
        'A.cs', 'A.kt', 'A.swift', 'A.scala', 'run.sh',
    ])('%s is code', (p) => {
        expect(isCodeSourcePath(p)).toBe(true);
    });
});

describe('not code', () => {
    it.each([
        'AI-README.md', 'SETUP.md', 'docs/decisions/ADR-007-store.md',
        'notes.txt', 'guide.rst', 'page.mdx', 'a.adoc', 'notes.org',
        'package-lock.json', 'data.json', 'config.yml', 'config.yaml',
        'style.css', 'index.html', '', null, undefined,
    ])('%s is not code', (p) => {
        expect(isCodeSourcePath(p)).toBe(false);
    });
});

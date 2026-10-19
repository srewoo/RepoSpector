/**
 * The codeComments lens is only as good as the comments it is shown. Each
 * syntax is pinned here, plus the window around the change and the fallback
 * for unknown extensions.
 */

const { extractComments } = require('../../src/review-core/context/commentExtractor.js');
const { ctxOk, ctxNotRun, CONTEXT_STATUS } = require('../../src/review-core/context/contextPort.js');

const texts = (arr) => arr.map(c => c.text);

describe('extractComments', () => {
    it('reads // line comments and /* */ blocks in JS, skipping URLs', () => {
        const src = [
            '// keep this list sorted',          // 1
            'const u = "https://x.io/a"; // trailing note', // 2
            '/**',                                // 3
            ' * Must not be called from render.', // 4
            ' */',                                // 5
            'const a = 1; /* inline */ const b = 2;', // 6
        ].join('\n');
        expect(extractComments(src, 'src/a.js')).toEqual([
            { line: 1, text: 'keep this list sorted' },
            { line: 2, text: 'trailing note' },
            { line: 4, text: 'Must not be called from render.' },
            { line: 6, text: 'inline' },
        ]);
    });

    it('reads # comments in shell and YAML, ignoring a # glued to a word', () => {
        expect(texts(extractComments('# deploy first\ncolor: a#b\nx: 1 # pinned', 'ci.yml')))
            .toEqual(['deploy first', 'pinned']);
        expect(texts(extractComments('#!/bin/sh\n# needs bash 4', 'run.sh'))).toEqual(['!/bin/sh', 'needs bash 4']);
    });

    it('reads Python # comments and docstrings', () => {
        const src = [
            'def f():',
            '    """Return the cached value.',
            '    Never mutate it."""',
            "    x = 1  # thread-safe only under the GIL",
            "    '''single'''",
        ].join('\n');
        expect(extractComments(src, 'm.py')).toEqual([
            { line: 2, text: 'Return the cached value.' },
            { line: 3, text: 'Never mutate it.' },
            { line: 4, text: 'thread-safe only under the GIL' },
            { line: 5, text: 'single' },
        ]);
    });

    it('reads <!-- --> in HTML, single- and multi-line', () => {
        const src = '<!-- a11y: keep labels -->\n<div>\n<!--\n  do not reorder\n-->';
        expect(extractComments(src, 'index.html')).toEqual([
            { line: 1, text: 'a11y: keep labels' },
            { line: 4, text: 'do not reorder' },
        ]);
    });

    it('falls back to // and # for unknown extensions', () => {
        expect(texts(extractComments('// one\n# two\n; three', 'file.weird'))).toEqual(['one', 'two']);
    });

    it('treats Makefile and Dockerfile as # languages', () => {
        expect(texts(extractComments('# build\nall:\n\tgo build // not a comment', 'Makefile'))).toEqual(['build']);
    });

    it('keeps only comments within radius of the given lines', () => {
        const src = Array.from({ length: 100 }, (_, i) => `// c${i + 1}`).join('\n');
        const out = extractComments(src, 'a.ts', { aroundLines: [50], radius: 2 });
        expect(out.map(c => c.line)).toEqual([48, 49, 50, 51, 52]);
    });

    it('defaults to a radius of 40', () => {
        const src = Array.from({ length: 200 }, (_, i) => `// c${i + 1}`).join('\n');
        const lines = extractComments(src, 'a.go', { aroundLines: [100] }).map(c => c.line);
        expect(lines[0]).toBe(60);
        expect(lines[lines.length - 1]).toBe(140);
    });

    it('returns [] for empty input', () => {
        expect(extractComments('', 'a.js')).toEqual([]);
        expect(extractComments(null, 'a.js')).toEqual([]);
    });
});

describe('contextPort helpers', () => {
    it('builds ok and not-run results', () => {
        expect(ctxOk({ text: 'x' })).toEqual({ status: CONTEXT_STATUS.OK, text: 'x' });
        expect(ctxNotRun('no token')).toEqual({ status: 'not-run', reason: 'no token' });
        expect(ctxNotRun()).toEqual({ status: 'not-run', reason: 'context not available' });
    });
});

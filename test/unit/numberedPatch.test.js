/**
 * Line-numbered hunks in the review prompt.
 *
 * The model used to receive a bare ```diff block and was asked for a `line`
 * value, which meant counting from the @@ header. It got that wrong silently:
 * a correct finding on the wrong line still reads as authoritative, and the
 * ±5 snap window in the inline formatter exists to paper over the near-misses.
 * These tests pin the format the model now copies from.
 */

const { formatPatchWithLineNumbers } = require('../../src/utils/patchLines.js');
const { buildPerFileReviewPrompt } = require('../../src/utils/multiPassPrompts.js');
const { flattenContent } = require('../../src/utils/promptCache.js');

const PATCH = [
    '@@ -10,4 +10,5 @@',
    ' function handler(req, res) {',   // new 10
    '-  const cmd = req.body.cmd;',    // removed
    '+  const cmd = req.query.cmd;',   // new 11
    '+  exec(cmd);',                   // new 12
    ' }',                              // new 13
].join('\n');

describe('formatPatchWithLineNumbers', () => {
    const out = formatPatchWithLineNumbers(PATCH, 'src/api.js');

    it('labels the file', () => {
        expect(out).toContain("## File: 'src/api.js'");
    });

    it('prints real file line numbers next to new-side lines', () => {
        expect(out).toMatch(/^\s*10\s{2}function handler/m);
        expect(out).toMatch(/^\s*11\s\+\s*const cmd = req\.query\.cmd;/m);
        expect(out).toMatch(/^\s*12\s\+\s*exec\(cmd\);/m);
        expect(out).toMatch(/^\s*13\s{2}\}/m);
    });

    it('separates removed code into an old hunk', () => {
        expect(out).toContain('__new hunk__');
        expect(out).toContain('__old hunk__');
        const oldSection = out.slice(out.indexOf('__old hunk__'));
        expect(oldSection).toContain('req.body.cmd');
    });

    it('never numbers a removed line — it has no addressable position', () => {
        const oldSection = out.slice(out.indexOf('__old hunk__'));
        expect(oldSection).not.toMatch(/^\s*\d+\s*-/m);
    });

    it('omits the old hunk when nothing was removed', () => {
        const additionsOnly = formatPatchWithLineNumbers('@@ -1,1 +1,2 @@\n a\n+b', 'x.js');
        expect(additionsOnly).toContain('__new hunk__');
        expect(additionsOnly).not.toContain('__old hunk__');
    });

    it('numbers each hunk from its own header, not continuously', () => {
        const twoHunks = formatPatchWithLineNumbers(
            '@@ -1,1 +1,2 @@\n a\n+b\n@@ -50,1 +51,2 @@\n c\n+d',
            'x.js',
        );
        expect(twoHunks).toMatch(/^\s*2\s\+b/m);
        expect(twoHunks).toMatch(/^\s*52\s\+d/m);
    });

    it('degrades to a readable note when there is no patch', () => {
        expect(formatPatchWithLineNumbers('', 'x.js')).toContain('no diff available');
        expect(formatPatchWithLineNumbers('')).toBe('');
    });

    it('right-aligns the gutter so numbers stay readable at any file size', () => {
        const deep = formatPatchWithLineNumbers('@@ -1,1 +99998,2 @@\n a\n+b', 'x.js');
        expect(deep).toMatch(/^\s*99999\s\+b/m);
    });
});

describe('buildPerFileReviewPrompt', () => {
    const unit = {
        primaryFile: 'src/api.js',
        files: [{ filename: 'src/api.js', language: 'javascript', status: 'modified', patch: PATCH, additions: 2, deletions: 1 }],
    };

    // The builder returns content parts so a cache breakpoint can sit between
    // the shared preamble and this unit's material; these assertions are about
    // the rendered text, so join them.
    const prompt = flattenContent(
        buildPerFileReviewPrompt(unit, { prContext: { title: 't' }, focusAreas: [] }),
    );

    it('embeds the numbered hunks rather than a raw diff block', () => {
        expect(prompt).toContain('__new hunk__');
        expect(prompt).toMatch(/^\s*12\s\+\s*exec\(cmd\);/m);
        // The old fenced ```diff form is what caused the counting.
        expect(prompt).not.toContain('```diff');
    });

    it('tells the model to copy the printed number, not compute one', () => {
        expect(prompt).toMatch(/COPY the number shown in __new hunk__/);
        expect(prompt).toMatch(/MUST be one printed in the `__new hunk__` gutter/);
    });

    // Deliberately flipped for P1-1. The blanket "never report a finding
    // against them" is what made every deletion defect unreportable — removing
    // an authorization check or a rollback is a behaviour change. The rule now
    // carves out the removal ITSELF being the defect, and when a significant
    // removal is present the prompt names it and invites a finding.
    it('scopes removed code out of review EXCEPT when the removal is the defect', () => {
        expect(prompt).not.toMatch(/never report a finding against them/i);
        expect(prompt).toMatch(/unless the removal itself is the defect/i);
    });
});

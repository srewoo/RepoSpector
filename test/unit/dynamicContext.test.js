/**
 * Dynamic context invents no code: everything it adds to a patch comes from the
 * file content it was given, and it refuses to expand at all unless that content
 * verifiably matches the patch. Those two properties are what the bulk of these
 * tests are about — a fabricated context line is a defect the model cannot
 * detect and will reason from confidently.
 */

const {
    expandPatch,
    isExpandable,
    enclosingDeclaration,
    verifyAlignment,
    shouldPreferExpansion,
} = require('../../src/utils/dynamicContext.js');
const { parsePatchHunks, commentableLines } = require('../../src/utils/patchLines.js');

/** A 40-line file with two functions, so declaration bounds are meaningful. */
const FILE_LINES = [
    'import { db } from "./db.js";',            // 1
    '',                                          // 2
    'export function loadUser(id) {',            // 3
    '    if (!id) throw new Error("no id");',    // 4
    '    const row = db.get(id);',               // 5
    '    if (!row) return null;',                // 6
    '    return normalize(row);',                // 7
    '}',                                         // 8
    '',                                          // 9
    'export function saveUser(user) {',          // 10
    '    validate(user);',                       // 11
    '    const patched = { ...user };',          // 12
    '    patched.updatedAt = Date.now();',       // 13
    '    return db.put(patched);',               // 14
    '}',                                         // 15
];
const FILE = FILE_LINES.join('\n');

const DECLS = [
    { name: 'loadUser', label: 'Function', startLine: 3, endLine: 8 },
    { name: 'saveUser', label: 'Function', startLine: 10, endLine: 15 },
];

/**
 * A one-line change to line 13 with git's default 3 lines of context. Line 13
 * is the last statement before `return`, so a 3-line window shows neither the
 * function signature nor the validate() call the change depends on.
 */
const PATCH = [
    '@@ -12,3 +12,3 @@',
    '     const patched = { ...user };',
    '-    patched.updatedAt = new Date();',
    '+    patched.updatedAt = Date.now();',
    '     return db.put(patched);',
].join('\n');

function linesOf(patch) {
    return parsePatchHunks(patch).flatMap(h => h.lines.map(l => l.content));
}

describe('isExpandable', () => {
    it('skips prose and data files', () => {
        expect(isExpandable('README.md')).toBe(false);
        expect(isExpandable('data/rows.csv')).toBe(false);
        expect(isExpandable('package-lock.json')).toBe(false);
        expect(isExpandable('a/b/NOTES.TXT')).toBe(false); // case-insensitive
    });

    it('expands source files', () => {
        expect(isExpandable('src/index.js')).toBe(true);
        expect(isExpandable('main.go')).toBe(true);
    });

    it('is false for a missing filename rather than throwing', () => {
        expect(isExpandable(undefined)).toBe(false);
        expect(isExpandable('')).toBe(false);
    });
});

describe('enclosingDeclaration', () => {
    it('finds the declaration containing a line', () => {
        expect(enclosingDeclaration(DECLS, 13).name).toBe('saveUser');
        expect(enclosingDeclaration(DECLS, 4).name).toBe('loadUser');
    });

    it('returns null between declarations', () => {
        expect(enclosingDeclaration(DECLS, 9)).toBeNull();
    });

    it('prefers the INNERMOST declaration', () => {
        // A method inside a big class must expand to the method, not the class —
        // otherwise expansion reintroduces the whole-file problem.
        const nested = [
            { name: 'BigClass', label: 'Class', startLine: 1, endLine: 500 },
            { name: 'method', label: 'Method', startLine: 200, endLine: 240 },
        ];
        expect(enclosingDeclaration(nested, 210).name).toBe('method');
    });

    it('ignores entries with unusable line numbers', () => {
        expect(enclosingDeclaration([{ startLine: null, endLine: 'x' }], 5)).toBeNull();
        expect(enclosingDeclaration(null, 5)).toBeNull();
    });
});

describe('verifyAlignment', () => {
    it('accepts content that matches the patch', () => {
        const res = verifyAlignment(parsePatchHunks(PATCH), FILE_LINES);
        expect(res.aligned).toBe(true);
        expect(res.checked).toBeGreaterThan(0);
    });

    it('rejects content from a different ref', () => {
        // GitLab defaults to the target branch, which is the code BEFORE the MR.
        const stale = [...FILE_LINES];
        stale[12] = '    patched.updatedAt = new Date();';
        expect(verifyAlignment(parsePatchHunks(PATCH), stale).aligned).toBe(false);
    });

    it('rejects truncated content', () => {
        expect(verifyAlignment(parsePatchHunks(PATCH), FILE_LINES.slice(0, 5)).aligned).toBe(false);
    });

    it('tolerates trailing-whitespace and line-ending differences', () => {
        const crlf = FILE_LINES.map(l => `${l}\r`);
        expect(verifyAlignment(parsePatchHunks(PATCH), crlf).aligned).toBe(true);
    });

    it('refuses a patch with nothing verifiable', () => {
        const deletionOnly = ['@@ -3,2 +2,0 @@', '-    const a = 1;', '-    const b = 2;'].join('\n');
        expect(verifyAlignment(parsePatchHunks(deletionOnly), FILE_LINES).aligned).toBe(false);
    });
});

describe('expandPatch', () => {
    it('expands a hunk to its enclosing declaration', () => {
        const out = expandPatch({
            patch: PATCH, filename: 'src/users.js', fileContent: FILE, declarations: DECLS,
        });

        expect(out.expanded).toBe(true);
        const contents = linesOf(out.patch);
        // The signature and the validate() call — neither visible in the original.
        expect(contents).toContain('export function saveUser(user) {');
        expect(contents).toContain('    validate(user);');
        expect(out.stats.boundedByDeclaration).toBe(1);
        expect(out.stats.linesAdded).toBeGreaterThan(0);
    });

    it('does not cross into the neighbouring declaration', () => {
        const out = expandPatch({
            patch: PATCH, filename: 'src/users.js', fileContent: FILE, declarations: DECLS,
        });
        const contents = linesOf(out.patch);
        expect(contents).not.toContain('export function loadUser(id) {');
        expect(contents).not.toContain('    const row = db.get(id);');
    });

    it('adds only lines that exist in the file, at their real numbers', () => {
        const out = expandPatch({
            patch: PATCH, filename: 'src/users.js', fileContent: FILE, declarations: DECLS,
        });

        for (const hunk of parsePatchHunks(out.patch)) {
            for (const l of hunk.lines) {
                if (l.type === 'deleted' || l.number.new == null) continue;
                expect(FILE_LINES[l.number.new - 1]).toBe(l.content);
            }
        }
    });

    it('produces a patch that still parses, with a header matching its body', () => {
        const out = expandPatch({
            patch: PATCH, filename: 'src/users.js', fileContent: FILE, declarations: DECLS,
        });
        const hunks = parsePatchHunks(out.patch);
        expect(hunks.length).toBe(1);

        const newSide = hunks[0].lines.filter(l => l.number.new != null);
        expect(hunks[0].newStart).toBe(newSide[0].number.new);
        expect(hunks[0].newLines).toBe(newSide.length);
    });

    it('keeps the added line addressable — the reason expansion is read-only', () => {
        // A finding on line 13 must still be postable. The expanded patch is used
        // for reading; `commentableLines` runs on the ORIGINAL patch, and the
        // original's addressable set must remain a subset of the expanded one so
        // expansion can never LOSE a legal comment target.
        const out = expandPatch({
            patch: PATCH, filename: 'src/users.js', fileContent: FILE, declarations: DECLS,
        });
        const original = commentableLines(PATCH);
        const expanded = commentableLines(out.patch);
        for (const line of original) expect(expanded.has(line)).toBe(true);
    });

    it('merges two nearby hunks instead of emitting shared lines twice', () => {
        const twoHunks = [
            '@@ -4,1 +4,1 @@',
            '-    if (!id) throw new Error("nope");',
            '+    if (!id) throw new Error("no id");',
            '@@ -7,1 +7,1 @@',
            '-    return row;',
            '+    return normalize(row);',
        ].join('\n');

        const out = expandPatch({
            patch: twoHunks, filename: 'src/users.js', fileContent: FILE, declarations: DECLS,
        });

        expect(out.expanded).toBe(true);
        expect(out.stats.hunksAfter).toBe(1);
        expect(out.stats.merged).toBe(1);

        // Every new-side line appears exactly once.
        const seen = new Set();
        for (const hunk of parsePatchHunks(out.patch)) {
            for (const l of hunk.lines) {
                if (l.number.new == null) continue;
                expect(seen.has(l.number.new)).toBe(false);
                seen.add(l.number.new);
            }
        }
    });

    it('falls back to a fixed window when no declaration encloses the change', () => {
        const topLevel = [
            '@@ -1,1 +1,1 @@',
            '-import { db } from "./database.js";',
            '+import { db } from "./db.js";',
        ].join('\n');

        const out = expandPatch({
            patch: topLevel, filename: 'src/users.js', fileContent: FILE, declarations: DECLS,
        });
        expect(out.expanded).toBe(true);
        expect(out.stats.boundedByDeclaration).toBe(0);

        // Asymmetric by default: 3 lines before (there are none — the change is
        // on line 1) and only 1 after, so it reaches line 2 and stops. It must
        // NOT drag in the following function.
        const newSide = parsePatchHunks(out.patch)[0].lines
            .filter(l => l.number.new != null)
            .map(l => l.number.new);
        expect(Math.max(...newSide)).toBe(2);
        expect(linesOf(out.patch)).not.toContain('export function loadUser(id) {');
    });

    it('respects the before/after ceilings even inside a huge declaration', () => {
        const bigLines = ['function huge() {'];
        for (let i = 0; i < 300; i++) bigLines.push(`    step(${i});`);
        bigLines.push('}');
        const bigFile = bigLines.join('\n');

        const patch = [
            '@@ -151,1 +151,1 @@',
            '-    step(150);',
            '+    step(149);',
        ].join('\n');
        // Line 151 is `    step(149);` post-change.
        const fixed = patch.replace('+    step(149);', `+${bigLines[150].replace(/^ {4}/, '    ')}`);

        const out = expandPatch({
            patch: fixed,
            filename: 'src/huge.js',
            fileContent: bigFile,
            declarations: [{ name: 'huge', startLine: 1, endLine: 302 }],
            options: { maxExtraLinesBefore: 12, maxExtraLinesAfter: 6 },
        });

        expect(out.expanded).toBe(true);
        // Not the whole 302-line function: bounded to ~12 before + 6 after.
        expect(parsePatchHunks(out.patch)[0].lines.length).toBeLessThanOrEqual(25);
    });

    it('refuses to expand when the content does not match the patch', () => {
        const stale = FILE.replace('patched.updatedAt = Date.now();', 'patched.updatedAt = new Date();');
        const out = expandPatch({
            patch: PATCH, filename: 'src/users.js', fileContent: stale, declarations: DECLS,
        });
        expect(out.expanded).toBe(false);
        expect(out.patch).toBe(PATCH); // unchanged, so the caller needs no branch
        expect(out.reason).toMatch(/does not match/);
    });

    it('returns the original patch for every degraded input', () => {
        const cases = [
            { patch: PATCH, filename: 'CHANGELOG.md', fileContent: FILE },
            { patch: PATCH, filename: 'src/users.js', fileContent: null },
            { patch: PATCH, filename: 'src/users.js', fileContent: FILE, options: { enabled: false } },
            { patch: '', filename: 'src/users.js', fileContent: FILE },
            { patch: 'not a diff at all', filename: 'src/users.js', fileContent: FILE },
        ];
        for (const c of cases) {
            const out = expandPatch({ declarations: DECLS, ...c });
            expect(out.expanded).toBe(false);
            expect(out.patch).toBe(c.patch || '');
        }
    });

    it('works with no declarations at all', () => {
        const out = expandPatch({ patch: PATCH, filename: 'src/users.js', fileContent: FILE });
        expect(out.expanded).toBe(true);
        expect(out.stats.boundedByDeclaration).toBe(0);
    });
});

describe('shouldPreferExpansion', () => {
    it('prefers the full file for small files', () => {
        expect(shouldPreferExpansion(FILE)).toBe(false);
    });

    it('prefers expanded hunks for large files', () => {
        expect(shouldPreferExpansion('x\n'.repeat(500))).toBe(true);
    });

    it('is false for missing content', () => {
        expect(shouldPreferExpansion(null)).toBe(false);
        expect(shouldPreferExpansion('')).toBe(false);
    });
});

/**
 * The importer turns an OpenQodex case (base + change folders, case.json) into
 * a corpus case. Failure cases it guards: the answer leaking into what the
 * reviewer sees, a bug line that no changed line covers, a clean case losing
 * its flag, and side issues counted as recall.
 */
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { importCase, patchOf } = require('../../eval/import-openqodex.js');

function makeCase(spec, base, change) {
    const dir = mkdtempSync(join(tmpdir(), 'oqcase-'));
    for (const [root, files] of [['base', base], ['change', change]]) {
        for (const [name, body] of Object.entries(files)) {
            mkdirSync(join(dir, root, name, '..'), { recursive: true });
            writeFileSync(join(dir, root, name), body);
        }
    }
    writeFileSync(join(dir, 'case.json'), JSON.stringify(spec));
    return dir;
}

describe('import-openqodex', () => {
    const spec = {
        id: 'flask-path-traversal',
        guards: 'a Flask route with a path traversal is reported',
        clean: false,
        bugs: [{ id: 'b', file: 'app.py', lines: [2, 2], mentions: ['travers'], kind: ['security'], class: 'path-traversal', severity: 'critical', truth: 'joins user input' }],
        extras: [{ file: 'app.py', lines: [3, 3], mentions: ['debug'], why: 'debug on' }],
    };
    const dir = makeCase(spec, { 'app.py': 'a = 1\n' }, { 'app.py': 'a = 1\nopen(name)\nrun(debug=True)\n' });
    const kase = importCase(dir, 0);

    it('keeps the answer out of everything the reviewer sees', () => {
        const seen = JSON.stringify({ title: kase.prData.title, description: kase.prData.description, url: kase.url, patch: kase.prData.files });
        expect(seen).not.toMatch(/travers|flask/i);
    });

    it('turns bugs into ranged reference defects and extras into accepted issues', () => {
        expect(kase.humanComments).toEqual([expect.objectContaining({ file: 'app.py', line: 2, lineEnd: 2, mentions: ['travers'], tag: 'path-traversal', tagGroup: 'security' })]);
        expect(kase.acceptedIssues).toEqual([expect.objectContaining({ line: 3, mentions: ['debug'] })]);
        expect(kase.clean).toBe(false);
    });

    it('produces a hunk-only patch whose added lines are the change', () => {
        expect(kase.prData.files[0]).toMatchObject({ filename: 'app.py', status: 'modified', additions: 2, deletions: 0 });
        expect(patchOf('x\n', 'x\ny\n')).toMatch(/^@@ -1 \+1,2 @@\n x\n\+y/);
        expect(kase.fileContents['app.py']).toContain('open(name)');
    });
});

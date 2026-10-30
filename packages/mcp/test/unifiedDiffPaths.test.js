import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../src/tools/unifiedDiff.js';

// Paths containing `b/` (.github/, db/, web/) were cut at the first `b/`, so
// the file was filed under a mangled name and static analysis skipped it.

const chunk = (p, body) => `diff --git a/${p} b/${p}\nindex 1..2 100644\n--- a/${p}\n+++ b/${p}\n${body}`;

test('paths that contain b/ keep their full name', () => {
    for (const p of ['.github/workflows/ci.yml', 'db/migrations/0002.sql', 'web/server.js']) {
        const [file] = parseUnifiedDiff(chunk(p, '@@ -1 +1 @@\n-a\n+b\n'));
        assert.equal(file.filename, p);
    }
});

test('a removed SQL comment line is not mistaken for a header', () => {
    const [file] = parseUnifiedDiff(chunk('db/x.sql', '@@ -1,2 +1 @@\n--- old comment\n select 1;\n'));
    assert.equal(file.filename, 'db/x.sql');
});

test('a deletion is named by its old side, a hunkless rename by its new name', () => {
    const del = 'diff --git a/web/old.js b/web/old.js\ndeleted file mode 100644\n--- a/web/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n';
    assert.equal(parseUnifiedDiff(del)[0].filename, 'web/old.js');
    const ren = 'diff --git a/lib/a.js b/lib/b.js\nsimilarity index 100%\nrename from lib/a.js\nrename to lib/b.js\n';
    assert.deepEqual(parseUnifiedDiff(ren)[0], { filename: 'lib/b.js', patch: '', status: 'renamed', previousFilename: 'lib/a.js' });
});

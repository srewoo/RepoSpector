import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/diff.js';

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a };
 export { b };
@@ -10,2 +11,2 @@ function f() {
-  return 1;
+  return 2;
 }
`;

describe('parseUnifiedDiff', () => {
  it('parses a modified file with two hunks and tracks added lines in the new file', () => {
    const [file] = parseUnifiedDiff(MODIFIED);
    expect(file).toBeDefined();
    expect(file?.path).toBe('src/a.ts');
    expect(file?.status).toBe('modified');
    expect(file?.hunks).toHaveLength(2);
    expect(file?.addedLines).toEqual([2, 3, 11]);
    expect(file?.removedCount).toBe(2);
  });

  it('marks added and deleted files using /dev/null', () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+one
+two
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-gone
`;
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['new.ts', 'added'],
      ['old.ts', 'deleted'],
    ]);
    expect(files[0]?.addedLines).toEqual([1, 2]);
    expect(files[1]?.addedLines).toEqual([]);
  });

  it('records renames and binary files', () => {
    const diff = `diff --git a/x.ts b/y.ts
similarity index 100%
rename from x.ts
rename to y.ts
diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
`;
    const files = parseUnifiedDiff(diff);
    expect(files[0]).toMatchObject({ path: 'y.ts', oldPath: 'x.ts', status: 'renamed' });
    expect(files[1]).toMatchObject({ path: 'img.png', binary: true });
  });

  it('ignores "no newline" markers and handles hunks without counts', () => {
    const diff = `diff --git a/a b/a
--- a/a
+++ b/a
@@ -1 +1 @@
-x
\\ No newline at end of file
+y
\\ No newline at end of file
`;
    const [file] = parseUnifiedDiff(diff);
    expect(file?.addedLines).toEqual([1]);
    expect(file?.removedCount).toBe(1);
  });

  it('unquotes paths git quotes', () => {
    const diff = `diff --git "a/sp ace.ts" "b/sp ace.ts"
--- "a/sp ace.ts"
+++ "b/sp ace.ts"
@@ -1 +1 @@
-a
+b
`;
    expect(parseUnifiedDiff(diff)[0]?.path).toBe('sp ace.ts');
  });

  it('returns an empty list for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

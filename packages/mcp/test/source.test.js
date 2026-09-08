import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRepoFiles } from '../src/repo/source.js';

// Resolve from this file's own location, not process.cwd(): this test must
// pass identically under `node --test packages/mcp/test/` (repo root) and
// under `npm test` from inside packages/mcp, where cwd is packages/mcp, not
// the repo root.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');            // packages/mcp
const REPO = path.resolve(PKG, '..', '..');      // repo root, a git worktree

test('reads real files from a git worktree', async () => {
    const { files } = await readRepoFiles(REPO, { maxFiles: 200 });
    assert.ok(files.length > 0, 'no files read');
    for (const f of files) {
        assert.equal(typeof f.path, 'string');
        assert.equal(typeof f.content, 'string');
        assert.ok(!path.isAbsolute(f.path), `paths must be repo-relative, got ${f.path}`);
    }
});

test('excludes node_modules and build output without a hand-maintained list', async () => {
    // git ls-files returns tracked (+ untracked-but-not-ignored) files only, so
    // .gitignore does this for us.
    const { files } = await readRepoFiles(REPO, { maxFiles: 5000 });
    assert.equal(files.some((f) => f.path.includes('node_modules/')), false);
    assert.equal(files.some((f) => f.path.startsWith('dist/')), false);
});

test('excludes non-code files via the shared filter', async () => {
    const { files } = await readRepoFiles(REPO, { maxFiles: 5000 });
    assert.equal(files.some((f) => f.path.endsWith('.png')), false);
    assert.equal(files.some((f) => f.path.endsWith('.wasm')), false);
});

test('maxFiles is honoured and the truncation is reported, not silent', async () => {
    const r = await readRepoFiles(REPO, { maxFiles: 5 });
    assert.equal(r.files.length, 5);
    assert.equal(r.truncated, true);
});

test('a directory that is not a git repo fails with a message naming the cause', async () => {
    await assert.rejects(
        () => readRepoFiles('/tmp', { maxFiles: 10 }),
        (e) => /git/i.test(e.message),
    );
});

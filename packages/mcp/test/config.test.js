import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';

test('defaults the repo to the working directory', () => {
    const c = parseConfig([], {});
    assert.equal(c.repo, process.cwd());
});

test('--repo overrides, and is resolved to an absolute path', () => {
    const c = parseConfig(['--repo', '.'], {});
    assert.equal(c.repo, process.cwd());
});

test('--max-files and --max-tool-tokens parse as integers', () => {
    const c = parseConfig(['--max-files', '500', '--max-tool-tokens', '8000'], {});
    assert.equal(c.maxFiles, 500);
    assert.equal(c.maxToolTokens, 8000);
});

test('a non-numeric limit falls back to the default rather than NaN', () => {
    // NaN would silently disable the cap, which is the failure the cap exists to prevent.
    const c = parseConfig(['--max-tool-tokens', 'lots'], {});
    assert.equal(c.maxToolTokens, 4096);
});

test('git host tokens come from the environment, never from argv', () => {
    // A token in argv is visible in the process list to every other process.
    const c = parseConfig(['--repo', '.'], { GITHUB_TOKEN: 'gh', GITLAB_TOKEN: 'gl' });
    assert.equal(c.githubToken, 'gh');
    assert.equal(c.gitlabToken, 'gl');
    const none = parseConfig([], {});
    assert.equal(none.githubToken, null);
});

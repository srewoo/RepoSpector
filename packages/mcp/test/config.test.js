import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseConfig, DEFAULT_MAX_TOOL_TOKENS, helpText, wantsHelp,
} from '../src/config.js';

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
    // Asserted against the exported constant, not a literal: this test read
    // `4096` and had to be edited when the default changed, which is a test
    // pinning a number rather than the behaviour.
    const c = parseConfig(['--max-tool-tokens', 'lots'], {});
    assert.equal(c.maxToolTokens, DEFAULT_MAX_TOOL_TOKENS);
});

test('git host tokens come from the environment, never from argv', () => {
    // A token in argv is visible in the process list to every other process.
    const c = parseConfig(['--repo', '.'], { GITHUB_TOKEN: 'gh', GITLAB_TOKEN: 'gl' });
    assert.equal(c.githubToken, 'gh');
    assert.equal(c.gitlabToken, 'gl');
    const none = parseConfig([], {});
    assert.equal(none.githubToken, null);
});

/**
 * The shipped default, and the flag that overrides it.
 *
 * 4096 was too small for the tool this server exists for. Measured on a real
 * 22-file merge request: at 4096 the bundle came back complete but heavily
 * trimmed — 15 of 26 hunk windows and an empty symbol list — while at 12000 it
 * carries the whole diff for an ordinary change. Every user who installs this
 * should get a working default rather than having to discover a flag.
 */

test('the default response budget is 12000 tokens', () => {
    assert.equal(DEFAULT_MAX_TOOL_TOKENS, 12000);
    assert.equal(parseConfig([], {}).maxToolTokens, 12000);
});

test('--max-tool-tokens overrides the default', () => {
    assert.equal(parseConfig(['--max-tool-tokens', '90000'], {}).maxToolTokens, 90000);
    assert.equal(parseConfig(['--max-tool-tokens', '2048'], {}).maxToolTokens, 2048);
});

test('a nonsense budget falls back to the default rather than disabling the cap', () => {
    for (const bad of ['0', '-5', 'lots', '', 'NaN']) {
        assert.equal(
            parseConfig(['--max-tool-tokens', bad], {}).maxToolTokens,
            12000,
            `'${bad}' should not become the budget`,
        );
    }
});

/**
 * `--help`, which did not exist.
 *
 * The flags are documented only in the package README, which nobody reads from
 * a client config. A server whose whole contract is "one response must fit a
 * context window" has to be able to say how that is tuned.
 */

test('help text names every flag, with its default', () => {
    const help = helpText();

    for (const flagName of ['--repo', '--max-files', '--max-tool-tokens', '--max-cache-mb', '--help']) {
        assert.match(help, new RegExp(flagName.replace(/-/g, '\\-')), `${flagName} is undocumented`);
    }
    assert.match(help, /12000/, 'the default budget is not stated');
    assert.match(help, /5000/, 'the default file ceiling is not stated');
});

test('help text shows how to pass the flag from a client config', () => {
    const help = helpText();
    // A user edits JSON in a client config, not a shell, so an example that
    // only shows shell syntax does not answer the question they have.
    assert.match(help, /args/i);
    assert.match(help, /repospector-mcp/);
});

test('help text says the tokens are for a single tool response', () => {
    assert.match(helpText(), /\bone tool response\b|\bsingle tool response\b|\bper tool response\b/i);
});

test('help text names the tokens as environment-only', () => {
    // Documenting a token flag would invite passing credentials in argv.
    const help = helpText();
    assert.match(help, /GITHUB_TOKEN/);
    assert.match(help, /GITLAB_TOKEN/);
    assert.match(help, /environment/i);
});

test('wantsHelp detects the flag in either form', () => {
    assert.equal(wantsHelp(['--help']), true);
    assert.equal(wantsHelp(['-h']), true);
    assert.equal(wantsHelp(['--repo', '/x', '--help']), true);
    assert.equal(wantsHelp(['--repo', '/x']), false);
    assert.equal(wantsHelp([]), false);
});

test('help is printed and the server never starts', async () => {
    // `--help` must exit BEFORE the transport is connected. A server that
    // prints usage and then starts speaking MCP on the same stdout would hand
    // a client a stream whose first bytes are not a protocol message.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const pathMod = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const exec = promisify(execFile);
    const here = pathMod.dirname(fileURLToPath(import.meta.url));

    const { stdout, stderr } = await exec(
        'node',
        [pathMod.join(here, '..', 'src/index.js'), '--help'],
        { timeout: 60000 },
    );

    assert.match(stdout, /--max-tool-tokens/);
    assert.match(stdout, /12000/);
    assert.doesNotMatch(stdout, /"jsonrpc"/, 'a protocol frame reached stdout in help mode');
    assert.doesNotMatch(stderr, /ready — repo/, 'the server started despite --help');
});

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drives the server over real stdio with real MCP framing. Unit tests cannot
 * catch a broken handshake, and a broken handshake makes every tool
 * unreachable regardless of how well it is tested.
 *
 * Paths below resolve from this file's own location, not from process.cwd():
 * this test must pass identically whether run as `node --test packages/mcp/test/`
 * from the repo root or as `npm test` (== `node --test test/*.test.js`) from
 * inside packages/mcp. A cwd-relative spawn path silently finds nothing in
 * the second case and the test times out reporting a "broken handshake" that
 * isn't one.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..'); // packages/mcp

function rpc(child, message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
}

test('completes initialize and lists tools over stdio', async () => {
    const child = spawn('node', [path.join(PKG, 'src/index.js'), '--repo', PKG], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    let spawnError = null;
    child.on('error', (err) => {
        // A bad node path or missing entry file would otherwise just time out
        // after 15s and report "no response to initialize" — pointing at the
        // server when the real cause is that it never started.
        spawnError = err;
    });

    const lines = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) lines.push(line);
        }
    });

    try {
        rpc(child, {
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'plan-test', version: '0' },
            },
        });

        // Poll rather than sleep a fixed interval: a fixed sleep is either flaky or slow.
        const deadline = Date.now() + 15000;
        while (lines.length < 1 && !spawnError && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
        }
        if (spawnError) assert.fail(`server process failed to spawn: ${spawnError.message}`);

        assert.ok(lines.length >= 1, 'server sent no response to initialize');
        const init = JSON.parse(lines[0]);
        assert.equal(init.id, 1);
        assert.equal(init.error, undefined);
        assert.equal(init.result.serverInfo.name, 'repospector');

        // Regression: the version was hardcoded, so the handshake still said
        // 0.1.0 after 0.1.1 shipped and a client could not tell which build it
        // was talking to. It must come from package.json.
        const pkg = JSON.parse(
            readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
        );
        assert.equal(
            init.result.serverInfo.version,
            pkg.version,
            'handshake version drifted from package.json — is it hardcoded again?',
        );

        rpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        const d2 = Date.now() + 15000;
        while (lines.length < 2 && !spawnError && Date.now() < d2) {
            await new Promise((r) => setTimeout(r, 50));
        }
        if (spawnError) assert.fail(`server process failed to spawn: ${spawnError.message}`);

        assert.ok(lines.length >= 2, 'server sent no response to tools/list');
        const list = JSON.parse(lines[1]);
        assert.equal(list.error, undefined);
        assert.ok(Array.isArray(list.result.tools));
    } finally {
        child.kill();
    }
});

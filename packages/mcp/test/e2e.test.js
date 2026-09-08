import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT = 300000;

// Resolve from this file's own location, not process.cwd(): this suite must
// pass identically whether run as `node --test packages/mcp/test/` from the
// repo root or as `npm test` (== `node --test test/`) from inside
// packages/mcp. A cwd-relative spawn path silently finds nothing in the
// second case.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..'); // packages/mcp
const SRC_ENTRY = path.join(PKG, 'src/index.js');
const DIST_ENTRY = path.join(PKG, 'dist/index.js');

/** Drive the server over real stdio and collect newline-delimited responses. */
function client(entry, args = ['--repo', PKG]) {
    const child = spawn('node', [entry, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) { try { responses.push(JSON.parse(line)); } catch { /* not a frame */ } }
        }
    });
    return {
        child,
        responses,
        send(msg) { child.stdin.write(`${JSON.stringify(msg)}\n`); },
        async waitFor(id, ms = 120000) {
            const deadline = Date.now() + ms;
            while (Date.now() < deadline) {
                const hit = responses.find((r) => r.id === id);
                if (hit) return hit;
                await new Promise((r) => setTimeout(r, 100));
            }
            throw new Error(`no response for id ${id}`);
        },
        kill() { child.kill(); },
    };
}

test('all eight tools are advertised over the wire', { timeout: TIMEOUT }, async () => {
    const c = client(SRC_ENTRY);
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } });
    await c.waitFor(1);
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const list = await c.waitFor(2);

    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
        'find_callers', 'get_diff_context', 'get_symbol', 'impact_of_change',
        'index_repo', 'repo_overview', 'review_pr', 'search_code',
    ]);
    // Every tool must carry a schema, or a client cannot call it.
    for (const t of list.result.tools) {
        assert.equal(t.inputSchema.type, 'object', `${t.name} has no object schema`);
        assert.ok(t.description.length > 0, `${t.name} has no description`);
    }
    c.kill();
});

test('an unknown tool returns a structured error naming what IS available', { timeout: TIMEOUT }, async () => {
    const c = client(SRC_ENTRY);
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } });
    await c.waitFor(1);
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'no_such_tool', arguments: {} } });
    const r = await c.waitFor(2);
    assert.match(JSON.stringify(r), /search_code/);
    c.kill();
});

test('repo_overview answers over the wire against this repository', { timeout: TIMEOUT }, async () => {
    const c = client(SRC_ENTRY);
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } });
    await c.waitFor(1);
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'repo_overview', arguments: {} } });
    const r = await c.waitFor(2, 280000);
    assert.equal(r.error, undefined);
    assert.match(JSON.stringify(r.result), /Repository|Graph/);
    c.kill();
});

test('nothing but protocol frames reaches stdout', { timeout: TIMEOUT }, async () => {
    // A stray console.log inside a ported service corrupts the transport, which
    // presents to the user as the server being broken rather than as a log line.
    const c = client(SRC_ENTRY);
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } });
    await c.waitFor(1);
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'repo_overview', arguments: {} } });
    await c.waitFor(2, 280000);
    // Every collected line parsed as JSON, or waitFor would have failed; assert
    // each has the jsonrpc envelope.
    for (const r of c.responses) assert.equal(r.jsonrpc, '2.0');
    c.kill();
});

// Ruling R6: bundling is the entire point of this task. A build that emits a
// dist/index.js that then fails to start over real stdio is exactly the
// failure this task exists to prevent — so this must run the real build and
// spawn the real dist artifact, not just check the build exits 0.
test('the built dist/index.js completes a real stdio handshake', { timeout: TIMEOUT }, async () => {
    const build = spawnSync('node', ['build.js'], { cwd: PKG, encoding: 'utf8' });
    assert.equal(build.status, 0, `build failed:\n${build.stdout}\n${build.stderr}`);

    const c = client(DIST_ENTRY);
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e-dist', version: '0' } } });
    const init = await c.waitFor(1);
    assert.equal(init.result.serverInfo.name, 'repospector');

    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const list = await c.waitFor(2);
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
        'find_callers', 'get_diff_context', 'get_symbol', 'impact_of_change',
        'index_repo', 'repo_overview', 'review_pr', 'search_code',
    ]);
    c.kill();
});

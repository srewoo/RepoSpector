import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { remoteKey, saveConfig } from '../src/native/config.js';
import { handleNative } from '../src/native/handler.js';
import { hostManifest, install, launcherScript } from '../src/native/install.js';
import { frame, FrameReader, MAX_TO_CHROME } from '../src/native/protocol.js';
import { git, write } from './helpers.js';

/** A clone of "github.com/acme/shop" with one commit: Cart.total called from pay(). */
function clone(): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), 'rs-native-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'remote', 'add', 'origin', 'git@github.com:Acme/shop.git');
  write(root, 'src/cart.py', 'class Cart:\n    def total(self, items):\n        return sum(items)\n');
  write(root, 'src/pay.py', 'def pay(c):\n    return c.total([1])\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'one');
  return { root, sha: git(root, 'rev-parse', 'HEAD') };
}

const cacheDir = () => mkdtempSync(join(tmpdir(), 'rs-native-cache-'));

describe('framing', () => {
  it('round-trips messages split across chunks, and reports bad JSON', () => {
    const r = new FrameReader();
    const bytes = Buffer.concat([frame({ a: 1 }), frame({ b: 'ü' })]);
    expect([...r.push(bytes.subarray(0, 3)), ...r.push(bytes.subarray(3, 9)), ...r.push(bytes.subarray(9))]).toEqual([{ ok: true, message: { a: 1 } }, { ok: true, message: { b: 'ü' } }]);
    const bad = Buffer.from('{nope');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(bad.length);
    expect(r.push(Buffer.concat([head, bad]))).toEqual([{ ok: false, error: 'message is not valid JSON' }]);
  });
  it('refuses replies over Chrome\'s 1 MB limit', () => {
    expect(() => frame({ big: 'x'.repeat(MAX_TO_CHROME) })).toThrow(/at most/);
  });
});

describe('remoteKey', () => {
  it('normalises https, ssh and scp-like remotes, and ignores local paths', () => {
    expect(remoteKey('https://github.com/Acme/shop.git')).toBe('github.com/acme/shop');
    expect(remoteKey('https://user:token@gitlab.example.com/group/sub/proj')).toBe('gitlab.example.com/group/sub/proj');
    expect(remoteKey('git@github.com:Acme/shop.git')).toBe('github.com/acme/shop');
    expect(remoteKey('ssh://git@gitlab.example.com:2222/g/p.git')).toBe('gitlab.example.com/g/p');
    expect(remoteKey('/srv/repos/shop.git')).toBeUndefined();
    expect(remoteKey('file:///srv/shop')).toBeUndefined();
  });
});

describe('handleNative', () => {
  it('answers hello with the listed repos and their remotes', async () => {
    const c = clone();
    const r = await handleNative({ type: 'hello' }, { config: () => ({ repos: [c.root] }), version: '9.9.9', cacheDir: cacheDir() });
    expect(r).toEqual({ ok: true, version: '9.9.9', repos: [{ path: c.root, remotes: ['github.com/acme/shop'] }] });
  });

  it('builds reader context from the local clone at the commit, matched by remote', async () => {
    const c = clone();
    const r = await handleNative({ type: 'context', repo: 'github.com/acme/shop', sha: c.sha, findings: [{ id: 'f1', file: 'src/cart.py', line: 3 }] }, { config: () => ({ repos: [c.root] }), version: 'x', cacheDir: cacheDir() });
    expect(r).toMatchObject({ ok: true, files: 2 });
    const ctx = (r as { context: Record<string, { symbol: { name: string }; callers: unknown[] }> }).context.f1;
    expect(ctx?.symbol.name).toBe('total');
    expect(ctx?.callers).toEqual([{ file: 'src/pay.py', line: 2, caller: 'pay' }]);
  });

  it('says why it cannot help: not listed, commit not fetched, bad request', async () => {
    const c = clone();
    const deps = { config: () => ({ repos: [c.root] }), version: 'x', cacheDir: cacheDir() };
    expect(await handleNative({ type: 'context', repo: 'github.com/other/repo', sha: c.sha, findings: [] }, deps)).toMatchObject({ ok: false, reason: 'not-cloned' });
    expect(await handleNative({ type: 'context', repo: 'github.com/acme/shop', sha: 'f'.repeat(40), findings: [] }, deps)).toMatchObject({ ok: false, reason: 'missing-commit', message: expect.stringMatching(/git fetch/) });
    expect(await handleNative({ type: 'context', repo: 'github.com/acme/shop', sha: c.sha, findings: [], extra: 1 }, deps)).toMatchObject({ ok: false, reason: 'bad-request' });
    expect(await handleNative({ type: 'read-file', path: '/etc/passwd' }, deps)).toMatchObject({ ok: false, reason: 'bad-request' });
  });

  it('reads nothing outside the listed repos', async () => {
    const c = clone();
    const r = await handleNative({ type: 'context', repo: 'github.com/acme/shop', sha: c.sha, findings: [] }, { config: () => ({ repos: [] }), version: 'x', cacheDir: cacheDir() });
    expect(r).toMatchObject({ ok: false, reason: 'not-cloned' });
  });
});

describe('install', () => {
  it('writes a manifest limited to this extension, a launcher pinned to this Node, and the repo list', async () => {
    const c = clone();
    const home = mkdtempSync(join(tmpdir(), 'rs-native-home-'));
    const dir = join(home, 'NativeMessagingHosts');
    const id = 'abcdefghijklmnopabcdefghijklmnop';
    const r = await install({ extensionId: id, repos: [c.root], manifestDirs: [dir], env: { HOME: home } });
    const manifest = JSON.parse(readFileSync(join(dir, 'com.repospector.local.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toEqual({ name: 'com.repospector.local', description: 'RepoSpector local code index', path: r.launcher, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] });
    expect(statSync(r.launcher).mode & 0o777).toBe(0o755);
    expect(readFileSync(r.launcher, 'utf8')).toContain(`exec '${process.execPath}'`);
    expect(r.repos).toEqual([realpathSync(c.root)]); // stored resolved (macOS /var is a symlink)
    expect(statSync(join(home, '.config', 'repospector', 'native.json')).mode & 0o777).toBe(0o600);
  });

  it('rejects a malformed extension id and quotes paths safely in the launcher', () => {
    expect(() => hostManifest('/x', 'not-an-id')).toThrow(/32 letters/);
    expect(launcherScript("/opt/no'de", '/a b/host.js')).toContain(`exec '/opt/no'\\''de' '/a b/host.js' "$@"`);
  });
});

describe('host process (as Chrome runs it)', () => {
  it('answers framed requests on stdout and nothing else', async () => {
    const c = clone();
    const home = mkdtempSync(join(tmpdir(), 'rs-native-host-'));
    const env = { ...process.env, XDG_CONFIG_HOME: join(home, 'cfg'), REPOSPECTOR_CACHE_DIR: join(home, 'cache') };
    saveConfig({ repos: [c.root] }, join(home, 'cfg', 'repospector', 'native.json'));
    // The built host, as the launcher runs it (tests run after `npm run build`).
    const hostJs = fileURLToPath(new URL('../dist/native/host.js', import.meta.url));
    const child = spawn(process.execPath, [hostJs, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const reader = new FrameReader();
    const replies: unknown[] = [];
    const raw: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => (raw.push(d), replies.push(...reader.push(d).map((m) => (m.ok ? m.message : m)))));
    child.stdin.write(frame({ type: 'hello' }));
    child.stdin.write(frame({ type: 'context', repo: 'github.com/acme/shop', sha: c.sha, findings: [{ id: 'f1', file: 'src/cart.py', line: 3 }] }));
    child.stdin.end();
    const code = await new Promise<number | null>((res) => child.on('close', res));
    expect(code).toBe(0);
    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatchObject({ ok: true, repos: [{ path: c.root, remotes: ['github.com/acme/shop'] }] });
    expect(replies[1]).toMatchObject({ ok: true, files: 2, context: { f1: { symbol: { name: 'total' } } } });
    // stdout holds exactly the two frames: no stray log lines.
    expect(Buffer.concat(raw).length).toBe(frame(replies[0]).length + frame(replies[1]).length);
  }, 60_000);
});

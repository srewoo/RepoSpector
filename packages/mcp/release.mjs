// Publishes repospector-mcp to npm at the version in packages/mcp/package.json.
//   npm run release:mcp              build, test, check, bundle, smoke-test the tarball, publish
//   npm run release:mcp -- --dry-run every step except the publish
// @repospector/core is a workspace package that is not on npm, so it is bundled into the published
// files; every other dependency stays a normal npm dependency. Nothing is published unless every check passes.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const dryRun = process.argv.includes('--dry-run');
const allowDirty = process.argv.includes('--allow-dirty');
const here = resolve('.');
const repoRoot = resolve('../..');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const fail = (msg) => {
  console.error(`\nrelease: ${msg}\nNothing was published.`);
  process.exit(1);
};
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
const step = (msg) => console.log(`\n• ${msg}`);

// 1. Version: from package.json, valid for npm, and newer than what is published.
const version = pkg.version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail(`packages/mcp/package.json has version "${version}"; npm needs MAJOR.MINOR.PATCH (for example ${/^\d+\.\d+$/.test(version) ? `${version}.0` : '1.2.3'})`);
step(`repospector-mcp ${version}${dryRun ? ' (dry run: nothing will be published)' : ''}`);
let published = [];
try {
  published = JSON.parse(run('npm', ['view', pkg.name, 'versions', '--json']));
} catch {
  published = []; // not on npm yet
}
if (published.includes(version)) fail(`${version} is already on npm; raise "version" in packages/mcp/package.json`);
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('-')[0].split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
const latest = published.filter((v) => !v.includes('-')).sort((a, b) => (newer(a, b) ? 1 : -1)).at(-1);
if (latest && !newer(version, latest)) fail(`${version} is not newer than the latest published ${latest}`);
console.log(`  on npm: ${latest ?? 'not published yet'}`);

// 2. Source state: committed, so the published code matches a commit.
step('checking the git working tree');
const dirty = run('git', ['status', '--porcelain'], { cwd: repoRoot }).trim();
if (dirty && !allowDirty && !dryRun) fail(`uncommitted changes:\n${dirty}\nCommit them first (or pass --allow-dirty).`);
const commit = run('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).trim();
console.log(`  commit ${commit}${dirty ? ' (with uncommitted changes)' : ''}`);

// 3. Build and test everything (versions are synced from package.json by the build).
step('building and testing');
run('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
run('npm', ['test'], { cwd: repoRoot, stdio: 'inherit' });

// 4. Bundle into pkg/: core inlined, other dependencies external.
step('bundling');
const out = join(here, 'pkg');
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const deps = Object.fromEntries(Object.entries(pkg.dependencies).filter(([name]) => name !== '@repospector/core'));
const coreDeps = JSON.parse(readFileSync(join(repoRoot, 'packages/core/package.json'), 'utf8')).dependencies ?? {};
for (const [name, range] of Object.entries(coreDeps)) if (!(name in deps)) deps[name] = range;
await build({
  entryPoints: { index: 'src/index.ts', 'native/host': 'src/native/host.ts' },
  outdir: join(out, 'dist'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: Object.keys(deps),
  legalComments: 'inline',
  logLevel: 'warning',
});
cpSync('plugin', join(out, 'plugin'), { recursive: true });
cpSync(join(repoRoot, 'LICENSE'), join(out, 'LICENSE'));
cpSync(join(repoRoot, 'README.md'), join(out, 'README.md'));
const manifest = {
  name: pkg.name,
  version,
  description: pkg.description ?? 'RepoSpector MCP server: code review with specialists and an independent verifier, plus the Chrome extension\'s local mode.',
  license: 'MIT',
  type: 'module',
  bin: { 'repospector-mcp': 'dist/index.js' },
  main: 'dist/index.js',
  files: ['dist', 'plugin', 'README.md', 'LICENSE'],
  engines: { node: '>=22' },
  repository: { type: 'git', url: 'git+https://github.com/srewoo/RepoSpector.git', directory: 'packages/mcp' },
  dependencies: deps,
};
writeFileSync(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// 5. Smoke test: install the exact tarball into an empty prefix and run it.
step('smoke-testing the packed tarball');
const tarball = join(out, run('npm', ['pack', '--silent'], { cwd: out }).trim().split('\n').at(-1));
const prefix = mkdtempSync(join(tmpdir(), 'rs-release-'));
run('npm', ['install', '-g', '--prefix', prefix, tarball, '--no-audit', '--no-fund'], { stdio: 'inherit' });
const bin = join(prefix, 'bin', 'repospector-mcp');
const reported = run(bin, ['--version']).trim();
if (reported !== version) fail(`the installed server reports version ${reported}, expected ${version}`);
const env = { ...process.env, XDG_CONFIG_HOME: join(prefix, 'cfg') };
if (!/Registered:/.test(run(bin, ['native', 'status'], { env }))) fail('`repospector-mcp native status` did not run');
const host = join(prefix, 'lib', 'node_modules', pkg.name, 'dist', 'native', 'host.js');
if (!existsSync(host)) fail('the native host program is missing from the package');
// MCP handshake over stdio: the server must answer initialize and list its tools.
const init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"release","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n';
const repo = mkdtempSync(join(tmpdir(), 'rs-release-repo-'));
run('git', ['init', '-q', repo]);
let reply = '';
try {
  reply = run(bin, ['--repo', repo], { input: init, timeout: 20_000 });
} catch (e) {
  reply = String(e.stdout ?? '');
}
if (!/"post_review"/.test(reply)) fail(`the installed server did not list its tools over stdio:\n${reply.slice(0, 500)}`);
console.log(`  installed ${tarball.split('/').at(-1)}: --version ${reported}, native status OK, MCP tools listed`);
rmSync(prefix, { recursive: true, force: true });
rmSync(repo, { recursive: true, force: true });

// 6. Publish.
if (dryRun) {
  console.log(`\nDry run passed. To publish ${pkg.name}@${version}: npm run release:mcp`);
  process.exit(0);
}
step(`publishing ${pkg.name}@${version} to npm`);
run('npm', ['publish', tarball, '--access', 'public'], { stdio: 'inherit' });
console.log(`\nPublished ${pkg.name}@${version} from commit ${commit}.\nOptional: tag it with  git tag mcp-v${version} && git push origin mcp-v${version}`);

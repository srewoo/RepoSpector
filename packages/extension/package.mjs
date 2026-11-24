// Makes the Chrome Web Store upload: release/repospector-extension-<version>.zip, with manifest.json
// at the zip root. The version comes from package.json (build.mjs writes it into the manifest).
// Run through `npm run package:extension` at the repo root, which builds first.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dist = resolve('dist/extension');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const fail = (msg) => {
  console.error(`package: ${msg}`);
  process.exit(1);
};

if (manifest.version !== version) fail(`dist manifest is ${manifest.version} but package.json is ${version}; run the build first (npm run package:extension does)`);
if (manifest.key) fail('manifest has a "key" field; the Chrome Web Store rejects uploads that include one');

// Everything in the zip, checked before packing: no source maps, OS junk or stray files.
const files = [];
const walk = (dir, prefix = '') => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
    else files.push(`${prefix}${name}`);
  }
};
walk(dist);
const junk = files.filter((f) => /(^|\/)(\.DS_Store|Thumbs\.db)$|\.map$|\.tsbuildinfo$/.test(f));
if (junk.length) fail(`unexpected files in the build: ${junk.join(', ')}`);
for (const required of ['manifest.json', 'sw.js', 'sidepanel.html', 'options.html', 'help.html', 'privacy.html', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png']) if (!files.includes(required)) fail(`the build is missing ${required}`);

mkdirSync('release', { recursive: true });
const zip = resolve(`release/repospector-extension-${version}.zip`);
if (existsSync(zip)) rmSync(zip);
try {
  // -X: no extra file attributes, so the same build gives the same zip. Run inside dist so paths start at the root.
  execFileSync('zip', ['-q', '-r', '-X', zip, '.'], { cwd: dist, stdio: 'inherit' });
} catch (e) {
  fail(`could not run zip (${e.message}). On Windows, zip the contents of ${dist} by hand, with manifest.json at the top level.`);
}
const listed = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
if (!listed.includes('manifest.json')) fail('manifest.json is not at the root of the zip');
if (listed.filter((f) => !f.endsWith('/')).length !== files.length) fail(`zip has ${listed.length} entries but the build has ${files.length} files`);
const mb = (statSync(zip).size / 1024 / 1024).toFixed(1);
console.log(`Chrome Web Store package: ${zip}\n  version ${version}, ${files.length} files, ${mb} MB`);
console.log('Upload it in the Chrome Web Store developer dashboard (a new version must be higher than the published one).');

// Bundles the extension into dist/: one ES module per entry point, plus the static files.
// Not minified, so a reviewer can read exactly what ships. No remote code is fetched at runtime.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { GRAMMAR_FILE } from '@repospector/core';

const out = 'dist/extension';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: { sw: 'src/sw.ts', sidepanel: 'src/sidepanel.ts', options: 'src/options.ts', offscreen: 'src/pipeline/offscreen.ts', worker: 'src/pipeline/worker.ts' },
  bundle: true,
  format: 'esm',
  // Shared and on-demand code goes into chunks/, so pages load the model SDK only when they call a model.
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  platform: 'browser',
  target: 'chrome116',
  outdir: out,
  minify: false,
  sourcemap: false,
  legalComments: 'inline',
  logLevel: 'warning',
});
// The diff-marker content script is injected as a classic script, so it is one self-contained file.
await build({ entryPoints: { markers: 'src/markers.ts' }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome116', outdir: out, minify: false, legalComments: 'inline', logLevel: 'warning' });
await build({ entryPoints: { 'graph-worker': 'src/graph/graph-worker.ts' }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome116', outdir: out, minify: false, legalComments: 'inline', logLevel: 'warning' });
// tree-sitter runtime + only the grammars the extractor uses (core GRAMMAR_FILE), from the pinned package.
const wasm = dirname(createRequire(import.meta.url).resolve('@vscode/tree-sitter-wasm'));
mkdirSync(`${out}/ts`, { recursive: true });
for (const f of ['tree-sitter.js', 'tree-sitter.wasm', ...Object.values(GRAMMAR_FILE)]) cpSync(join(wasm, f), `${out}/ts/${f}`);
cpSync(join(wasm, '..', 'LICENSE'), `${out}/ts/LICENSE`);
// ONNX runtime's WebAssembly for meaning-based matching (loaded only when the user turns it on).
const ort = dirname(createRequire(import.meta.url).resolve('onnxruntime-web/wasm'));
mkdirSync(`${out}/ort`, { recursive: true });
cpSync(join(ort, 'ort-wasm-simd-threaded.wasm'), `${out}/ort/ort-wasm-simd-threaded.wasm`);
// The npm package declares MIT but ships no licence file; MIT requires the notice, so write it.
writeFileSync(`${out}/ort/LICENSE`, `onnxruntime-web ${JSON.parse(readFileSync(join(ort, '..', 'package.json'), 'utf8')).version}\n\nMIT License\n\nCopyright (c) Microsoft Corporation\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n`);
cpSync('static', out, { recursive: true });
// The manifest's version comes from package.json, so a release changes only package.json.
const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const manifestPath = `${out}/manifest.json`;
writeFileSync(manifestPath, `${JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, 'utf8')), version: pkgVersion }, null, 2)}\n`);
console.log(`built ${out}`);

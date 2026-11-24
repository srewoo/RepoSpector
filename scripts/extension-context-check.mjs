// End-to-end check of the repository-context review in Chrome for Testing (headless): offscreen
// document -> review worker -> real GitHub API (public PR, no token) -> real repository download
// (codeload) -> graph worker indexes it and locates what the diff calls -> only those files fetched
// -> a second review pass with that code -> merged with the plain pass -> verifier. The model is a
// stand-in on localhost (canned answers): this checks the wiring, not review quality.
// Usage: node scripts/extension-context-check.mjs "<Chrome for Testing binary>" "$PWD/packages/extension/dist/extension"
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [chromeBin, extDir] = process.argv.slice(2);
const PORT = 9336;
const MODEL_PORT = 11556;
// Default: sindresorhus/ky#883 (its added lines call validateJsonWithSchema, getRemainingTotalTimeout, …
// defined elsewhere). Or a GitLab MR: CONTEXT_MR=gitlab.com:gitlab-org/gitlab-pages:1393
const MR = process.env.CONTEXT_MR?.split(':');
const PR = MR ? { kind: 'gitlab', host: MR[0], project: MR[1], iid: Number(MR[2]) } : { kind: 'github', host: 'github.com', owner: 'sindresorhus', repo: 'ky', number: 883 };
const API_BASE = PR.kind === 'github' ? 'https://api.github.com' : `https://${PR.host}/api/v4`;
const REPO_KEY = PR.kind === 'github' ? `github.com/${PR.owner}/${PR.repo}` : `${PR.host}/${PR.project}`;
let failures = 0;
const check = (ok, label) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const prompts = [];
const model = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') return res.end();
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const prompt = JSON.parse(body).messages.at(-1).content;
    prompts.push(prompt);
    const content = prompt.includes('<findings>')
      ? '[{"index":0,"keep":true,"confidence":80,"impact":"medium","reason":"r"},{"index":1,"keep":true,"confidence":60,"impact":"high","reason":"r"}]'
      : prompt.includes('<definitions>')
        ? '[{"file":"src/changed.ts","line":400,"claim":"Context-pass finding: wrong argument order to a helper defined elsewhere."}]'
        : '[{"file":"src/changed.ts","line":10,"claim":"Plain-pass finding."}]';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'stand-in', message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: Math.ceil(prompt.length / 4), eval_count: 50 }));
  });
}).listen(MODEL_PORT, 'localhost');

// Test-only copy with the hosts pre-granted (headless Chrome cannot click a permission prompt).
const testExt = mkdtempSync(join(tmpdir(), 'rs-ctx-ext-'));
cpSync(extDir, testExt, { recursive: true });
const manifest = JSON.parse(readFileSync(join(testExt, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['https://github.com/*', 'https://api.github.com/*', 'https://codeload.github.com/*', 'https://gitlab.com/*', 'http://localhost/*'];
writeFileSync(join(testExt, 'manifest.json'), JSON.stringify(manifest));
const chrome = spawn(chromeBin, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'rs-ctx-'))}`, `--disable-extensions-except=${testExt}`, `--load-extension=${testExt}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());
const json = async (path, method = 'GET') => (await fetch(`http://127.0.0.1:${PORT}${path}`, { method })).json();

async function page(url) {
  const t = await json(`/json/new?${url}`, 'PUT');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) (pending.get(d.id)(d), pending.delete(d.id));
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await sleep(500);
  return async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluation failed');
    return r.result?.result?.value;
  };
}

const READ_RUN = (id) => `new Promise((res, rej) => { const o = indexedDB.open('repospector', 1); o.onsuccess = () => { const g = o.result.transaction('runs').objectStore('runs').get('${id}'); g.onsuccess = () => { res(g.result ?? null); o.result.close(); }; g.onerror = () => rej(g.error); }; o.onerror = () => rej(o.error); })`;
const SAVED_GRAPHS = `new Promise((res) => { const o = indexedDB.open('repospector-index'); o.onsuccess = () => { const db = o.result; if (!db.objectStoreNames.contains('graphs')) { db.close(); return res([]); } const g = db.transaction('graphs').objectStore('graphs').getAllKeys(); g.onsuccess = () => { res(g.result); db.close(); }; }; o.onerror = () => res([]); })`;

async function review(js, runId) {
  const start = { type: 'review:start', runId, target: PR, apiBase: API_BASE, provider: 'ollama', model: 'stand-in', ollamaUrl: `http://localhost:${MODEL_PORT}`, prices: { model: 'stand-in', inPerM: 0, outPerM: 0 }, repoContext: true };
  await js(`chrome.runtime.sendMessage(${JSON.stringify(start)})`);
  const steps = new Set();
  const began = Date.now();
  let run;
  for (let i = 0; i < 720; i++) {
    run = await js(READ_RUN(runId));
    if (run?.step) steps.add(run.step);
    if (run?.status === 'done' || run?.status === 'failed') break;
    await sleep(500);
  }
  return { run, steps: [...steps], ms: Date.now() - began };
}

try {
  let targets = [];
  for (let i = 0; i < 120; i++) { try { targets = await json('/json/list'); if (targets.some((t) => t.url.endsWith('/sw.js'))) break; } catch {} await sleep(250); }
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/sw.js'));
  if (!sw) throw new Error('extension did not load');
  const js = await page(`${sw.url.replace('/sw.js', '')}/options.html`);
  check((await js(`chrome.runtime.sendMessage({ type: 'offscreen:ensure' })`))?.ok === true, 'offscreen document ready');

  const first = await review(js, 'ctx-run-0001');
  const run = first.run;
  check(run?.status === 'done', `review finished (${run?.status}${run?.error ? `: ${run.error.message}` : ''}) in ${(first.ms / 1000).toFixed(1)} s`);
  check(first.steps.includes('context'), `went through "Read the repository" (steps seen: ${first.steps.join(' → ')})`);
  const plain = prompts.filter((p) => !p.includes('<definitions>') && !p.includes('<findings>'));
  const withDefs = prompts.filter((p) => p.includes('<definitions>'));
  check(plain.length === 1 && !plain[0].includes('<definitions>'), 'the plain review pass ran, diff only');
  check(withDefs.length === 1, 'a second review pass ran with repository code');
  const defs = withDefs[0]?.match(/<definitions>\n([\s\S]*?)\n<\/definitions>/)?.[1] ?? '';
  const named = [...defs.matchAll(/^### `([^`]+)` at ([^\s]+):(\d+)$/gm)].map((m) => `${m[1]} @ ${m[2]}:${m[3]}`);
  console.log(`  definitions sent: ${named.join(' | ')}`);
  check(named.length > 0 && named.every((n) => /^\S+ @ \S+:\d+$/.test(n)), `definitions located in the repository (${named.length})`);
  check(/\bfunc\b|function|\bdef |=>|\bconst |\bclass /.test(defs) && defs.length > 200, `definitions carry real code (${defs.length} chars)`);
  check(!named.some((n) => /test/.test(n.split(' @ ')[1] ?? '')), 'no test files among the definitions');
  const verify = prompts.find((p) => p.includes('<findings>')) ?? '';
  check(/0\. src\/changed\.ts:10/.test(verify) && /1\. src\/changed\.ts:400/.test(verify), 'the verifier checks the merged findings of both passes');
  check(JSON.stringify(run?.findings?.map((f) => [f.line, f.fromContext ?? false, f.impact])) === '[[10,false,"medium"],[400,true,"high"]]', `findings merged, context-only one marked: ${JSON.stringify(run?.findings?.map((f) => [f.line, f.fromContext ?? false, f.impact]))}`);
  const note = run?.notes?.find((n) => n.startsWith('Also reviewed with code from other files'));
  check(!!note && /from (\d+) indexed files/.test(note) && Number(note.match(/from (\d+) indexed/)[1]) > 10, `note says what context was used: ${note}`);
  check(run?.repoContext && run.repoContext.text === undefined && run.diff === undefined, 'repository code and diff are not kept after the review');
  const saved = await js(SAVED_GRAPHS);
  check(saved.some((k) => k === `${REPO_KEY}@${run?.headSha}`), `index saved for this commit (${saved.join(', ')})`);

  // Second review of the same PR: the saved index is reused, no repository download.
  prompts.length = 0;
  const second = await review(js, 'ctx-run-0002');
  check(second.run?.status === 'done' && prompts.some((p) => p.includes('<definitions>')), `second review reuses the saved index and still sends definitions (${(second.ms / 1000).toFixed(1)} s vs ${(first.ms / 1000).toFixed(1)} s)`);
} catch (e) {
  failures++;
  console.log(`FAIL the check stopped: ${e.message}`);
} finally {
  model.close();
  chrome.kill();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

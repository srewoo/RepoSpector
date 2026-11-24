// End-to-end check of the review pipeline in Chrome for Testing (headless): service worker ->
// offscreen document -> worker -> real GitHub API (public PR, no token) -> a stand-in model that
// speaks Ollama's /api/chat on localhost:11555 -> IndexedDB -> broadcast. Includes an interruption
// (offscreen document closed mid-review) and a resume. The model's answers are canned on purpose:
// this checks the wiring; model quality is what the eval sets measure.
// Usage: node scripts/extension-e2e-check.mjs "<Chrome for Testing binary>" "$PWD/packages/extension/dist/extension"
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [chromeBin, extDir] = process.argv.slice(2);
const PORT = 9335;
const MODEL_PORT = 11555;
const PR = { kind: 'github', host: 'github.com', owner: 'vercel', repo: 'next.js', number: 96301 };
let failures = 0;
const check = (ok, label) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GitHub's diff markup as served today: a file block named diff-<sha256(path)>, line cells with ids
// …L<old> / …R<new>. Line 10 is rendered; line 20 is not (as when a diff is collapsed).
const FIXTURE_PATH = 'packages/next/src/server/image-optimizer.ts';
const FIXTURE_HASH = createHash('sha256').update(FIXTURE_PATH).digest('hex');
const FIXTURE = `<!doctype html><title>diff</title><div data-diff-anchor="diff-${FIXTURE_HASH}" data-tagsearch-path="${FIXTURE_PATH}"><table><tr><td id="diff-${FIXTURE_HASH}L9" data-line-number="9"></td><td id="diff-${FIXTURE_HASH}R10" data-line-number="10"></td><td>code</td></tr></table></div>`;

let repoDownloads = 0;
// A tiny repository as GitHub serves it (gzipped git archive), for the graph worker.
const REPO_TGZ = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-e2e-repo-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/cart.py'), 'class Cart:\n    def total(self, items):\n        return sum(items)\n');
  writeFileSync(join(dir, 'src/pay.py'), 'def pay(c):\n    return c.total([1])\n\nclass Gift(Cart):\n    pass\n');
  writeFileSync(join(dir, 'src/web.tsx'), 'export function View() { return <div>{total()}</div>; }\n');
  const g = (...a) => execFileSync('git', ['-C', dir, ...a]);
  g('init', '-q');
  g('add', '.');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x');
  return gzipSync(g('archive', '--format=tar', '--prefix=o-r-abc/', 'HEAD'));
})();

// Stand-in model. Holds the first review request open so the test can close the offscreen document.
const prompts = [];
let holdFirstReview = true;
const model = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') return res.end();
  if (req.method === 'GET' && req.url === '/repo.tgz') {
    repoDownloads++;
    res.setHeader('content-type', 'application/gzip');
    return res.end(REPO_TGZ);
  }
  if (req.method === 'GET') {
    res.statusCode = req.url === '/fixture' ? 200 : 404;
    res.setHeader('content-type', 'text/html');
    return res.end(req.url === '/fixture' ? FIXTURE : '');
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const prompt = JSON.parse(body).messages.at(-1).content;
    prompts.push(prompt);
    const verify = prompt.includes('<findings>');
    if (!verify && holdFirstReview) {
      holdFirstReview = false;
      await sleep(15_000); // the test closes the offscreen document during this wait
    }
    const content = verify
      ? '[{"index":0,"keep":true,"confidence":88,"reason":"The allowlist omits svg."},{"index":1,"keep":false,"confidence":15,"reason":"Covered by the existing test."}]'
      : '[{"file":"packages/next/src/server/image-optimizer.ts","line":10,"claim":"SVG is missing from the allowlist after block()."},{"file":"packages/next/src/server/image-optimizer.ts","line":20,"claim":"Unused import."}]';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'stand-in', message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: Math.ceil(prompt.length / 4), eval_count: 50 }));
  });
}).listen(MODEL_PORT, 'localhost');

// Test-only copy of the build with the hosts pre-granted, because headless Chrome cannot click a
// permission prompt and the side panel only sees a tab's URL on a granted host. The shipped build is untouched.
const testExt = mkdtempSync(join(tmpdir(), 'rs-e2e-ext-'));
cpSync(extDir, testExt, { recursive: true });
const manifest = JSON.parse(readFileSync(join(testExt, 'manifest.json'), 'utf8'));
manifest.permissions = [...manifest.permissions, 'nativeMessaging'];
manifest.host_permissions = ['https://github.com/*', 'https://api.github.com/*', 'https://codeload.github.com/*', 'http://localhost/*'];
writeFileSync(join(testExt, 'manifest.json'), JSON.stringify(manifest));
const userDataDir = mkdtempSync(join(tmpdir(), 'rs-e2e-'));
const localHome = mkdtempSync(join(tmpdir(), 'rs-e2e-local-'));
const localEnv = { ...process.env, XDG_CONFIG_HOME: join(localHome, 'cfg'), REPOSPECTOR_CACHE_DIR: join(localHome, 'cache') };
const chrome = spawn(chromeBin, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`, `--disable-extensions-except=${testExt}`, `--load-extension=${testExt}`, '--no-first-run', 'about:blank'], { stdio: 'ignore', env: localEnv });
// Never leave a headless browser on the port, even if the script dies.
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
  await send('Runtime.enable');
  await sleep(500);
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluation failed');
    return r.result?.result?.value;
  };
  // Optional PNG for a human look (set SHOTS=<dir>): width in CSS px, full page height.
  evaluate.shot = async (file, width) => {
    if (!process.env.SHOTS) return;
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1200, deviceScaleFactor: 1, mobile: false });
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(process.env.SHOTS, file), Buffer.from(r.result.data, 'base64'));
    await send('Emulation.clearDeviceMetricsOverride');
  };
  return evaluate;
}

async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) (pending.get(d.id)(d), pending.delete(d.id));
  });
  return async (expr) => {
    const i = ++id;
    const r = await new Promise((res) => { pending.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
    return r.result?.result?.value;
  };
}

const OPEN_INDEX = `new Promise((res, rej) => { const r = indexedDB.open('repospector-index', 2); r.onupgradeneeded = () => { r.result.createObjectStore('graphs', { keyPath: 'key' }).createIndex('repo', 'repo'); r.result.createObjectStore('symbols'); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); })`;

const READ_RUN = (id) => `new Promise((res, rej) => { const o = indexedDB.open('repospector', 1); o.onsuccess = () => { const g = o.result.transaction('runs').objectStore('runs').get('${id}'); g.onsuccess = () => { res(g.result ?? null); o.result.close(); }; g.onerror = () => rej(g.error); }; o.onerror = () => rej(o.error); })`;

try {
  let targets = [];
  for (let i = 0; i < 120; i++) { try { targets = await json('/json/list'); if (targets.some((t) => t.url.endsWith('/sw.js'))) break; } catch {} await sleep(250); }
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/sw.js'));
  if (!sw) throw new Error('extension did not load');
  const base = sw.url.replace('/sw.js', '');
  const js = await page(`${base}/options.html`);

  const runId = 'e2e-run-0001';
  const start = { type: 'review:start', runId, target: PR, apiBase: 'https://api.github.com', provider: 'ollama', model: 'stand-in', ollamaUrl: `http://localhost:${MODEL_PORT}`, prices: { model: 'stand-in', inPerM: 0, outPerM: 0 }, repoContext: false }; // resume wiring only; repository context: scripts/extension-context-check.mjs
  check((await js(`chrome.runtime.sendMessage({ type: 'offscreen:ensure' })`))?.ok === true, 'service worker created the offscreen document');
  await js(`chrome.runtime.sendMessage(${JSON.stringify(start)})`);

  // Wait until the review request is being held, then close the offscreen document (as Chrome might).
  for (let i = 0; i < 40 && prompts.length === 0; i++) await sleep(250);
  check(prompts.length === 1, 'review request reached the model');
  check(prompts[0]?.startsWith('Review this pull request diff for real defects'), 'the review uses the measured prompt');
  check(/PR title: .+/.test(prompts[0] ?? ''), 'the prompt carries the real PR title');
  const mid = await js(READ_RUN(runId));
  check(mid?.status === 'running' && mid?.step === 'review' && typeof mid?.diff === 'string' && mid.diff.length > 1000, `run saved at the review step with the diff (${mid?.diff?.length ?? 0} chars)`);
  const closed = await js(`chrome.offscreen?.closeDocument ? chrome.offscreen.closeDocument().then(() => 'closed', (e) => 'error: ' + e.message) : 'no offscreen API in this page'`);
  console.log(`  offscreen close from an extension page: ${closed}`);
  if (closed !== 'closed') throw new Error('could not close the offscreen document to simulate an interruption');
  await sleep(500);
  const active = await js(`chrome.runtime.sendMessage({ type: 'review:active' }).then((r) => r?.active ?? [], () => 'no runner')`);
  check(active === 'no runner' || (Array.isArray(active) && !active.includes(runId)), `after the close, nothing reports the run as live (${JSON.stringify(active)})`);
  check((await js(READ_RUN(runId)))?.status === 'running', 'the interrupted run is still marked running in storage (the panel shows Resume)');

  // Resume with the same run id.
  await js(`chrome.runtime.sendMessage({ type: 'offscreen:ensure' })`);
  await js(`chrome.runtime.sendMessage(${JSON.stringify(start)})`);
  let run;
  for (let i = 0; i < 120; i++) {
    run = await js(READ_RUN(runId));
    if (run?.status === 'done' || run?.status === 'failed') break;
    await sleep(500);
  }
  check(run?.status === 'done', `resumed run finished (${run?.status}${run?.error ? `: ${run.error.message}` : ''})`);
  check(JSON.stringify(run?.findings?.map((f) => f.status)) === '["verified","suspected"]', `findings labelled, none dropped: ${JSON.stringify(run?.findings?.map((f) => `${f.status} ${f.file}:${f.line}`))}`);
  check(run?.findings?.[1]?.suspectedBecause === 'Covered by the existing test.', 'suspected finding keeps the verifier reason');
  check(JSON.stringify(run?.findings?.map((f) => f.confidence)) === '[88,15]', `verifier confidence stored for ranking: ${JSON.stringify(run?.findings?.map((f) => f.confidence))}`);
  check(run?.diff === undefined, 'the diff is removed from storage when the run is done');
  check(run?.filesReviewed > 0 && /^[0-9a-f]{40}$/.test(run?.headSha ?? ''), `recorded ${run?.filesReviewed} files at head ${run?.headSha?.slice(0, 10)}`);
  check(run?.usage?.inputTokens > 0 && run?.costUsd === 0, `usage recorded (${run?.usage?.inputTokens} in / ${run?.usage?.outputTokens} out), cost 0 for a local model`);
  check(prompts.filter((p) => p.includes('<findings>')).length === 1, 'exactly one verifier call');

  // Part 2: the real side panel flow on a real PR page.
  await js(`chrome.storage.local.set({ hosts: [{ kind: 'github', origin: 'https://github.com' }], model: { provider: 'ollama', preset: 'low', ollamaModel: 'stand-in', ollamaUrl: 'http://localhost:${MODEL_PORT}' } })`);
  await js(`new Promise((res) => { const o = indexedDB.open('repospector', 1); o.onsuccess = () => { const t = o.result.transaction('runs', 'readwrite'); t.objectStore('runs').clear(); t.oncomplete = () => { o.result.close(); res(true); }; }; })`);
  const prTab = await json(`/json/new?https://github.com/vercel/next.js/pull/96301`, 'PUT');
  const panel = await page(`${base}/sidepanel.html`);
  await fetch(`http://127.0.0.1:${PORT}/json/activate/${prTab.id}`); // replies with plain text
  let text = '';
  for (let i = 0; i < 60; i++) {
    text = await panel('document.body.innerText');
    if (/Estimated|no model cost|Could not/.test(text)) break;
    await sleep(500);
  }
  check(text.includes('vercel/next.js #96301'), 'side panel names the PR in the active tab');
  check(/Reviews \d+ KB of changes with stand-in/.test(text) && text.includes('no model cost'), `side panel shows size, model and cost line before running: ${JSON.stringify(text.split('\n').slice(-3))}`);
  await panel(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Review this pull request').click()`);
  for (let i = 0; i < 120; i++) {
    text = await panel('document.body.innerText');
    if (/verified|failed|Could not/i.test(text)) break;
    await sleep(500);
  }
  check(text.includes('1 verified, 1 suspected.'), 'side panel shows the result summary');
  check(text.includes('Most likely real defects first'), 'side panel says findings are ordered by likelihood');
  check(text.includes('packages/next/src/server/image-optimizer.ts:10') && text.includes('Why suspected: Covered by the existing test.'), 'side panel lists findings as file:line with labels and reasons');
  check(text.includes('stand-in, no model cost (runs locally).'), `side panel shows model and cost: ${JSON.stringify(text.match(/stand-in.*\./)?.[0])}`);
  const labelContrast = await panel(`(() => { const lum = (c) => { const p = c.match(/\\d+/g).map(Number).slice(0,3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126*p[0]+0.7152*p[1]+0.0722*p[2]; }; const e = document.querySelector('.label.verified'); const a = lum(getComputedStyle(e).color), b = lum(getComputedStyle(document.body).backgroundColor); return Math.round(((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05))*100)/100; })()`);
  check(labelContrast >= 4.5, `"Verified" label contrast ${labelContrast}:1`);
  await panel.shot('results-360.png', 360);
  const layout = await panel(`(() => {
    const names = [...document.querySelectorAll('button, input, a')].map((c) => c.getAttribute('aria-label') || (c.labels?.[0]?.innerText) || c.textContent.trim());
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    const small = [...document.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().height < 36).map((b) => b.textContent);
    document.body.style.width = '360px'; document.body.style.boxSizing = 'border-box';
    const wide = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > 361).map((e) => e.tagName + '.' + e.className);
    document.body.style.width = '';
    return { dupes, small, wide: [...new Set(wide)] };
  })()`);
  check(layout.dupes.length === 0, `results view: every control has a unique name (${JSON.stringify(layout.dupes)})`);
  check(layout.small.length === 0, `results view: buttons >= 36px (${JSON.stringify(layout.small)})`);
  check(layout.wide.length === 0, `results view at 360px: nothing overflows (${JSON.stringify(layout.wide)})`);
  const picks = await panel(`[...document.querySelectorAll('.findings input[type=checkbox]')].map((b) => b.checked)`);
  check(JSON.stringify(picks) === '[true,false]', `verified finding is selected for posting, suspected is not: ${JSON.stringify(picks)}`);
  check(text.includes('To post drafts, add an access token for github.com in settings.'), 'without a host token the panel says how to enable posting');
  await sleep(9_000); // the marker attempt on the still-loading PR tab times out after 8 s
  text = await panel('document.body.innerText');
  check(/Could not mark the findings on this page|Marked/.test(text), `marker line reports what happened on the PR tab: ${JSON.stringify(text.match(/(Could not mark|Marked)[^.]*\./)?.[0])}`);

  // Feedback: "Not useful" on the second finding, then a reason.
  await panel(`[...document.querySelectorAll('.findings li')][1].querySelector('.feedback button:nth-child(2)').click()`);
  await sleep(300);
  const pressed = await panel(`[...document.querySelectorAll('.findings li')][1].querySelector('.feedback button[aria-pressed=true]')?.textContent`);
  check(pressed === 'Not useful', `reaction shows as pressed: ${pressed}`);
  await panel(`(() => { const li = [...document.querySelectorAll('.findings li')][1]; li.querySelector('.reason input').value = 'covered by test'; [...li.querySelectorAll('button')].find((b) => b.textContent === 'Save reason').click(); })()`);
  await sleep(300);
  await panel.shot('results-feedback-360.png', 360);
  const rows = await panel(`new Promise((res) => { const o = indexedDB.open('repospector', 1); o.onsuccess = () => { const g = o.result.transaction('feedback').objectStore('feedback').getAll(); g.onsuccess = () => { res(g.result); o.result.close(); }; }; })`);
  check(rows?.length === 1 && rows[0].choice === 'not-useful' && rows[0].entry.reaction === 'rejected' && rows[0].entry.reason === 'covered by test' && rows[0].repo === 'github.com/vercel/next.js', `feedback stored on the device: ${JSON.stringify(rows?.map((r) => [r.choice, r.entry.reaction, r.entry.reason, r.repo]))}`);
  const settings = await page(`${base}/options.html`);
  await sleep(800);
  const fbText = await settings(`document.getElementById('feedback').innerText`);
  check(fbText.includes('1 reaction from 1 repository, 1 marked not useful') && fbText.includes('Export as JSONL'), `settings shows stored feedback and export: ${JSON.stringify(fbText.split('\n').slice(1, 3))}`);

  // C8 in the panel: the offer, then a finished index rendered under the finding.
  await fetch(`http://127.0.0.1:${PORT}/json/activate/${prTab.id}`); // the settings tab took focus
  await sleep(1500);
  const offerText = await panel('document.body.innerText');
  check(/Show where this code is used/.test(offerText), `panel offers to show where the code is used: ${JSON.stringify(offerText.slice(0, 400))}`);
  const ctx = { status: 'done', source: 'download', reused: 0, files: 812, skipped: 40, ms: 5300, perFinding: { f1: { symbol: { name: 'imageOptimizer', kind: 'function', file: 'packages/next/src/server/image-optimizer.ts', startLine: 5, endLine: 30 }, callers: [{ file: 'packages/next/src/server/next-server.ts', line: 120, caller: 'handleImage' }], callerCount: 1, sameName: [], subtypes: [] } } };
  await panel(`new Promise((res) => { const o = indexedDB.open('repospector', 1); o.onsuccess = () => { const t = o.result.transaction('runs', 'readwrite'); const st = t.objectStore('runs'); const g = st.index('target').getAll('github.com/vercel/next.js#96301'); g.onsuccess = () => { const run = g.result.sort((a, b) => b.startedAt - a.startedAt)[0]; st.put({ ...run, context: ${JSON.stringify(ctx)} }); }; t.oncomplete = () => { o.result.close(); new BroadcastChannel('repospector-runs').postMessage({}); res(true); }; }; })`);
  await sleep(800);
  const details = await panel(`(() => { const d = document.querySelector('details.context'); if (!d) return null; d.open = true; const a = d.querySelector('a'); return { summary: d.querySelector('summary').innerText, link: a?.href, text: a?.innerText, target: a?.target, rel: a?.rel }; })()`);
  check(details?.summary === 'In imageOptimizer · 1 caller', `finding shows its enclosing function and caller count: ${JSON.stringify(details?.summary)}`);
  check(/^https:\/\/github\.com\/vercel\/next\.js\/blob\/[0-9a-f]{40}\/packages\/next\/src\/server\/next-server\.ts#L120$/.test(details?.link ?? '') && details?.rel === 'noopener noreferrer', `caller links to the line at the reviewed commit: ${details?.link}`);
  check(/Downloaded and indexed 812 source files in 5\.3 s\. Saved on this device for next time\./.test(await panel('document.body.innerText')), 'panel summarises the index, that it is saved, and the by-name caveat');
  await panel.shot('results-context-360.png', 360);
  const prSha = await panel(`new Promise((res) => { const o = indexedDB.open('repospector'); o.onsuccess = () => { const g = o.result.transaction('runs').objectStore('runs').index('target').getAll('github.com/vercel/next.js#96301'); g.onsuccess = () => { res(g.result.sort((a, b) => b.startedAt - a.startedAt)[0].headSha); o.result.close(); }; }; })`);
  const savedSymbols = { language: 'typescript', defs: [{ name: 'imageOptimizer', kind: 'function', startLine: 5, endLine: 30, nameLine: 5 }], calls: [], inherits: [] };
  const callerSymbols = { language: 'typescript', defs: [], calls: [{ name: 'imageOptimizer', line: 7, caller: 'serve' }, { name: 'imageOptimizer', line: 9, caller: 'serve' }], inherits: [] };
  await panel(`${OPEN_INDEX}.then((db) => new Promise((res) => { const t = db.transaction(['graphs', 'symbols'], 'readwrite'); t.objectStore('graphs').put({ key: 'github.com/vercel/next.js@${prSha}', repo: 'github.com/vercel/next.js', files: [['packages/next/src/server/image-optimizer.ts', 'b1'], ['packages/next/src/server/serve.ts', 'b2']], skipped: 0, at: Date.now() }); t.objectStore('symbols').put(${JSON.stringify(savedSymbols)}, 'b1'); t.objectStore('symbols').put(${JSON.stringify(callerSymbols)}, 'b2'); t.oncomplete = () => { db.close(); res(true); }; }))`);
  await panel(`new Promise((res) => { const o = indexedDB.open('repospector'); o.onsuccess = () => { const t = o.result.transaction('runs', 'readwrite'); const st = t.objectStore('runs'); const g = st.index('target').getAll('github.com/vercel/next.js#96301'); g.onsuccess = () => { const run = g.result.sort((a, b) => b.startedAt - a.startedAt)[0]; delete run.context; st.put(run); }; t.oncomplete = () => { o.result.close(); new BroadcastChannel('repospector-runs').postMessage({}); res(true); }; }; })`);
  let autoText = '';
  for (let i = 0; i < 40; i++) {
    autoText = await panel('document.body.innerText');
    if (/Used the index saved on this device/.test(autoText)) break;
    await sleep(250);
  }
  check(/Used the index saved on this device for this commit \(2 source files\)/.test(autoText), 'panel used the saved index for this commit automatically, without a click or a download');
  check(/In imageOptimizer · 2 callers/.test(autoText), `context from the saved index under the finding: ${JSON.stringify(autoText.match(/In imageOptimizer[^\n]*/)?.[0])}`);

  // Markers on a page with GitHub's diff markup (localhost is granted in the test copy only).
  const fixtureTab = await json(`/json/new?http://localhost:${MODEL_PORT}/fixture`, 'PUT');
  await sleep(1000);
  const placed = await settings(`(async () => { const [t] = await chrome.tabs.query({ url: 'http://localhost/*' }); await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['markers.js'] }); await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['markers.js'] }); return chrome.tabs.sendMessage(t.id, { type: 'repospector:markers', kind: 'github', findings: [{ id: 'f1', file: '${FIXTURE_PATH}', line: 10, status: 'verified', claim: 'SVG missing' }, { id: 'f2', file: '${FIXTURE_PATH}', line: 20, status: 'suspected', claim: 'not rendered' }] }); })()`);
  check(placed?.placed === 1 && placed?.total === 2, `marker script placed what is on the page (${JSON.stringify(placed)})`);
  const fixture = await attach(fixtureTab);
  const marks = await fixture(`[...document.querySelectorAll('.repospector-marker')].map((m) => [m.parentElement.id.slice(-3), m.textContent, m.getAttribute('aria-label')])`);
  check(JSON.stringify(marks) === JSON.stringify([['R10', 'RS', 'RepoSpector (verified): SVG missing']]), `one marker, on the new-side cell, labelled for screen readers, injected twice without duplicates: ${JSON.stringify(marks)}`);
  const rejectedMsg = await settings(`(async () => { const [t] = await chrome.tabs.query({ url: 'http://localhost/*' }); return chrome.tabs.sendMessage(t.id, { type: 'repospector:markers', kind: 'github', findings: [{ id: 'x', file: 'a', line: -1, status: 'verified', claim: 'bad' }] }).then((r) => r ?? 'no reply', (e) => 'error: ' + e.message); })()`);
  check(typeof rejectedMsg === 'string', `malformed marker message ignored: ${rejectedMsg}`);


  // Part 3 (C8): the shipped graph worker in Chrome: parser runtime, WebAssembly under the extension CSP,
  // gzip + tar, tree-sitter, reader context. Then the offscreen path on a real small public repo.
  const graphPage = await page(`${base}/options.html`);
  const direct = await graphPage(`new Promise((res) => { const w = new Worker('graph-worker.js'); const seen = []; w.onmessage = (e) => { seen.push(e.data.type); if (e.data.type !== 'progress') { w.terminate(); res({ ...e.data, seen }); } }; w.postMessage({ repo: 'localhost/o/r', sha: '${'a'.repeat(40)}', archiveUrl: 'http://localhost:${MODEL_PORT}/repo.tgz', findings: [{ id: 'f1', file: 'src/cart.py', line: 3 }, { id: 'f2', file: 'src/cart.py', line: 1 }], maxDownloadBytes: 1e7 }); })`);
  check(direct?.type === 'done' && direct.files === 3, `graph worker indexed the archive in Chrome (${JSON.stringify({ type: direct?.type, files: direct?.files, message: direct?.message, ms: direct?.ms })})`);
  // web.tsx calls an unrelated total(): matching is by name, which the panel says; both are listed.
  check(JSON.stringify(direct?.context?.f1?.callers) === JSON.stringify([{ file: 'src/pay.py', line: 2, caller: 'pay' }, { file: 'src/web.tsx', line: 1, caller: 'View' }]) && direct?.context?.f1?.symbol?.name === 'total', `callers of the finding's method, by name across languages: ${JSON.stringify(direct?.context?.f1?.callers)}`);
  check(JSON.stringify(direct?.context?.f2?.subtypes) === JSON.stringify([{ file: 'src/pay.py', line: 4, name: 'Gift' }]), `subclasses of the finding's class: ${JSON.stringify(direct?.context?.f2?.subtypes)}`);
  const runJob = (job) => graphPage(`new Promise((res) => { const w = new Worker('graph-worker.js'); w.onmessage = (e) => { if (e.data.type !== 'progress') { w.terminate(); res(e.data); } }; w.postMessage(${JSON.stringify(job)}); })`);
  const again = await runJob({ repo: 'localhost/o/r', sha: 'a'.repeat(40), archiveUrl: `http://localhost:${MODEL_PORT}/repo.tgz`, findings: [{ id: 'f1', file: 'src/cart.py', line: 3 }], maxDownloadBytes: 1e7 });
  check(again?.source === 'saved' && repoDownloads === 1 && JSON.stringify(again.context.f1) === JSON.stringify(direct?.context?.f1), `same commit again: from the saved index, no second download (${JSON.stringify({ source: again?.source, downloads: repoDownloads, ms: again?.ms })})`);
  const none = await runJob({ repo: 'localhost/o/r', sha: 'c'.repeat(40), findings: [], maxDownloadBytes: 1e7 });
  check(none?.type === 'error' && none.noSavedIndex === true && repoDownloads === 1, `index-only request for an unsaved commit touches no network: ${JSON.stringify(none)}`);

  const ctxRun = 'e2e-graph-0001';
  const msSha = '4ff48cec099f0514c3e9bbca18706c9c21122bfb';
  const msRun = { id: ctxRun, target: { kind: 'github', host: 'github.com', owner: 'vercel', repo: 'ms', number: 1 }, provider: 'ollama', model: 'stand-in', status: 'done', step: 'filter', startedAt: Date.now(), updatedAt: Date.now(), usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, notes: [], headSha: msSha, findings: [{ id: 'f1', file: 'src/index.ts', line: 60, claim: 'x', status: 'verified', fingerprint: 'fp', category: 'logic' }] };
  await graphPage(`new Promise((res) => { const o = indexedDB.open('repospector', 1); o.onsuccess = () => { const t = o.result.transaction('runs', 'readwrite'); t.objectStore('runs').put({ ...${JSON.stringify(msRun)}, targetKey: 'github.com/vercel/ms#1' }); t.oncomplete = () => { o.result.close(); res(true); }; }; })`);
  await graphPage(`chrome.runtime.sendMessage({ type: 'offscreen:ensure' })`);
  const msBuild = `chrome.runtime.sendMessage({ type: 'graph:build', runId: '${ctxRun}', repo: 'github.com/vercel/ms', sha: '${msSha}', archiveUrl: 'https://api.github.com/repos/vercel/ms/tarball/${msSha}', findings: [{ id: 'f1', file: 'src/index.ts', line: 60 }] })`;
  await graphPage(msBuild);
  let ctxState;
  for (let i = 0; i < 120; i++) {
    ctxState = (await graphPage(READ_RUN(ctxRun)))?.context;
    if (ctxState && ctxState.status !== 'running') break;
    await sleep(500);
  }
  check(ctxState?.status === 'done' && ctxState.files > 0, `offscreen indexed vercel/ms through GitHub's codeload redirect, no token (${JSON.stringify({ status: ctxState?.status, files: ctxState?.files, ms: ctxState?.ms, message: ctxState?.message })})`);
  const msCtx = ctxState?.perFinding?.f1;
  check(Boolean(msCtx?.symbol?.name), `reader context for a real file: ${JSON.stringify(msCtx ? { symbol: msCtx.symbol.name, callers: msCtx.callerCount } : null)}`);
  await graphPage(msBuild);
  let second;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    second = (await graphPage(READ_RUN(ctxRun)))?.context;
    if (second?.source === 'saved') break;
  }
  check(second?.source === 'saved' && JSON.stringify(second.perFinding) === JSON.stringify(ctxState?.perFinding), `vercel/ms again: from the saved index, same result (${second?.ms} ms vs ${ctxState?.ms} ms)`);

  // Settings: what is saved, and delete-all behind a second click.
  const settings2 = await page(`${base}/options.html`);
  await sleep(800);
  const savedText = await settings2(`document.getElementById('saved-index').innerText`);
  check(/3 commits indexed/.test(savedText), `settings shows the saved index: ${JSON.stringify(savedText.split('\n').filter(Boolean).slice(1, 2))}`);
  await settings2(`[...document.querySelectorAll('#saved-index button')].find((b) => b.textContent === 'Delete saved indexes').click()`);
  await settings2(`[...document.querySelectorAll('#saved-index button')].find((b) => /Click again/.test(b.textContent)).click()`);
  await sleep(500);
  check(/Nothing saved yet/.test(await settings2(`document.getElementById('saved-index').innerText`)), 'saved indexes deleted from settings');

  // Part 4 (C9b): local mode with the real program, registered only in this test profile.
  const extId = new URL(base).host;
  const shop = mkdtempSync(join(tmpdir(), 'rs-e2e-shop-'));
  const g2 = (...a) => execFileSync('git', ['-C', shop, ...a]).toString().trim();
  g2('init', '-q');
  g2('remote', 'add', 'origin', 'https://github.com/acme/shop.git');
  mkdirSync(join(shop, 'src'));
  writeFileSync(join(shop, 'src/cart.py'), 'class Cart:\n    def total(self, items):\n        return sum(items)\n');
  writeFileSync(join(shop, 'src/pay.py'), 'def pay(c):\n    return c.total([1])\n');
  g2('add', '.');
  g2('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x');
  const shopSha = g2('rev-parse', 'HEAD');
  // A clone of the PR's repo without the PR commit: the panel should say so and fall back.
  const nextClone = mkdtempSync(join(tmpdir(), 'rs-e2e-next-'));
  execFileSync('git', ['-C', nextClone, 'init', '-q']);
  execFileSync('git', ['-C', nextClone, 'remote', 'add', 'origin', 'git@github.com:vercel/next.js.git']);
  execFileSync('git', ['-C', nextClone, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  const mcpCli = new URL('../packages/mcp/dist/index.js', import.meta.url).pathname;
  execFileSync(process.execPath, [mcpCli, 'native', 'install', '--extension-id', extId, '--repo', shop, '--repo', nextClone, '--manifest-dir', join(userDataDir, 'NativeMessagingHosts')], { env: localEnv });
  const lp = await page(`${base}/options.html`);
  await sleep(1000);
  const hi = await lp(`chrome.runtime.sendNativeMessage('com.repospector.local', { type: 'hello' }).then((r) => r, (e) => ({ error: e.message }))`);
  check(hi?.ok === true && hi.repos?.length === 2 && hi.repos.some((r) => r.remotes.includes('github.com/acme/shop')), `Chrome reached the local program over native messaging: ${JSON.stringify(hi?.error ?? hi?.repos?.map((r) => r.remotes))}`);
  const lc = await lp(`chrome.runtime.sendNativeMessage('com.repospector.local', { type: 'context', repo: 'github.com/acme/shop', sha: '${shopSha}', findings: [{ id: 'f1', file: 'src/cart.py', line: 3 }] }).then((r) => r, (e) => ({ error: e.message }))`);
  check(lc?.ok === true && lc.context?.f1?.symbol?.name === 'total' && JSON.stringify(lc.context.f1.callers) === JSON.stringify([{ file: 'src/pay.py', line: 2, caller: 'pay' }]), `local program built context from the clone: ${JSON.stringify(lc?.error ?? lc?.context?.f1?.callers)}`);
  const bad = await lp(`chrome.runtime.sendNativeMessage('com.repospector.local', { type: 'read-file', path: '/etc/passwd' }).then((r) => r, (e) => ({ error: e.message }))`);
  check(bad?.ok === false && bad.reason === 'bad-request', `local program refuses anything but its two requests: ${JSON.stringify(bad)}`);
  await lp(`chrome.storage.local.set({ localMode: true })`);
  await lp(`location.reload()`);
  await sleep(1500);
  const localSettings = await lp(`document.getElementById('local-mode').innerText`);
  check(/Connected to RepoSpector .* It may read: .*github\.com\/acme\/shop/.test(localSettings) && localSettings.includes(`--extension-id ${extId}`), `settings shows the connection, the readable repos and this extension's install command: ${JSON.stringify(localSettings.split('\n').filter(Boolean).slice(1, 2))}`);
  // Panel on the PR: the local clone lacks the PR commit, so it says why and offers the download.
  await panel(`new Promise((res) => { const o = indexedDB.open('repospector'); o.onsuccess = () => { const t = o.result.transaction('runs', 'readwrite'); const st = t.objectStore('runs'); const g = st.index('target').getAll('github.com/vercel/next.js#96301'); g.onsuccess = () => { const run = g.result.sort((a, b) => b.startedAt - a.startedAt)[0]; delete run.context; st.put(run); }; t.oncomplete = () => { o.result.close(); res(true); }; }; })`);
  await panel(`indexedDB.deleteDatabase('repospector-index'); true`);
  await fetch(`http://127.0.0.1:${PORT}/json/activate/${prTab.id}`);
  await sleep(500);
  await panel(`new BroadcastChannel('repospector-runs').postMessage({}); true`);
  let localPanel = '';
  for (let i = 0; i < 40; i++) {
    localPanel = await panel('document.body.innerText');
    if (/Local mode could not help/.test(localPanel)) break;
    await sleep(250);
  }
  check(/Local mode could not help: the clone at .* does not have commit 62573ba3892d; run git fetch there/.test(localPanel) && /Show where this code is used/.test(localPanel), `panel asked the local clone, explained the missing commit, and still offers the download: ${JSON.stringify(localPanel.match(/Local mode could not help[^\n]*/)?.[0])}`);

  // Part 5 (C9a): meaning-based matching. Real settings flow: download the pinned model from
  // huggingface.co (checksums verified), then a review whose finding matches 3 reworded rejections
  // by meaning (cosine 0.79-0.90) but not by words (overlap <= 0.25), with the ONNX runtime in the
  // review worker under the extension's CSP.
  const mp = await page(`${base}/options.html`);
  await sleep(800);
  await mp(`[...document.querySelectorAll('#meaning button')].find((b) => /Download the model/.test(b.textContent)).click()`);
  let meaningText = '';
  for (let i = 0; i < 240; i++) {
    meaningText = await mp(`document.getElementById('meaning').innerText`);
    if (/^On\.|Could not set it up/m.test(meaningText)) break;
    await sleep(500);
  }
  check(/On\. The model is saved on this device/.test(meaningText), `settings downloaded, verified and saved the model: ${JSON.stringify(meaningText.split('\n').filter(Boolean).slice(-2))}`);
  const reworded = ["svg isn't in the allowed list once block() is called", 'block() leaves SVG out of the permitted formats', 'After calling block, SVG files are no longer allowed'];
  const meaningRows = reworded.map((claim, i) => ({ key: `meaning-${i}`, choice: 'not-useful', repo: 'github.com/vercel/next.js', entry: { fingerprint: `meaning-${i}`, category: 'logic', severity: 'medium', claim, file: 'packages/next/src/server/image-optimizer.ts', reaction: 'rejected', reason: 'covered', at: new Date().toISOString() } }));
  await mp(`new Promise((res) => { const o = indexedDB.open('repospector'); o.onsuccess = () => { const t = o.result.transaction('feedback', 'readwrite'); t.objectStore('feedback').clear(); for (const r of ${JSON.stringify(meaningRows)}) t.objectStore('feedback').put(r); t.oncomplete = () => { o.result.close(); res(true); }; }; })`);
  const meaningRun = 'e2e-meaning-0001';
  await mp(`chrome.runtime.sendMessage({ type: 'offscreen:ensure' })`);
  await mp(`chrome.runtime.sendMessage(${JSON.stringify({ ...start, runId: meaningRun, semanticFeedback: true })})`);
  let mr;
  for (let i = 0; i < 240; i++) {
    mr = await mp(READ_RUN(meaningRun));
    if (mr?.status === 'done' || mr?.status === 'failed') break;
    await sleep(500);
  }
  const svg = mr?.findings?.find((f) => /SVG/.test(f.claim));
  check(mr?.status === 'done' && svg?.status === 'suspected' && svg?.suspectedBecause === 'similar to 3 comments your team rejected', `review in Chrome demoted the finding by meaning: ${JSON.stringify({ status: mr?.status, finding: svg?.status, why: svg?.suspectedBecause, error: mr?.error?.message })}`);
  check(!(mr?.notes ?? []).some((n) => /unavailable/.test(n)), `the ONNX runtime ran in the review worker (no fallback note): ${JSON.stringify(mr?.notes)}`);
} catch (e) {
  failures++; // a crash is a failure, not a pass with zero failed checks
  console.log(`FAIL the check stopped: ${e.message}`);
} finally {
  chrome.kill();
  model.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
}

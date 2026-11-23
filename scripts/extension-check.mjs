// Usage: node scripts/extension-check.mjs "<Chrome for Testing binary>" "$PWD/packages/extension/dist/extension"
// Branded Chrome ignores --load-extension; use Chrome for Testing (e.g. from ~/Library/Caches/ms-playwright).
// Loads the built extension in Chrome for Testing (headless) and checks its pages over CDP.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [chromeBin, extDir] = process.argv.slice(2);
const port = 9333;
const chrome = spawn(chromeBin, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'rs-ext-'))}`, `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (path, method = 'GET') => (await fetch(`http://127.0.0.1:${port}${path}`, { method })).json();
try {
  let targets = [];
  for (let i = 0; i < 40; i++) { try { targets = await json('/json/list'); if (targets.some((t) => t.url.startsWith('chrome-extension://'))) break; } catch {} await sleep(250); }
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/sw.js'));
  console.log('service worker:', sw ? sw.url : 'NOT FOUND');
  if (!sw) process.exit(1);
  const base = sw.url.replace('/sw.js', '');
  async function page(path, setup, steps = []) {
    const t = await json(`/json/new?${base}/${path}`, 'PUT');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 0; const errors = [];
    const pending = new Map();
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' ')); });
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable');
    const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
    if (setup) { await evalJs(setup); await send('Page.reload'); }
    await sleep(800);
    const text = await evalJs('document.body.innerText');
    const done = [];
    for (const [name, js] of steps) done.push([name, await evalJs(js)]);
    ws.close();
    return { text, errors, steps: done };
  }
  const p1 = await page('sidepanel.html');
  console.log('side panel (no hosts):', JSON.stringify(p1.text), 'errors:', p1.errors);
  const p2 = await page('sidepanel.html', "chrome.storage.local.set({hosts:[{kind:'github',origin:'https://github.com'}]})");
  console.log('side panel (github added):', JSON.stringify(p2.text), 'errors:', p2.errors);
  const o = await page('options.html');
  console.log('options:', JSON.stringify(o.text.slice(0, 200)), 'errors:', o.errors);
  // Vault flow through the real form, with Chrome's WebCrypto and the full PBKDF2 cost.
  const KEY = 'sk-ant-api03-CHECKCHECKCHECKCHECK';
  const flow = await page('options.html', null, [
    ["create", "(() => { const s=(id,v)=>{const e=document.getElementById(id); e.value=v;}; s('pass1','correct horse battery'); s('pass2','correct horse battery'); const t=performance.now(); document.querySelector('#keys form').requestSubmit(); return new Promise(r=>{const w=()=>document.getElementById('secret-value')?r(Math.round(performance.now()-t)):setTimeout(w,50); w();}); })()"],
    ["save key", `(() => { document.getElementById('secret-value').value='${KEY}'; document.querySelector('#keys form').requestSubmit(); return new Promise(r=>setTimeout(()=>r(document.getElementById('keys').innerText),500)); })()`],
    ["stored", `chrome.storage.local.get('vault').then(v => { const j = JSON.stringify(v); return { hasPlaintext: j.includes('${KEY}'), iterations: v.vault.iterations, items: Object.keys(v.vault.items) }; })`],
    ["lock", "(() => { [...document.querySelectorAll('#keys button')].find(b=>b.textContent==='Lock now').click(); return new Promise(r=>setTimeout(()=>r(document.getElementById('keys').innerText),300)); })()"],
    ["wrong pass", "(() => { document.getElementById('unlock').value='not the passphrase'; document.querySelector('#keys form').requestSubmit(); return new Promise(r=>setTimeout(()=>r(document.getElementById('status').innerText),2500)); })()"],
    ["right pass", "(() => { document.getElementById('unlock').value='correct horse battery'; document.querySelector('#keys form').requestSubmit(); return new Promise(r=>setTimeout(()=>r(document.getElementById('keys').innerText),2500)); })()"],
  ]);
  for (const [name, value] of flow.steps) console.log(`vault ${name}:`, JSON.stringify(value));
  const model = await page('options.html', null, [
    ["model section", "document.getElementById('model').innerText.slice(0, 300)"],
    ["switch to ollama", "(() => { const p=document.getElementById('provider'); p.value='ollama'; p.dispatchEvent(new Event('change')); return { ollamaVisible: !document.getElementById('ollamaModel').hidden, presetDisabled: document.getElementById('preset').disabled }; })()"],
    ["test without key", "(() => { const p=document.getElementById('provider'); p.value='openai'; p.dispatchEvent(new Event('change')); document.getElementById('test').click(); return new Promise(r=>setTimeout(()=>r(document.getElementById('status').innerText),1500)); })()"],
    ["test loads SDK chunk", "(() => { const p=document.getElementById('provider'); p.value='ollama'; p.dispatchEvent(new Event('change')); document.getElementById('ollamaModel').value='no-such-model'; document.getElementById('test').click(); return new Promise(r=>setTimeout(()=>r(document.getElementById('status').innerText),4000)); })()"],
  ]);
  for (const [name, value] of model.steps) console.log(`model ${name}:`, JSON.stringify(value));
  console.log('model errors:', model.errors);
  console.log('vault errors:', flow.errors);
} finally { chrome.kill(); }

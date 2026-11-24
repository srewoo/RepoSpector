// UI check for the extension pages in Chrome for Testing (headless), over CDP:
// themes x widths (overflow, control height, unique names, measured text contrast), real Tab
// navigation with focus-ring check, and a click-through of every control with console errors.
// Usage: node scripts/extension-ui-check.mjs "<Chrome for Testing binary>" "$PWD/packages/extension/dist/extension"
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [chromeBin, builtDir] = process.argv.slice(2);
// Test-only copy of the build with the model provider and GitHub pre-granted, because headless Chrome
// cannot click a permission prompt. Model-list calls are intercepted (see mock), so nothing leaves the machine.
const extDir = mkdtempSync(join(tmpdir(), 'rs-ui-ext-'));
cpSync(builtDir, extDir, { recursive: true });
const testManifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
testManifest.host_permissions = ['https://api.anthropic.com/*', 'https://github.com/*', 'https://api.github.com/*'];
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(testManifest));
const port = 9334;
const chrome = spawn(chromeBin, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'rs-ui-'))}`, `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (path, method = 'GET') => (await fetch(`http://127.0.0.1:${port}${path}`, { method })).json();
let failures = 0;
const check = (ok, label) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
};

// Runs in the page: measured contrast of every visible text node's element against its effective background.
const AUDIT = `(() => {
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) return c; } return { r: 255, g: 255, b: 255 }; };
  const out = { worst: 99, worstWhere: '', overflow: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth, shortControls: [], dupNames: [] };
  for (const el of document.querySelectorAll('body *')) {
    if (!el.offsetParent || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const fg = parse(getComputedStyle(el).color); if (!fg) continue;
    const a = lum(fg), b = lum(bgOf(el)); let ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (el.disabled) continue; // disabled controls are exempt from WCAG 1.4.3
    if (ratio < out.worst) { out.worst = Math.round(ratio * 100) / 100; out.worstWhere = el.tagName + ' ' + el.textContent.trim().slice(0, 40); }
  }
  const names = new Map();
  for (const c of document.querySelectorAll('button, input, select')) {
    if (!c.offsetParent) continue;
    if (c.getBoundingClientRect().height < 36) out.shortControls.push(c.id || c.textContent.trim().slice(0, 30));
    const n = c.getAttribute('aria-label') || c.labels?.[0]?.textContent || c.textContent.trim();
    names.set(n, (names.get(n) ?? 0) + 1);
  }
  out.dupNames = [...names].filter(([, k]) => k > 1).map(([n]) => n);
  return out;
})()`;

async function open(url) {
  const t = await json(`/json/new?${url}`, 'PUT');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  const errors = [];
  const mocks = [];
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Fetch.requestPaused') {
      const hit = mocks.find((x) => d.params.request.url.startsWith(x.prefix));
      ws.send(JSON.stringify(hit
        ? { id: 1e6 + Math.floor(Math.random() * 1e6), method: 'Fetch.fulfillRequest', params: { requestId: d.params.requestId, responseCode: hit.status, responseHeaders: [{ name: 'content-type', value: 'application/json' }, ...Object.entries(hit.headers).map(([name, value]) => ({ name, value }))], body: Buffer.from(JSON.stringify(hit.json)).toString('base64') } }
        : { id: 1e6 + Math.floor(Math.random() * 1e6), method: 'Fetch.continueRequest', params: { requestId: d.params.requestId } }));
      if (hit) hit.calls.push({ url: d.params.request.url, headers: d.params.request.headers });
    }
    if (d.id && pending.has(d.id)) (pending.get(d.id)(d), pending.delete(d.id));
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  // As if the user clicked: permissions.request needs a user gesture.
  const click = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })).result?.result?.value;
  /** Answers requests starting with prefix with a canned JSON reply; records each call. */
  const mock = async (prefix, status, json, headers = {}) => {
    const m = { prefix, status, json, headers, calls: [] };
    const old = mocks.findIndex((x) => x.prefix === prefix);
    if (old >= 0) mocks.splice(old, 1);
    mocks.push(m);
    await send('Fetch.enable', { patterns: mocks.map((x) => ({ urlPattern: `${x.prefix}*` })) });
    return m;
  };
  const view = async (width, dark) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
    await sleep(300);
  };
  const tab = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    return js(`(() => { const e = document.activeElement; const s = getComputedStyle(e); return { name: e.getAttribute('aria-label') || e.labels?.[0]?.textContent || e.textContent.trim().slice(0, 40) || e.tagName, ring: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2 }; })()`);
  };
  await sleep(800);
  const shot = async (file) => {
    await send('Emulation.setDeviceMetricsOverride', { width: 800, height: Math.ceil(await js('document.documentElement.scrollHeight')), deviceScaleFactor: 1, mobile: false });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  };
  return { js, click, mock, view, tab, shot, errors, close: () => ws.close() };
}

async function audit(p, label) {
  for (const dark of [false, true]) for (const width of [360, 800]) {
    await p.view(width, dark);
    const r = await p.js(AUDIT);
    const where = `${label} ${dark ? 'dark' : 'light'} ${width}px`;
    check(r.worst >= 4.5, `${where}: worst text contrast ${r.worst}:1 (${r.worstWhere})`);
    check(!r.overflow, `${where}: no horizontal overflow`);
    check(r.shortControls.length === 0, `${where}: controls >= 36px${r.shortControls.length ? ` (short: ${r.shortControls.join(', ')})` : ''}`);
    check(r.dupNames.length === 0, `${where}: unique control names${r.dupNames.length ? ` (dup: ${r.dupNames.join(', ')})` : ''}`);
  }
}

async function keyboard(p, label, stops) {
  await p.view(800, false);
  const seen = [];
  for (let i = 0; i < stops; i++) seen.push(await p.tab());
  check(seen.every((s) => s.ring), `${label}: focus ring visible on every Tab stop`);
  console.log(`  ${label} tab order: ${seen.map((s) => s.name.replace(/\s+/g, ' ')).join(' > ')}`);
}

try {
  let targets = [];
  for (let i = 0; i < 40; i++) { try { targets = await json('/json/list'); if (targets.some((t) => t.url.endsWith('/sw.js'))) break; } catch {} await sleep(250); }
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/sw.js'));
  if (!sw) throw new Error('extension did not load');
  const base = sw.url.replace('/sw.js', '');

  // Side panel, nothing set up.
  let panel = await open(`${base}/sidepanel.html`);
  check((await panel.js('document.body.innerText')).includes('Finish setup'), 'side panel (new user): points to setup');
  if (process.env.SHOT_DIR) { await panel.view(400, false); await panel.shot(`${process.env.SHOT_DIR}/panel.png`); }
  await audit(panel, 'side panel (no hosts)');
  await keyboard(panel, 'side panel', 1);
  panel.close();

  // Options: a new user's path, top to bottom. Provider and GitHub calls are answered by mocks.
  const o = await open(`${base}/options.html`);
  const status = () => o.js("document.getElementById('status').innerText");
  const text = (id) => o.js(`document.getElementById('${id}').innerText`);
  const keyStatus = () => o.js("document.getElementById('api-key-status')?.innerText ?? ''");
  const connectStatus = () => o.js("document.getElementById('connect-status')?.innerText ?? ''");
  await sleep(400);
  check(/○ ?Add your own AI provider API key/.test(await text('checklist')), 'checklist: first step is the API key');
  check(await o.js("!!document.getElementById('api-key') && !!document.getElementById('key-pass1')"), 'step 1: key field shown straight away, with the passphrase that will encrypt it');
  check(/Create one on Anthropic/.test(await text('model')), 'step 1: links to the provider key page');
  check(await o.js("!document.getElementById('model-pick')") && /Your models appear here once your key is checked/.test(await text('model')), 'step 1: no model list before a key is checked');
  check((await o.js("document.getElementById('origin').value")) === 'https://github.com', 'step 2: github.com pre-filled');
  await o.js("(() => { const k = document.getElementById('kind'); k.value = 'gitlab'; k.dispatchEvent(new Event('change')); })()");
  check((await o.js("document.getElementById('origin').value")) === 'https://gitlab.com', 'step 2: switching to GitLab pre-fills gitlab.com');
  await o.js("(() => { const k = document.getElementById('kind'); k.value = 'github'; k.dispatchEvent(new Event('change')); })()");

  const saveKey = "[...document.querySelectorAll('#model button')].find(b => b.textContent === 'Check and save key').click()";
  const fill = (key, p1, p2) => `document.getElementById('api-key').value='${key}'; document.getElementById('key-pass1').value='${p1}'; document.getElementById('key-pass2').value='${p2}';`;
  await o.js(`(() => { ${fill('sk-ant-api03-UICHECK', 'correct horse battery', 'different one here')} ${saveKey}; })()`);
  check(/do not match/.test(await keyStatus()), 'save key: mismatched passphrases are explained next to the button');
  // Wrong key: the provider says 401. Nothing may be saved, not even the vault.
  const models = await o.mock('https://api.anthropic.com/v1/models', 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  await o.click(`(() => { ${fill('sk-ant-WRONG', 'correct horse battery', 'correct horse battery')} ${saveKey}; })()`); await sleep(1500);
  check(/Anthropic rejected this key \(401\).*The key was not saved\./.test(await keyStatus()), `wrong key: says so and saves nothing: "${await keyStatus()}"`);
  check(/No keys saved yet/.test(await text('vault')) && await o.js("!document.getElementById('model-pick')"), 'wrong key: no vault, no model list');
  // Right key: the list is what the key can use; the recommended model is saved automatically.
  await o.mock('https://api.anthropic.com/v1/models', 200, { data: [{ id: 'claude-x-preview', display_name: 'Claude X' }, { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }], has_more: false });
  await o.click(`(() => { ${fill('sk-ant-api03-UICHECK', 'correct horse battery', 'correct horse battery')} ${saveKey}; })()`); await sleep(2500);
  check((await keyStatus()) === 'Key works: 2 models available.' && /Reviews will use claude-sonnet-5-5 \(recommended\)/.test(await status()), `right key: saved, list loaded, recommended model chosen: "${await keyStatus()}" / "${await status()}"`);
  const call = (await o.mock('https://api.anthropic.com/v1/models', 200, { data: [{ id: 'claude-x-preview', display_name: 'Claude X' }, { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }], has_more: false })) && models;
  check(call.calls.length >= 1 && call.calls.every((x) => !x.url.includes('UICHECK') && !x.url.includes('WRONG')), 'model list: the key is never in a URL');
  check(/Anthropic API key saved/.test(await text('model')) && /Check again/.test(await text('model')), 'step 1: saved key row with Check again / Replace / Remove');
  check(!(await o.js("document.body.innerText")).includes('UICHECK'), 'the key value is never displayed');
  const options = await o.js("[...document.getElementById('model-pick').options].map(x => x.textContent)");
  check(options[0]?.startsWith('Claude Sonnet 5.5 (claude-sonnet-5-5) · Recommended') && options[1] === 'Claude X (claude-x-preview)' && options.length === 3, `model list: only the key's models, recommended first: ${JSON.stringify(options)}`);
  check(/Reviews use claude-sonnet-5-5/.test(await text('model')), 'model: says which model reviews use');
  await o.js("(() => { const p = document.getElementById('model-pick'); p.value = 'claude-x-preview'; p.dispatchEvent(new Event('change')); })()");
  check(/Price not listed/.test(await text('model')), 'model: unknown price is said plainly');
  await o.click("[...document.querySelectorAll('#model button')].find(b => b.textContent === 'Save model').click()"); await sleep(600);
  check((await status()).includes('reviews will use claude-x-preview'), 'Save model: saves the picked model');
  check(/Lock keys now/.test(await text('vault')), 'key security: vault created by the first good key');

  // Git: a wrong token is refused before anything is saved; a right one connects and names the account.
  await o.mock('https://api.github.com/user', 401, { message: 'Bad credentials' });
  await o.click("(() => { document.getElementById('token').value = 'ghp_WRONG'; document.getElementById('token').dispatchEvent(new Event('input')); document.querySelector('#add button[type=submit]').click(); })()"); await sleep(1200);
  check(/GitHub rejected this token \(401\).*Nothing was saved/.test(await connectStatus()), `wrong token: says so: "${await connectStatus()}"`);
  check(!(await o.js("document.getElementById('hosts').innerText")).includes('github.com'), 'wrong token: host not connected');
  await o.mock('https://api.github.com/user', 200, { login: 'octo' }, { 'x-oauth-scopes': 'repo' });
  await o.click("(() => { document.getElementById('token').value = 'ghp_UICHECK'; document.querySelector('#add button[type=submit]').click(); })()"); await sleep(1200);
  check(/Token works: signed in as octo\. It can post draft reviews/.test(await text('hosts')), `right token: connected, names the account and what it can do: "${await text('hosts')}"`);
  check(!(await o.js("document.body.innerText")).includes('ghp_'), 'tokens are never displayed');
  check(/All set/.test(await o.js("document.querySelector('section.start').innerText")), 'checklist: all done, says how to start a review');
  if (process.env.SHOT_DIR) { await o.view(800, false); await o.shot(`${process.env.SHOT_DIR}/options.png`); }

  await o.js("(() => { const p = document.getElementById('provider'); p.value = 'ollama'; p.dispatchEvent(new Event('change')); })()"); await sleep(400);
  check(await o.js("!!document.getElementById('ollamaUrl') && !document.getElementById('api-key')") && /Check connection and load models/.test(await text('model')), 'Ollama: address and a connection check, no key field');
  await o.js("(() => { const p = document.getElementById('provider'); p.value = 'openai'; p.dispatchEvent(new Event('change')); })()"); await sleep(400);
  check(await o.js("!!document.getElementById('api-key') && !document.getElementById('key-pass1')"), 'second provider: key field only, encryption already set up');
  check(await o.js("!document.getElementById('local-mode') && !document.body.innerText.includes('npm install')"), 'local mode is not in the store build');
  check(!(await o.js("document.querySelector('details.advanced').open")) && /Meaning-based matching/.test(await o.js("document.querySelector('details.advanced').textContent")), 'advanced features collapsed by default');
  check(/Download the model \(22 MB\) and turn on/.test(await o.js("document.getElementById('meaning').textContent")), 'meaning-based matching: off by default, offers the download with its size');
  check(/Help/.test(await o.js("document.querySelector('footer').innerText")), 'settings links to help and privacy');
  await audit(o, 'options (set up)');
  await o.js("document.querySelector('details.advanced').open = true"); await sleep(200);
  await audit(o, 'options (advanced open)');
  await o.js("document.querySelector('details.advanced').open = false");
  await keyboard(o, 'options', 12);
  await o.js("[...document.querySelectorAll('#vault button')].find(b => b.textContent === 'Lock keys now').click()"); await sleep(800);
  check(!!(await o.js("!!document.getElementById('key-unlock')")) && /locked/.test(await text('model')), 'Lock keys now: step 1 offers unlock in place');

  // Keys locked (as after a Chrome restart or extension reload): the side panel unlocks in place.
  const prTab = await json(`/json/new?https://github.com/sindresorhus/ky/pull/883`, 'PUT');
  const lockedPanel = await open(`${base}/sidepanel.html`);
  await fetch(`http://127.0.0.1:${port}/json/activate/${prTab.id}`);
  let ptext = '';
  for (let i = 0; i < 30 && !/Your keys are locked/.test(ptext); i++) { await sleep(300); ptext = await lockedPanel.js('document.body.innerText'); }
  check(/Your keys are locked\. Enter your passphrase to review this pull request\./.test(ptext) && !!(await lockedPanel.js("!!document.getElementById('panel-unlock')")), 'side panel (keys locked): unlock form in the panel, not a trip to settings');
  check((await lockedPanel.js('document.activeElement?.id')) === 'panel-unlock', 'side panel (keys locked): passphrase field has focus');
  await lockedPanel.js("(() => { document.getElementById('panel-unlock').value = 'wrong passphrase!'; [...document.querySelectorAll('button')].find(b => b.textContent === 'Unlock keys').click(); })()"); await sleep(2500);
  check(/That passphrase is not right/.test(await lockedPanel.js('document.body.innerText')), 'side panel: a wrong passphrase is explained in place');
  await lockedPanel.js("(() => { document.getElementById('panel-unlock').value = 'correct horse battery'; document.getElementById('panel-unlock').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()");
  for (let i = 0; i < 40; i++) { await sleep(400); ptext = await lockedPanel.js('document.body.innerText'); if (/Reviews \d+ KB|Could not read|rejected your saved/.test(ptext)) break; }
  // The test's saved GitHub token is fake, so real GitHub answers 401: the panel must say the saved token was rejected.
  check(!(await lockedPanel.js("!!document.getElementById('panel-unlock')")) && /github\.com rejected your saved access token \(401\)/.test(ptext), `side panel: Enter unlocks and goes straight to reading the PR (fake saved token → says it was rejected): ${JSON.stringify(ptext.split('\n').filter(Boolean).slice(3, 5))}`);
  await audit(lockedPanel, 'side panel (unlocked, ready to review)');
  check(lockedPanel.errors.length === 0, `side panel: no console errors${lockedPanel.errors.length ? `: ${lockedPanel.errors.join(' | ')}` : ''}`);
  lockedPanel.close();
  await o.js("[...document.querySelectorAll('#vault button')].find(b => b.textContent === 'Lock keys now')?.click()"); await sleep(600);
  await o.js("[...document.querySelectorAll('#hosts button')].find(b => b.textContent === 'Disconnect').click()"); await sleep(600);
  check((await status()).includes('Disconnected github.com'), `Disconnect: removes the host and says so: "${await status()}"`);
  check(o.errors.length === 0, `options: no console errors${o.errors.length ? `: ${o.errors.join(' | ')}` : ''}`);
  o.close();

  // Side panel with a host but not on a PR.
  panel = await open(`${base}/sidepanel.html`);
  await panel.js("chrome.storage.local.set({hosts:[{kind:'github',origin:'https://github.com'}]})"); await sleep(500);
  check((await panel.js('document.body.innerText')).includes('Your hosts: github.com.'), 'side panel (host, no PR): lists hosts and the next step');
  await audit(panel, 'side panel (host, no PR)');
  check(panel.errors.length === 0, `side panel: no console errors${panel.errors.length ? `: ${panel.errors.join(' | ')}` : ''}`);
  panel.close();

  // Help and privacy pages: same checks, and every link is reachable by keyboard with a visible ring.
  for (const [file, label, stops] of [['help.html', 'help', 9], ['privacy.html', 'privacy', 1]]) {
    const d = await open(`${base}/${file}`);
    check((await d.js('document.querySelector("h1").innerText')).length > 0, `${label}: renders`);
    await audit(d, label);
    if (label === 'help') await keyboard(d, label, stops);
    check(d.errors.length === 0, `${label}: no console errors${d.errors.length ? `: ${d.errors.join(' | ')}` : ''}`);
    d.close();
  }
} catch (e) {
  failures++; // a crash is a failure, not a pass with zero failed checks
  console.log(`FAIL the check stopped: ${e.message}`);
} finally {
  chrome.kill();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
}

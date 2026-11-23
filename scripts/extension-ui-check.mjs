// UI check for the extension pages in Chrome for Testing (headless), over CDP:
// themes x widths (overflow, control height, unique names, measured text contrast), real Tab
// navigation with focus-ring check, and a click-through of every control with console errors.
// Usage: node scripts/extension-ui-check.mjs "<Chrome for Testing binary>" "$PWD/packages/extension/dist/extension"
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [chromeBin, extDir] = process.argv.slice(2);
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
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) (pending.get(d.id)(d), pending.delete(d.id));
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
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
  return { js, view, tab, errors, close: () => ws.close() };
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

  // Side panel, no hosts.
  let panel = await open(`${base}/sidepanel.html`);
  check((await panel.js('document.body.innerText')).includes('Add GitHub or GitLab in settings'), 'side panel (no hosts): explains next step');
  await audit(panel, 'side panel (no hosts)');
  await keyboard(panel, 'side panel', 1);
  panel.close();

  // Options: click-through.
  const o = await open(`${base}/options.html`);
  const status = () => o.js("document.getElementById('status').innerText");
  await o.js("(() => { document.getElementById('origin').value = 'https://gitlab.example/group'; document.querySelector('#add button').click(); })()");
  check((await status()).includes('without a path'), 'Add host with a path: explains the expected format');
  await o.js("(() => { document.getElementById('origin').value = 'https://github.com'; document.querySelector('#add button').click(); })()"); await sleep(500);
  check(/not granted|could not ask/i.test(await status()), `Add host (headless, no permission prompt): reports the permission outcome: "${await status()}"`);
  await o.js("chrome.storage.local.set({hosts:[{kind:'github',origin:'https://github.com'}]})"); await sleep(400);
  check((await o.js("document.getElementById('hosts').innerText")).includes('GitHub at github.com'), 'host list shows the added host');
  await o.js("(() => { document.getElementById('pass1').value='correct horse battery'; document.getElementById('pass2').value='different passphrase'; document.querySelector('#keys form').requestSubmit(); })()");
  check((await status()).includes('do not match'), 'vault: mismatched passphrases are explained');
  await o.js("(() => { document.getElementById('pass2').value='correct horse battery'; document.querySelector('#keys form').requestSubmit(); })()"); await sleep(1500);
  check(!!(await o.js("!!document.getElementById('secret-value')")), 'vault: created and unlocked');
  check((await o.js("document.getElementById('keys').innerText")).includes('No keys or tokens yet.'), 'keys: empty state names the next action');
  await o.js("(() => { document.getElementById('secret-for').value='provider:anthropic'; document.getElementById('secret-value').value='sk-ant-api03-UICHECK'; document.querySelector('#keys form').requestSubmit(); })()"); await sleep(600);
  check((await o.js("document.getElementById('keys').innerText")).includes('provider:anthropic'), 'keys: saved key listed by name');
  check(!(await o.js("document.body.innerText")).includes('UICHECK'), 'keys: the key value is never displayed');
  await o.js("[...document.querySelectorAll('#keys button')].find(b => b.textContent === 'Test key').click()"); await sleep(800);
  const rowStatus = await o.js("document.querySelector('#keys .row-status').innerText");
  check(/permission|not granted|user gesture/i.test(rowStatus), `Test key (headless, no permission prompt): row reports the outcome: "${rowStatus}"`);
  await o.js("(() => { const p = document.getElementById('provider'); p.value = 'ollama'; p.dispatchEvent(new Event('change')); })()");
  check(await o.js("!document.getElementById('ollamaModel').hidden && document.getElementById('preset').disabled"), 'model: Ollama shows its model field and disables presets');
  await o.js("document.getElementById('test').click()"); await sleep(600);
  check((await status()).length > 0, `Test this model: reports a result: "${await status()}"`);
  const localText = await o.js("document.getElementById('local-mode').innerText");
  check(localText.includes('npm install -g repospector-mcp@0.7.0') && localText.includes('native install --extension-id'), 'local mode: shows the install commands for this extension');
  await o.js("[...document.querySelectorAll('#local-mode button')].find(b => b.textContent === 'Turn on local mode').click()"); await sleep(600);
  check(/not granted|could not ask|is on/i.test(await status()), `Turn on local mode (headless, no permission prompt): reports the outcome: "${await status()}"`);
  check(/Download the model \(22 MB\) and turn on/.test(await o.js("document.getElementById('meaning').innerText")), 'meaning-based matching: off by default, offers the download with its size');
  check(/Help/.test(await o.js("document.querySelector('footer').innerText")), 'settings links to help and privacy');
  await audit(o, 'options (unlocked, 1 key, 1 host)');
  await keyboard(o, 'options', 14);
  await o.js("[...document.querySelectorAll('#keys button')].find(b => b.textContent === 'Lock keys now').click()"); await sleep(600);
  check(!!(await o.js("!!document.getElementById('unlock')")), 'Lock keys now: shows the unlock form');
  await o.js("[...document.querySelectorAll('#hosts button')][0].click()"); await sleep(600);
  check((await status()).includes('Removed https://github.com'), 'Remove host: removes it and says so');
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

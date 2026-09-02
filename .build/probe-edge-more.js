//  Read-only: click "Show More" on the ExtensionInstallForcelist / ExtensionSettings
//  rows of edge://policy and print what Edge reveals -- the error and warning text
//  is only put in the DOM when that row is expanded.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 9337;
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
    .find(p => fs.existsSync(p));
const tmp = path.join(os.tmpdir(), `fp-edge-more-${process.pid}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); }).on('error', rej);
});

const child = spawn(EDGE, [
    `--user-data-dir=${tmp}`, '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-gpu', '--headless=new', `--remote-debugging-port=${PORT}`,
], { detached: true, stdio: 'ignore', windowsHide: true });
child.unref();

const CLICK_AND_DUMP = String.raw`(async () => {
  const all = [];
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document);

  const entries = all.filter(el => el.classList?.contains('entry'));
  const want = /^Extension(InstallForcelist|Settings|InstallAllowlist)$/;
  const picked = entries.filter(e => want.test((e.querySelector('a')?.textContent || '').trim()));

  for (const e of picked) { const b = e.querySelector('button'); try { b?.click(); } catch (err) {} }
  await new Promise(r => setTimeout(r, 1500));

  //  re-walk: expanding adds nodes
  const all2 = [];
  walk2 = (root) => { for (const el of root.querySelectorAll('*')) { all2.push(el); if (el.shadowRoot) walk2(el.shadowRoot); } };
  walk2(document);

  const out = [];
  for (const e of entries) {
    const name = (e.querySelector('a')?.textContent || '').trim();
    if (!want.test(name)) continue;
    const container = e.parentElement;
    const idx = [...container.children].indexOf(e);
    const chunk = [...container.children].slice(idx, idx + 3);
    out.push('════ ' + name + '\n' + chunk.map(c => c.innerText || c.textContent).join('\n---\n'));
  }
  return out.join('\n\n') || 'nothing';
})()`;

class Cdp {
    constructor(url) {
        this.ws = new WebSocket(url); this.id = 0; this.pending = new Map();
        this.ready = new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
        this.ws.onmessage = (e) => { const m = JSON.parse(e.data);
            if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } };
    }
    send(method, params = {}, sessionId) {
        return new Promise(r => { const id = ++this.id; this.pending.set(id, r);
            this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
    }
}

(async () => {
    let ver = null;
    for (let i = 0; i < 60 && !ver; i++) { await sleep(500);
        try { ver = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/version`)); } catch {} }
    if (!ver) { console.log('DevTools never came up'); process.exit(0); }
    const br = new Cdp(ver.webSocketDebuggerUrl); await br.ready;
    const t = await br.send('Target.createTarget', { url: 'edge://policy' });
    const at = await br.send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
    const sid = at.result.sessionId;
    await br.send('Runtime.enable', {}, sid);
    await sleep(7000);
    const r = await br.send('Runtime.evaluate',
        { expression: CLICK_AND_DUMP, returnByValue: true, awaitPromise: true }, sid);
    if (r?.result?.exceptionDetails)
        console.log('eval threw:', JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    const text = r?.result?.result?.value || '(empty)';
    fs.writeFileSync(path.join(__dirname, 'probe-edge-more.txt'), text);
    console.log(text);
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch {}
    await sleep(1200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    process.exit(0);
})();

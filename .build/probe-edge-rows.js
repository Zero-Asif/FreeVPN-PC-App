//  Read-only: find the edge://policy cell that names ExtensionInstallForcelist,
//  walk up to the row that owns it (crossing shadow boundaries), and print that
//  subtree with tag names so Edge's own error/warning text is visible.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 9336;
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
    .find(p => fs.existsSync(p));
const tmp = path.join(os.tmpdir(), `fp-edge-row2-${process.pid}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); }).on('error', rej);
});

const child = spawn(EDGE, [
    `--user-data-dir=${tmp}`, '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-gpu', '--headless=new', `--remote-debugging-port=${PORT}`,
], { detached: true, stdio: 'ignore', windowsHide: true });
child.unref();

const DUMP = String.raw`(async () => {
  const all = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);

  const hits = all.filter(el => !el.children.length &&
      /^Extension(InstallForcelist|Settings)$/.test(el.textContent.trim()));
  const up = (el, n) => { let c = el; for (let i = 0; i < n; i++) {
      c = c.parentElement || c.getRootNode().host; if (!c) break; } return c; };

  const render = (el, depth = 0, out = []) => {
    const pad = '  '.repeat(depth);
    const cls = el.getAttribute && el.getAttribute('class');
    const hid = el.hasAttribute && (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true');
    const own = [...el.childNodes].filter(n => n.nodeType === 3)
        .map(n => n.textContent.trim()).filter(Boolean).join(' ');
    out.push(pad + '<' + el.tagName.toLowerCase() + (cls ? ' .' + cls.split(/\s+/).join('.') : '')
             + (hid ? ' [hidden]' : '') + '>' + (own ? '  ' + own : ''));
    if (el.shadowRoot) { out.push(pad + '  #shadow-root'); for (const c of el.shadowRoot.children) render(c, depth + 2, out); }
    for (const c of el.children) render(c, depth + 1, out);
    return out;
  };

  const blocks = [];
  for (const h of hits) {
    const row = up(h, 4);
    blocks.push('════ ' + h.textContent.trim() + '  (row = <' + row.tagName.toLowerCase() + '>)\n'
                + render(row).join('\n'));
  }
  return blocks.join('\n\n') || 'no cell named ExtensionInstallForcelist / ExtensionSettings found';
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
        { expression: DUMP, returnByValue: true, awaitPromise: true }, sid);
    if (r?.result?.exceptionDetails)
        console.log('eval threw:', JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    const text = r?.result?.result?.value || '(empty)';
    fs.writeFileSync(path.join(__dirname, 'probe-edge-rows.txt'), text);
    console.log(text);
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch {}
    await sleep(1200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    process.exit(0);
})();

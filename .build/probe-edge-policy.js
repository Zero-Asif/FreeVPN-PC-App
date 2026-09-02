//  Read-only: read edge://policy out of Edge itself over DevTools, so we get
//  Edge's OWN verdict on each policy (accepted / ignored, and why) instead of
//  our registry read-back, which only proves the value survived the write.
//  Throwaway --user-data-dir; HKLM machine policy applies to it just the same.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 9334;
const HEADLESS = !process.argv.includes('--window');
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
    .find(p => fs.existsSync(p));
if (!EDGE) { console.log('msedge.exe not found'); process.exit(0); }

const tmp = path.join(os.tmpdir(), `fp-edge-cdp-${process.pid}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => {
    http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); }).on('error', rej);
});

const flags = [
    `--user-data-dir=${tmp}`, '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-gpu', `--remote-debugging-port=${PORT}`,
];
if (HEADLESS) flags.push('--headless=new');
else flags.push('--window-position=-32000,-32000', '--window-size=900,700');

const child = spawn(EDGE, flags, { detached: true, stdio: 'ignore', windowsHide: true });
child.unref();

const EXTRACT = `(() => {
  const out = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot);
      if (!el.children.length && el.textContent.trim()) out.push(el.textContent.trim());
    }
  };
  walk(document);
  return location.href + '\\n@@' + document.title + '@@\\n' + out.join('\\n');
})()`;

class Cdp {
    constructor(url) {
        this.ws = new WebSocket(url);
        this.id = 0; this.pending = new Map();
        this.ready = new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
        this.ws.onmessage = (e) => {
            const m = JSON.parse(e.data);
            if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
        };
    }
    send(method, params = {}, sessionId) {
        return new Promise(r => {
            const id = ++this.id;
            this.pending.set(id, r);
            this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
    }
}

(async () => {
    let ver = null;
    for (let i = 0; i < 60 && !ver; i++) {
        await sleep(500);
        try { ver = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/version`)); } catch {}
    }
    if (!ver) { console.log('DevTools never came up'); process.exit(0); }
    console.log(`${ver.Browser}   (headless: ${HEADLESS})`);

    const br = new Cdp(ver.webSocketDebuggerUrl);
    await br.ready;
    const t = await br.send('Target.createTarget', { url: 'edge://policy' });
    const targetId = t?.result?.targetId;
    const at = await br.send('Target.attachToTarget', { targetId, flatten: true });
    const sid = at?.result?.sessionId;
    console.log(`target ${targetId} session ${sid ? 'attached' : 'FAILED'}`);

    await br.send('Runtime.enable', {}, sid);
    await sleep(7000);
    const r = await br.send('Runtime.evaluate',
        { expression: EXTRACT, returnByValue: true, awaitPromise: true }, sid);
    const text = r?.result?.result?.value || '';
    if (r?.result?.exceptionDetails) console.log('eval threw:', JSON.stringify(r.result.exceptionDetails).slice(0, 300));

    fs.writeFileSync(path.join(__dirname, 'probe-edge-policy.txt'), text);
    const lines = text.split('\n');
    console.log(`\nurl: ${lines[0]}   title: ${(lines[1] || '').replace(/@@/g, '')}`);
    console.log(`${lines.length} text nodes -> .build/probe-edge-policy.txt\n`);

    let shown = 0;
    lines.forEach((l, i) => {
        if (/^Extension(Settings|InstallForcelist|InstallAllowlist)$/i.test(l)) {
            shown++;
            console.log(`── ${l}\n   ${lines.slice(i + 1, i + 8).join('\n   ')}\n`);
        }
    });
    if (!shown) {
        console.log('(no Extension* policy row on the page)');
        console.log(lines.slice(0, 40).join('\n'));
    }

    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch {}
    await sleep(1500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    process.exit(0);
})();

'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-d3b-bluedot.js  --  READ-ONLY, throwaway profile, no app.
//
//  D3 half B asks "after our correction the map shows NO PIN". probe-d3b-
//  pinforms.js measured that a bare /maps/@lat,lng,Nz draws no RED marker. But
//  the thing a "Your Location" click normally leaves behind is the BLUE dot,
//  not a red teardrop -- and the blue dot comes from navigator.geolocation,
//  which this extension's shim already answers with the connected country.
//
//  So: with geolocation GRANTED and OVERRIDDEN to the same coordinate the URL
//  is pinned at, does a fresh load of the bare-@ URL draw the blue dot on its
//  own, or only after the user clicks the crosshair again?
//
//    arm 1  load bare-@ 12z, permission granted, position overridden, no click
//    arm 2  same tab, then a click on the crosshair button at the bottom right
//
//  Writes ONLY into os.tmpdir() (the browser profile) and G:/tmp/d3b.
// ════════════════════════════════════════════════════════════════════
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 9347;
const SETTLE_MS = Number(process.env.FP_SETTLE || 16000);
const OUT = 'G:/tmp/d3b';

const browsers = require('../lib/browsers');
const cands = browsers.detectChromium();
const pick = cands.find(b => b.id === 'brave') || cands.find(b => b.id === 'chrome') || cands[0];
const EXE = pick && pick.exePath;
if (!EXE) { console.log('No Chromium browser detected -- nothing to measure'); process.exit(0); }

const P = { lat: 48.8566, lng: 2.3522 };
const URL = `https://www.google.com/maps/@${P.lat},${P.lng},12z`;

const tmp = path.join(fs.realpathSync.native(os.tmpdir()), `fp-d3bblue-${process.pid}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = u => new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); }).on('error', rej);
});

class Cdp {
    constructor(url) {
        this.ws = new WebSocket(url); this.id = 0; this.pending = new Map();
        this.ready = new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
        this.ws.onmessage = (e) => {
            const m = JSON.parse(e.data);
            if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
        };
    }
    send(method, params = {}, sessionId) {
        return new Promise((resolve, reject) => {
            const id = ++this.id;
            this.pending.set(id, m => {
                if (m.error) reject(new Error(method + ': ' + JSON.stringify(m.error)));
                else resolve(m);
            });
            this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
    }
}

//  Did the page ever ASK? The shim is not installed here, so the only way to
//  know the dot's provenance is to watch the call itself.
const HOOK = `(() => {
  window.__fpGeo = { current: 0, watch: 0 };
  const g = navigator.geolocation;
  if (!g) return 'no geolocation object';
  const c = g.getCurrentPosition.bind(g), w = g.watchPosition.bind(g);
  g.getCurrentPosition = function (...a) { window.__fpGeo.current++; return c(...a); };
  g.watchPosition = function (...a) { window.__fpGeo.watch++; return w(...a); };
  return 'hooked';
})()`;

const READ = `({ href: location.href, title: document.title,
                 geo: window.__fpGeo || null })`;

async function shot(br, sid, name) {
    const s = await br.send('Page.captureScreenshot', { format: 'png' }, sid);
    const p = path.join(OUT, name);
    fs.writeFileSync(p, Buffer.from(s.result.data, 'base64'));
    return p;
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const child = spawn(EXE, [
        `--user-data-dir=${tmp}`, '--no-first-run', '--no-default-browser-check',
        '--disable-sync', '--headless=new', '--window-size=1200,800',
        `--remote-debugging-port=${PORT}`, 'about:blank',
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();

    let ver = null;
    for (let i = 0; i < 60 && !ver; i++) {
        await sleep(500);
        try { ver = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/version`)); } catch (e) {}
    }
    if (!ver) { console.log('DevTools never came up'); process.exit(0); }
    const br = new Cdp(ver.webSocketDebuggerUrl); await br.ready;

    await br.send('Browser.grantPermissions',
        { origin: 'https://www.google.com', permissions: ['geolocation'] });

    const t = await br.send('Target.createTarget', { url: 'about:blank' });
    const tid = t.result.targetId;
    const at = await br.send('Target.attachToTarget', { targetId: tid, flatten: true });
    const sid = at.result.sessionId;
    await br.send('Page.enable', {}, sid);
    await br.send('Runtime.enable', {}, sid);
    await br.send('Emulation.setDeviceMetricsOverride',
        { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false }, sid);
    await br.send('Emulation.setGeolocationOverride',
        { latitude: P.lat, longitude: P.lng, accuracy: 20 }, sid);
    await br.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK }, sid);

    await br.send('Page.navigate', { url: URL }, sid);
    await sleep(SETTLE_MS);
    let r1 = {};
    try {
        const r = await br.send('Runtime.evaluate', { expression: READ, returnByValue: true }, sid);
        r1 = r?.result?.result?.value || {};
    } catch (e) { r1 = { error: e.message }; }
    const s1 = await shot(br, sid, 'blue-1-noclick.png');
    console.log('──── arm 1: bare-@ loaded, geolocation granted + overridden, NO click');
    console.log('   settled : ' + r1.href);
    console.log('   title   : ' + JSON.stringify(r1.title));
    console.log('   geolocation calls the PAGE made: ' + JSON.stringify(r1.geo));
    console.log('   shot    : ' + s1);

    //  The crosshair "Your location" button. Its aria-label is localised, so it
    //  is found by its jsaction/class rather than by text, and only clicked at
    //  the coordinates the page itself reports.
    const FIND = `(() => {
      const cand = [...document.querySelectorAll('button')]
        .map(b => ({ b, r: b.getBoundingClientRect(), al: b.getAttribute('aria-label') || '' }))
        .filter(o => o.r.width > 20 && o.r.width < 60 && o.r.height > 20 && o.r.height < 60 &&
                     o.r.right > innerWidth - 90 && o.r.bottom < innerHeight - 90 &&
                     o.r.bottom > innerHeight / 2);
      return cand.map(o => ({ x: Math.round(o.r.x + o.r.width / 2),
                              y: Math.round(o.r.y + o.r.height / 2),
                              al: o.al, id: o.b.id || '', cls: String(o.b.className).slice(0, 40) }));
    })()`;
    let found = [];
    try {
        const r = await br.send('Runtime.evaluate', { expression: FIND, returnByValue: true }, sid);
        found = r?.result?.result?.value || [];
    } catch (e) { found = [{ err: e.message }]; }
    console.log('\n   bottom-right buttons found: ' + JSON.stringify(found));

    const target = found[0];
    if (target && typeof target.x === 'number') {
        for (const type of ['mousePressed', 'mouseReleased']) {
            await br.send('Input.dispatchMouseEvent',
                { type, x: target.x, y: target.y, button: 'left', clickCount: 1 }, sid);
        }
        await sleep(9000);
    }
    let r2 = {};
    try {
        const r = await br.send('Runtime.evaluate', { expression: READ, returnByValue: true }, sid);
        r2 = r?.result?.result?.value || {};
    } catch (e) { r2 = { error: e.message }; }
    const s2 = await shot(br, sid, 'blue-2-clicked.png');
    console.log('\n──── arm 2: same tab, crosshair clicked at ' + JSON.stringify(target));
    console.log('   settled : ' + r2.href);
    console.log('   geolocation calls the PAGE made: ' + JSON.stringify(r2.geo));
    console.log('   shot    : ' + s2);
    console.log('\nbrowser : ' + pick.name + '  ' + (ver.Browser || ''));

    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch (e) {}
    await sleep(1200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
})().catch(e => { console.log('probe failed: ' + e.message); process.exit(1); });

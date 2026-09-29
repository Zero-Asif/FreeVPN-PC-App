'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-d3b-renav.js  --  READ-ONLY, throwaway profile, no app.
//
//  THE PRODUCTION SHAPE of D3 half B, with no extension and no app:
//  a Maps tab sitting on country A, then the SAME TAB renavigated to the
//  bare-@ URL for country B -- which is exactly what mapsNavFix() +
//  chrome.tabs.update(tabId,{url}) do at Extension/background.js:1132/1150.
//
//  probe-d3b-bluedot.txt already measured that a FIRST load of a bare-@ URL
//  draws the blue "your location" dot on its own (the page calls
//  getCurrentPosition once, unprompted). What is still unmeasured is whether
//  the dot survives -- or returns after -- the cross-document renavigation our
//  correction performs. That is the difference between "a bare-@ URL cannot
//  show a location" and "ours does not, for some other reason".
//
//  Writes ONLY into os.tmpdir() and G:/tmp/d3b.
// ════════════════════════════════════════════════════════════════════
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 9348;
const SETTLE_MS = Number(process.env.FP_SETTLE || 16000);
const OUT = 'G:/tmp/d3b';

const browsers = require('../lib/browsers');
const cands = browsers.detectChromium();
const pick = cands.find(b => b.id === 'brave') || cands.find(b => b.id === 'chrome') || cands[0];
const EXE = pick && pick.exePath;
if (!EXE) { console.log('No Chromium browser detected -- nothing to measure'); process.exit(0); }

const A = { cc: 'LU', lat: 49.6116, lng: 6.1319 };
const B = { cc: 'NL', lat: 52.3676, lng: 4.9041 };
const url = p => `https://www.google.com/maps/@${p.lat},${p.lng},12z`;

const tmp = path.join(fs.realpathSync.native(os.tmpdir()), `fp-d3bren-${process.pid}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = u => new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); }).on('error', rej);
});

class Cdp {
    constructor(u) {
        this.ws = new WebSocket(u); this.id = 0; this.pending = new Map();
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

//  Record not just THAT the page asked but WHEN, and with what timeout: a short
//  timeout is the difference between a shim that answers and a dot that appears.
const HOOK = `(() => {
  window.__fpGeo = { calls: [], t0: Date.now() };
  const g = navigator.geolocation;
  if (!g) return;
  const c = g.getCurrentPosition.bind(g), w = g.watchPosition.bind(g);
  const note = (kind, ok, err, opt) => {
    const at = Date.now() - window.__fpGeo.t0;
    const rec = { kind, at, opt: opt ? JSON.parse(JSON.stringify(opt)) : null, answeredMs: null, error: null };
    window.__fpGeo.calls.push(rec);
    return [p => { rec.answeredMs = Date.now() - window.__fpGeo.t0 - at;
                   rec.got = [p.coords.latitude, p.coords.longitude]; if (ok) ok(p); },
            e => { rec.error = e && e.code; if (err) err(e); }];
  };
  g.getCurrentPosition = function (ok, err, opt) { const [a, b] = note('current', ok, err, opt); return c(a, b, opt); };
  g.watchPosition = function (ok, err, opt) { const [a, b] = note('watch', ok, err, opt); return w(a, b, opt); };
})()`;

const READ = `({ href: location.href, title: document.title, geo: window.__fpGeo || null })`;

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
    await br.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK }, sid);

    async function arm(label, place, name) {
        await br.send('Emulation.setGeolocationOverride',
            { latitude: place.lat, longitude: place.lng, accuracy: 20 }, sid);
        await br.send('Page.navigate', { url: url(place) }, sid);
        await sleep(SETTLE_MS);
        let r = {};
        try {
            const e = await br.send('Runtime.evaluate', { expression: READ, returnByValue: true }, sid);
            r = e?.result?.result?.value || {};
        } catch (e) { r = { error: e.message }; }
        const s = await br.send('Page.captureScreenshot', { format: 'png' }, sid);
        fs.writeFileSync(path.join(OUT, name), Buffer.from(s.result.data, 'base64'));
        console.log(`──── ${label}`);
        console.log('   asked   : ' + url(place));
        console.log('   settled : ' + r.href);
        console.log('   the page\'s own geolocation calls: ' + JSON.stringify(r.geo && r.geo.calls));
        console.log('   shot    : ' + path.join(OUT, name));
        console.log('');
    }

    await arm('1. first load, country A (LU) -- the tab the user is on', A, 'renav-1-A.png');
    //  THE CORRECTION. Same tab, cross-document navigation to the bare-@ URL for
    //  country B: byte-for-byte what chrome.tabs.update(tabId, {url: next}) does.
    await arm('2. SAME TAB renavigated to the bare-@ URL for country B (NL)', B, 'renav-2-B.png');

    console.log('browser : ' + pick.name + '  ' + (ver.Browser || ''));
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch (e) {}
    await sleep(1200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
})().catch(e => { console.log('probe failed: ' + e.message); process.exit(1); });

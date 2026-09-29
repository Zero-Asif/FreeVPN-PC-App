'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-d3b-pinforms.js  --  READ-ONLY, throwaway profile, no app.
//
//  D3 half B: after our nav-time correction the map shows NO PIN. Every maps
//  probe already in this repo (probe-maps-repin.txt, probe-maps-repin2.txt,
//  probe-maps-uule*.txt, probe-maps-cache.txt) decides its VERDICT purely from
//  the /@lat,lng in the SETTLED URL -- see probe-maps-repin.js:105-114 and
//  probe-maps-uule2.js:98-105. None of them ever asked whether a MARKER was
//  drawn. So that question is unmeasured, and this probe measures it.
//
//  Two independent readings per URL form, because Maps draws its marker on a
//  WebGL canvas where no DOM node names it:
//    1. DOM/URL/title state -- did Maps enter its "a place is selected" mode
//       (URL settles to /maps/place/..., title becomes the place, the left
//       panel gains a role=main with an aria-label, the searchbox fills)?
//    2. a screenshot, scored separately by probe-d3b-redpin.py: Google's
//       marker is red, the map is not, so red pixels near the centre are the
//       marker itself.
//
//  Writes ONLY into os.tmpdir() (the browser profile) and G:/tmp/d3b (the
//  screenshots + summary). Nothing in the repo is touched.
// ════════════════════════════════════════════════════════════════════
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 9346;
const SETTLE_MS = Number(process.env.FP_SETTLE || 16000);
const OUT = 'G:/tmp/d3b';

const browsers = require('../lib/browsers');
const cands = browsers.detectChromium();
const pick = cands.find(b => b.id === 'brave') || cands.find(b => b.id === 'chrome') || cands[0];
const EXE = pick && pick.exePath;
if (!EXE) { console.log('No Chromium browser detected -- nothing to measure'); process.exit(0); }

const P = { lat: 48.8566, lng: 2.3522 };            // Paris: far from this machine
const C = P.lat + ',' + P.lng;

const tmp = path.join(fs.realpathSync.native(os.tmpdir()), `fp-d3b-${process.pid}`);
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

//  Every reading is a fact about the page, not a judgement.
const DUMP = `(() => {
  const q = s => document.querySelectorAll(s).length;
  const mains = [...document.querySelectorAll('[role="main"]')]
      .map(e => e.getAttribute('aria-label') || '(no aria-label)');
  const sb = document.querySelector('#searchboxinput');
  return {
    href: location.href,
    title: document.title,
    mains: mains,
    searchbox: sb ? String(sb.value || '') : '(no #searchboxinput)',
    canvases: q('canvas'),
    directionsBtn: q('[data-value="Directions"]') + q('button[aria-label^="Directions"]'),
    closeBtn: q('button[aria-label^="Close"]'),
    imgPin: q('img[src*="spotlight-poi"]') + q('img[src*="marker"]'),
    bodyLen: document.body ? document.body.innerHTML.length : 0
  };
})()`;

const FORMS = [
    ['A bare-@ 12z  (WHAT WE SHIP AT NAV TIME)',
     `https://www.google.com/maps/@${C},12z`],
    ['B search api=1 query=LAT,LNG',
     `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(C)}`],
    ['C legacy /maps?q=LAT,LNG',
     `https://www.google.com/maps?q=${encodeURIComponent(C)}`],
    ['D /maps/place/LAT,LNG/@LAT,LNG,17z',
     `https://www.google.com/maps/place/${encodeURIComponent(C)}/@${C},17z`],
    ['E /maps/place/LAT,LNG/@LAT,LNG,12z (zoom carried)',
     `https://www.google.com/maps/place/${encodeURIComponent(C)}/@${C},12z`],
    ['F /maps/search/LAT,LNG/@LAT,LNG,12z',
     `https://www.google.com/maps/search/${encodeURIComponent(C)}/@${C},12z`],
    ['G bare-@ 12z with a ?q= tail',
     `https://www.google.com/maps/@${C},12z?q=${encodeURIComponent(C)}`],
    ['H api=1 map_action=map (official viewport form)',
     `https://www.google.com/maps/@?api=1&map_action=map&center=${encodeURIComponent(C)}&zoom=12`],
];

async function arm(br, tag, url, i) {
    const t = await br.send('Target.createTarget', { url: 'about:blank' });
    const tid = t.result.targetId;
    const at = await br.send('Target.attachToTarget', { targetId: tid, flatten: true });
    const sid = at.result.sessionId;
    await br.send('Page.enable', {}, sid);
    await br.send('Runtime.enable', {}, sid);
    await br.send('Emulation.setDeviceMetricsOverride',
        { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false }, sid);
    await br.send('Page.navigate', { url }, sid);
    await sleep(SETTLE_MS);
    let dump = { error: null };
    try {
        const r = await br.send('Runtime.evaluate',
            { expression: DUMP, returnByValue: true, awaitPromise: false }, sid);
        dump = r?.result?.result?.value || { error: 'no value' };
    } catch (e) { dump = { error: e.message }; }
    let shot = null;
    try {
        const s = await br.send('Page.captureScreenshot', { format: 'png' }, sid);
        shot = path.join(OUT, `form-${String(i).padStart(2, '0')}.png`);
        fs.writeFileSync(shot, Buffer.from(s.result.data, 'base64'));
    } catch (e) { shot = 'capture failed: ' + e.message; }
    try { await br.send('Target.closeTarget', { targetId: tid }); } catch (e) {}
    return { tag, url, shot, ...dump };
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

    const runs = [];
    for (let i = 0; i < FORMS.length; i++) {
        const [tag, url] = FORMS[i];
        let r;
        try { r = await arm(br, tag, url, i); }
        catch (e) { r = { tag, url, error: e.message }; }
        runs.push(r);
        console.log(`──── ${tag}`);
        console.log('   asked   : ' + url);
        console.log('   settled : ' + (r.href || '(none)'));
        console.log('   title   : ' + JSON.stringify(r.title));
        console.log('   role=main aria-labels : ' + JSON.stringify(r.mains));
        console.log('   searchbox value       : ' + JSON.stringify(r.searchbox));
        console.log('   canvases=' + r.canvases + '  directionsBtn=' + r.directionsBtn +
                    '  closeBtn=' + r.closeBtn + '  imgPin=' + r.imgPin +
                    '  bodyLen=' + r.bodyLen);
        console.log('   shot    : ' + r.shot);
        if (r.error) console.log('   ERROR   : ' + r.error);
        console.log('');
    }

    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({
        browser: pick.name, exe: EXE, version: ver.Browser, settleMs: SETTLE_MS,
        target: P, runs,
    }, null, 2));
    console.log('browser : ' + pick.name + '  ' + (ver.Browser || ''));
    console.log('summary : ' + path.join(OUT, 'summary.json'));

    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch (e) {}
    await sleep(1200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
})().catch(e => { console.log('probe failed: ' + e.message); process.exit(1); });

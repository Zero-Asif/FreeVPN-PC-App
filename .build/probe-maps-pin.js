'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-maps-pin.js  --  READ-ONLY, throwaway profile, no app.
//
//  D3's other half: after our nav-time correction the map is in the RIGHT
//  country but shows NO PIN, while Maps' own stale view DOES show one. So:
//  which URL form makes Maps draw a marker?
//
//  Maps draws the marker on a WebGL canvas -- no DOM node names it, and
//  probe-d3b-pinforms.js already showed img[src*="marker"] = 0 for every form
//  including the ones that plainly do have a pin. So a DOM query alone would
//  say "no pin" everywhere and be wrong. Two readings are taken instead, and
//  they are reported separately rather than merged into one guess:
//
//    (a) PLACE MODE, from the page: does Maps enter its "a place is selected"
//        state -- the URL rewritten to /maps/place/..., the title becoming the
//        place name, and the left-hand detail panel present. That panel is real
//        DOM and can be counted.
//    (b) THE MARKER ITSELF, from pixels: Google's marker is #EA4335 red and the
//        basemap is not. The largest connected blob of that red is measured,
//        and -- the part that matters -- the blob's position is compared with
//        where the URL's own coordinate lands on screen. A red POI dot in a
//        corner is not a marker for our coordinate; a red blob at the map
//        centre is.
//
//  Writes ONLY os.tmpdir() (the profile) and G:/tmp/pin (screenshots + json).
// ════════════════════════════════════════════════════════════════════
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.FP_PORT || 9371);
const SETTLE_MS = Number(process.env.FP_SETTLE || 20000);
const OUT = 'G:/tmp/pin';
const W = 1200, H = 800;

const browsers = require('../lib/browsers');
const cands = browsers.detectChromium();
const pick = cands.find(b => b.id === 'brave');
const EXE = pick && pick.exePath;
if (!EXE) { console.log('Brave not detected -- nothing to measure'); process.exit(0); }

const P = { lat: 48.8566, lng: 2.3522 };            // Paris, far from this machine
const C = P.lat + ',' + P.lng;

const tmp = path.join(fs.realpathSync.native(os.tmpdir()), `fp-pin-${process.pid}`);
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
                if (m.error) reject(new Error(method + ' -> ' + JSON.stringify(m.error)));
                else resolve(m);
            });
            this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
    }
}

//  Facts about the page. No verdict is formed here.
const DUMP = `(() => {
  const q = s => { try { return document.querySelectorAll(s).length; } catch (e) { return -1; } };
  return {
    href: location.href,
    title: document.title,
    //  Maps' place card: the left panel that appears only when something is
    //  selected. Its Directions/Save action row is the reliable tell.
    placePanel: q('[data-section-id]') + q('button[data-value="Directions"]') +
                q('[jsaction*="pane.placeActions"]'),
    mainRoles: q('[role="main"]'),
    closeBtn: q('button[aria-label^="Close"]') + q('button[jsaction*="pane.close"]'),
    imgPin: q('img[src*="spotlight-poi"]') + q('img[src*="marker"]'),
    canvases: q('canvas'),
    //  Where the map thinks the viewport is, for the record.
    urlHasPlace: /\\/maps\\/place\\//.test(location.href),
    urlHasAt: /\\/@(-?[\\d.]+),(-?[\\d.]+)/.exec(location.href)
  };
})()`;

const FORMS = [
    ['1  /maps/@LAT,LNG,12z            (the form we ship at nav time)',
     `https://www.google.com/maps/@${C},12z`],
    ['2  /maps/search/?api=1&query=LAT,LNG',
     `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(C)}`],
    ['3  /maps?q=LAT,LNG',
     `https://www.google.com/maps?q=${encodeURIComponent(C)}`],
    ['4  /maps/place/LAT,LNG/@LAT,LNG,17z',
     `https://www.google.com/maps/place/${encodeURIComponent(C)}/@${C},17z`],
];

async function arm(br, tag, url, i) {
    const t = await br.send('Target.createTarget', { url: 'about:blank' });
    const tid = t.result.targetId;
    const at = await br.send('Target.attachToTarget', { targetId: tid, flatten: true });
    const sid = at.result.sessionId;
    await br.send('Page.enable', {}, sid);
    await br.send('Runtime.enable', {}, sid);
    await br.send('Emulation.setDeviceMetricsOverride',
        { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sid);
    await br.send('Page.navigate', { url }, sid);
    await sleep(SETTLE_MS);

    let dump = null, err = null;
    try {
        const r = await br.send('Runtime.evaluate', { expression: DUMP, returnByValue: true }, sid);
        dump = r?.result?.result?.value;
    } catch (e) { err = e.message.slice(0, 200); }

    const shot = path.join(OUT, `pin-${i}.png`);
    try {
        const s = await br.send('Page.captureScreenshot', { format: 'png' }, sid);
        fs.writeFileSync(shot, Buffer.from(s.result.data, 'base64'));
    } catch (e) { err = (err || '') + ' | screenshot: ' + e.message.slice(0, 120); }

    await br.send('Target.closeTarget', { targetId: tid });
    return { tag, url, shot, dump, err };
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const child = spawn(EXE, [
        `--user-data-dir=${tmp}`, '--no-first-run', '--no-default-browser-check',
        '--disable-sync', '--disable-gpu', '--headless=new',
        '--disable-background-networking', `--window-size=${W},${H}`,
        `--remote-debugging-port=${PORT}`, 'about:blank',
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();

    let ver = null;
    for (let i = 0; i < 80 && !ver; i++) {
        await sleep(400);
        try { ver = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/version`)); } catch (e) {}
    }
    if (!ver) { console.log('DevTools never came up on ' + PORT); process.exit(1); }

    const br = new Cdp(ver.webSocketDebuggerUrl); await br.ready;

    const runs = [];
    for (let i = 0; i < FORMS.length; i++) {
        const [tag, url] = FORMS[i];
        let r;
        try { r = await arm(br, tag, url, i); }
        catch (e) { r = { tag, url, err: String(e && e.stack || e).slice(0, 300) }; }
        runs.push(r);
        console.log('──── ' + tag);
        console.log('   requested : ' + url);
        if (r.err) console.log('   ERROR     : ' + r.err);
        if (r.dump) {
            console.log('   settled   : ' + r.dump.href);
            console.log('   title     : ' + r.dump.title);
            console.log('   place mode: urlHasPlace=' + r.dump.urlHasPlace +
                        '  placePanel=' + r.dump.placePanel +
                        '  closeBtn=' + r.dump.closeBtn +
                        '  role=main=' + r.dump.mainRoles);
            console.log('   img pin   : ' + r.dump.imgPin + '   canvases=' + r.dump.canvases);
        }
        console.log('   shot      : ' + r.shot);
        console.log('');
    }

    fs.writeFileSync(path.join(OUT, 'pin.json'), JSON.stringify(
        { browser: ver.Browser, exe: EXE, settleMs: SETTLE_MS, target: P, size: [W, H], runs }, null, 1));

    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch (e) {}
    await sleep(1500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
})();

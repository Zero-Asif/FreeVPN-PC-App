'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-maps-cache.js  --  READ-ONLY measurement, temp profile
//
//  The question this answers: when the reported position CHANGES between two
//  visits, does Google Maps still show the FIRST one -- and if it does, where
//  is that first one being kept?
//
//  Method: one Brave, one throwaway profile, two visits to google.com/maps.
//  Visit 1 with the geolocation override set to country A, visit 2 with it set
//  to country B. Nothing else differs, and the profile is shared between the
//  two visits, so anything that survives is Maps' own stored state.
//
//  After each visit we record:
//    * the URL Maps rewrote itself to -- it puts /@lat,lng,zoom there, so this
//      is the map's actual centre, not an inference
//    * every localStorage key for the origin, and any that contains a number
//      pair that looks like the coordinates we handed it
//    * the IndexedDB database names
//
//  No app state is touched: the profile is a fresh directory under TEMP and is
//  removed at the end.
// ════════════════════════════════════════════════════════════════════
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 9338;
const browsers = require('../lib/browsers');
const brave = browsers.detectChromium().find(b => b.id === 'brave');
const EXE = brave && brave.exePath;
if (!EXE) { console.log('Brave not detected -- nothing to measure'); process.exit(0); }

const A = { cc: 'LU', label: 'Luxembourg', lat: 49.6116, lng: 6.1319 };
const B = { cc: 'NL', label: 'Amsterdam',  lat: 52.3676, lng: 4.9041 };

const tmp = path.join(os.tmpdir(), `fp-maps-${process.pid}`);
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
        return new Promise(r => {
            const id = ++this.id; this.pending.set(id, r);
            this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
    }
}

//  Runs in the page. Reports what the origin has stored, plus which of the two
//  coordinate pairs (if either) can be found in it.
const DUMP = (a, b) => String.raw`(async () => {
  const near = (v, t) => Math.abs(v - t) < 0.5;
  const hitsFor = (s, lat, lng) => {
    //  any number pair in the blob that lands within ~55 km of the target
    const nums = String(s).match(/-?\d{1,3}\.\d{3,}/g) || [];
    for (let i = 0; i < nums.length - 1; i++)
      if (near(+nums[i], lat) && near(+nums[i + 1], lng)) return true;
    for (let i = 0; i < nums.length - 1; i++)
      if (near(+nums[i], lng) && near(+nums[i + 1], lat)) return true;
    return false;
  };
  const ls = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i), v = localStorage.getItem(k) || '';
      ls.push({ k, len: v.length, head: v.slice(0, 160),
                hasA: hitsFor(v, ${a.lat}, ${a.lng}), hasB: hitsFor(v, ${b.lat}, ${b.lng}) });
    }
  } catch (e) { ls.push({ k: 'THREW', head: String(e) }); }
  let dbs = [];
  try { dbs = (await indexedDB.databases()).map(d => d.name + '@v' + d.version); } catch (e) { dbs = ['THREW ' + e]; }
  let ss = [];
  try { for (let i = 0; i < sessionStorage.length; i++) ss.push(sessionStorage.key(i)); } catch (e) {}
  return { url: location.href, title: document.title, ls, dbs, ss,
           cookieNames: (document.cookie || '').split(';').map(c => c.split('=')[0].trim()).filter(Boolean) };
})()`;

async function visit(br, sid, where, tag) {
    await br.send('Emulation.setGeolocationOverride', {
        latitude: where.lat, longitude: where.lng, accuracy: 20,
    }, sid);
    await br.send('Page.navigate', { url: 'https://www.google.com/maps' }, sid);
    //  Maps rewrites its own URL a few seconds after it settles; 25 s is well
    //  clear of that on a cold profile.
    await sleep(25000);
    const r = await br.send('Runtime.evaluate',
        { expression: DUMP(A, B), returnByValue: true, awaitPromise: true }, sid);
    if (r?.result?.exceptionDetails)
        return { tag, error: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
    return { tag, override: where, ...(r?.result?.result?.value || {}) };
}

function report(v) {
    const L = [];
    L.push(`──── ${v.tag}  (override = ${v.override ? v.override.label + ' ' + v.override.lat + ',' + v.override.lng : '?'})`);
    if (v.error) { L.push('  eval threw: ' + v.error); return L.join('\n'); }
    L.push('  url        : ' + v.url);
    L.push('  title      : ' + v.title);
    L.push('  idb        : ' + (v.dbs.length ? v.dbs.join(', ') : 'none'));
    L.push('  cookies    : ' + (v.cookieNames.length ? v.cookieNames.join(', ') : 'none visible to JS'));
    L.push(`  localStorage: ${v.ls.length} key(s)`);
    for (const e of v.ls) {
        const mark = (e.hasA ? ' <<A' : '') + (e.hasB ? ' <<B' : '');
        L.push(`    ${e.k}  (${e.len}b)${mark}`);
        L.push('        ' + String(e.head).replace(/\s+/g, ' '));
    }
    L.push('  sessionStorage: ' + (v.ss.length ? v.ss.join(', ') : 'none'));
    return L.join('\n');
}

(async () => {
    const child = spawn(EXE, [
        `--user-data-dir=${tmp}`, '--no-first-run', '--no-default-browser-check',
        '--disable-sync', '--disable-gpu', '--headless=new',
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
    //  Grant geolocation up front: a headless browser auto-DENIES the prompt,
    //  and a denied permission would make both visits look identical for the
    //  wrong reason.
    await br.send('Browser.grantPermissions',
        { origin: 'https://www.google.com', permissions: ['geolocation'] });

    const t  = await br.send('Target.createTarget', { url: 'about:blank' });
    const at = await br.send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
    const sid = at.result.sessionId;
    await br.send('Page.enable', {}, sid);
    await br.send('Runtime.enable', {}, sid);

    const out = [];
    out.push(report(await visit(br, sid, A, 'VISIT 1 -- first country')));
    out.push(report(await visit(br, sid, B, 'VISIT 2 -- switched country, same profile')));

    const text = out.join('\n\n') + '\n';
    fs.writeFileSync(path.join(__dirname, 'probe-maps-cache.txt'), text);
    console.log(text);

    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch (e) {}
    await sleep(1200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
})();

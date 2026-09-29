'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-maps-carrier.js  --  READ-ONLY measurement, temp profiles.
//
//  THE QUESTION. After a country switch, Google Maps replays the PREVIOUS
//  country. probe-maps-cache.js proved that happens with no extension and no
//  app running, so the carrier is something the profile keeps. This probe
//  eliminates the candidates one at a time.
//
//  WHY A NEW PROBE AND NOT A RE-READ OF probe-maps-uule2.txt. That file's arm 3
//  says "UULE deleted first" and then, on its own next line,
//  "(UULE still present after delete: 1)". The delete never landed: the probe
//  called Storage.deleteCookies, and there IS no Storage.deleteCookies in the
//  protocol -- the cookie deleter is Network.deleteCookies. Its send() resolved
//  on protocol errors instead of rejecting, so the {"error":{"code":-32601,
//  "message":"'Storage.deleteCookies' wasn't found"}} reply was read as
//  success. So "clearing UULE does not help" was never measured. Here send()
//  REJECTS on m.error, the deleter is Network.deleteCookies, and the jar is
//  printed before and after every intervention so a no-op cannot pass as one.
//
//  METHOD. One arm per run, each in its OWN fresh profile under TEMP and its
//  own browser process, each on its own debugging port:
//     visit A (country A) -> intervention -> visit B (country B)
//  A FRESH TAB per visit, because Chromium hands a subscriber the position it
//  already acquired and a reused tab would keep reporting A for the wrong
//  reason (that confound is documented at probe-maps-uule2.js:5-11).
//
//  Arms:
//     control                 nothing removed          (must reproduce)
//     clear-UULE              only the UULE cookie
//     clear-STRP              only __Secure-STRP
//     clear-all-google-cookies  every google.* cookie
//     clear-localstorage-only localStorage+IDB+CacheStorage, cookies kept
//
//  Nothing outside os.tmpdir() and G:/tmp/carrier is written. The user's real
//  browser profile is never opened.
// ════════════════════════════════════════════════════════════════════
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const BASE_PORT = Number(process.env.FP_PORT || 9351);
const SETTLE_MS = Number(process.env.FP_SETTLE || 25000);
const OUT = 'G:/tmp/carrier';

const browsers = require('../lib/browsers');
const cands = browsers.detectChromium();
const pick = cands.find(b => b.id === 'brave');
const EXE = pick && pick.exePath;
if (!EXE) {
    console.log('Brave not detected -- nothing to measure. Detected: ' +
        JSON.stringify(cands.map(c => c.id)));
    process.exit(0);
}

//  A and B are far apart and both far from this machine's own IP city, so a
//  verdict can never be an accident of proximity.
const A = { cc: 'LU', label: 'Luxembourg', lat: 49.6116, lng: 6.1319 };
const B = { cc: 'NL', label: 'Amsterdam',  lat: 52.3676, lng: 4.9041 };

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
    //  REJECTS on a protocol error. The whole point of this probe is that the
    //  previous one did not.
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

//  UULE is `<prefix>+<base64 of a plain list>`; element 5 is [lat*1e7, lng*1e7].
function readUule(value) {
    if (!value) return '(absent)';
    const b64 = String(value).replace(/^[^+]*\+/, '').replace(/-/g, '+').replace(/_/g, '/');
    let txt = '';
    try { txt = Buffer.from(b64, 'base64').toString('utf8'); } catch (e) { return 'undecodable'; }
    const m = /\[(-?\d{6,10}),\s*(-?\d{6,10})\]/.exec(txt);
    if (!m) return 'no coord pair in: ' + txt.slice(0, 70);
    const lat = +m[1] / 1e7, lng = +m[2] / 1e7;
    const near = t => Math.abs(lat - t.lat) < 0.6 && Math.abs(lng - t.lng) < 0.6;
    const who = near(A) ? '= A ' + A.label : near(B) ? '= B ' + B.label : '= neither';
    return lat.toFixed(4) + ',' + lng.toFixed(4) + ' ' + who;
}

function centre(url) {
    const m = /\/@(-?\d+\.\d+),(-?\d+\.\d+)(?:,([\d.]+z))?/.exec(url || '');
    return m ? { lat: +m[1], lng: +m[2], z: m[3] || '?' } : null;
}
function whose(url) {
    const c = centre(url);
    if (!c) return 'NO /@ IN THE URL -- ' + String(url).slice(0, 110);
    const near = t => Math.abs(c.lat - t.lat) < 0.6 && Math.abs(c.lng - t.lng) < 0.6;
    if (near(A)) return `A = ${A.label} -- THE PREVIOUS COUNTRY REPLAYED   (${c.lat},${c.lng},${c.z})`;
    if (near(B)) return `B = ${B.label} -- correct, the current country    (${c.lat},${c.lng},${c.z})`;
    return `neither -- this machine's own IP city                (${c.lat},${c.lng},${c.z})`;
}

async function allCookies(br) {
    const r = await br.send('Storage.getCookies', {});
    return r?.result?.cookies || [];
}
function jarLines(cookies) {
    if (!cookies.length) return ['      (empty)'];
    return cookies.map(c =>
        `      ${c.name.padEnd(18)} dom=${String(c.domain).padEnd(16)} path=${c.path} ` +
        `len=${String(c.value || '').length}` +
        (c.name === 'UULE' ? '   ->  ' + readUule(c.value) : ''));
}

//  Delete one cookie for real. Tries the exact (name,domain,path) the jar
//  reported first; if the cookie survives, tries the url form and the
//  dot-flipped domain, and reports which variant actually removed it. Nothing
//  is claimed that a re-read did not confirm.
async function deleteCookie(br, sid, c) {
    const host = String(c.domain || '').replace(/^\./, '');
    const url = (c.secure ? 'https://' : 'http://') + host + (c.path || '/');
    const tries = [
        ['name+domain+path', { name: c.name, domain: c.domain, path: c.path }],
        ['name+url',         { name: c.name, url }],
        ['name+dotflipped',  { name: c.name, domain: (String(c.domain).startsWith('.') ? host : '.' + host), path: c.path }],
        ['name only',        { name: c.name }],
    ];
    for (const [label, params] of tries) {
        try { await br.send('Network.deleteCookies', params, sid); }
        catch (e) { return { name: c.name, domain: c.domain, via: label + ' THREW ' + e.message.slice(0, 120), gone: false }; }
        const left = (await allCookies(br)).some(x =>
            x.name === c.name && x.domain === c.domain && x.path === c.path);
        if (!left) return { name: c.name, domain: c.domain, via: label, gone: true };
    }
    return { name: c.name, domain: c.domain, via: 'ALL FOUR FORMS FAILED', gone: false };
}

async function newTab(br, where) {
    const t = await br.send('Target.createTarget', { url: 'about:blank' });
    const tid = t.result.targetId;
    const at = await br.send('Target.attachToTarget', { targetId: tid, flatten: true });
    const sid = at.result.sessionId;
    await br.send('Page.enable', {}, sid);
    await br.send('Runtime.enable', {}, sid);
    await br.send('Network.enable', {}, sid);
    if (where) {
        await br.send('Emulation.setGeolocationOverride',
            { latitude: where.lat, longitude: where.lng, accuracy: 20 }, sid);
    }
    return { tid, sid };
}

async function href(br, sid) {
    try {
        const r = await br.send('Runtime.evaluate',
            { expression: 'location.href', returnByValue: true }, sid);
        return r?.result?.result?.value || '(none)';
    } catch (e) { return 'EVAL THREW ' + e.message.slice(0, 90); }
}

//  visit: fresh tab, override set BEFORE the navigation, samples of the URL as
//  Maps settles so a slow settle cannot be mistaken for a different answer.
async function visit(br, where, keepOpen) {
    const { tid, sid } = await newTab(br, where);
    await br.send('Page.navigate', { url: 'https://www.google.com/maps' }, sid);
    const marks = [6000, 12000, 18000, SETTLE_MS];
    const samples = [];
    let last = 0;
    for (const m of marks) {
        await sleep(Math.max(0, m - last)); last = m;
        samples.push({ t: m, href: await href(br, sid) });
    }
    let lsCount = -1;
    try {
        const r = await br.send('Runtime.evaluate',
            { expression: '(()=>{try{return localStorage.length}catch(e){return -2}})()',
              returnByValue: true }, sid);
        lsCount = r?.result?.result?.value;
    } catch (e) {}
    const url = samples[samples.length - 1].href;
    if (!keepOpen) await br.send('Target.closeTarget', { targetId: tid });
    return { url, samples, lsCount, tid, sid };
}

async function launch(port, tmp) {
    const child = spawn(EXE, [
        `--user-data-dir=${tmp}`, '--no-first-run', '--no-default-browser-check',
        '--disable-sync', '--disable-gpu', '--headless=new',
        '--disable-background-networking',
        `--remote-debugging-port=${port}`, 'about:blank',
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    let ver = null;
    for (let i = 0; i < 80 && !ver; i++) {
        await sleep(400);
        try { ver = JSON.parse(await get(`http://127.0.0.1:${port}/json/version`)); } catch (e) {}
    }
    return { child, ver };
}

function kill(child, tmp) {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch (e) {}
    setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }, 1500);
}

async function runArm(name, index) {
    const port = BASE_PORT + index;
    const tmp = path.join(fs.realpathSync.native(os.tmpdir()), `fp-carrier-${process.pid}-${index}`);
    const L = [];
    L.push('═══════════════════════════════════════════════════════════════');
    L.push(`ARM  ${name}      port ${port}   profile ${tmp}`);
    L.push('═══════════════════════════════════════════════════════════════');

    const { child, ver } = await launch(port, tmp);
    if (!ver) { L.push('  DevTools never came up on this port -- arm not measured'); return L.join('\n'); }
    L.push('  browser    : ' + ver.Browser + '   ' + ver['User-Agent'].replace(/^.*?(Chrome\/[\d.]+).*$/, '$1'));

    const br = new Cdp(ver.webSocketDebuggerUrl); await br.ready;
    await br.send('Browser.grantPermissions',
        { origin: 'https://www.google.com', permissions: ['geolocation'] });

    //  ── visit A ────────────────────────────────────────────────────
    //  These two arms reach back into visit A's own tab afterwards -- one to
    //  re-read localStorage without issuing a request, one to clear from
    //  inside the origin -- so that tab must stay open past the visit.
    const keepA = (name === 'clear-localstorage-only' || name === 'clear-localstorage-js');
    const va = await visit(br, A, keepA);
    L.push('');
    L.push(`  VISIT A  override = ${A.label} ${A.lat},${A.lng}`);
    for (const s of va.samples) L.push(`     t=${String(s.t).padStart(5)}ms  ${s.href}`);
    L.push('     settled -> ' + whose(va.url));
    L.push('     localStorage keys after visit A: ' + va.lsCount);

    //  ── the jar as it stands, before anything is removed ───────────
    const before = await allCookies(br);
    L.push('');
    L.push(`  JAR BEFORE the intervention  (${before.length} cookie(s))`);
    L.push(...jarLines(before));

    //  ── the intervention ───────────────────────────────────────────
    const { sid: wsid } = await newTab(br, null);          // a worker tab for Network.*
    const acts = [];
    if (name === 'control') {
        acts.push('nothing removed -- this arm exists to prove the harness still reproduces');
    } else if (name === 'clear-UULE') {
        const t = before.filter(c => c.name === 'UULE');
        if (!t.length) acts.push('no UULE cookie in the jar to delete');
        for (const c of t) { const r = await deleteCookie(br, wsid, c);
            acts.push(`delete UULE @${r.domain}: ${r.gone ? 'GONE via ' + r.via : 'STILL THERE (' + r.via + ')'}`); }
    } else if (name === 'clear-STRP') {
        const t = before.filter(c => c.name === '__Secure-STRP');
        if (!t.length) acts.push('no __Secure-STRP cookie in the jar to delete');
        for (const c of t) { const r = await deleteCookie(br, wsid, c);
            acts.push(`delete __Secure-STRP @${r.domain}: ${r.gone ? 'GONE via ' + r.via : 'STILL THERE (' + r.via + ')'}`); }
    } else if (name === 'clear-all-google-cookies') {
        const t = before.filter(c => /google\./.test(c.domain));
        if (!t.length) acts.push('no google.* cookie in the jar to delete');
        for (const c of t) { const r = await deleteCookie(br, wsid, c);
            acts.push(`delete ${r.name} @${r.domain}: ${r.gone ? 'GONE via ' + r.via : 'STILL THERE (' + r.via + ')'}`); }
    } else if (name === 'clear-localstorage-only') {
        const types = 'local_storage,indexeddb,cache_storage,websql,file_systems,service_workers,shader_cache';
        for (const origin of ['https://www.google.com', 'https://google.com', 'https://maps.google.com']) {
            try { await br.send('Storage.clearDataForOrigin', { origin, storageTypes: types });
                  acts.push('clearDataForOrigin ' + origin + '  [' + types + ']  ok'); }
            catch (e) { acts.push('clearDataForOrigin ' + origin + ' THREW ' + e.message.slice(0, 120)); }
        }
        //  Proof it landed, read from the tab that is ALREADY on the origin so
        //  no new request is made and no cookie is refreshed.
        try {
            const r = await br.send('Runtime.evaluate',
                { expression: '(()=>{try{return localStorage.length}catch(e){return -2}})()',
                  returnByValue: true }, va.sid);
            acts.push('localStorage keys after the clear (same tab, no new request): ' + r?.result?.result?.value +
                      '   (was ' + va.lsCount + ')');
        } catch (e) { acts.push('re-read of localStorage THREW ' + e.message.slice(0, 120)); }
        try { await br.send('Target.closeTarget', { targetId: va.tid }); } catch (e) {}
    } else if (name === 'clear-localstorage-js') {
        //  The CDP clear returned {"code":-32603,"Internal error"} on this build,
        //  so the site-storage arm is redone from INSIDE the page, where the
        //  same-origin APIs cannot half-apply without saying so. Cookies are
        //  deliberately left alone: document.cookie is never written here.
        const JS = `(async () => {
            const before = { ls: -1, idb: [], caches: [] };
            try { before.ls = localStorage.length; } catch (e) {}
            try { before.idb = (await indexedDB.databases()).map(d => d.name); } catch (e) {}
            try { before.caches = await caches.keys(); } catch (e) {}
            try { localStorage.clear(); } catch (e) {}
            try { sessionStorage.clear(); } catch (e) {}
            for (const n of before.idb) { try { indexedDB.deleteDatabase(n); } catch (e) {} }
            for (const n of before.caches) { try { await caches.delete(n); } catch (e) {} }
            const after = { ls: -1, idb: [], caches: [] };
            try { after.ls = localStorage.length; } catch (e) {}
            try { after.idb = (await indexedDB.databases()).map(d => d.name); } catch (e) {}
            try { after.caches = await caches.keys(); } catch (e) {}
            return { before, after, cookieStillVisible: (document.cookie || '').length };
        })()`;
        try {
            const r = await br.send('Runtime.evaluate',
                { expression: JS, returnByValue: true, awaitPromise: true }, va.sid);
            const v = r?.result?.result?.value;
            acts.push('in-page clear ran. localStorage ' + v.before.ls + ' -> ' + v.after.ls +
                      ' ;  idb [' + v.before.idb.join(',') + '] -> [' + v.after.idb.join(',') + ']' +
                      ' ;  caches [' + v.before.caches.join(',') + '] -> [' + v.after.caches.join(',') + ']');
            acts.push('document.cookie length still ' + v.cookieStillVisible + ' -- cookies deliberately untouched');
        } catch (e) { acts.push('in-page clear THREW ' + e.message.slice(0, 200)); }
        try { await br.send('Target.closeTarget', { targetId: va.tid }); } catch (e) {}
    } else if (name === 'clear-UULE-recovery') {
        //  Clearing UULE stops the replay, but visit B then lands on the IP
        //  city rather than on B -- so the honest question is what the load
        //  AFTER that does. Google re-mints UULE from the live position, so
        //  this arm keeps going for a third visit and reports where it lands.
        const t = before.filter(c => c.name === 'UULE');
        if (!t.length) acts.push('no UULE cookie in the jar to delete');
        for (const c of t) { const r = await deleteCookie(br, wsid, c);
            acts.push(`delete UULE @${r.domain}: ${r.gone ? 'GONE via ' + r.via : 'STILL THERE (' + r.via + ')'}`); }
    }
    L.push('');
    L.push('  INTERVENTION');
    for (const a of acts) L.push('     ' + a);

    //  ── the jar the server will actually see on visit B ────────────
    const after = await allCookies(br);
    L.push('');
    L.push(`  JAR AFTER the intervention -- this is what visit B sends  (${after.length} cookie(s))`);
    L.push(...jarLines(after));

    //  ── visit B ────────────────────────────────────────────────────
    const vb = await visit(br, B, false);
    L.push('');
    L.push(`  VISIT B  override = ${B.label} ${B.lat},${B.lng}`);
    for (const s of vb.samples) L.push(`     t=${String(s.t).padStart(5)}ms  ${s.href}`);
    L.push('');
    L.push('  >>> VERDICT visit B settled on: ' + whose(vb.url));
    L.push('  >>> settled url: ' + vb.url);

    const end = await allCookies(br);
    const u = end.find(c => c.name === 'UULE');
    L.push('  UULE after visit B: ' + (u ? readUule(u.value) : '(absent)'));

    //  A third visit, only for the recovery arm: with UULE re-minted from the
    //  live position by visit B, does the NEXT load land on B?
    if (name === 'clear-UULE-recovery') {
        const vc = await visit(br, B, false);
        L.push('');
        L.push(`  VISIT C  override = ${B.label} (again, UULE now re-minted)`);
        for (const s of vc.samples) L.push(`     t=${String(s.t).padStart(5)}ms  ${s.href}`);
        L.push('  >>> VERDICT visit C settled on: ' + whose(vc.url));
        const u2 = (await allCookies(br)).find(c => c.name === 'UULE');
        L.push('  UULE after visit C: ' + (u2 ? readUule(u2.value) : '(absent)'));
    }

    kill(child, tmp);
    await sleep(1500);
    return L.join('\n');
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const arms = ['control', 'clear-UULE', 'clear-STRP',
                  'clear-all-google-cookies', 'clear-localstorage-only',
                  'clear-localstorage-js', 'clear-UULE-recovery'];
    const only = process.env.FP_ARM;
    const list = only ? arms.filter(a => only.split(',').includes(a)) : arms;
    if (!list.length) { console.log('no arm named ' + only + ' -- known: ' + arms.join(', ')); process.exit(2); }

    const head = [
        'probe-maps-carrier  --  which stored item replays the previous country',
        'browser exe : ' + EXE,
        'A (first)   : ' + A.label + ' ' + A.lat + ',' + A.lng,
        'B (switched): ' + B.label + ' ' + B.lat + ',' + B.lng,
        'settle/visit: ' + SETTLE_MS + ' ms',
        '',
    ].join('\n');
    let text = head;
    fs.writeFileSync(path.join(OUT, 'arms.txt'), text);
    console.log(head);

    for (let i = 0; i < list.length; i++) {
        let out;
        try { out = await runArm(list[i], i); }
        catch (e) { out = `ARM ${list[i]} THREW: ${e && e.stack ? e.stack : e}`; }
        console.log(out); console.log('');
        text += out + '\n\n';
        fs.writeFileSync(path.join(OUT, 'arms.txt'), text);   // partial-safe
    }
    process.exit(0);
})();

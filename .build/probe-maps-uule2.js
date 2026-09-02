'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-maps-uule2.js  --  READ-ONLY measurement, temp profile
//
//  Round 1 (probe-maps-uule.js) had a confound: all three visits reused ONE
//  tab, and Chromium hands a subscriber its cached position, so the page kept
//  receiving country A even after the override was moved to B -- the UULE value
//  came back with A's ORIGINAL microsecond timestamp, which is what gave it
//  away. With the position never changing, "still centred on A" proved nothing
//  about the cookie.
//
//  So: a FRESH TAB per visit, the override set on that tab before it navigates,
//  and the cookie recorded BEFORE the navigation as well as after -- the value
//  present at request time is the only one the server could have centred on.
//
//     1. position A, no cookie yet
//     2. position B, cookie from 1 kept
//     3. position B, cookie deleted immediately before navigating
//
//  Deleting one cookie by name is the whole intervention. Nothing else on
//  google.com is touched, which is the property the fix depends on.
// ════════════════════════════════════════════════════════════════════
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 9341;
const browsers = require('../lib/browsers');
const brave = browsers.detectChromium().find(b => b.id === 'brave');
const EXE = brave && brave.exePath;
if (!EXE) { console.log('Brave not detected -- nothing to measure'); process.exit(0); }

const A = { cc: 'LU', label: 'Luxembourg', lat: 49.6116, lng: 6.1319 };
const B = { cc: 'NL', label: 'Amsterdam',  lat: 52.3676, lng: 4.9041 };

const tmp = path.join(os.tmpdir(), `fp-uule2-${process.pid}`);
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

//  UULE is not a protobuf: it is `<prefix>+<base64 of a plain list>`, and the
//  list's 5th element is [lat*1e7, lng*1e7]. Decode it and say which country it
//  names, so the cookie is evidence rather than a name that sounds right.
function readUule(value) {
    if (!value) return '(absent)';
    const b64 = String(value).replace(/^[^+]*\+/, '').replace(/-/g, '+').replace(/_/g, '/');
    let txt = '';
    try { txt = Buffer.from(b64, 'base64').toString('utf8'); } catch (e) { return 'undecodable'; }
    const m = /\[(-?\d{6,10}),\s*(-?\d{6,10})\]/.exec(txt);
    if (!m) return txt.slice(0, 90);
    const lat = +m[1] / 1e7, lng = +m[2] / 1e7;
    const near = t => Math.abs(lat - t.lat) < 0.6 && Math.abs(lng - t.lng) < 0.6;
    const who = near(A) ? `= A ${A.label}` : near(B) ? `= B ${B.label}` : '= neither';
    return `${lat.toFixed(4)},${lng.toFixed(4)} ${who}   [raw ${txt.slice(0, 60)}]`;
}

async function googleCookies(br) {
    const r = await br.send('Storage.getCookies', {});
    return (r?.result?.cookies || []).filter(c => /google\./.test(c.domain));
}

async function dropUule(br) {
    const gone = [];
    for (const c of await googleCookies(br)) {
        if (c.name !== 'UULE') continue;
        await br.send('Storage.deleteCookies',
            { cookies: [{ name: c.name, domain: c.domain, path: c.path }] });
        gone.push(`${c.domain}${c.path}`);
    }
    const left = (await googleCookies(br)).filter(c => c.name === 'UULE');
    return { gone, stillThere: left.length };
}

function centre(url) {
    const m = /\/@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(url);
    return m ? { lat: +m[1], lng: +m[2] } : null;
}
function whose(url) {
    const c = centre(url);
    if (!c) return 'no /@ in the URL';
    const near = t => Math.abs(c.lat - t.lat) < 0.6 && Math.abs(c.lng - t.lng) < 0.6;
    if (near(A)) return `A (${A.label})  <-- the PREVIOUS country`;
    if (near(B)) return `B (${B.label})  <-- the country just handed to the page`;
    return `neither: ${c.lat},${c.lng}  <-- this connection's own IP city`;
}

async function visit(br, where, tag, deleteFirst) {
    let del = null;
    if (deleteFirst) del = await dropUule(br);
    const before = (await googleCookies(br)).find(c => c.name === 'UULE');

    //  A NEW tab, so this page's geolocation request cannot be answered from
    //  the position the previous tab already acquired.
    const t  = await br.send('Target.createTarget', { url: 'about:blank' });
    const at = await br.send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
    const sid = at.result.sessionId;
    await br.send('Page.enable', {}, sid);
    await br.send('Runtime.enable', {}, sid);
    await br.send('Emulation.setGeolocationOverride',
        { latitude: where.lat, longitude: where.lng, accuracy: 20 }, sid);
    await br.send('Page.navigate', { url: 'https://www.google.com/maps' }, sid);
    await sleep(25000);

    const r = await br.send('Runtime.evaluate',
        { expression: '({url: location.href})', returnByValue: true }, sid);
    const url = r?.result?.result?.value?.url || '(none)';
    const after = (await googleCookies(br)).find(c => c.name === 'UULE');
    await br.send('Target.closeTarget', { targetId: t.result.targetId });

    return { tag, where, url, del,
             before: readUule(before && before.value),
             after:  readUule(after && after.value) };
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
    await br.send('Browser.grantPermissions',
        { origin: 'https://www.google.com', permissions: ['geolocation'] });

    const runs = [];
    runs.push(await visit(br, A, '1. position A, cold profile',        false));
    runs.push(await visit(br, B, '2. position B, UULE from 1 kept',    false));
    runs.push(await visit(br, B, '3. position B, UULE deleted first',  true));

    const L = [];
    for (const r of runs) {
        L.push(`──── ${r.tag}`);
        L.push('   handed the page : ' + `${r.where.label} ${r.where.lat},${r.where.lng}`);
        if (r.del) L.push('   deleted         : ' +
            (r.del.gone.length ? r.del.gone.join(', ') : 'nothing') +
            `  (UULE still present after delete: ${r.del.stillThere})`);
        L.push('   UULE at request : ' + r.before);
        L.push('   map centred on  : ' + whose(r.url));
        L.push('   UULE afterwards : ' + r.after);
        L.push('   url             : ' + r.url);
        L.push('');
    }
    const text = L.join('\n');
    fs.writeFileSync(path.join(__dirname, 'probe-maps-uule2.txt'), text);
    console.log(text);

    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch (e) {}
    await sleep(1200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
})();

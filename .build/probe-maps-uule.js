'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-maps-uule.js  --  READ-ONLY measurement, temp profile
//
//  probe-maps-cache.js reproduced the report: with the profile carried over,
//  visit 2's map centred on visit 1's country even though the position handed
//  to the page had changed. localStorage and IndexedDB held no coordinates --
//  the only location-shaped thing on the origin was the `UULE` cookie, which is
//  how Google carries "where this user is" to its own servers.
//
//  This is the A/B that turns that into a cause. Three visits, one profile:
//
//     1. position = A            -- warm the profile
//     2. position = B            -- the bug: does it still show A?
//     3. position = B, UULE cookie DELETED first
//
//  If 3 stops showing A, the cookie is the carrier and deleting it is the fix.
//  If 3 still shows A, it is not, and clearing storage would be a placebo.
//
//  The UULE value is printed and its varints scanned for lat/lng * 1e7, so the
//  contents are evidence too rather than a guess from the name.
// ════════════════════════════════════════════════════════════════════
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 9339;
const browsers = require('../lib/browsers');
const brave = browsers.detectChromium().find(b => b.id === 'brave');
const EXE = brave && brave.exePath;
if (!EXE) { console.log('Brave not detected -- nothing to measure'); process.exit(0); }

const A = { cc: 'LU', label: 'Luxembourg', lat: 49.6116, lng: 6.1319 };
const B = { cc: 'NL', label: 'Amsterdam',  lat: 52.3676, lng: 4.9041 };

const tmp = path.join(os.tmpdir(), `fp-uule-${process.pid}`);
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

//  Pull every varint out of the decoded cookie and report the ones that look
//  like a coordinate in Google's e7 fixed-point form.
function scanUule(value) {
    let raw;
    try {
        const b64 = String(value).replace(/^w\+/, '').replace(/-/g, '+').replace(/_/g, '/');
        raw = Buffer.from(b64, 'base64');
    } catch (e) { return 'undecodable'; }
    const hits = [];
    for (let i = 0; i < raw.length; i++) {
        let v = 0n, shift = 0n, j = i, ok = false;
        while (j < raw.length && shift <= 63n) {
            const byte = BigInt(raw[j]);
            v |= (byte & 0x7fn) << shift;
            j++; shift += 7n;
            if (!(byte & 0x80n)) { ok = true; break; }
        }
        if (!ok) continue;
        const n = Number(BigInt.asIntN(64, v));
        const deg = n / 1e7;
        if (Math.abs(deg) > 0.5 && Math.abs(deg) <= 180) hits.push(deg.toFixed(4));
    }
    return hits.length ? hits.join(' ') : 'no coordinate-shaped varint';
}

async function cookies(br) {
    const r = await br.send('Storage.getCookies', {});
    return (r?.result?.cookies || []).filter(c => /google\./.test(c.domain));
}

async function visit(br, sid, where, tag, dropUule) {
    if (dropUule) {
        //  Exactly one cookie, by name, on the domain that set it. Nothing else
        //  on google.com is touched -- that is the whole point of the test.
        for (const c of await cookies(br)) {
            if (c.name !== 'UULE') continue;
            await br.send('Storage.deleteCookies',
                { cookies: [{ name: c.name, domain: c.domain, path: c.path }] });
        }
    }
    await br.send('Emulation.setGeolocationOverride',
        { latitude: where.lat, longitude: where.lng, accuracy: 20 }, sid);
    await br.send('Page.navigate', { url: 'https://www.google.com/maps' }, sid);
    await sleep(25000);
    const r = await br.send('Runtime.evaluate',
        { expression: '({url: location.href})', returnByValue: true }, sid);
    const url = r?.result?.result?.value?.url || '(none)';
    const jar = await cookies(br);
    const uule = jar.find(c => c.name === 'UULE');
    return {
        tag, where, url,
        names: jar.map(c => c.name).sort().join(', ') || 'none',
        uule: uule ? uule.value : null,
        uuleCoords: uule ? scanUule(uule.value) : null,
    };
}

function centre(url) {
    const m = /\/@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(url);
    return m ? { lat: +m[1], lng: +m[2] } : null;
}
function whose(url) {
    const c = centre(url);
    if (!c) return 'no /@ in the URL';
    const near = (t) => Math.abs(c.lat - t.lat) < 0.6 && Math.abs(c.lng - t.lng) < 0.6;
    if (near(A)) return `A (${A.label})`;
    if (near(B)) return `B (${B.label})`;
    return `neither -- ${c.lat},${c.lng} (the exit IP's own city)`;
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
    const t  = await br.send('Target.createTarget', { url: 'about:blank' });
    const at = await br.send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
    const sid = at.result.sessionId;
    await br.send('Page.enable', {}, sid);
    await br.send('Runtime.enable', {}, sid);

    const runs = [];
    runs.push(await visit(br, sid, A, '1. position = A', false));
    runs.push(await visit(br, sid, B, '2. position = B, cookie kept', false));
    runs.push(await visit(br, sid, B, '3. position = B, UULE deleted', true));

    const L = [];
    for (const r of runs) {
        L.push(`──── ${r.tag}   (handed the page ${r.where.label} ${r.where.lat},${r.where.lng})`);
        L.push('   map centred on : ' + whose(r.url));
        L.push('   url            : ' + r.url);
        L.push('   google cookies : ' + r.names);
        L.push('   UULE           : ' + (r.uule ? r.uule.slice(0, 80) : '(absent)'));
        L.push('   UULE coords    : ' + (r.uuleCoords || '-'));
        L.push('');
    }
    const text = L.join('\n');
    fs.writeFileSync(path.join(__dirname, 'probe-maps-uule.txt'), text);
    console.log(text);

    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch (e) {}
    await sleep(1200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
})();

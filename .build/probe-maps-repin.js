'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-maps-repin.js  --  READ-ONLY measurement, temp profile
//
//  ASK 1 rests on two premises this repo has ASSERTED but never measured:
//
//    P1  a `/maps/@lat,lng,zoom` pin in the URL decides the first-load centre,
//        beating whatever Google's own IP database says
//        (Extension/background.js:723-724 states this as fact)
//    P2  a UULE cookie WE compose is honoured the same way the one Google
//        writes is (probe-maps-uule2.txt only ever measured READING one back)
//
//  Neither is safe to build on. Both are decidable from this machine with no
//  tunnel at all: the machine's own IP resolves near Dhaka (23.71,90.42) and
//  the target is Paris (48.86,2.35) -- 5000 km apart, so there is no ambiguity
//  about which signal won.
//
//  Every arm starts from an EMPTY cookie jar (Storage.clearCookies) so "no
//  cookie at request time" is a fact and not a hope; probe-maps-uule2's
//  per-name delete silently never executed -- Storage.deleteCookies is not a
//  CDP method, and its transport resolved on any id-matched reply.
//
//  Nothing is written outside os.tmpdir() and .build/. No user profile is
//  opened, no proxy is set, and the app does not have to be connected.
// ════════════════════════════════════════════════════════════════════
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 9343;
const SETTLE_MS = 25000;

const browsers = require('../lib/browsers');
const pick = browsers.detectChromium().find(b => b.id === 'brave')
          || browsers.detectChromium().find(b => b.id === 'chrome')
          || browsers.detectChromium()[0];
const EXE = pick && pick.exePath;
if (!EXE) { console.log('No Chromium browser detected -- nothing to measure'); process.exit(0); }

//  Paris and Tokyo are the two planted answers; HOME is whatever this
//  machine's own IP resolves to and is discovered, never assumed.
const PARIS = { label: 'Paris',  lat: 48.8566, lng: 2.3522 };
const TOKYO = { label: 'Tokyo',  lat: 35.6895, lng: 139.6917 };

const tmp = path.join(os.tmpdir(), `fp-repin-${process.pid}`);
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
    //  Unlike probe-maps-uule2's transport, a protocol error is surfaced. A
    //  silent `{error:{message:"'Storage.deleteCookies' wasn't found"}}` is
    //  what made the earlier rounds report a delete that never happened.
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

//  ── the composer under test ─────────────────────────────────────────
//  Grammar as decoded from the cookie Google itself wrote (see
//  .build/probe-maps-uule2.txt:5): `<prefix>+<base64 of a plain list>` where
//  the list is [1,12,<micros>,null,[lat*1e7,lng*1e7],null,<radius>,]. The
//  trailing comma is in Google's own value; it is reproduced exactly.
function makeUule(pos, micros, radius = 20000) {
    const list = '[1,12,' + micros + ',null,[' +
                 Math.round(pos.lat * 1e7) + ',' + Math.round(pos.lng * 1e7) +
                 '],null,' + radius + ',]';
    return { raw: list, value: 'j+' + Buffer.from(list, 'utf8').toString('base64') };
}

function readUule(value) {
    if (!value) return { text: '(absent)', lat: null, lng: null };
    const b64 = String(value).replace(/^[^+]*\+/, '').replace(/-/g, '+').replace(/_/g, '/');
    let txt = '';
    try { txt = Buffer.from(b64, 'base64').toString('utf8'); } catch (e) { return { text: 'undecodable', lat: null, lng: null }; }
    const m = /\[(-?\d{6,10}),\s*(-?\d{6,10})\]/.exec(txt);
    if (!m) return { text: txt, lat: null, lng: null };
    return { text: txt, lat: +m[1] / 1e7, lng: +m[2] / 1e7 };
}

function centre(url) {
    const m = /\/@(-?\d+\.\d+),(-?\d+\.\d+)(?:,([\d.]+)z)?/.exec(String(url));
    return m ? { lat: +m[1], lng: +m[2], zoom: m[3] || null } : null;
}
function near(c, t, deg) { return c && Math.abs(c.lat - t.lat) < deg && Math.abs(c.lng - t.lng) < deg; }

function verdict(url, expect, home) {
    const c = centre(url);
    if (/\/sorry\//.test(String(url))) return 'CAPTCHA -- Google served /sorry/, arm inconclusive';
    if (!c) return 'no /@ in the settled URL: ' + url;
    if (near(c, expect, 0.6)) return `${expect.label} -- the planted signal WON  (${c.lat},${c.lng} ${c.zoom || '?'}z)`;
    if (home && near(c, home, 1.2)) return `this machine's own IP city -- the planted signal LOST  (${c.lat},${c.lng} ${c.zoom || '?'}z)`;
    if (near(c, TOKYO, 0.6)) return `Tokyo -- the cookie won over the pin  (${c.lat},${c.lng} ${c.zoom || '?'}z)`;
    if (near(c, PARIS, 0.6)) return `Paris  (${c.lat},${c.lng} ${c.zoom || '?'}z)`;
    return `neither: ${c.lat},${c.lng} ${c.zoom || '?'}z`;
}

async function allCookies(br) {
    const r = await br.send('Storage.getCookies', {});
    return (r?.result?.cookies || []).filter(c => /google\./.test(c.domain));
}

//  An arm is only evidence if the jar really was empty. Clear, then read back,
//  and abort the arm with a printed reason if a UULE survived.
async function emptyJar(br) {
    await br.send('Storage.clearCookies', {});
    const left = (await allCookies(br)).filter(c => c.name === 'UULE');
    return left.length;
}

async function plant(br, pos, micros) {
    const u = makeUule(pos, micros);
    //  Storage.setCookies, not Network.setCookie: Network is a *page* domain and
    //  is not present on the browser-level session -- the first run of this probe
    //  died with "'Network.setCookie' wasn't found", which is the whole point of
    //  a transport that surfaces protocol errors instead of resolving on them.
    let accepted = true;
    try {
        await br.send('Storage.setCookies', { cookies: [{
            name: 'UULE', value: u.value, domain: '.google.com', path: '/',
            secure: true, httpOnly: false, sameSite: 'None',
            expires: Math.floor(Date.now() / 1000) + 3600,
        }] });
    } catch (e) { accepted = false; }
    const back = (await allCookies(br)).find(c => c.name === 'UULE');
    return { asked: u, accepted, readBack: back || null };
}

//  One arm.  `url` is navigated verbatim; `override` is only used by the arm
//  that has to make Google mint a cookie of its own.
async function arm(br, tag, { url, planted = null, override = null, expect, home }) {
    const jarLeft = await emptyJar(br);
    let plantRec = null;
    if (planted) plantRec = await plant(br, planted.pos, planted.micros);

    const before = (await allCookies(br)).find(c => c.name === 'UULE');
    const t   = await br.send('Target.createTarget', { url: 'about:blank' });
    const at  = await br.send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
    const sid = at.result.sessionId;
    await br.send('Page.enable', {}, sid);
    await br.send('Runtime.enable', {}, sid);
    if (override) {
        await br.send('Emulation.setGeolocationOverride',
            { latitude: override.lat, longitude: override.lng, accuracy: 20 }, sid);
    }
    await br.send('Page.navigate', { url }, sid);
    await sleep(SETTLE_MS);

    let settled = '(none)';
    try {
        const r = await br.send('Runtime.evaluate',
            { expression: '({url: location.href})', returnByValue: true }, sid);
        settled = r?.result?.result?.value?.url || '(none)';
    } catch (e) { settled = 'evaluate failed: ' + e.message; }
    const after = (await allCookies(br)).find(c => c.name === 'UULE');
    try { await br.send('Target.closeTarget', { targetId: t.result.targetId }); } catch (e) {}

    return { tag, url, jarLeft, plantRec, override, expect, home,
             before: before || null, after: after || null, settled };
}

//  Print a cookie WHOLE. The truncation at probe-maps-uule.js:166 and
//  probe-maps-uule2.js:74 is why nobody could build a composer from the
//  existing record: the decoded list is cut off mid-value in both files.
function dumpCookie(c, label, L) {
    if (!c) { L.push(`   ${label}: (absent)`); return; }
    const d = readUule(c.value);
    L.push(`   ${label}:`);
    L.push(`      value   : ${c.value}`);
    L.push(`      decoded : ${d.text}`);
    L.push(`      coords  : ${d.lat === null ? '(none)' : d.lat.toFixed(4) + ',' + d.lng.toFixed(4)}`);
    L.push('      attrs   : ' + JSON.stringify({
        domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
        sameSite: c.sameSite, session: c.session, expires: c.expires, size: c.size,
        sourcePort: c.sourcePort, sourceScheme: c.sourceScheme,
    }));
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
    //  An arm that throws must not destroy the arms that already succeeded --
    //  the first run of this probe lost two completed arms to one bad CDP name.
    async function go(tag, opts) {
        try { runs.push(await arm(br, tag, opts)); }
        catch (e) { runs.push({ tag, url: opts.url, error: e.message }); }
        return runs[runs.length - 1];
    }

    //  0. BASELINE. Empty jar, bare /maps, no pin, no override. Whatever this
    //     returns is this machine's own IP city, discovered rather than assumed.
    await go('0. baseline: empty jar, bare /maps, nothing planted', {
        url: 'https://www.google.com/maps', expect: PARIS, home: null,
    });
    const home = centre(runs[0].settled);

    //  1. P1. A pin in the URL, empty jar, NO geolocation override anywhere --
    //     so the URL is the only signal that could place the map.
    await go('1. P1: pin Paris in the URL, empty jar, no override', {
        url: 'https://www.google.com/maps/@48.8566,2.3522,12z', expect: PARIS, home,
    });

    //  2. P2. A UULE WE composed, bare /maps, no pin, no override.
    await go('2. P2: composed UULE for Paris, bare /maps', {
        url: 'https://www.google.com/maps', expect: PARIS, home,
        planted: { pos: PARIS, micros: 1788211318853000 },
    });

    //  3. Same as 2 with a fresh microsecond stamp, in case Google rejects a
    //     stale one. Answers "is the timestamp load-bearing" for free.
    await go('3. P2 again, current timestamp', {
        url: 'https://www.google.com/maps', expect: PARIS, home,
        planted: { pos: PARIS, micros: Date.now() * 1000 },
    });

    //  4. Precedence. Pin says Paris, our cookie says Tokyo. Which one the map
    //     obeys decides whether the repin alone is sufficient.
    await go('4. precedence: pin Paris vs composed UULE Tokyo', {
        url: 'https://www.google.com/maps/@48.8566,2.3522,12z', expect: PARIS, home,
        planted: { pos: TOKYO, micros: Date.now() * 1000 },
    });

    //  5. Google's own cookie, whole. An override on a bare /maps makes Google
    //     mint one; this arm exists to validate the composer's grammar against
    //     it byte for byte.
    await go('5. reference: Google mints its own UULE (override Tokyo)', {
        url: 'https://www.google.com/maps', expect: TOKYO, home, override: TOKYO,
    });

    const L = [];
    L.push(`browser         : ${pick.name}  ${EXE}`);
    L.push(`chrome version  : ${ver.Browser || '(unknown)'}`);
    L.push(`settle per arm  : ${SETTLE_MS} ms`);
    L.push(`machine IP city : ${home ? home.lat + ',' + home.lng : '(not established)'}`);
    L.push('');
    for (const r of runs) {
        L.push(`──── ${r.tag}`);
        L.push('   navigated to    : ' + r.url);
        if (r.error) { L.push('   ARM FAILED      : ' + r.error); L.push(''); continue; }
        L.push('   jar cleared     : ' + (r.jarLeft === 0 ? 'yes, 0 UULE left' :
            `NO -- ${r.jarLeft} UULE survived, this arm is not evidence`));
        if (r.override) L.push('   geo override    : ' + r.override.label +
            ` ${r.override.lat},${r.override.lng}`);
        if (r.plantRec) {
            L.push('   planted UULE    : ' + (r.plantRec.accepted ? 'setCookie ok' : 'setCookie REFUSED'));
            L.push('      asked raw    : ' + r.plantRec.asked.raw);
            L.push('      asked value  : ' + r.plantRec.asked.value);
            L.push('      read back    : ' + (r.plantRec.readBack
                ? (r.plantRec.readBack.value === r.plantRec.asked.value
                    ? 'identical' : 'DIFFERENT: ' + r.plantRec.readBack.value)
                : 'NOT IN THE JAR'));
        }
        dumpCookie(r.before, 'UULE at request time', L);
        L.push('   VERDICT         : ' + verdict(r.settled, r.expect, r.home));
        L.push('   settled url     : ' + r.settled);
        dumpCookie(r.after, 'UULE afterwards', L);
        L.push('');
    }
    const text = L.join('\n');
    fs.writeFileSync(path.join(__dirname, 'probe-maps-repin.txt'), text);
    console.log(text);

    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch (e) {}
    await sleep(1200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
})().catch(e => { console.log('probe failed: ' + e.message); process.exit(1); });



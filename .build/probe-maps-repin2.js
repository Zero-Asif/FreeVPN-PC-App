'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-maps-repin2.js  --  READ-ONLY, temp profile, no tunnel
//
//  probe-maps-repin.txt settled the physics:
//     P1 CONFIRMED  a `/@lat,lng,zoom` pin decides the first-load centre and
//                   beats both Google's IP answer and a conflicting UULE
//     P2 REFUTED    a UULE we compose is read back byte-identical and then
//                   ignored -- the map still centred on this machine's own city
//
//  So the fix for ASK 1 is a REPIN, not a cookie. What is still unmeasured is
//  the part that actually ships:
//
//    Q1  does the pin still decide when the URL carries Maps' own
//        `?entry=ttu&g_ep=...` tail (the shape every real tab has, including
//        the one in the user's screenshot)?
//    Q2  does renavigating the SAME tab to a different pin fly the map there?
//        `chrome.tabs.update(id, {url})` is a browser-level navigation, but
//        Maps is an SPA and this is the production path, so measure it.
//    Q3  does the string surgery survive the URL shapes Maps really produces
//        (/data= segments, /place/, /dir/, bare /maps, a no-op repin)?
//
//  Nothing is written outside os.tmpdir() and .build/. No proxy, no profile.
// ════════════════════════════════════════════════════════════════════
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 9344;
const SETTLE_MS = 22000;

const browsers = require('../lib/browsers');
const cands = browsers.detectChromium();
const pick = cands.find(b => b.id === 'brave') || cands.find(b => b.id === 'chrome') || cands[0];
const EXE = pick && pick.exePath;
if (!EXE) { console.log('No Chromium browser detected -- nothing to measure'); process.exit(0); }

//  The user's screenshot URL, verbatim, tail and all.
const USER_URL = 'https://www.google.com/maps/@35.5026691,51.7546255,7z' +
                 '?entry=ttu&g_ep=EgoyMDI2MDgzMC4wIKXMDSoASAFQAw%3D%3D';
const PARIS = { label: 'Paris', lat: 48.8566,   lng: 2.3522 };
const IRAN  = { label: 'Iran',  lat: 35.5026691, lng: 51.7546255 };

const tmp = path.join(os.tmpdir(), `fp-repin2-${process.pid}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = u => new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); }).on('error', rej);
});

// ── THE CANDIDATE PRODUCTION SURGERY ────────────────────────────────
//  A NEW function, deliberately separate from unpinMaps(): that one's 1.5°
//  guard line is a mutation anchor (.build/probe-mutate.js:60-62 locates it by
//  literal string), so it is left byte-identical and this sits beside it.
//  Unlike unpinMaps, the zoom/rotation segment is CAPTURED and carried over --
//  a 7z country view stays a 7z country view, only the centre moves.
function repinMaps(url, to) {
    if (!to || typeof to.lat !== 'number' || typeof to.lng !== 'number') return null;
    const m = /^(https?:\/\/[^/]*google\.[^/]+\/maps(?:\/[^@?#][^?#]*?)?)\/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)([^/?#]*)((?:\/[^?#]*)?(?:[?#].*)?)$/
        .exec(String(url));
    if (!m) return null;
    const next = m[1] + '/@' + to.lat + ',' + to.lng + (m[4] || '') + (m[5] || '');
    return next === String(url) ? null : next;
}

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

function centre(url) {
    const m = /\/@(-?\d+\.\d+),(-?\d+\.\d+)(?:,([\d.]+)z)?/.exec(String(url));
    return m ? { lat: +m[1], lng: +m[2], zoom: m[3] || null } : null;
}
function near(c, t, deg) { return c && Math.abs(c.lat - t.lat) < deg && Math.abs(c.lng - t.lng) < deg; }
function where(url, home) {
    const c = centre(url);
    if (/\/sorry\//.test(String(url))) return 'CAPTCHA -- /sorry/, arm inconclusive';
    if (!c) return 'no /@ in the settled URL: ' + url;
    if (near(c, PARIS, 0.6)) return `Paris  (${c.lat},${c.lng} ${c.zoom || '?'}z)`;
    if (near(c, IRAN, 0.6))  return `Iran   (${c.lat},${c.lng} ${c.zoom || '?'}z)`;
    if (home && near(c, home, 1.2)) return `this machine's own IP city  (${c.lat},${c.lng} ${c.zoom || '?'}z)`;
    return `neither: ${c.lat},${c.lng} ${c.zoom || '?'}z`;
}

// ── Q3: string-only, no browser needed ──────────────────────────────
const SHAPES = [
    ['the screenshot URL',           USER_URL],
    ['bare /maps (no pin at all)',   'https://www.google.com/maps'],
    ['pin, no tail',                 'https://www.google.com/maps/@35.5026691,51.7546255,7z'],
    ['pin + /data= segment',         'https://www.google.com/maps/@35.50,51.75,15z/data=!3m1!4b1!4m2'],
    ['pin + 3D camera segment',      'https://www.google.com/maps/@35.50,51.75,17z,3a,75y,90t/data=!3m7'],
    ['/place/ then a pin',           'https://www.google.com/maps/place/Tehran/@35.6892,51.3890,11z/data=!4m2'],
    ['/dir/ then a pin',             'https://www.google.com/maps/dir/A/B/@35.60,51.40,10z/data=!3m1'],
    ['/search/ then a pin',          'https://www.google.com/maps/search/cafe/@35.60,51.40,13z'],
    ['a non-Maps google page',       'https://www.google.com/search?q=weather'],
    ['maps.google.co.uk host',       'https://maps.google.co.uk/maps/@51.5,0.12,10z'],
    ['already at the destination',   'https://www.google.com/maps/@48.8566,2.3522,7z?entry=ttu'],
    ['negative coordinates',         'https://www.google.com/maps/@-33.8688,151.2093,12z?entry=ttu'],
];

async function arm(br, tag, { url, targetId = null, home }) {
    await br.send('Storage.clearCookies', {});
    let tid = targetId;
    if (!tid) {
        const t = await br.send('Target.createTarget', { url: 'about:blank' });
        tid = t.result.targetId;
    }
    const at  = await br.send('Target.attachToTarget', { targetId: tid, flatten: true });
    const sid = at.result.sessionId;
    await br.send('Page.enable', {}, sid);
    await br.send('Runtime.enable', {}, sid);
    await br.send('Page.navigate', { url }, sid);
    await sleep(SETTLE_MS);
    let settled = '(none)';
    try {
        const r = await br.send('Runtime.evaluate',
            { expression: '({url: location.href})', returnByValue: true }, sid);
        settled = r?.result?.result?.value?.url || '(none)';
    } catch (e) { settled = 'evaluate failed: ' + e.message; }
    return { tag, url, targetId: tid, settled, verdict: where(settled, home) };
}

(async () => {
    const L = [];
    L.push('── Q3  string surgery, repinMaps(url, Paris) ─────────────────');
    for (const [label, u] of SHAPES) {
        const out = repinMaps(u, PARIS);
        L.push(`   ${label}`);
        L.push(`      in  : ${u}`);
        L.push(`      out : ${out === null ? '(null -- left alone)' : out}`);
    }
    L.push('');
    console.log(L.join('\n'));

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

    const runs = [];
    async function go(tag, opts) {
        try { runs.push(await arm(br, tag, opts)); }
        catch (e) { runs.push({ tag, url: opts.url, error: e.message }); }
        return runs[runs.length - 1];
    }

    //  home first: bare /maps with an empty jar is this machine's own IP city.
    const base = await go('home: bare /maps, empty jar', { url: 'https://www.google.com/maps', home: null });
    const home = centre(base.settled);

    //  Q1. The screenshot URL verbatim -- pin + Maps' own tail.
    const a = await go('Q1: the screenshot URL verbatim (pin Iran + ?entry tail)',
        { url: USER_URL, home });

    //  Q2. THE PRODUCTION PATH. Same tab, renavigated to the repinned URL,
    //      exactly what chrome.tabs.update(id, {url}) does after a switch.
    const repinned = repinMaps(USER_URL, PARIS);
    await go('Q2: SAME TAB renavigated to repinMaps(url, Paris)',
        { url: repinned, targetId: a.targetId, home });

    //  Q2b. Cold: a fresh tab straight to the repinned URL, to separate
    //       "the repin works" from "the same-tab renavigation works".
    await go('Q2b: fresh tab straight to the repinned URL',
        { url: repinned, home });

    const R = [];
    R.push(`browser         : ${pick.name}  ${EXE}`);
    R.push(`chrome version  : ${ver.Browser || '(unknown)'}`);
    R.push(`settle per arm  : ${SETTLE_MS} ms`);
    R.push(`machine IP city : ${home ? home.lat + ',' + home.lng + ' ' + (home.zoom || '?') + 'z' : '(not established)'}`);
    R.push(`repinned URL    : ${repinned}`);
    R.push('');
    for (const r of runs) {
        R.push(`──── ${r.tag}`);
        R.push('   navigated to : ' + r.url);
        if (r.error) { R.push('   ARM FAILED   : ' + r.error); R.push(''); continue; }
        R.push('   VERDICT      : ' + r.verdict);
        R.push('   settled url  : ' + r.settled);
        R.push('');
    }
    const text = L.join('\n') + '\n' + R.join('\n');
    fs.writeFileSync(path.join(__dirname, 'probe-maps-repin2.txt'), text);
    console.log(R.join('\n'));

    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch (e) {}
    await sleep(1200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
})().catch(e => { console.log('probe failed: ' + e.message); process.exit(1); });

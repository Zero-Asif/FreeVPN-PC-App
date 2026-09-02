'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-geo-purge.js  --  does a country switch actually take the
//  previous country OUT of the browser?
//
//  The reported bug: connect to country A, open Google Maps, switch to country
//  B -- Maps still shows A. Closing the tab does not help. Restarting Brave
//  does not help. .build/probe-maps-uule2.js measured why: Maps centres from
//  Google's `UULE` cookie, we are the ones who cause it to be written, and a
//  cookie outlives both the tab and the browser.
//
//  This test does not go near google.com. It stands up a page of our own that
//  behaves the way the measurement showed Maps behaves -- asks for a position,
//  then keeps a copy of one in a UULE cookie and in localStorage -- and then
//  asks the only question that matters: after a switch, does that page still
//  find the old country lying around?
//
//  What each check is worth:
//
//    * the cookie and the localStorage entry are read at LOAD time, before the
//      page re-plants them. A purge cannot be papered over by a re-plant, and
//      that reading is literally what a real site finds when it reloads.
//    * the page reports a random per-load id, so "the tab was reloaded" is a
//      fact about a new document rather than an inference from timing.
//    * a SECOND origin (localhost, which is a different origin from 127.0.0.1)
//      plants the same things and never asks for a position. Its localStorage
//      must survive: the storage clear is scoped to origins that were handed a
//      position, and everything else the user has open is not ours to empty.
//    * a control run with no extension loaded must find both still there --
//      otherwise the browser was doing it on its own and we proved nothing.
//
//  The extension is staged through lib/geo-ext.js exactly as the app stages it,
//  with no test seed, so this is the shipping chain: fake desktop app on
//  127.0.0.1:8080 -> background.js -> geo-bridge.js -> geo-spoof.js -> page.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { Probe, BROWSERS, sleep } = require('./probe');
const { GeoExt } = require('../lib/geo-ext');

let WebSocketServer;
try { WebSocketServer = require('ws').Server; }
catch (e) { console.log('ABORT: the "ws" module is not installed'); process.exit(3); }

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fppurge-'));

const WS_PORT = 8080;          // what Extension/background.js hard-codes
const PROBE_PORT = 8099;

//  Far enough apart that the +/- 0.0004 deg jitter cannot turn one into the
//  other, and far enough that unpinMaps()'s 1.5 deg tolerance cannot confuse
//  them either.
const LU = { lat: 49.6116, lng: 6.1319, accuracy: 18, city: 'Luxembourg City', cc: 'LU' };
const JP = { lat: 35.6895, lng: 139.6917, accuracy: 18, city: 'Tokyo', cc: 'JP' };

//  The two origins. Different hosts, so different origins, and the browser keeps
//  their cookies and their localStorage separately -- which is the whole point
//  of having a second one.
const GEO_URL   = `http://127.0.0.1:${PROBE_PORT}/geo.html`;
const QUIET_URL = `http://localhost:${PROBE_PORT}/quiet.html`;

let pass = 0, fail = 0, skipped = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '\n         ' + extra : '')); }
};
const note = (name, why) => { skipped++; console.log('  --   ' + name + (why ? '  (' + why + ')' : '')); };

const log = {
    debug: () => {}, info: () => {}, success: () => {},
    warn: (...a) => console.log('   warn:', ...a),
    error: (...a) => console.log('   ERROR:', ...a),
};

// ── the pages ───────────────────────────────────────────────────────
//  Built by string concatenation with no backslash anywhere: this source is a
//  template literal, and an unrecognised escape in one of those silently loses
//  the backslash -- a regex like /;\s*UULE=/ would arrive as /;s*UULE=/ and
//  quietly never match. indexOf does the same job with nothing to lose.
function page(tag, ask, openUrl) {
    return [
        '<!doctype html><meta charset=utf-8><title>' + tag + '</title><body>' + tag,
        '<script>',
        'var TAG = "' + tag + '", ASK = ' + (ask ? 'true' : 'false') + ';',
        'var OPEN = ' + (openUrl ? JSON.stringify(openUrl) : 'null') + ';',
        //  A fresh id per document. A report carrying a new one is a reload.
        'var ID = Math.random().toString(36).slice(2, 8);',
        'function hasCookie(){ var c = "; " + document.cookie; return c.indexOf("; UULE=") >= 0 ? 1 : 0; }',
        'function hasLs(){ try { return localStorage.getItem("fp-loc") ? 1 : 0; } catch (e) { return -1; } }',
        //  Read BEFORE planting. This pair is the evidence: it is what the site
        //  finds on the load, and re-planting afterwards cannot rewrite it.
        'var L_UULE = hasCookie(), L_LS = hasLs();',
        'try { document.cookie = "UULE=w+CAIQICINTHV4ZW1ib3VyZw; path=/; max-age=3600"; } catch (e) {}',
        'try { localStorage.setItem("fp-loc", "49.6116,6.1319"); } catch (e) {}',
        'try { if (OPEN && !sessionStorage.getItem("fp-opened")) {',
        '  sessionStorage.setItem("fp-opened", "1"); window.open(OPEN, "_blank"); } } catch (e) {}',
        'var n = 0;',
        'function send(q){ try { fetch("/r?" + q); } catch (e) { new Image().src = "/r?" + q; } }',
        'function base(){ return "tag=" + TAG + "&id=" + ID + "&n=" + (++n) +',
        '  "&luule=" + L_UULE + "&lls=" + L_LS + "&uule=" + hasCookie() + "&ls=" + hasLs(); }',
        'function poll(){',
        '  var b = base();',
        '  if (!ASK) { send(b); return; }',
        '  if (!navigator.geolocation) { send(b + "&no-api=1"); return; }',
        '  navigator.geolocation.getCurrentPosition(',
        '    function(p){ send(b + "&ok=" + p.coords.latitude.toFixed(4) + "," + p.coords.longitude.toFixed(4)); },',
        '    function(e){ send(b + "&err=" + e.code); },',
        '    { timeout: 3000, enableHighAccuracy: true, maximumAge: 0 });',
        '}',
        'poll();',
        'setInterval(poll, 1200);',
        '</scr' + 'ipt>',
    ].join('\n');
}

// ── report parsing ──────────────────────────────────────────────────
const field = (r, k) => {
    const m = new RegExp('(?:^|&)' + k + '=([^&]*)').exec(r);
    return m ? m[1] : null;
};
const isGeo   = r => field(r, 'tag') === 'geo';
const isQuiet = r => field(r, 'tag') === 'quiet';
const coordsOf = r => {
    const m = /(?:^|&)ok=(-?[\d.]+),(-?[\d.]+)/.exec(r);
    return m ? { lat: +m[1], lng: +m[2] } : null;
};
const isAt = (r, c) => {
    const p = coordsOf(r);
    return !!p && Math.abs(p.lat - c.lat) < 0.01 && Math.abs(p.lng - c.lng) < 0.01;
};

// ── the fake desktop app ────────────────────────────────────────────
//  The same shape main.js sends: stateForWire() spreads appState and attaches
//  `geo`, broadcastState() wraps it in {type:'STATE_SYNC', state}.
function stateFor(coord, code) {
    return {
        connected: !!coord, serverCode: code || 'us', killSwitch: false,
        bypassList: '', servers: {},
        geo: coord ? { lat: coord.lat, lng: coord.lng, accuracy: coord.accuracy,
                       city: coord.city, cc: coord.cc } : null,
    };
}

class FakeApp {
    constructor(state) { this.state = state; this.clients = new Set(); }
    start() {
        this.wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
        this.wss.on('connection', ws => {
            this.clients.add(ws);
            ws.send(JSON.stringify({ type: 'STATE_SYNC', state: this.state }));
            ws.on('message', () => {});                 // PING keepalive; ignored
            ws.on('close', () => this.clients.delete(ws));
            ws.on('error', () => {});
        });
        return new Promise((res, rej) => {
            this.wss.once('listening', res);
            this.wss.once('error', rej);
        });
    }
    set(state, label) {
        this.state = state;
        const msg = JSON.stringify({ type: 'STATE_SYNC', state });
        let n = 0;
        for (const c of this.clients) { if (c.readyState === 1) { c.send(msg); n++; } }
        console.log(`   -> ${label} (${n} client${n === 1 ? '' : 's'})`);
        return n;
    }
    stop() {
        try { this.wss.close(); } catch (e) {}
        for (const c of this.clients) { try { c.close(); } catch (e) {} }
    }
}

const portFree = port => new Promise(res => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
});

// ── one browser: connect, plant, switch, look again ─────────────────
async function session(probe, app, name, exe, extDir) {
    console.log(`\n── ${name}: connect to LU, plant a location, switch to JP ──`);
    app.state = stateFor(LU, 'lu');

    let phase = 0, markSwitch = 0, reloadAt = -1;
    let firstId = null, quietId = null;
    let planted = null;

    const until = () => {
        const rs = probe.reports;
        if (phase === 0) {
            //  Wait for the page to have BOTH the connected country and the
            //  planted copies of it. Asserting on a switch before the plant
            //  landed would be testing nothing at all.
            const hit = rs.findIndex(r => isGeo(r) && isAt(r, LU) &&
                                          field(r, 'uule') === '1' && field(r, 'ls') === '1');
            //  A page clearly alive and answering from something other than us,
            //  two dozen answers in, is a browser that will not load the
            //  extension. Chrome does this every run, by design.
            if (hit < 0) return rs.length >= 30;
            planted = rs[hit];
            firstId = field(planted, 'id');
            const q = rs.find(isQuiet);
            quietId = q ? field(q, 'id') : null;
            phase = 1; markSwitch = rs.length;
            app.set(stateFor(JP, 'jp'), 'switch to Tokyo');
            return false;
        }
        if (phase === 1) {
            const hit = rs.slice(markSwitch).findIndex(r => isGeo(r) && field(r, 'id') !== firstId);
            if (hit < 0) return false;
            reloadAt = markSwitch + hit;
            phase = 2;
            return false;
        }
        //  Let the new document poll a few times: its first answer may still be
        //  in flight when it reports, and the quiet tab has to be heard from too.
        return probe.reports.length >= reloadAt + 6;
    };

    const r = await probe.run({
        exe, tmp: TMP, label: name, waitSec: 100, until, url: GEO_URL,
        args: [
            `--disable-extensions-except=${extDir}`,
            `--load-extension=${extDir}`,
            //  The quiet origin is opened by window.open from the geo page, so
            //  the popup blocker has to be out of the way. Nothing else in this
            //  test depends on it: if the tab never appears its checks are
            //  reported as not applicable rather than as a product failure.
            '--disable-popup-blocking',
            '--deny-permission-prompts',
        ],
    });

    const rs = r.reports;
    console.log(`   ${rs.length} reports, reached phase ${phase}`);
    console.log('   ' + rs.slice(0, 10).join('\n   ') + (rs.length > 10 ? '\n   ...' : ''));

    //  The extension's own console, out of the browser's stderr log. Without it a
    //  failure below says only "nothing was cleared" -- this says which branch of
    //  the purge ran, and every branch that cannot run announces itself.
    const said = (r.log || '').split(/\r?\n/)
        .filter(l => /FreeProxy:/.test(l))
        .map(l => l.replace(/^.*?FreeProxy:\s*/, '').trim());
    if (said.length) console.log('   ext: ' + [...new Set(said)].join('\n   ext: '));
    else console.log('   ext: (the extension printed nothing at all)');

    if (!planted) return { loaded: false, r };

    ok(true, `${name}: the page got the connected country and planted a UULE cookie + localStorage`);
    console.log(`        ${planted}`);

    //  Only the document that replaced the original one. A report from the
    //  ORIGINAL document after the switch is not evidence about the purge: it
    //  planted its copies before the switch happened.
    const post = reloadAt < 0 ? [] : rs.slice(reloadAt).filter(r2 => isGeo(r2) && field(r2, 'id') !== firstId);

    ok(post.length > 0,
       `${name}: the tab that had been given a position was reloaded on the switch`,
       'no report from a new document after the switch: ' +
       rs.slice(markSwitch).filter(isGeo).join(' | '));

    if (post.length) {
        console.log(`        ${post[0]}`);
        ok(post.every(r2 => field(r2, 'luule') === '0'),
           `${name}: the reloaded page finds NO location cookie -- the previous country is gone`,
           post.filter(r2 => field(r2, 'luule') !== '0').join(' | '));
        ok(post.every(r2 => field(r2, 'lls') === '0'),
           `${name}: the reloaded page finds NO localStorage copy of the previous country`,
           post.filter(r2 => field(r2, 'lls') !== '0').join(' | '));
        ok(post.some(r2 => isAt(r2, JP)),
           `${name}: and it is answered with the NEW country`,
           post.join(' | '));
        ok(!post.some(r2 => isAt(r2, LU)),
           `${name}: nothing after the switch still reports the previous country`,
           post.filter(r2 => isAt(r2, LU)).join(' | '));
    } else {
        note(`${name}: cookie / storage / new-country checks`, 'no reloaded document to read');
    }

    //  The scoping guarantee, and the reason the storage clear is allowed to
    //  exist at all: a site that never asked where it was keeps everything.
    //
    //  READ THE ARITHMETIC OF THE TWO CHECKS BELOW CAREFULLY. The harness ends
    //  up with a SECOND document on the quiet origin, and the obvious reading of
    //  either check then measures the harness rather than the product.
    //
    //  Why a second one appears: geo.html opens the popup once per tab, guarded
    //  by its own sessionStorage marker. The purge clears localStorage for the
    //  origin that was handed a position -- geo.html's -- and Chromium's
    //  browsingData `localStorage` type takes that origin's whole DOM-storage
    //  backend with it, sessionStorage included. The reloaded geo document
    //  therefore finds no marker and opens the popup again. That is the harness
    //  re-arming itself; the extension never touched the quiet tab.
    const quietAll = rs.filter(isQuiet);
    const quietAfter = rs.slice(markSwitch).filter(r2 => isQuiet(r2) && field(r2, 'id') === quietId);
    if (!quietId) {
        note(`${name}: second-origin checks`, 'the quiet tab never reported');
    } else if (!quietAfter.length) {
        //  It reported BEFORE the switch and went silent after it. That is
        //  precisely the regression this section exists to catch -- the quiet tab
        //  was reloaded, so its document and its setInterval ended together --
        //  and it must not be allowed to leave as "not applicable".
        ok(false, `${name}: and its tab is not reloaded -- the same document is still polling`,
           `${quietId} reported ` +
           quietAll.filter(r2 => field(r2, 'id') === quietId).length +
           ' time(s), none after the switch; ids seen: ' +
           [...new Set(quietAll.map(r2 => field(r2, 'id')))].join(','));
        note(`${name}: the rest of the second-origin checks`, 'its document did not survive the switch');
    } else {
        ok(quietAfter.every(r2 => field(r2, 'ls') === '1'),
           `${name}: an origin that never asked for a position keeps its localStorage`,
           quietAfter.filter(r2 => field(r2, 'ls') !== '1').join(' | '));

        //  "Not reloaded" means NOT REPLACED. A reload ends a document and its
        //  setInterval ends with it, so the evidence is that the document which
        //  was alive when the switch happened is STILL polling afterwards -- not
        //  that no other quiet document ever came into being.
        ok(quietAfter.some(r2 => +field(r2, 'n') > 1),
           `${name}: and its tab is not reloaded -- the same document is still polling`,
           `nothing past n=1 from ${quietId}; ids seen: ` +
           [...new Set(quietAll.map(r2 => field(r2, 'id')))].join(','));
        //  Intended, and worth stating: a UULE cookie anywhere is a stored
        //  location, so it goes wherever it is -- unlike site storage, which is
        //  only cleared for the origins that were actually handed a position.
        //
        //  Read at LOAD time (`luule`), for the reason this file's header gives:
        //  BOTH pages re-plant the cookie on every load, so the live `uule` of a
        //  document that outlived the sweep reports whatever the next load put
        //  back rather than what the sweep did. A quiet document that loaded
        //  AFTER the switch is the only witness that reads that jar before
        //  touching it, and it is also proof the sweep reached an origin that
        //  never asked for a position -- which is the point of the check.
        const born = rs.slice(markSwitch).filter(r2 => isQuiet(r2) && field(r2, 'n') === '1');
        if (born.length) {
            ok(born.every(r2 => field(r2, 'luule') === '0'),
               `${name}: the location cookie is cleared on that origin too, by name`,
               born.filter(r2 => field(r2, 'luule') !== '0').join(' | '));
        } else {
            //  Nothing loaded on that origin after the switch, so the live read
            //  is all there is -- trustworthy only because no later load can
            //  have re-planted behind it.
            const last = quietAfter[quietAfter.length - 1];
            ok(field(last, 'uule') === '0',
               `${name}: the location cookie is cleared on that origin too, by name`,
               last);
        }
    }

    return { loaded: true, r };
}

// ── control: the same page, no extension ────────────────────────────
//  Without this, a browser that clears its own cookies between page loads would
//  make every check above pass for the wrong reason.
async function control(probe, name, exe) {
    console.log(`\n── ${name} control: no extension loaded ──`);
    let id = null;
    const r = await probe.run({
        exe, tmp: TMP, label: name + '-control', waitSec: 30, url: GEO_URL,
        args: ['--disable-extensions', '--disable-popup-blocking', '--deny-permission-prompts'],
        until: () => {
            const g = probe.reports.filter(isGeo);
            if (g.length && !id) id = field(g[0], 'id');
            return g.length >= 8;
        },
    });
    const g = r.reports.filter(isGeo);
    console.log('   ' + g.slice(0, 6).join('\n   '));
    if (!g.length) { note(`${name} control`, 'the page never reported'); return; }
    ok(g.every(r2 => field(r2, 'id') === id) &&
       g[g.length - 1] && field(g[g.length - 1], 'uule') === '1' &&
       field(g[g.length - 1], 'ls') === '1',
       `${name} control: with no extension the cookie and localStorage just stay there`,
       g.join(' | '));
}

(async () => {
    if (!await portFree(WS_PORT)) {
        console.log(`ABORT: 127.0.0.1:${WS_PORT} is already in use -- close the FreeProxy app first.`);
        process.exit(3);
    }

    console.log('── stage the SHIPPING extension (lib/geo-ext.js, no test seed) ──');
    const ext = new GeoExt({ log, stateDir: TMP, sourceDir: path.join(ROOT, 'Extension') });
    const prepared = await ext.prepare();
    if (!prepared) { console.log('ABORT: prepare() failed'); process.exit(3); }
    console.log(`   id ${prepared.id}  v${prepared.version}  ->  ${prepared.dir}`);

    //  The purge needs both of these. Staged, not source, because the staged
    //  copy is what the browser loads.
    const mf = JSON.parse(fs.readFileSync(path.join(prepared.dir, 'manifest.json'), 'utf8'));
    ok((mf.permissions || []).includes('cookies'), 'the staged manifest asks for "cookies"');
    ok((mf.permissions || []).includes('browsingData'), 'the staged manifest asks for "browsingData"');

    const probe = new Probe(PROBE_PORT);
    probe.serve('/geo.html', page('geo', true, QUIET_URL), 'text/html; charset=utf-8');
    probe.serve('/quiet.html', page('quiet', false, null), 'text/html; charset=utf-8');
    const bound = await probe.start();
    ok(bound.length > 0, 'probe pages served on ' + bound.join(' + '));
    if (!bound.includes('::1')) {
        note('second-origin coverage may be thin', 'localhost did not bind on ::1');
    }

    const app = new FakeApp(stateFor(LU, 'lu'));
    await app.start();
    console.log(`   fake desktop app listening on 127.0.0.1:${WS_PORT}`);

    const results = {};
    //  ONLY=brave re-runs one browser's leg. A single green run of a
    //  browser-timing test is not a pass, and re-running all of them to look at
    //  one costs four minutes a sample.
    const only = (process.env.ONLY || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
    for (const b of BROWSERS) {
        if (only.length && !only.includes(b.id) && !only.includes(b.name.toLowerCase())) continue;
        const exe = b.exe.find(p => fs.existsSync(p));
        if (!exe) { note(`${b.name}: no executable found`); continue; }
        results[b.name] = await session(probe, app, b.name, exe, prepared.dir);
        if (!results[b.name].loaded) {
            const refused = /not supported|Extensions are not|--load-extension/i
                .test(results[b.name].r.log || '');
            if (b.id === 'chrome') {
                note('Chrome: refused --load-extension, as documented',
                     refused ? 'confirmed in its own log' : 'no coordinates reached the page');
            } else {
                ok(false, `${b.name}: the page never received the connected country`,
                   'reports: ' + results[b.name].r.reports.slice(0, 8).join(' | '));
            }
        }
    }

    const positive = Object.keys(results).find(n => results[n].loaded);
    if (positive) {
        const b = BROWSERS.find(x => x.name === positive);
        await control(probe, positive, b.exe.find(p => fs.existsSync(p)));
    } else {
        note('control run', 'no browser loaded the extension, so there is nothing to control for');
    }

    app.stop();
    probe.stop();
    ext.host.stop();
    await sleep(300);

    //  WHY THE PROFILE IS READ ON A FAILURE
    //  ------------------------------------
    //  Every failing Brave run so far reported "the extension printed nothing at
    //  all" -- the one run whose diagnosis depends on the worker's console is the
    //  run that has no console. Reading it from Brave's own chrome_debug.log as
    //  well did not help either.
    //
    //  The worker's state does not depend on logging: chrome.storage.local is a
    //  LevelDB under the profile, so after the browser has exited the keys are on
    //  disk. `geoLast` and `geoOrigins` are exactly what noteLocationChange()
    //  decides on, so their values at exit say which branch it could have taken --
    //  a read-back instead of an inference.
    if (fail) dumpExtStorage(TMP);
    if (fail) console.log(`\n   profile kept for inspection: ${TMP}`);
    else { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} }

    console.log(`\n${pass}/${pass + fail} checks passed` + (skipped ? `, ${skipped} not applicable` : ''));
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ABORT: ' + e.stack); process.exit(3); });

//  Print whatever chrome.storage.local held when the browser exited. The files
//  are LevelDB, but the values are stored as plain JSON text, so the printable
//  runs around each key are readable without a LevelDB reader -- and being able
//  to read it at all matters more here than reading it prettily.
function dumpExtStorage(root) {
    const found = [];
    const walk = dir => {
        let ents = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of ents) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === 'Local Extension Settings') found.push(p);
                else walk(p);
            }
        }
    };
    walk(root);
    console.log('\n── what chrome.storage.local held when the browser exited ──');
    if (!found.length) { console.log('   (no Local Extension Settings directory in the profile)'); return; }
    for (const dir of found) {
        for (const sub of fs.readdirSync(dir)) {
            const d = path.join(dir, sub);
            let files = [];
            try { files = fs.readdirSync(d); } catch (e) { continue; }
            for (const f of files) {
                if (!/\.(log|ldb|sst)$/i.test(f)) continue;
                let buf;
                try { buf = fs.readFileSync(path.join(d, f)); } catch (e) { continue; }
                //  Printable runs of 6+ characters, then only the ones naming a
                //  key this test reasons about. LevelDB appends, so the LAST
                //  occurrence of a key is the value that was in force.
                const runs = (buf.toString('latin1').match(/[\x20-\x7e]{6,}/g) || [])
                    .filter(s => /geoLast|geoOrigins|geoSpoof/.test(s));
                for (const s of runs.slice(-12)) console.log(`   ${sub}/${f}: ${s.slice(0, 300)}`);
            }
        }
    }
}








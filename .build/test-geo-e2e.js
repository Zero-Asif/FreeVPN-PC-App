'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-geo-e2e.js  --  the one link that had never been measured.
//
//  Every earlier positive result in this project was obtained with
//  probe.js's stageExtension(), which writes a test-only geo-seed.js that
//  hands geo-spoof.js the coordinates synchronously. That proves the MAIN
//  world patch works. It does NOT prove the production chain works, because
//  geo-seed.js is not shipped.
//
//  What ships is:
//
//      desktop app  --WebSocket-->  background.js
//                   --chrome.storage.local-->  geo-bridge.js (isolated)
//                   --CustomEvent-->  geo-spoof.js (MAIN)  -->  the page
//
//  So this test stands up a fake desktop app on 127.0.0.1:8080 speaking the
//  exact wire format main.js's stateForWire()/broadcastState() produce, stages
//  the SHIPPING extension through lib/geo-ext.js (no seed file), launches real
//  browsers unelevated against a page served over http://127.0.0.1 -- a secure
//  context, so the Geolocation API is available with no certificate -- and
//  reads back what the page actually received.
//
//  Three things get proved, in one browser session each:
//
//    1. connect          -> the page reports the connected country
//    2. switch country   -> the page reports the NEW country with no reload
//                           and no repackaging of the extension
//    3. disconnect       -> the page STOPS getting spoofed coordinates
//                           (never a stale country the IP no longer backs up)
//
//  and one control: the same page in the same browser with no extension
//  loaded must NOT report those coordinates. Without the control, a harness
//  bug that echoed the expected answer would look like a pass.
//
//  Chrome is launched too, and is expected to refuse --load-extension: that
//  refusal is branded and unconditional, which is exactly why Chrome is a
//  one-time "Load unpacked" in the shipping product rather than automatic.
//  Its result is reported, not asserted.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { Probe, BROWSERS, sh, sleep } = require('./probe');
const { GeoExt } = require('../lib/geo-ext');

let WebSocketServer;
try { WebSocketServer = require('ws').Server; }
catch (e) { console.log('ABORT: the "ws" module is not installed'); process.exit(3); }

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpe2e-'));

const WS_PORT = 8080;          // what Extension/background.js hard-codes
const PROBE_PORT = 8099;

//  Two countries far enough apart that jitter (+/- 0.0004 deg) cannot
//  possibly turn one into the other.
const LU = { lat: 49.6116, lng: 6.1319, accuracy: 18, city: 'Luxembourg City', cc: 'LU' };
const JP = { lat: 35.6895, lng: 139.6917, accuracy: 18, city: 'Tokyo', cc: 'JP' };

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

// ── the page ────────────────────────────────────────────────────────
//  Polls rather than asking once, because the interesting events happen
//  WHILE the page is open: a country switch and a disconnect have to reach a
//  page that is already loaded. Each report carries a sequence number so the
//  answers can be ordered against the moment the state changed.
const LIVE_PAGE = `<!doctype html><meta charset=utf-8><title>live</title><body>live probe
<script>
var n = 0;
function send(q){ try{ fetch('/r?'+q); }catch(e){ new Image().src='/r?'+q; } }
function poll(){
  var i = ++n;
  if (!navigator.geolocation) { send('n='+i+'&no-api=1'); return; }
  navigator.geolocation.getCurrentPosition(
    function(p){ send('n='+i+'&ok='+p.coords.latitude.toFixed(4)+','+p.coords.longitude.toFixed(4)
                      +'&acc='+Math.round(p.coords.accuracy)); },
    function(e){ send('n='+i+'&err='+e.code); },
    { timeout: 3000, enableHighAccuracy: true, maximumAge: 0 });
  try {
    navigator.permissions.query({name:'geolocation'})
      .then(function(s){ send('n='+i+'&perm='+s.state); }, function(){ send('n='+i+'&perm=throw'); });
  } catch(e){}
}
poll();
setInterval(poll, 1500);
</script>`;

// ── report parsing ──────────────────────────────────────────────────
const coordsOf = r => {
    const m = /(?:^|&)ok=(-?[\d.]+),(-?[\d.]+)/.exec(r);
    return m ? { lat: +m[1], lng: +m[2] } : null;
};
const isAt = (r, c) => {
    const p = coordsOf(r);
    return !!p && Math.abs(p.lat - c.lat) < 0.01 && Math.abs(p.lng - c.lng) < 0.01;
};
const anySpoofed = rs => rs.some(r => isAt(r, LU) || isAt(r, JP));

// ── the fake desktop app ────────────────────────────────────────────
//  Byte-for-byte the shape main.js sends: stateForWire() spreads appState and
//  attaches a `geo` object, broadcastState() wraps it in
//  {type:'STATE_SYNC', state}, and a new client is sent the current state the
//  moment it connects.
function stateFor(coord, code) {
    return {
        connected: !!coord, serverCode: code || 'us', killSwitch: false,
        bypassList: '', servers: {},
        geo: coord ? { lat: coord.lat, lng: coord.lng, accuracy: coord.accuracy,
                       city: coord.city, cc: coord.cc } : null,
    };
}

class FakeApp {
    constructor(state) { this.state = state; this.clients = new Set(); this.log = []; }
    start() {
        this.wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
        this.wss.on('connection', ws => {
            this.clients.add(ws);
            this.log.push('client connected');
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
        this.log.push(`broadcast ${label} to ${n} client(s)`);
        console.log(`   -> ${label} (${n} client${n === 1 ? '' : 's'})`);
        return n;
    }
    stop() { try { this.wss.close(); } catch (e) {} for (const c of this.clients) { try { c.close(); } catch (e) {} } }
}

const portFree = port => new Promise(res => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
});

const exeFor = key => {
    //  BROWSERS comes from lib/browsers.js now, whose display names are the
    //  full product names ('Microsoft Edge'), so an id and a short label both
    //  have to resolve. Id wins first: 'Chrome' as a substring would otherwise
    //  also match 'Chromium'.
    const k = String(key).toLowerCase();
    const b = BROWSERS.find(x => x.id === k) ||
              BROWSERS.find(x => x.name.toLowerCase().includes(k));
    return b && b.exe.find(p => fs.existsSync(p)) || null;
};

// ── one browser, the whole three-phase story ────────────────────────
async function session(probe, app, name, exe, extDir) {
    console.log(`\n── ${name}: connect -> switch country -> disconnect ──`);
    app.state = stateFor(LU, 'lu');
    app.log = [];

    //  Phase machine, driven from run()'s once-a-second `until` callback so
    //  the browser stays open across all three transitions -- reloading
    //  between them would test a fresh page, not a live update.
    let phase = 0, markJP = 0, markOff = 0, drained = 0;
    const seen = { lu: null, jp: null, afterOff: [] };

    const until = () => {
        const rs = probe.reports;
        if (phase === 0) {
            const hit = rs.findIndex(r => isAt(r, LU));
            if (hit < 0) {
                //  The page is clearly alive and polling -- a dozen answers in,
                //  all of them from something other than us -- so the extension
                //  is not going to load. Give up rather than burning the full
                //  waitSec; Chrome does this on every run by design.
                return rs.length >= 24;
            }
            seen.lu = rs[hit];
            phase = 1; markJP = rs.length;
            app.set(stateFor(JP, 'jp'), 'switch to Tokyo');
            return false;
        }
        if (phase === 1) {
            const hit = rs.slice(markJP).findIndex(r => isAt(r, JP));
            if (hit < 0) return false;
            seen.jp = rs[markJP + hit];
            phase = 2; markOff = rs.length;
            app.set(stateFor(null, 'jp'), 'disconnect');
            return false;
        }
        if (phase === 2) {
            //  Answers already in flight when the disconnect went out are not
            //  evidence of anything. Let two land, then judge what follows.
            if (rs.length < markOff + 2) return false;
            drained = rs.length; phase = 3;
            return false;
        }
        if (phase === 3) {
            if (rs.length < drained + 4) return false;
            seen.afterOff = rs.slice(drained);
            return true;
        }
        return true;
    };

    const r = await probe.run({
        exe, tmp: TMP, label: name, waitSec: 75, until,
        url: `http://127.0.0.1:${probe.port}/live.html`,
        args: [
            `--disable-extensions-except=${extDir}`,
            `--load-extension=${extDir}`,
            //  Makes the disconnect phase deterministic: once the spoof is
            //  off, geo-spoof.js delegates to the REAL provider, which would
            //  otherwise sit on an unanswered permission bubble.
            '--deny-permission-prompts',
        ],
    });

    const perms = r.reports.filter(x => x.includes('perm=')).map(x => x.split('perm=')[1]);
    console.log(`   ${r.reports.length} reports, reached phase ${phase}`);
    console.log('   ' + r.reports.slice(0, 14).join('\n   ') + (r.reports.length > 14 ? '\n   ...' : ''));

    const loaded = !!seen.lu;
    if (!loaded) {
        return { loaded: false, r, perms };
    }

    ok(true, `${name}: page received the connected country over the production chain`);
    console.log(`        ${seen.lu}`);

    //  The first answer of the whole session, and the one that used to be
    //  wrong. geo-spoof.js runs at document_start, before background.js's
    //  WebSocket has said anything; if that gap resolves to "not connected"
    //  the page is handed Chromium's real provider while the VPN is up. This
    //  run is launched with --deny-permission-prompts, so a fall-through shows
    //  up unmistakably as err=1 rather than as a plausible-looking position.
    const firstAnswer = r.reports.find(x => /(?:^|&)(ok|err|no-api)=/.test(x));
    ok(isAt(firstAnswer || '', LU),
       `${name}: the FIRST geolocation call of the session already gets the connected country`,
       'got: ' + (firstAnswer || '(none)'));

    //  "no repack" is the claim: the switch travels the live WebSocket into an
    //  extension that is already installed, so no CRX is rebuilt and no browser
    //  is restarted. It is NOT a claim that the tab is not reloaded -- the
    //  location purge added for the Brave stale-country bug reloads exactly the
    //  tabs that were handed a position, and the report stream above shows it:
    //  the counter restarts at n=1 when the new country arrives, which is a new
    //  document. .build/test-geo-purge.js is where that reload is the subject.
    ok(!!seen.jp, `${name}: a country switch reaches an already-open page over the live socket, no repack`,
       'reports after the switch: ' + probe.reports.slice(markJP).join(' | '));
    if (seen.jp) console.log(`        ${seen.jp}`);
    ok(perms.includes('granted'),
       `${name}: navigator.permissions reports "granted" while spoofing`,
       'saw: ' + (perms.join(',') || 'no perm report'));
    ok(seen.afterOff.length > 0 && !anySpoofed(seen.afterOff),
       `${name}: disconnect stops the spoof -- no stale country after the app lets go`,
       'after disconnect: ' + (seen.afterOff.join(' | ') || '(no reports)'));

    //  Scoped to the window where a spoof was actually in force: everything
    //  from the first spoofed answer up to the disconnect. err=1 AFTER the
    //  disconnect is this harness's own --deny-permission-prompts answering
    //  the real provider, which is correct behaviour, not the reported bug.
    const spoofWindow = r.reports.slice(r.reports.indexOf(seen.lu), markOff);
    ok(!spoofWindow.some(x => /err=1(?:&|$)/.test(x) || /perm=denied/.test(x)),
       `${name}: nothing is ever denied while spoofing (the reported bug)`,
       spoofWindow.filter(x => /err=1(?:&|$)/.test(x) || /perm=denied/.test(x)).join(' | '));

    return { loaded: true, r, perms };
}

// ── control: the same page, no extension ────────────────────────────
async function control(probe, name, exe) {
    console.log(`\n── ${name} control: no extension loaded ──`);
    const r = await probe.run({
        exe, tmp: TMP, label: name + '-control', waitSec: 25,
        url: `http://127.0.0.1:${probe.port}/live.html`,
        args: ['--disable-extensions', '--deny-permission-prompts'],
        until: () => probe.reports.length >= 3,
    });
    console.log('   ' + r.reports.slice(0, 6).join('\n   '));
    ok(r.reports.length > 0 && !anySpoofed(r.reports),
       `${name} control: without the extension the page does NOT get our coordinates`,
       r.reports.join(' | '));
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

    ok(!fs.existsSync(path.join(prepared.dir, 'geo-seed.js')),
       'no geo-seed.js in the staged extension -- this really is the shipping chain');
    const mf = JSON.parse(fs.readFileSync(path.join(prepared.dir, 'manifest.json'), 'utf8'));
    const mainEntry = (mf.content_scripts || []).find(c => c.world === 'MAIN');
    const isoEntry = (mf.content_scripts || []).find(c => c.world === 'ISOLATED');
    ok(!!mainEntry && JSON.stringify(mainEntry.js) === '["geo-spoof.js"]',
       'the MAIN-world script is geo-spoof.js alone', JSON.stringify(mainEntry && mainEntry.js));
    ok(!!isoEntry && JSON.stringify(isoEntry.js) === '["geo-bridge.js"]',
       'the ISOLATED-world script is geo-bridge.js', JSON.stringify(isoEntry && isoEntry.js));

    const probe = new Probe(PROBE_PORT);
    probe.serve('/live.html', LIVE_PAGE, 'text/html; charset=utf-8');
    const bound = await probe.start();
    ok(bound.length > 0, 'probe page served on ' + bound.join(' + '));

    const app = new FakeApp(stateFor(LU, 'lu'));
    await app.start();
    console.log(`   fake desktop app listening on 127.0.0.1:${WS_PORT}`);

    //  EVERY Chromium fork detected on this machine, not a hardcoded three:
    //  the product has to work in whatever the user actually has installed, so
    //  the test has to be able to say what happened in each of them. Edge is
    //  the one the shipping product force-installs into, so its result is the
    //  one that must hold; Brave takes --load-extension too, and Chrome's
    //  refusal is the documented reason it needs a one-time manual load.
    const results = {};
    for (const b of BROWSERS) {
        const name = b.name;
        const exe = b.exe.find(p => fs.existsSync(p));
        if (!exe) { note(`${name}: no executable found`); continue; }
        results[name] = await session(probe, app, name, exe, prepared.dir);
        if (!results[name].loaded) {
            const refused = /not supported|Extensions are not|--load-extension/i.test(results[name].r.log || '');
            if (b.id === 'chrome') {
                note('Chrome: refused --load-extension, as documented',
                     refused ? 'confirmed in its own log' : 'no coordinates reached the page');
            } else {
                ok(false, `${name}: the page never received the connected country`,
                   'reports: ' + results[name].r.reports.slice(0, 8).join(' | '));
            }
        }
    }

    //  One control is enough to show the harness is not answering its own
    //  question; run it in whichever browser actually loaded the extension.
    const positive = Object.keys(results).find(n => results[n].loaded);
    if (positive) await control(probe, positive, exeFor(positive));
    else note('control run', 'no browser loaded the extension, so there is nothing to control for');

    app.stop();
    probe.stop();
    ext.host.stop();
    await sleep(300);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

    console.log(`\n${pass}/${pass + fail} checks passed` + (skipped ? `, ${skipped} not applicable` : ''));
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ABORT: ' + e.stack); process.exit(3); });

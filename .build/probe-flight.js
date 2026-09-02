'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-flight.js  --  drive the REAL globe and check THE FLIGHT RULES.
//
//  Run:  node_modules/electron/dist/electron.exe .build/probe-flight.js
//
//  The bug this exists for, in the user's words: "rocket ta kothai theke fly
//  kortese?" -- with Croatia connecting, the rocket was climbing out of the open
//  Atlantic. Two causes, both now deleted: a monkey-patch that copied the
//  current location over home WITHOUT its `known` flag, so an unknown home fell
//  through to a literal { lat: 0, lng: 0 }; and a second, drifted copy of the
//  country coordinate table.
//
//  Nothing static can prove the fix. "The rocket departs from where the app
//  actually is" is a claim about a curve built at runtime out of an anchor that
//  moves only when a flight resolves, so this opens the real window, calls the
//  real flyToCountry/landRocket/explodeRocket/backToHome, and after each step
//  reads the flight's own start point back out of the page and compares it with
//  globe.getCoords() of where it should have been.
//
//  THE RULES BEING CHECKED  (the specification, as given)
//  -----------------------------------------------------
//  kill switch OFF
//    * the caption names the user's own location, ring there
//    * connecting flies the rocket FROM that location
//    * success lands it in the chosen country and pulses there
//    * failure blasts it mid-flight and the ring returns to where the app was
//  kill switch ON
//    * no lookup is made, so there is no honest origin: nothing flies, but the
//      connect still lands and the ring appears in the country reached
//    * a country SWITCH always flies from the country it was connected to
//  always
//    * wherever the ring is drawn, that is where the app genuinely is -- so
//      ring coordinates must be main.js's GEO_COORDS for that country, exactly
//    * a country main.js cannot place gets its name in the caption and NO ring,
//      rather than a ring at 0,0
//    * a connect that took SEVERAL attempts behind one click still ends anchored
//      in the country reached, not at home -- the failed attempt's blast took
//      the pending record with it and there was nothing left to land
//
//  It starts no Tor, binds no port, touches no registry, and changes nothing
//  about the machine: the kill switch is exercised by setting the checkbox and
//  calling the globe's own re-ask hook, never by invoking toggle-killswitch.
// ════════════════════════════════════════════════════════════════════
const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { geoFromMainJs } = require('./geo-from-main.js');

const ROOT = path.join(__dirname, '..');
const GEO  = geoFromMainJs(ROOT);
const HOME = { lat: 52.52, lng: 13.405, city: 'Berlin', country: 'Germany', cc: 'DE' };

//  Same file-backed log as probe-window.js: Electron on Windows does not
//  reliably reach the parent shell's stdout.
const LOG = path.join(__dirname, 'probe-flight.log');
try { fs.writeFileSync(LOG, ''); } catch (e) {}
const say = console.log.bind(console);
console.log = (...a) => {
    const s = a.join(' ');
    say(s);
    try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {}
};

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

//  What gets read back out of the page after every step. All of it is state the
//  shipped code already keeps -- nothing is added to globe-controller.js for the
//  sake of being testable.
const SNAP = `(() => {
    const fc = (typeof FC !== 'undefined') ? FC : null;
    const g  = (typeof globe !== 'undefined') ? globe : null;
    //  The flight path used to be a THREE.QuadraticBezierCurve3 and this read its
    //  v0 and v2 control points directly. It is now a great circle with a sin(pi t)
    //  altitude profile and has no such fields, so the two ends are asked for the
    //  way every other caller asks: getPoint(0) and getPoint(1). They sit one PAD
    //  (0.6 units) above the ground, so each is scaled back onto the surface --
    //  which makes the comparison with globe.getCoords() exact rather than merely
    //  inside the tolerance.
    const endOf = t => {
        if (!fc || !fc.curve || typeof fc.curve.getPoint !== 'function') return null;
        const p = fc.curve.getPoint(t);
        const l = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z) || 1;
        return { x: p.x * 100 / l, y: p.y * 100 / l, z: p.z * 100 / l };
    };
    return {
        anchor: (typeof ANCHOR !== 'undefined' && ANCHOR)
            ? { kind: ANCHOR.kind, code: ANCHOR.code, name: ANCHOR.name,
                lat: ANCHOR.lat, lng: ANCHOR.lng, placed: !!ANCHOR.placed } : null,
        pending: (typeof PENDING !== 'undefined' && PENDING)
            ? { code: PENDING.code, dest: PENDING.dest ? PENDING.dest.code : null,
                outcome: PENDING.outcome } : null,
        flying: fc ? { state: fc.state, t: fc.t, dest: fc.destInfo && fc.destInfo.code } : null,
        v0: endOf(0),
        v2: endOf(1),
        trail: (fc && fc.trail) ? {
            obj:   fc.trail.line && fc.trail.line.type,
            mat:   fc.trail.mat && fc.trail.mat.type,
            blend: fc.trail.mat && fc.trail.mat.blending,
            drawn: fc.trail.geo && fc.trail.geo.drawRange ? fc.trail.geo.drawRange.count : -1,
            head:  fc.trail.mat && fc.trail.mat.uniforms ? fc.trail.mat.uniforms.uHead.value : -1,
            puffs: fc.trail.geo ? fc.trail.geo.getAttribute('position').count : -1,
        } : null,
        rings: (g && g.ringsData) ? g.ringsData().map(r => ({ lat: r.lat, lng: r.lng })) : null,
        overlay: (document.getElementById('status-overlay') || {}).innerText || null,
        home: { known: HOME_LOC.known, name: HOME_LOC.name, lat: HOME_LOC.lat, lng: HOME_LOC.lng },
        why: (typeof HOME_WHY !== 'undefined') ? String(HOME_WHY) : null,
        ks: !!(document.getElementById('killSwitchToggle') || {}).checked,
    };
})()`;

let win = null;
const run  = js => win.webContents.executeJavaScript(js, true);
const snap = () => run(SNAP);
//  Expected world position via the SAME function the flight itself used to build
//  its curve, so this compares a start point with a place and not one guess at
//  three-globe's coordinate convention with another.
const coordsFor = (lat, lng) => run(`globe.getCoords(${lat}, ${lng}, 0)`);
const dist = (a, b) => (!a || !b) ? Infinity
    : Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
//  The globe's radius is 100, so a degree of arc is about 1.75 units. 2.5 is
//  under a degree and a half: close enough that no other capital city could
//  satisfy it, loose enough not to depend on the curve's exact endpoint.
const TOL = 2.5;

async function launchedFrom(what, lat, lng, s) {
    const want = await coordsFor(lat, lng);
    const d = dist(s.v0, want);
    ok(d < TOL, `the rocket departs from ${what}`,
       `${d === Infinity ? 'no curve at all' : d.toFixed(2) + ' units away'}`);
}
async function headedFor(what, lat, lng, s) {
    const want = await coordsFor(lat, lng);
    const d = dist(s.v2, want);
    ok(d < TOL, `and is headed for ${what}`,
       `${d === Infinity ? 'no curve at all' : d.toFixed(2) + ' units away'}`);
}
//  The integrity rule: wherever the ring is, the app has to genuinely be. So a
//  country ring must sit on main.js's GEO_COORDS for that country to the digit --
//  the same table that decides what actually gets spoofed.
function ringOn(cc, s) {
    const g = GEO[cc];
    const r = (s.rings || [])[0];
    ok(!!r && Math.abs(r.lat - g.lat) < 1e-6 && Math.abs(r.lng - g.lng) < 1e-6,
       `the ring is on main.js's own coordinates for ${cc.toUpperCase()} (${g.city})`,
       JSON.stringify(s.rings));
}
function ringNear(what, lat, lng, s) {
    const r = (s.rings || [])[0];
    ok(!!r && Math.abs(r.lat - lat) < 0.01 && Math.abs(r.lng - lng) < 0.01,
       `the ring is at ${what}`, JSON.stringify(s.rings));
}
function noRing(why, s) {
    ok((s.rings || []).length === 0, `no ring is drawn ${why}`, JSON.stringify(s.rings));
}
function captions(re, s) {
    ok(re.test(s.overlay || ''), `the caption reads ${re}`, JSON.stringify(s.overlay));
}

//  Two countries far enough apart that a mistaken origin cannot pass for the
//  right one, and one code main.js has no coordinates for -- which is the case
//  that used to become a ring at 0,0.
const A = 'ro', B = 'jp', UNPLACED = 'zz';
let homeAsks = 0;
const logs = [], netHits = [];

app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
        if (/^(file|devtools|blob|data|chrome-extension):/.test(d.url)) return cb({});
        netHits.push(d.method + ' ' + d.url);
        cb({ cancel: true });
    });
    ipcMain.handle('get-geo-coords', async () => GEO);
    ipcMain.handle('get-home-location', async () => {
        homeAsks++;
        return { ok: true, reason: 'fresh', loc: HOME };
    });
    ipcMain.handle('report-killswitch', async (e, v) => ({ status: 'noted', killSwitch: !!v }));

    //  The same webPreferences main.js:981 uses. backgroundThrottling off and
    //  show true both matter here and not only for the screenshot: the flight
    //  advances on requestAnimationFrame, which a throttled window does not run.
    win = new BrowserWindow({
        width: 1000, height: 670, resizable: false, autoHideMenuBar: true, show: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false,
                          backgroundThrottling: false },
    });
    win.webContents.on('console-message', (...a) => {
        const d = (a[0] && typeof a[0] === 'object' && 'message' in a[0])
            ? a[0] : { level: a[1], message: a[2], sourceId: a[4], lineNumber: a[3] };
        logs.push({ level: String(d.level), message: String(d.message || ''),
                    where: path.basename(String(d.sourceId || '')) + ':' + (d.lineNumber || 0) });
    });
    let died = null;
    win.webContents.on('render-process-gone', (e, d) => { died = d.reason; });

    await win.loadFile(path.join(ROOT, 'index.html'));
    //  The globe is built 650 ms after DOMContentLoaded and the home lookup
    //  resolves an IPC round trip later.
    await sleep(4500);
    await scenarioKillSwitchOff();
    await scenarioSecondAttempt();
    await scenarioKillSwitchOn();
    await scenarioUnplaced();
    report(died);
    win.destroy();
    app.exit(fail ? 1 : 0);
}).catch(err => {
    console.log('  FAIL the probe itself threw  -- ' + (err && err.stack || err));
    app.exit(1);
});

async function scenarioKillSwitchOff() {
    console.log('\n══ kill switch OFF, home known ══');
    let s = await snap();
    console.log('   overlay ' + JSON.stringify(s.overlay) + '   anchor ' + JSON.stringify(s.anchor));
    ok(s.home.known === true && s.why === 'ok',
       'the lookup answered, so the app knows where the user is', JSON.stringify(s.home));
    ok(!!s.anchor && s.anchor.kind === 'home', 'and is anchored there',
       JSON.stringify(s.anchor));
    //  Photo 1 of the bug report: this said "Home location unavailable" with the
    //  kill switch OFF and nothing connected, which is the one state where it
    //  must name the user's own location instead.
    captions(/Standing by in Berlin, Germany/, s);
    ringNear("the user's own location", HOME.lat, HOME.lng, s);

    console.log('\n── connecting: the rocket leaves from where the user is ──');
    await run(`window.flyToCountry('${A}')`);
    captions(/Routing to Romania/, await snap());
    await sleep(1600);
    s = await snap();
    ok(!!s.flying && s.flying.state === 'flying' && s.flying.dest === A,
       'a rocket is in the air for it', JSON.stringify(s.flying));
    //  Photo 2 of the bug report: this launched out of the open ocean.
    await launchedFrom("the user's own location, not 0,0", HOME.lat, HOME.lng, s);
    await headedFor(`${A.toUpperCase()}'s capital`, GEO[A].lat, GEO[A].lng, s);
    ok(!!s.anchor && s.anchor.kind === 'home',
       'and the anchor has not moved: a launch is not an arrival', JSON.stringify(s.anchor));

    console.log('\n── the trail is smoke, not a drawn line ──');
    ok(!!s.trail && s.trail.obj === 'Points' && s.trail.mat === 'ShaderMaterial',
       'the plume is a cloud of sprites, not a one-pixel THREE.Line',
       JSON.stringify(s.trail));
    ok(!!s.trail && s.trail.blend === 1,
       'blended normally, so it reads as lit smoke rather than as a laser',
       String(s.trail && s.trail.blend));
    ok(!!s.trail && s.trail.puffs >= 500, `${s.trail && s.trail.puffs} puffs make it up`);
    const drawn0 = s.trail.drawn, head0 = s.trail.head;
    //  Three seconds, not one: the climb is eased in over FLIGHT_MS = 90 s, so
    //  the rocket covers a fraction of a percent of the arc in the first second
    //  and the 900-puff plume only reaches its second puff at about t = 0.0011.
    //  A shorter sample would read "the plume never grows" off a rocket that is
    //  simply still accelerating.
    await sleep(3000);
    const s2 = await snap();
    ok(!!s2.trail && s2.trail.drawn > drawn0 && s2.trail.head > head0,
       'and it grows out behind the rocket as it climbs',
       `${drawn0} -> ${s2.trail && s2.trail.drawn} puffs drawn, ` +
       `head ${head0} -> ${s2.trail && s2.trail.head}`);

    console.log('\n── success: it lands there, and pulses there ──');
    await run('window.landRocket()');
    await sleep(2600);
    s = await snap();
    ok(s.flying === null, 'the flight is over', JSON.stringify(s.flying));
    ok(!!s.anchor && s.anchor.kind === 'country' && s.anchor.code === A,
       'the app is anchored in the country it reached', JSON.stringify(s.anchor));
    ringOn(A, s);
    captions(/Secured & Routed via Romania/, s);
    ok(s.pending === null, 'and nothing is left pending', JSON.stringify(s.pending));

    console.log('\n── a switch flies from the country it was on ──');
    await run(`window.flyToCountry('${B}')`);
    await sleep(1600);
    s = await snap();
    ok(!!s.flying && s.flying.dest === B, 'a rocket is in the air for the new country',
       JSON.stringify(s.flying));
    await launchedFrom(`${A.toUpperCase()}, the country it was connected to`,
                       GEO[A].lat, GEO[A].lng, s);
    await headedFor(B.toUpperCase(), GEO[B].lat, GEO[B].lng, s);

    console.log('\n── failure: it blasts in flight, and the ring goes back ──');
    await run('window.explodeRocket()');
    captions(/Connection Failed/, await snap());
    //  Blast, then +2200 ms "Returning to", then +2400 ms the ring.
    await sleep(5200);
    s = await snap();
    ok(s.flying === null, 'the rocket is gone', JSON.stringify(s.flying));
    ok(!!s.anchor && s.anchor.code === A,
       'and the app is still anchored where it actually still is',
       JSON.stringify(s.anchor));
    ringOn(A, s);
    captions(/Secured & Routed via Romania/, s);

    console.log('\n── disconnect: home again ──');
    await run('window.backToHome()');
    await sleep(4800);
    s = await snap();
    ok(!!s.anchor && s.anchor.kind === 'home', 'anchored at home', JSON.stringify(s.anchor));
    ringNear("the user's own location", HOME.lat, HOME.lng, s);
    captions(/Standing by in Berlin, Germany/, s);
}

//  ONE CLICK, SEVERAL ATTEMPTS  --  reported 2026-08-31 with a screenshot.
//
//  The user pressed Connect for the United States. The first attempt failed, the
//  country-unavailable dialog offered its three choices, they picked "keep trying
//  until it connects", and it did connect -- yet the app showed DISCONNECT,
//  Protected, a running timer and "United States" in the dropdown while the ring
//  pulsed over Motijheel, Bangladesh and the caption still read "Standing by in
//  Motijheel, Bangladesh".
//
//  Why: the failed attempt had already blasted the rocket, and a blast clears
//  PENDING. When the retry succeeded there was no rocket to land and no attempt
//  on record either, so landing was a silent no-op and the anchor stayed home.
//  The exit country is now passed to landRocket() for exactly this case.
async function scenarioSecondAttempt() {
    console.log('\n══ one click, several attempts: the first fails, a later one connects ══');
    await run(`window.flyToCountry('${A}')`);
    await sleep(1600);
    let s = await snap();
    ok(!!s.flying && s.flying.dest === A, 'the first attempt puts a rocket in the air',
       JSON.stringify(s.flying));

    await run('window.explodeRocket()');
    await sleep(5200);
    s = await snap();
    ok(!!s.anchor && s.anchor.kind === 'home' && s.pending === null,
       'it fails, so the app is back home with nothing pending -- and the dialog is up',
       JSON.stringify(s.anchor) + ' pending=' + JSON.stringify(s.pending));

    //  What the renderer used to do here, and the whole bug: there is nothing
    //  left to land. Asserted rather than assumed, because it is also correct --
    //  a landing with no attempt and no country named has no place to go.
    await run('window.landRocket()');
    await sleep(400);
    s = await snap();
    ok(!!s.anchor && s.anchor.kind === 'home',
       'landing with no country named still cannot move it: nothing is on record',
       JSON.stringify(s.anchor));

    //  What it does now: the verified exit country, which is the one thing the
    //  renderer does know at that moment.
    await run(`window.landRocket('${A}')`);
    await sleep(500);
    s = await snap();
    ok(!!s.anchor && s.anchor.kind === 'country' && s.anchor.code === A,
       'told where the tunnel came out, it anchors there', JSON.stringify(s.anchor));
    ringOn(A, s);
    captions(/Secured & Routed via Romania/, s);
    ok(s.pending === null, 'and nothing is left pending', JSON.stringify(s.pending));

    //  The settle re-records the attempt to place it, which schedules a launch
    //  960 ms out. It must not go: the tunnel is already up.
    await sleep(1600);
    s = await snap();
    ok(s.flying === null, 'no rocket takes off out of the settle afterwards',
       JSON.stringify(s.flying));
    ringOn(A, s);

    //  The renderer's progress record and its connect reply can both land the
    //  same success. The second one has to be a no-op.
    await run(`window.landRocket('${A}')`);
    await sleep(400);
    s = await snap();
    ok(!!s.anchor && s.anchor.code === A && s.flying === null,
       'landing the same country twice changes nothing', JSON.stringify(s.anchor));
    ringOn(A, s);
    captions(/Secured & Routed via Romania/, s);

    await run('window.backToHome()');
    await sleep(4800);
    s = await snap();
    ok(!!s.anchor && s.anchor.kind === 'home', 'and it disconnects back home as usual',
       JSON.stringify(s.anchor));
}

async function scenarioKillSwitchOn() {
    console.log('\n══ kill switch ON, home deliberately unknown ══');
    //  The toggle is set and the globe's own re-ask hook is called directly. The
    //  change event is deliberately NOT dispatched, so renderer.js never invokes
    //  toggle-killswitch and this probe changes nothing about the machine's
    //  firewall, proxy or registry -- only what the window believes.
    await run("document.getElementById('killSwitchToggle').checked = true;" +
              'window.refreshHomeLocation();');
    await sleep(700);
    let s = await snap();
    ok(s.ks === true && s.home.known === false && s.why === 'killswitch',
       'no lookup was made, so the app does not know where the user is either',
       JSON.stringify(s.home) + ' why=' + s.why);
    ok(s.anchor === null, 'and there is no anchor for anything to launch from',
       JSON.stringify(s.anchor));
    noRing('while the app has no place it can honestly claim', s);
    captions(/[Kk]ill switch on/, s);

    console.log('\n── connecting: nothing flies, but the connect still lands ──');
    await run(`window.flyToCountry('${A}')`);
    await sleep(1800);
    s = await snap();
    ok(s.flying === null, 'no rocket was launched out of nowhere', JSON.stringify(s.flying));
    ok(!!s.pending && s.pending.code === A, 'the attempt is recorded all the same',
       JSON.stringify(s.pending));
    await run('window.landRocket()');
    await sleep(500);
    s = await snap();
    ok(!!s.anchor && s.anchor.code === A,
       'and on success the app is anchored in the country it reached',
       JSON.stringify(s.anchor));
    ringOn(A, s);
    captions(/Secured & Routed via Romania/, s);

    console.log('\n── and now a switch DOES fly: both ends are exit countries ──');
    await run(`window.flyToCountry('${B}')`);
    await sleep(1600);
    s = await snap();
    ok(!!s.flying && s.flying.dest === B,
       'a rocket is in the air with the kill switch still on', JSON.stringify(s.flying));
    await launchedFrom(`${A.toUpperCase()}, the country it was connected to`,
                       GEO[A].lat, GEO[A].lng, s);
    await run('window.landRocket()');
    await sleep(2600);
    s = await snap();
    ok(!!s.anchor && s.anchor.code === B, 'and it lands in the new one',
       JSON.stringify(s.anchor));
    ringOn(B, s);
}

async function scenarioUnplaced() {
    console.log('\n══ a country main.js has no coordinates for ══');
    await run(`window.flyToCountry('${UNPLACED}')`);
    await sleep(1700);
    let s = await snap();
    ok(s.flying === null, 'no rocket launches towards a place with no position',
       JSON.stringify(s.flying));
    await run('window.landRocket()');
    await sleep(600);
    s = await snap();
    ok(!!s.anchor && s.anchor.code === UNPLACED && s.anchor.placed === false,
       'the app still records that the tunnel is out through it',
       JSON.stringify(s.anchor));
    //  The honest half of the fix: the caption names it, because that really is
    //  where the traffic goes, and no ring is drawn, because there is no point on
    //  the globe that would be true. This is exactly where a ring at 0,0 in the
    //  Gulf of Guinea used to appear.
    noRing('for a country the app cannot place', s);
    captions(/Secured & Routed via/, s);

    //  Put the window back the way it was found: disconnected, kill switch off,
    //  home lookup allowed again.
    await run('window.backToHome();' +
              "document.getElementById('killSwitchToggle').checked = false;" +
              'window.refreshHomeLocation();');
    await sleep(1800);
    s = await snap();
    ok(!!s.anchor && s.anchor.kind === 'home' && s.home.known === true,
       'releasing the kill switch asks again, and the home ring comes back',
       JSON.stringify(s.anchor));
}

function report(died) {
    console.log('\n── and nothing else happened while all that ran ──');
    ok(!died, 'the renderer did not crash', String(died));
    ok(!netHits.length, 'not one request left the window during any of it',
       JSON.stringify(netHits));
    //  Once at startup, once when the kill switch was released. Not once per
    //  connect, and never while it was on.
    ok(homeAsks === 2,
       'the location was asked for exactly twice: at startup, and when the kill ' +
       'switch came off', homeAsks + ' ask(s)');
    const EXPECTED = /Multiple instances of Three\.js|No handler registered/i;
    const bad = logs.filter(l => (l.level === 'error' || l.level === '3' ||
                                  l.level === 'warning' || l.level === '2') &&
                                 !EXPECTED.test(l.message));
    ok(!bad.length, "no unexplained error or warning from the app's own scripts",
       bad.map(l => `[${l.where}] ${l.message}`).join(' | '));
    console.log('');
    console.log(`${pass}/${pass + fail} checks passed`);
    if (fail) console.log(`${fail} FAILED`);
}

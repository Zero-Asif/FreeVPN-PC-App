'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-flight-bdcl.js  --  the reported flight, in the real renderer.
//
//  Run:  node_modules/electron/dist/electron.exe .build/probe-flight-bdcl.js
//
//  THE REPORT, with two screenshots: connecting Bangladesh -> Chile, the rocket
//  did not climb out of Bangladesh -- it appeared out of the open Indian Ocean
//  already in flight -- and instead of coming down on Chile it went into the sea
//  beside it. The radar ring was right in both frames.
//
//  .build/test-flight-path.js proves the arithmetic with a stub for THREE and a
//  stub for globe.getCoords(). This file removes both stubs: it opens the real
//  window, connects Bangladesh -> Chile through the real flyToCountry(), and
//  measures the REAL FC.curve and the REAL rocketMesh.position -- three-globe's
//  own coordinate convention, the vendored THREE, no re-implementation of either.
//
//  It also writes three PNGs next to this file, at the two moments the report is
//  about: the launch out of Bangladesh, and the arrival over Chile.
//
//  Every request the window makes is cancelled, no Tor is started, no port is
//  bound and nothing about the machine is touched. The camera is aimed by hand
//  and the flight is shuttled forward by moving fc.startTime -- neither changes
//  the path, which is the thing being measured.
// ════════════════════════════════════════════════════════════════════
const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { geoFromMainJs } = require('./geo-from-main.js');

const ROOT = path.join(__dirname, '..');
const GEO  = geoFromMainJs(ROOT);
const BD   = GEO.bd, CL = GEO.cl;
//  The user's own situation: the app is in Bangladesh and connects to Chile.
const HOME = { lat: BD.lat, lng: BD.lng, city: BD.city, country: 'Bangladesh', cc: 'BD' };

const LOG = path.join(__dirname, 'probe-flight-bdcl.log');
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

//  Everything asked of the page. The whole point is that the curve is the real
//  one, so it is sampled where it lives rather than rebuilt out here.
const MEASURE = `(() => {
    if (!FC || !FC.curve) return { none: true };
    const c = FC.curve, R = 100;
    let minR = Infinity, maxR = 0, off = 0;
    const uS = c.getPoint(0).clone().normalize();
    const uE = c.getPoint(1).clone().normalize();
    const nrm = uS.clone().cross(uE);
    const planar = nrm.length() > 1e-9 ? nrm.normalize() : null;
    //  Dense at the ends: a path that hugged the chord dipped under exactly there,
    //  and evenly spaced samples step straight over the dip.
    const ts = [];
    for (let i = 0; i <= 2000; i++) ts.push(i / 2000);
    for (let i = 1; i <= 80; i++) { ts.push(i / 8000); ts.push(1 - i / 8000); }
    for (const t of ts) {
        const p = c.getPoint(t), r = p.length();
        if (!isFinite(r)) return { nan: true };
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (planar) off = Math.max(off, Math.abs(p.clone().normalize().dot(planar)));
    }
    //  Signed attitude at each end: positive is climbing away from the ground.
    const elev = t => {
        const p = c.getPoint(t);
        const q = c.getPoint(t + (t < 0.5 ? 1e-3 : -1e-3));
        const step = (t < 0.5 ? q.clone().sub(p) : p.clone().sub(q));
        return Math.asin(Math.max(-1, Math.min(1,
            step.dot(p.clone().normalize()) / (step.length() || 1)))) * 180 / Math.PI;
    };
    return {
        minR, maxR, off, launch: elev(0), land: elev(1),
        span: uS.angleTo(uE) * 180 / Math.PI,
        start: { x: c.getPoint(0).x, y: c.getPoint(0).y, z: c.getPoint(0).z },
        end:   { x: c.getPoint(1).x, y: c.getPoint(1).y, z: c.getPoint(1).z },
        t: FC.t,
        //  The mesh itself, which is what is actually on screen. Its origin is its
        //  TAIL, so this radius is the bottom of the rocket, not its middle.
        mesh: rocketMesh && rocketMesh.visible
            ? { r: rocketMesh.position.length(), vis: true } : { r: -1, vis: false },
    };
})()`;

let win = null;
const run  = js => win.webContents.executeJavaScript(js, true);
const logs = [], netHits = [];
let died = null;

const shoot = async (name) => {
    const img = await win.webContents.capturePage();
    const file = path.join(__dirname, name);
    fs.writeFileSync(file, img.toPNG());
    console.log('   wrote ' + path.basename(file) + ' (' + img.getSize().width + 'x' +
                img.getSize().height + ')');
};

app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
        if (/^(file|devtools|blob|data|chrome-extension):/.test(d.url)) return cb({});
        netHits.push(d.method + ' ' + d.url);
        cb({ cancel: true });
    });
    ipcMain.handle('get-geo-coords', async () => GEO);
    ipcMain.handle('get-home-location', async () => ({ ok: true, reason: 'fresh', loc: HOME }));
    ipcMain.handle('report-killswitch', async (e, v) => ({ status: 'noted', killSwitch: !!v }));

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
    win.webContents.on('render-process-gone', (e, d) => { died = d.reason; });

    await win.loadFile(path.join(ROOT, 'index.html'));
    await sleep(4500);
    await flight();
    report();
    win.destroy();
    app.exit(fail ? 1 : 0);
}).catch(err => {
    console.log('  FAIL the probe itself threw  -- ' + (err && err.stack || err));
    app.exit(1);
});

async function flight() {
    console.log(`══ ${HOME.city}, Bangladesh -> ${CL.city}, Chile ══`);
    console.log(`   from ${BD.lat}, ${BD.lng}   to ${CL.lat}, ${CL.lng}`);
    await run("window.flyToCountry('cl'); null");
    await sleep(1800);

    let m = await run(MEASURE);
    if (m.none || m.nan) {
        fail++;
        console.log('  FAIL there is no usable curve at all  -- ' + JSON.stringify(m));
        return;
    }
    console.log(`   ${m.span.toFixed(1)} deg apart;  path radius ` +
                `${m.minR.toFixed(2)} .. ${m.maxR.toFixed(2)}  (surface = 100)`);
    console.log(`   launch ${m.launch.toFixed(1)} deg, landing ${m.land.toFixed(1)} deg ` +
                `above the local horizon`);

    //  Photo 1: the rocket appeared out of the open Indian Ocean, in flight.
    ok(m.minR >= 100, 'the path never passes under the surface anywhere along it',
       `dips to ${m.minR.toFixed(2)}, i.e. ${(100 - m.minR).toFixed(2)} units underground`);
    ok(m.launch > 5, 'it climbs OUT of Bangladesh rather than nosing into it',
       `launch attitude ${m.launch.toFixed(1)} deg`);
    //  Photo 2: it went into the sea beside Chile and rose back out of it.
    ok(m.land < -5, 'it comes DOWN onto Chile rather than rising into it out of the sea',
       `landing attitude ${m.land.toFixed(1)} deg`);
    ok(m.off < 1e-6, 'the ground track is the great circle between the two capitals',
       `off-plane component ${m.off.toExponential(2)}`);

    //  The endpoints against three-globe's own getCoords, not against my idea of it.
    const want = async (lat, lng) => run(`globe.getCoords(${lat}, ${lng}, 0)`);
    const dirOff = (p, q) => {
        const n = v => { const l = Math.hypot(v.x, v.y, v.z) || 1;
                         return { x: v.x / l, y: v.y / l, z: v.z / l }; };
        const a = n(p), b = n(q);
        return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    };
    ok(dirOff(m.start, await want(BD.lat, BD.lng)) < 1e-9,
       'it starts directly over Bangladesh',
       dirOff(m.start, await want(BD.lat, BD.lng)).toExponential(2));
    ok(dirOff(m.end, await want(CL.lat, CL.lng)) < 1e-9,
       'and ends directly over Chile',
       dirOff(m.end, await want(CL.lat, CL.lng)).toExponential(2));

    //  ── the mesh, which is what is on screen ────────────────────────
    console.log('\n── the rocket mesh itself, at launch ──');
    ok(m.mesh.vis, 'a rocket is visible', JSON.stringify(m.mesh));
    ok(m.mesh.r >= 100, 'and its tail -- its origin -- is on or above the ground',
       `radius ${m.mesh.r.toFixed(2)}`);
    //  The camera is aimed by hand for the picture only. flyToCountry() pulls it
    //  out to altitude 3.8 and then tweens to 2.8 over five seconds, and that tween
    //  wins against anything set while it is still running -- the first two attempts
    //  at these pictures came out at 2.8 over Asia for exactly that reason. So it is
    //  left to finish first. The rocket is still barely off the pad at 7.5 s: the
    //  ease-in makes t about 0.014 of a 90-second flight.
    await sleep(5800);
    await run(`globe.pointOfView({ lat: ${BD.lat}, lng: ${BD.lng}, altitude: 0.85 }, 900); null`);
    await sleep(1600);
    await shoot('probe-bdcl-launch.png');

    //  ── shuttled to the far end of the flight ───────────────────────
    //  fc.startTime is the flight's only clock, so moving it back 85 s puts the
    //  rocket at the 0.92 the flight caps at. The path is untouched.
    console.log('\n── shuttled forward to the end of the cruise ──');
    await run('FC.startTime = Date.now() - 85000');
    await sleep(700);
    m = await run(MEASURE);
    console.log(`   t = ${m.t.toFixed(3)},  mesh radius ${m.mesh.r.toFixed(2)}`);
    ok(m.mesh.r >= 100, 'the rocket is still above the ground near the far end',
       `radius ${m.mesh.r.toFixed(2)}`);
    await run(`globe.pointOfView({ lat: ${CL.lat}, lng: ${CL.lng}, altitude: 0.85 }, 900); null`);
    await sleep(1600);
    m = await run(MEASURE);
    ok(m.mesh.r >= 100, 'and still above it with the camera over Chile',
       `radius ${m.mesh.r.toFixed(2)}`);
    await shoot('probe-bdcl-approach.png');

    //  ── the landing run, which is where it went into the sea ────────
    console.log('\n── the landing run ──');
    await run('window.landRocket("cl"); null');
    //  Sampled across the descent rather than at one instant: the old curve was
    //  under the surface for the whole last stretch, so any instant would do, but
    //  a sweep says so without having to pick the right one.
    let worst = Infinity, worstT = -1;
    for (let i = 0; i < 24; i++) {
        const s = await run('(FC ? { r: rocketMesh.position.length(), t: FC.t } : null)');
        if (s && s.r < worst) { worst = s.r; worstT = s.t; }
        if (i === 12) await shoot('probe-bdcl-landing.png');
        await sleep(90);
    }
    console.log(`   lowest the rocket ever got during the descent: ` +
                `${worst === Infinity ? 'n/a' : worst.toFixed(2)} at t = ${worstT.toFixed(3)}`);
    ok(worst >= 100, 'it never dips below the surface on the way down',
       `reached ${worst.toFixed(2)}, i.e. ${(100 - worst).toFixed(2)} units underground`);

    await sleep(2600);
    const rings = await run('globe.ringsData().map(r => ({ lat: r.lat, lng: r.lng }))');
    ok(rings.length === 1 && Math.abs(rings[0].lat - CL.lat) < 1e-6 &&
       Math.abs(rings[0].lng - CL.lng) < 1e-6,
       'and the ring ends up on Chile, where the report already had it right',
       JSON.stringify(rings));
}

function report() {
    console.log('\n── and nothing else happened while all that ran ──');
    ok(!died, 'the renderer did not crash', String(died));
    ok(!netHits.length, 'not one request left the window',
       JSON.stringify(netHits.slice(0, 6)));
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

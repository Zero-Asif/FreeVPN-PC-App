'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-globe-asitopens.js  --  the app as the user opens it, untouched.
//
//  Run:  node_modules/electron/dist/electron.exe .build/probe-globe-asitopens.js
//
//  Every other probe here aims the camera somewhere in particular: over the
//  sub-solar point, over Bangladesh, over Chile. That is what makes them
//  comparable, and it is also their one weakness -- a lighting change judged only
//  from the spot it was tuned for is not judged at all. The report's third
//  screenshot was of the app simply sitting there, rotating, at the camera the app
//  chose for itself.
//
//  So this file changes nothing. It does not touch pointOfView, it does not stop
//  autoRotate, it sets no light and no material. It opens index.html, waits, and
//  photographs the window four times as the globe turns 0.25 deg/s past every
//  longitude the user would see in the first minute. Each frame is measured the
//  same way probe-globe-bright.js measures its one frame, so "no featureless white
//  anywhere in a full rotation" is a number rather than an impression.
//
//  Nothing is started, no port is bound, every request the window makes is
//  cancelled.
// ════════════════════════════════════════════════════════════════════
const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { geoFromMainJs } = require('./geo-from-main.js');

const ROOT = path.join(__dirname, '..');
const GEO  = geoFromMainJs(ROOT);
const HOME = { lat: 23.8103, lng: 90.4125, city: 'Dhaka', country: 'Bangladesh', cc: 'BD' };
const TAG  = process.env.GA_TAG || 'after';

const LOG = path.join(__dirname, `probe-globe-asitopens-${TAG}.log`);
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

let win = null;
const run  = js => win.webContents.executeJavaScript(js, true);
const logs = [], netHits = [];
let died = null;

//  Same rule as probe-globe-bright.js, so the two files' numbers mean the same
//  thing: a pixel is blown when all three channels are at the top, because then
//  neither the land's colour nor the bump map's relief has survived.
async function frame(name) {
    const img = await win.webContents.capturePage();
    const { width, height } = img.getSize();
    const buf = img.getBitmap();
    fs.writeFileSync(path.join(__dirname, name), img.toPNG());
    const x0 = Math.round(410 * (width / 1000));
    let n = 0, white = 0, hot = 0, sum = 0;
    for (let y = 0; y < height; y++) {
        for (let x = x0; x < width; x++) {
            const i = (y * width + x) * 4;
            const b = buf[i], g = buf[i + 1], r = buf[i + 2];
            if (r + g + b < 90) continue;
            n++;
            const m = Math.max(r, g, b);
            sum += m;
            if (r >= 250 && g >= 250 && b >= 250) white++;
            else if (m >= 250) hot++;
        }
    }
    return { px: n, white, hot, whitePct: n ? 100 * white / n : 0,
             hotPct: n ? 100 * hot / n : 0, mean: n ? sum / n / 255 : 0, file: name };
}

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
    await sleep(6000);
    await shots();
    report();
    win.destroy();
    app.exit(fail ? 1 : 0);
}).catch(err => {
    console.log('  FAIL the probe itself threw  -- ' + (err && err.stack || err));
    app.exit(1);
});

async function shots() {
    //  Read back, not assumed: the lights the shipped file actually leaves in the
    //  scene. If globe.gl's pair were still burning, everything below would be
    //  measuring a picture the user will not get.
    const lights = await run(`(() => { const out = [];
        globe.scene().traverse(o => { if (o.isLight) out.push(
            { kind: o.type, i: +o.intensity.toFixed(3), col: o.color.getHexString(),
              pos: [o.position.x, o.position.y, o.position.z] }); });
        const gm = globe.globeMaterial();
        return { out, spec: gm.specular.getHexString(), shin: gm.shininess,
                 bump: gm.bumpScale, tone: globe.renderer().toneMapping,
                 cam: globe.pointOfView() }; })()`);
    console.log('── what the shipped file leaves in the scene ──');
    for (const l of lights.out) {
        console.log(`   ${l.kind.padEnd(17)} intensity ${String(l.i).padEnd(5)} ` +
                    `#${l.col}  at (${l.pos.join(', ')})`);
    }
    console.log(`   globe material: specular #${lights.spec}, shininess ${lights.shin}, ` +
                `bumpScale ${lights.bump};  renderer toneMapping ${lights.tone}`);
    console.log(`   camera as the app chose it: lat ${lights.cam.lat.toFixed(1)}, ` +
                `lng ${lights.cam.lng.toFixed(1)}, altitude ${lights.cam.altitude.toFixed(2)}`);

    const vendor = lights.out.filter(l => l.i === 0);
    ok(vendor.length === 2 && vendor.some(l => l.col === 'bbbbbb'),
       "globe.gl's own two lights are silenced in the running app, not just in theory",
       JSON.stringify(lights.out));
    ok(lights.out.filter(l => l.i > 0).length === 2,
       'and exactly two lights are lighting the globe',
       JSON.stringify(lights.out.filter(l => l.i > 0)));
    ok(lights.spec === '000000', 'the specular really is black', '#' + lights.spec);
    ok(lights.tone === 0, 'and no tone mapping was switched on behind the scenes',
       String(lights.tone));

    //  0.25 deg/s: 40 s of rotation is 10 deg of longitude, which is not a lot.
    //  The four frames are spaced to catch the report's own view first and then let
    //  the terminator walk across the deserts it ringed.
    console.log('\n── four frames, camera and rotation left exactly as the app set them ──');
    const at = [0, 20000, 40000, 60000];
    const got = [];
    for (let i = 0; i < at.length; i++) {
        if (i) await sleep(at[i] - at[i - 1]);
        const cam = await run('globe.pointOfView()');
        const f = await frame(`probe-globe-asitopens-${TAG}-${i}.png`);
        got.push(f);
        console.log(`   t+${String(Math.round((6000 + at[i]) / 1000)).padStart(2)}s  ` +
                    `lng ${cam.lng.toFixed(1).padStart(6)}  white ${f.whitePct.toFixed(2)}%  ` +
                    `hot ${f.hotPct.toFixed(2)}%  mean ${f.mean.toFixed(3)}  ${f.file}`);
    }
    const worst = got.reduce((a, b) => (b.whitePct > a.whitePct ? b : a));
    const dimmest = got.reduce((a, b) => (b.mean < a.mean ? b : a));
    ok(worst.whitePct < 1.0,
       'no frame in a full minute of rotation has a featureless white region',
       `worst is ${worst.whitePct.toFixed(2)}% in ${worst.file}`);
    ok(dimmest.mean > 0.30,
       'and none of them is merely dim',
       `dimmest mean brightest channel ${dimmest.mean.toFixed(3)} in ${dimmest.file}`);
}

function report() {
    console.log('\n── and nothing else happened while all that ran ──');
    ok(!died, 'the renderer did not crash', String(died));
    ok(!netHits.length, 'not one request left the window',
       JSON.stringify(netHits.slice(0, 6)));
    const EXPECTED = /Multiple instances of Three\.js|No handler registered|getBitmap\(\) is deprecated/i;
    const bad = logs.filter(l => (l.level === 'error' || l.level === '3' ||
                                  l.level === 'warning' || l.level === '2') &&
                                 !EXPECTED.test(l.message));
    ok(!bad.length, "no unexplained error or warning from the app's own scripts",
       bad.map(l => `[${l.where}] ${l.message}`).join(' | '));
    console.log('');
    console.log(`${pass}/${pass + fail} checks passed`);
    if (fail) console.log(`${fail} FAILED`);
}

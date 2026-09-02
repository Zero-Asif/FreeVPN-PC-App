'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-globe-light-sweep.js  --  ten lightings, measured, then one is
//  chosen. Nothing in globe-controller.js is edited by this file.
//
//  Run:  node_modules/electron/dist/electron.exe .build/probe-globe-light-sweep.js
//
//  .build/probe-globe-bright.js established the before-state: 32.93% of the lit
//  globe is pure white with no land colour left in it, and the reason is that the
//  sub-solar point receives far more light than 1.0x albedo. It also turned up the
//  cause, which was not in globe-controller.js at all:
//
//    vendor/globe.gl.min.js does  renderObjs.objects([ new AmbientLight(0xbbbbbb),
//                                 new DirectionalLight(0xffffff, 0.6), globe ])
//
//  so a scene already has an ambient of 0.733 (0xbb = 187/255) and a directional
//  of 0.6 in it before globe-controller.js adds its own AmbientLight(0.28) and
//  DirectionalLight(1.55). The comment above that code reasons about ambient 0.28
//  as though it were the whole ambient -- "Ambient used to be 0.55, which
//  flattened the earth into a poster" -- while the real ambient is 1.013, nearly
//  twice the 0.55 that was diagnosed as flattening it. The directional was then
//  pushed to 1.55 to win back a terminator against that flat fill, and 1.55 on a
//  desert of albedo 0.72 is what the user ringed in red.
//
//  Which of the ten fixes is best is not something to decide by reasoning about
//  it, so this file applies each one to the running app and photographs it. Per
//  candidate it measures three views:
//
//    wide   the view the user actually has, altitude 2.8 over the sub-solar point:
//           how much is blown out, how bright it still is, the on-screen colour of
//           each region they ringed, and whether the stars survived
//    close  altitude 0.62, the same stress view probe-globe-bright.js gates on, so
//           its 32.93% has something directly comparable
//    night  altitude 2.8 over the ANTI-solar point: the city lights and the dark
//           sea, because a fix that dims those has broken something else
//
//  Candidate 0 is the shipped lighting, measured in this same process by this same
//  code, so the before and after numbers are comparable by construction.
//
//  Nothing is started, no port is bound, every request is cancelled, and the only
//  things touched are the camera, four light intensities and the renderer's tone
//  mapping -- all in a window that is destroyed at the end.
// ════════════════════════════════════════════════════════════════════
const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { geoFromMainJs } = require('./geo-from-main.js');

const ROOT = path.join(__dirname, '..');
const GEO  = geoFromMainJs(ROOT);
const HOME = { lat: 23.8103, lng: 90.4125, city: 'Dhaka', country: 'Bangladesh', cc: 'BD' };
//  Where SUN_DIR = (260, 140, 190) points: r = 351.14, so lat = asin(140/r) =
//  23.5 N and lng = atan2(190, 260) = 53.9 E. Over the Arabian desert, which is
//  why the ringed regions are the bright deserts nearest it.
const SUB = { lat: 23.5, lng: 53.9 };
const ANTI = { lat: -SUB.lat, lng: SUB.lng - 180 };

//  LS_SET picks which candidate list to run (see SETS below); LS_TAG keeps one
//  run's log and pictures from overwriting another's.
const SET = process.env.LS_SET || '1';
const TAG = process.env.LS_TAG || SET;

const LOG = path.join(__dirname, `probe-globe-light-sweep-${TAG}.log`);
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

//  ── the candidates ───────────────────────────────────────────────────
//  vAmb/vDir are globe.gl's own two lights, aAmb/aDir the two
//  globe-controller.js adds. `tone` is a three.js tone-mapping constant, read out
//  of the page rather than hard-coded, so it is named here and resolved there.
//  `spec` and `shin`, where present, override the globe material's specular colour
//  and shininess for that row only.
//
//  Tone mapping is worth rows of its own because the fix has to be a roll-off, not
//  a dimming: turning everything down stops the deserts clipping but leaves the
//  oceans and the forests darker than they are now, and the user did not complain
//  about those. Note that ACES multiplies by exposure/0.6 before it fits, so
//  exposure 0.6 is the neutral pre-scale and 1.0 is a 1.67x boost.
//
//  SET 2 is the second pass, and it exists because of what SET 1 measured:
//    * turning globe.gl's pair off drops the blown-out area from 13.18% of the
//      wide view to 3.51% and restores the terminator the file's own comment
//      wanted -- but Arabia is still 1.00/1.00/1.00, and Arabia is the middle of
//      what the user ringed;
//    * ACES on top of that takes the blown-out area to 0.01% and brings the
//      Sahara back to 0.80/0.76/0.69 -- but the spread at Arabia stays +0.01,
//      i.e. bright and still colourless, so something there is not diffuse;
//    * the suspect is the specular highlight. The camera in the wide view sits
//      over the sub-solar point, which is exactly the mirror direction, and
//      MeshPhongMaterial has no specular map, so 0x14202c at shininess 24 is
//      added to the WHOLE lit disc and most strongly right there -- and it is
//      bluish, so it desaturates as well as brightens.
//  So SET 2 sweeps lower light with and without tone mapping, and with the
//  specular halved, zeroed or tightened, to find the row that keeps SET 1 row 1's
//  colour and SET 1 row 2's roll-off.
const SETS = { 1: [
    { n: 'shipped',              vAmb: 1.00, vDir: 0.60, aAmb: 0.28, aDir: 1.55, tone: 'None', exp: 1.00 },
    { n: 'vendor pair off',      vAmb: 0.00, vDir: 0.00, aAmb: 0.28, aDir: 1.55, tone: 'None', exp: 1.00 },
    { n: 'off + ACES 1.00',      vAmb: 0.00, vDir: 0.00, aAmb: 0.28, aDir: 1.55, tone: 'ACESFilmic', exp: 1.00 },
    { n: 'off + ACES 0.85',      vAmb: 0.00, vDir: 0.00, aAmb: 0.28, aDir: 1.55, tone: 'ACESFilmic', exp: 0.85 },
    { n: 'off + ACES 0.70',      vAmb: 0.00, vDir: 0.00, aAmb: 0.28, aDir: 1.55, tone: 'ACESFilmic', exp: 0.70 },
    { n: 'off + ACES 0.60',      vAmb: 0.00, vDir: 0.00, aAmb: 0.28, aDir: 1.55, tone: 'ACESFilmic', exp: 0.60 },
    { n: 'softer, no tone map',  vAmb: 0.00, vDir: 0.00, aAmb: 0.22, aDir: 1.10, tone: 'None', exp: 1.00 },
    { n: 'softer + ACES 0.85',   vAmb: 0.00, vDir: 0.00, aAmb: 0.22, aDir: 1.20, tone: 'ACESFilmic', exp: 0.85 },
    { n: 'vendor amb 0.25+ACES', vAmb: 0.25, vDir: 0.00, aAmb: 0.28, aDir: 1.45, tone: 'ACESFilmic', exp: 0.85 },
    { n: 'off + Reinhard 1.40',  vAmb: 0.00, vDir: 0.00, aAmb: 0.28, aDir: 1.55, tone: 'Reinhard', exp: 1.40 },
], 2: [
    //  SET 1 row 2, repeated as the control so the two runs can be lined up.
    { n: 'control = set1 row2',  vAmb: 0, vDir: 0, aAmb: 0.28, aDir: 1.55, tone: 'ACESFilmic', exp: 1.00 },
    { n: 'spec 0, else control', vAmb: 0, vDir: 0, aAmb: 0.28, aDir: 1.55, tone: 'ACESFilmic', exp: 1.00, spec: 0x000000 },
    { n: 'spec half, control',   vAmb: 0, vDir: 0, aAmb: 0.28, aDir: 1.55, tone: 'ACESFilmic', exp: 1.00, spec: 0x0a1016 },
    { n: 'spec tight (shin 90)', vAmb: 0, vDir: 0, aAmb: 0.28, aDir: 1.55, tone: 'ACESFilmic', exp: 1.00, shin: 90 },
    { n: '1.30 ACES 1.00 sp/2',  vAmb: 0, vDir: 0, aAmb: 0.24, aDir: 1.30, tone: 'ACESFilmic', exp: 1.00, spec: 0x0a1016 },
    { n: '1.15 ACES 1.00 sp/2',  vAmb: 0, vDir: 0, aAmb: 0.22, aDir: 1.15, tone: 'ACESFilmic', exp: 1.00, spec: 0x0a1016 },
    { n: '1.15 ACES 0.85 sp/2',  vAmb: 0, vDir: 0, aAmb: 0.22, aDir: 1.15, tone: 'ACESFilmic', exp: 0.85, spec: 0x0a1016 },
    //  No tone mapping at all: if a lower light and a tamer specular are enough on
    //  their own, the fix touches two numbers and leaves the renderer alone, which
    //  is the smallest change that can answer the report.
    { n: '1.30 no tone sp/2',    vAmb: 0, vDir: 0, aAmb: 0.24, aDir: 1.30, tone: 'None', exp: 1.00, spec: 0x0a1016 },
    { n: '1.15 no tone sp/2',    vAmb: 0, vDir: 0, aAmb: 0.22, aDir: 1.15, tone: 'None', exp: 1.00, spec: 0x0a1016 },
    { n: '1.05 no tone sp/2',    vAmb: 0, vDir: 0, aAmb: 0.20, aDir: 1.05, tone: 'None', exp: 1.00, spec: 0x0a1016 },
    { n: '1.15 no tone spec 0',  vAmb: 0, vDir: 0, aAmb: 0.22, aDir: 1.15, tone: 'None', exp: 1.00, spec: 0x000000 },
    { n: '1.30 no tone sp tight',vAmb: 0, vDir: 0, aAmb: 0.24, aDir: 1.30, tone: 'None', exp: 1.00, shin: 90 },
//  ── SET 3: the last four questions about SET 2 row 10 ────────────────
//  Row 10 -- vendor pair off, app 0.22/1.15, specular black, no tone mapping --
//  was the only row in either set that had both no featureless white (0.01% wide,
//  0.02% close) and the desert's own colour back (Sahara +0.33, Arabia +0.31,
//  sub-solar +0.32 against the ACES control's +0.00). Four things about it are
//  still unmeasured, and each could change what gets written into the app:
//    1. does it reproduce in a fresh process? Row 0 here is row 10 again. SET 2
//       row 0 reproduced SET 1 row 2 to three decimals, and the same has to hold
//       for the row that actually ships.
//    2. 2.73% of the wide view still has ONE channel maxed -- the red of the very
//       brightest sand. That is a hue shift, not the white mass the report is
//       about, but two rows here ask what a little less light costs: if the hot
//       area drops and the spread stays, the smaller number is the better one.
//    3. row 10 gives up the ocean sheen the shipped comment asked for. A specular
//       a quarter as bright and much tighter is the only version that could keep
//       a sheen without reaching Arabia, because at shininess 140 the lobe is a
//       few degrees wide. It is still centred on the sub-solar point, so this row
//       exists to find out whether "tight enough to miss the deserts" is possible
//       at all, or whether black is the only honest answer.
//    4. ACES at exposure 0.60 is the neutral pre-scale in r147 (it divides by
//       0.6), so this is the first row that asks for a roll-off WITHOUT the 1.67x
//       brightening every other ACES row here carried. If it keeps the spread
//       above +0.25 it beats a hard clip; if it desaturates like the rest, that
//       settles the tone-mapping question by measurement instead of by taste.
], 3: [
    { n: 'row10 again (control)', vAmb: 0, vDir: 0, aAmb: 0.22, aDir: 1.15, tone: 'None', exp: 1.00, spec: 0x000000 },
    { n: '1.31 spec 0',           vAmb: 0, vDir: 0, aAmb: 0.21, aDir: 1.10, tone: 'None', exp: 1.00, spec: 0x000000 },
    { n: '1.22 spec 0',           vAmb: 0, vDir: 0, aAmb: 0.20, aDir: 1.02, tone: 'None', exp: 1.00, spec: 0x000000 },
    { n: '1.15 sheen tight 140',  vAmb: 0, vDir: 0, aAmb: 0.22, aDir: 1.15, tone: 'None', exp: 1.00, spec: 0x060c14, shin: 140 },
    { n: '1.15 spec 0 ACES 0.60', vAmb: 0, vDir: 0, aAmb: 0.22, aDir: 1.15, tone: 'ACESFilmic', exp: 0.60, spec: 0x000000 },
] };
const CANDS = SETS[SET];
if (!CANDS) { console.log('ABORT: no such candidate set ' + SET); app.exit(3); }


//  The four regions ringed in red, the sub-solar point itself, and two dark
//  controls that are visible from the same viewpoint -- a fix that only pulls the
//  highlights down has to leave these two where they are.
const SPOTS = [
    ['Sahara (Libya)',     25.0, 17.0], ['Arabia (Saudi)',      24.0, 45.0],
    ['C.Asia (Kyzylkum)',  42.0, 63.0], ['S.Russia (Volga)',    48.0, 46.0],
    ['sub-solar point',    23.5, 53.9], ['Congo rainforest',     0.0, 22.0],
    ['Indian Ocean',        0.0, 70.0],
];
//  Night side: two cities whose lights should still read, and open sea that should
//  still be dark.
const NIGHT_SPOTS = [
    ['Los Angeles',  34.05, -118.24], ['Santiago',   -33.45, -70.67],
    ['Lima',         -12.05,  -77.04], ['S.Pacific',  -23.50, -126.10],
];

const VIEWS = [
    { key: 'wide',  lat: SUB.lat,  lng: SUB.lng,  alt: 2.80 },
    { key: 'close', lat: SUB.lat,  lng: SUB.lng,  alt: 0.62 },
    { key: 'night', lat: ANTI.lat, lng: ANTI.lng, alt: 2.80 },
];

//  ── what runs in the page ────────────────────────────────────────────
//  The four lights are picked up in scene order and ALSO described back out, so
//  which one is the vendor's and which the app's is something the Node side
//  checks rather than something this file asserts. globe.gl adds its pair when the
//  globe is constructed and globe-controller.js adds its own 650 ms later, so
//  scene order is vendor-then-app -- and the colours (0xbbbbbb vs 0xffffff) and
//  the positions (three.js's default (0,1,0) vs SUN_DIR) say the same thing twice.
const INIT = `(() => {
    const T = window.THREE, amb = [], dir = [];
    globe.scene().traverse(o => {
        if (o.isAmbientLight) amb.push(o);
        else if (o.isDirectionalLight) dir.push(o);
    });
    window.__L = { vAmb: amb[0], vDir: dir[0], aAmb: amb[1], aDir: dir[1] };
    window.__TONE = { None: T.NoToneMapping, ACESFilmic: T.ACESFilmicToneMapping,
                      Reinhard: T.ReinhardToneMapping, Linear: T.LinearToneMapping };
    //  What the material ships with, so a row that does not name a specular is
    //  put back to the shipped one instead of inheriting the previous row's.
    const gm = globe.globeMaterial();
    window.__M0 = { spec: gm && gm.specular ? gm.specular.getHex() : null,
                    shin: gm ? gm.shininess : null };
    const d = l => l ? { kind: l.type, i: l.intensity, col: l.color.getHexString(),
                         pos: [l.position.x, l.position.y, l.position.z] } : null;
    return {
        found: { vAmb: d(amb[0]), vDir: d(dir[0]), aAmb: d(amb[1]), aDir: d(dir[1]) },
        counts: { ambient: amb.length, directional: dir.length },
        tone: window.__TONE,
        mat: window.__M0,
        //  Read once so a candidate can be described in the table by what it does
        //  to the picture rather than by four numbers.
        radius: globe.getGlobeRadius(),
    };
})()`;

//  Changing renderer.toneMapping mid-run changes every built-in material's shader
//  program, so each is marked for a recompile. In the shipping fix this is set once
//  before anything compiles and the loop is unnecessary; here it is not.
const APPLY = `(c => {
    const L = window.__L, r = globe.renderer(), gm = globe.globeMaterial();
    L.vAmb.intensity = c.vAmb; L.vDir.intensity = c.vDir;
    L.aAmb.intensity = c.aAmb; L.aDir.intensity = c.aDir;
    r.toneMapping = window.__TONE[c.tone];
    r.toneMappingExposure = c.exp;
    if (gm) {
        if (gm.specular) gm.specular.setHex(c.spec === undefined ? window.__M0.spec : c.spec);
        gm.shininess = c.shin === undefined ? window.__M0.shin : c.shin;
    }
    globe.scene().traverse(o => {
        if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true;
    });
    return { tone: r.toneMapping, exp: r.toneMappingExposure,
             spec: gm && gm.specular ? gm.specular.getHexString() : null,
             shin: gm ? gm.shininess : null };
})`;


//  Screen positions for the sample boxes. The horizon test is exact: a point on a
//  sphere of radius R is visible from distance d only where the surface normal's
//  component along the view direction exceeds R/d.
const SPOTS_JS = `(spots => {
    const rect = globe.renderer().domElement.getBoundingClientRect();
    const cam = globe.camera().position, R = globe.getGlobeRadius();
    const d = Math.hypot(cam.x, cam.y, cam.z), cu = { x: cam.x / d, y: cam.y / d, z: cam.z / d };
    return {
        rect: { left: rect.left, top: rect.top, w: rect.width, h: rect.height },
        pts: spots.map(([name, lat, lng]) => {
            const s = globe.getScreenCoords(lat, lng, 0.002);
            const p = globe.getCoords(lat, lng, 0);
            const pl = Math.hypot(p.x, p.y, p.z) || 1;
            const nd = (p.x * cu.x + p.y * cu.y + p.z * cu.z) / pl;
            return { name, x: rect.left + s.x, y: rect.top + s.y, vis: nd > R / d + 0.02 };
        }),
    };
})`;

let win = null;
const run  = js => win.webContents.executeJavaScript(js, true);
const logs = [], netHits = [];
let died = null;

//  ── reading the finished frame ───────────────────────────────────────
//  capturePage gives a NativeImage and getBitmap() its raw BGRA bytes, so the
//  pixels the user would be looking at are counted directly: no PNG decode, no
//  re-render, no second guess at what the shader did.
let SCALE = 1;
async function grab() {
    const img = await win.webContents.capturePage();
    const { width, height } = img.getSize();
    return { width, height, buf: img.getBitmap(), img };
}
const px = (c, x, y) => {
    const i = (y * c.width + x) * 4;
    return { b: c.buf[i], g: c.buf[i + 1], r: c.buf[i + 2] };
};

//  The lit globe, aggregated. x0 cuts off the sidebar of white UI, taken from the
//  canvas's own bounding rect rather than from a constant. A pixel is "pure white,
//  no land colour left" when all three channels are at the top of the range -- at
//  that point neither the hue nor the bump map's relief survives.
function discStats(c, x0) {
    let n = 0, clipped = 0, hot = 0, sum = 0, mx = 0;
    for (let y = 0; y < c.height; y++) {
        for (let x = x0; x < c.width; x++) {
            const { r, g, b } = px(c, x, y);
            if (r + g + b < 90) continue;
            n++;
            const m = Math.max(r, g, b);
            sum += m; if (m > mx) mx = m;
            if (r >= 250 && g >= 250 && b >= 250) clipped++;
            else if (m >= 250) hot++;
        }
    }
    return { px: n, clippedPct: n ? 100 * clipped / n : 0, hotPct: n ? 100 * hot / n : 0,
             meanMax: n ? sum / n / 255 : 0, peak: mx / 255 };
}

//  The sky, so a tone-mapping row cannot quietly dim the 8000 stars and have that
//  go unnoticed. The backdrop is #090b14, whose brightest channel is 20, so 40 is
//  comfortably a star and not the background.
function skyStats(c, x0) {
    let stars = 0, sum = 0, n = 0;
    for (let y = 0; y < c.height; y++) {
        for (let x = x0; x < c.width; x++) {
            const { r, g, b } = px(c, x, y);
            if (r + g + b >= 90) continue;
            const m = Math.max(r, g, b);
            n++; sum += m;
            if (m >= 40) stars++;
        }
    }
    return { stars, skyMean: n ? sum / n / 255 : 0 };
}

//  One sample box per region: the mean over 7x7 capture pixels, so a single bright
//  speck cannot stand in for a region, and the channel spread r-b, which is the
//  thing the user actually lost. Sand has a spread; white has none.
function sampleAt(c, cssX, cssY) {
    const x0 = Math.round(cssX * SCALE), y0 = Math.round(cssY * SCALE);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0 - 3; y <= y0 + 3; y++) {
        for (let x = x0 - 3; x <= x0 + 3; x++) {
            if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue;
            const p = px(c, x, y);
            r += p.r; g += p.g; b += p.b; n++;
        }
    }
    if (!n) return null;
    return { r: r / n / 255, g: g / n / 255, b: b / n / 255,
             spread: (r - b) / n / 255, x: x0, y: y0 };
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
    //  The night-lights layer starts at 1800 ms and fades in over about 4.7 s, and
    //  it is one of the things being watched, so nothing is measured until it has
    //  finished arriving.
    await sleep(8000);
    await sweep();
    report();
    win.destroy();
    app.exit(fail ? 1 : 0);
}).catch(err => {
    console.log('  FAIL the probe itself threw  -- ' + (err && err.stack || err));
    app.exit(1);
});

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const f2 = (v, w = 5) => v.toFixed(2).padStart(w);
const rgb = s => s ? `${s.r.toFixed(2)}/${s.g.toFixed(2)}/${s.b.toFixed(2)}` : '  n/a  ';

async function sweep() {
    console.log(`── candidate set ${SET}: the four lights in the scene, before anything is changed ──`);
    const st = await run(INIT);
    for (const k of ['vAmb', 'vDir', 'aAmb', 'aDir']) {
        const l = st.found[k];
        console.log(`   ${k}  ${l ? `${l.kind.padEnd(16)} intensity ${l.i}  #${l.col}  ` +
                                    `at (${l.pos.join(', ')})` : 'MISSING'}`);
    }
    console.log(`   globe material ships with specular #${(st.mat.spec || 0).toString(16)}` +
                `, shininess ${st.mat.shin}`);
    ok(st.counts.ambient === 2 && st.counts.directional === 2,
       'there are exactly two ambient and two directional lights, as the doubling implies',
       JSON.stringify(st.counts));
    //  Scene order says vendor-then-app; the colours and the positions have to say
    //  it too, or the wrong light is about to be turned down.
    ok(st.found.vAmb && st.found.vAmb.col === 'bbbbbb' && st.found.vAmb.i === 1,
       "the first ambient is globe.gl's own #bbbbbb at intensity 1",
       JSON.stringify(st.found.vAmb));
    ok(st.found.aAmb && st.found.aAmb.col === 'ffffff' && Math.abs(st.found.aAmb.i - 0.28) < 1e-9,
       "the second ambient is globe-controller.js's white 0.28",
       JSON.stringify(st.found.aAmb));
    ok(st.found.vDir && Math.abs(st.found.vDir.i - 0.6) < 1e-9 &&
       st.found.vDir.pos[0] === 0 && st.found.vDir.pos[1] === 1 && st.found.vDir.pos[2] === 0,
       "the first directional is globe.gl's 0.6 still at three.js's default (0,1,0)",
       JSON.stringify(st.found.vDir));
    ok(st.found.aDir && Math.abs(st.found.aDir.i - 1.55) < 1e-9 && st.found.aDir.pos[0] === 260,
       "the second directional is globe-controller.js's 1.55 aimed along SUN_DIR",
       JSON.stringify(st.found.aDir));

    //  autoRotate would move the terminator between one candidate and the next and
    //  make the columns incomparable. It is a camera setting; the lighting is fixed
    //  in world space and does not move with it.
    await run('globe.controls().autoRotate = false; null');
    const bounds = win.getContentBounds();
    let cap = await grab();
    SCALE = cap.width / bounds.width;
    console.log(`\n   capture ${cap.width}x${cap.height} for a ${bounds.width}x${bounds.height} ` +
                `window, so ${SCALE.toFixed(3)} capture px per CSS px`);

    //  Before any region is sampled: with the camera parked over the sub-solar
    //  point, that point has to come out at the middle of the canvas. If
    //  getScreenCoords is measured from somewhere else, every colour below is read
    //  off the wrong pixels and the whole table is fiction.
    const V0 = VIEWS[0];
    await run(`globe.pointOfView({ lat: ${V0.lat}, lng: ${V0.lng}, altitude: ${V0.alt} }, 0); null`);
    await sleep(900);
    const chk = await run(SPOTS_JS + '(' + JSON.stringify([['sub-solar point', SUB.lat, SUB.lng]]) + ')');
    const cx = chk.rect.left + chk.rect.w / 2, cy = chk.rect.top + chk.rect.h / 2;
    const off = Math.hypot(chk.pts[0].x - cx, chk.pts[0].y - cy);
    ok(off < 6, 'getScreenCoords puts the sub-solar point at the centre of the canvas, ' +
                'so the sample boxes are where they claim to be',
       `off by ${off.toFixed(1)} CSS px; canvas ${JSON.stringify(chk.rect)}`);
    const X0 = Math.round((chk.rect.left + 6) * SCALE);

    const rows = [];
    for (let i = 0; i < CANDS.length; i++) {
        const c = CANDS[i];
        const got = await run(APPLY + '(' + JSON.stringify(c) + ')');
        //  A tone-mapping change recompiles every built-in material's program, so
        //  the first frame after it is not necessarily the finished one.
        await sleep(500);
        const row = { i, c, tone: got };
        for (const v of VIEWS) {
            await run(`globe.pointOfView({ lat: ${v.lat}, lng: ${v.lng}, altitude: ${v.alt} }, 0); null`);
            await sleep(750);
            cap = await grab();
            if (v.key === 'wide') {
                row.wide = discStats(cap, X0);
                row.sky  = skyStats(cap, X0);
                const s = await run(SPOTS_JS + '(' + JSON.stringify(SPOTS) + ')');
                row.spots = s.pts.map(p => ({ name: p.name, vis: p.vis,
                                              s: p.vis ? sampleAt(cap, p.x, p.y) : null }));
                fs.writeFileSync(path.join(__dirname,
                    `probe-lightsweep-${TAG}-${i}-${slug(c.n)}.png`), cap.img.toPNG());
            } else if (v.key === 'close') {
                row.close = discStats(cap, X0);
            } else {
                const s = await run(SPOTS_JS + '(' + JSON.stringify(NIGHT_SPOTS) + ')');
                row.night = s.pts.map(p => ({ name: p.name, vis: p.vis,
                                              s: p.vis ? sampleAt(cap, p.x, p.y) : null }));
            }
        }
        rows.push(row);
        print(row);
    }
    table(rows);
}

function print(r) {
    const c = r.c;
    console.log(`\n[${r.i}] ${c.n.padEnd(22)} vendor ${f2(c.vAmb, 4)}/${f2(c.vDir, 4)}   ` +
                `app ${f2(c.aAmb, 4)}/${f2(c.aDir, 4)}   ${c.tone} x${c.exp.toFixed(2)}` +
                `   specular #${r.tone.spec} shininess ${r.tone.shin}`);
    console.log(`     wide  white ${f2(r.wide.clippedPct)}%  hot ${f2(r.wide.hotPct)}%  ` +
                `mean ${r.wide.meanMax.toFixed(3)}  peak ${r.wide.peak.toFixed(3)}  ` +
                `stars ${String(r.sky.stars).padStart(5)}  sky ${r.sky.skyMean.toFixed(3)}`);
    console.log(`     close white ${f2(r.close.clippedPct)}%  hot ${f2(r.close.hotPct)}%  ` +
                `mean ${r.close.meanMax.toFixed(3)}`);
    console.log('     ' + r.spots.map(p => `${p.name.split(' ')[0]} ${rgb(p.s)}` +
                (p.s ? ` (${p.s.spread >= 0 ? '+' : ''}${p.s.spread.toFixed(2)})` : ''))
                .join('  '));
    console.log('     night ' + r.night.map(p => `${p.name} ${rgb(p.s)}`).join('  '));
}

//  The whole point of the run, in one block: the columns that decide it.
//  "white" is the user's complaint. "mean" is the guard against answering it by
//  turning the globe down. "sand" is the Sahara's r-b spread, which is what makes
//  it read as sand rather than as paper. "dark" columns are the two controls that
//  must not move much, and "stars"/"cities" are the two things a tone-mapping row
//  could break without touching the land at all.
function table(rows) {
    console.log('\n══ the whole sweep, side by side ══');
    console.log('  #  lighting                wide-white  wide-mean  close-white   sand   arab  ' +
                'Congo  Ocean  stars  LA-lights');
    for (const r of rows) {
        const sah = r.spots.find(p => /Sahara/.test(p.name));
        const arb = r.spots.find(p => /Arabia/.test(p.name));
        const con = r.spots.find(p => /Congo/.test(p.name));
        const oce = r.spots.find(p => /Indian/.test(p.name));
        const la  = r.night.find(p => /Los Angeles/.test(p.name));
        const mx = s => s && s.s ? Math.max(s.s.r, s.s.g, s.s.b).toFixed(2) : ' n/a';
        const sp = s => (s && s.s ? (s.s.spread >= 0 ? '+' : '') + s.s.spread.toFixed(2) : ' n/a').padStart(5);
        console.log(`  ${String(r.i).padEnd(2)} ${r.c.n.padEnd(22)} ` +
                    `${f2(r.wide.clippedPct, 8)}%  ${r.wide.meanMax.toFixed(3).padStart(8)}  ` +
                    `${f2(r.close.clippedPct, 10)}%  ` +
                    `${sp(sah)}  ${sp(arb)}  ` +
                    `${mx(con).padStart(5)}  ${mx(oce).padStart(5)}  ` +
                    `${String(r.sky.stars).padStart(5)}  ${mx(la).padStart(9)}`);
    }
    console.log('\n   sand/arab are the r-b spread at the Sahara and at Arabia: what makes them ' +
                'read as\n   desert rather than as paper. Congo/Ocean/stars/LA are the four ' +
                'things a fix\n   must not dim. Set 1 row 0 is the shipped lighting, measured ' +
                'by this same code.');
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


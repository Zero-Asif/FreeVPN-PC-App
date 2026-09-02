'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-globe-night.js  --  the OTHER side of the globe, measured.
//
//  Run:  node_modules/electron/dist/electron.exe .build/probe-globe-night.js
//
//  WHY THIS FILE EXISTS
//  --------------------
//  The lighting that this file was written against was chosen by
//  .build/probe-globe-light-sweep.js, which parks the camera over the sub-solar
//  point (23.5N 53.9E) for two of its three views and samples four deserts. It
//  answered the report it was built for -- 13.18% of the lit globe was featureless
//  white, then 0.01% -- and it did it by taking the real ambient from 1.013 to 0.21.
//
//  Ambient is the ONLY light the night hemisphere gets: the directional sits at
//  SUN_DIR and its contribution there is max(0, dot) = 0. So that fix multiplied
//  the whole night side by 0.21/1.013 = 0.21, and the user's next screenshot is a
//  black globe with a lit sliver at one edge. That is a real regression, and the
//  reason it reached them before it reached me is written in the probes: this
//  file's predecessor photographed four frames as the app opens and all four
//  landed on the day side (lng 84.4, 53.9, 23.6, -6.8), and the bright probe only
//  ever parks over the sub-solar point. Nothing measured the night side at all.
//
//  So this file measures BOTH SIDES OF EVERY CANDIDATE, in four views, and its
//  reference row is not a taste call either: row 1 puts globe.gl's two lights
//  back to 1.00/0.60 and the app's to 0.28/1.55, i.e. exactly the lighting the
//  user had when they said the night side was fine. That row's night-side numbers
//  are the target to approach, and its day-side numbers are the white the fix
//  must not bring back. Every other row is judged between those two.
//
//  Two families are swept, because they fail differently:
//    fill  -- a third DirectionalLight aimed at -SUN_DIR. On the day side its
//             dot product is <= 0, so it CANNOT change the white percentages;
//             on the night side it adds a soft glow centred on the anti-solar
//             point, brightest there and fading to nothing at the terminator.
//    shift -- move light from the directional into the ambient, keeping
//             ambient+directional = 1.31 so the sub-solar total is untouched.
//             Lifts the night side flatly, but flattens the terminator and the
//             bump-map relief, which is what the original comment meant by
//             "flattened the earth into a poster".
//  One row raises the night-lights layer's opacity instead, to have a number for
//  why brighter cities are not an answer to "which country is that".
//
//  Nothing is started, no port is bound, every request the window makes is
//  cancelled, and the only things touched are the camera, five light intensities
//  and one shader uniform, in a window that is destroyed at the end.
// ════════════════════════════════════════════════════════════════════
const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { geoFromMainJs } = require('./geo-from-main.js');

const ROOT = path.join(__dirname, '..');
const GEO  = geoFromMainJs(ROOT);
const HOME = { lat: 23.8103, lng: 90.4125, city: 'Dhaka', country: 'Bangladesh', cc: 'BD' };
//  SUN_DIR = (260, 140, 190): r = 351.14, lat = asin(140/r) = 23.5 N,
//  lng = atan2(190, 260) = 53.9 E. The anti-solar point is the middle of the
//  hemisphere the user photographed.
const SUB  = { lat: 23.5, lng: 53.9 };
const ANTI = { lat: -SUB.lat, lng: SUB.lng - 180 };

const SET = process.env.GN_SET || '1';
const TAG = process.env.GN_TAG || SET;
const LOG = path.join(__dirname, `probe-globe-night-${TAG}.log`);
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
//  vAmb/vDir are globe.gl's baked-in pair, aAmb/aDir the two globe-controller.js
//  adds, `fill` the third light this probe adds at -SUN_DIR, `nb` the night-lights
//  layer's opacity (the shipped value is 0.94 and is used when a row omits it).
//  Rows 0 and 1 of every set are the two ends of the argument -- the lighting the
//  report was written about, and the lighting the user had before it -- measured by
//  this same code in this same process, so every other row can be read against both.
//
//  SET 2 exists because of what SET 1 measured. Not one of its nine candidates got
//  within 55% of the pre-fix night side on BOTH counts, and the reason is in the
//  numbers rather than in the choice of candidates: with MeshPhongMaterial and no
//  tone mapping, the night hemisphere receives the ambient and nothing else, so
//  night legibility is a straight function of the ambient plus whatever a fill
//  light adds -- and the pre-fix night side the user was happy with sat at an
//  ambient of 1.013. A fill light alone cannot get there without becoming a second
//  sun over the Pacific, and a 0.55 ambient cannot get there either. What SET 1
//  also measured is that the day side has room: the Sahara's own 0.72 albedo
//  clips at a total of 1.39, the sub-solar point clips at 1.89, and rows 5-7 held
//  0.01% white while the total was held at 1.31. So SET 2 keeps that total and
//  walks the ambient up from 0.55 to 1.00, with and without a fill on top, which
//  is the only direction left that can reach the pre-fix night side.
const SETS = { 1: [
    { n: 'as reported',        vAmb: 0.00, vDir: 0.00, aAmb: 0.21, aDir: 1.10, fill: 0.00 },
    { n: 'pre-fix (old app)',  vAmb: 1.00, vDir: 0.60, aAmb: 0.28, aDir: 1.55, fill: 0.00 },
    { n: 'fill 0.22',          vAmb: 0.00, vDir: 0.00, aAmb: 0.21, aDir: 1.10, fill: 0.22 },
    { n: 'fill 0.32',          vAmb: 0.00, vDir: 0.00, aAmb: 0.21, aDir: 1.10, fill: 0.32 },
    { n: 'fill 0.42',          vAmb: 0.00, vDir: 0.00, aAmb: 0.21, aDir: 1.10, fill: 0.42 },
    { n: 'shift 0.34/0.97',    vAmb: 0.00, vDir: 0.00, aAmb: 0.34, aDir: 0.97, fill: 0.00 },
    { n: 'shift 0.45/0.86',    vAmb: 0.00, vDir: 0.00, aAmb: 0.45, aDir: 0.86, fill: 0.00 },
    { n: 'shift 0.55/0.76',    vAmb: 0.00, vDir: 0.00, aAmb: 0.55, aDir: 0.76, fill: 0.00 },
    { n: 'shift 0.34 + f 0.18',vAmb: 0.00, vDir: 0.00, aAmb: 0.34, aDir: 0.97, fill: 0.18 },
    { n: 'shift 0.40 + f 0.14',vAmb: 0.00, vDir: 0.00, aAmb: 0.40, aDir: 0.91, fill: 0.14 },
    { n: 'cities only (nb 1.6)',vAmb: 0.00, vDir: 0.00, aAmb: 0.21, aDir: 1.10, fill: 0.00, nb: 1.60 },
], 2: [
    { n: 'as reported',        vAmb: 0.00, vDir: 0.00, aAmb: 0.21, aDir: 1.10, fill: 0.00 },
    { n: 'pre-fix (old app)',  vAmb: 1.00, vDir: 0.60, aAmb: 0.28, aDir: 1.55, fill: 0.00 },
    { n: '0.55/0.76 + f 0.34', vAmb: 0.00, vDir: 0.00, aAmb: 0.55, aDir: 0.76, fill: 0.34 },
    { n: '0.62/0.68 + f 0.24', vAmb: 0.00, vDir: 0.00, aAmb: 0.62, aDir: 0.68, fill: 0.24 },
    { n: '0.70/0.60 + f 0.16', vAmb: 0.00, vDir: 0.00, aAmb: 0.70, aDir: 0.60, fill: 0.16 },
    { n: '0.70/0.60',          vAmb: 0.00, vDir: 0.00, aAmb: 0.70, aDir: 0.60, fill: 0.00 },
    { n: '0.80/0.50',          vAmb: 0.00, vDir: 0.00, aAmb: 0.80, aDir: 0.50, fill: 0.00 },
    { n: '0.80/0.50 + f 0.14', vAmb: 0.00, vDir: 0.00, aAmb: 0.80, aDir: 0.50, fill: 0.14 },
    { n: '0.90/0.42',          vAmb: 0.00, vDir: 0.00, aAmb: 0.90, aDir: 0.42, fill: 0.00 },
    { n: '0.45/0.86 + f 0.45', vAmb: 0.00, vDir: 0.00, aAmb: 0.45, aDir: 0.86, fill: 0.45 },
    { n: '1.00/0.34 (flat end)',vAmb: 0.00, vDir: 0.00, aAmb: 1.00, aDir: 0.34, fill: 0.00 },
//  SET 3 is the regression suite, not a search: the two ends of the complaint and
//  the one row that ships, so `GN_SET=3` re-answers "is either side ruined" in one
//  run. Row 2 repeats what INIT has already read back out of globe-controller.js,
//  which is what makes the numbers below numbers about the shipped app.
], 3: [
    { n: 'as reported',        vAmb: 0.00, vDir: 0.00, aAmb: 0.21, aDir: 1.10, fill: 0.00 },
    { n: 'pre-fix (old app)',  vAmb: 1.00, vDir: 0.60, aAmb: 0.28, aDir: 1.55, fill: 0.00 },
    { n: 'shipped now',        vAmb: 0.00, vDir: 0.00, aAmb: 0.90, aDir: 0.42, fill: 0.00 },
] };
const ROWS = SETS[SET];
if (!ROWS) { console.log('ABORT: no such candidate set ' + SET); app.exit(3); }


//  ── what gets sampled ────────────────────────────────────────────────
//  Day side: the four regions the first report ringed, plus the sub-solar point
//  itself and two dark controls. Himalaya is here for a different reason -- it is
//  the relief probe. Moving light out of the directional and into the ambient
//  flattens the bump map, and a 41x41 box over the Karakoram is where that shows
//  up as a number (its standard deviation) instead of as an opinion.
const SPOTS = [
    ['Sahara (Libya)',     25.0, 17.0], ['Arabia (Saudi)',      24.0, 45.0],
    ['C.Asia (Kyzylkum)',  42.0, 63.0], ['S.Russia (Volga)',    48.0, 46.0],
    ['sub-solar point',    23.5, 53.9], ['Congo rainforest',      0.0, 22.0],
    ['Indian Ocean',        0.0, 70.0], ['Himalaya (relief)',   35.0, 76.0],
];
//  Night side, from the anti-solar view. Paired on purpose: each land sample has
//  a sea sample at nearly the same latitude a few hundred km off its coast, so
//  "can you tell where the continent ends" is land-minus-sea and not a guess. The
//  three cities are the night-lights layer, which must not be drowned by the fix.
const NIGHT_SPOTS = [
    ['Baja/Sonora',        28.0, -112.0, 'land'], ['Rockies (Colorado)', 39.0, -105.0, 'land'],
    ['Andes (Atacama)',   -24.0,  -69.0, 'land'], ['Amazon (Brazil)',    -6.0,  -62.0, 'land'],
    ['Pacific off Baja',   25.0, -125.0, 'sea'],  ['Pacific off Chile', -24.0,  -82.0, 'sea'],
    ['S.Pacific (anti)',  -23.5, -126.1, 'sea'],  ['N.Pacific',          30.0, -140.0, 'sea'],
    ['Los Angeles',        34.05,-118.24,'city'], ['Mexico City',        19.43, -99.13,'city'],
    ['Santiago',          -33.45, -70.67,'city'],
];
//  The terminator frame: one picture with the Sahara in full daylight at one edge
//  and the Amazon in full night at the other. This is the view that answers the
//  actual instruction -- one side must not be fixed by ruining the other -- because
//  both sides are in the same frame and lit by the same numbers.
const TERM_SPOTS = [
    ['Sahara (Libya)',     25.0,  17.0], ['Congo rainforest',     0.0,  22.0],
    ['Atlantic (limb)',    10.0, -36.1], ['Amazon (Brazil)',     -6.0, -62.0],
    ['Andes (Atacama)',   -24.0, -69.0], ['Lima',               -12.05,-77.04],
];

const VIEWS = [
    { key: 'wide',  lat: SUB.lat,  lng: SUB.lng,      alt: 2.80 },
    { key: 'close', lat: SUB.lat,  lng: SUB.lng,      alt: 0.62 },
    { key: 'night', lat: ANTI.lat, lng: ANTI.lng,     alt: 2.80 },
    { key: 'term',  lat: 10,       lng: SUB.lng - 90, alt: 2.80 },
];

//  ── what runs in the page ────────────────────────────────────────────
//  The lights are identified by what they are, not by scene order: globe.gl's
//  ambient is the #bbbbbb one and its directional is the one still at three.js's
//  default (0,1,0), which is exactly why it lights the north pole rather than the
//  sun's side. SUN_DIR is read out of globe-controller.js's own scope, so the fill
//  light cannot end up aimed somewhere the app's directional is not opposite to.
const INIT = `(() => {
    const T = window.THREE, amb = [], dir = [];
    globe.scene().traverse(o => {
        if (o.isAmbientLight) amb.push(o);
        else if (o.isDirectionalLight) dir.push(o);
    });
    const vAmb = amb.find(l => l.color.getHexString() === 'bbbbbb') || null;
    const aAmb = amb.find(l => l !== vAmb) || null;
    const vDir = dir.find(l => !l.position.x && l.position.y === 1 && !l.position.z) || null;
    const aDir = dir.find(l => l !== vDir) || null;

    //  The light this probe exists to size, added at intensity 0 so row 0 is the
    //  shipped picture even though the scene now holds a light the app does not.
    const fill = new T.DirectionalLight(0xffffff, 0);
    fill.position.set(-SUN_DIR.x, -SUN_DIR.y, -SUN_DIR.z);
    globe.scene().add(fill);

    //  The night-lights layer, found by its own uniform rather than by index.
    let night = null;
    globe.scene().traverse(o => {
        for (const m of [].concat(o.material || [])) {
            if (m && m.uniforms && m.uniforms.uNight) night = m;
        }
    });
    window.__L = { vAmb, vDir, aAmb, aDir, fill, night,
                   nb0: night ? night.uniforms.uOpacity.value : null };

    const gm = globe.globeMaterial();
    const d = l => l ? { i: +l.intensity.toFixed(3), col: l.color.getHexString(),
                         pos: [l.position.x, l.position.y, l.position.z] } : null;
    return {
        found: { vAmb: d(vAmb), vDir: d(vDir), aAmb: d(aAmb), aDir: d(aDir), fill: d(fill) },
        counts: { amb: amb.length, dir: dir.length },
        spec: gm && gm.specular ? gm.specular.getHexString() : null,
        shin: gm ? gm.shininess : null, bump: gm ? gm.bumpScale : null,
        tone: globe.renderer().toneMapping, exp: globe.renderer().toneMappingExposure,
        sun: [SUN_DIR.x, SUN_DIR.y, SUN_DIR.z],
        nightLayer: !!night, nb0: night ? night.uniforms.uOpacity.value : null,
        radius: globe.getGlobeRadius(), fov: globe.camera().fov,
    };
})()`;

//  Only intensities and one uniform change per row, so no material is recompiled
//  and no frame is a half-applied mixture of two rows. The fill light itself is
//  added once, in INIT, which is the only recompile in the run.
const APPLY = `(c => {
    const L = window.__L;
    L.vAmb.intensity = c.vAmb; L.vDir.intensity = c.vDir;
    L.aAmb.intensity = c.aAmb; L.aDir.intensity = c.aDir;
    L.fill.intensity = c.fill;
    if (L.night) L.night.uniforms.uOpacity.value = (c.nb === undefined ? L.nb0 : c.nb);
    return { v: [L.vAmb.intensity, L.vDir.intensity],
             a: [L.aAmb.intensity, L.aDir.intensity], fill: L.fill.intensity,
             nb: L.night ? +L.night.uniforms.uOpacity.value.toFixed(3) : null };
})`;

//  Screen positions, and the silhouette. The horizon test is exact: a point on a
//  sphere of radius R is visible from distance d only where the surface normal's
//  component along the view direction exceeds R/d. The disc radius is the same
//  geometry from the other side -- the sphere subtends asin(R/d), which the
//  perspective camera maps to (h/2)*tan(asin(R/d))/tan(fov/2) pixels. It is needed
//  because the night side cannot be found by brightness: a mask that keeps only
//  pixels above a threshold would measure the night hemisphere by throwing away
//  exactly the dark pixels the complaint is about.
const FRAME_JS = `(spots => {
    const rect = globe.renderer().domElement.getBoundingClientRect();
    const cam = globe.camera(), p0 = cam.position, R = globe.getGlobeRadius();
    const d = Math.hypot(p0.x, p0.y, p0.z);
    const cu = { x: p0.x / d, y: p0.y / d, z: p0.z / d };
    const ang = Math.asin(Math.min(1, R / d));
    return {
        rect: { left: rect.left, top: rect.top, w: rect.width, h: rect.height },
        disc: { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2,
                r: (rect.height / 2) * Math.tan(ang) / Math.tan(cam.fov * Math.PI / 360) },
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

//  The lit part of the frame, counted the way .build/probe-globe-bright.js and
//  probe-globe-light-sweep.js count it, so this file's day-side numbers can be
//  read against theirs directly.
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

//  The globe itself, dark pixels included, inside 0.97 of the silhouette so the
//  atmosphere's rim glow is left out. black/dim are the complaint as a number:
//  "kichui bujha jacchena" is a disc most of whose pixels carry no readable
//  colour, and 0.06 / 0.12 of full scale is where a 4096-wide texture's land
//  stops being distinguishable from the sea beside it on a 670 px window.
function maskStats(c, disc) {
    const cx = disc.cx * SCALE, cy = disc.cy * SCALE, R = disc.r * SCALE * 0.97;
    let n = 0, sum = 0, black = 0, dim = 0, clipped = 0;
    const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(c.width - 1, Math.ceil(cx + R));
    const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(c.height - 1, Math.ceil(cy + R));
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            if ((x - cx) ** 2 + (y - cy) ** 2 > R * R) continue;
            const { r, g, b } = px(c, x, y);
            const m = Math.max(r, g, b);
            n++; sum += m;
            if (m < 15) black++;
            if (m < 31) dim++;
            if (r >= 250 && g >= 250 && b >= 250) clipped++;
        }
    }
    return { px: n, mean: n ? sum / n / 255 : 0, blackPct: n ? 100 * black / n : 0,
             dimPct: n ? 100 * dim / n : 0, clippedPct: n ? 100 * clipped / n : 0 };
}

//  One sample box per place: the mean over 7x7 capture pixels, so a single speck
//  cannot stand in for a region, and r-b, which is what makes sand read as sand.
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
             spread: (r - b) / n / 255, max: Math.max(r, g, b) / n / 255 };
}

//  Relief, as a number. The bump map only shows up in the directional light's
//  term, so moving light into the ambient makes mountains flatter -- the exact
//  thing globe-controller.js's older comment called "flattened into a poster".
//  A 41x41 box over the Karakoram has ridges and valleys in it, so the standard
//  deviation across it falls when the relief does, while the mean stays put.
function reliefAt(c, cssX, cssY) {
    const x0 = Math.round(cssX * SCALE), y0 = Math.round(cssY * SCALE), H = 20;
    const v = [];
    for (let y = y0 - H; y <= y0 + H; y++) {
        for (let x = x0 - H; x <= x0 + H; x++) {
            if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue;
            const p = px(c, x, y);
            v.push(Math.max(p.r, p.g, p.b) / 255);
        }
    }
    if (v.length < 100) return null;
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
    return { mean, sd, cv: mean ? sd / mean : 0 };
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
const mx = s => (s && s.s ? s.s.max.toFixed(2) : ' n/a');

async function sweep() {
    console.log('── the scene as the shipped file leaves it, before this probe changes anything ──');
    const st = await run(INIT);
    for (const k of ['vAmb', 'vDir', 'aAmb', 'aDir', 'fill']) {
        const l = st.found[k];
        console.log(`   ${k.padEnd(5)} ${l ? `intensity ${String(l.i).padEnd(5)} #${l.col}  ` +
                                            `at (${l.pos.join(', ')})` : 'MISSING'}`);
    }
    console.log(`   material: specular #${st.spec}, shininess ${st.shin}, bumpScale ${st.bump};  ` +
                `toneMapping ${st.tone} x${st.exp};  night layer ${st.nightLayer ? 'yes' : 'NO'} ` +
                `at opacity ${st.nb0};  SUN_DIR (${st.sun.join(', ')})`);

    ok(st.counts.amb === 2 && st.counts.dir === 2,
       'the scene has globe.gl\'s two lights and the app\'s two, and no others',
       JSON.stringify(st.counts));
    ok(st.found.vAmb && st.found.vAmb.i === 0 && st.found.vDir && st.found.vDir.i === 0,
       "globe.gl's own pair is still silenced, so this run measures the app's lights only",
       JSON.stringify([st.found.vAmb, st.found.vDir]));
    ok(st.found.aAmb && Math.abs(st.found.aAmb.i - 0.90) < 1e-9 &&
       st.found.aDir && Math.abs(st.found.aDir.i - 0.42) < 1e-9,
       'globe-controller.js ships ambient 0.90 with a 0.42 directional -- read back out ' +
       'of the running scene, so the rows below are candidates against the real app',
       JSON.stringify([st.found.aAmb, st.found.aDir]));
    ok(st.found.fill && st.found.fill.pos[0] === -st.sun[0] &&
       st.found.fill.pos[1] === -st.sun[1] && st.found.fill.pos[2] === -st.sun[2],
       'the fill light is aimed at exactly -SUN_DIR, so on the day side it adds nothing',
       JSON.stringify(st.found.fill));
    ok(st.spec === '000000' && st.tone === 0,
       'specular is still black and tone mapping still off, so nothing else is in play',
       `spec #${st.spec}, tone ${st.tone}`);
    ok(st.nightLayer, 'the night-lights layer is up, so the city lights can be watched too');

    //  autoRotate would move the camera between one row and the next and make the
    //  columns incomparable. The lighting is fixed in world space, so it does not
    //  move with the camera: parking it is measurement, not staging.
    await run('globe.controls().autoRotate = false; null');
    const bounds = win.getContentBounds();
    let cap = await grab();
    SCALE = cap.width / bounds.width;
    console.log(`\n   capture ${cap.width}x${cap.height} for a ${bounds.width}x${bounds.height} ` +
                `window, so ${SCALE.toFixed(3)} capture px per CSS px`);

    const V0 = VIEWS[0];
    await run(`globe.pointOfView({ lat: ${V0.lat}, lng: ${V0.lng}, altitude: ${V0.alt} }, 0); null`);
    await sleep(900);
    const chk = await run(FRAME_JS + '(' + JSON.stringify([['sub-solar', SUB.lat, SUB.lng]]) + ')');
    const off = Math.hypot(chk.pts[0].x - chk.disc.cx, chk.pts[0].y - chk.disc.cy);
    ok(off < 6, 'the point the camera is aimed at comes out at the centre of the disc, so ' +
                'both the sample boxes and the disc mask are where they claim to be',
       `off by ${off.toFixed(1)} CSS px; disc r ${chk.disc.r.toFixed(1)} CSS px`);
    const X0 = Math.round((chk.rect.left + 6) * SCALE);

    const rows = [];
    for (let i = 0; i < ROWS.length; i++) {
        const c = ROWS[i];
        const got = await run(APPLY + '(' + JSON.stringify(c) + ')');
        await sleep(450);
        const row = { i, c, got };
        for (const v of VIEWS) {
            await run(`globe.pointOfView({ lat: ${v.lat}, lng: ${v.lng}, altitude: ${v.alt} }, 0); null`);
            await sleep(750);
            cap = await grab();
            const spots = v.key === 'wide' ? SPOTS : v.key === 'night' ? NIGHT_SPOTS
                        : v.key === 'term' ? TERM_SPOTS : [];
            const fr = await run(FRAME_JS + '(' + JSON.stringify(spots) + ')');
            const take = () => fr.pts.map(p => ({ name: p.name, vis: p.vis,
                                                  s: p.vis ? sampleAt(cap, p.x, p.y) : null }));
            const shot = () => fs.writeFileSync(path.join(__dirname,
                `probe-globe-night-${TAG}-${i}-${v.key}-${slug(c.n)}.png`), cap.img.toPNG());
            if (v.key === 'wide') {
                row.wide = discStats(cap, X0);
                row.wideDisc = maskStats(cap, fr.disc);
                row.spots = take();
                const h = fr.pts.find(p => /Himalaya/.test(p.name));
                row.relief = h && h.vis ? reliefAt(cap, h.x, h.y) : null;
                shot();
            } else if (v.key === 'close') {
                row.close = discStats(cap, X0);
            } else if (v.key === 'night') {
                row.nightDisc = maskStats(cap, fr.disc);
                row.night = take();
                shot();
            } else {
                row.termDisc = maskStats(cap, fr.disc);
                row.term = take();
                shot();
            }
        }
        rows.push(row);
        print(row);
    }
    verdict(rows);
    table(rows);
}

//  Which night samples are land, which are open sea, which are cities. Land minus
//  sea is the whole question: a night hemisphere is legible when the continents
//  are brighter than the water around them by enough to see the coastline, and
//  that is a subtraction rather than an opinion.
const NIGHT_KIND = new Map(NIGHT_SPOTS.map(([n, , , k]) => [n, k]));
function nightAgg(list) {
    const grab = kind => list.filter(p => p.s && NIGHT_KIND.get(p.name) === kind)
                             .map(p => p.s.max);
    const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const land = mean(grab('land')), sea = mean(grab('sea')), city = mean(grab('city'));
    return { land, sea, city, contrast: land !== null && sea !== null ? land - sea : null };
}
const n2 = v => (v === null || v === undefined ? ' n/a' : v.toFixed(2));

function print(r) {
    const c = r.c, a = nightAgg(r.night);
    console.log(`\n[${r.i}] ${c.n.padEnd(24)} vendor ${f2(c.vAmb, 4)}/${f2(c.vDir, 4)}  ` +
                `app ${f2(c.aAmb, 4)}/${f2(c.aDir, 4)}  fill ${f2(c.fill, 4)}  ` +
                `cities ${r.got.nb}`);
    console.log(`     DAY   wide white ${f2(r.wide.clippedPct)}%  hot ${f2(r.wide.hotPct)}%  ` +
                `lit-mean ${r.wide.meanMax.toFixed(3)}  disc-mean ${r.wideDisc.mean.toFixed(3)}` +
                `   close white ${f2(r.close.clippedPct)}%`);
    console.log(`     NIGHT disc-mean ${r.nightDisc.mean.toFixed(3)}  ` +
                `black ${f2(r.nightDisc.blackPct)}%  dim ${f2(r.nightDisc.dimPct)}%  ` +
                `land ${n2(a.land)}  sea ${n2(a.sea)}  land-sea ${n2(a.contrast)}  ` +
                `cities ${n2(a.city)}`);
    console.log(`     TERM  disc-mean ${r.termDisc.mean.toFixed(3)}  ` +
                `black ${f2(r.termDisc.blackPct)}%   relief sd ` +
                `${r.relief ? r.relief.sd.toFixed(3) + ' (cv ' + r.relief.cv.toFixed(3) + ')' : 'n/a'}`);
    console.log('     day   ' + r.spots.filter(p => !/Himalaya/.test(p.name))
                .map(p => `${p.name.split(' ')[0]} ${rgb(p.s)}`).join('  '));
    console.log('     night ' + r.night.map(p => `${p.name.split(' ')[0]} ${mx(p)}`).join('  '));
    console.log('     term  ' + r.term.map(p => `${p.name.split(' ')[0]} ${mx(p)}`).join('  '));
}

//  ── the decision, spelled out ────────────────────────────────────────
//  Row 0 is the lighting the report was written about; row 1 is the lighting the
//  user had when the night side was fine and the deserts were white. A candidate has
//  to be on the right side of BOTH: day-side white where row 0 is, night-side
//  legibility where row 1 is. The gates are stated here so the choice is arithmetic.
function verdict(rows) {
    const R0 = rows[0], R1 = rows[1];
    const a0 = nightAgg(R0.night), a1 = nightAgg(R1.night);
    console.log('\n══ the two ends of the argument ══');
    console.log(`   row 0 (as reported) night disc-mean ${R0.nightDisc.mean.toFixed(3)}  ` +
                `black ${R0.nightDisc.blackPct.toFixed(2)}%  land-sea ${n2(a0.contrast)}  ` +
                `|  day white ${R0.wide.clippedPct.toFixed(2)}% wide / ${R0.close.clippedPct.toFixed(2)}% close`);
    console.log(`   row 1 (pre-fix)     night disc-mean ${R1.nightDisc.mean.toFixed(3)}  ` +
                `black ${R1.nightDisc.blackPct.toFixed(2)}%  land-sea ${n2(a1.contrast)}  ` +
                `|  day white ${R1.wide.clippedPct.toFixed(2)}% wide / ${R1.close.clippedPct.toFixed(2)}% close`);

    ok(R0.nightDisc.mean < R1.nightDisc.mean * 0.6,
       'the report reproduces as a measurement: the reported night side is far darker ' +
       'than the one the user was happy with',
       `${R0.nightDisc.mean.toFixed(3)} vs ${R1.nightDisc.mean.toFixed(3)}`);
    ok(R1.wide.clippedPct > 5 && R0.wide.clippedPct < 1,
       'and so does the white it was fixed for, so both ends are real and measured here',
       `pre-fix ${R1.wide.clippedPct.toFixed(2)}%, as reported ${R0.wide.clippedPct.toFixed(2)}%`);

    //  The claim that a light at -SUN_DIR cannot touch the day side is a dot
    //  product, and this is it measured: three fill rows against row 0. Only
    //  set 1 holds row 0's ambient and directional while moving the fill, which
    //  is what makes the comparison mean anything; a set without three such
    //  rows is not evidence against the claim, so it says so and moves on
    //  rather than failing for a check it cannot run.
    const fills = rows.filter(r => r.c.fill > 0 && r.c.aAmb === R0.c.aAmb && r.c.aDir === R0.c.aDir);
    const dayMoved = fills.map(r => Math.abs(r.wide.meanMax - R0.wide.meanMax));
    if (fills.length >= 3) {
        ok(Math.max(...dayMoved) < 0.006,
           'a fill light aimed at -SUN_DIR leaves the whole day side exactly where it was',
           fills.map((r, k) => `${r.c.n}: lit-mean moved ${dayMoved[k].toFixed(4)}`).join('; '));
    } else {
        console.log(`  --   skipped: this set has ${fills.length} fill row(s) sharing row 0's ` +
                    "ambient/directional, so it cannot test the -SUN_DIR claim (set 1 does)");
    }

    const gate = r => {
        const a = nightAgg(r.night);
        const sand = r.spots.find(p => /Sahara/.test(p.name));
        return {
            r, a,
            dayClean: r.wide.clippedPct < 0.5 && r.close.clippedPct < 0.5,
            sandKept: !!(sand && sand.s && sand.s.spread >= 0.25),
            reliefKept: !!(r.relief && R0.relief && r.relief.sd >= R0.relief.sd * 0.85),
            nightPct: R1.nightDisc.mean ? r.nightDisc.mean / R1.nightDisc.mean : 0,
            seePct: a1.contrast ? (a.contrast || 0) / a1.contrast : 0,
        };
    };

    const g = rows.map(gate);
    console.log('\n══ every row against those two ends ══');
    console.log('   #  lighting                 day-clean  sand  relief  night%  land-sea%   verdict');
    for (const x of g) {
        const pass2 = x.dayClean && x.sandKept && x.reliefKept &&
                      x.nightPct >= 0.55 && x.seePct >= 0.55;
        console.log(`   ${String(x.r.i).padEnd(2)} ${x.r.c.n.padEnd(24)} ` +
                    `${(x.dayClean ? 'yes' : 'NO ').padStart(9)}  ` +
                    `${(x.sandKept ? 'yes' : 'NO ').padStart(4)}  ` +
                    `${(x.reliefKept ? 'yes' : 'NO ').padStart(6)}  ` +
                    `${(100 * x.nightPct).toFixed(0).padStart(5)}%  ` +
                    `${(100 * x.seePct).toFixed(0).padStart(8)}%   ` +
                    `${pass2 ? 'usable' : '-'}`);
    }
    //  Row 1 is excluded from the winners by construction -- it is the lighting
    //  being replaced -- so a winner is a row that is as legible as row 1 at night
    //  while keeping row 0's day side. Ranked by the weaker of its two night
    //  ratios, because a row that is bright but flat has not answered anything.
    const usable = g.filter(x => x.r.i !== 1 && x.dayClean && x.sandKept && x.reliefKept &&
                                 x.nightPct >= 0.55 && x.seePct >= 0.55);
    usable.sort((a, b) => Math.min(b.nightPct, b.seePct) - Math.min(a.nightPct, a.seePct));
    ok(usable.length > 0,
       'at least one candidate is legible at night without bringing the white back');
    if (usable.length) {
        const w = usable[0];
        console.log(`\n   best by measurement: [${w.r.i}] ${w.r.c.n}  ` +
                    `-- ambient ${w.r.c.aAmb}, directional ${w.r.c.aDir}, fill ${w.r.c.fill}`);
        console.log(`   night disc-mean ${w.r.nightDisc.mean.toFixed(3)} ` +
                    `(${(100 * w.nightPct).toFixed(0)}% of the pre-fix picture), ` +
                    `black ${w.r.nightDisc.blackPct.toFixed(2)}%, ` +
                    `land-sea ${n2(w.a.contrast)}, cities ${n2(w.a.city)}`);
        console.log(`   day  white ${w.r.wide.clippedPct.toFixed(2)}% wide / ` +
                    `${w.r.close.clippedPct.toFixed(2)}% close, Sahara spread ` +
                    `+${(w.r.spots.find(p => /Sahara/.test(p.name)).s.spread).toFixed(2)}, ` +
                    `relief sd ${w.r.relief.sd.toFixed(3)} against row 0's ${R0.relief.sd.toFixed(3)}`);
    }
}

//  The whole sweep in one block: both sides of the globe on the same line, which
//  is the thing every earlier probe here could not show.
function table(rows) {
    console.log('\n══ both sides of the globe, side by side ══');
    console.log('  #  lighting                 D-white  D-close  D-mean  sand   N-mean  N-black  ' +
                'land   sea  L-S   city  relief');
    for (const r of rows) {
        const a = nightAgg(r.night);
        const sah = r.spots.find(p => /Sahara/.test(p.name));
        const sp = sah && sah.s ? (sah.s.spread >= 0 ? '+' : '') + sah.s.spread.toFixed(2) : ' n/a';
        console.log(`  ${String(r.i).padEnd(2)} ${r.c.n.padEnd(24)} ` +
                    `${f2(r.wide.clippedPct, 6)}%  ${f2(r.close.clippedPct, 6)}%  ` +
                    `${r.wide.meanMax.toFixed(3).padStart(6)}  ${sp.padStart(5)}  ` +
                    `${r.nightDisc.mean.toFixed(3).padStart(6)}  ` +
                    `${f2(r.nightDisc.blackPct, 6)}%  ` +
                    `${n2(a.land).padStart(4)}  ${n2(a.sea).padStart(4)}  ` +
                    `${n2(a.contrast).padStart(4)}  ${n2(a.city).padStart(4)}  ` +
                    `${r.relief ? r.relief.sd.toFixed(3) : ' n/a '}`);
    }
    console.log('\n   D-* is the day view over the sub-solar point, N-* the night view over the');
    console.log('   anti-solar point -- the hemisphere in the second screenshot. land/sea/L-S are');
    console.log('   the night-side continents, the water beside them and the difference, which is');
    console.log('   what "you cannot tell which country that is" measures. relief is the standard');
    console.log('   deviation over the Karakoram: it falls when light moves into the ambient.');
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

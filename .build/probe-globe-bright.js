'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-globe-bright.js  --  how much of the land is blown to white?
//
//  Run:  node_modules/electron/dist/electron.exe .build/probe-globe-bright.js
//
//  THE REPORT, third screenshot: "globe kichu country onek brightness bere tader
//  land color bujha jacche na" -- some countries are so bright their land colour
//  cannot be made out. The regions ringed in red were the Sahara, the Arabian
//  peninsula, Central Asia and part of southern Europe/Russia.
//
//  Those are not four unrelated places. SUN_DIR is (260, 140, 190), which in
//  three-globe's convention is a sub-solar point at about 23.5 N, 53.9 E -- over
//  the Arabian desert. The ringed regions are the bright-albedo deserts nearest
//  that point, so the suspicion is ordinary highlight clipping: ambient 0.28 plus
//  directional 1.55 is 1.83x the texture's own colour where the sun is overhead,
//  and anything past 1.0 is cut off at white, taking the hue and the terrain with
//  it.
//
//  That is a story, and this file is here to replace it with numbers. It measures
//  three things in the shipped renderer, not in a model of it:
//    1. what the renderer and the globe material are actually set to, including
//       colour space and tone mapping, because the arithmetic above is only right
//       if lighting is a plain multiply into an untone-mapped buffer;
//    2. the real albedo of vendor/earth-blue-marble.jpg at the ringed regions,
//       decoded by Chromium rather than estimated by me;
//    3. the finished frame: what fraction of the globe, with the camera over the
//       sub-solar point, is pure white with no detail left in it.
//
//  Nothing is started, no port is bound, every request is cancelled, and the only
//  thing touched is the camera.
// ════════════════════════════════════════════════════════════════════
const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { geoFromMainJs } = require('./geo-from-main.js');

const ROOT = path.join(__dirname, '..');
const GEO  = geoFromMainJs(ROOT);
const HOME = { lat: 23.8103, lng: 90.4125, city: 'Dhaka', country: 'Bangladesh', cc: 'BD' };
//  Where SUN_DIR points, worked out in the header. The worst case is here.
const SUB_SOLAR = { lat: 23.5, lng: 53.9 };
const TAG = process.env.GB_TAG || 'now';

const LOG = path.join(__dirname, `probe-globe-bright-${TAG}.log`);
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

//  1. What is actually set. Read, not assumed: if the renderer were already
//  tone-mapping, or the texture were being decoded as sRGB into a linear
//  pipeline, the "ambient + directional times albedo" arithmetic above would be
//  the wrong model and the fix would have to be a different one.
const STATE = `(() => {
    const T = window.THREE, r = globe.renderer(), gm = globe.globeMaterial();
    const lights = [];
    globe.scene().traverse(o => {
        if (o.isLight) lights.push({ kind: o.type, i: o.intensity,
                                     col: o.color ? o.color.getHexString() : null });
    });
    const tex = gm && gm.map;
    return {
        rev: T.REVISION,
        toneMapping: r.toneMapping, exposure: r.toneMappingExposure,
        //  Both spellings: outputEncoding is pre-r152, outputColorSpace is after.
        outputEncoding: r.outputEncoding, outputColorSpace: r.outputColorSpace,
        physical: r.useLegacyLights === undefined ? null : !r.useLegacyLights,
        mat: gm ? {
            type: gm.type, color: gm.color && gm.color.getHexString(),
            emissive: gm.emissive && gm.emissive.getHexString(),
            specular: gm.specular && gm.specular.getHexString(),
            shininess: gm.shininess, bumpScale: gm.bumpScale,
            toneMapped: gm.toneMapped,
        } : null,
        texEncoding: tex ? tex.encoding : null,
        texColorSpace: tex ? tex.colorSpace : null,
        lights,
        //  Everything else in the scene that tone mapping would also reach, so a
        //  change here is a change with a known blast radius.
        materials: (() => {
            const seen = {};
            globe.scene().traverse(o => {
                if (!o.material) return;
                for (const m of [].concat(o.material)) {
                    const k = m.type + (m.toneMapped === false ? ' (opted out)' : '');
                    seen[k] = (seen[k] || 0) + 1;
                }
            });
            return seen;
        })(),
        names: { ACESFilmic: T.ACESFilmicToneMapping, Reinhard: T.ReinhardToneMapping,
                 Linear: T.LinearToneMapping, None: T.NoToneMapping,
                 sRGBEncoding: T.sRGBEncoding, LinearEncoding: T.LinearEncoding },
    };
})()`;

let win = null;
const run  = js => win.webContents.executeJavaScript(js, true);
const logs = [], netHits = [];
let died = null;

//  3. The finished frame. capturePage gives a NativeImage and getBitmap() gives
//  its raw BGRA bytes, so the pixels the user is looking at are counted directly
//  -- no PNG decoder, no re-render, no second guess at what the shader did.
async function frameStats(name) {
    const img = await win.webContents.capturePage();
    const { width, height } = img.getSize();
    const buf = img.getBitmap();
    fs.writeFileSync(path.join(__dirname, name), img.toPNG());
    //  The sidebar is 400 CSS px of white UI; the capture is scaled, so the cut is
    //  taken from the ratio rather than from the constant.
    const scale = width / 1000;
    const x0 = Math.round(410 * scale);
    let n = 0, clipped = 0, sum = 0, mx = 0, hot = 0;
    for (let y = 0; y < height; y++) {
        for (let x = x0; x < width; x++) {
            const i = (y * width + x) * 4;
            const b = buf[i], g = buf[i + 1], r = buf[i + 2];
            //  Only the globe: at this altitude it fills the pane, and anything
            //  this dark is the background or the caption's dark pill.
            if (r + g + b < 90) continue;
            n++;
            const m = Math.max(r, g, b);
            sum += m; mx = Math.max(mx, m);
            //  "No land colour left in it": all three channels at the top of the
            //  range means both the hue and the terrain detail are gone.
            if (r >= 250 && g >= 250 && b >= 250) clipped++;
            else if (m >= 250) hot++;
        }
    }
    return { width, height, px: n, clipped, hot,
             clippedPct: n ? 100 * clipped / n : 0,
             hotPct: n ? 100 * hot / n : 0,
             meanMax: n ? sum / n / 255 : 0, maxMax: mx / 255, file: name };
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
    await sleep(4500);
    await measure();
    report();
    win.destroy();
    app.exit(fail ? 1 : 0);
}).catch(err => {
    console.log('  FAIL the probe itself threw  -- ' + (err && err.stack || err));
    app.exit(1);
});

async function measure() {
    console.log('── 1. what the renderer and the globe material are actually set to ──');
    const st = await run(STATE);
    const nameOf = (v, group) => {
        for (const k of Object.keys(st.names)) if (st.names[k] === v) return `${k} (${v})`;
        return String(v);
    };
    console.log(`   three.js r${st.rev}`);
    console.log(`   tone mapping ${nameOf(st.toneMapping)}, exposure ${st.exposure}`);
    console.log(`   output ${st.outputEncoding !== undefined
        ? 'encoding ' + nameOf(st.outputEncoding) : 'colorSpace ' + st.outputColorSpace}` +
        `,  texture ${st.texEncoding !== undefined && st.texEncoding !== null
        ? 'encoding ' + nameOf(st.texEncoding) : 'colorSpace ' + st.texColorSpace}`);
    console.log(`   globe material ${JSON.stringify(st.mat)}`);
    console.log(`   lights ${JSON.stringify(st.lights)}`);
    console.log(`   every material in the scene ${JSON.stringify(st.materials)}`);
    const lit = st.lights.reduce((s, l) => s + (l.i || 0), 0);
    console.log(`   total light landing on the sub-solar point: ${lit.toFixed(2)}x albedo`);

    console.log('\n── 2. the texture\'s own colour where the report ringed it ──');
    const al = await run(ALBEDO);
    console.log(`   vendor/earth-blue-marble.jpg is ${al.size[0]}x${al.size[1]}`);
    for (const [k, v] of Object.entries(al.spots)) {
        //  What that albedo becomes once the lights multiply it, and whether that
        //  lands past 1.0 -- which is the whole question.
        const out = [v.r, v.g, v.b].map(c => c * lit);
        const cut = out.filter(c => c > 1).length;
        console.log(`   ${k.padEnd(26)} albedo ${v.r.toFixed(2)} ${v.g.toFixed(2)} ` +
                    `${v.b.toFixed(2)}  ->  ${out.map(c => c.toFixed(2)).join(' ')}` +
                    `   ${cut === 3 ? '<-- all three clip: white, no hue, no terrain'
                                    : cut ? `<-- ${cut} channel(s) clip: hue shifts` : ''}`);
    }

    console.log('\n── 3. the finished frame, camera over the sub-solar point ──');
    //  autoRotate would move the terminator between the two runs of this file and
    //  make the before and after numbers incomparable, so it is stopped. It is a
    //  camera setting; the lighting is fixed in world space and does not move.
    await run('globe.controls().autoRotate = false; null');
    await run(`globe.pointOfView({ lat: ${SUB_SOLAR.lat}, lng: ${SUB_SOLAR.lng}, ` +
              `altitude: 0.62 }, 0); null`);
    await sleep(2200);
    const f = await frameStats(`probe-globe-bright-${TAG}.png`);
    console.log(`   ${f.px} globe pixels examined in a ${f.width}x${f.height} capture`);
    console.log(`   pure white, no detail left: ${f.clipped} px = ${f.clippedPct.toFixed(2)}%`);
    console.log(`   one or two channels maxed:  ${f.hot} px = ${f.hotPct.toFixed(2)}%`);
    console.log(`   mean brightest channel ${f.meanMax.toFixed(3)}, peak ${f.maxMax.toFixed(3)}`);
    console.log(`   wrote ${f.file}`);

    //  The user's complaint, as a number: a region is "too bright to make out"
    //  when every channel is at the top of the range, because then neither the
    //  land's colour nor the bump map's relief survives. One per cent of the lit
    //  globe is about the size of a small country at this zoom -- below that, no
    //  region reads as a white patch.
    ok(f.clippedPct < 1.0,
       'less than 1% of the globe is blown to featureless white',
       `${f.clippedPct.toFixed(2)}% is, over ${f.px} pixels`);
    //  And the fix has to be a roll-off, not a dimming: if the whole globe were
    //  simply turned down, the deserts would stop clipping but the picture would
    //  go dull. So the mean is held up as well.
    ok(f.meanMax > 0.42,
       'and the globe is still brightly lit rather than merely dimmed',
       `mean brightest channel ${f.meanMax.toFixed(3)}`);
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
//  2. The texture's own colour at the places that were ringed, decoded by the
//  browser. equirectangular, so x = (lng + 180)/360 and y = (90 - lat)/180.
//  Each sample is the mean over a small box, not one pixel, so a single bright
//  speck cannot stand in for a region.
const ALBEDO = `(async () => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej;
                                      img.src = 'vendor/earth-blue-marble.jpg'; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const box = (lat, lng, deg) => {
        const x0 = Math.round((lng - deg + 180) / 360 * c.width);
        const y0 = Math.round((90 - lat - deg) / 180 * c.height);
        const w  = Math.max(1, Math.round(2 * deg / 360 * c.width));
        const h  = Math.max(1, Math.round(2 * deg / 180 * c.height));
        const d  = cx.getImageData(x0, y0, w, h).data;
        let r = 0, g = 0, b = 0, mx = 0;
        for (let i = 0; i < d.length; i += 4) {
            r += d[i]; g += d[i + 1]; b += d[i + 2];
            mx = Math.max(mx, d[i], d[i + 1], d[i + 2]);
        }
        const n = d.length / 4;
        return { r: r / n / 255, g: g / n / 255, b: b / n / 255, max: mx / 255 };
    };
    return {
        size: [c.width, c.height],
        //  The four regions ringed in red, then three controls: the sub-solar
        //  point itself, a dark forest, and open ocean.
        spots: {
            'Sahara (Libya)':        box(25, 17, 3),
            'Arabia (Saudi)':        box(24, 45, 3),
            'Central Asia (Kyzylkum)': box(42, 63, 3),
            'southern Russia (Volga)': box(48, 46, 3),
            'the sub-solar point':   box(23.5, 53.9, 3),
            'Amazon basin':          box(-4, -62, 3),
            'open Pacific':          box(0, -140, 3),
        },
    };
})()`;

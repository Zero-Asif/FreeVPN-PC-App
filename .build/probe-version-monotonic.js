'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-version-monotonic.js  --  can the FIXED background.js actually
//  reach a browser that already has the old one? READ ONLY.
//
//  Why this matters more than it sounds. The problem-1 repair lives in
//  Extension/background.js. Chromium's updater installs a CRX only when its
//  version is GREATER than the one already unpacked. lib/geo-ext.js::_stage()
//  derives that fourth version component from ext-restore.json:
//
//      let build = Number.isInteger(prev.build) ? prev.build : 0;
//      if (prev.hash !== hash) build += 1;
//
//  If ext-restore.json is missing or its `build` is gone, that expression
//  restarts at 1 -- no matter how high the version already installed in the
//  browsers is. Brave was measured holding 1.1.0.1_0. So a rebuild whose bytes
//  changed could hand every browser a package numbered 1.1.0.1 again, and every
//  browser would compare, find nothing newer, and keep the OLD background.js.
//  The fix would be on disk and never in the browser.
//
//  Whether that is happening here is a question about four numbers on this
//  machine, so read all four rather than reasoning about them:
//
//    * ext-restore.json     -- what _stage() will use as `prev`
//    * the staged manifest  -- the version the last prepare() actually wrote
//    * the delivery bundle  -- the version the helper is serving right now
//    * every browser profile -- the version each browser has unpacked
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const LOCAL = process.env.LOCALAPPDATA || '';
const PD = path.join(process.env.ProgramData || 'C:\\ProgramData', 'freeproxy-vpn');
const j = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const cmp = (a, b) => {          // -1 / 0 / 1 on dotted versions, Chromium's rule
    const A = String(a).split('.').map(Number), B = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
        const x = A[i] || 0, y = B[i] || 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
};

console.log('══════════ 1. ext-restore.json -- what _stage() reads as `prev` ══════════');
const restorePath = path.join(PD, 'ext-restore.json');
const restore = j(restorePath);
if (!restore) console.log('  MISSING or unreadable: ' + restorePath +
                          '\n  -> prev.build is undefined, so build restarts at 0 and becomes 1');
else {
    console.log('  path     ' + restorePath);
    console.log('  build    ' + JSON.stringify(restore.build) +
                (Number.isInteger(restore.build) ? '' : '   <<< NOT AN INTEGER: restarts at 0'));
    console.log('  version  ' + JSON.stringify(restore.version));
    console.log('  hash     ' + (restore.hash ? String(restore.hash).slice(0, 16) + '...' : '(none)'));
    console.log('  id       ' + JSON.stringify(restore.id));
}

console.log('\n══════════ 2. the staged manifest -- what the last prepare() wrote ══════════');
const stagedMf = j(path.join(PD, 'browser-setup', 'extension', 'manifest.json'));
console.log('  version  ' + (stagedMf ? stagedMf.version : '(no staged manifest)'));
const stagedBg = path.join(PD, 'browser-setup', 'extension', 'background.js');
try {
    const bg = fs.readFileSync(stagedBg, 'utf8');
    console.log('  background.js  ' + bg.length + ' bytes, mtime ' +
                fs.statSync(stagedBg).mtime.toISOString());
    console.log('  onRemoved release  ' + (bg.includes('chrome.windows.onRemoved') ? 'PRESENT' : 'ABSENT'));
    console.log('  fpProxyLeftOn mark ' + (bg.includes('fpProxyLeftOn') ? 'PRESENT' : 'ABSENT'));
} catch (e) { console.log('  background.js unreadable: ' + e.code); }

console.log('\n══════════ 3. the delivery bundle -- what the helper serves ══════════');
const bundle = j(path.join(PD, 'ext-bundle.json')) || j(path.join(PD, 'delivery', 'bundle.json'));
if (bundle) {
    console.log('  version  ' + bundle.version + '   id ' + bundle.id + '   port ' + bundle.port);
} else {
    //  Find it rather than guess its name.
    let hits = [];
    const walk = (dir, depth) => {
        if (depth > 2) return;
        let ents = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of ents) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p, depth + 1);
            else if (/\.json$/i.test(e.name)) {
                const o = j(p);
                if (o && o.id && o.version && o.port) hits.push([p, o]);
            }
        }
    };
    walk(PD, 0);
    if (!hits.length) console.log('  no bundle json found under ' + PD);
    hits.forEach(([p, o]) => console.log(`  ${p}\n     version ${o.version}  id ${o.id}  port ${o.port}`));
}

console.log('\n══════════ 4. what each browser has UNPACKED right now ══════════');
const id = (restore && restore.id) || (stagedMf && '(id needs the key)') || null;
const LIVE = 'bmdkiblidpidilbeebghppkifmdhheog';
const useId = (restore && restore.id) || LIVE;
console.log('  looking for id ' + useId + (restore && restore.id ? '' : '   (from the measured live id)'));
let highest = null;
for (const [browser, root] of [
    ['Brave',  path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data')],
    ['Chrome', path.join(LOCAL, 'Google', 'Chrome', 'User Data')],
    ['Edge',   path.join(LOCAL, 'Microsoft', 'Edge', 'User Data')],
]) {
    let dirs = [];
    try {
        dirs = fs.readdirSync(root, { withFileTypes: true })
            .filter(d => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
            .map(d => d.name);
    } catch (e) { console.log(`  ${browser.padEnd(7)} no User Data`); continue; }
    for (const p of dirs) {
        const extDir = path.join(root, p, 'Extensions', useId);
        let vers = [];
        try { vers = fs.readdirSync(extDir); } catch (e) {}
        const clean = vers.map(v => v.replace(/_\d+$/, ''));
        clean.forEach(v => { if (!highest || cmp(v, highest) > 0) highest = v; });
        console.log(`  ${browser.padEnd(7)} ${p.padEnd(10)} ` +
                    (clean.length ? clean.join(', ') : '(nothing unpacked)'));
        //  Does that copy have the repair in it?
        for (const v of vers) {
            const bgp = path.join(extDir, v, 'background.js');
            try {
                const bg = fs.readFileSync(bgp, 'utf8');
                console.log(`            ${v}: onRemoved ` +
                            (bg.includes('chrome.windows.onRemoved') ? 'PRESENT' : 'ABSENT') +
                            ', fpProxyLeftOn ' + (bg.includes('fpProxyLeftOn') ? 'PRESENT' : 'ABSENT'));
            } catch (e) {}
        }
    }
}

console.log('\n══════════ 5. the verdict ══════════');
const nextBuild = (Number.isInteger(restore && restore.build) ? restore.build : 0) + 1;
const base = stagedMf ? String(stagedMf.version).split('.').slice(0, 3).join('.') : '1.1.0';
const next = `${base}.${nextBuild}`;
console.log('  highest version any browser has unpacked   ' + (highest || '(none)'));
console.log('  version the NEXT changed stage would emit  ' + next);
if (!highest) console.log('  -> no browser has it, so any version installs. No defect visible here.');
else if (cmp(next, highest) > 0)
    console.log('  -> ' + next + ' > ' + highest + ': an update WOULD be picked up.');
else
    console.log('  -> ' + next + ' <= ' + highest + ': THE UPDATE WOULD BE IGNORED. ' +
                'Chromium keeps the copy it has, and the repair never reaches the browser.');

console.log('\nNothing was modified.');

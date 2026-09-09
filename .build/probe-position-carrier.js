'use strict';
//  Where is the replayed position actually stored?
//
//  probe-brave-nav-order.py measured that every "Your Location" click navigates
//  to /maps/@38.8951644,-77.0364331 -- the SAME digits six times over two
//  minutes. makePosition() adds jitter(0.0008) to lat and lng on every call
//  (Extension/geo-spoof.js:253), so identical digits cannot be six answers from
//  our shim: they are ONE answer of ours, from the US era, stored by Maps and
//  replayed. test-clear-scope.js then measured that an origin-filtered clear
//  really does take localStorage, sessionStorage, indexedDB, cacheStorage and
//  the HTTP cache for the origin it names -- so if the value survived, either
//  google.com was not in that list, or it lives somewhere the clear leaves
//  alone by design (Google's cookies are never cleared: only MAP_ONLY_HOST
//  origins get a cookie clear, to keep the user signed in).
//
//  So stop reasoning and search the profile for the digits themselves. Every
//  file, every browser: name the file that holds them.
const fs = require('fs');
const path = require('path');
const B = require('../lib/browsers.js');

const NEEDLES = process.argv.slice(2).filter(a => !a.startsWith('-'));
const WANT = NEEDLES.length ? NEEDLES : ['38.8951644', '77.0364331', '38.8951', '77.0364'];
const MAXB = 64 * 1024 * 1024;

let scanned = 0, skipped = 0;
const found = [];

function scan(file) {
    let st;
    try { st = fs.statSync(file); } catch (e) { return; }
    if (!st.isFile() || st.size === 0 || st.size > MAXB) { skipped++; return; }
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { skipped++; return; }
    scanned++;
    const txt = buf.toString('latin1');
    for (const n of WANT) {
        let i = -1;
        while ((i = txt.indexOf(n, i + 1)) !== -1) {
            const ctx = txt.slice(Math.max(0, i - 90), i + 110).replace(/[^\x20-\x7E]/g, '·');
            found.push({ file, needle: n, at: i, ctx, mtime: st.mtime.toISOString() });
            if (found.length > 4000) return;
        }
    }
}

function walk(dir, depth) {
    if (depth > 8) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else scan(p);
    }
}

const ud = B.chromiumUserData();
const only = (process.argv.find(a => a.startsWith('--browser=')) || '').split('=')[1];
for (const [bid, root] of Object.entries(ud)) {
    if (only && bid !== only) continue;
    let profiles = [];
    try {
        profiles = fs.readdirSync(root, { withFileTypes: true })
            .filter(d => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'Preferences')))
            .map(d => d.name);
    } catch (e) { continue; }
    for (const p of profiles) {
        const before = found.length;
        const t0 = Date.now();
        walk(path.join(root, p), 0);
        console.log('== ' + bid + ' \\ ' + p + '   ' + (found.length - before) + ' hit(s)   ' +
                    ((Date.now() - t0) / 1000).toFixed(1) + 's');
    }
}

console.log('');
console.log('files read ' + scanned + ', skipped ' + skipped + ', hits ' + found.length);
const byFile = new Map();
for (const f of found) {
    const k = f.file + '|' + f.needle;
    if (!byFile.has(k)) byFile.set(k, { ...f, n: 0 });
    byFile.get(k).n++;
}
for (const v of [...byFile.values()].sort((a, b) => b.n - a.n)) {
    console.log('');
    console.log(v.needle + '  x' + v.n + '   ' + v.mtime);
    console.log('   ' + v.file);
    console.log('   ' + v.ctx);
}

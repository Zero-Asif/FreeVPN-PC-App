'use strict';
//  probe-dup-extension.js filters rows by name, so a record with no manifest --
//  the `"<id>": {}` shape -- reads as name '' and is skipped. Chrome still draws
//  a row for anything it has an id for, so this lists EVERY id with no filter at
//  all, from every profile dir that has a Preferences file (not just
//  Default/Profile N), plus every Extensions\<id> dir on disk, plus the external
//  JSON files. Also sizes History/Cookies/Cache, which is the second question:
//  what did the app actually clear.
const fs = require('fs');
const path = require('path');
const B = require('../lib/browsers.js');

const LOC = { 1: 'INTERNAL', 2: 'EXTERNAL_PREF', 3: 'EXTERNAL_REGISTRY',
              4: 'UNPACKED', 5: 'COMPONENT', 6: 'EXTERNAL_PREF_DOWNLOAD',
              7: 'EXTERNAL_POLICY_DOWNLOAD', 8: 'EXTERNAL_COMPONENT',
              9: 'EXTERNAL_POLICY', 10: 'COMMAND_LINE' };

const ud = B.chromiumUserData();

function profileDirs(root) {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return out; }
    for (const d of names) {
        if (!d.isDirectory()) continue;
        if (fs.existsSync(path.join(root, d.name, 'Preferences')) ||
            fs.existsSync(path.join(root, d.name, 'Secure Preferences'))) out.push(d.name);
    }
    return out;
}

function sizeOf(p) {
    try {
        const st = fs.statSync(p);
        if (st.isFile()) return st.size;
        let n = 0;
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
            n += e.isDirectory() ? sizeOf(path.join(p, e.name))
                                 : (fs.statSync(path.join(p, e.name)).size || 0);
        }
        return n;
    } catch (e) { return -1; }
}
const kb = n => n < 0 ? '--' : (n / 1024).toFixed(0).padStart(9) + ' KB';
const when = p => { try { return fs.statSync(p).mtime.toISOString(); } catch (e) { return '--'; } };

for (const [id, root] of Object.entries(ud)) {
    console.log('══ ' + id + '  ' + root);
    let localState = null;
    try { localState = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8')); }
    catch (e) {}
    const cache = ((localState || {}).profile || {}).info_cache;
    console.log('   Local State profiles: ' +
                (cache ? Object.keys(cache).join(', ') : '-- unreadable'));

    for (const p of profileDirs(root)) {
        const rows = new Map();
        for (const file of ['Preferences', 'Secure Preferences']) {
            let j;
            try { j = JSON.parse(fs.readFileSync(path.join(root, p, file), 'utf8')); }
            catch (e) { continue; }
            const settings = (j.extensions && j.extensions.settings) || {};
            for (const [extId, rec] of Object.entries(settings)) {
                const cur = rows.get(extId) || { in: [], rec: null };
                cur.in.push(file === 'Preferences' ? 'P' : 'S');
                //  Prefer whichever copy actually carries a manifest.
                if (!cur.rec || (!cur.rec.manifest && rec.manifest)) cur.rec = rec;
                rows.set(extId, cur);
            }
        }
        console.log(`   ── ${p}   ${rows.size} extension records`);
        for (const [extId, { in: where, rec }] of rows) {
            const m = rec.manifest || {};
            console.log(`      ${extId}  [${where.join('+')}]  ` +
                        `loc ${String(rec.location).padEnd(2)} ${(LOC[rec.location] || '?').padEnd(22)} ` +
                        `state ${rec.state}`);
            console.log(`         name "${m.name || '(no manifest)'}"  v${m.version || '?'}  ` +
                        `key ${m.key ? 'yes' : 'no'}  webstore ${rec.from_webstore}  ` +
                        `ack ${rec.ack_external}  path ${rec.path || '-'}`);
            if (rec.disable_reasons) console.log(`         disable_reasons ${JSON.stringify(rec.disable_reasons)}`);
        }
        const extRoot = path.join(root, p, 'Extensions');
        let dirs = [];
        try { dirs = fs.readdirSync(extRoot).filter(n => /^[a-p]{32}$/.test(n)); } catch (e) {}
        console.log(`      Extensions\\ on disk: ${dirs.length}`);
        for (const d of dirs) {
            if (rows.has(d)) continue;
            let vers = [];
            try { vers = fs.readdirSync(path.join(extRoot, d)); } catch (e) {}
            console.log(`         ORPHAN DIR (no prefs row)  ${d}  ${vers.join(', ')}`);
        }

        console.log(`      History      ${kb(sizeOf(path.join(root, p, 'History')))}   ${when(path.join(root, p, 'History'))}`);
        console.log(`      Cookies      ${kb(sizeOf(path.join(root, p, 'Network', 'Cookies')))}   ${when(path.join(root, p, 'Network', 'Cookies'))}`);
        console.log(`      Cache        ${kb(sizeOf(path.join(root, p, 'Cache', 'Cache_Data')))}`);
        console.log(`      Local Storage${kb(sizeOf(path.join(root, p, 'Local Storage', 'leveldb')))}`);
        console.log(`      Login Data   ${kb(sizeOf(path.join(root, p, 'Login Data')))}`);
    }
    console.log('');
}

console.log('── External Extensions JSON files ──');
for (const b of B.CHROMIUM) {
    const roots = [];
    if (ud[b.id]) roots.push(path.join(ud[b.id], 'External Extensions'));
    for (const exe of [b.exe, b.exe86].filter(Boolean)) {
        roots.push(path.join(path.dirname(exe), 'default_apps'));
        roots.push(path.join(path.dirname(exe), '..', 'External Extensions'));
    }
    for (const r of roots) {
        let files = [];
        try { files = fs.readdirSync(r); } catch (e) { continue; }
        for (const f of files) {
            console.log(`   ${b.id}  ${path.join(r, f)}`);
            try { console.log('     ' + fs.readFileSync(path.join(r, f), 'utf8').replace(/\s+/g, ' ').slice(0, 400)); }
            catch (e) { console.log('     -- ' + e.code); }
        }
    }
}

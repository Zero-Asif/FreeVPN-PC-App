'use strict';
//  Did the extension id CHANGE across installs? Look for any surviving trace of
//  an id other than the current one: leftover unpacked trees in every Chromium
//  profile, ids named in this app's own logs, and ids still named anywhere in
//  the registry. A second id anywhere is the two rows the user photographed.
const fs = require('fs');
const path = require('path');
const B = require('../lib/browsers.js');
const crx = require('../lib/crx.js');

const STATE = path.join(process.env.ProgramData || 'C:\\ProgramData', 'freeproxy-vpn');
let ourId = null;
try { ourId = crx.idForKey(fs.readFileSync(path.join(STATE, 'ext-key.pem'), 'utf8')); } catch (e) {}
console.log('current id: ' + ourId);

console.log('');
console.log('── leftover extension trees, every Chromium profile ──');
const ud = B.chromiumUserData();
for (const [bid, root] of Object.entries(ud)) {
    let profiles = [];
    try {
        profiles = fs.readdirSync(root).filter(n =>
            (n === 'Default' || /^Profile \d+$/.test(n)) &&
            fs.existsSync(path.join(root, n, 'Extensions')));
    } catch (e) { continue; }
    for (const p of profiles) {
        const dir = path.join(root, p, 'Extensions');
        for (const id of fs.readdirSync(dir)) {
            if (!/^[a-p]{32}$/.test(id)) continue;
            let vers = [];
            try { vers = fs.readdirSync(path.join(dir, id)); } catch (e) { continue; }
            let name = '?';
            for (const v of vers) {
                try {
                    name = JSON.parse(fs.readFileSync(path.join(dir, id, v, 'manifest.json'), 'utf8')).name;
                    break;
                } catch (e) {}
            }
            if (!/freeproxy/i.test(String(name))) continue;
            const st = fs.statSync(path.join(dir, id));
            console.log(`   ${bid}/${p}  ${id}  ${id === ourId ? 'CURRENT' : '*** STALE ***'}  ` +
                        `${vers.join(',')}  ${st.mtime.toISOString()}`);
        }
    }
}

console.log('');
console.log('── ids this app has named in its own logs ──');
const logDirs = [path.join(process.env.LOCALAPPDATA || '', 'FreeProxy VPN', 'logs'),
                 path.join(STATE, 'logs')];
const ids = new Map();
for (const d of logDirs) {
    let files = [];
    try { files = fs.readdirSync(d); } catch (e) { console.log(`   ${d} -- ${e.code}`); continue; }
    for (const f of files) {
        let txt = '';
        try { txt = fs.readFileSync(path.join(d, f), 'utf8'); } catch (e) { continue; }
        for (const m of txt.matchAll(/\b([a-p]{32})\b/g)) {
            const k = m[1];
            if (!ids.has(k)) ids.set(k, { file: f, n: 0 });
            ids.get(k).n++;
        }
    }
    console.log(`   ${d}  ${files.length} files`);
}
for (const [id, o] of ids) {
    console.log(`   ${id}  ${id === ourId ? 'CURRENT' : '*** OTHER ID ***'}  ${o.n} mentions, first in ${o.file}`);
}
if (!ids.size) console.log('   (no id appears in any log)');

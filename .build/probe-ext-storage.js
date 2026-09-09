'use strict';
//  The extension's console is empty exactly on the failing runs; the LevelDB
//  under Local Extension Settings is not. Dump what each browser's copy of the
//  extension actually has in chrome.storage.local right now, so Chrome's
//  first-load miss and Brave's stale third switch can be compared against the
//  country the app is really on.
const fs = require('fs');
const path = require('path');
const B = require('../lib/browsers.js');
const crx = require('../lib/crx.js');

const STATE = path.join(process.env.ProgramData || 'C:\\ProgramData', 'freeproxy-vpn');
let ourId = null;
try { ourId = crx.idForKey(fs.readFileSync(path.join(STATE, 'ext-key.pem'), 'utf8')); } catch (e) {}

//  No LevelDB library here, and adding one to ship a diagnostic would be worse
//  than reading the log by hand: a .log file is a sequence of records whose
//  payloads are the raw key/value strings, so the JSON is recoverable by
//  scanning for it. Every {...} that parses is reported with its key prefix.
const readLdb = (dir) => {
    const out = [];
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) { return out; }
    for (const f of files.sort()) {
        if (!/\.(log|ldb|sst)$/.test(f)) continue;
        let buf;
        try { buf = fs.readFileSync(path.join(dir, f)); } catch (e) { continue; }
        const txt = buf.toString('latin1');
        //  Keys this extension uses are plain ASCII words; values are JSON.
        for (const m of txt.matchAll(/([\x20-\x7E]{2,40}?)(\{[\x20-\x7E]{2,4000}?\})/g)) {
            let j;
            try { j = JSON.parse(m[2]); } catch (e) { continue; }
            if (j === null || typeof j !== 'object') continue;
            out.push({ file: f, keyish: m[1].replace(/[^A-Za-z0-9_.:-]/g, '').slice(-40), json: j });
        }
    }
    return out;
};

console.log('id ' + ourId);
console.log('');
const ud = B.chromiumUserData();
for (const [bid, root] of Object.entries(ud)) {
    let profiles = [];
    try {
        profiles = fs.readdirSync(root).filter(n => n === 'Default' || /^Profile \d+$/.test(n));
    } catch (e) { continue; }
    for (const p of profiles) {
        const dir = path.join(root, p, 'Local Extension Settings', ourId || '');
        if (!ourId || !fs.existsSync(dir)) continue;
        const recs = readLdb(dir);
        const st = fs.statSync(dir);
        console.log(`── ${bid}/${p}   ${recs.length} json records, dir mtime ${st.mtime.toISOString()}`);
        //  Newest first: the last record written for a key is the live one.
        const byKey = new Map();
        for (const r of recs) {
            const k = Object.keys(r.json).sort().join(',') || '(empty)';
            byKey.set(k + '|' + r.keyish, r);
        }
        for (const [k, r] of byKey) {
            const s = JSON.stringify(r.json);
            console.log(`   ${r.keyish.padEnd(24)} ${s.length > 300 ? s.slice(0, 300) + '...' : s}`);
        }
        if (!recs.length) console.log('   (nothing parsed out of the LevelDB)');
        console.log('');
    }
}
//  What the app itself thinks it is on, for the comparison.
for (const f of ['geo-state.json', 'state.json', 'last-country.json', 'boot-result.json']) {
    try {
        console.log(`app ${f}: ` + fs.readFileSync(path.join(STATE, f), 'utf8').slice(0, 400));
    } catch (e) {}
}

'use strict';
//  When did each browser actually take the extension? Two independent clocks:
//  the profile's own `install_time` (Chromium microseconds since 1601-01-01)
//  and the mtime of the unpacked folder on disk. Printed in local time next to
//  the moment the routes were written, so "+N min" is a measurement, not a
//  memory.
const fs = require('fs');
const path = require('path');
const browsers = require('../lib/browsers');

const ID = process.argv[2] || 'edfdpeehkfpjhhgpkaoiahndelmcimfn';
const EPOCH_DIFF_US = 11644473600e6;          // 1601-01-01 -> 1970-01-01
const chromiumTime = us => new Date((Number(us) - EPOCH_DIFF_US) / 1000);
const fmt = d => (d && !isNaN(d)) ? d.toLocaleString('sv-SE') : 'n/a';

// the moment lib/ext-deliver.js published the routes
let wrote = null;
try {
    const d = JSON.parse(fs.readFileSync('C:\\ProgramData\\freeproxy-vpn\\browser-setup\\delivery.json', 'utf8'));
    if (d && d.at) wrote = new Date(d.at);
} catch (e) {}
console.log('routes written : ' + fmt(wrote) + (wrote ? '' : '  (delivery.json unreadable)'));
console.log('');

const roots = browsers.chromiumUserData();
for (const b of browsers.CHROMIUM) {
    const root = roots[b.id];
    if (!root || !fs.existsSync(root)) continue;

    for (const store of ['Secure Preferences', 'Preferences']) {
        const p = path.join(root, 'Default', store);
        let j;
        try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { continue; }
        const rec = j && j.extensions && j.extensions.settings && j.extensions.settings[ID];
        if (!rec) continue;

        const inst = rec.install_time ? chromiumTime(rec.install_time) : null;
        let dirTime = null;
        try {
            const dir = path.join(root, 'Default', 'Extensions', ID);
            const sub = fs.readdirSync(dir)[0];
            dirTime = fs.statSync(path.join(dir, sub)).mtime;
        } catch (e) {}

        const mins = t => (wrote && t) ? ((t - wrote) / 60000).toFixed(1) + ' min after the write' : '';
        console.log(`${b.name}  (${store})`);
        console.log(`   install_time : ${fmt(inst)}   ${mins(inst)}`);
        console.log(`   folder mtime : ${fmt(dirTime)}   ${mins(dirTime)}`);
        console.log(`   location     : ${rec.location}   disable_reasons: ${JSON.stringify(rec.disable_reasons)}`);
        console.log('');
        break;
    }
}

'use strict';
//  probe-live-workers.js matched each {...} separately, so an ARRAY value shows
//  up as its first element and the key looks like a scalar. mapsNavFix() and
//  noteLocationChange() both require geoSeen to be an Array, so the shape is the
//  whole question: dump the raw bytes that follow the key.
const fs = require('fs');
const path = require('path');
const B = require('../lib/browsers.js');

const KEYS = process.argv.slice(2).filter(a => !a.startsWith('-'));
const WANT = KEYS.length ? KEYS : ['geoSeen', 'geoLast', 'geoOrigins'];

const ud = B.chromiumUserData();
for (const [bid, root] of Object.entries(ud)) {
    const les = path.join(root, 'Default', 'Local Extension Settings');
    let ids = [];
    try { ids = fs.readdirSync(les).filter(n => /^[a-p]{32}$/.test(n)); } catch (e) { continue; }
    for (const id of ids) {
        let files = [];
        try { files = fs.readdirSync(path.join(les, id)); } catch (e) { continue; }
        const hits = [];
        for (const f of files) {
            if (!/\.(log|ldb|sst)$/.test(f)) continue;
            let txt;
            try { txt = fs.readFileSync(path.join(les, id, f)).toString('latin1'); } catch (e) { continue; }
            for (const key of WANT) {
                let i = -1;
                while ((i = txt.indexOf(key, i + 1)) !== -1) {
                    const after = txt.slice(i + key.length, i + key.length + 700)
                        .replace(/[^\x20-\x7E]/g, '·');
                    hits.push({ f, key, at: i, after });
                }
            }
        }
        if (!hits.length) continue;
        console.log('══ ' + bid + '  ' + id + '   ' + hits.length + ' hit(s)');
        for (const h of hits) console.log('   ' + h.key + ' @' + h.f + ':' + h.at + '\n      ' + h.after);
        console.log('');
    }
}

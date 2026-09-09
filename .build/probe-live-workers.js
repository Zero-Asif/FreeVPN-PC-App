'use strict';
//  How many copies of this extension are actually RUNNING, and what country each
//  one is holding. A prefs row proves a browser drew a row; only a write into
//  Local Extension Settings\<id> proves that id executed. Directory mtimes do
//  not move when a file inside is rewritten on Windows, so this reads FILE
//  mtimes, and every geoSpoof record it can recover, with the stamp decoded.
const fs = require('fs');
const path = require('path');
const B = require('../lib/browsers.js');
const crx = require('../lib/crx.js');

const STATE = path.join(process.env.ProgramData || 'C:\\ProgramData', 'freeproxy-vpn');
let keyId = null;
try { keyId = crx.idForKey(fs.readFileSync(path.join(STATE, 'ext-key.pem'), 'utf8')); } catch (e) {}
console.log('key-hash id (packed copy): ' + keyId);

const STAGED = path.join(STATE, 'browser-setup', 'extension');
for (const dir of [STAGED, path.join('C:\\Program Files', 'FreeProxy VPN', 'resources', 'Extension')]) {
    let has = false, hasKey = false, ver = '?';
    try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        has = true; hasKey = !!m.key; ver = m.version;
    } catch (e) {}
    console.log('  ' + dir);
    console.log('     manifest ' + (has ? 'present v' + ver + '  key ' + (hasKey ? 'YES -> loads as ' + keyId : 'no -> loads as path hash')
                                        : 'ABSENT'));
    if (has && !hasKey && crx.idForPath) {
        try { console.log('     path-hash id ' + crx.idForPath(dir)); } catch (e) {}
    }
}

const readLdb = (dir) => {
    const out = [];
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) { return out; }
    for (const f of files) {
        if (!/\.(log|ldb|sst)$/.test(f)) continue;
        let buf;
        try { buf = fs.readFileSync(path.join(dir, f)); } catch (e) { continue; }
        const txt = buf.toString('latin1');
        for (const m of txt.matchAll(/([\x20-\x7E]{2,40}?)(\{[\x20-\x7E]{2,4000}?\})/g)) {
            let j;
            try { j = JSON.parse(m[2]); } catch (e) { continue; }
            if (!j || typeof j !== 'object') continue;
            out.push({ file: f, key: m[1].replace(/[^A-Za-z0-9_.:-]/g, '').slice(-24), json: j });
        }
    }
    return out;
};

const newestFile = (dir) => {
    let best = 0, name = '--';
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) { return null; }
    for (const f of files) {
        try {
            const t = fs.statSync(path.join(dir, f)).mtimeMs;
            if (t > best) { best = t; name = f; }
        } catch (e) {}
    }
    return best ? { at: new Date(best).toISOString(), name } : null;
};

const ud = B.chromiumUserData();
for (const [bid, root] of Object.entries(ud)) {
    console.log('');
    console.log('══ ' + bid);
    let profiles = [];
    try {
        profiles = fs.readdirSync(root, { withFileTypes: true })
            .filter(d => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'Preferences')))
            .map(d => d.name);
    } catch (e) {}
    for (const p of profiles) {
        const les = path.join(root, p, 'Local Extension Settings');
        let ids = [];
        try { ids = fs.readdirSync(les).filter(n => /^[a-p]{32}$/.test(n)); } catch (e) {}
        console.log('   ── ' + p + '   ' + ids.length + ' storage dirs');
        for (const id of ids) {
            const nf = newestFile(path.join(les, id));
            console.log('      ' + id + (id === keyId ? '  <- packed' : '') +
                        '   newest write ' + (nf ? nf.at + '  (' + nf.name + ')' : 'none'));
            const recs = readLdb(path.join(les, id));
            const geo = recs.filter(r => r.json && (r.json.active !== undefined || r.json.appOff !== undefined));
            const seen = recs.filter(r => /geoSeen|lastGeo|seen/i.test(r.key));
            for (const g of geo) {
                const j = g.json;
                console.log('         geo ' + (j.stamp ? new Date(j.stamp).toISOString() : '(no stamp)') +
                            '  active=' + j.active + (j.appOff ? ' appOff' : '') + (j.pending ? ' pending' : '') +
                            '  ' + (j.cc || '--') + ' ' + (j.city || '') +
                            (typeof j.lat === 'number' ? '  ' + j.lat + ',' + j.lng : ''));
            }
            for (const s of seen) console.log('         ' + s.key + ' ' + JSON.stringify(s.json).slice(0, 200));
            if (!geo.length && !seen.length && recs.length) {
                console.log('         ' + recs.length + ' other record(s): ' +
                            recs.map(r => r.key).slice(0, 6).join(', '));
            }
        }
    }
}

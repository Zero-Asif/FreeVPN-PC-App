'use strict';
// Read every printable run out of the kept red-run profile's extension storage,
// unfiltered, so "geoOrigins was empty" is a read-back and not a deduction from
// a filter that might have dropped the value.
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
//  There is no default to fall back on, and inventing one would be worse than
//  saying so: the profile this reads lives under the fpext-XXXXXX directory
//  mkdtemp gave that run, which test-ext-install.js prints and which is
//  different every time. Without it the next line threw ERR_INVALID_ARG_TYPE
//  with a stack trace, which reads as a broken probe in a sweep rather than as
//  a missing argument.
if (!root) {
    console.log('ABORT: pass the kept red-run directory, the one holding udd-Brave-w.');
    console.log('       usage: node .build/probe-red-profile.js <...\\Temp\\fpext-XXXXXX>');
    console.log('       .build/test-ext-install.js prints that path when it keeps a profile.');
    process.exit(3);
}
const dir = path.join(root, 'udd-Brave-w', 'Default', 'Local Extension Settings');
for (const sub of fs.readdirSync(dir)) {
    const d = path.join(dir, sub);
    for (const f of fs.readdirSync(d)) {
        const buf = fs.readFileSync(path.join(d, f));
        console.log(`\n== ${sub}/${f}  (${buf.length} bytes) ==`);
        const runs = buf.toString('latin1').match(/[\x20-\x7e]{3,}/g) || [];
        runs.forEach((s, i) => console.log(String(i).padStart(3) + ': ' + s.slice(0, 400)));
    }
}
// And what the page itself planted, for comparison: the cookie jar and Local
// Storage of the throwaway profile.
for (const rel of ['Default/Network/Cookies', 'Default/Local Storage/leveldb']) {
    const p = path.join(root, 'udd-Brave-w', rel);
    if (!fs.existsSync(p)) { console.log(`\n== ${rel}: absent ==`); continue; }
    const files = fs.statSync(p).isDirectory() ? fs.readdirSync(p).map(f => path.join(p, f)) : [p];
    for (const f of files) {
        let buf; try { buf = fs.readFileSync(f); } catch (e) { continue; }
        const hits = (buf.toString('latin1').match(/[\x20-\x7e]{4,}/g) || [])
            .filter(s => /uule|127\.0\.0\.1|lastLoc|geo/i.test(s));
        if (hits.length) {
            console.log(`\n== ${rel}/${path.basename(f)} ==`);
            [...new Set(hits)].slice(0, 25).forEach(s => console.log('   ' + s.slice(0, 200)));
        }
    }
}

'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/audit-eol.js  --  no file may be half CRLF and half LF.
//
//  Run:  node .build/audit-eol.js
//
//  The app's own sources are CRLF and everything added later is LF. That is
//  fine; what is not fine is ONE file holding both, which is what an Edit whose
//  new text contains "\n" does to a CRLF file. It is invisible in a diff
//  viewer, and in installer.nsh it is the difference between a working NSIS
//  script and a broken installer.
//
//  So the rule is per-file consistency, not a house style -- no list to keep in
//  step with reality. The five original CRLF files are additionally pinned,
//  because a whole-file flip is also a change nobody asked for. (There were six.
//  globe.html, the unloaded v1 globe, was deleted rather than left lying around.)
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PINNED_CRLF = ['main.js', 'renderer.js', 'globe-controller.js',
                     'index.html', 'style.css'];

const files = [
    ...PINNED_CRLF, 'package.json', 'installer.nsh',
    ...fs.readdirSync(path.join(ROOT, 'Extension')).filter(f => /\.(js|html|json)$/.test(f))
        .map(f => 'Extension/' + f),
    ...fs.readdirSync(path.join(ROOT, 'lib')).filter(f => f.endsWith('.js')).map(f => 'lib/' + f),
    ...fs.readdirSync(__dirname).filter(f => f.endsWith('.js')).map(f => '.build/' + f),
];

let bad = 0;
const rows = [];
for (const rel of files) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { rows.push([rel, 'MISSING', '', '']); bad++; continue; }
    const s = fs.readFileSync(p, 'utf8');
    const crlf = (s.match(/\r\n/g) || []).length;
    //  Every \n, minus the ones that belong to a \r\n. Counted this way rather
    //  than by a look-behind regex, which undercounts consecutive blank lines.
    const lf = (s.split('\n').length - 1) - crlf;
    const mixed = crlf > 0 && lf > 0;
    const flipped = PINNED_CRLF.includes(rel) && crlf === 0;
    if (mixed || flipped) bad++;
    rows.push([rel, mixed ? 'MIXED' : flipped ? 'FLIPPED TO LF' : (crlf ? 'CRLF' : 'LF'),
               'crlf=' + crlf, 'bareLF=' + lf]);
}
const w = Math.max(...rows.map(r => r[0].length));
for (const r of rows)
    console.log(`  ${r[1] === 'CRLF' || r[1] === 'LF' ? 'ok  ' : 'FAIL'} ` +
                `${r[0].padEnd(w)}  ${r[1].padEnd(13)} ${r[2].padEnd(10)} ${r[3]}`);
console.log('');
console.log(bad ? `${bad} file(s) have inconsistent or flipped line endings`
                : `${rows.length} files: every one internally consistent, all five originals still CRLF`);
process.exit(bad ? 1 : 0);

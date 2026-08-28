'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/check-callsites.js  --  every geoEngine().x / geoExt().x in main.js
//  must actually exist on the object the factory returns.
//
//  This exists because mid-refactor breakage of exactly this shape has already
//  happened twice: the blocking layer was deleted from lib/geo-spoof.js while
//  main.js and applyAll() still called applyPolicy(), restorePolicy() and
//  _planProfiles(). Nothing catches that until the code path runs, and these
//  paths run on connect and on quit -- i.e. in front of the user, elevated,
//  with the machine's proxy settings half-applied.
//
//  Static and side-effect free: it constructs both objects against a temp state
//  directory and only looks at their surface. Nothing is written, no registry
//  is touched, no browser is closed.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');

const { GeoSpoof } = require('../lib/geo-spoof');
const { GeoExt } = require('../lib/geo-ext');

const ROOT = path.join(__dirname, '..');
const log = { debug() {}, info() {}, warn() {}, error() {}, success() {} };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fpsmoke-'));

const targets = [
    ['geoEngine()', new GeoSpoof({ log, stateDir: tmp })],
    ['geoExt()', new GeoExt({ log, stateDir: tmp, sourceDir: path.join(ROOT, 'Extension') })],
];

//  Comments stripped first: a method named only in a doc comment -- and the
//  comments here name the deleted ones on purpose, to explain why they went --
//  is not a call site.
const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * Every receiver expression that resolves to `factory`. The factory call
 * itself, plus any local alias bound to it -- `const ext = geoExt()` is how the
 * connect path actually uses these, so an alias-blind scan would skip exactly
 * the code that runs on connect.
 *
 * The factory call must be the WHOLE initialiser: `const s = geoEngine()` is an
 * alias, `const s = geoEngine().status()` binds the status object instead, and
 * treating that as an alias made this checker report five methods missing that
 * were never asked of the engine. Aliases are matched by name only, so a
 * same-named variable in an unrelated scope would still be attributed here --
 * that direction produces a loud false positive, not a silent gap.
 */
function receivers(factory) {
    const out = [factory];
    const re = new RegExp('\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*' +
                          factory.replace(/[()]/g, '\\$&') + '\\s*(?!\\.)', 'g');
    let m;
    while ((m = re.exec(src))) if (!out.includes(m[1])) out.push(m[1]);
    return out;
}

let bad = 0, n = 0;
for (const [factory, obj] of targets) {
    const recv = receivers(factory);
    console.log(`── ${factory}  via ${recv.map(r => r + '.').join(' ')} ──`);
    const names = new Set();
    for (const r of recv) {
        const re = new RegExp('(?:^|[^\\w$.])' + r.replace(/[()]/g, '\\$&') +
                              '\\.([A-Za-z_$][\\w$]*)', 'g');
        let m;
        while ((m = re.exec(src))) names.add(m[1]);
    }
    if (!names.size) {
        console.log(`  FAIL     no ${factory} call sites found -- this checker has stopped checking`);
        bad++;
        continue;
    }
    for (const name of [...names].sort()) {
        n++;
        const kind = typeof obj[name];
        if (kind === 'function' || name in obj) console.log(`  ok       ${name}  (${kind})`);
        else { bad++; console.log(`  MISSING  ${factory}.${name}`); }
    }
}

console.log('');
console.log('  geoEngine().status()   -> ' + JSON.stringify(targets[0][1].status()));
console.log('  geoExt().presence()    -> ' + JSON.stringify(targets[1][1].presence()));
console.log('  geoExt().needManualLoad() -> ' + JSON.stringify(targets[1][1].needManualLoad()));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log('');
console.log(bad ? `${bad} problem(s) across ${n} call sites` : `all ${n} main.js call sites resolve`);
process.exit(bad ? 1 : 0);

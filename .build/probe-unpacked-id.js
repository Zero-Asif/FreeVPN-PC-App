'use strict';
// ════════════════════════════════════════════════════════════════════
//  probe-unpacked-id.js -- WHICH directory is Chromium's second row?
//
//  A duplicate extension row means two DIFFERENT ids, because Chromium
//  keys the list by id. One of them is this app's packed CRX, whose id
//  comes from the injected `key`. The other, if it is an unpacked load,
//  has no key -- so Chromium derives its id from the absolute PATH:
//
//      id_util.cc: GenerateId(path.value())
//      = sha256(raw bytes of the wstring)  -- UTF-16LE on Windows
//      first 16 bytes, each nibble mapped 0..15 -> 'a'..'p'
//
//  That is arithmetic, not a guess. Feeding it every directory this app
//  could plausibly have exposed says which one a reported id belongs to,
//  or says none of them do -- which would mean the row is not ours.
//
//  Read-only: hashes strings. Touches no browser and no registry.
// ════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

//  The packed id, for comparison, is sha256 of the SPKI DER -- a different
//  input entirely, which is why the two ids cannot coincide.
function idFromPath(p) {
    const h = crypto.createHash('sha256').update(Buffer.from(p, 'utf16le')).digest();
    let id = '';
    for (let i = 0; i < 16; i++) {
        id += String.fromCharCode(97 + (h[i] >> 4));
        id += String.fromCharCode(97 + (h[i] & 15));
    }
    return id;
}

function idFromSpki(derB64) {
    const h = crypto.createHash('sha256').update(Buffer.from(derB64, 'base64')).digest();
    let id = '';
    for (let i = 0; i < 16; i++) {
        id += String.fromCharCode(97 + (h[i] >> 4));
        id += String.fromCharCode(97 + (h[i] & 15));
    }
    return id;
}

const REPO = path.join(__dirname, '..');
const PD = process.env.ProgramData || 'C:\\ProgramData';
//  The state dir's real name, read out of the source rather than guessed --
//  the first version of this probe guessed three wrong spellings and reported
//  "no staged manifest on this machine" for a machine that had one.
const STATE = path.join(PD, 'freeproxy-vpn');
const STAGED = path.join(STATE, 'browser-setup', 'extension');

const candidates = [
    ['repo Extension/ (dev run, __dirname)', path.join(REPO, 'Extension')],
    ['repo Extension-Store/package/', path.join(REPO, 'Extension-Store', 'package')],
    ['installed resources\\Extension (extraResource)',
     'C:\\Program Files\\FreeProxy VPN\\resources\\Extension'],
    ['installed resources\\Extension (x86 dir)',
     'C:\\Program Files (x86)\\FreeProxy VPN\\resources\\Extension'],
    ['ProgramData staged copy -- the one HOW-TO-ENABLE.txt names', STAGED],
];

//  Whatever the app actually staged, if it is on this machine, beats every
//  guess above -- read it rather than assume the layout.
try {
    for (const n of fs.readdirSync(PD)) {
        if (!/freeproxy/i.test(n)) continue;
        const base = path.join(PD, n);
        const walk = (d, depth) => {
            if (depth > 3) return;
            let ents = [];
            try { ents = fs.readdirSync(d); } catch (e) { return; }
            if (ents.includes('manifest.json') && d !== STAGED &&
                !candidates.some(([, p]) => p === d))
                candidates.push(['FOUND on disk: ' + d, d]);
            for (const s of ents) {
                const p = path.join(d, s);
                try { if (fs.statSync(p).isDirectory()) walk(p, depth + 1); } catch (e) {}
            }
        };
        walk(base, 0);
    }
} catch (e) {}

//  And the id every browser on this machine is actually holding -- the only
//  number that can say whether a duplicate is present RIGHT NOW, as opposed to
//  which directory a duplicate would have come from.
const LIVE = [
    ['Chrome', process.env.LOCALAPPDATA + '\\Google\\Chrome\\User Data'],
    ['Brave',  process.env.LOCALAPPDATA + '\\BraveSoftware\\Brave-Browser\\User Data'],
    ['Edge',   process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\User Data'],
];

console.log('\n── path-derived ids (what an UNPACKED load of each would be) ──');
const want = process.argv.slice(2).filter(a => /^[a-p]{32}$/.test(a));
for (const [label, p] of candidates) {
    const id = idFromPath(p);
    const hit = want.includes(id) ? '   <== MATCHES the id given' : '';
    console.log(`  ${id}  ${label}${hit}`);
    console.log(`  ${' '.repeat(32)}  ${p}`);
}

//  And the packed id the app really installs, read out of the staged manifest
//  so it is the shipped number rather than a recomputation of the theory.
console.log('\n── the packed id this app installs (from the injected key) ──');
let found = false;
for (const [label, p] of candidates) {
    const mf = path.join(p, 'manifest.json');
    let j;
    try { j = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) { continue; }
    if (!j.key) {
        console.log(`  (no key)  ${label} -- source copy, keyless by design`);
        continue;
    }
    found = true;
    console.log(`  ${idFromSpki(j.key)}  ${label}  v${j.version}`);
}
if (!found) console.log('  no staged manifest with a key on this machine yet');

if (want.length) {
    console.log('\n── verdict on the ids given ──');
    for (const w of want) {
        const m = candidates.find(([, p]) => idFromPath(p) === w);
        console.log(`  ${w}: ` + (m ? 'an unpacked load of ' + m[1] : 'NOT any directory listed above'));
    }
}

//  A derived id is a PREDICTION. A row in a profile is an OBSERVATION. Only the
//  second can say a duplicate exists, and the two were conflated once already.
console.log('\n── what each browser is holding right now (observation) ──');
for (const [name, root] of LIVE) {
    let profs = [];
    try { profs = fs.readdirSync(root).filter(d => d === 'Default' || /^Profile /.test(d)); }
    catch (e) { console.log(`  ${name}: not installed`); continue; }
    let any = false;
    for (const p of profs) for (const f of ['Preferences', 'Secure Preferences']) {
        let j;
        try { j = JSON.parse(fs.readFileSync(path.join(root, p, f), 'utf8')); }
        catch (e) { continue; }
        for (const [id, v] of Object.entries((j.extensions && j.extensions.settings) || {})) {
            const nm = (v.manifest && v.manifest.name) || '';
            if (!/freeproxy/i.test(nm)) continue;
            any = true;
            const keyed = v.manifest && v.manifest.key;
            //  location 4 is UNPACKED; a keyless one of ours would be that and
            //  nothing else, because no other route can install without a key.
            console.log(`  ${name}/${p}: ${id}  v${(v.manifest || {}).version}  ` +
                        `location=${v.location}${v.location === 4 ? ' (UNPACKED)' : ''}  ` +
                        `${keyed ? 'keyed' : 'KEYLESS -- path-derived id'}`);
        }
    }
    if (!any) console.log(`  ${name}: no FreeProxy row in any profile`);
}
console.log('');

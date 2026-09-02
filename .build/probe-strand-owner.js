'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-strand-owner.js  --  WHICH id holds the stuck proxy, and is that
//  id an extension Brave has actually loaded?
//
//  This exists because two measurements in this repo disagree. probe-fossil-id.js
//  was read as saying the stuck pref belongs to the live id
//  bmdkiblidpidilbeebghppkifmdhheog; probe-brave-proxy-who.js, run today, prints
//  the fixed_servers record under egclniilmgnaildaaiccpmakehnhledg instead, with
//  no manifest and no state, pointing at the same unpacked folder.
//
//  The difference decides whether the repair in Extension/background.js can work
//  at all. An extension-controlled pref is applied by Chromium from the extension
//  that owns it, so:
//
//    * live id      -> our worker owns it, and releasing it at the last window
//                      close is a fix
//    * dead id      -> no worker exists for it, ever. Nothing in our extension can
//                      release another extension's pref, so if Chromium is still
//                      APPLYING it, background.js cannot be the fix and saying so
//                      would be a fake implementation
//
//  So both ids are dumped whole, out of both pref files, next to what is actually
//  on disk in Brave's Extensions directory and in the external-prefs file that
//  names the folder. Reads only; nothing is written anywhere.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const LOCAL = process.env.LOCALAPPDATA || '';
const BRAVE = path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data');
const LIVE = 'bmdkiblidpidilbeebghppkifmdhheog';
const FOSSIL = 'egclniilmgnaildaaiccpmakehnhledg';

const STATE = { 0: 'DISABLED', 1: 'enabled', 2: 'external-uninstalled' };
const LOC = { 1: 'internal(store)', 2: 'external-pref', 3: 'external-registry',
              4: 'unpacked(load-unpacked)', 5: 'component', 6: 'external-pref-download',
              7: 'external-policy-download', 8: 'command-line', 9: 'external-policy',
              10: 'external-component' };

const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const has = p => { try { fs.accessSync(p); return true; } catch (e) { return false; } };

//  The whole record, with only the two fields that are pages long trimmed, so
//  nothing about it is paraphrased.
function dump(rec) {
    const copy = { ...rec };
    if (copy.manifest) copy.manifest = { name: copy.manifest.name, version: copy.manifest.version,
                                         manifest_version: copy.manifest.manifest_version,
                                         key: copy.manifest.key ? '(' + String(copy.manifest.key).length + ' chars)' : undefined };
    if (copy.content_settings) copy.content_settings = '(' + JSON.stringify(copy.content_settings).length + ' chars)';
    return JSON.stringify(copy, null, 2).split('\n').join('\n    ');
}

const profiles = (() => {
    try {
        return fs.readdirSync(BRAVE, { withFileTypes: true })
            .filter(d => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
            .map(d => path.join(BRAVE, d.name));
    } catch (e) { return []; }
})();

if (!profiles.length) { console.log('ABORT: no Brave profile found under ' + BRAVE); process.exit(3); }

for (const dir of profiles) {
    console.log(`\n══════════ Brave / ${path.basename(dir)} ══════════`);

    for (const file of ['Preferences', 'Secure Preferences']) {
        const j = readJson(path.join(dir, file));
        const es = (j && j.extensions && j.extensions.settings) || null;
        if (!es) { console.log(`\n── ${file}: no extensions.settings ──`); continue; }
        console.log(`\n── ${file}: ${Object.keys(es).length} extension records ──`);

        for (const [label, id] of [['LIVE  ', LIVE], ['FOSSIL', FOSSIL]]) {
            const e = es[id];
            if (!e) { console.log(`  ${label} ${id}: no record in this file`); continue; }
            const scopes = ['preferences', 'regular_only_preferences',
                            'incognito_persistent_preferences', 'incognito_session_only_preferences'];
            const proxied = scopes.filter(s => e[s] && e[s].proxy !== undefined);
            console.log(`  ${label} ${id}`);
            console.log(`    state=${STATE[e.state] !== undefined ? STATE[e.state] : e.state}` +
                        `  location=${LOC[e.location] || e.location}` +
                        `  manifest=${e.manifest ? 'recorded' : 'NOT recorded'}` +
                        `  proxy pref in: ${proxied.join(',') || '(none)'}`);
            console.log('    ' + dump(e));
        }
    }
}

// ── what is actually on disk, which is the tie-breaker ───────────────
//  An unpacked extension has no copy under Extensions/<id>; Chromium loads it
//  from `path` every start. So "is it loaded" is answered by the external-prefs
//  file that names the folder plus the folder's own manifest, not by a directory
//  under Extensions.
console.log('\n══════════ what names the folder, and what the folder holds ══════════');
const FOLDER = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData',
                         'freeproxy-vpn', 'browser-setup', 'extension');
const mf = readJson(path.join(FOLDER, 'manifest.json'));
console.log(`  folder   ${FOLDER}  ${has(FOLDER) ? 'exists' : 'MISSING'}`);
console.log(`  manifest version ${mf ? mf.version : '(unreadable)'}` +
            `  key ${mf && mf.key ? mf.key.length + ' chars' : 'ABSENT'}`);
//  The id is the first 32 bytes of SHA256(key-der) mapped a-p. With no `key` in
//  the manifest, Chromium derives the id from the PATH instead -- which is why an
//  id can change under a folder that never moved, and why a fossil record exists
//  at all.
const crypto = require('crypto');
if (mf && mf.key) {
    const der = Buffer.from(mf.key, 'base64');
    const h = crypto.createHash('sha256').update(der).digest();
    const id = [...h.subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4)) +
                                               String.fromCharCode(97 + (b & 15))).join('');
    console.log(`  id derived from that key: ${id}  ${id === LIVE ? '== LIVE' : id === FOSSIL ? '== FOSSIL' : '(neither!)'}`);
}

for (const dir of profiles) {
    const extDir = path.join(dir, 'Extensions');
    for (const id of [LIVE, FOSSIL]) {
        const p = path.join(extDir, id);
        console.log(`  ${path.basename(dir)}/Extensions/${id.slice(0, 8)}...  ` +
                    (has(p) ? 'PRESENT: ' + fs.readdirSync(p).join(' ') : 'absent (as an unpacked load should be)'));
    }
}

//  Brave reads external extensions from this file at every start. Whichever id it
//  names is the one that gets loaded; the other cannot have a worker.
const EXTPREF = path.join(BRAVE, '..', 'Application', 'extensions');
for (const cand of [path.join(BRAVE, 'External Extensions', 'external_extensions.json'),
                    path.join(EXTPREF, 'external_extensions.json')]) {
    if (!has(cand)) { console.log(`  external prefs ${cand}: absent`); continue; }
    console.log(`  external prefs ${cand}:`);
    console.log('    ' + JSON.stringify(readJson(cand), null, 2).split('\n').join('\n    '));
}

console.log('\nNothing was modified.');

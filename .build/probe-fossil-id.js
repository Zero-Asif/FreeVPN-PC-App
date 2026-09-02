'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-fossil-id.js  --  who is egclniilmgnaildaaiccpmakehnhledg,
//  and is Brave still applying its proxy? READ ONLY.
//
//  The measured fact: with the app down, Tor down and nothing on 9050, only
//  BRAVE holds an extension-set `fixed_servers` proxy pointing at
//  socks5://127.0.0.1:9050 -- and it is filed under a DIFFERENT extension id
//  than the one we ship. Extension-controlled prefs are per-extension, so no
//  code in the live extension can release it. That is why the watchdog changed
//  nothing for Brave.
//
//  Two things still have to be read rather than reasoned about:
//
//    1. the record's `state`. An enabled record is one Chromium tries to load,
//       and a loaded extension gets its stored prefs registered. A disabled or
//       externally-uninstalled one does not, and then the theory is wrong and
//       the real holder is still unfound.
//
//    2. where the id came from. An unpacked extension with no `key` in its
//       manifest gets an id derived from its FOLDER PATH -- and Chromium hashes
//       the path as base::FilePath, i.e. UTF-16LE on Windows. Hashing the UTF-8
//       bytes instead gives a different answer, which is why the first attempt
//       at this did not match. If the UTF-16LE hash of the staged folder equals
//       the fossil, the origin is proven: that folder was once loaded unpacked
//       while its manifest had no key, and adding the key moved the id, leaving
//       the old record behind with the proxy still in it.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOCAL = process.env.LOCALAPPDATA || '';
const PD = path.join(process.env.ProgramData || 'C:\\ProgramData', 'freeproxy-vpn');
const STAGED = path.join(PD, 'browser-setup', 'extension');
const FOSSIL = 'egclniilmgnaildaaiccpmakehnhledg';
const LIVE = 'bmdkiblidpidilbeebghppkifmdhheog';

const j = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };

//  sha256(input)[0..16) rendered as hex with the digits shifted into a-p.
const mpdecode = buf => [...crypto.createHash('sha256').update(buf).digest().subarray(0, 16)]
    .map(b => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('');

console.log('══════════ 1. the id, derived every way it could have been ══════════');
const forms = [
    ['UTF-16LE, as base::FilePath on Windows', Buffer.from(STAGED, 'utf16le')],
    ['UTF-8 bytes', Buffer.from(STAGED, 'utf8')],
    ['UTF-16LE, uppercased drive+path', Buffer.from(STAGED.toUpperCase(), 'utf16le')],
    ['UTF-16LE, forward slashes', Buffer.from(STAGED.replace(/\\/g, '/'), 'utf16le')],
];
for (const [name, buf] of forms) {
    const id = mpdecode(buf);
    console.log(`  ${id}   ${id === FOSSIL ? '<<< THE FOSSIL' : id === LIVE ? '<<< the live id' : ''}   ${name}`);
}
console.log(`  path hashed: ${STAGED}`);

console.log('\n══════════ 2. what the staged manifest yields today ══════════');
const mf = j(path.join(STAGED, 'manifest.json'));
if (!mf) console.log('  manifest UNREADABLE');
else {
    console.log('  version   ' + mf.version);
    console.log('  key       ' + (mf.key ? mf.key.length + ' chars' : '(none -- id would come from the path)'));
    if (mf.key) {
        const id = mpdecode(Buffer.from(mf.key, 'base64'));
        console.log('  key id    ' + id + (id === LIVE ? '   <<< matches the installed record' : '   <<< UNEXPECTED'));
    }
}

console.log('\n══════════ 3. the full Brave record for both ids ══════════');
const STATE = { 0: 'DISABLED', 1: 'ENABLED', 2: 'EXTERNAL_EXTENSION_UNINSTALLED' };
const LOC = { 1: 'internal(store)', 2: 'external-pref', 3: 'external-registry', 4: 'UNPACKED',
              5: 'component', 6: 'external-pref-download', 7: 'external-policy-download',
              8: 'command-line', 9: 'external-policy', 10: 'external-component' };
const PREF_BUCKETS = ['preferences', 'regular_only_preferences',
                      'incognito_persistent_preferences', 'incognito_session_only_preferences'];

for (const [browser, root] of [
    ['Brave',  path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data')],
    ['Chrome', path.join(LOCAL, 'Google', 'Chrome', 'User Data')],
    ['Edge',   path.join(LOCAL, 'Microsoft', 'Edge', 'User Data')],
]) {
    let dirs = [];
    try {
        dirs = fs.readdirSync(root, { withFileTypes: true })
            .filter(d => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
            .map(d => path.join(root, d.name));
    } catch (e) { console.log(`\n── ${browser}: no User Data`); continue; }

    for (const dir of dirs) {
        for (const file of ['Preferences', 'Secure Preferences']) {
            const p = j(path.join(dir, file));
            const es = p && p.extensions && p.extensions.settings;
            if (!es) continue;
            for (const id of [FOSSIL, LIVE]) {
                const e = es[id];
                if (!e) continue;
                console.log(`\n── ${browser} / ${path.basename(dir)} / ${file} / ` +
                            (id === FOSSIL ? 'FOSSIL' : 'live') + ' ' + id);
                console.log('  state            ' + (STATE[e.state] !== undefined
                    ? `${e.state} = ${STATE[e.state]}` : `${e.state} (unknown)`));
                console.log('  location         ' + (LOC[e.location] || e.location));
                console.log('  disable_reasons  ' + JSON.stringify(e.disable_reasons));
                console.log('  path             ' + (e.path || '(none)'));
                console.log('  manifest cached  ' + (e.manifest ? 'yes: ' + e.manifest.name : 'NO'));
                console.log('  was_installed_by_default/oem  ' +
                            JSON.stringify([e.was_installed_by_default, e.was_installed_by_oem]));
                console.log('  install_time     ' + (e.install_time || '(none)') +
                            '   first_install_time ' + (e.first_install_time || '(none)'));
                console.log('  active_permissions.api  ' +
                            JSON.stringify((e.active_permissions || {}).api || []));
                for (const b of PREF_BUCKETS) {
                    if (e[b] === undefined) continue;
                    const keys = Object.keys(e[b] || {});
                    console.log(`  ${b}  keys=${JSON.stringify(keys)}`);
                    if (e[b] && e[b].proxy !== undefined)
                        console.log(`      proxy = ${JSON.stringify(e[b].proxy)}`);
                }
                //  Every other key, so nothing about this record is invisible here.
                console.log('  all keys         ' + JSON.stringify(Object.keys(e)));
            }
        }
        //  Chromium's own record of which extension controls which pref.
        for (const file of ['Preferences', 'Secure Preferences']) {
            const p = j(path.join(dir, file));
            if (p && p.proxy !== undefined)
                console.log(`\n  !! ${browser}/${path.basename(dir)}/${file}: top-level proxy = ` +
                            JSON.stringify(p.proxy));
        }
    }
}

console.log('\n══════════ 4. is that folder still loadable as unpacked? ══════════');
try {
    const st = fs.statSync(STAGED);
    console.log('  folder exists, mtime ' + st.mtime.toISOString());
    console.log('  entries: ' + fs.readdirSync(STAGED).join(', '));
} catch (e) { console.log('  folder MISSING: ' + e.message); }

console.log('\nNothing was modified.');

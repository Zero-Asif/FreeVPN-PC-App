'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-brave-proxy-stuck.js  --  who is holding Brave on a dead proxy?
//
//  THE REPORT. "app e jokhon kono country te connected thakchena tokhon brave
//  kono net pacchena but jekono country te connect korar sathe sathe pacche."
//  Brave shows ERR_PROXY_CONNECTION_FAILED while the app is down, and starts
//  working the instant it connects.
//
//  Measured on this machine at the time of the report: ProxyEnable=0 (system
//  proxy off), no ProxySettings policy in any Chromium hive, no listener on
//  9050, the app not running. That leaves exactly one layer that could still be
//  pointing the browser at 127.0.0.1:9050 -- the extension's own
//  chrome.proxy.settings.set({scope:'regular'}), which Chromium PERSISTS in the
//  profile and only the extension can clear.
//
//  This reads it back out of the profile instead of asserting it. Reads only:
//  no browser is started, no file is written, nothing is cleared.
//
//    node .build/probe-brave-proxy-stuck.js
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const LOCAL = process.env.LOCALAPPDATA || '';
const ROAM  = process.env.APPDATA || '';

//  Every Chromium fork this app touches, so "only Brave" can be shown to be
//  only Brave rather than assumed from one profile.
const ROOTS = [
    ['Brave',    path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data')],
    ['Chrome',   path.join(LOCAL, 'Google', 'Chrome', 'User Data')],
    ['Edge',     path.join(LOCAL, 'Microsoft', 'Edge', 'User Data')],
    ['Vivaldi',  path.join(LOCAL, 'Vivaldi', 'User Data')],
    ['Opera',    path.join(ROAM,  'Opera Software', 'Opera Stable')],
];

const EXT_ID = 'lllpgagacaonelkgghpnmceapgollkii';   // the bundled geo spoofer

function profilesIn(root) {
    let names;
    try { names = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return []; }
    return names
        .filter(d => d.isDirectory() &&
                     (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
        .map(d => path.join(root, d.name));
}

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

//  The effective proxy pref and, separately, the per-extension copy. Both
//  matter: the first is what the network stack obeys, the second is the record
//  that says WHICH extension put it there and survives a browser restart.
function describe(pref) {
    if (!pref) return 'absent';
    if (typeof pref === 'string') return JSON.stringify(pref);
    const mode = pref.mode || (pref.value && pref.value.mode) || '?';
    const rules = pref.rules || (pref.value && pref.value.rules) || null;
    let where = '';
    if (rules) {
        const s = rules.singleProxy;
        if (s) where = ` -> ${s.scheme || '?'}://${s.host || '?'}:${s.port === undefined ? '?' : s.port}`;
        else where = ' -> ' + JSON.stringify(rules).slice(0, 90);
    }
    if (pref.pacScript) where = ' -> pac ' + JSON.stringify(pref.pacScript).slice(0, 80);
    return `mode=${mode}${where}`;
}

let found = 0, checked = 0;

for (const [name, root] of ROOTS) {
    const profs = profilesIn(root);
    if (!profs.length) { console.log(`\n══ ${name} ══\n  no profile directory at ${root}`); continue; }
    console.log(`\n══ ${name} ══`);

    for (const dir of profs) {
        checked++;
        const label = path.basename(dir);
        const prefs  = readJson(path.join(dir, 'Preferences'));
        const secure = readJson(path.join(dir, 'Secure Preferences'));
        if (!prefs && !secure) { console.log(`  ${label}: unreadable (browser may hold it open)`); continue; }

        //  1. the effective pref the network service reads
        const eff = prefs && prefs.proxy;

        //  2. the extension-controlled copy, per scope. This is the one that
        //     persists across a browser restart with the app never running.
        const es = (secure && secure.extensions && secure.extensions.settings) ||
                   (prefs  && prefs.extensions  && prefs.extensions.settings)  || {};
        const rows = [];
        for (const id of Object.keys(es)) {
            const e = es[id] || {};
            for (const scope of ['preferences', 'regular_only_preferences',
                                 'incognito_persistent_preferences', 'incognito_session_only_preferences']) {
                const p = e[scope] && e[scope].proxy;
                if (p !== undefined) rows.push({ id, scope, val: p });
            }
        }

        const stuck = eff && String(describe(eff)).includes('fixed_servers');
        console.log(`  ${label}`);
        console.log(`    proxy pref (effective) : ${describe(eff)}${stuck ? '   <-- POINTS AT A PROXY' : ''}`);
        if (!rows.length) console.log('    extension-set proxy    : none recorded');
        rows.forEach(r => {
            const mine = r.id === EXT_ID ? '  (OUR extension)' : '';
            console.log(`    extension-set proxy    : ${r.id}${mine}`);
            console.log(`                             scope=${r.scope}  ${describe(r.val)}`);
        });
        if (stuck || rows.length) found++;
    }
}

console.log(`\n${checked} profile(s) read, ${found} with a proxy pref present.`);
console.log('Nothing was modified.');

// Read-only: what does every browser profile on this machine say about our
// extension RIGHT NOW?  Two refuters disagreed about whether Chrome carries
// disable_reasons [256] (NOT_VERIFIED), so read it out of the profile instead
// of trusting either.
'use strict';
const fs = require('fs');
const path = require('path');
const B = require('../lib/browsers.js');

const LIVE = 'chgddbpnlfjjdlekafkddegnjklecdlk';
const FOSSIL = 'egclniilmgnaildaaiccpmakehnhledg';

function reasons(bits) {
    if (!Array.isArray(bits)) bits = [bits];
    const out = [];
    for (const b of bits) {
        for (const k of Object.keys(B.DISABLE_REASON)) {
            if ((+b) & (+k)) out.push(k + '=' + B.DISABLE_REASON[k]);
        }
        if (+b && !out.length) out.push(b + '=UNNAMED');
    }
    return out.length ? out.join(',') : '(none)';
}

function look(file, label) {
    if (!fs.existsSync(file)) return;
    let j;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log('   ' + label + ' UNPARSED ' + e.message); return; }
    const settings = (j.extensions && j.extensions.settings) || {};
    for (const id of [LIVE, FOSSIL]) {
        if (!(id in settings)) continue;
        const r = settings[id] || {};
        const keys = Object.keys(r);
        console.log('   ' + label);
        console.log('      id            : ' + id + (id === FOSSIL ? '  (fossil)' : '  (live)'));
        console.log('      keys          : ' + (keys.length ? keys.join(',') : '(EMPTY RECORD)'));
        console.log('      state         : ' + JSON.stringify(r.state));
        console.log('      location      : ' + JSON.stringify(r.location) + ' ' + (B.EXT_LOCATION ? (B.EXT_LOCATION[r.location] || '') : ''));
        console.log('      disable_reasons: ' + JSON.stringify(r.disable_reasons) + '  -> ' + reasons(r.disable_reasons === undefined ? [] : r.disable_reasons));
        console.log('      ack_external  : ' + JSON.stringify(r.ack_external));
        console.log('      ack_safety_check_warning_reason: ' + JSON.stringify(r.ack_safety_check_warning_reason));
        console.log('      blacklist_state: ' + JSON.stringify(r.blacklist_state));
        console.log('      has_started_service_worker: ' + JSON.stringify(r.has_started_service_worker));
        console.log('      path          : ' + JSON.stringify(r.path));
        console.log('      was_installed_by_default/oem: ' + JSON.stringify(r.was_installed_by_default) + '/' + JSON.stringify(r.was_installed_by_oem));
    }
}

console.log('DISABLE_REASON table currently in lib/browsers.js:');
console.log('   ' + Object.keys(B.DISABLE_REASON).map(k => k + '=' + B.DISABLE_REASON[k]).join('  '));
console.log('');

for (const b of B.detect()) {
    if (b.family !== 'chromium') { console.log('== ' + b.name + '  (gecko, no extension)'); continue; }
    console.log('== ' + b.name + '   dataDir=' + b.dataDir);
    if (!b.dataDir) { console.log('   no user data dir'); continue; }
    let profiles = [];
    try {
        profiles = fs.readdirSync(b.dataDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name)
            .filter(n => n === 'Default' || /^Profile \d+$/.test(n));
    } catch (e) { console.log('   readdir failed: ' + e.message); continue; }
    if (!profiles.length) console.log('   no profiles found');
    for (const p of profiles) {
        look(path.join(b.dataDir, p, 'Secure Preferences'), p + '/Secure Preferences');
        look(path.join(b.dataDir, p, 'Preferences'), p + '/Preferences');
    }
}

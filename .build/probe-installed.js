'use strict';
//  scratch, read-only: the exact state of our extension id in every Chromium
//  profile on this machine, and whether the browser disabled it.
//
//  The tables and the browser list are IMPORTED from lib/browsers.js rather
//  than copied. The copy that used to live here had every bit above 128 shifted
//  by one position -- it printed 8192 as CUSTODIAN_APPROVAL_REQUIRED, which is
//  a parental-controls reason, when the measured value means EXTERNAL_EXTENSION
//  ("an installer offered this, the user has not accepted it yet"). Two
//  completely different conclusions from the same profile, and the wrong one
//  says "nothing we can do" about a state that is one click from working.
//
//  usage: node .build/probe-installed.js [extension-id]
const fs = require('fs');
const path = require('path');

const browsers = require('../lib/browsers');

const ID = process.argv[2] || 'edfdpeehkfpjhhgpkaoiahndelmcimfn';
const R = browsers.DISABLE_REASON;

const j = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const bits = n => Object.keys(R).filter(k => (n & +k)).map(k => `${k}=${R[k]}`).join(' | ') ||
                  String(n);
const PROFILE_DIR = /^(Default|Profile \d+)$/;

console.log('looking for ' + ID + '\n');

//  Every Chromium fork the table knows and this machine has, not a hard-coded
//  three: a profile the probe never opens is a profile whose answer we invent.
const roots = browsers.chromiumUserData();
for (const b of browsers.CHROMIUM) {
    const root = roots[b.id];
    if (!root) { console.log(`${b.name}: not installed`); continue; }

    for (const pr of fs.readdirSync(root).filter(d => PROFILE_DIR.test(d))) {
        //  Both stores. An externally-offered extension is recorded in Secure
        //  Preferences; only a hand-loaded one may sit in plain Preferences, and
        //  reading just the secure file reports "Load unpacked" as absent.
        let v = null, where = null;
        for (const f of ['Secure Preferences', 'Preferences']) {
            const s = ((j(path.join(root, pr, f)) || {}).extensions || {}).settings || {};
            if (s[ID]) { v = s[ID]; where = f; break; }
        }
        const dir = path.join(root, pr, 'Extensions', ID);
        const onDisk = fs.existsSync(dir) ? fs.readdirSync(dir).join(',') : 'NO FOLDER';
        console.log(`── ${b.id} / ${pr}`);
        console.log('   folder on disk : ' + onDisk);
        if (!v) { console.log('   prefs entry    : NONE\n'); continue; }
        const dr = Array.isArray(v.disable_reasons) ? v.disable_reasons
                 : (typeof v.disable_reasons === 'number' ? [v.disable_reasons] : []);
        const loc = Number(v.location);
        console.log('   recorded in    : ' + where);
        console.log('   location       : ' + v.location +
                    ' (' + (browsers.EXT_LOCATION[loc] || '?') + ')   state: ' + v.state);
        console.log('   disable_reasons: ' + (dr.length ? dr.map(bits).join(' + ') : 'none'));
        console.log('   ack_external   : ' + JSON.stringify(v.ack_external));
        console.log('   from_webstore  : ' + JSON.stringify(v.from_webstore) +
                    '   install_time: ' + (v.first_install_time || v.install_time || '?'));
        console.log('   worker started : ' + JSON.stringify(v.has_started_service_worker));
        console.log('   granted        : ' + JSON.stringify((v.granted_permissions || {}).api));
        console.log('');
    }

    //  And the verdict the app itself would print for this browser, from the one
    //  reader every claim goes through -- so the probe and the product can never
    //  disagree about the same profile.
    const st = browsers.extensionState(root, ID);
    console.log(`   => ${b.name}: present=${st.present} enabled=${st.enabled}` +
                ` removedByUser=${st.removedByUser} profile=${st.profile || '-'}` +
                ` location=${st.locationName || '-'}` +
                (st.disabled.length ? ` disabled_by=${st.disabled.join(',')}` : '') +
                //  The record is there and empty: this browser HAD it and threw
                //  the install away. Printed, because an unexplained absence is
                //  what sent the last investigation looking at the wrong routes.
                (st.husk ? '  [husk: the record is an empty {} -- the install was ' +
                           'dropped, most likely at a start with the port dead]' : '') + '\n');
}

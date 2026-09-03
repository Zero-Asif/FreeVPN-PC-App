'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-ext-state.js  --  "present" and "enabled" are two different
//  facts, and this locks the difference down against the REAL prefs shapes.
//
//  Every fixture below was measured on this machine (see .build/probe-startup.js
//  and .build/probe-forcelist.js), with the delivery helper serving the CRX the
//  browser policies name and each browser started fresh:
//
//      Edge    location 7 (EXTERNAL_POLICY_DOWNLOAD), no disable_reasons,
//              ack_external:true, service worker started      -> RUNNING
//      Chrome  location 6 (EXTERNAL_PREF_DOWNLOAD), disable_reasons [8192]
//      Brave   location 6, disable_reasons [8192]             -> OFF until the
//                                                                user accepts
//
//  8192 is DISABLE_EXTERNAL_EXTENSION. Before this split, profileHasExtension()
//  answered "yes" for all three and main.js printed "Chromium (Edge/Chrome/
//  Brave): spoofed by the extension" -- a claim about two browsers that were
//  not running it. That is the regression this file exists to prevent.
//
//  Notice what is NOT asserted anywhere here: that we can turn it on. The bit
//  lives in an HMAC-signed record (super_mac) keyed to the profile, so writing
//  it is forgery and Chromium drops a profile whose macs do not verify.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');

const browsers = require('../lib/browsers');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpxst-'));
const ID  = 'edfdpeehkfpjhhgpkaoiahndelmcimfn';   //  the real id on this machine

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};

/**
 * Build a throwaway User Data root.
 * @param {object} profiles  { Default: {entry, secure, folder}, ... }
 */
function userData(name, profiles) {
    const root = path.join(TMP, name);
    for (const [prof, spec] of Object.entries(profiles)) {
        const dir = path.join(root, prof);
        fs.mkdirSync(dir, { recursive: true });
        const file = spec.secure === false ? 'Preferences' : 'Secure Preferences';
        const body = spec.entry === undefined ? { extensions: { settings: {} } }
                   : { extensions: { settings: { [ID]: spec.entry } } };
        if (spec.raw) Object.assign(body, spec.raw);
        fs.writeFileSync(path.join(dir, file), JSON.stringify(body), 'utf8');
        //  A second store, so "husk in the protected file, the real record in
        //  the plain one" can be built at all.
        if (spec.plain !== undefined) {
            fs.writeFileSync(path.join(dir, 'Preferences'),
                JSON.stringify({ extensions: { settings: { [ID]: spec.plain } } }), 'utf8');
        }
        //  A prefs file Chromium is halfway through writing: parses as nothing,
        //  still has the id in its text.
        if (spec.truncated) {
            fs.writeFileSync(path.join(dir, spec.truncated),
                '{"extensions":{"settings":{"' + ID + '":{"location":6,', 'utf8');
        }
        if (spec.folder) {
            fs.mkdirSync(path.join(dir, 'Extensions', ID, spec.folder), { recursive: true });
        }
    }
    return root;
}

//  The three measured entries, trimmed to the keys that decide anything.
const EDGE_ENTRY = {
    location: 7, from_webstore: false, ack_external: true,
    manifest: { version: '1.1.0.2', manifest_version: 3, name: 'FreeProxy VPN Extension' },
    has_started_service_worker: true,
};
const CHROME_ENTRY = {
    location: 6, from_webstore: false, disable_reasons: [8192],
    manifest: { version: '1.1.0.2', manifest_version: 3, name: 'FreeProxy VPN Extension' },
};
//  Same fact, other spelling: older Chromium writes disable_reasons as a single
//  number rather than a list, and a reader that only handles the array form
//  reports that profile as ENABLED. Both forms have to mean the same thing.
const BRAVE_ENTRY = { ...CHROME_ENTRY, disable_reasons: 8192 };

console.log('── Edge: delivered by policy and running ──');
const edge = userData('edge', { Default: { entry: EDGE_ENTRY, folder: '1.1.0.2_0' } });
const e = browsers.extensionState(edge, ID);
ok(e.present && e.enabled, 'present and enabled');
ok(e.location === 7 && e.locationName === 'EXTERNAL_POLICY_DOWNLOAD',
   'location 7 is named, not printed as a bare number', JSON.stringify(e));
ok(e.disabled.length === 0, 'no disable reasons');
ok(e.version === '1.1.0.2', 'version comes from the browser\'s own manifest copy', e.version);
ok(browsers.profileHasExtension(edge, ID) === true, 'the bytes test still says yes');

console.log('── Chrome / Brave: delivered and switched OFF ──');
for (const [name, entry] of [['chrome', CHROME_ENTRY], ['brave', BRAVE_ENTRY]]) {
    const ud = userData(name, { Default: { entry, folder: '1.1.0.2_0' } });
    const s = browsers.extensionState(ud, ID);
    ok(s.present === true, `${name}: present`);
    ok(s.enabled === false, `${name}: NOT enabled -- 8192 means the user has not accepted it`);
    ok(s.disabled.join(',') === 'EXTERNAL_EXTENSION',
       `${name}: the reason is named`, s.disabled.join(','));
    ok(s.location === 6 && s.locationName === 'EXTERNAL_PREF_DOWNLOAD',
       `${name}: location 6 is named`);
    ok(browsers.profileHasExtension(ud, ID) === true,
       `${name}: the delivery helper still has nothing left to serve`);
}

console.log('── the user pressed Remove ──');
//  Extension::State 2, EXTERNAL_EXTENSION_UNINSTALLED. Chromium keeps the record
//  and never offers it again, so this is a decision, not a delivery failure.
const gone = userData('declined', { Default: { entry: { location: 6, state: 2 } } });
const g = browsers.extensionState(gone, ID);
ok(g.removedByUser === true, 'removedByUser is reported');
ok(g.present === false && g.enabled === false, 'and it is neither present nor enabled');
ok(browsers.profileHasExtension(gone, ID) === true,
   'yet the helper treats it as delivered -- otherwise it would serve a port for ' +
   '3.5 hours every logon, forever, over a choice the user already made');

console.log('── state 0 is disabled even with no reason bits ──');
const off = userData('userdisabled', { Default: { entry: { location: 1, state: 0 } } });
ok(browsers.extensionState(off, ID).enabled === false, 'state 0 alone is enough to say off');

console.log('── a hand-loaded folder, in plain Preferences ──');
const unp = userData('unpacked', {
    Default: { secure: false, entry: { location: 4, path: 'C:\\somewhere\\extension',
                                       manifest: { version: '1.1.0.2' } } },
});
const u = browsers.extensionState(unp, ID);
ok(u.present && u.enabled, 'Load unpacked reads as present and enabled');
ok(u.unpacked === true && u.locationName === 'UNPACKED', 'and is marked unpacked');

console.log('── bytes with no prefs entry are not "enabled" ──');
const half = userData('halfway', { Default: { entry: undefined, folder: '1.1.0.2_0' } });
const h = browsers.extensionState(half, ID);
ok(h.present === true, 'the folder alone counts as present');
ok(h.enabled === false, 'but nothing is called enabled without the browser saying so');

console.log('── the browser kept the record and threw the install away ──');
//  Measured 2026-08-30. Edge had it at location 7 with its service worker
//  running at 00:33; at a later Edge start the port its policy names was dead,
//  and what was left in Secure Preferences was `"<id>": {}` with no folder.
//  An empty record has no location to contradict it and no disable bit, so it
//  used to read as present AND enabled -- and --fp-deliver logged "Every
//  installed browser already has the extension -- nothing to serve" and exited,
//  for a browser that had nothing.
const husk = userData('husk', { Default: { entry: {} } });
const hk = browsers.extensionState(husk, ID);
ok(hk.present === false, 'an empty record is not an install');
ok(hk.enabled === false, 'and above all it is not enabled');
ok(hk.husk === true, 'it is reported as a husk, so the absence has a reason');
ok(browsers.profileHasExtension(husk, ID) === false,
   'the delivery helper still has work -- this is the exact check that said ' +
   '"nothing to serve" while Edge was empty');

console.log('── a husk does not hide the real record in the other store ──');
const both = userData('husk-plus', {
    Default: { entry: {}, folder: '1.1.0.2_0',
               plain: { location: 4, path: 'C:\\somewhere', manifest: { version: '1.1.0.2' } } },
});
const bp = browsers.extensionState(both, ID);
ok(bp.present && bp.enabled, 'the record carrying something wins');
ok(bp.locationName === 'UNPACKED', 'and it is the one that gets read', bp.locationName);
ok(bp.husk === false, 'so nothing is called a husk');

console.log('── bytes on disk outrank an emptied record ──');
const hb = browsers.extensionState(userData('husk-bytes', {
    Default: { entry: {}, folder: '1.1.0.2_0' } }), ID);
ok(hb.present === true, 'the folder is still evidence the bytes were delivered');
ok(hb.enabled === false, 'but not that the browser is running them');

console.log('── a prefs file caught mid-write is not an answer ──');
const lk = browsers.extensionState(userData('locked', {
    Default: { entry: undefined, truncated: 'Secure Preferences' } }), ID);
ok(lk.present === true, 'an unparseable file that still names the id stays present -- ' +
   'a busy browser must not read as gone and trigger a pointless re-delivery');
ok(lk.enabled === false, 'without being called enabled');

console.log('── the best profile wins, not the first one ──');
const multi = userData('multi', {
    'Default':   { entry: CHROME_ENTRY, folder: '1.1.0.2_0' },
    'Profile 1': { entry: EDGE_ENTRY,   folder: '1.1.0.2_0' },
});
const m = browsers.extensionState(multi, ID);
ok(m.enabled === true && m.profile === 'Profile 1',
   'a profile that has it running outranks one that has it switched off', m.profile);

console.log('── nothing at all ──');
const empty = userData('empty', { Default: { entry: undefined } });
ok(browsers.extensionState(empty, ID).present === false, 'an empty profile is not present');
ok(browsers.profileHasExtension(empty, ID) === false, 'and the helper still has work');
ok(browsers.extensionState(path.join(TMP, 'nope'), ID).present === false,
   'a missing User Data root is not present');
ok(browsers.extensionState(edge, '').present === false, 'an empty id is never present');
ok(browsers.extensionState(edge, 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz').present === false,
   'and neither is somebody else\'s id');

console.log('── the enum tables are the ones Chromium actually uses ──');
ok(browsers.DISABLE_REASON[8192] === 'EXTERNAL_EXTENSION',
   '8192 is EXTERNAL_EXTENSION (it was mislabelled CUSTODIAN_APPROVAL_REQUIRED once)');
ok(browsers.DISABLE_REASON[32768] === 'CUSTODIAN_APPROVAL_REQUIRED', '32768 is the custodian one');
ok(browsers.DISABLE_REASON[65536] === 'BLOCKED_BY_POLICY', '65536 is BLOCKED_BY_POLICY');
ok(browsers.EXT_LOCATION[7] === 'EXTERNAL_POLICY_DOWNLOAD' &&
   browsers.EXT_LOCATION[6] === 'EXTERNAL_PREF_DOWNLOAD', 'locations 6 and 7 are right');

//  The two bits below were wrong in this table until 2026-09-02, and both wrong
//  labels sat on reasons Chromium really can set for an off-store MV3 extension,
//  so the coverage report would have named the wrong cause. Values come from
//  extensions/browser/disable_reason.h, which forbids reordering because they
//  feed histograms -- so these are safe to pin.
ok(browsers.DISABLE_REASON[256] === 'NOT_VERIFIED', '256 is NOT_VERIFIED (1<<8), not the greylist');
ok(browsers.DISABLE_REASON[512] === 'GREYLIST', '512 is GREYLIST (1<<9)');
ok(browsers.DISABLE_REASON[524288] === 'REINSTALL',
   '524288 is REINSTALL (1<<19) -- it was labelled UNSUPPORTED_MANIFEST_VERSION');
ok(browsers.DISABLE_REASON[1048576] === 'NOT_ALLOWLISTED',
   '1048576 is NOT_ALLOWLISTED (1<<20) -- it was read off 262144');
ok(browsers.DISABLE_REASON[8388608] === 'UNSUPPORTED_MANIFEST_VERSION',
   '8388608 is UNSUPPORTED_MANIFEST_VERSION (1<<23)');
ok(browsers.DISABLE_REASON[16777216] === 'UNSUPPORTED_DEVELOPER_EXTENSION',
   '16777216 is UNSUPPORTED_DEVELOPER_EXTENSION (1<<24)');
ok(browsers.DISABLE_REASON[67108864] === 'BLOCKED_BY_CLOUD_POLICY_CHECK',
   '67108864 is BLOCKED_BY_CLOUD_POLICY_CHECK (1<<26)');
ok(browsers.DISABLE_REASON[262144] === undefined,
   '262144 (1<<18) is retired in Chromium and is claimed by nothing here');

console.log('── a bit with no label still counts as disabled ──');
{
    const p = path.join(TMP, 'unnamed');
    fs.mkdirSync(path.join(p, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(p, 'Default', 'Secure Preferences'), JSON.stringify({
        extensions: { settings: { [ID]: { location: 6, state: 1, disable_reasons: [1 << 27] } } },
    }));
    const st = browsers.extensionState(p, ID);
    ok(st.present === true, 'the record is still an install');
    ok(st.enabled === false,
       'and it is NOT enabled -- enabled is decided by bits === 0, never by whether a label was found');
    ok(st.disabled.length === 1 && /^UNNAMED_BIT_/.test(st.disabled[0]),
       `the unnamed bit is reported as itself (${st.disabled.join(',')}), not dropped`);
}

console.log('── who switched it off, per reason ──');
ok(browsers.disableAuthor(['EXTERNAL_EXTENSION']) === 'prompt',
   'EXTERNAL_EXTENSION is a prompt waiting for the user -- the one reason a single click settles for good');
ok(browsers.disableAuthor(['NOT_VERIFIED']) === 'browser',
   'NOT_VERIFIED is the browser deciding by itself');
ok(browsers.disableAuthor(['NOT_ALLOWLISTED']) === 'browser', 'so is NOT_ALLOWLISTED');
ok(browsers.disableAuthor(['BLOCKED_BY_POLICY']) === 'admin', 'BLOCKED_BY_POLICY is an administrator');
ok(browsers.disableAuthor(['USER_ACTION', 'NOT_VERIFIED']) === 'user',
   'the user outranks everything -- re-enabling would override a choice this app promised to leave alone');
ok(browsers.disableAuthor(['BLOCKED_BY_POLICY', 'NOT_VERIFIED']) === 'admin',
   'an administrator outranks the browser');
ok(browsers.disableAuthor(['EXTERNAL_EXTENSION', 'UNNAMED_BIT_134217728']) === 'unknown',
   'an unnamed bit is never optimistically reported as merely waiting for a click');
ok(browsers.disableAuthor([]) === null, 'nothing disabled has no author');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {}
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);

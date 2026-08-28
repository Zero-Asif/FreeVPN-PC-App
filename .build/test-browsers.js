'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-browsers.js
//
//  lib/browsers.js is now the ONLY place that names a browser, so a
//  mistake in it is a silent hole in proxy policy, DNS/WebRTC hardening,
//  extension delivery or the geo spoof -- with nothing in the coverage
//  report to say so. This exercises it against the real machine and
//  asserts the three properties that actually matter:
//
//    1. TABLE SANITY -- ids unique, every Chromium row has a policy root
//       or a written-down reason not to, every row is reachable.
//    2. NO FALSE POSITIVES -- an exe verified on disk is required before
//       anything is called installed, a profile alone is never enough,
//       and a browser must never be resolved to ANOTHER browser's
//       executable (App Paths\chrome.exe is Chrome's, and reading it for
//       the `chromium` row reported Chromium on a machine without it).
//    3. IT IS FAST ENOUGH TO SIT ON THE CONNECT PATH -- detect() runs
//       three times per connect. The per-browser registry probe it
//       replaced cost 5.1 s.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const B = require('../lib/browsers');

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
    if (cond) { pass++; console.log('  ok   ' + msg); }
    else { fail++; console.log('  FAIL ' + msg + (extra ? '\n         ' + extra : '')); }
};

console.log('── table sanity ──');
ok(B.ALL.length === B.CHROMIUM.length + B.GECKO.length + B.WININET.length,
   'ALL is exactly the three families');
const ids = B.ALL.map(b => b.id);
ok(new Set(ids).size === ids.length, 'every id is unique', ids.join(','));
ok(B.ALL.every(b => b.name && b.exe && b.family && Array.isArray(b.exePaths)),
   'every row has name/exe/family/exePaths');
ok(B.CHROMIUM.every(b => ['works', 'refused', 'unknown', 'no-policy'].includes(b.forcelist)),
   'every Chromium row carries a sourced forcelist verdict');
ok(B.CHROMIUM.every(b => (b.policy === null) === (b.forcelist === 'no-policy')),
   'policy===null iff forcelist==="no-policy" -- no silent policy-less row');
ok(B.CHROMIUM.every(b => Array.isArray(b.userData) && b.userData.length),
   'every Chromium row names a User Data root');
ok(B.GECKO.every(b => Array.isArray(b.profiles) && b.profiles.length),
   'every Gecko row names a profile root');
ok(B.byId('edge') && !B.byId('nope'), 'byId() finds a real row and not a made-up one');

console.log('');
console.log('── expand() ──');
ok(B.expand('%LOCALAPPDATA%\\x') === process.env.LOCALAPPDATA + '\\x', 'expands a set var');
ok(B.expand('%FP_NOT_A_REAL_VAR%\\x') === null,
   'an UNSET var collapses the whole path to null, so it can never half-expand');
ok(B.expand('C:\\plain') === 'C:\\plain', 'leaves a plain path alone');

console.log('');
console.log('── detect() speed: it runs three times per connect ──');
B.resetCache();
let t = Date.now();
const found = B.detect();
const cold = Date.now() - t;
t = Date.now();
B.detect(); B.detect();
const warm = Date.now() - t;
console.log(`   cold ${cold} ms, two more in ${warm} ms`);
ok(cold < 1500, `first detect() under 1.5 s (was 5069 ms per-browser)`, cold + ' ms');
ok(warm < 200, 'cached calls are effectively free', warm + ' ms');

console.log('');
console.log('── what is really here ──');
for (const b of found) {
    console.log(`   ${b.name.padEnd(20)}${b.family.padEnd(10)}` +
                `${(b.dataDir ? 'has-profile' : 'no-profile-yet').padEnd(16)}${b.exePath}`);
}
const orph = B.orphanProfiles();
for (const b of orph) console.log(`   ORPHAN  ${b.name.padEnd(18)}${b.dataDir}`);

console.log('');
console.log('── no false positives ──');
ok(found.length > 0, 'at least one browser detected (a machine with none is a bug here)');
ok(found.every(b => b.exePath && fs.existsSync(b.exePath)),
   'every detected exePath exists on disk RIGHT NOW');
ok(found.every(b => b.installed === true), 'detected rows are marked installed');
ok(orph.every(b => !b.exePath && b.dataDir), 'orphans have a profile and no exe');
ok(!found.some(b => orph.some(o => o.id === b.id)),
   'nothing is both detected and orphaned');

//  The bug this test exists for: two rows resolving to the same file.
const byPath = {};
let collision = null;
for (const b of found) {
    const k = b.exePath.toLowerCase();
    if (byPath[k]) collision = `${byPath[k]} and ${b.id} both resolve to ${b.exePath}`;
    byPath[k] = b.id;
}
ok(!collision, 'no two browsers resolve to the SAME executable', collision);

//  ...and the specific shape of it: a fork must be found in its own
//  directory, never via a shared App Paths\<exe> registration.
for (const b of found) {
    const dir = b.exePath.toLowerCase();
    const marker = b.id === 'operagx' ? 'opera gx'
                 : b.id === 'ie'      ? 'internet explorer'
                 : b.id === 'edge'    ? '\\edge\\'
                 : b.id === 'chrome'  ? '\\google\\chrome\\'
                 : b.id === 'brave'   ? 'brave'
                 : b.id;
    ok(dir.includes(marker),
       `${b.name} resolved inside its own install tree`, b.exePath);
}
ok(!found.some(b => b.id === 'chromium') ||
   found.find(b => b.id === 'chromium').exePath.toLowerCase().includes('chromium'),
   'the `chromium` row is NOT satisfied by Google Chrome\'s chrome.exe');

console.log('');
console.log('── the three consumers get consistent answers ──');
const roots = B.policyRoots('reg');
const rootsPs = B.policyRoots('ps');
console.log('   policyRoots: ' + roots.map(r => r.id).join(', '));
ok(roots.every(r => r.key.startsWith('HKLM\\SOFTWARE\\Policies\\')),
   'reg-style roots are HKLM\\SOFTWARE\\Policies\\...');
ok(rootsPs.every(r => r.key.startsWith('HKLM:\\SOFTWARE\\Policies\\')),
   'ps-style roots are HKLM:\\SOFTWARE\\Policies\\...');
ok(roots.length === rootsPs.length, 'both styles cover the same browsers');
ok(roots.every(r => found.some(b => b.id === r.id && b.family === 'chromium')),
   'a policy root is only offered for a DETECTED Chromium browser');
ok(!roots.some(r => B.byId(r.id).policy === null),
   'no policy root for a browser that implements none (Opera)');

const procs = B.processNames();
console.log('   processNames: ' + procs.join(', '));
ok(new Set(procs).size === procs.length, 'process list is deduplicated');
ok(!procs.includes('iexplore.exe'),
   'IE is not on the close list -- it reads nothing we write at startup');
ok(procs.every(p => found.some(b => b.exe === p)), 'only detected browsers are closed');

const ud = B.chromiumUserData();
const gp = B.geckoProfileRoots();
console.log('   chromiumUserData: ' + Object.keys(ud).join(', '));
console.log('   geckoProfileRoots: ' + (Object.keys(gp).join(', ') || '(none)'));
ok(Object.values(ud).every(d => fs.existsSync(d)), 'every User Data dir returned exists');
ok(Object.values(gp).every(d => fs.existsSync(d)), 'every Gecko profile root returned exists');
ok(Object.keys(gp).every(id => found.some(b => b.id === id)),
   'Gecko roots belong to INSTALLED browsers only -- the dead Firefox profiles ' +
   'on this machine must not be written to');
ok(!Object.keys(ud).some(id => orph.some(o => o.id === id)),
   'no orphaned Chromium profile is offered for writing');

console.log('');
console.log(`${pass}/${pass + fail} checks passed` + (fail ? `  (${fail} FAILED)` : ''));
process.exit(fail ? 1 : 0);

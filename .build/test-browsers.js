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
//  FP_BROWSERS points this suite at another copy of lib/browsers.js, which is
//  how the eight-spawn version is shown failing rather than described as failing.
const SRC = process.env.FP_BROWSERS || path.join(__dirname, '..', 'lib', 'browsers.js');
const B = require(SRC);
const { stripComments } = require('./srcstrip.js');

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
console.log('── the registry scan: ONE spawn, not eight ──');
//  detect() sat at 1513-1699 ms and the 29 filesystem stats in it cost 3-14 ms.
//  probe-regquery-cost.js found the rest: `reg /?`, which reads no registry at
//  all, costs 176 ms, so the eight separate `reg query` calls were paying for
//  eight process starts and ~90 ms of actual I/O. Chained into one shell the
//  same 138 values arrive in 676-770 ms, identical on every field
//  (probe-regscan-equivalence.js). A wall-clock budget alone would not hold this:
//  on a slower machine 8 spawns and 1 spawn both blow it, and the invariant that
//  matters is the count.
{
    const cp = require('child_process');
    const real = cp.execSync;
    const calls = [];
    cp.execSync = (cmd) => {
        calls.push(cmd);
        return 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Fake\\shell\\open\\command\r\n' +
               '    (Default)    REG_SZ    "C:\\nope\\fake.exe"\r\n';
    };
    try {
        B.resetCache();
        B.regExePaths();
    } finally { cp.execSync = real; B.resetCache(); }
    ok(calls.length === 1, 'regExePaths() shells out exactly once', calls.length + ' times');
    const cmd = calls[0] || '';
    ok((cmd.match(/reg query/g) || []).length === 8,
       'and that one command carries all eight queries',
       String((cmd.match(/reg query/g) || []).length));
    ok(cmd.includes(' & ') && !cmd.includes('&&'),
       'chained with & and never &&, so an absent key cannot stop the rest');
    for (const k of ['HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft', 'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft',
                     'WOW6432Node', 'Clients\\StartMenuInternet']) {
        ok(cmd.includes(k), `  the chain still covers ${k}`);
    }
}

//  The hazard the chain introduces: cmd.exe returns the LAST command's exit
//  code, HKCU\...\WOW6432Node\Clients\StartMenuInternet does not exist on this
//  machine, and `reg query` on a missing key exits 1 -- so execSync throws and
//  seven good dumps go in the bin unless e.stdout is read.
{
    const cp = require('child_process');
    const real = cp.execSync;
    cp.execSync = () => {
        const e = new Error('Command failed');
        e.status = 1;
        e.stdout =
            'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe\r\n' +
            '    (Default)    REG_SZ    ' + (B.byId('edge').exePaths[0] || '') + '\r\n' +
            '\r\nERROR: The system was unable to find the specified registry key or value.\r\n';
        throw e;
    };
    let map = null;
    try { B.resetCache(); map = B.regExePaths(); }
    catch (e) { map = { THREW: e.message }; }
    finally { cp.execSync = real; B.resetCache(); }
    ok(map && !map.THREW, 'a chain whose LAST query fails does not throw out of regExePaths()',
       map && map.THREW);
    ok(map && !map.THREW && Object.keys(map).length >= 0,
       '  and the dumps that did arrive are still parsed', JSON.stringify(map));
}

const bsrc = stripComments(fs.readFileSync(SRC, 'utf8'));
ok(/\.join\(' & '\)/.test(bsrc), 'the source really joins the queries into one command');
ok(/e\.stdout/.test(bsrc), 'and the catch reads e.stdout instead of returning nothing');
ok(/timeout: \d+/.test(bsrc), 'the scan is bounded, so a wedged reg.exe cannot hang a connect');
//  The shape that shipped: a scan() called once per root.
ok(!/Object\.assign\(hives, scan\(/.test(bsrc), 'and the eight-call loop it replaced is gone');

console.log('');
console.log('── detect() speed: it runs three times per connect ──');
//  Three cold-cache samples, best one judged. One sample also measures whatever
//  else the disk is doing: right after a `npm run dist` this read 1730 ms against
//  a 1500 ms budget with lib/browsers.js untouched, which is Defender walking a
//  142 MB installer, not a regression. The regression this guards against was
//  algorithmic -- 5069 ms PER BROWSER, repeated work rather than a slow disk --
//  and that shows up in every sample, warm cache or not.
let cold = Infinity;
const samples = [];
let found = [];
for (let i = 0; i < 3; i++) {
    B.resetCache();
    const t0 = Date.now();
    found = B.detect();
    const ms = Date.now() - t0;
    samples.push(ms);
    if (ms < cold) cold = ms;
    if (cold < 1500) break;
}
let t = Date.now();
B.detect(); B.detect();
const warm = Date.now() - t;
console.log(`   cold ${samples.join(' / ')} ms, two more in ${warm} ms`);
ok(cold < 1500, `first detect() under 1.5 s (was 5069 ms per-browser)`,
   'best of ' + samples.join(', ') + ' ms');
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

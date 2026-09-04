'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-containment-recovery.js
//
//  lib/containment.js writes the two files that have to work on a PC where
//  this app is gone: restore-internet.bat, and -- from 2.0.5 --
//  restore-gecko-prefs.ps1 beside it.
//
//  The .bat is checked structurally: it cannot be executed here without
//  flipping this machine's firewall policy. The .ps1 IS executed, for real,
//  against a fake user tree in the temp directory with $env:SystemDrive and
//  $env:ProgramData pointed at it -- so the Firefox recovery is proved by
//  reading files back, not by reading the source and believing it.
//
//  Nothing outside the temp directory is written and no browser is needed:
//  the profiles are directories with a user.js in them, which is all the
//  script looks for.
// ════════════════════════════════════════════════════════════════════
const os   = require('os');
const path = require('path');
const fs   = require('fs');
const { execFileSync } = require('child_process');
const { Containment, RULE_NAMES } = require('../lib/containment.js');
const { GeoSpoof } = require('../lib/geo-spoof.js');

let pass = 0, fail = 0;
const ok = (c, m, x) => {
    if (c) { pass++; console.log('  ok   ' + m); }
    else { fail++; console.log('  FAIL ' + m + (x ? '\n         ' + String(x) : '')); }
};

const warned = [];
const log = { info() {}, success() {}, debug() {},
              warn: m => warned.push(String(m)), error: m => warned.push(String(m)) };

//  realpathSync.native, and it is not decoration: os.tmpdir() returns %TEMP%,
//  which on this machine is the 8.3 SHORT form C:\Users\USERPC~1\AppData\Local\
//  Temp, while PowerShell's Get-ChildItem hands back the long C:\Users\User pc\.
//  A journal written with one and looked up with the other misses, and the first
//  run of this probe failed exactly there. Production uses %APPDATA%, which is
//  always long -- so the long form is what this must test with. The short-name
//  case gets its own run at the end.
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-recov-')));
const STATE = path.join(TMP, 'state');
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} };
process.on('exit', cleanup);

const C = new Containment({
    Logger: log, stateDir: STATE,
    torExe: path.join(STATE, 'tor.exe'), appExe: process.execPath,
});

console.log('── both files are written, and the .bat is the fatal one ──');
const r = C.writeRecovery();
ok(r.ok, 'writeRecovery() succeeded', JSON.stringify(r));
if (!r.ok) { console.log('\nABORT'); process.exit(1); }
ok(r.gecko === true, 'it reports the Gecko half was written too');
ok(fs.existsSync(r.path), 'restore-internet.bat is on disk');
const PS1 = path.join(STATE, 'restore-gecko-prefs.ps1');
ok(fs.existsSync(PS1), 'restore-gecko-prefs.ps1 is beside it', PS1);
ok(path.dirname(PS1) === path.dirname(r.path),
   'in the SAME directory -- the .bat finds it with %~dp0, which survives ' +
   'the Start-Process -Verb RunAs self-elevation');

// ── the .bat, structurally ──────────────────────────────────────────
const bat = fs.readFileSync(r.path, 'utf8');
console.log('');
console.log('── the .bat still removes every rule this module owns ──');
const missing = RULE_NAMES.filter(n => !bat.includes(`name="${n}"`));
ok(missing.length === 0, 'every allow rule appears in the recovery script',
   'missing: ' + missing.join(', '));
for (const need of ['blockinbound,allowoutbound', 'netsh winhttp reset proxy',
                    'Start-Process', 'ProxyEnable',
                    'FreeProxy VPN - block Windows location resolution']) {
    ok(bat.includes(need), 'it still does: ' + need);
}

console.log('');
console.log('── ...and now calls the Gecko half, or says it could not ──');
ok(bat.includes('if exist "%~dp0restore-gecko-prefs.ps1" powershell'),
   'the .ps1 is invoked when it is there');
ok(bat.includes('if not exist "%~dp0restore-gecko-prefs.ps1" ('),
   'and there is a branch for when it is not');
ok(/echo\s+SKIPPED/.test(bat),
   'that branch says SKIPPED -- it does not print a step number and move on');
ok(/9050/.test(bat), 'and names the port the browser is still pointed at');
ok(bat.includes('[6/7]') && bat.includes('[7/7]') && !bat.includes('/6]'),
   'the steps are renumbered to 7, with the check last',
   'still has a /6] at ' + bat.indexOf('/6]'));
ok(bat.indexOf('[6/7]') < bat.indexOf('[7/7]'),
   'the Firefox step runs BEFORE the result check, not after it');
ok(bat.indexOf('taskkill /F /IM tor.exe') < bat.indexOf('[6/7]'),
   'and after tor.exe is killed, so the browser is not left aimed at a live port');

//  cmd.exe has no way to parse a .bat without running it, so check the two
//  structures that fail silently: unbalanced parentheses at top level, and a
//  pipe outside a for /f. `) else (` is deliberately not used -- see below.
const blines = bat.split('\r\n');
let depth = 0; const badAt = [];
blines.forEach((l, i) => {
    if (/^\s*if .*\($/.test(l) || /^\s*for .*do \($/.test(l)) depth++;
    else if (/^\s*\)\s*$/.test(l)) depth--;
    if (depth < 0) badAt.push(i + 1);
});
ok(depth === 0 && badAt.length === 0, 'parentheses balance at top level',
   'depth ' + depth + (badAt.length ? ', went negative at line ' + badAt : ''));
ok(!/\) else \(/.test(bat),
   'no `) else (` -- it is valid batch but this checker cannot see through it, ' +
   'so two separate `if exist` lines are used instead');

// ── the .ps1, structurally ──────────────────────────────────────────
const psBuf = fs.readFileSync(PS1);
const ps = psBuf.toString('utf8');
//  The script minus its comments. Several checks below are about what the script
//  DOES, and the comments legitimately name things it must not do -- the first
//  draft of this probe failed three times over on text inside them.
const psCode = ps.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');
console.log('');
console.log('── the .ps1 is ASCII, and matches markers a shell cannot mangle ──');
const hiByte = psBuf.findIndex(b => b > 0x7e);
ok(hiByte < 0, 'every byte is ASCII -- PowerShell 5.1 reads a BOM-less file as ' +
   'ANSI, so a non-ASCII byte here would arrive mojibaked',
   hiByte < 0 ? '' : 'byte 0x' + psBuf[hiByte].toString(16) + ' at offset ' + hiByte);
ok(!ps.includes('─'),
   'the U+2500 box-drawing fence is NOT what it matches on');
ok(psCode.includes('$BEGIN = "FreeProxy VPN:"'),
   'the opening marker is matched by its ASCII substring');
ok(GeoSpoof.FF_BEGIN.includes('FreeProxy VPN:') && GeoSpoof.FF_END.includes('end FreeProxy VPN'),
   'and those substrings really are inside the markers geo-spoof.js writes',
   GeoSpoof.FF_BEGIN + ' / ' + GeoSpoof.FF_END);

//  MEASURED, and it shipped broken in the first draft: the block's own text
//  explains to a human which lines to delete, and that sentence contains the
//  words "end FreeProxy VPN". A substring match ends the block THERE -- four
//  lines in -- and leaves network.proxy.type = 1 in the file, which is the exact
//  failure this script exists to undo.
const BLOCK_TEXT = GeoSpoof._ffBlock({ lat: 1, lng: 2, accuracy: 40, city: 'X' },
                                     { host: '127.0.0.1', port: 9050, bypass: '' }).text;
const decoys = BLOCK_TEXT.split(/\r?\n/)
    .filter(l => l.includes('end FreeProxy VPN') && l.trim() !== GeoSpoof.FF_END);
ok(decoys.length > 0,
   'the block really does contain a DECOY "end FreeProxy VPN" before its real ' +
   'end marker -- this is the trap the next check is about',
   'no decoy line found; if the block text changed, the check below is now moot');
ok(psCode.includes("$ENDRX = 'end FreeProxy VPN[^A-Za-z0-9]*$'"),
   'so the closing marker is matched by an ANCHORED regex, not a substring');
ok(decoys.every(l => !/end FreeProxy VPN[^A-Za-z0-9]*$/.test(l)) &&
   /end FreeProxy VPN[^A-Za-z0-9]*$/.test(GeoSpoof.FF_END),
   'and that regex rejects every decoy line while still matching the real one',
   JSON.stringify(decoys[0] || ''));
//  2.0.4's marker read "spoofed geolocation while connected". A machine
//  upgrading from it still has that line, and a recovery that only knew the
//  new wording would leave that block -- and its proxy prefs -- forever.
ok('// ── FreeProxy VPN: spoofed geolocation while connected ──'
       .includes('FreeProxy VPN:'),
   'the 2.0.4 fence is matched by the same substring, so an upgraded machine ' +
   'is recoverable too');

console.log('');
console.log('── it knows every pref this app writes, and only those ──');
const absent = GeoSpoof.FF_ALL_PREFS.filter(p => !ps.includes("'" + p + "'"));
ok(absent.length === 0, `all ${GeoSpoof.FF_ALL_PREFS.length} pref names are in the ` +
   'script, from FF_ALL_PREFS rather than a second hand-kept list',
   'absent: ' + absent.join(', '));
ok(!/'network\.proxy\.http'/.test(psCode),
   'and network.proxy.http is NOT in $OURS -- this app never writes it, so ' +
   'recovery must not clear a corporate proxy it did not set');
ok(psCode.includes('$UsersRoot = (Join-Path $env:SystemDrive "Users")'),
   'it enumerates every user on the PC by default -- self-elevation can put a ' +
   'different account in APPDATA than the one whose browser is broken');
ok(!/\$env:APPDATA/.test(psCode),
   'and never reads APPDATA to decide where to look');
ok(/-Recurse -Depth 4/.test(psCode),
   'depth 4 -- exactly deep enough for "Moonchild Productions\\Pale Moon\\' +
   'Profiles\\<p>\\user.js" without walking the whole of Roaming');
ok(psCode.includes('$Journal   = (Join-Path $env:ProgramData "freeproxy-vpn\\geo-restore.json")'),
   'and reads the restore journal by default, so a user\'s own values come back');
ok(psCode.includes('if ($leafCount[$lf] -eq 1) { $back = $leafPrior[$lf] }'),
   'the profile-folder-name fallback fires ONLY when that name is unique in the ' +
   'journal -- an ambiguous one must not hand a profile another profile\'s values');
ok(/exit 0\s*$/.test(ps.trim()),
   'it exits 0 -- the .bat must carry on to the result check either way');
ok(!/Set-Content[^\r\n]*-Encoding UTF8/.test(psCode) && psCode.includes('UTF8Encoding($false)'),
   'and writes UTF-8 with NO BOM -- PowerShell 5.1\'s -Encoding UTF8 prepends ' +
   'one, and a BOM on line 1 of a prefs file costs the user every pref in it');

console.log('');
console.log('── PowerShell itself parses it ──');
const PARSE = [
    '$e = $null; $t = $null;',
    '[void][System.Management.Automation.Language.Parser]::ParseFile(',
    "'" + PS1 + "', [ref]$t, [ref]$e);",
    'if ($e.Count -gt 0) {',
    "  foreach ($x in $e) { 'ERR line ' + $x.Extent.StartLineNumber + ': ' + $x.Message }",
    "} else { 'PARSE-OK' }",
].join(' ');
let parsed = '';
try {
    parsed = execFileSync('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PARSE],
        { encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim();
} catch (e) { parsed = 'THREW: ' + (e.stdout || '') + (e.message || ''); }
ok(parsed === 'PARSE-OK', 'no syntax errors, checked by PowerShell\'s own parser', parsed);

// ── and then it is RUN, for real, against a fake user tree ──────────
//  -UsersRoot and -Journal are pointed into the temp directory, which is the
//  only reason this is safe to run unattended: the script's own enumeration is
//  what gets redirected, so it cannot reach a real profile. Overriding
//  $env:SystemDrive was the first attempt and it does NOT work -- Windows hands
//  the child C: regardless -- which is why the script takes parameters.
const COORD = { lat: 49.611621, lng: 6.131935, accuracy: 40, city: 'Luxembourg' };
const PROXY = { host: '127.0.0.1', port: 9050, bypass: 'example.com' };
const BLOCK = GeoSpoof._ffBlock(COORD, PROXY).text;
const HOME  = 'user_pref("browser.startup.homepage", "https://example.invalid/");';
const PD    = path.join(TMP, 'pd');
const JOURNAL = path.join(PD, 'freeproxy-vpn', 'geo-restore.json');

const profile = (user, vendor, name) => {
    const dir = path.join(TMP, 'Users', user, 'AppData', 'Roaming',
                          ...vendor.split('\\'), 'Profiles', name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};
const runPs1 = () => {
    try {
        return execFileSync('powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1,
             '-UsersRoot', path.join(TMP, 'Users'), '-Journal', JOURNAL],
            { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    } catch (e) { return 'THREW: ' + (e.stdout || '') + ' ' + (e.message || ''); }
};

//  Three profiles, one per case that matters:
//    keep     -- a user.js the user wrote, with our block appended
//    ours     -- a user.js that exists ONLY because we created it
//    innocent -- a Gecko profile this app never touched at all
const KEEP = profile('alice', 'Mozilla\\Firefox', 'abc.default-release');
const OURS = profile('alice', 'Waterfox', 'xyz.second');
const INNOCENT = profile('bob', 'Moonchild Productions\\Pale Moon', 'pm.default');

//  The user's own choices, which this script must hand back rather than reset.
const OWN_SOCKS = 'user_pref("network.proxy.type", 4);';
const OWN_GEO   = 'user_pref("geo.provider.network.url", ' +
                  '"https://location.services.mozilla.com/v1/geolocate");';
const NOTIF     = 'user_pref("dom.webnotifications.enabled", false);';

const seed = () => {
    fs.writeFileSync(path.join(KEEP, 'user.js'), HOME + '\r\n' + BLOCK + '\r\n', 'utf8');
    //  What Gecko copies into prefs.js at shutdown: OUR values, over the top of
    //  the two the user had set themselves.
    fs.writeFileSync(path.join(KEEP, 'prefs.js'), [
        HOME,
        'user_pref("geo.provider.network.url", "data:application/json,{\\"location\\"}");',
        'user_pref("network.proxy.type", 1);',
        'user_pref("network.proxy.socks", "127.0.0.1");',
        NOTIF,
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(OURS, 'user.js'), BLOCK + '\r\n', 'utf8');
    fs.writeFileSync(path.join(OURS, 'prefs.js'),
        ['user_pref("network.proxy.type", 1);', NOTIF].join('\n'), 'utf8');

    fs.writeFileSync(path.join(INNOCENT, 'user.js'), HOME + '\r\n', 'utf8');
    fs.writeFileSync(path.join(INNOCENT, 'prefs.js'), [OWN_SOCKS, NOTIF].join('\n'), 'utf8');
};
const writeJournalWith = firefox => {
    fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
    fs.writeFileSync(JOURNAL, JSON.stringify({
        createdAt: new Date().toISOString(), policy: [], profiles: [], windows: null,
        firefox,
    }), 'utf8');
};
const writeJournal = () => writeJournalWith([
    { dir: KEEP, userJs: path.join(KEEP, 'user.js'), browser: 'firefox',
      existed: true, prior: HOME + '\r\n', priorPrefs: [OWN_GEO, OWN_SOCKS] },
    { dir: OURS, userJs: path.join(OURS, 'user.js'), browser: 'waterfox',
      existed: false, prior: null, priorPrefs: [] },
]);

console.log('');
console.log('── run 1: WITH the journal, on three real profiles ──');
seed();
writeJournal();
const out1 = runPs1();
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
const count = (s, sub) => (String(s).split(sub).length - 1);

ok(!/THREW/.test(out1), 'the script ran without throwing', out1);
ok(/2 profile\(s\)/.test(out1), 'it reports the two profiles that carried our block',
   out1.trim());
ok(/restore journal/.test(out1) && !/no restore journal/.test(out1),
   'and says the values came back FROM the journal', out1.trim());

const keepUser = read(path.join(KEEP, 'user.js'));
ok(keepUser !== null && keepUser.trim() === HOME,
   "the user's own user.js is back to exactly their line -- our block is gone",
   JSON.stringify(keepUser));
ok(keepUser !== null && !keepUser.includes('FreeProxy VPN'),
   'neither marker is left behind in it');
ok(read(path.join(OURS, 'user.js')) === null,
   'a user.js that existed only because we made it is DELETED, not left empty');

const keepPrefs = read(path.join(KEEP, 'prefs.js'));
ok(!keepPrefs.includes('data:application/json,'),
   'the spoofed geolocation value is out of prefs.js -- Gecko copies user.js ' +
   'values in there at shutdown, so removing user.js alone leaves the spoof');
ok(!keepPrefs.includes('user_pref("network.proxy.type", 1);'),
   'and so is the SOCKS proxy that points at a port nothing is answering');
ok(!keepPrefs.includes('network.proxy.socks'),
   'along with every other proxy pref this app wrote');
ok(keepPrefs.includes(OWN_SOCKS),
   "the user's OWN network.proxy.type is back, verbatim -- not deleted, and not " +
   'reset to a default they never chose', JSON.stringify(keepPrefs));
ok(keepPrefs.includes(OWN_GEO), "and their own geolocation provider with it");
ok(count(keepPrefs, 'network.proxy.type') === 1 &&
   count(keepPrefs, 'geo.provider.network.url') === 1,
   'each of those appears exactly ONCE -- ours was filtered out before theirs ' +
   'was appended, so the file does not end up holding both');
ok(keepPrefs.includes(HOME) && keepPrefs.includes(NOTIF),
   'every pref this app never wrote is untouched');
ok(!/﻿/.test(keepPrefs) && !/﻿/.test(keepUser || ''),
   'and neither rewritten file starts with a byte-order mark');

const oursPrefs = read(path.join(OURS, 'prefs.js'));
ok(!oursPrefs.includes('network.proxy.type'),
   'a profile whose journal entry has no priorPrefs gets our lines removed and ' +
   'nothing invented in their place', JSON.stringify(oursPrefs));
ok(oursPrefs.includes(NOTIF), 'its other prefs survive');

console.log('');
console.log('── a profile this app never touched is not touched now either ──');
ok(read(path.join(INNOCENT, 'user.js')) === HOME + '\r\n',
   'its user.js is byte-identical -- no marker, so the script skips it',
   JSON.stringify(read(path.join(INNOCENT, 'user.js'))));
ok(read(path.join(INNOCENT, 'prefs.js')) === [OWN_SOCKS, NOTIF].join('\n'),
   'and its prefs.js keeps the manual proxy the user set themselves. This is ' +
   'the corporate-laptop case: a pref named in FF_ALL_PREFS is only OURS in a ' +
   'profile we fenced a block into',
   JSON.stringify(read(path.join(INNOCENT, 'prefs.js'))));

console.log('');
console.log('── run 2: no journal at all, which is the uninstalled case ──');
//  The app deletes its state directory on uninstall. The script must still
//  produce a browser that can load a page, and must SAY that the user's own
//  values for those prefs could not be recovered rather than imply they were.
seed();
fs.rmSync(path.dirname(JOURNAL), { recursive: true, force: true });
const out2 = runPs1();
ok(!/THREW/.test(out2), 'it runs with no journal on disk', out2);
ok(/no restore journal/.test(out2),
   'and says so, in as many words, instead of claiming a restore it did not do',
   out2.trim());
ok(read(path.join(KEEP, 'user.js')).trim() === HOME,
   'our block is still stripped from user.js');
const keep2 = read(path.join(KEEP, 'prefs.js'));
ok(!keep2.includes('data:application/json,') &&
   !keep2.includes('user_pref("network.proxy.type", 1);'),
   'and our prefs are still out of prefs.js, so the browser works again');
ok(!keep2.includes('network.proxy.type'),
   'with nothing appended in their place -- there was no record of what to put back');
ok(keep2.includes(HOME) && keep2.includes(NOTIF), 'and their other prefs are intact');

console.log('');
console.log('── run 3: nothing left to do ──');
const out3 = runPs1();
ok(/nothing found/.test(out3),
   'a second run reports nothing found rather than reporting work it did not do',
   out3.trim());
ok(read(path.join(KEEP, 'prefs.js')) === keep2,
   'and prefs.js is byte-identical -- the script is idempotent');

console.log('');
console.log('── run 4: the journal names the profile in a different path FORM ──');
//  MEASURED, and it is what made the first version of this probe fail three
//  checks: %TEMP% on this machine is the 8.3 short C:\Users\USERPC~1\... while
//  PowerShell's enumeration returns C:\Users\User pc\..., so the journal key and
//  the lookup key named the same folder and did not match. Production writes
//  %APPDATA%, which is long -- but a mapped drive or a redirected AppData does
//  the same thing, and the failure is SILENT: our prefs come out, the user's own
//  values do not come back, and the script prints that they did.
seed();
const FOREIGN = path.join('D:\\SOMEWH~1\\Roaming\\Mozilla\\Firefox\\Profiles',
                          path.basename(KEEP));
writeJournalWith([{ dir: FOREIGN, userJs: path.join(FOREIGN, 'user.js'),
                    browser: 'firefox', existed: true, prior: HOME + '\r\n',
                    priorPrefs: [OWN_GEO, OWN_SOCKS] }]);
const out4 = runPs1();
ok(!/THREW/.test(out4), 'it runs', out4);
const keep4 = read(path.join(KEEP, 'prefs.js'));
ok(keep4.includes(OWN_SOCKS) && keep4.includes(OWN_GEO),
   "the user's own values come back anyway -- matched on the salted profile folder " +
   'name when the recorded path does not match string for string',
   JSON.stringify(keep4));
ok(count(keep4, 'network.proxy.type') === 1 &&
   count(keep4, 'geo.provider.network.url') === 1,
   'and still exactly once each');

console.log('');
console.log('── run 5: two journal entries share that name, so the fallback stands down ──');
seed();
const WRONG = 'user_pref("network.proxy.type", 2);';
writeJournalWith([
    { dir: FOREIGN, userJs: '', browser: 'firefox', existed: true, prior: null,
      priorPrefs: [OWN_SOCKS] },
    { dir: path.join('E:\\other\\Roaming\\Waterfox\\Profiles', path.basename(KEEP)),
      userJs: '', browser: 'waterfox', existed: true, prior: null,
      priorPrefs: [WRONG] },
]);
const out5 = runPs1();
ok(!/THREW/.test(out5), 'it runs', out5);
const keep5 = read(path.join(KEEP, 'prefs.js'));
ok(!keep5.includes(WRONG) && !keep5.includes(OWN_SOCKS),
   'NEITHER entry is used -- an ambiguous folder name gets the no-journal outcome ' +
   "rather than another profile's proxy setting", JSON.stringify(keep5));
ok(!keep5.includes('network.proxy.type'),
   'so the browser is unproxied and can load a page, which is the point of the script');
ok(keep5.includes(HOME) && keep5.includes(NOTIF), 'and their own prefs are intact');

console.log('');
ok(warned.length === 0, 'nothing in lib/containment.js warned while writing either file',
   warned.join(' | '));
cleanup();
console.log('');
console.log(`${pass}/${pass + fail} checks passed` + (fail ? `  (${fail} FAILED)` : ''));
process.exit(fail ? 1 : 0);

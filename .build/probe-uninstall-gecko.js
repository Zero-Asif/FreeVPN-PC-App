'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-uninstall-gecko.js
//
//  installer.nsh writes $TEMP\fp-uninstall-clean.ps1 one FileWrite at a time,
//  through two layers of escaping (NSIS's, then PowerShell's), and it runs on a
//  machine where this app's exe is already gone. Nothing else in the repo ever
//  executes it, and an uninstaller that leaves Firefox pointed at a dead SOCKS
//  port has not uninstalled -- so this probe RECONSTRUCTS that file the way NSIS
//  would, checks it, has PowerShell parse it, and then runs its Firefox section
//  for real against profiles built in the temp directory.
//
//  Two paths in the generated script reach the real machine: $env:ProgramData
//  (the app's own recovery script) and $env:SystemDrive\Users (every profile on
//  the PC). Both are redirected into the temp tree before anything is executed,
//  and the redirection is ASSERTED -- if either substitution misses, this file
//  aborts without running a line, because the alternative is a probe that
//  rewrites the developer's own Firefox.
//
//  The hosts-file and certificate sections are parsed but never run: they have
//  no way to be pointed somewhere safe.
// ════════════════════════════════════════════════════════════════════
const os   = require('os');
const path = require('path');
const fs   = require('fs');
const { execFileSync } = require('child_process');
const { GeoSpoof } = require('../lib/geo-spoof.js');

let pass = 0, fail = 0;
const ok = (c, m, x) => {
    if (c) { pass++; console.log('  ok   ' + m); }
    else { fail++; console.log('  FAIL ' + m + (x ? '\n         ' + String(x) : '')); }
};
const die = m => { console.log('\nABORT: ' + m); process.exit(3); };

//  realpathSync.native: %TEMP% is the 8.3 short form on some machines and
//  PowerShell enumerates the long one. See probe-containment-recovery.js.
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-unins-')));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

const ROOT = path.join(__dirname, '..');
const nsh  = fs.readFileSync(path.join(ROOT, 'installer.nsh'), 'utf8');

// ── reconstruct the file NSIS writes ────────────────────────────────
//  NSIS unescaping, inside a "..." literal, in ONE left-to-right pass so that
//  $$ cannot be mistaken for the $ of a $\r. These five are the only escapes
//  the block uses; anything else is literal, including a lone backslash.
const unescapeNsis = s => {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        if (s[i] !== '$') { out += s[i]; continue; }
        const n = s[i + 1];
        if (n === '$') { out += '$'; i++; continue; }
        if (n === '\\') {
            const c = s[i + 2];
            if (c === 'r') { out += '\r'; i += 2; continue; }
            if (c === 'n') { out += '\n'; i += 2; continue; }
            if (c === 't') { out += '\t'; i += 2; continue; }
            if (c === '"') { out += '"';  i += 2; continue; }
            if (c === "'") { out += "'";  i += 2; continue; }
        }
        out += s[i];
    }
    return out;
};

const lines = nsh.split(/\r?\n/);
const start = lines.findIndex(l => l.includes('StrCpy $1 "$TEMP\\fp-uninstall-clean.ps1"'));
if (start < 0) die('installer.nsh no longer names $TEMP\\fp-uninstall-clean.ps1');
const end = lines.findIndex((l, i) => i > start && /^\s*FileClose \$2\s*$/.test(l));
if (end < 0) die('no FileClose $2 after the fp-uninstall-clean.ps1 StrCpy');

const payloads = [];
for (let i = start; i < end; i++) {
    const m = /^\s*FileWrite \$2 "(.*)"\s*$/.exec(lines[i]);
    if (m) payloads.push(unescapeNsis(m[1]));
}
const PS_TEXT = payloads.join('');
console.log(`── reconstructed fp-uninstall-clean.ps1: ${payloads.length} FileWrite lines, ` +
            `${PS_TEXT.length} bytes ──`);
ok(payloads.length > 40, 'the whole block was picked up, not a fragment',
   'only ' + payloads.length + ' FileWrite lines between the StrCpy and FileClose');
ok(!/\$\$|\$\\r|\$\\n/.test(PS_TEXT),
   'no NSIS escape survived into the reconstruction -- a leftover $$ here would ' +
   'mean this probe is checking text PowerShell never sees',
   JSON.stringify((/\$\$.{0,30}|\$\\[rn].{0,30}/.exec(PS_TEXT) || [''])[0]));

// ── what it must contain ────────────────────────────────────────────
console.log('');
console.log('── it prefers the app\'s own script, and only strips when that is gone ──');
ok(/\$geckoPs1 = \(Join-Path \$env:ProgramData 'freeproxy-vpn\\restore-gecko-prefs\.ps1'\)/
   .test(PS_TEXT),
   'it looks for restore-gecko-prefs.ps1 in the state directory');
ok(/if \(Test-Path -LiteralPath \$geckoPs1\)/.test(PS_TEXT),
   'guarded by Test-Path, so a missing file is a branch and not an error');
ok(/& \$geckoPs1/.test(PS_TEXT),
   'and RUNS it -- the same file .build/probe-containment-recovery.js proves, ' +
   'rather than a second hand-kept copy of a 70-line recovery script');
ok(PS_TEXT.indexOf('$geckoPs1') < PS_TEXT.indexOf('$fpBegin'),
   'the delegation comes first and the strip is the fallback, not the other way round');

console.log('');
console.log('── the fallback carries the same hard-won details ──');
ok(PS_TEXT.includes("$fpEndRx = 'end FreeProxy VPN[^A-Za-z0-9]*$'"),
   'the END marker is the ANCHORED regex, not a substring -- the block contains ' +
   'the words "end FreeProxy VPN" in its own prose, and a substring match stops ' +
   'four lines in and leaves network.proxy.type set');
const decoys = GeoSpoof._ffBlock({ lat: 1, lng: 2, accuracy: 40, city: 'X' },
                                 { host: '127.0.0.1', port: 9050, bypass: '' })
    .text.split(/\r?\n/)
    .filter(l => l.includes('end FreeProxy VPN') && l.trim() !== GeoSpoof.FF_END);
ok(decoys.length > 0 &&
   decoys.every(l => !/end FreeProxy VPN[^A-Za-z0-9]*$/.test(l)) &&
   /end FreeProxy VPN[^A-Za-z0-9]*$/.test(GeoSpoof.FF_END),
   'and that regex still rejects every decoy line in the shipped block while ' +
   'matching the real marker', JSON.stringify(decoys[0] || 'no decoy found'));
const absent = GeoSpoof.FF_ALL_PREFS.filter(p => !PS_TEXT.includes("'" + p + "'"));
ok(absent.length === 0,
   `all ${GeoSpoof.FF_ALL_PREFS.length} prefs from GeoSpoof.FF_ALL_PREFS are in the ` +
   'fallback list', 'absent: ' + absent.join(', '));
ok(!PS_TEXT.includes("'network.proxy.http'"),
   'and network.proxy.http is not -- this app never writes it, so an uninstall ' +
   'must not clear a corporate proxy it did not set');
ok(PS_TEXT.includes('UTF8Encoding($false)') &&
   !/Set-Content[^\r\n]*-Encoding UTF8/.test(PS_TEXT),
   'it writes UTF-8 with NO BOM -- PowerShell 5.1\'s -Encoding UTF8 prepends one, ' +
   'and a BOM on line 1 of a prefs file costs the user every pref in it');
ok(/-Recurse -Depth 4/.test(PS_TEXT), 'and walks Roaming exactly 4 deep');
ok(!/`/.test(PS_TEXT),
   'not one backtick anywhere -- through NSIS FileWrite escaping, a backtick is ' +
   'the character most likely to arrive as something else');

// ── PowerShell parses the whole reconstructed file ──────────────────
console.log('');
console.log('── PowerShell\'s own parser reads it ──');
const WHOLE = path.join(TMP, 'fp-uninstall-clean.ps1');
fs.writeFileSync(WHOLE, PS_TEXT, 'utf8');
const parseCheck = file => {
    const cmd = [
        '$e = $null; $t = $null;',
        '[void][System.Management.Automation.Language.Parser]::ParseFile(',
        "'" + file + "', [ref]$t, [ref]$e);",
        'if ($e.Count -gt 0) {',
        "  foreach ($x in $e) { 'ERR line ' + $x.Extent.StartLineNumber + ': ' + $x.Message }",
        "} else { 'PARSE-OK' }",
    ].join(' ');
    try {
        return execFileSync('powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
            { encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim();
    } catch (e) { return 'THREW: ' + (e.stdout || '') + (e.message || ''); }
};
const parsed = parseCheck(WHOLE);
ok(parsed === 'PARSE-OK',
   'no syntax errors in the file the uninstaller actually writes -- two layers of ' +
   'escaping, and nothing else in this repo ever runs it', parsed);

// ── the executable fragment, pointed away from this machine ─────────
//  Only the Firefox section is run. The hosts file and the certificate stores
//  cannot be redirected anywhere safe, so they are parsed and left alone.
const cut = PS_TEXT.indexOf('$geckoPs1 = ');
if (cut < 0) die('the reconstructed script has no $geckoPs1 assignment to cut at');
const SHIPPED = path.join(TMP, 'shipped', 'restore-gecko-prefs.ps1');
const USERS   = path.join(TMP, 'Users');
let frag = PS_TEXT.slice(cut);
const before = frag;
frag = frag.split("(Join-Path $env:ProgramData 'freeproxy-vpn\\restore-gecko-prefs.ps1')")
           .join("'" + SHIPPED + "'");
frag = frag.split("(Join-Path $env:SystemDrive 'Users')").join("'" + USERS + "'");
if (frag === before) die('neither path substitution matched -- refusing to run a ' +
                         'script still aimed at this machine');
if (/\$env:/.test(frag)) die('an $env: reference survived the substitution: ' +
                             (/\$env:\w+/.exec(frag) || [''])[0]);
const FRAG = path.join(TMP, 'gecko-frag.ps1');
const writeFrag = () => fs.writeFileSync(FRAG,
    "$ErrorActionPreference = 'SilentlyContinue'\r\n" + frag, 'utf8');
writeFrag();
ok(parseCheck(FRAG) === 'PARSE-OK', 'and the redirected fragment parses too',
   parseCheck(FRAG));

// ── and it is RUN, against profiles built here ──────────────────────
const COORD = { lat: 49.611621, lng: 6.131935, accuracy: 40, city: 'Luxembourg' };
const PROXY = { host: '127.0.0.1', port: 9050, bypass: 'example.com' };
const BLOCK = GeoSpoof._ffBlock(COORD, PROXY).text;
const HOME  = 'user_pref("browser.startup.homepage", "https://example.invalid/");';
const OWN   = 'user_pref("network.proxy.type", 4);';
const NOTIF = 'user_pref("dom.webnotifications.enabled", false);';

const profile = (user, vendor, name) => {
    const dir = path.join(USERS, user, 'AppData', 'Roaming',
                          ...vendor.split('\\'), 'Profiles', name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};
const KEEP     = profile('alice', 'Mozilla\\Firefox', 'abc.default-release');
const OURS     = profile('alice', 'LibreWolf', 'xyz.second');
const INNOCENT = profile('bob', 'Moonchild Productions\\Pale Moon', 'pm.default');
const seed = () => {
    fs.writeFileSync(path.join(KEEP, 'user.js'), HOME + '\r\n' + BLOCK + '\r\n', 'utf8');
    fs.writeFileSync(path.join(KEEP, 'prefs.js'), [
        HOME,
        'user_pref("geo.provider.network.url", "data:application/json,{\\"location\\"}");',
        'user_pref("network.proxy.type", 1);',
        'user_pref("network.proxy.socks", "127.0.0.1");',
        'user_pref("media.peerconnection.enabled", false);',
        NOTIF,
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(OURS, 'user.js'), BLOCK + '\r\n', 'utf8');
    fs.writeFileSync(path.join(INNOCENT, 'user.js'), HOME + '\r\n', 'utf8');
    fs.writeFileSync(path.join(INNOCENT, 'prefs.js'), [OWN, NOTIF].join('\n'), 'utf8');
};
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
const runFrag = () => {
    try {
        return execFileSync('powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FRAG],
            { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    } catch (e) { return 'THREW: ' + (e.stdout || '') + ' ' + (e.message || ''); }
};

console.log('');
console.log('── run 1: the app\'s script is gone, so the fallback strips ──');
seed();
const out1 = runFrag();
ok(!/THREW/.test(out1), 'it runs', out1);
ok(/stripping by hand/.test(out1),
   'and says which branch it took, rather than printing nothing either way',
   out1.trim());
ok(read(path.join(KEEP, 'user.js')).trim() === HOME,
   "the user's own user.js line survives and our whole block is gone -- not the " +
   'first four lines of it', JSON.stringify(read(path.join(KEEP, 'user.js'))));
ok(read(path.join(OURS, 'user.js')) === null,
   'a user.js that existed only because we made it is deleted, not left empty');
const kp = read(path.join(KEEP, 'prefs.js'));
ok(!kp.includes('data:application/json,') && !kp.includes('network.proxy.socks'),
   'the spoof and the SOCKS proxy are out of prefs.js, where Gecko copied them ' +
   'at its last shutdown', JSON.stringify(kp));
ok(!kp.includes('network.proxy.type'),
   'so the browser is not left aimed at a port nothing answers');
ok(!kp.includes('media.peerconnection.enabled'),
   'and WebRTC is no longer switched off by us');
ok(kp.includes(HOME) && kp.includes(NOTIF), 'every pref we never wrote is untouched');
ok(!/^\uFEFF/.test(kp), 'and prefs.js does not start with a byte-order mark');
ok(/anything you had set yourself/i.test(out1),
   'it says the user\'s own values for those prefs could NOT be put back -- the ' +
   'journal lived in the directory that is gone', out1.trim());
ok(read(path.join(INNOCENT, 'user.js')) === HOME + '\r\n' &&
   read(path.join(INNOCENT, 'prefs.js')) === [OWN, NOTIF].join('\n'),
   'a profile this app never touched is byte-identical, manual proxy included',
   JSON.stringify(read(path.join(INNOCENT, 'prefs.js'))));

console.log('');
console.log('── run 2: nothing left to strip ──');
const out2 = runFrag();
ok(/nothing found/.test(out2), 'it reports nothing found rather than work it did not do',
   out2.trim());
ok(read(path.join(KEEP, 'prefs.js')) === kp, 'and prefs.js is byte-identical');

console.log('');
console.log('── run 3: the app\'s script IS there, so that one runs instead ──');
//  A stub, not the real recovery script: the real one defaults -UsersRoot to
//  this machine's C:\Users, and running it here would rewrite the developer's
//  own Firefox. What has to be proved is that the branch executes the file it
//  finds and does not also strip -- so the stub leaves a sentinel and the seeded
//  block is expected to survive.
seed();
const SENTINEL = path.join(TMP, 'delegated.txt');
fs.mkdirSync(path.dirname(SHIPPED), { recursive: true });
fs.writeFileSync(SHIPPED,
    "Set-Content -LiteralPath '" + SENTINEL + "' -Value 'ran'\r\n" +
    "Write-Host '  (stub recovery script)'\r\n", 'utf8');
const out3 = runFrag();
ok(!/THREW/.test(out3), 'it runs', out3);
ok(fs.existsSync(SENTINEL),
   'the app\'s own restore-gecko-prefs.ps1 is what got executed', out3.trim());
ok(/running the app's own recovery script/.test(out3),
   'and the log says so', out3.trim());
ok(!/stripping by hand/.test(out3),
   'the fallback does NOT also run -- two writers over one user.js is how a ' +
   'half-stripped file happens');
ok(read(path.join(KEEP, 'user.js')).includes('FreeProxy VPN'),
   'proof it was the stub and not the fallback: the seeded block is still there');

console.log('');
console.log(`${pass}/${pass + fail} checks passed` + (fail ? `  (${fail} FAILED)` : ''));
process.exit(fail ? 1 : 0);





'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-installer-nsh.js  --  installer.nsh, checked the only two ways
//  it can be checked without running a real uninstall.
//
//  1. STATIC. The things that would be silently wrong forever: the fake
//     force-install id must not come back as a WriteRegStr, the exit codes
//     branched on must be the ones lib/installer-tasks.js actually returns,
//     the firewall rule names must match FW_RULES byte for byte, the hosts
//     marker must match the string main.js writes, and no line may exceed the
//     1024-character NSIS string limit.
//
//  2. BEHAVIOURAL. The two PowerShell scripts are not in a .ps1 file to lint:
//     they are built at run time out of FileWrite lines, where one missing
//     `$$` turns a variable into an NSIS constant and the sweep quietly does
//     nothing. So this rebuilds them exactly as NSIS would, parses them with
//     PowerShell's own parser, and then RUNS the registry sweep against a
//     throwaway HKCU hive with the root string swapped -- the same way
//     test-geo-forcelist.js redirects POLICY_KEYS. Every assertion reads the
//     registry back afterwards; none of them trusts an exit code.
//
//  The sweep must be right in both directions, which is why the foreign
//  entries are here: a workplace ExtensionInstallForcelist is how required
//  extensions get deployed, and an uninstaller that clears it is an outage.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const NSH = path.join(__dirname, '..', 'installer.nsh');
const src = fs.readFileSync(NSH, 'utf8');
const lines = src.split('\n');

const tasks = require('../lib/installer-tasks');
//  The sandbox root ends in \Policies on purpose: the sweep skips anything
//  under \Policies\Microsoft\Windows, and that guard can only be exercised if
//  the redirected paths have the same shape as the real ones.
const TEST_ROOT = 'HKCU\\SOFTWARE\\FreeProxyNshTest\\Policies';
const PS_ROOT = 'HKCU:\\SOFTWARE\\FreeProxyNshTest\\Policies';
const TEST_HIVE = 'HKCU\\SOFTWARE\\FreeProxyNshTest';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpnsh-'));

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const sh = c => { try { return execSync(c, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }); }
                  catch (e) { return null; } };

//  NSIS unescaping, in one pass so `$$\r` cannot be read as an escape.
const unescape = s => s.replace(/\$(\$|\\r|\\n|\\t|\\"|\\')/g, (m, g) => (
    { '$': '$', '\\r': '\r', '\\n': '\n', '\\t': '\t', '\\"': '"', "\\'": "'" }[g]));

//  Rebuild every heredoc-style script the macro writes: StrCpy names it,
//  FileWrite fills it, FileClose ends it.
const scripts = {};
{
    let cur = null;
    for (const raw of lines) {
        const t = raw.trim();
        let m = t.match(/^StrCpy \$1 "\$TEMP\\([\w.-]+)\.ps1"$/);
        if (m) { cur = m[1]; scripts[cur] = ''; continue; }
        m = t.match(/^FileWrite \$2 "(.*)"$/);
        if (m && cur) { scripts[cur] += unescape(m[1]); continue; }
        if (t === 'FileClose $2') cur = null;
    }
    //  fp-uninstall-sweep -> sweep, fp-uninstall-clean -> clean
    for (const k of Object.keys(scripts)) scripts[k.replace(/^fp-uninstall-/, '')] = scripts[k];
}

console.log('── static: shape ──');
ok(!src.includes('\r'), 'file is LF-only (electron-builder reads it verbatim)');
ok((src.match(/^!macro /gm) || []).length === 2 &&
   (src.match(/^!macroend/gm) || []).length === 2, 'both macros open and close');
ok(/^!macro customInstall$/m.test(src) && /^!macro customUnInstall$/m.test(src),
   'the two macro names electron-builder looks for are present');
{
    const over = lines.map((l, i) => [i + 1, l.length]).filter(([, n]) => n > 1000);
    ok(!over.length, 'no line near the 1024-char NSIS string limit',
       JSON.stringify(over));
}
ok(!/PLACEHOLDER/.test(src), 'no placeholder left behind');

console.log('\n── static: the fake force-install is gone ──');
{
    //  The whole reason this file was rewritten. The id may appear only as
    //  prose in the header and as the signature the sweep MATCHES ON -- never
    //  as something written to a forcelist. The signature is now built in two
    //  steps in the generated PowerShell ($fid, then $fake = $fid + ';'), so
    //  both halves of that assignment are the allowed form.
    const fake = tasks.LEGACY_FAKE_ID;
    const hits = lines
        .map((l, i) => [i + 1, l])
        .filter(([, l]) => l.includes(fake))
        .filter(([, l]) => !/^\s*;/.test(l) &&
                           !/\$\$fake\s*=/.test(l) && !/\$\$fid\s*=/.test(l));
    ok(!hits.length, 'legacy id appears only in comments and in the match signature',
       JSON.stringify(hits));
    ok(!/WriteRegStr[^\n]*ExtensionInstallForcelist/i.test(src),
       'nothing writes an ExtensionInstallForcelist value from NSIS');
    ok(!/DeleteRegValue[^\n]*ExtensionInstallForcelist/i.test(src),
       'nothing deletes a forcelist slot BY NUMBER from NSIS');
    ok(!/Policies\\(Google|Microsoft\\Edge|BraveSoftware)/.test(src),
       'no browser-specific policy path is hardcoded in NSIS');
}

console.log('\n── static: the exe does the real work ──');
//  $4 rather than nothing after the flag: customInstall appends Windows' own
//  pending-reboot verdict (` --fp-reboot-pending`) so --fp-setup can decide
//  whether to leave a restart marker. .build/test-restart-marker.js owns that
//  behaviour; what matters here is that the exe is what runs, and that $0
//  catches its exit code so the installer can branch on it.
ok(/ExecWait '"\$INSTDIR\\FreeProxy VPN\.exe" --fp-setup\$4' \$0/.test(src),
   'customInstall runs --fp-setup (with the reboot flag) and captures the exit code');
ok(/ExecWait '"\$INSTDIR\\FreeProxy VPN\.exe" --fp-teardown' \$0/.test(src),
   'customUnInstall runs --fp-teardown and captures the exit code');
ok(/\$\{If\} \$\{FileExists\} "\$INSTDIR\\FreeProxy VPN\.exe"/.test(src),
   'the teardown call is guarded -- program files may already be gone');
for (const [name, code] of [['ok', tasks.EXIT.ok], ['manual', tasks.EXIT.manual],
                            ['timedOut', tasks.EXIT.timedOut]]) {
    ok(new RegExp(`\\$0 == ${code}\\b`).test(src),
       `installer branches on EXIT.${name} (${code})`);
}

console.log('\n── static: agreement with the code, not a second copy of it ──');
for (const rule of tasks.FW_RULES) {
    ok(src.includes(`netsh advfirewall firewall delete rule name="${rule}"`),
       `firewall rule removed by exact name: ${rule}`);
}
{
    //  A rule name that drifts by one character is a rule that stays in the
    //  profile forever, and the lfsvc shield staying behind means Windows
    //  location resolution is still broken after the app is gone.
    const deletes = (src.match(/firewall delete rule name="([^"]+)"/g) || [])
        .map(s => s.replace(/^.*name="/, '').replace(/"$/, ''));
    const stray = deletes.filter(n => !tasks.FW_RULES.includes(n));
    ok(!stray.length, 'no firewall rule is deleted that the app never created',
       JSON.stringify(stray));
}
{
    const sub = tasks.PROXY_KEY.replace(/^HKCU\\/, '');
    ok(src.includes(`HKCU "${sub}" "ProxyEnable" 0`),
       'system proxy switched off at the same key lib/installer-tasks.js uses');
    ok(src.includes(`DeleteRegValue HKCU "${sub}" "ProxyServer"`),
       'ProxyServer deleted, not blanked');
}
{
    const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const open = 'FreeProxy VPN -- location spoof block';
    const close = 'FreeProxy VPN end';
    ok(mainJs.includes(open) && mainJs.includes(close), 'main.js writes those markers');
    ok(scripts.clean && scripts.clean.includes(open) && scripts.clean.includes(close),
       'the fallback hosts strip matches those same markers');
}
ok(/RMDir \/r "C:\\ProgramData\\freeproxy-vpn"/.test(src),
   'the real state directory is deleted (userData override in main.js)');
ok(/RMDir \/r "\$LOCALAPPDATA\\FreeProxy VPN"/.test(src),
   'the log/Tor tree is deleted');
//  The requirement was "delete what you created", so there must be no prompt
//  offering to KEEP any of it. It is not a ban on MB_YESNO as such: the
//  uninstaller now asks one question, and it asks it only on exit code 11 --
//  restart to finish evicting the extension from browsers that are open. So the
//  test is what each MB_YESNO is ABOUT, which is what the requirement was about.
{
    //  Real statements only -- two of the MB_YESNO mentions in this file are
    //  comments explaining why the one question is asked the way it is.
    const asks = (src.match(/MessageBox\s+MB_YESNO[\s\S]{0,1500}?IDNO/g) || [])
        .map(s => s.replace(/\$\\r|\$\\n/g, ' '));
    const keepish = asks.filter(a => /\b(keep|retain|preserve)\b/i.test(a) ||
                                     /remove all|your data|settings\?/i.test(a));
    ok(keepish.length === 0,
       'no "keep your data?" prompt -- deleting what it created was the requirement',
       keepish.join(' || ').slice(0, 200));
    ok(asks.length === 1 && /Restart this PC now/.test(asks[0]),
       'the one question it does ask is the restart that finishes the revert',
       `${asks.length} MB_YESNO statement(s)`);
    ok(/\$\{IfNot\} \$\{Silent\}[\s\S]{0,120}\$5 == 11/.test(src),
       'and it is asked only when teardown really found a browser open, never in /S');
}
ok(/taskkill \/F \/IM "FreeProxy VPN\.exe"/.test(src) &&
   src.indexOf('taskkill /F /IM "FreeProxy VPN.exe"') < src.indexOf('taskkill /F /IM tor.exe'),
   'the app is killed before tor.exe, so it cannot rewrite the proxy on the way out');

console.log('\n── the generated PowerShell: escaping ──');
ok(!!scripts.sweep && !!scripts.clean, 'both scripts are assembled from FileWrite',
   JSON.stringify(Object.keys(scripts)));
{
    //  One `$` that is not `$$` and not an NSIS escape is a PowerShell
    //  variable NSIS eats before the file is ever written. That failure is
    //  invisible: the script still runs, it just sweeps nothing.
    const bad = [];
    lines.forEach((l, i) => {
        const m = l.trim().match(/^FileWrite \$2 "(.*)"$/);
        if (!m) return;
        //  Consume the legal escapes as UNITS first. Scanning for `$` not
        //  followed by `$` finds the second half of every `$$` instead.
        const left = m[1].replace(/\$(?:\$|\\r|\\n|\\t|\\"|\\')/g, '');
        if (left.includes('$')) bad.push(i + 1 + ': ' + l.trim());
    });
    ok(!bad.length, 'every PowerShell $ inside FileWrite is written $$', JSON.stringify(bad));
}
for (const k of ['sweep', 'clean']) {
    const f = path.join(TMP, k + '.ps1');
    fs.writeFileSync(f, scripts[k], 'utf8');
    const chk = path.join(TMP, 'parse.ps1');
    fs.writeFileSync(chk,
        '$e = $null\n' +
        '[void][System.Management.Automation.Language.Parser]::ParseFile(' +
        '$args[0], [ref]$null, [ref]$e)\n' +
        'if ($e -and $e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }\n' +
        'exit 0\n', 'utf8');
    const out = sh(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass ` +
                   `-File "${chk}" "${f}"`);
    ok(out !== null, `${k}.ps1 parses with PowerShell's own parser`, String(out).trim());
}

console.log('\n── the registry sweep, run for real against a throwaway hive ──');
const FL = 'ExtensionInstallForcelist';
const OURS = 'abcdefghijklmnopabcdefghijklmnop;http://127.0.0.1:8081/updates.xml';
const FAKE = tasks.LEGACY_FAKE_ID + ';https://clients2.google.com/service/update2/crx';
const FOREIGN = 'cjpalhdlnbpafiamejdnhcphjbkeiagm;https://clients2.google.com/service/update2/crx';

function values(key) {
    const out = sh(`reg query "${key}"`);
    if (!out) return null;
    const v = {};
    for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s{4}(\S+)\s+REG_(?:SZ|DWORD)\s+(.*)$/);
        if (m && m[1] !== '(Default)') v[m[1]] = m[2].trim();
    }
    return v;
}

const EDGE = `${TEST_ROOT}\\Microsoft\\Edge\\${FL}`;
const VIV = `${TEST_ROOT}\\Vivaldi\\${FL}`;
const CHR = `${TEST_ROOT}\\Chromium`;
const GEO = `${CHR}\\GeolocationBlockedForUrls`;
const WIN = `${TEST_ROOT}\\Microsoft\\Windows\\CurrentVersion`;

sh(`reg delete "${TEST_HIVE}" /f`);
//  Edge: a foreign entry, ours, and the fake one an older installer wrote.
sh(`reg add "${EDGE}" /f`);
sh(`reg add "${EDGE}" /v "1" /t REG_SZ /d "${FOREIGN}" /f`);
sh(`reg add "${EDGE}" /v "2" /t REG_SZ /d "${OURS}" /f`);
sh(`reg add "${EDGE}" /v "3" /t REG_SZ /d "${FAKE}" /f`);
//  Vivaldi: ours alone, so the subkey itself must go -- past the (Default)
//  value `reg add <key> /f` leaves behind.
sh(`reg add "${VIV}" /v "1" /t REG_SZ /d "${OURS}" /f`);
//  Chromium: two of the app's policy values plus one that is not the app's.
sh(`reg add "${CHR}" /v "ProxySettings" /t REG_SZ /d "{}" /f`);
sh(`reg add "${CHR}" /v "WebRtcIPHandlingPolicy" /t REG_SZ /d "disable_non_proxied_udp" /f`);
sh(`reg add "${CHR}" /v "HomepageLocation" /t REG_SZ /d "https://example.com" /f`);
sh(`reg add "${GEO}" /v "1" /t REG_SZ /d "*" /f`);
//  Windows' own policy branch, holding a value with one of the same names.
sh(`reg add "${WIN}" /v "ProxySettings" /t REG_SZ /d "keep-me" /f`);

ok(values(EDGE) && Object.keys(values(EDGE)).length === 3, 'hive staged: 3 Edge entries');
ok(values(WIN) && values(WIN).ProxySettings === 'keep-me', 'hive staged: Windows branch');

{
    //  EVERY occurrence, not the first: the sweep walks that root more than once
    //  now (one pass per policy shape), and a single .replace() left the second
    //  loop pointed at the real hive -- which the guard below caught, correctly,
    //  by refusing to run at all.
    const ROOT = "'HKLM:\\Software\\Policies'";
    const sweepSrc = scripts.sweep.split(ROOT).join(`'${PS_ROOT}'`);
    //  Hard stop, not a failed assertion: running the real thing against real
    //  policy would be the exact outage this test exists to prevent.
    if (sweepSrc === scripts.sweep || /HKLM/i.test(sweepSrc)) {
        console.log('ABORT: could not redirect the sweep root -- refusing to run it');
        sh(`reg delete "${TEST_HIVE}" /f`);
        process.exit(3);
    }
    ok(scripts.sweep.split(ROOT).length - 1 >= 1,
       `every walk of the policy root was redirected (${scripts.sweep.split(ROOT).length - 1})`);
    const f = path.join(TMP, 'sweep-sandboxed.ps1');
    fs.writeFileSync(f, sweepSrc, 'utf8');
    const out = sh(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${f}"`);
    ok(out !== null, 'sandboxed sweep ran', String(out).trim());
    if (out) for (const l of out.split(/\r?\n/).filter(Boolean)) console.log('   ps: ' + l);
}

const edge = values(EDGE);
ok(edge && edge['1'] === FOREIGN, "a workplace forcelist entry survives", JSON.stringify(edge));
ok(edge && edge['2'] === undefined, 'our loopback entry is removed');
ok(edge && edge['3'] === undefined, 'the legacy fake id is removed');
ok(edge && Object.keys(edge).length === 1, 'nothing else in that key was touched',
   JSON.stringify(edge));
ok(values(VIV) === null, 'a forcelist key holding only our entry is deleted');
ok(values(`${TEST_ROOT}\\Vivaldi`) !== null, 'its parent browser key is left alone');

const chr = values(CHR);
ok(chr && chr.ProxySettings === undefined, 'ProxySettings policy removed');
ok(chr && chr.WebRtcIPHandlingPolicy === undefined, 'WebRtcIPHandlingPolicy policy removed');
ok(chr && chr.HomepageLocation === 'https://example.com',
   'a policy this app never wrote survives', JSON.stringify(chr));
ok(values(GEO) === null, 'GeolocationBlockedForUrls subkey removed outright');
ok(values(WIN) && values(WIN).ProxySettings === 'keep-me',
   'Policies\\Microsoft\\Windows is skipped, same name or not');

sh(`reg delete "${TEST_HIVE}" /f`);
ok(sh(`reg query "${TEST_HIVE}"`) === null, 'test hive removed');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);

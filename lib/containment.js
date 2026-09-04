'use strict';
//  ════════════════════════════════════════════════════════════════════════════
//  CONTAINMENT  --  default-deny outbound, so nothing on this machine reaches
//                   the internet except through the tunnel
//
//  WHAT THIS IS FOR
//  ----------------
//  Up to v2.0.0 this app was not a whole-machine VPN and did not claim to be
//  one honestly enough. It set a WinINET proxy (which only proxy-aware Windows
//  apps consult), a Chromium policy, and an extension pref. Anything that
//  ignored all three -- a game, an installer, a mail client, a stub resolver
//  with its own hardcoded DNS -- went straight out over the real IP. The only
//  block rules that existed anywhere were for DNS (53/853) and IPv6.
//
//  This module closes that. `blockinbound,blockoutbound` on all three profiles
//  means the Windows Filtering Platform drops every outbound packet that no
//  ALLOW rule matches, for every process, whether it knows what a proxy is or
//  not. The allow list is deliberately tiny: tor.exe, lyrebird.exe, this app,
//  the TUN adapter, loopback and DHCP.
//
//  WHAT IT COSTS, STATED PLAINLY
//  -----------------------------
//    * While armed, UDP to the internet is dead. Tor's SOCKS5 has no UDP
//      ASSOCIATE, so QUIC, WebRTC, most games and most VoIP stop working.
//      They do not degrade -- they stop. That is the honest price of "nothing
//      leaves outside the tunnel".
//    * LAN reachability is off unless allowLan is passed. Printers and NAS
//      boxes go quiet.
//    * If this process dies while armed, the machine has NO internet until
//      something disarms it. That is why enable() refuses to run until the
//      standalone recovery script exists on disk (see writeRecovery), why the
//      app restores the policy at every startup, and why disable() is also
//      wired to will-quit and to the kill-switch-off path.
//
//  WHAT IT CANNOT DO
//  -----------------
//    * It cannot work if the Windows Firewall service is off, or if a domain
//      GPO owns the policy. Both are detected and reported as a REFUSAL, not
//      papered over -- status() reads the policy back out of netsh every time.
//    * It is not a substitute for the TUN layer. Default-deny stops leaks;
//      it does not make a proxy-unaware app's TCP go through Tor. That is
//      lib/tunnel.js's job. The two are complementary and both are needed.
//  ════════════════════════════════════════════════════════════════════════════

const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');

//  For FF_ALL_PREFS and nothing else: the exact list of Firefox-family prefs the
//  app writes, so the recovery script below removes precisely those and no
//  others. Same rule as ALLOW_RULES -- one spelling, in one place. A pref name
//  that lived in geo-spoof.js but not here would be left set on a machine where
//  this app is gone, pointing a browser at a dead SOCKS port forever.
//
//  Safe to require: lib/geo-spoof.js pulls in fs, path, child_process and
//  lib/browsers.js, none of which reach back here, and nothing in either runs at
//  load time beyond building static tables.
const { GeoSpoof } = require('./geo-spoof.js');

//  Every rule name this module owns. Kept in one exported list because three
//  other places have to delete exactly these on uninstall: FW_RULES in
//  lib/installer-tasks.js, the customUnInstall block in installer.nsh, and the
//  recovery script written below. A name that exists in one list and not the
//  others is how a machine ends up permanently firewalled by an app that is no
//  longer installed.
const ALLOW_RULES = {
    tor:       'FreeProxy Allow Tor Engine',
    lyrebird:  'FreeProxy Allow Bridge Transport',
    app:       'FreeProxy Allow App',
    tun2socks: 'FreeProxy Allow Tunnel Engine',
    loopback:  'FreeProxy Allow Loopback',
    dhcp:      'FreeProxy Allow DHCP',
    tun:       'FreeProxy Allow Tunnel Adapter',
    lan:       'FreeProxy Allow Local Subnet',
};
const RULE_NAMES = Object.values(ALLOW_RULES);

//  The Start Menu entry for the recovery script below. main.js writes it (the
//  target has to exist before the shortcut does, and the target is generated at
//  runtime); lib/installer-tasks.js and installer.nsh delete it, by this exact
//  file name, from the all-users Start Menu. Same rule as the firewall names
//  above: one spelling, in one place.
const RECOVERY_LNK = 'Restore Internet (FreeProxy VPN).lnk';

//  Exported at the BOTTOM of this file: `class` bindings sit in a temporal dead
//  zone until their declaration is evaluated, so exporting Containment up here
//  throws ReferenceError at require() time.

//  ── One process runner, so every command in here is argv-based ──
//  Never a shell string: the paths involved contain spaces ("C:\Program
//  Files\...", "C:\Users\User pc\...") and this module runs elevated. execFile
//  hands the arguments to CreateProcess as an array, so nothing in a path can
//  be read as a separator or a second command.
function run(exe, args, timeout = 30000) {
    return new Promise(resolve => {
        execFile(exe, args, { windowsHide: true, timeout, encoding: 'utf8' },
                 (err, stdout, stderr) => {
            resolve({
                ok: !err,
                code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
                out: String(stdout || '') + String(stderr || ''),
                err: err ? String(err.message).split('\n')[0] : null,
            });
        });
    });
}

const netsh = (args, t) => run('netsh.exe', args, t);

class Containment {
    //  torExe / appExe / lyrebirdExe are absolute paths to the executables that
    //  must keep their outbound reach while armed. They are the RUNNING paths,
    //  not the installed ones -- see the note on verifyAllowPaths().
    constructor({ Logger, stateDir, torExe, appExe, lyrebirdExe, tun2socksExe }) {
        this.log         = Logger;
        this.stateDir    = stateDir;
        this.torExe      = torExe || '';
        this.appExe      = appExe || process.execPath;
        this.lyrebirdExe = lyrebirdExe || '';
        this.tun2socksExe = tun2socksExe || '';
        this.recoveryBat = path.join(stateDir, 'restore-internet.bat');
        //  The Gecko half of the recovery, as its own file. A .bat cannot hold
        //  fifteen lines of PowerShell without the quoting becoming the most
        //  likely thing to fail in the one script that has to work when
        //  everything else has already failed.
        this.recoveryGeckoPs1 = path.join(stateDir, 'restore-gecko-prefs.ps1');
        this._armed      = false;
    }

    get armed() { return this._armed; }

    //  ── What Windows actually has right now ──
    //  Parsed out of netsh rather than remembered, because the interesting
    //  cases are all ones where our memory would be wrong: a GPO refresh, a
    //  second admin, a crash that left the policy armed, a firewall service
    //  someone turned off. Returns one entry per profile.
    async status() {
        const r = await netsh(['advfirewall', 'show', 'allprofiles'], 20000);
        if (!r.ok) return { ok: false, reason: r.err || 'netsh failed', profiles: [] };
        const profiles = [];
        let cur = null;
        for (const line of r.out.split(/\r?\n/)) {
            const head = /^(Domain|Private|Public) Profile Settings:/i.exec(line);
            if (head) { cur = { profile: head[1].toLowerCase(), state: null, policy: null };
                        profiles.push(cur); continue; }
            if (!cur) continue;
            const st = /^State\s+(\S+)/i.exec(line);
            if (st) { cur.state = st[1].toUpperCase(); continue; }
            const po = /^Firewall Policy\s+(\S+)/i.exec(line);
            if (po) { cur.policy = po[1]; }
        }
        const blocked = profiles.length === 3 &&
                        profiles.every(p => /BlockOutbound/i.test(p.policy || ''));
        const allOn   = profiles.every(p => p.state === 'ON');
        return { ok: true, profiles, outboundBlocked: blocked, firewallOn: allOn };
    }

    //  ── The Gecko half of the way out ──
    //
    //  Firefox and its forks do not read the system proxy when this app has
    //  written user.js: network.proxy.type is 1, pointing at 127.0.0.1:9050.
    //  Every step above puts Windows back, and none of them touches that -- so
    //  on a PC where this app is gone, a Gecko browser is the one thing still
    //  sending every request to a port nothing answers. "Restore Internet" that
    //  leaves Firefox unable to load a page has not restored the internet.
    //
    //  Its own .ps1 rather than a line inside the .bat: this is fifteen lines of
    //  PowerShell, and folded into `powershell -Command "..."` the quoting would
    //  be the most likely thing to fail in the one script that has to work when
    //  everything else already has.
    //
    //  It prefers the journal -- the same geo-restore.json the app writes before
    //  its first edit -- so a user's own network.proxy.* values come back
    //  verbatim. Without one it strips our block and our pref lines, which
    //  leaves Gecko's defaults: a working browser, and the honest limit of what
    //  can be recovered with no record of what was there before. The script says
    //  which of the two it did.
    //
    //  One deliberate divergence from restoreFirefox(): that function rewrites
    //  user.js from the journal's `prior` snapshot, this one strips our fenced
    //  block out of whatever is there now. The result is the same file unless the
    //  user has hand-edited user.js since we wrote it -- in which case stripping
    //  keeps their edit and replaying `prior` would silently discard it. In a
    //  recovery script, losing none of the user's text matters more than matching
    //  the app byte for byte.
    _geckoRecoveryPs1() {
        //  ASCII only, matched as a substring. The real fence line contains
        //  U+2500 box-drawing characters, and this file is read by a shell whose
        //  codepage would mangle them.
        return [
            '# FreeProxy VPN -- undo the Gecko (Firefox family) proxy and geolocation',
            '# prefs this app writes while connected. Safe to run at any time: with the',
            '# app gone it is the only thing that clears them, and with nothing to clear',
            '# it prints "nothing found" and exits 0.',
            '',
            '# Two parameters, both defaulted to the real thing, so restore-internet.bat',
            '# calls this with no arguments at all. They exist because a recovery script',
            '# that cannot be pointed at a fake tree cannot be TESTED -- and an untested',
            '# recovery script is the one that fails on the day it is needed.',
            '# .build/probe-containment-recovery.js runs this file for real against',
            '# profiles it builds in the temp directory, which is only possible because',
            '# of these two.',
            'param(',
            '  [string]$UsersRoot = (Join-Path $env:SystemDrive "Users"),',
            '  [string]$Journal   = (Join-Path $env:ProgramData "freeproxy-vpn\\geo-restore.json")',
            ')',
            '$ErrorActionPreference = "Continue"',
            '$BEGIN = "FreeProxy VPN:"',
            '# The END marker is matched by ANCHORED REGEX, and that is not fussiness.',
            '# The block itself contains the words end FreeProxy VPN inside the sentence',
            '# that tells a user which lines to delete by hand -- so a plain substring',
            '# match stops FOUR LINES INTO THE BLOCK and leaves every pref below it,',
            '# including network.proxy.type, in the file. That is the half-repair this',
            '# script exists to prevent, and it is what the first draft of it did.',
            '# geo-spoof.js is immune because it compares the whole line for equality;',
            '# this cannot, because the real marker is fenced with U+2500 characters and',
            '# the shell that runs this script has an OEM codepage that mangles them.',
            "$ENDRX = 'end FreeProxy VPN[^A-Za-z0-9]*$'",
            '# UTF-8 with NO byte-order mark, and the line endings each file already',
            '# uses: CRLF for user.js, LF for prefs.js, exactly as lib/geo-spoof.js',
            '# writes them. Set-Content -Encoding UTF8 in PowerShell 5.1 PREPENDS a',
            '# BOM, and a BOM on line 1 of a Gecko prefs file is a parse error that',
            '# would cost the user every pref in it -- a far worse outcome than the',
            '# proxy setting this script came to remove.',
            '$enc = New-Object System.Text.UTF8Encoding($false)',
            '# Every pref this app writes, and nothing else. A pref it never wrote --',
            '# network.proxy.http, say -- must survive this untouched.',
            '$OURS = @(' + GeoSpoof.FF_ALL_PREFS.map(p => "'" + p + "'").join(',') + ')',
            '',
            '# The journal, if this machine still has one. Keyed by profile directory,',
            '# and ALSO by the profile directory NAME on its own -- see the lookup below',
            '# for why one key is not enough.',
            '$prior = @{}',
            '$leafCount = @{}',
            '$leafPrior = @{}',
            '$jf = $Journal',
            '$fromJournal = $false',
            'if (Test-Path -LiteralPath $jf) {',
            '  try {',
            '    $j = Get-Content -LiteralPath $jf -Raw -ErrorAction Stop | ConvertFrom-Json',
            '    foreach ($r in @($j.firefox)) {',
            '      if ($r.dir -and $r.priorPrefs) {',
            '        $d = [string]$r.dir',
            '        $prior[$d.ToLower()] = @($r.priorPrefs)',
            '        $lf = ([System.IO.Path]::GetFileName($d)).ToLower()',
            '        $leafCount[$lf] = 1 + [int]$leafCount[$lf]',
            '        $leafPrior[$lf] = @($r.priorPrefs)',
            '      }',
            '    }',
            '    $fromJournal = $true',
            '  } catch { Write-Host "  (the restore journal could not be read: $($_.Exception.Message))" }',
            '}',
            '',
            '# Every user profile on the PC, not just this one: the .bat self-elevates',
            '# with Start-Process -Verb RunAs, so the APPDATA of the process running this',
            '# can belong to a different account than the one whose browser is broken.',
            '$roots = @($UsersRoot)',
            '$hits = @()',
            'foreach ($root in $roots) {',
            '  if (-not (Test-Path -LiteralPath $root)) { continue }',
            '  foreach ($u in Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue) {',
            '    $ad = Join-Path $u.FullName "AppData\\Roaming"',
            '    if (-not (Test-Path -LiteralPath $ad)) { continue }',
            '    # Depth 4 reaches Mozilla\\Firefox\\Profiles\\<p>\\user.js and',
            '    # "Moonchild Productions\\Pale Moon\\Profiles\\<p>\\user.js" alike, and',
            '    # stops well short of walking the whole of Roaming.',
            '    $hits += @(Get-ChildItem -LiteralPath $ad -Filter "user.js" -File -Recurse -Depth 4 -ErrorAction SilentlyContinue)',
            '  }',
            '}',
            '',
            '$fixed = 0',
            'foreach ($f in $hits) {',
            '  $text = ""',
            '  try { $text = Get-Content -LiteralPath $f.FullName -Raw -ErrorAction Stop } catch { continue }',
            '  if ($text -notlike "*$BEGIN*") { continue }',
            '  # Strip our fenced block, keeping every line the user wrote themselves.',
            '  $keep = New-Object System.Collections.ArrayList',
            '  $inside = $false',
            '  foreach ($line in ($text -split "`r?`n")) {',
            '    if (-not $inside -and $line.Trim().StartsWith("//") -and $line -like "*$BEGIN*") { $inside = $true; continue }',
            '    if ($inside) { if ($line -match $ENDRX) { $inside = $false }; continue }',
            '    [void]$keep.Add($line)',
            '  }',
            '  $rest = ($keep -join "`r`n").Trim()',
            '  if ($rest.Length -gt 0) { [System.IO.File]::WriteAllText($f.FullName, $rest + "`r`n", $enc) }',
            '  else { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue }',
            '',
            '  # ...and prefs.js, where Gecko copied those same values at its last',
            '  # shutdown. Removing user.js alone would leave the browser proxied.',
            '  $dir = Split-Path -Parent $f.FullName',
            '  $pj  = Join-Path $dir "prefs.js"',
            '  if (Test-Path -LiteralPath $pj) {',
            '    try {',
            '      $lines = @(Get-Content -LiteralPath $pj -ErrorAction Stop)',
            '      $out = @($lines | Where-Object { $l = $_; -not ($OURS | Where-Object { $l -like ("*""" + $_ + """*") }) })',
            '      $back = $prior[$dir.ToLower()]',
            '      if (-not $back) {',
            '        # The journal records the directory as the APP saw it; this script',
            '        # enumerates from a root it was HANDED. Two strings can name the same',
            '        # folder and not match: an 8.3 short name in the prefix (measured --',
            '        # %TEMP% is C:\\Users\\USERPC~1\\... on the machine this was written on',
            '        # while enumeration returns C:\\Users\\User pc\\...), a mapped drive, a',
            '        # redirected AppData. Miss the lookup and the user silently gets the',
            '        # no-journal outcome while this script prints that it restored them.',
            '        # So fall back to the profile folder NAME, which Gecko salts',
            '        # (abc.default-release) -- but only when it is unique in the journal.',
            '        # Two profiles sharing a name would otherwise be handed each other\'s',
            '        # values, and a wrong pref is worse than a missing one.',
            '        $lf = ([System.IO.Path]::GetFileName($dir)).ToLower()',
            '        if ($leafCount[$lf] -eq 1) { $back = $leafPrior[$lf] }',
            '      }',
            '      if ($back) { $out += @($back) }',
            '      [System.IO.File]::WriteAllText($pj, (($out) -join "`n"), $enc)',
            '    } catch { Write-Host "  (could not rewrite $pj : $($_.Exception.Message))" }',
            '  }',
            '  $fixed++',
            '  Write-Host "  cleared $dir"',
            '}',
            '',
            'if ($fixed -eq 0) { Write-Host "  nothing found -- no Firefox-family profile was carrying this app\'s prefs" }',
            'elseif ($fromJournal) { Write-Host "  $fixed profile(s): our prefs removed and your own values put back from the restore journal" }',
            'else { Write-Host "  $fixed profile(s): our prefs removed. There was no restore journal, so anything you had set for those same prefs is back to the browser default." }',
            'exit 0',
        ].join('\r\n');
    }

    //  ── The way out, written BEFORE the door is locked ──
    //  A standalone .bat, because the recovery case is precisely the one where
    //  this app is not running: it crashed, it was killed, it was uninstalled
    //  while armed. Nothing in here depends on Electron, on Node, or on the
    //  install directory still existing. It self-elevates, because a user who
    //  has just lost all internet should not also have to know to right-click.
    writeRecovery() {
        const del = RULE_NAMES.concat([
            //  The block rules from main.js and lib/geo-spoof.js. Leaving these
            //  behind is worse than leaving an allow rule behind: a machine with
            //  "block DNS to anywhere but 127.0.0.1" and no Tor listening cannot
            //  resolve a single hostname, and nothing in the Windows network
            //  dialogs explains why.
            'FreeProxy Block DNS Out UDP', 'FreeProxy Block DNS Out TCP',
            'FreeProxy Block DNS Out', 'FreeProxy Block DoT Out',
            'FreeProxy Block IPv6 Out', 'FreeProxy Block IPv6 In',
            'FreeProxy VPN - block Windows location resolution',
        ]).map(n => `netsh advfirewall firewall delete rule name="${n}" >nul 2>&1`);

        const lines = [
            '@echo off',
            'setlocal',
            'title Restore Internet - FreeProxy VPN',
            'echo ============================================================',
            'echo  FreeProxy VPN  --  Restore Internet',
            'echo ============================================================',
            'echo.',
            //  Self-elevate. `net session` succeeds only for an elevated token.
            'net session >nul 2>&1',
            'if %errorlevel% neq 0 (',
            '  echo Administrator rights are required. Asking for them now...',
            '  powershell -NoProfile -ExecutionPolicy Bypass -Command ' +
                '"Start-Process -FilePath \'%~f0\' -Verb RunAs"',
            '  exit /b 0',
            ')',
            'echo [1/7] Stopping anything this app left running...',
            //  FIRST, and not optional. tun2socks.exe owns the Wintun adapter
            //  that holds the two /1 capture routes; while it lives, every TCP
            //  connection on this PC is still handed to a SOCKS port that a dead
            //  tor.exe is not answering, and the machine stays broken no matter
            //  what the firewall policy says. Killing it removes the adapter, and
            //  the routes are per-adapter, so they go with it -- which is why
            //  there is no `route delete` here to get wrong.
            //
            //  A child process outlives the Electron parent on Windows unless it
            //  was put in a job object, so "the app is gone" does not mean these
            //  are. Both taskkills are harmless when nothing matches.
            'taskkill /F /IM tun2socks.exe >nul 2>&1',
            'taskkill /F /IM tor.exe >nul 2>&1',
            'taskkill /F /IM lyrebird.exe >nul 2>&1',
            'echo [2/7] Allowing outbound traffic again...',
            'netsh advfirewall set allprofiles firewallpolicy blockinbound,allowoutbound',
            'echo [3/7] Removing the firewall rules this app added...',
            ...del,
            'echo [4/7] Clearing the system proxy...',
            'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" ' +
                '/v ProxyEnable /t REG_DWORD /d 0 /f >nul',
            'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" ' +
                '/v ProxyServer /t REG_SZ /d "" /f >nul',
            'netsh winhttp reset proxy >nul 2>&1',
            'echo [5/7] Putting DNS back on automatic...',
            'reg delete "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters" ' +
                '/v NameServer /f >nul 2>&1',
            'for /f "tokens=3*" %%A in (\'netsh interface show interface ^| findstr /i "connected"\') do (',
            '  netsh interface ipv4 set dnsserver "%%B" dhcp >nul 2>&1',
            '  netsh interface ipv6 set dnsserver "%%B" dhcp >nul 2>&1',
            ')',
            'net start dnscache >nul 2>&1',
            'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters" ' +
                '/v DisabledComponents /t REG_DWORD /d 0 /f >nul',
            'ipconfig /flushdns >nul',
            //  ── The Firefox family, which none of the steps above reaches ──
            //  Everything before this line is Windows: the firewall policy, the
            //  WinINET/WinHTTP proxy, the DNS servers. A Gecko browser that this
            //  app wrote user.js into ignores all of it -- network.proxy.type is
            //  1, not 5, and it points at 127.0.0.1:9050. With tor.exe killed in
            //  step 1, that browser cannot load a single page, and no Windows
            //  setting in this script will change that.
            //
            //  Delegated to a sibling .ps1 rather than inlined: see
            //  _geckoRecoveryPs1(). If that file is missing, this SAYS SO and
            //  tells the user the manual fix -- it does not print a step number
            //  and move on as if it had run.
            'echo [6/7] Putting the Firefox family back...',
            'if exist "%~dp0restore-gecko-prefs.ps1" powershell -NoProfile ' +
                '-ExecutionPolicy Bypass -File "%~dp0restore-gecko-prefs.ps1"',
            'if not exist "%~dp0restore-gecko-prefs.ps1" (',
            '  echo   SKIPPED - restore-gecko-prefs.ps1 is not next to this file.',
            '  echo   Firefox, Waterfox, LibreWolf, Pale Moon and SeaMonkey may still',
            '  echo   be set to send everything to 127.0.0.1:9050, which nothing is',
            '  echo   answering now. To fix one by hand: open its Settings, search for',
            '  echo   proxy, open Network Settings, then choose Use system proxy settings.',
            ')',
            'echo [7/7] Checking the result...',
            'netsh advfirewall show allprofiles | findstr /i "Firewall Policy"',
            'echo.',
            'echo Done. Every line above should read BlockInbound,AllowOutbound.',
            'echo If IPv6 was disabled, a restart puts it back completely.',
            'echo A Firefox-family browser that was open must be closed and reopened.',
            'echo.',
            'pause',
        ];
        try {
            fs.mkdirSync(this.stateDir, { recursive: true });
            fs.writeFileSync(this.recoveryBat, lines.join('\r\n'), 'utf8');
        } catch (e) {
            this.log.error('Recovery script could NOT be written -- containment ' +
                           'will not be armed', { path: this.recoveryBat, err: e.message });
            return { ok: false, error: e.message };
        }
        //  The Gecko half, in its own try: a machine that gets the .bat and not
        //  the .ps1 can still be rescued from "no internet at all", which is the
        //  failure this whole class exists for, so this one must not veto arming.
        //  It is not silent either -- the .bat prints SKIPPED and the manual fix
        //  when the file is absent, and this warns in the app's own log.
        //
        //  Written as ASCII with no BOM on purpose: PowerShell 5.1 reads a
        //  BOM-less file as ANSI, so any non-ASCII byte here would arrive
        //  mojibaked in the one script that has to work unattended.
        let gecko = false;
        try {
            fs.writeFileSync(this.recoveryGeckoPs1, this._geckoRecoveryPs1(), 'utf8');
            gecko = true;
        } catch (e) {
            this.log.warn('The Firefox-family half of the recovery could not be ' +
                          'written; Restore Internet will say so rather than skip it ' +
                          'silently', { path: this.recoveryGeckoPs1, err: e.message });
        }
        return { ok: true, path: this.recoveryBat, gecko,
                 geckoPath: gecko ? this.recoveryGeckoPs1 : null };
    }

    //  ── The allow list ──
    //  Written before the policy flips, and READ BACK BY PROGRAM PATH, not just
    //  by name. That distinction is the whole point of this function.
    //
    //  MEASURED, and it would have been fatal here: installer.nsh adds
    //  "FreeProxy Tor Engine" pointing at
    //      $INSTDIR\resources\app.asar.unpacked\Tor\tor\tor.exe
    //  but setupWritableTor() copies the bundle to ProgramData and the process
    //  that actually runs is
    //      C:\ProgramData\freeproxy-vpn\Tor\tor\tor.exe
    //  Two different binaries as far as the Windows Filtering Platform is
    //  concerned. firstRunCheck() then "self-healed" only when the rule was
    //  MISSING, found it present, and logged "Firewall rule present" -- so the
    //  exe that carries every byte of this VPN had no allow rule at all. With
    //  outbound allowed by default that was invisible. Under default-deny it
    //  would mean Tor cannot open a single circuit and the machine has no
    //  internet, with the app insisting everything is configured.
    async installAllowRules({ allowLan = false, tunLocalIp = '' } = {}) {
        const want = [];
        const add = (name, args) => want.push({ name, args });

        if (this.torExe && fs.existsSync(this.torExe)) {
            add(ALLOW_RULES.tor, [`program=${this.torExe}`]);
        } else {
            this.log.error('Containment: tor.exe not found, refusing to arm',
                           { path: this.torExe });
            return { ok: false, reason: 'tor.exe not found at ' + this.torExe };
        }
        if (this.lyrebirdExe && fs.existsSync(this.lyrebirdExe)) {
            add(ALLOW_RULES.lyrebird, [`program=${this.lyrebirdExe}`]);
        }
        //  This app itself. Stated plainly rather than pretended away: while
        //  armed, this process keeps direct outbound reach. It needs it -- the
        //  relay index has to be fetchable before a tunnel exists, and the
        //  wait-for-capacity loop runs before Tor is up. What removes the
        //  cleartext exposure is the on-disk relay-index cache, not this rule.
        add(ALLOW_RULES.app, [`program=${this.appExe}`]);
        //  tun2socks. Everything it sends goes to 127.0.0.1:9050, which the
        //  loopback rule below already covers and which Windows does not filter
        //  in practice -- so this rule is belt and braces, not load-bearing. It
        //  is here because the cost of being wrong is asymmetric: one extra
        //  netsh call versus a machine in default-deny whose tunnel silently
        //  carries nothing, which looks exactly like "connected".
        if (this.tun2socksExe && fs.existsSync(this.tun2socksExe)) {
            add(ALLOW_RULES.tun2socks, [`program=${this.tun2socksExe}`]);
        }
        //  Loopback. Windows does not filter 127/8 in practice, but an explicit
        //  rule costs nothing and makes the intent readable in wf.msc.
        add(ALLOW_RULES.loopback, ['remoteip=127.0.0.1']);
        //  DHCP, or the machine loses its own IP address at the next lease
        //  renewal and "no internet" becomes permanent rather than policy.
        add(ALLOW_RULES.dhcp, ['protocol=UDP', 'localport=68', 'remoteport=67']);
        //  ── The rule that makes containment and the TUN work together ──
        //  Without this, default-deny would block the very applications whose
        //  traffic the tunnel exists to carry: an app connects out, the route
        //  table hands the packet to the TUN adapter, and WFP drops it before it
        //  gets there, because WFP filters by PROCESS and the process has no
        //  allow rule.
        //
        //  Windows firewall rules cannot name a specific adapter
        //  (interfacetype= only understands wireless/lan/ras/any), but they can
        //  name a LOCAL address -- and a connection routed through the TUN has
        //  the TUN's address as its local address. So "allow outbound when the
        //  local IP is the tunnel's" permits exactly the traffic that is inside
        //  the tunnel and nothing that would leave by the physical NIC. Any app
        //  that binds to the real interface on purpose, and every UDP flow the
        //  tunnel cannot carry, still hits the default deny. That is the leak
        //  guarantee, expressed as one rule.
        if (tunLocalIp) add(ALLOW_RULES.tun, [`localip=${tunLocalIp}`]);
        if (allowLan)   add(ALLOW_RULES.lan, ['remoteip=LocalSubnet']);

        for (const rule of want) {
            await netsh(['advfirewall', 'firewall', 'delete', 'rule',
                         `name=${rule.name}`], 15000);
            const r = await netsh(['advfirewall', 'firewall', 'add', 'rule',
                `name=${rule.name}`, 'dir=out', 'action=allow', 'enable=yes',
                'profile=any', ...rule.args], 15000);
            if (!r.ok) {
                this.log.error('Containment: an allow rule could not be added, ' +
                               'refusing to arm', { rule: rule.name, out: r.out.trim() });
                return { ok: false, reason: `could not add "${rule.name}"` };
            }
        }
        //  Read back the two that decide whether anything works at all.
        const bad = [];
        for (const [name, exe] of [[ALLOW_RULES.tor, this.torExe],
                                   [ALLOW_RULES.app, this.appExe]]) {
            const q = await netsh(['advfirewall', 'firewall', 'show', 'rule',
                                   `name=${name}`, 'verbose'], 15000);
            const hit = q.ok && q.out.toLowerCase().includes(exe.toLowerCase());
            if (!hit) bad.push({ rule: name, expectedProgram: exe });
        }
        if (bad.length) {
            this.log.error('Containment: allow rules do not name the running ' +
                           'executables -- refusing to arm', { bad });
            return { ok: false, reason: 'allow-rule read-back mismatch', bad };
        }
        this.log.success('Containment: allow rules written and verified',
                         { rules: want.map(w => w.name) });
        return { ok: true, rules: want.map(w => w.name) };
    }

    //  ── Arm ──
    //  Strict order, and every step can refuse:
    //    1. the way out exists on disk           (else: refuse)
    //    2. the firewall is actually running     (else: refuse, and say so)
    //    3. the allow rules exist and name the right binaries (else: refuse)
    //    4. only then does the policy flip
    //    5. read the policy back; if it did not take, undo step 4 immediately
    //  There is no path through this function that locks the machine down
    //  without a verified allow list and a verified way out already in place.
    async enable({ allowLan = false, tunLocalIp = '' } = {}) {
        const rec = this.writeRecovery();
        if (!rec.ok) return { ok: false, reason: 'no recovery script: ' + rec.error };

        const before = await this.status();
        if (!before.ok) return { ok: false, reason: 'cannot read firewall state' };
        if (!before.firewallOn) {
            //  Not a warning. Containment IS the Windows firewall here; with the
            //  service off there is nothing to contain with, and pretending
            //  otherwise would be the exact "claim without the block" this
            //  release exists to remove.
            this.log.error('Containment REFUSED: the Windows Firewall is off for ' +
                           'at least one profile, so a default-deny policy would ' +
                           'not be enforced', { profiles: before.profiles });
            return { ok: false, reason: 'windows firewall is off' };
        }

        const rules = await this.installAllowRules({ allowLan, tunLocalIp });
        if (!rules.ok) return { ok: false, reason: rules.reason, bad: rules.bad };

        const set = await netsh(['advfirewall', 'set', 'allprofiles',
                                 'firewallpolicy', 'blockinbound,blockoutbound'], 25000);
        if (!set.ok) {
            this.log.error('Containment: the policy flip was refused by netsh',
                           { out: set.out.trim() });
            return { ok: false, reason: 'netsh refused the policy change' };
        }
        const after = await this.status();
        if (!after.outboundBlocked) {
            //  This is the domain-GPO case: netsh returns Ok. and the effective
            //  policy is unchanged because a Group Policy object owns it. Read
            //  back, caught, undone, reported -- never recorded as armed.
            this.log.error('Containment: netsh reported success but the policy ' +
                           'did NOT change -- a Group Policy probably owns it. ' +
                           'Nothing is armed.', { profiles: after.profiles });
            await netsh(['advfirewall', 'set', 'allprofiles', 'firewallpolicy',
                         'blockinbound,allowoutbound'], 25000);
            return { ok: false, reason: 'policy did not take (Group Policy?)' };
        }
        this._armed = true;
        this.log.success('Containment ARMED -- outbound blocked by default on all ' +
                         'three profiles. Only the tunnel, tor.exe, this app, ' +
                         'loopback and DHCP can leave.', {
            allowLan, tunLocalIp: tunLocalIp || null, recovery: this.recoveryBat });
        return { ok: true, recovery: this.recoveryBat };
    }

    //  ── Disarm ──
    //  Deliberately forgiving in the opposite direction: it always tries every
    //  step, never returns early on a failure, and reports what is still wrong.
    //  A disarm that gives up halfway is how a machine stays offline.
    async disable({ keepRules = false } = {}) {
        const problems = [];
        const set = await netsh(['advfirewall', 'set', 'allprofiles',
                                 'firewallpolicy', 'blockinbound,allowoutbound'], 25000);
        if (!set.ok) problems.push('policy: ' + (set.err || set.out.trim()));
        if (!keepRules) {
            for (const name of RULE_NAMES) {
                await netsh(['advfirewall', 'firewall', 'delete', 'rule',
                             `name=${name}`], 15000);
            }
        }
        const after = await this.status();
        if (after.ok && after.outboundBlocked) {
            problems.push('outbound is STILL blocked after the restore attempt');
        }
        this._armed = after.ok ? !!after.outboundBlocked : this._armed;
        if (problems.length) {
            this.log.error('Containment disarm did not fully succeed -- run ' +
                           this.recoveryBat + ' as administrator', { problems });
            return { ok: false, problems, recovery: this.recoveryBat };
        }
        this.log.success('Containment disarmed -- outbound allowed again');
        return { ok: true };
    }

    //  Best-effort, synchronous-ish, for the paths where the process is going
    //  away and there is no time to await anything: will-quit, and the last
    //  chance inside an uncaughtException. Fire-and-forget on purpose.
    disableNoWait() {
        try {
            require('child_process').spawn('netsh.exe',
                ['advfirewall', 'set', 'allprofiles', 'firewallpolicy',
                 'blockinbound,allowoutbound'],
                { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
        } catch (e) { /* the recovery script is the backstop */ }
    }
}

module.exports = { ALLOW_RULES, RULE_NAMES, RECOVERY_LNK, Containment };


'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-winloc-default.js
//
//  THE decisive experiment for native Windows apps.
//
//  Established by .build/diag-winloc.js on this machine:
//    * a Win32/.NET app gets 23.7208, 90.4220 +/- 113 m -- the real position
//    * there is NO GNSS sensor, so that 113 m came from the Wi-Fi survey
//      resolved by Microsoft's online location service
//    * lfsvc runs alone in its own svchost (-k netsvcs -p), so a
//      service-scoped firewall rule hits it and nothing else
//
//  Established by .build/diag-defloc.js:
//    * HKCU\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Sensors\Location
//      exists with Latitude="0", Longitude="0", Status=1 (dword)
//    * LocationApi.dll contains the literal SOFTWARE\Microsoft\Location\
//      DefaultLocation\ (absent from the registry -- created on demand)
//
//  The question this answers: can writing a default location make a NATIVE
//  app report the connected country, with Location left ON and nothing
//  denied? Microsoft documents the default location as a FALLBACK used only
//  when no better source resolves, so the test has two stages:
//
//      A. write the coordinates, leave the Wi-Fi survey working
//         -> expect the real position still (fallback not consulted)
//      B. write the coordinates AND cut lfsvc off from the network
//         -> the survey cannot resolve, so if the fallback is real and
//            wired up, this is where the written coordinates appear
//
//  Stage B needs admin for the firewall rule. Run this elevated to get it;
//  unelevated it runs stage A and says so rather than guessing.
//
//  EVERYTHING IS RESTORED. The original Latitude/Longitude/Status are read
//  first and put back in a finally block, the firewall rule is removed by
//  name, and the script re-reads both afterwards to prove the machine is as
//  it was. Nothing here is left behind on any exit path.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LU = { lat: 49.6116, lng: 6.1319 };      // Luxembourg City
const RULE = 'FPVPN-DIAG-lfsvc-block';         // removed before exit, always

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpwloc-'));
const KEY = 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Sensors\\Location';

function ps(script, opts) {
    const f = path.join(TMP, 'p' + Math.random().toString(36).slice(2) + '.ps1');
    fs.writeFileSync(f, script, 'utf8');
    try {
        return execFileSync('powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f],
            { encoding: 'utf8', windowsHide: true,
              timeout: (opts && opts.timeout) || 120000 });
    } catch (e) {
        return (e.stdout || '') + (e.stderr ? '\n[stderr] ' + e.stderr : '') +
               (e.killed ? '\n[timed out]' : '');
    }
}

/** What a native Win32/.NET consumer reports right now. */
function nativePosition(label) {
    const out = ps(`
$ErrorActionPreference='Continue'
Add-Type -AssemblyName System.Device
$w = New-Object System.Device.Location.GeoCoordinateWatcher([System.Device.Location.GeoPositionAccuracy]::High)
$w.MovementThreshold = 0
$null = $w.TryStart($false, [TimeSpan]::FromSeconds(20))
$deadline = (Get-Date).AddSeconds(22)
while ((Get-Date) -lt $deadline -and $w.Status -ne 'Ready' -and $w.Permission -ne 'Denied') { Start-Sleep -Milliseconds 400 }
$p = $w.Position
if ($p -and -not $p.Location.IsUnknown) {
  Write-Output ("POS " + $p.Location.Latitude + " " + $p.Location.Longitude + " " + $p.Location.HorizontalAccuracy)
} else { Write-Output "POS unknown" }
Write-Output ("ST " + $w.Status + " " + $w.Permission)
$w.Stop()
`, { timeout: 90000 });
    const pos = (out.match(/^POS (.+)$/m) || [, '?'])[1].trim();
    const st = (out.match(/^ST (.+)$/m) || [, '?'])[1].trim();
    console.log(`   ${label.padEnd(34)} ${pos}   [${st}]`);
    return pos;
}

const elevated = /True/i.test(ps(
    `Write-Output ([Security.Principal.WindowsPrincipal]::new(` +
    `[Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(` +
    `[Security.Principal.WindowsBuiltInRole]::Administrator))`));

//  ── snapshot ────────────────────────────────────────────────────────
const snap = JSON.parse(ps(`
$ErrorActionPreference='SilentlyContinue'
$k = 'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Sensors\\Location'
$o = @{ existed = (Test-Path $k) }
if ($o.existed) {
  $i = Get-Item $k
  foreach ($n in @('Latitude','Longitude','Status')) {
    if ($i.GetValueNames() -contains $n) { $o[$n] = [string]$i.GetValue($n); $o[$n + 'Kind'] = [string]$i.GetValueKind($n) }
  }
}
$o | ConvertTo-Json -Compress
`));
console.log('elevated : ' + elevated);
console.log('snapshot : ' + JSON.stringify(snap));
console.log('');

let restored = false;
function restore() {
    if (restored) return;
    restored = true;
    console.log('');
    console.log('── restoring ──');
    const lat = snap.Latitude === undefined ? null : snap.Latitude;
    const lng = snap.Longitude === undefined ? null : snap.Longitude;
    const sts = snap.Status === undefined ? null : snap.Status;
    console.log(ps(`
$ErrorActionPreference='Continue'
$k = 'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Sensors\\Location'
${lat === null ? `Remove-ItemProperty $k -Name Latitude -ErrorAction SilentlyContinue`
              : `Set-ItemProperty $k -Name Latitude -Value '${lat}' -Type String`}
${lng === null ? `Remove-ItemProperty $k -Name Longitude -ErrorAction SilentlyContinue`
              : `Set-ItemProperty $k -Name Longitude -Value '${lng}' -Type String`}
${sts === null ? `Remove-ItemProperty $k -Name Status -ErrorAction SilentlyContinue`
              : `Set-ItemProperty $k -Name Status -Value ${sts} -Type DWord`}
Remove-Item 'HKCU:\\SOFTWARE\\Microsoft\\Location' -Recurse -Force -ErrorAction SilentlyContinue
if (Get-NetFirewallRule -DisplayName '${RULE}' -ErrorAction SilentlyContinue) {
  Remove-NetFirewallRule -DisplayName '${RULE}' -ErrorAction SilentlyContinue
  Write-Output "  firewall rule removed"
} else { Write-Output "  no firewall rule to remove" }
$i = Get-Item $k -ErrorAction SilentlyContinue
Write-Output ("  now: Latitude=" + $i.GetValue('Latitude') + " Longitude=" + $i.GetValue('Longitude') + " Status=" + $i.GetValue('Status'))
Write-Output ("  HKCU\\SOFTWARE\\Microsoft\\Location present: " + (Test-Path 'HKCU:\\SOFTWARE\\Microsoft\\Location'))
`));
}
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(130); });

try {
    console.log('── stage 0: baseline, nothing changed ──');
    const base = nativePosition('baseline');

    console.log('');
    console.log('── stage A: default location written, Wi-Fi survey still working ──');
    ps(`
$ErrorActionPreference='Continue'
$k = 'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Sensors\\Location'
Set-ItemProperty $k -Name Latitude  -Value '${LU.lat}' -Type String
Set-ItemProperty $k -Name Longitude -Value '${LU.lng}' -Type String
Set-ItemProperty $k -Name Status    -Value 1 -Type DWord
#  the legacy Location API path too, since LocationApi.dll names it
New-Item 'HKCU:\\SOFTWARE\\Microsoft\\Location\\DefaultLocation' -Force | Out-Null
Set-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Location\\DefaultLocation' -Name Latitude  -Value '${LU.lat}' -Type String
Set-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Location\\DefaultLocation' -Name Longitude -Value '${LU.lng}' -Type String
`);
    const withDefault = nativePosition('default written');

    let cutOff = null;
    if (elevated) {
        console.log('');
        console.log('── stage B: same, but lfsvc cut off from the network ──');
        console.log(ps(`
$ErrorActionPreference='Continue'
New-NetFirewallRule -DisplayName '${RULE}' -Direction Outbound -Action Block -Service lfsvc -Profile Any | Out-Null
Write-Output ("  rule added: " + (Get-NetFirewallRule -DisplayName '${RULE}').Enabled)
Restart-Service lfsvc -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Write-Output ("  lfsvc: " + (Get-Service lfsvc).Status)
`, { timeout: 90000 }));
        cutOff = nativePosition('default + lfsvc offline');
    } else {
        console.log('');
        console.log('── stage B skipped: needs admin for the service-scoped firewall rule ──');
    }

    console.log('');
    console.log('════ verdict ════');
    const isLU = (p) => /^49\.6/.test(p) && /\s6\.1/.test(p);
    console.log('  baseline               : ' + base);
    console.log('  default written        : ' + withDefault +
                (isLU(withDefault) ? '   <= DEFAULT LOCATION IS AUTHORITATIVE' : '   (fallback not consulted, as documented)'));
    if (cutOff !== null) {
        console.log('  default + no network   : ' + cutOff +
                    (isLU(cutOff) ? '   <= FALLBACK WORKS -- a genuine native spoof exists'
                                  : cutOff === 'unknown'
                                      ? '   <= no position at all: leak-proof but NOT a spoof'
                                      : '   <= still the real position: the survey is cached or offline-capable'));
    }
} finally {
    restore();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
}

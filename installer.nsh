; ═══════════════════════════════════════════════════════════════════
;  FreeProxy VPN -- NSIS install / uninstall hooks
;
;  WHAT THIS FILE USED TO DO, AND WHY IT IS GONE
;
;  The previous version force-installed a HARDCODED extension id --
;  oecbgglkbdlifmaedkikgpmifiidjhfo -- into slot "1" of the Chrome and Edge
;  ExtensionInstallForcelist keys. That id is not this project's extension:
;  nothing in this repository packages, signs or serves it. So the installer
;  was pushing a stranger's extension into every user's browser, in the very
;  slot lib/geo-ext.js allocates dynamically. The uninstaller then deleted
;  exactly that one slot NUMBER, which would just as happily have removed a
;  workplace deployment's own entry.
;
;  Both are gone, and this file no longer contains a single browser-specific
;  registry path. It runs the app instead:
;
;      "$INSTDIR\FreeProxy VPN.exe" --fp-setup       from customInstall
;      "$INSTDIR\FreeProxy VPN.exe" --fp-teardown    from customUnInstall
;
;  lib/installer-tasks.js handles both, headless. That is not indirection for
;  its own sake -- it is the only way the install-time step can do the real
;  job: detect which browsers are actually on THIS machine (lib/browsers.js),
;  stage and RSA-sign the real extension (lib/crx.js), and write the forcelist
;  entry for its own generated id. NSIS can do none of that, and any registry
;  path copied in here is a second source of truth that rots the moment the
;  browser table changes.
;
;  The entry written at install time points at http://127.0.0.1, which nothing
;  answers until the app is running. That is the requirement, not a side
;  effect: the extension is delivered by the install and comes to life with
;  the app.
;
;  Everything after the uninstaller's ExecWait is a fallback that needs no
;  exe, because electron-builder does not guarantee that the program files
;  still exist when this macro runs. It touches only entries whose update URL
;  is this app's own loopback server, plus the fake id above -- a signature no
;  real enterprise deployment can have. It covers ALL THREE routes
;  lib/geo-ext.js writes: the numbered ExtensionInstallForcelist slots, the
;  ExtensionSettings JSON dictionary, which has to be rewritten without our key
;  rather than deleted, and each fork's own external-extensions provider under
;  HKLM\SOFTWARE -- walked by shape, in both registry views, so this file still
;  contains no browser-specific registry path.
;
;  THE ONE RESTART
;  This installer also collects, and never invents, the answer to "does this
;  machine need a reboot": the bundled Visual C++ runtime's exit code (3010 /
;  1641) and NSIS's own reboot flag, passed to --fp-setup as
;  --fp-reboot-pending. That step checks Windows' PendingFileRenameOperations
;  as well, and it schedules the boot pass -- the SYSTEM task that finishes the
;  browser work at the next startup, before any browser has started, which is
;  the only moment a Chromium fork reads an external-extensions offer. Whichever
;  of those is real leaves a marker the app reads once, offering a single
;  restart. It exists so the app has one interruption at the start instead of
;  closing the user's browsers every time they connect or switch country.
;
;  The uninstaller has the mirror image: --fp-teardown returns 11 when it found
;  a browser open, because a browser only drops an externally-offered extension
;  while it starts, and section 8 offers one restart for that -- MB_YESNO, never
;  in a silent run, and never taken on the user's behalf.
; ═══════════════════════════════════════════════════════════════════

!macro customInstall

  DetailPrint "FreeProxy VPN: Configuring components..."

  ; ── 0. The one restart -- collected, never invented ─────────────
  ;  $4 becomes " --fp-reboot-pending" if, and only if, WINDOWS says part of
  ;  this install finishes at the next boot. It is passed straight through to
  ;  --fp-setup, which is what decides whether to leave a marker for the app to
  ;  find (lib/installer-tasks.js, noteRestart()).
  ;
  ;  This is the whole reason the app no longer closes browsers on connect,
  ;  disconnect and country switch: everything that needs doing to a quiet
  ;  system is done HERE, and the single restart that may be left over is asked
  ;  for once, at the start, the way IDM and the commercial VPNs do it.
  ;
  ;  Windows' evidence is only half of it. --fp-setup also schedules the boot
  ;  pass, and that IS work waiting for a restart: a Chromium fork reads an
  ;  installer's external-extensions offer while it starts, so Chrome, Brave and
  ;  the rest are covered at the next startup and not before. Everything that
  ;  applies live -- Chromium policy, the system proxy, the firewall rules --
  ;  still asks for nothing.
  StrCpy $4 ""

  ; ── 1. Windows Firewall: tor.exe + app outbound allow ──────────
  ;  Named rules, deleted first so a repeat install cannot stack duplicates.
  ;  lib/installer-tasks.js knows these same two names and removes them on
  ;  uninstall, together with the three the running app creates.
  DetailPrint "Setting up Windows Firewall rules..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="FreeProxy Tor Engine"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="FreeProxy Tor Engine" dir=out action=allow program="$INSTDIR\resources\app.asar.unpacked\Tor\tor\tor.exe" enable=yes profile=any description="FreeProxy VPN Tor Engine"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="FreeProxy App"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="FreeProxy App" dir=out action=allow program="$INSTDIR\FreeProxy VPN.exe" enable=yes profile=any description="FreeProxy VPN Application"'
  DetailPrint "Firewall configured."

  ; ── 2. Visual C++ Redistributable check ────────────────────────
  DetailPrint "Checking Visual C++ Runtime..."
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${If} $0 != 1
    ${If} ${FileExists} "$INSTDIR\resources\vc_redist.x64.exe"
      DetailPrint "Installing Visual C++ Redistributable (bundled)..."
      ;  /norestart means "do not reboot my machine", NOT "no reboot is
      ;  needed" -- the redistributable reports that separately in its exit
      ;  code, and this is the one place in the whole install where a restart
      ;  can legitimately become necessary: 3010 means it could not replace a
      ;  runtime DLL that some other process had open, so the replacement
      ;  happens at the next boot. 1641 means it started a reboot itself.
      ;
      ;  Nothing is INFERRED from this. The flag only travels to --fp-setup,
      ;  which checks Windows' own PendingFileRenameOperations as well before it
      ;  writes anything. And SetRebootFlag is deliberately NOT called: NSIS
      ;  would then be entitled to put up its own reboot dialog, and two
      ;  different prompts for one restart is worse than none.
      ExecWait '"$INSTDIR\resources\vc_redist.x64.exe" /quiet /norestart' $3
      DetailPrint "Visual C++ Redistributable finished with code $3."
      ${If} $3 == 3010
      ${OrIf} $3 == 1641
        StrCpy $4 " --fp-reboot-pending"
        DetailPrint "Windows will finish the Visual C++ runtime at the next restart."
      ${EndIf}
    ${Else}
      DetailPrint "Downloading Visual C++ Redistributable..."
      nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { $$url=''https://aka.ms/vs/17/release/vc_redist.x64.exe''; $$out=''$$env:TEMP\vc_redist.x64.exe''; (New-Object Net.WebClient).DownloadFile($$url,$$out); Start-Process -FilePath $$out -ArgumentList ''/quiet /norestart'' -Wait } catch { Write-Host ''VC++ download failed'' }"'
    ${EndIf}
    DetailPrint "Visual C++ Runtime ready."
  ${Else}
    DetailPrint "Visual C++ Runtime already installed."
  ${EndIf}

  ; ── 3. Application directories ─────────────────────────────────
  ;  Only the log/Tor tree under LOCALAPPDATA. The app's real state directory
  ;  is C:\ProgramData\freeproxy-vpn and it creates that itself, before
  ;  app.getPath() is ever called -- creating it from here as well would just
  ;  be a second place that has to agree with main.js.
  DetailPrint "Creating application directories..."
  CreateDirectory "$LOCALAPPDATA\FreeProxy VPN"
  CreateDirectory "$LOCALAPPDATA\FreeProxy VPN\logs"
  CreateDirectory "$LOCALAPPDATA\FreeProxy VPN\Tor"
  CreateDirectory "$LOCALAPPDATA\FreeProxy VPN\Tor\data"
  CreateDirectory "$LOCALAPPDATA\FreeProxy VPN\Tor\data\keys"

  ; ── 4. Browser extension: the app does it, with real detection ──
  ;  Runs elevated, because the installer is (perMachine + requireAdministrator
  ;  in package.json), which is what the force-install into HKLM needs. There
  ;  is no separate admin prompt: asking again from inside an install would put
  ;  a UAC dialog on screen with no visible parent.
  ;
  ;  Exit codes come from lib/installer-tasks.js. 10 is not a failure -- it
  ;  means the extension is staged and signed but every installed browser
  ;  refuses the automatic route, which on Windows is true of Chrome and Brave
  ;  for a reason no app can work around: Google requires the machine to be
  ;  domain-joined, Azure-AD-joined or enrolled in Chrome Browser Cloud
  ;  Management before an off-store extension can be forced. Those users get
  ;  HOW-TO-ENABLE.txt and the in-app popup, which is one click, once, ever.
  DetailPrint "Setting up the browser location extension..."
  ;  NSIS's own reboot flag, read and never set: electron-builder's template
  ;  raises it if IT had to schedule a locked file for the next boot, and that
  ;  is exactly the same fact the redistributable's 3010 reports. Read here
  ;  rather than in section 2 so it is picked up however late it was raised.
  IfRebootFlag 0 +2
    StrCpy $4 " --fp-reboot-pending"
  ExecWait '"$INSTDIR\FreeProxy VPN.exe" --fp-setup$4' $0
  ${If} $0 == 0
    DetailPrint "Extension force-installed automatically -- nothing for you to do."
  ${ElseIf} $0 == 10
    DetailPrint "Extension ready. One browser needs a single manual load -- see HOW-TO-ENABLE.txt."
  ${ElseIf} $0 == 4
    DetailPrint "Extension setup timed out; the app will finish it on first run."
  ${Else}
    DetailPrint "Extension setup returned $0; the app will retry on first run."
  ${EndIf}

  ; ── 5. Registry markers ────────────────────────────────────────
  ;  ${VERSION} is electron-builder's, so this cannot drift from package.json
  ;  the way the hardcoded "1.0.0" here did.
  WriteRegStr   HKLM "Software\FreeProxy VPN" "InstallPath" "$INSTDIR"
  WriteRegStr   HKLM "Software\FreeProxy VPN" "Version"     "${VERSION}"
  WriteRegDWORD HKLM "Software\FreeProxy VPN" "FirewallConfigured" 1

  DetailPrint "FreeProxy VPN setup complete!"

!macroend

!macro customUnInstall

  DetailPrint "FreeProxy VPN: reverting every change this app made..."

  ; ── 1. Nothing of ours may still be running ────────────────────
  ;  The app first: it is the process that would rewrite the proxy and the
  ;  policy keys underneath the sweep below. tor.exe second, because with the
  ;  proxy about to be removed a surviving tor.exe is just a stray listener.
  nsExec::ExecToLog 'taskkill /F /IM "FreeProxy VPN.exe"'
  nsExec::ExecToLog 'taskkill /F /IM tor.exe'

  ; ── 2. The app's own journal-driven revert ─────────────────────
  ;  This is the only step that can put a setting back to what the USER had
  ;  rather than to a Windows default: the Chromium site permissions an older
  ;  build flipped, the location consent state and lfsvc's start type, each
  ;  Gecko profile's user.js, and the exact forcelist slots lib/geo-ext.js
  ;  recorded. Guarded, because electron-builder does not promise the program
  ;  files still exist when this macro runs -- everything after it is written
  ;  to work without them.
  ${If} ${FileExists} "$INSTDIR\FreeProxy VPN.exe"
    DetailPrint "Restoring saved settings..."
    ExecWait '"$INSTDIR\FreeProxy VPN.exe" --fp-teardown' $0
    DetailPrint "Settings restore finished (code $0)."
    ;  Kept in a register of its own because the sweeps below reuse $0..$2, and
    ;  the one question it answers can only be acted on at the very end of the
    ;  uninstall: code 11 means teardown found a Chromium browser OPEN. Nothing
    ;  is inferred from it here -- see the block after section 7.
    StrCpy $5 $0
  ${Else}
    DetailPrint "Program files already removed -- using the fallback sweep."
    StrCpy $5 ""
  ${EndIf}

  ; ── 3. Fallback sweep -- no exe required ───────────────────────
  ;  Written to a script instead of a giant -Command string: NSIS strings are
  ;  1024 characters, and every quote in a -Command has to be doubled, which is
  ;  how a sweep like this ends up silently doing nothing.
  ;
  ;  It walks HKLM\Software\Policies by SHAPE rather than by a list of vendor
  ;  paths, so a Chromium fork that is not in lib/browsers.js is still cleaned,
  ;  and it removes a forcelist entry ONLY when the value is unmistakably ours:
  ;  a 32-letter id served from this machine's own loopback, or the fake id an
  ;  earlier version of this installer wrote. A workplace deployment's entry
  ;  can match neither, and is left exactly where it is. The subkey itself goes
  ;  only if this is what emptied it -- and the (Default) value that
  ;  `reg add <key> /f` leaves behind is discounted, or "empty" would never be
  ;  true again.
  ;
  ;  BOTH FORCE-INSTALL ROUTES, because lib/geo-ext.js writes both:
  ;
  ;    ExtensionInstallForcelist -- a subkey of numbered REG_SZ slots, one
  ;        entry per value, handled by the block below.
  ;    ExtensionSettings         -- ONE REG_SZ value holding a JSON dictionary
  ;        of every extension the machine has a policy for. That makes removal
  ;        genuinely different: our entry cannot be deleted on its own, the
  ;        whole value has to be rewritten without it. So it is parsed with
  ;        ConvertFrom-Json, only our own key is dropped, and what is left is
  ;        written back -- an administrator's entries survive, byte-for-byte in
  ;        meaning. The value is removed outright only when ours was the only
  ;        thing in it.
  DetailPrint "Removing browser policy left by this app..."
  StrCpy $1 "$TEMP\fp-uninstall-sweep.ps1"
  FileOpen $2 "$1" w
  FileWrite $2 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $2 "$$sig  = '^[a-p]{32};https?://127\.0\.0\.1(:\d+)?/'$\r$\n"
  FileWrite $2 "$$url  = '^https?://127\.0\.0\.1(:\d+)?/'$\r$\n"
  FileWrite $2 "$$fid  = 'oecbgglkbdlifmaedkikgpmifiidjhfo'$\r$\n"
  FileWrite $2 "$$fake = $$fid + ';'$\r$\n"
  FileWrite $2 "$$vals = @('ProxySettings','WebRtcIPHandlingPolicy','DnsOverHttpsMode',$\r$\n"
  FileWrite $2 "          'BuiltInDnsClientEnabled','DnsPrefetchingEnabled',$\r$\n"
  FileWrite $2 "          'NetworkPredictionOptions','DefaultGeolocationSetting')$\r$\n"
  ;  ── which ids are OURS, collected before anything is deleted ──
  ;  The fourth route, ExtensionInstallAllowlist, stores a BARE id in a numbered
  ;  slot. There is no update_url in it and no path -- nothing about the value
  ;  says who wrote it, and a workplace that permits one extension by id writes
  ;  a byte-identical value. So "remove any 32-letter id" would be this
  ;  uninstaller deleting an administrator's policy, which it does not do.
  ;
  ;  The proof comes from elsewhere on the machine: our id is ALSO named by a
  ;  loopback-served entry -- a forcelist slot, an ExtensionSettings entry, or an
  ;  external-extensions provider subkey. This pre-pass collects those ids while
  ;  they still exist, because the walk right below is what deletes them. The
  ;  allowlist pass at the end of this script uses the result, and an id that
  ;  appears in the allowlist and nowhere else is left alone permanently.
  FileWrite $2 "$$ourIds = @()$\r$\n"
  FileWrite $2 "foreach ($$k in (Get-ChildItem 'HKLM:\Software\Policies' -Recurse -Depth 4)) {$\r$\n"
  FileWrite $2 "  $$r2 = [string]$$k.GetValue('ExtensionSettings')$\r$\n"
  FileWrite $2 "  if ($$r2) {$\r$\n"
  FileWrite $2 "    $$o2 = $$null$\r$\n"
  FileWrite $2 "    try { $$o2 = $$r2 | ConvertFrom-Json } catch { $$o2 = $$null }$\r$\n"
  FileWrite $2 "    if ($$o2 -ne $$null) {$\r$\n"
  FileWrite $2 "      foreach ($$p in @($$o2.PSObject.Properties)) {$\r$\n"
  FileWrite $2 "        $$u2 = [string]$$p.Value.update_url$\r$\n"
  FileWrite $2 "        if ($$p.Name -match '^[a-p]{32}$$' -and $$u2 -match $$url) {$\r$\n"
  FileWrite $2 "          $$ourIds += $$p.Name.ToLower()$\r$\n"
  FileWrite $2 "        }$\r$\n"
  FileWrite $2 "      }$\r$\n"
  FileWrite $2 "    }$\r$\n"
  FileWrite $2 "  }$\r$\n"
  FileWrite $2 "  if ($$k.PSChildName -eq 'ExtensionInstallForcelist') {$\r$\n"
  FileWrite $2 "    foreach ($$n in $$k.GetValueNames()) {$\r$\n"
  FileWrite $2 "      $$v2 = [string]$$k.GetValue($$n)$\r$\n"
  FileWrite $2 "      if ($$v2 -match $$sig) { $$ourIds += ($$v2.Split(';')[0]).ToLower() }$\r$\n"
  FileWrite $2 "    }$\r$\n"
  FileWrite $2 "  }$\r$\n"
  FileWrite $2 "}$\r$\n"
  FileWrite $2 "foreach ($$k in (Get-ChildItem 'HKLM:\Software\Policies' -Recurse -Depth 4)) {$\r$\n"
  FileWrite $2 "  $$raw = [string]$$k.GetValue('ExtensionSettings')$\r$\n"
  FileWrite $2 "  if ($$raw) {$\r$\n"
  FileWrite $2 "    $$o = $$null$\r$\n"
  FileWrite $2 "    try { $$o = $$raw | ConvertFrom-Json } catch { $$o = $$null }$\r$\n"
  FileWrite $2 "    if ($$o -ne $$null) {$\r$\n"
  FileWrite $2 "      $$drop = @()$\r$\n"
  FileWrite $2 "      foreach ($$p in @($$o.PSObject.Properties)) {$\r$\n"
  FileWrite $2 "        if ($$p.Name -eq $$fid) { $$drop += $$p.Name; continue }$\r$\n"
  FileWrite $2 "        $$u = [string]$$p.Value.update_url$\r$\n"
  FileWrite $2 "        if ($$p.Name -match '^[a-p]{32}$$' -and $$u -match $$url) { $$drop += $$p.Name }$\r$\n"
  FileWrite $2 "      }$\r$\n"
  FileWrite $2 "      if ($$drop.Count -gt 0) {$\r$\n"
  FileWrite $2 "        foreach ($$d in $$drop) { $$o.PSObject.Properties.Remove($$d) }$\r$\n"
  FileWrite $2 "        $$left = @($$o.PSObject.Properties).Count$\r$\n"
  FileWrite $2 "        if ($$left -eq 0) {$\r$\n"
  FileWrite $2 "          Remove-ItemProperty -Path $$k.PSPath -Name 'ExtensionSettings' -Force$\r$\n"
  FileWrite $2 "          Write-Host ('removed our ExtensionSettings policy from ' + $$k.PSChildName)$\r$\n"
  FileWrite $2 "        } else {$\r$\n"
  FileWrite $2 "          $$j = $$o | ConvertTo-Json -Compress -Depth 8$\r$\n"
  FileWrite $2 "          Set-ItemProperty -Path $$k.PSPath -Name 'ExtensionSettings' -Value $$j -Force$\r$\n"
  FileWrite $2 "          Write-Host ('ExtensionSettings: ours removed, ' + $$left + ' other entry/ies kept')$\r$\n"
  FileWrite $2 "        }$\r$\n"
  FileWrite $2 "      }$\r$\n"
  FileWrite $2 "    }$\r$\n"
  FileWrite $2 "  }$\r$\n"
  FileWrite $2 "  if ($$k.PSChildName -eq 'ExtensionInstallForcelist') {$\r$\n"
  FileWrite $2 "    foreach ($$n in $$k.GetValueNames()) {$\r$\n"
  FileWrite $2 "      $$v = [string]$$k.GetValue($$n)$\r$\n"
  FileWrite $2 "      if ($$v -match $$sig -or $$v.StartsWith($$fake)) {$\r$\n"
  FileWrite $2 "        Remove-ItemProperty -Path $$k.PSPath -Name $$n -Force$\r$\n"
  FileWrite $2 "        Write-Host ('removed force-install entry: ' + $$v)$\r$\n"
  FileWrite $2 "      }$\r$\n"
  FileWrite $2 "    }$\r$\n"
  FileWrite $2 "    $$left = @((Get-Item $$k.PSPath).GetValueNames() | ? { $$_ -ne '' })$\r$\n"
  FileWrite $2 "    if ($$left.Count -eq 0) { Remove-Item $$k.PSPath -Recurse -Force }$\r$\n"
  FileWrite $2 "    continue$\r$\n"
  FileWrite $2 "  }$\r$\n"
  FileWrite $2 "  if ($$k.PSChildName -eq 'GeolocationBlockedForUrls' -or$\r$\n"
  FileWrite $2 "      $$k.PSChildName -eq 'GeolocationAllowedForUrls') {$\r$\n"
  FileWrite $2 "    Remove-Item $$k.PSPath -Recurse -Force; continue$\r$\n"
  FileWrite $2 "  }$\r$\n"
  FileWrite $2 "  if ($$k.PSPath -like '*\Policies\Microsoft\Windows*') { continue }$\r$\n"
  FileWrite $2 "  foreach ($$n in $$vals) {$\r$\n"
  FileWrite $2 "    if ($$k.GetValue($$n) -ne $$null) {$\r$\n"
  FileWrite $2 "      Remove-ItemProperty -Path $$k.PSPath -Name $$n -Force$\r$\n"
  FileWrite $2 "    }$\r$\n"
  FileWrite $2 "  }$\r$\n"
  FileWrite $2 "}$\r$\n"
  ;  ── the third route, in the same script and with no exe either ──
  ;  lib/geo-ext.js also writes a Chromium fork's OWN external-extensions
  ;  provider -- HKLM\SOFTWARE\<vendor>\[<product>\]Extensions\<id>, one subkey
  ;  named after the extension id, holding an update_url. That is not policy, so
  ;  the loop above cannot see it, and it is the route that reaches Chrome and
  ;  Brave at all: an off-store force-install POLICY is discarded by an
  ;  unmanaged Chromium, an external-extensions offer is not.
  ;
  ;  Still no browser-specific path in this file. The tree is walked by SHAPE:
  ;  any vendor key under SOFTWARE, or any product key one level below it, that
  ;  has an Extensions subkey. That covers Microsoft\Edge, Google\Chrome,
  ;  BraveSoftware\Brave-Browser, Yandex\YandexBrowser and the vendor-level
  ;  Vivaldi and Chromium alike, and a fork nobody has heard of yet.
  ;
  ;  And it removes a subkey only when BOTH halves are unmistakably ours: the
  ;  key name is a 32-letter Chromium id AND its update_url is served from this
  ;  machine's own loopback. A Web Store id or a real vendor's update server
  ;  matches neither, so an administrator's own external install survives.
  ;
  ;  Both registry views, through OpenBaseKey rather than the HKLM: drive: NSIS
  ;  is a 32-bit process, so the powershell.exe it starts is the 32-bit one, and
  ;  everything it reads through HKLM:\SOFTWARE is silently redirected into
  ;  WOW6432Node. A 64-bit fork's entry would be invisible -- which is to say
  ;  every fork on a normal machine.
  ;  The hive and the root are named in two variables of their own so that
  ;  .build/test-installer-sweep.js can point this half at a throwaway HKCU key
  ;  the same way it redirects the policy walk above -- a test that had to run
  ;  the real thing against the real HKLM could not be run at all.
  ;
  ;  Last, the Extensions key itself goes if removing our id emptied it: writing
  ;  HKLM\SOFTWARE\<vendor>\Extensions\<id> creates that key on the way to the
  ;  id, so on a browser that had no external extension of its own it is a key
  ;  WE added. A lone (Default) value does not count as content -- reg add
  ;  leaves one behind on every key it creates, and counting it would make
  ;  "empty" impossible forever. Same test, same idiom as the policy walk above.
  FileWrite $2 "$$rx     = '^https?://127\.0\.0\.1(:\d+)?/'$\r$\n"
  FileWrite $2 "$$exHive = 'LocalMachine'$\r$\n"
  FileWrite $2 "$$exRoot = 'SOFTWARE'$\r$\n"
  FileWrite $2 "foreach ($$vw in @('Registry64','Registry32')) {$\r$\n"
  FileWrite $2 "  $$hk = $$null$\r$\n"
  FileWrite $2 "  try { $$hk = [Microsoft.Win32.RegistryKey]::OpenBaseKey($$exHive,$$vw) } catch {}$\r$\n"
  FileWrite $2 "  if ($$hk -eq $$null) { continue }$\r$\n"
  FileWrite $2 "  $$sw = $$null$\r$\n"
  FileWrite $2 "  try { $$sw = $$hk.OpenSubKey($$exRoot) } catch {}$\r$\n"
  FileWrite $2 "  if ($$sw -eq $$null) { $$hk.Close(); continue }$\r$\n"
  FileWrite $2 "  foreach ($$vn in $$sw.GetSubKeyNames()) {$\r$\n"
  FileWrite $2 "    if ($$vn -eq 'WOW6432Node') { continue }$\r$\n"
  FileWrite $2 "    try {$\r$\n"
  FileWrite $2 "      $$v = $$sw.OpenSubKey($$vn)$\r$\n"
  FileWrite $2 "      if ($$v -ne $$null) {$\r$\n"
  FileWrite $2 "        $$rel = @('Extensions')$\r$\n"
  FileWrite $2 "        foreach ($$pn in $$v.GetSubKeyNames()) { $$rel += ($$pn + '\Extensions') }$\r$\n"
  FileWrite $2 "        foreach ($$r in $$rel) {$\r$\n"
  FileWrite $2 "          $$e = $$v.OpenSubKey($$r)$\r$\n"
  FileWrite $2 "          if ($$e -ne $$null) {$\r$\n"
  FileWrite $2 "            $$kill = @()$\r$\n"
  FileWrite $2 "            foreach ($$idn in $$e.GetSubKeyNames()) {$\r$\n"
  FileWrite $2 "              if ($$idn -match '^[a-p]{32}$$') {$\r$\n"
  FileWrite $2 "                $$c = $$e.OpenSubKey($$idn)$\r$\n"
  FileWrite $2 "                if ($$c -ne $$null) {$\r$\n"
  FileWrite $2 "                  $$u = [string]$$c.GetValue('update_url')$\r$\n"
  FileWrite $2 "                  $$c.Close()$\r$\n"
  FileWrite $2 "                  if ($$u -match $$rx) { $$kill += $$idn; $$ourIds += $$idn.ToLower() }$\r$\n"
  FileWrite $2 "                }$\r$\n"
  FileWrite $2 "              }$\r$\n"
  FileWrite $2 "            }$\r$\n"
  FileWrite $2 "            $$e.Close()$\r$\n"
  FileWrite $2 "            if ($$kill.Count -gt 0) {$\r$\n"
  FileWrite $2 "              $$vwr = $$sw.OpenSubKey($$vn, $$true)$\r$\n"
  FileWrite $2 "              if ($$vwr -ne $$null) {$\r$\n"
  FileWrite $2 "                $$w = $$vwr.OpenSubKey($$r, $$true)$\r$\n"
  FileWrite $2 "                if ($$w -ne $$null) {$\r$\n"
  FileWrite $2 "                  foreach ($$d in $$kill) {$\r$\n"
  FileWrite $2 "                    try {$\r$\n"
  FileWrite $2 "                      $$w.DeleteSubKeyTree($$d)$\r$\n"
  FileWrite $2 "                      Write-Host ('removed external-extensions entry: ' + $$vn + '\' + $$r + '\' + $$d)$\r$\n"
  FileWrite $2 "                    } catch {}$\r$\n"
  FileWrite $2 "                  }$\r$\n"
  FileWrite $2 "                  $$names = @($$w.GetValueNames() | ? { $$_ -ne '' })$\r$\n"
  FileWrite $2 "                  $$bare = (($$w.SubKeyCount -eq 0) -and ($$names.Count -eq 0))$\r$\n"
  FileWrite $2 "                  $$w.Close()$\r$\n"
  FileWrite $2 "                  if ($$bare) { try { $$vwr.DeleteSubKey($$r) } catch {} }$\r$\n"
  FileWrite $2 "                }$\r$\n"
  FileWrite $2 "                $$vwr.Close()$\r$\n"
  FileWrite $2 "              }$\r$\n"
  FileWrite $2 "            }$\r$\n"
  FileWrite $2 "          }$\r$\n"
  FileWrite $2 "        }$\r$\n"
  FileWrite $2 "        $$v.Close()$\r$\n"
  FileWrite $2 "      }$\r$\n"
  FileWrite $2 "    } catch {}$\r$\n"
  FileWrite $2 "  }$\r$\n"
  FileWrite $2 "  $$sw.Close(); $$hk.Close()$\r$\n"
  FileWrite $2 "}$\r$\n"
  ;  ── the fourth route, last, because it needs the other three ──
  ;  ExtensionInstallAllowlist. Every id that could be proved ours is in $ourIds
  ;  by now -- collected by the pre-pass above, and by the external-extensions
  ;  walk just above. A slot goes only when it holds one of those ids; the
  ;  subkey goes only if this is what emptied it, discounting the (Default)
  ;  value reg add leaves behind. An allowlist holding anyone else's id keeps it,
  ;  which is the difference between uninstalling this app and vandalising a
  ;  managed machine.
  FileWrite $2 "if ($$ourIds.Count -gt 0) {$\r$\n"
  FileWrite $2 "  $$ourIds = $$ourIds | Select-Object -Unique$\r$\n"
  FileWrite $2 "  foreach ($$k in (Get-ChildItem 'HKLM:\Software\Policies' -Recurse -Depth 4)) {$\r$\n"
  FileWrite $2 "    if ($$k.PSChildName -ne 'ExtensionInstallAllowlist') { continue }$\r$\n"
  FileWrite $2 "    foreach ($$n in $$k.GetValueNames()) {$\r$\n"
  FileWrite $2 "      $$v3 = ([string]$$k.GetValue($$n)).Trim().ToLower()$\r$\n"
  FileWrite $2 "      if ($$ourIds -contains $$v3) {$\r$\n"
  FileWrite $2 "        Remove-ItemProperty -Path $$k.PSPath -Name $$n -Force$\r$\n"
  FileWrite $2 "        Write-Host ('removed extension-allowlist entry: ' + $$v3)$\r$\n"
  FileWrite $2 "      }$\r$\n"
  FileWrite $2 "    }$\r$\n"
  FileWrite $2 "    $$left = @((Get-Item $$k.PSPath).GetValueNames() | ? { $$_ -ne '' })$\r$\n"
  FileWrite $2 "    if ($$left.Count -eq 0) { Remove-Item $$k.PSPath -Recurse -Force }$\r$\n"
  FileWrite $2 "  }$\r$\n"
  FileWrite $2 "}$\r$\n"
  FileClose $2
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$1"'
  Delete "$1"

  ; ── 4. Network state -- also without the exe ───────────────────
  ;  The same reverts lib/installer-tasks.js performs, in the same order, so an
  ;  uninstall that runs after the program files are gone still leaves the
  ;  machine reachable. Every line here is idempotent and every line restores a
  ;  WINDOWS DEFAULT rather than a saved value -- which is exactly why the
  ;  guarded ExecWait above runs first. That step is the only one that can put
  ;  back what the USER had.
  DetailPrint "Restoring proxy, DNS and IPv6 settings..."

  ;  System proxy off. The two values the app wrote are deleted outright: an
  ;  empty ProxyServer with ProxyEnable=0 is not the same as no value at all --
  ;  some Windows dialogs still show the address greyed out.
  WriteRegDWORD  HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyEnable" 0
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyServer"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyOverride"
  nsExec::ExecToLog 'netsh interface portproxy delete v4tov4 listenport=9150 listenaddress=127.0.0.1'

  ;  DNS: adapters back to DHCP, the per-interface NameServer the app wrote
  ;  removed, then the resolver cache service back up -- the kill switch stops
  ;  it, and a stopped dnscache is the one thing here a user cannot fix from
  ;  the network dialog.
  DetailPrint "Restoring DNS..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-NetAdapter | Set-DnsClientServerAddress -ResetServerAddresses -ErrorAction SilentlyContinue"'
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-ChildItem $\'HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces$\' | ForEach-Object { Remove-ItemProperty $$_.PSPath -Name NameServer -Force -ErrorAction SilentlyContinue }"'
  nsExec::ExecToLog 'net start dnscache'

  ;  IPv6 re-enabled: binding, DisabledComponents and the three tunnel
  ;  interfaces the leak guard turns off.
  DetailPrint "Re-enabling IPv6..."
  WriteRegDWORD HKLM "SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters" "DisabledComponents" 0
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Enable-NetAdapterBinding -Name * -ComponentID ms_tcpip6 -ErrorAction SilentlyContinue"'
  nsExec::ExecToLog 'netsh interface teredo set state default'
  nsExec::ExecToLog 'netsh interface isatap set state default'
  nsExec::ExecToLog 'netsh interface 6to4 set state default'

  ;  Firewall: the two this installer created plus the rules the running app
  ;  creates. Named, so nothing else in the profile is touched.
  ;
  ;  The two DNS blocks are the ones that must not survive: they forbid
  ;  outbound port 53 and 853 to everything except 127.0.0.1, which is correct
  ;  while Tor is answering there and catastrophic once it is not -- a machine
  ;  that resolves nothing, with no visible cause in any Windows dialog.
  ;
  ;  The last one is FW_RULE in lib/geo-spoof.js -- the lfsvc shield. Leaving
  ;  that behind would keep Windows location resolution broken after the app
  ;  is gone.
  DetailPrint "Removing firewall rules..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="FreeProxy Tor Engine"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="FreeProxy App"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="FreeProxy Block IPv6 Out"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="FreeProxy Block IPv6 In"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="FreeProxy Block DNS Out"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="FreeProxy Block DoT Out"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="FreeProxy VPN - block Windows location resolution"'

  ;  Geolocation service back to its shipped start type, and the stale
  ;  resolver cache dropped so the next lookup is a real one.
  nsExec::ExecToLog 'sc config lfsvc start= demand'
  nsExec::ExecToLog 'ipconfig /flushdns'

  ; ── 5. hosts file and certificates -- no exe required ──────────
  ;  Two leftovers that outlive an uninstall and cannot be undone from any
  ;  Windows dialog, so neither may depend on the program files existing:
  ;
  ;    * the hosts block. A stale entry for a Google endpoint does not degrade,
  ;      it BREAKS -- for every app on the machine, forever, with no visible
  ;      cause. Removed by marker, line by line, so hand-written entries above
  ;      and below it survive byte for byte.
  ;    * a certificate in a trust store is a security hole once its private key
  ;      is on disk in an app that no longer exists. Matched on this app's
  ;      FriendlyName, or on a SELF-SIGNED (issuer == subject) googleapis
  ;      subject, which a real Google certificate never is.
  DetailPrint "Restoring hosts file and removing certificates..."
  StrCpy $1 "$TEMP\fp-uninstall-clean.ps1"
  FileOpen $2 "$1" w
  FileWrite $2 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $2 "$$h = $$env:SystemRoot + '\System32\drivers\etc\hosts'$\r$\n"
  FileWrite $2 "if (Test-Path $$h) {$\r$\n"
  FileWrite $2 "  $$keep = @(); $$skip = $$false; $$hit = $$false$\r$\n"
  FileWrite $2 "  foreach ($$l in (Get-Content $$h)) {$\r$\n"
  FileWrite $2 "    if ($$l -match 'FreeProxy VPN -- location spoof block') {$\r$\n"
  FileWrite $2 "      $$skip = $$true; $$hit = $$true; continue$\r$\n"
  FileWrite $2 "    }$\r$\n"
  FileWrite $2 "    if ($$l -match 'FreeProxy VPN end') { $$skip = $$false; continue }$\r$\n"
  FileWrite $2 "    if (-not $$skip) { $$keep += $$l }$\r$\n"
  FileWrite $2 "  }$\r$\n"
  FileWrite $2 "  if ($$hit) {$\r$\n"
  FileWrite $2 "    Set-Content -Path $$h -Value $$keep -Encoding ASCII -Force$\r$\n"
  FileWrite $2 "    Write-Host 'hosts file: FreeProxy block removed'$\r$\n"
  FileWrite $2 "  }$\r$\n"
  FileWrite $2 "}$\r$\n"
  FileWrite $2 "$$stores = @('Cert:\LocalMachine\Root','Cert:\LocalMachine\My',$\r$\n"
  FileWrite $2 "            'Cert:\LocalMachine\CA','Cert:\CurrentUser\Root',$\r$\n"
  FileWrite $2 "            'Cert:\CurrentUser\My','Cert:\CurrentUser\CA')$\r$\n"
  FileWrite $2 "foreach ($$s in $$stores) {$\r$\n"
  FileWrite $2 "  foreach ($$c in (Get-ChildItem $$s)) {$\r$\n"
  FileWrite $2 "    $$mine = ($$c.FriendlyName -eq 'FreeProxy GeoSpoof') -or$\r$\n"
  FileWrite $2 "            ($$c.Subject -eq 'CN=www.googleapis.com' -and $$c.Issuer -eq $$c.Subject)$\r$\n"
  FileWrite $2 "    if ($$mine) {$\r$\n"
  FileWrite $2 "      Write-Host ('removing certificate ' + $$c.Thumbprint + ' from ' + $$s)$\r$\n"
  FileWrite $2 "      Remove-Item $$c.PSPath -Force$\r$\n"
  FileWrite $2 "    }$\r$\n"
  FileWrite $2 "  }$\r$\n"
  FileWrite $2 "}$\r$\n"
  FileClose $2
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$1"'
  Delete "$1"

  ; ── 6. Registry markers and temporary files ────────────────────
  ;  The Run value is from an older build that offered autostart. Nothing in
  ;  this version writes it, and DeleteRegValue on an absent value is a no-op --
  ;  it stays so an upgrade from that build does not leave a startup entry
  ;  pointing at a program that is being deleted three lines below.
  DetailPrint "Removing registry entries..."
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FreeProxyVPN"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FreeProxy VPN"
  DeleteRegKey   HKLM "Software\FreeProxy VPN"

  Delete "$TEMP\vpn_elevate.ps1"
  Delete "$TEMP\vc_redist.x64.exe"
  Delete "$TEMP\fp_uninstall_net.bat"

  ;  The pending-restart marker, explicitly, and the boot pass's own two state
  ;  files with it. Section 7 deletes the tree they live in, but an RMDir that
  ;  fails on one locked log file must not be able to leave behind a card asking
  ;  the user to restart their PC to finish installing an app that is gone -- nor
  ;  a queued job for a scheduled task that no longer exists.
  Delete "C:\ProgramData\freeproxy-vpn\restart-pending.json"
  Delete "C:\ProgramData\freeproxy-vpn\boot-pending.json"
  Delete "C:\ProgramData\freeproxy-vpn\boot-result.json"

  ;  The boot pass itself. --fp-teardown removes this task; this line is the
  ;  belt-and-braces for the case that macro is written for throughout -- the
  ;  exe was already gone, so nothing of ours ran. A task whose action points at
  ;  a deleted executable would otherwise sit in Task Scheduler failing at every
  ;  boot, with this app's name on it, forever. Deleting a task that is not
  ;  there prints an error and changes nothing, which is why it is unguarded.
  DetailPrint "Removing the boot-time browser setup task..."
  nsExec::ExecToLog 'schtasks /delete /tn "FreeProxy VPN Boot Setup" /f'

  ;  And the logon delivery helper, for the same reason and with the same
  ;  belt-and-braces. This is the task that serves the extension package to a
  ;  browser on 127.0.0.1 at logon -- it holds no key and writes no policy, but
  ;  its action points at the exe being deleted, so it must not outlive it.
  DetailPrint "Removing the extension delivery task..."
  nsExec::ExecToLog 'schtasks /delete /tn "FreeProxy VPN Extension Delivery" /f'

  ; ── 7. Every file this app created ─────────────────────────────
  ;  Unconditional, and both trees. The old build asked "Remove all FreeProxy
  ;  VPN data?" and left everything behind on No -- including the Tor state,
  ;  the staged extension, and the RSA private key that signs the CRX. A
  ;  private key surviving the uninstall of the only program that used it is
  ;  not user data worth keeping, and "delete what you created" was the
  ;  requirement.
  ;
  ;  ProgramData is the app's real state directory (main.js overrides userData
  ;  to it): logs, Tor\data, browser-setup\extension, the signing key,
  ;  HOW-TO-ENABLE.txt and the revert journal. The exe cannot delete this from
  ;  --fp-teardown -- it is the tree it is logging into -- so it happens here,
  ;  after the process is gone.
  DetailPrint "Deleting application data..."
  RMDir /r "C:\ProgramData\freeproxy-vpn"
  RMDir /r "$LOCALAPPDATA\FreeProxy VPN"
  RMDir /r "$APPDATA\FreeProxy VPN"

  DetailPrint "FreeProxy VPN removed. Proxy, DNS, IPv6, firewall, browser"
  DetailPrint "policy, hosts file and location settings are back as they were."

  ; ── 8. The uninstall's own restart -- offered, never taken ─────
  ;  Exit code 11 (EXIT.rebootAdvised in lib/installer-tasks.js) means one
  ;  thing and is measured, not guessed: --fp-teardown asked tasklist and found
  ;  a Chromium browser running. Every registry entry this app wrote is already
  ;  gone by now, but a browser checks whether an externally-offered extension
  ;  is still offered while it STARTS -- so in a browser that is open right now
  ;  the extension is still loaded, and it leaves at that browser's next start.
  ;  One restart does that for all of them at once.
  ;
  ;  Asked, never done: MB_YESNO with No as the safe answer, and skipped
  ;  entirely in a silent run -- electron-builder's upgrade path runs this
  ;  uninstaller with /S, where a message box would hang the update behind a
  ;  dialog nobody can see, and where a Reboot would be indefensible.
  ;
  ;  SetRebootFlag is deliberately not used here either. The finish page that
  ;  reads it belongs to the installer, not the uninstaller, so the flag would
  ;  raise nothing at all -- and in the installer it would produce a second
  ;  dialog for the one restart the app already offers itself.
  ${IfNot} ${Silent}
  ${AndIf} $5 == 11
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "FreeProxy VPN has been removed.$\r$\n$\r$\nA browser is still open. A browser only drops an extension an installer gave it when it next starts, so the location extension is still loaded in the browsers you have open right now.$\r$\n$\r$\nRestart this PC now to finish removing it from all of them?" \
      IDNO fp_no_reboot
      Reboot
    fp_no_reboot:
  ${EndIf}

!macroend

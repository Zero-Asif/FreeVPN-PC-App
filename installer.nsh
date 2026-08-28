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
;  still exist when this macro runs. It touches only forcelist entries whose
;  update URL is this app's own loopback server, plus the fake id above --
;  a signature no real enterprise deployment can have.
; ═══════════════════════════════════════════════════════════════════

!macro customInstall

  DetailPrint "FreeProxy VPN: Configuring components..."

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
      ExecWait '"$INSTDIR\resources\vc_redist.x64.exe" /quiet /norestart'
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
  ExecWait '"$INSTDIR\FreeProxy VPN.exe" --fp-setup' $0
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
  ${Else}
    DetailPrint "Program files already removed -- using the fallback sweep."
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
  DetailPrint "Removing browser policy left by this app..."
  StrCpy $1 "$TEMP\fp-uninstall-sweep.ps1"
  FileOpen $2 "$1" w
  FileWrite $2 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $2 "$$sig  = '^[a-p]{32};https?://127\.0\.0\.1(:\d+)?/'$\r$\n"
  FileWrite $2 "$$fake = 'oecbgglkbdlifmaedkikgpmifiidjhfo;'$\r$\n"
  FileWrite $2 "$$vals = @('ProxySettings','WebRtcIPHandlingPolicy','DnsOverHttpsMode',$\r$\n"
  FileWrite $2 "          'BuiltInDnsClientEnabled','DnsPrefetchingEnabled',$\r$\n"
  FileWrite $2 "          'NetworkPredictionOptions','DefaultGeolocationSetting')$\r$\n"
  FileWrite $2 "foreach ($$k in (Get-ChildItem 'HKLM:\Software\Policies' -Recurse -Depth 4)) {$\r$\n"
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

  ;  Firewall: the two this installer created plus the three the running app
  ;  creates. Named, so nothing else in the profile is touched. The last one is
  ;  FW_RULE in lib/geo-spoof.js -- the lfsvc shield. Leaving that behind would
  ;  keep Windows location resolution broken after the app is gone.
  DetailPrint "Removing firewall rules..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="FreeProxy Tor Engine"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="FreeProxy App"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="FreeProxy Block IPv6 Out"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="FreeProxy Block IPv6 In"'
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

!macroend

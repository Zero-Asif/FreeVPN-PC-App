; ═══════════════════════════════════════════════════════════════════
;  FreeProxy VPN — NSIS Custom Installer Script  (Point 6)
;
;  Install এ automatically হবে:
;    1. Windows Firewall exception (tor.exe + app)
;    2. Visual C++ Redistributable check & install
;    3. AppData directories তৈরি (proper permissions)
;    4. Chrome + Edge extension force-install
;    5. Registry markers
;
;  Uninstall এ automatically হবে:
;    1. tor.exe terminate
;    2. System proxy, DNS, IPv6 restore
;    3. Firewall rules delete
;    4. Extensions remove
;    5. Registry cleanup
;    6. AppData cleanup (user choice)
; ═══════════════════════════════════════════════════════════════════

!macro customInstall

  DetailPrint "FreeProxy VPN: Configuring components..."

  ; ── 1. Windows Firewall: tor.exe allow ─────────────────────────
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
      nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { $url=''https://aka.ms/vs/17/release/vc_redist.x64.exe''; $out=''$env:TEMP\vc_redist.x64.exe''; (New-Object Net.WebClient).DownloadFile($url,$out); Start-Process -FilePath $out -ArgumentList ''/quiet /norestart'' -Wait } catch { Write-Host ''VC++ download failed'' }"'
    ${EndIf}
    DetailPrint "Visual C++ Runtime ready."
  ${Else}
    DetailPrint "Visual C++ Runtime already installed."
  ${EndIf}

  ; ── 3. AppData directories ─────────────────────────────────────
  DetailPrint "Creating application directories..."
  CreateDirectory "$LOCALAPPDATA\FreeProxy VPN"
  CreateDirectory "$LOCALAPPDATA\FreeProxy VPN\logs"
  CreateDirectory "$LOCALAPPDATA\FreeProxy VPN\Tor"
  CreateDirectory "$LOCALAPPDATA\FreeProxy VPN\Tor\data"
  CreateDirectory "$LOCALAPPDATA\FreeProxy VPN\Tor\data\keys"

  ; ── 4. Chrome Extension force-install ──────────────────────────
  DetailPrint "Registering browser extensions..."
  WriteRegStr HKLM "Software\Policies\Google\Chrome\ExtensionInstallForcelist" "1" "oecbgglkbdlifmaedkikgpmifiidjhfo;https://clients2.google.com/service/update2/crx"

  ; ── 5. Edge Extension force-install ────────────────────────────
  WriteRegStr HKLM "Software\Policies\Microsoft\Edge\ExtensionInstallForcelist" "1" "oecbgglkbdlifmaedkikgpmifiidjhfo;https://edge.microsoft.com/extensionwebstorebase/v1/crx"

  ; ── 6. Registry markers ────────────────────────────────────────
  WriteRegStr  HKLM "Software\FreeProxy VPN" "InstallPath" "$INSTDIR"
  WriteRegStr  HKLM "Software\FreeProxy VPN" "Version"     "1.0.0"
  WriteRegDWORD HKLM "Software\FreeProxy VPN" "FirewallConfigured" 1

  DetailPrint "FreeProxy VPN setup complete!"

!macroend

!macro customUnInstall

  DetailPrint "FreeProxy VPN: Removing components..."

  ; ── 1. Stop tor.exe ────────────────────────────────────────────
  nsExec::ExecToLog 'taskkill /F /IM tor.exe'

  ; ── 2. Remove system proxy ─────────────────────────────────────
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyEnable" 0
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyServer" ""

  ; ── 3. Restore DNS ─────────────────────────────────────────────
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-NetAdapter | Where-Object {$_.Status -eq ''Up''} | ForEach-Object { Set-DnsClientServerAddress -InterfaceAlias $_.Name -ResetServerAddresses }"'

  ; ── 4. Restore IPv6 ────────────────────────────────────────────
  WriteRegDWORD HKLM "SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters" "DisabledComponents" 0
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-NetAdapter | Where-Object {$_.Status -eq ''Up''} | ForEach-Object { Enable-NetAdapterBinding -Name $_.Name -ComponentID ms_tcpip6 -ErrorAction SilentlyContinue }"'
  nsExec::ExecToLog 'netsh interface teredo set state default'
  nsExec::ExecToLog 'netsh interface isatap set state default'
  nsExec::ExecToLog 'netsh interface 6to4 set state default'
  nsExec::ExecToLog 'ipconfig /flushdns'

  ; ── 5. Remove firewall rules ────────────────────────────────────
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="FreeProxy Tor Engine"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="FreeProxy App"'

  ; ── 6. Remove browser extensions ───────────────────────────────
  DeleteRegValue HKLM "Software\Policies\Google\Chrome\ExtensionInstallForcelist" "1"
  DeleteRegValue HKLM "Software\Policies\Microsoft\Edge\ExtensionInstallForcelist" "1"

  ; ── 7. Remove startup entry (if existed) ───────────────────────
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FreeProxyVPN"

  ; ── 8. Remove registry keys ────────────────────────────────────
  DeleteRegKey HKLM "Software\FreeProxy VPN"

  ; ── 9. AppData cleanup — user choice ───────────────────────────
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Remove all FreeProxy VPN data?$\n$\n(Logs and settings in:$\n$LOCALAPPDATA\FreeProxy VPN)" \
    IDNO done_uninstall
    RMDir /r "$LOCALAPPDATA\FreeProxy VPN"
  done_uninstall:

  DetailPrint "FreeProxy VPN removed successfully."

!macroend

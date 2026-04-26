!macro customInstall
  ; Push registration id into Chrome
  WriteRegStr HKLM "Software\Policies\Google\Chrome\ExtensionInstallForcelist" "1" "oecbgglkbdlifmaedkikgpmifiidjhfo;https://clients2.google.com/service/update2/crx"
  
  ; Push registration id into Edge
  WriteRegStr HKLM "Software\Policies\Microsoft\Edge\ExtensionInstallForcelist" "1" "oecbgglkbdlifmaedkikgpmifiidjhfo;https://edge.microsoft.com/extensionwebstorebase/v1/crx"
!macroend

!macro customUnInstall
  ; Extension Remove after uninstalling app
  DeleteRegValue HKLM "Software\Policies\Google\Chrome\ExtensionInstallForcelist" "1"
  DeleteRegValue HKLM "Software\Policies\Microsoft\Edge\ExtensionInstallForcelist" "1"
!macroend
; Extra NSIS steps for the Notch Picker installer (included by electron-builder).

; Uninstalling removes the Copilot CLI hook that "Approve from the notch" may have added,
; so no session keeps calling a program that is no longer installed.
!macro customUnInstall
  Delete "$PROFILE\.copilot\hooks\copilot-notch.json"
!macroend

!macro customUnInstall
  nsExec::ExecToStack '"$INSTDIR\Codex Model Checker.exe" --restore-proxy'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Codex configuration restore failed. Open Model Checker and restore the proxy before uninstalling."
    Abort
  ${EndIf}
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Codex Model Checker"
!macroend

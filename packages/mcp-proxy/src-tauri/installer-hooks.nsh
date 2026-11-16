; Remove only the application's receipt-verified URI before removing its runtime.
!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToStack /TIMEOUT=90000 '"$INSTDIR\mcp-proxy.exe" --uninstall'
  Pop $R0
  Pop $R1
  ${If} $R0 != 0
    SetErrorLevel 1
    Abort "Cannot verify and remove this installation's URI. Close the application and retry."
  ${EndIf}
!macroend

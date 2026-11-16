; BrainAI's installer hooks (D6). An update or reinstall while BrainAI runs: its server (node.exe in this folder) keeps
; its files open after the app itself is closed. Stop only that one, never another node.exe on this computer, then
; clear the old server folder so no file from an older version stays behind. The data folder is elsewhere
; (%LOCALAPPDATA%\io.github.jsr1292.brainai) and is never touched.
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq '$INSTDIR\node.exe' } | Stop-Process -Force"`
  Pop $0
  Sleep 1000
  RMDir /r "$INSTDIR\server"
!macroend

; Uninstalling for good: take BrainAI's entries out of the owner's AI tools first, with the server's own command, which
; reads the port from the data folder. It must not run when this uninstaller is only the first half of an upgrade:
; Tauri sets $UpdateMode only for its own /UPDATE, but a newer setup.exe ("Uninstall before installing") runs the old
; uninstaller in place (_?=$INSTDIR, so $EXEDIR equals $INSTDIR). An uninstall from Windows Settings, or the app's own
; `uninstall.exe /S`, first copies itself to %TEMP%, so $EXEDIR differs: only then are the tools disconnected. This
; hook runs before Tauri's "BrainAI is running" check. Hidden, and whatever the command answers is ignored, so it
; can never stop the uninstall.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
  ${AndIf} $EXEDIR != $INSTDIR
    nsExec::Exec `cmd /c set "DATA_DIR=$LOCALAPPDATA\io.github.jsr1292.brainai" && "$INSTDIR\node.exe" "$INSTDIR\server\dist\cli.js" disconnect-tools`
    Pop $0
  ${EndIf}
!macroend

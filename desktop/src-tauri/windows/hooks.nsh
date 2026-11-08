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

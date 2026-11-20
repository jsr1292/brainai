; BrainAI's installer hooks (D6). An update or reinstall while BrainAI runs: its server (node.exe in this folder) keeps
; its files open after the app itself is closed. Stop only that one, never another node.exe on this computer, then
; clear the old server folder so no file from an older version stays behind. The data folder is elsewhere
; (%LOCALAPPDATA%\io.github.jsr1292.brainai) and is never touched.
; The installer now runs silently for updates (installMode "quiet": /S /UPDATE /R). Nothing in these hooks may show a
; dialog or wait for input: no MessageBox (it would need an /SD default); only hidden nsExec commands and a silent Abort.
!macro NSIS_HOOK_PREINSTALL
  ; The marker comes FIRST, before the app is stopped: an app opened during the stop phase waits too. The template's own
  ; CheckIfAppIsRunning can abort without running our cleanup and leave the marker behind, so the app trusts a marker for
  ; 3 minutes only (updating.rs); our own Abort below deletes it.
  FileOpen $R9 "$INSTDIR\updating" w
  FileWrite $R9 "${VERSION}"
  FileClose $R9
  ; This hook runs before the template's own CheckIfAppIsRunning, so it does the same first: brainai.exe is shut down
  ; with the Restart Manager (forced when silent), and the install is aborted, before anything is deleted, if it
  ; cannot be stopped. Silent: no dialog, no MessageBox.
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  ; Then this folder's own node.exe (the server) and only that one: stopped, and waited for up to 5 seconds until it is
  ; really gone (exit code 0). If it is still there, abort: the server folder is not removed under a running server.
  ; The folder goes to PowerShell in an environment variable, never inside the command text: a path with an apostrophe
  ; (C:\Users\O'Brien\...) would break a quoted string. Exit code 1 is the one definite answer "still running".
  System::Call 'kernel32::SetEnvironmentVariableW(w "BRAINAI_NODE", w "$INSTDIR\node.exe")'
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$mine = { Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq $$env:BRAINAI_NODE } }; & $$mine | Stop-Process -Force -ErrorAction SilentlyContinue; for ($$i = 0; $$i -lt 20; $$i++) { if (-not (& $$mine)) { exit 0 }; Start-Sleep -Milliseconds 250 }; exit 1"`
  Pop $0
  ; Abort only on that definite answer. Any other result ("error" when powershell.exe is blocked or missing, "timeout", a
  ; parse error) means we could not tell: skip clearing the server folder but go on with the install, whose own
  ; CheckIfAppIsRunning (above) has already made sure the app is gone. Aborting there would leave a silent update half
  ; done with the app closed and /R never run: BrainAI would just vanish, on every update.
  ${If} $0 == "1"
    Delete "$INSTDIR\updating"
    Abort
  ${EndIf}
  ${If} $0 == "0"
    ; Clear the old server folder so no file from an older version stays behind.
    RMDir /r "$INSTDIR\server"
  ${EndIf}
!macroend

; The copy is done (the template's /R relaunch comes after this): let a waiting app go on. Silent, nothing to answer.
!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\updating"
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

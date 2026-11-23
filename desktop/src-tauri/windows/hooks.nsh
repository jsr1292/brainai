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
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$mine = { Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq $$env:BRAINAI_NODE } }; & $$mine | Stop-Process -Force -ErrorAction SilentlyContinue; for ($$i = 0; $$i -lt 20; $$i++) { if (-not (& $$mine)) { exit 0 }; Start-Sleep -Milliseconds 250 }; exit 1"`
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

; Uninstalling for good. Everything here is skipped when $UpdateMode = 1 (Tauri's own /UPDATE, the first half of an upgrade).
; There are two ways a real uninstall reaches here, and both must be safe:
;   * Windows Settings, or the app's own `uninstall.exe /S`: the uninstaller first copies itself to %TEMP%, so
;     $EXEDIR differs from $INSTDIR.
;   * Tauri's setup.exe ("Uninstall BrainAI" on the same version, "Uninstall before installing" on an upgrade) runs the
;     old uninstaller IN PLACE (_?=$INSTDIR, so $EXEDIR equals $INSTDIR) with its full window, where the delete-data box
;     can be ticked, and the template then deletes the data when $DeleteAppDataCheckboxState = 1 and $UpdateMode <> 1.
; So the tools are disconnected when $EXEDIR differs, or whenever the box is ticked (the brain is going away); and the
; copy depends on the box alone. Order (this hook runs BEFORE the template's own CheckIfAppIsRunning, which we do first,
; so a Cancel on "BrainAI is running" leaves BrainAI connected and its tools untouched):
;   1. the running check (Restart Manager; its OK/Cancel dialog, or forced when silent);
;   2. this folder's node.exe (the server) stopped, so it is not left locked and the database is quiet;
;   3. BrainAI's entries taken out of the owner's AI tools with the server's own command (it reads the port from the data
;      folder, looks for the tools on the same PATH the app connected them on, ends their sign-ins, removes the hooks);
;   4. only when "Delete the application data" was ticked: a saved copy of the brain into Documents FIRST (the same
;      folder Settings > Remove BrainAI makes). If no copy can be made, the checkbox state is cleared so the template
;      does NOT delete the data, and a message says so. With no database there is nothing to copy and deletion goes on.
; $DeleteAppDataCheckboxState is set in un.ConfirmLeave, long before Section Uninstall; it stays 0 in silent (/S) and
; passive (/P) runs, where that page is skipped, so those never copy and never delete data.
; Paths go to the programs in environment variables, never inside a command line (an apostrophe or a space in a user
; name would break a quoted string), and no cmd.exe is involved. Hidden throughout; the one message box is a failed copy.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ${If} $EXEDIR != $INSTDIR
    ${OrIf} $DeleteAppDataCheckboxState = 1
      !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
      ; Only this folder's node.exe, never another one on this computer. The answer is not needed: whatever it is, the
      ; uninstall goes on.
      System::Call 'kernel32::SetEnvironmentVariableW(w "BRAINAI_NODE", w "$INSTDIR\node.exe")'
      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$mine = { Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq $$env:BRAINAI_NODE } }; & $$mine | Stop-Process -Force -ErrorAction SilentlyContinue; for ($$i = 0; $$i -lt 20; $$i++) { if (-not (& $$mine)) { exit 0 }; Start-Sleep -Milliseconds 250 }; exit 1"`
      Pop $0
      System::Call 'kernel32::SetEnvironmentVariableW(w "DATA_DIR", w "$LOCALAPPDATA\io.github.jsr1292.brainai")'
      nsExec::Exec `"$INSTDIR\node.exe" "$INSTDIR\server\dist\cli.js" disconnect-tools`
      Pop $0
    ${EndIf}
    ${If} $DeleteAppDataCheckboxState = 1
    ${AndIf} ${FileExists} "$LOCALAPPDATA\io.github.jsr1292.brainai\data\memory.db"
      ; The user's own Documents (it may have moved, e.g. into OneDrive), whatever the install mode's shell context is,
      ; without a trailing backslash.
      SetShellVarContext current
      StrCpy $R8 "$DOCUMENTS"
      !insertmacro SetContext
      StrCpy $R9 $R8 1 -1
      ${If} $R9 == "\"
        StrCpy $R8 $R8 -1
      ${EndIf}
      ; The server's data folder is the "data" folder inside the app data folder. Exit code 0 means the copy is whole
      ; (the CLI checks the archive before it leaves the folder); anything else, including "error", means no copy.
      System::Call 'kernel32::SetEnvironmentVariableW(w "DATA_DIR", w "$LOCALAPPDATA\io.github.jsr1292.brainai\data")'
      System::Call 'kernel32::SetEnvironmentVariableW(w "BRAINAI_COPY_TO", w "$R8")'
      nsExec::Exec `"$INSTDIR\node.exe" "$INSTDIR\server\dist\cli.js" save-copy --app`
      Pop $0
      ${If} $0 != "0"
        StrCpy $DeleteAppDataCheckboxState 0
        ; 1034 is Spanish (LANG_SPANISH is only defined when the installer includes that language).
        ${If} $LANGUAGE = 1034
          MessageBox MB_OK|MB_ICONEXCLAMATION|MB_TOPMOST "No se pudo guardar una copia de tu memoria en Documentos, por eso BrainAI ha conservado tus datos sin borrarlos. Siguen en $LOCALAPPDATA\io.github.jsr1292.brainai." /SD IDOK
        ${Else}
          MessageBox MB_OK|MB_ICONEXCLAMATION|MB_TOPMOST "BrainAI could not save a copy of your memory to Documents, so your data was kept and not deleted. It is in $LOCALAPPDATA\io.github.jsr1292.brainai." /SD IDOK
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

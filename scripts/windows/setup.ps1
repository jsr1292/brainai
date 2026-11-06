# Installs the work memory on this laptop, or updates it from a newer zip (your memories are kept):
#   1. copies it to %LOCALAPPDATA%\WorkMemory and writes its settings (work.env),
#   2. on first install, asks for a dashboard password and sets up your authenticator app,
#   3. starts it now and at every login (a shortcut in your Startup folder), with a Start menu link to the dashboard,
#   4. connects Codex and Claude Code (when installed) and adds the memory rules to their AGENTS.md / CLAUDE.md,
#   5. lets either of them ask the other in a discussion by itself (ASK_COMMANDS in work.env).
# Run from the unzipped folder:  powershell -ExecutionPolicy Bypass -File .\setup.ps1
param([int]$Port = 3100)
. (Join-Path $PSScriptRoot 'common.ps1')

if ($PSScriptRoot -ne $Install) {
  Write-Host "Copying the work memory to $Install ..."
  Stop-Memory
  New-Item -ItemType Directory -Force $Install | Out-Null
  # Full paths, so only the install's own data, logs, backups and settings are kept (and never purged by /MIR),
  # not any folder of the same name inside the app. /R:3 /W:2: a locked file fails in seconds instead of hanging.
  $keepDirs = @('data', 'logs', 'backups') | ForEach-Object { Join-Path $Install $_ }
  robocopy $PSScriptRoot $Install /MIR /XD $keepDirs /XF (Join-Path $Install 'work.env') /R:3 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copying to $Install failed (robocopy exit code $LASTEXITCODE)." }
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Install 'setup.ps1') -Port $Port
  exit $LASTEXITCODE
}

Get-ChildItem -Path $Install -Recurse -File | Unblock-File
$data = Join-Path $Install 'data'
# Written once the password and authenticator are both set, so an interrupted first setup asks again.
$loginReady = Join-Path $data '.login-ready'
$firstInstall = -not (Test-Path $loginReady)

if (-not (Test-Path $EnvFile)) {
  if ($env:OneDriveCommercial) { $backups = Join-Path $env:OneDriveCommercial 'Work memory backups' }
  else { $backups = Join-Path $Install 'backups' }
  # Forward slashes: Node accepts them on Windows, and a backslash inside quotes could read as an escape (\n).
  $slash = { param($p) $p.Replace('\', '/') }
  Write-Utf8 $EnvFile @"
MEMORY_MODE=work
PORT=$Port
PUBLIC_URL=http://localhost:$Port
DATA_DIR="$(& $slash $data)"
MODEL_DIR="$(& $slash (Join-Path $AppDir 'models'))"
BACKUP_DIR="$(& $slash $backups)"
NODE_ENV=production
"@
  Write-Host "Settings written to $EnvFile (backups go to $backups)."
}

# How the assistant that opens a discussion asks the other one itself (keys are the connection names). Both commands
# work from Git Bash (Claude Code's shell) and PowerShell (Codex's). Written on every setup, so updates get it too.
$ask = '{"Codex":"codex exec --skip-git-repo-check \"{prompt}\"","Claude Code":"claude -p \"{prompt}\" --allowedTools mcp__work-memory"}'
Set-EnvLine 'ASK_COMMANDS' "'$ask'"

if ($firstInstall) {
  Write-Host ''
  Write-Host 'Choose a password for the work memory dashboard (at least 12 characters).'
  Invoke-MemoryCli set-password
  Write-Host ''
  Write-Host 'Now add the dashboard to your authenticator app (the same kind of app as for the home memory).'
  Invoke-MemoryCli setup-totp
  Write-Utf8 $loginReady "$(Get-Date -Format s)`n"
}

# Codex identifies itself with a document on chatgpt.com, and the memory only reads such documents from sites on
# its allowlist (a fresh copy lists only Claude's). Safe to repeat.
Invoke-MemoryCli redirects add https://chatgpt.com/oauth/codex/ | Out-Null

# Start at every login, hidden.
$startup = [Environment]::GetFolderPath('Startup')
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path $startup 'Work memory.lnk'))
$link.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$link.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $Install 'start.ps1')`""
$link.WindowStyle = 7
$link.Description = 'Starts the work memory'
$link.Save()

# A Start menu link to the dashboard. Always localhost: the login page refuses 127.0.0.1.
$programs = [Environment]::GetFolderPath('Programs')
Write-Utf8 (Join-Path $programs 'Work memory dashboard.url') "[InternetShortcut]`r`nURL=http://localhost:$(Get-MemoryPort)/`r`n"

Stop-Memory
Start-Memory
Write-Host 'Starting the work memory (the first start loads the search model, about half a minute) ...'
if (-not (Wait-Memory)) { throw "The work memory did not start. See $(Join-Path $LogDir 'server.log')." }
Write-Host "Running. Dashboard: http://localhost:$(Get-MemoryPort)/"

$rules = @'
## Work memory

I have a work memory (MCP server "work-memory") on this laptop. At the start of each session, load my profile from it. Before answering anything about past work, my repos or my jobs, recall from it. Save decisions, conclusions and lasting facts as we go, and save or update a short status when a task finishes with something to carry over. If the memory server is missing, needs a login, or a call fails, tell me right away. When I ask you to discuss something with the other assistant, open a discussion in the work memory and do what its tools tell you.
'@
Set-AgentsBlock $rules
Write-Host "Memory rules added to $(Join-Path (Get-CodexHome) 'AGENTS.md')."

$url = "http://localhost:$(Get-MemoryPort)/mcp"
$codex = Get-Command codex -ErrorAction SilentlyContinue
$connected = $false
if ($codex) {
  # Through cmd: with $ErrorActionPreference = 'Stop', Windows PowerShell 5.1 turns a redirected stderr line from a
  # native command into a terminating error, and codex prints one when the server is not added yet.
  cmd /d /c "codex mcp get work-memory >nul 2>&1"
  $connected = ($LASTEXITCODE -eq 0)
}
if ($codex -and -not $connected) {
  Write-Host ''
  Write-Host 'Connecting Codex. Your browser will open: log in to the dashboard and approve Codex.'
  # codex mcp add also signs in (it opens the browser and waits for the approval).
  & codex mcp add work-memory --url $url
  if ($LASTEXITCODE -ne 0) { throw 'Connecting Codex failed. Run it again: codex mcp login work-memory' }
}
Set-CodexServer $url
if ($codex) {
  Write-Host 'Done. Start a new Codex session and it will use the work memory.'
  if ($connected) { Write-Host 'Codex was already connected. If it says the memory needs a login: codex mcp login work-memory' }
} else {
  Write-Host ''
  Write-Host "The codex command was not found. The memory is added to Codex's settings; once Codex is installed, sign in with:"
  Write-Host '  codex mcp login work-memory'
}

# Claude Code: added for every project of this Windows user. It signs in on first use, from inside Claude Code.
$claude = Get-Command claude -ErrorAction SilentlyContinue
if ($claude) {
  Set-ClaudeBlock $rules
  Write-Host "Memory rules added to $(Join-Path (Get-ClaudeHome) 'CLAUDE.md')."
  cmd /d /c "claude mcp get work-memory >nul 2>&1"
  if ($LASTEXITCODE -ne 0) {
    & claude mcp add --transport http --scope user work-memory $url
    if ($LASTEXITCODE -ne 0) { throw 'Adding the memory to Claude Code failed. Run it again: claude mcp add --transport http --scope user work-memory ' + $url }
  }
  Write-Host 'Claude Code: start it, type /mcp, choose work-memory and Authenticate (log in to the dashboard and approve Claude Code).'
} else {
  Write-Host 'Claude Code is not installed. Once it is, run this setup again to connect it.'
}

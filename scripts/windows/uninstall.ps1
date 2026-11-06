# Removes the work memory from this laptop: exports your memories to Documents first, then stops it, removes the
# Startup and Start menu shortcuts, disconnects Codex and Claude Code, removes the rules from their AGENTS.md and
# CLAUDE.md, and deletes %LOCALAPPDATA%\WorkMemory. Backups in OneDrive are left for you to keep or delete.
. (Join-Path $PSScriptRoot 'common.ps1')

$answer = Read-Host "This deletes the work memory and everything in it. Type delete to continue"
if ($answer -ne 'delete') { Write-Host 'Nothing was changed.'; exit 1 }

$export = Join-Path ([Environment]::GetFolderPath('MyDocuments')) "work-memory-$(Get-Date -Format yyyy-MM-dd).md"
Invoke-MemoryCli export $export
Stop-Memory
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path ([Environment]::GetFolderPath('Startup')) 'Work memory.lnk')
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path ([Environment]::GetFolderPath('Programs')) 'Work memory dashboard.url')
if (Get-Command codex -ErrorAction SilentlyContinue) { & codex mcp remove work-memory | Out-Null }
if (Get-Command claude -ErrorAction SilentlyContinue) { cmd /d /c "claude mcp remove --scope user work-memory >nul 2>&1" }
Set-AgentsBlock ''
Set-ClaudeBlock ''
# Both: Set-Location alone leaves the process's own working directory inside the folder in Windows PowerShell 5.1.
Set-Location $env:TEMP
[Environment]::CurrentDirectory = $env:TEMP
Remove-Item -Recurse -Force $Install
Write-Host "Removed. Your memories were exported to $export."

# Shared by the work memory's Windows scripts. Windows PowerShell 5.1 compatible (no ?? or ternaries).
$ErrorActionPreference = 'Stop'

$Install = Join-Path $env:LOCALAPPDATA 'WorkMemory'
$Node = Join-Path $Install 'node\node.exe'
$AppDir = Join-Path $Install 'app'
$EnvFile = Join-Path $Install 'work.env'
$LogDir = Join-Path $Install 'logs'

function Write-Utf8([string]$Path, [string]$Text) {
  # Node reads the env file as UTF-8; Windows PowerShell's Out-File would write UTF-16.
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

function Get-MemoryPort {
  if (-not (Test-Path $EnvFile)) { return 3100 }
  $line = Get-Content $EnvFile | Where-Object { $_ -match '^PORT=' } | Select-Object -First 1
  if ($line) { return [int]($line -replace '^PORT=', '') }
  return 3100
}

# The work memory's own node.exe processes, found by path: this also catches one still loading the search model
# (not yet listening), and never touches anyone else's node.
function Get-MemoryProcess {
  Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Node }
}

function Stop-Memory {
  $procs = @(Get-MemoryProcess)
  foreach ($p in $procs) { Stop-Process -Id $p.Id -Force }
  # Stop-Process returns before the process is gone, and its files stay locked until then.
  foreach ($p in $procs) { Wait-Process -Id $p.Id -Timeout 15 -ErrorAction SilentlyContinue }
}

function Start-Memory {
  if (@(Get-MemoryProcess).Count -gt 0) { return }
  New-Item -ItemType Directory -Force $LogDir | Out-Null
  $log = Join-Path $LogDir 'server.log'
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item -Force $log "$log.old" }
  $index = Join-Path $AppDir 'dist\index.js'
  # cmd.exe runs hidden and node shares its hidden console; >> keeps a log across restarts.
  $cmd = "/d /c `"`"$Node`" --env-file=`"$EnvFile`" `"$index`" >> `"$log`" 2>&1`""
  Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList $cmd -WorkingDirectory $AppDir -WindowStyle Hidden
}

function Wait-Memory([int]$Seconds = 90) {
  $url = "http://localhost:$(Get-MemoryPort)/.well-known/oauth-authorization-server"
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $url | Out-Null
      return $true
    } catch { Start-Sleep -Seconds 2 }
  }
  return $false
}

# Runs the memory's command-line tool (set-password, setup-totp, export, clients ...).
function Invoke-MemoryCli {
  & $Node "--env-file=$EnvFile" (Join-Path $AppDir 'dist\cli.js') @args
  if ($LASTEXITCODE -ne 0) { throw "The memory command '$($args[0])' failed." }
}

# work.env with the line NAME=... set to $Value (replaced, or added at the end).
function Set-EnvLine([string]$Name, [string]$Value) {
  $lines = @()
  if (Test-Path $EnvFile) { $lines = @(Get-Content $EnvFile | Where-Object { $_ -notmatch "^$Name=" }) }
  Write-Utf8 $EnvFile ((($lines + "$Name=$Value") -join "`n") + "`n")
}

function Get-ClaudeHome {
  if ($env:CLAUDE_CONFIG_DIR) { return $env:CLAUDE_CONFIG_DIR }
  return Join-Path $env:USERPROFILE '.claude'
}

function Get-CodexHome {
  if ($env:CODEX_HOME) { return $env:CODEX_HOME }
  return Join-Path $env:USERPROFILE '.codex'
}

# Codex's config.toml with a [mcp_servers.work-memory] section for $Url whose tools run without asking each time
# ("approve"): the memory is local, deletions can be undone on the dashboard, and anything that reads like an
# instruction is held for your approval. Adds the section when missing; keeps everything else as it is.
function Set-CodexServer([string]$Url) {
  $dir = Get-CodexHome
  New-Item -ItemType Directory -Force $dir | Out-Null
  $path = Join-Path $dir 'config.toml'
  $text = ''
  if (Test-Path $path) { $text = [IO.File]::ReadAllText($path) }
  $header = '[mcp_servers.work-memory]'
  if (-not $text.Contains($header)) {
    if ($text -and -not $text.EndsWith("`n")) { $text += "`n" }
    if ($text) { $text += "`n" }
    $text += "$header`nurl = `"$Url`"`n"
  }
  # The section runs from its header to the next [table] header or the end of the file.
  $m = [regex]::Match($text, '(?ms)^\[mcp_servers\.work-memory\][ \t]*\r?$.*?(?=^\[|\z)')
  if (-not $m.Success) { throw "Could not find the work-memory section in $path." }
  $section = $m.Value
  if ($section -notmatch '(?m)^default_tools_approval_mode\s*=') {
    $section = $section.TrimEnd() + "`ndefault_tools_approval_mode = `"approve`"`n"
    if ($m.Index + $m.Length -lt $text.Length) { $section += "`n" }
    $text = $text.Substring(0, $m.Index) + $section + $text.Substring($m.Index + $m.Length)
  }
  Write-Utf8 $path $text
}

$AgentsStart = '<!-- work-memory:start -->'
$AgentsEnd = '<!-- work-memory:end -->'

# A rules file (Codex's AGENTS.md, Claude Code's CLAUDE.md) with the work-memory block replaced by $Block (or
# removed when $Block is empty).
function Set-RulesBlock([string]$Path, [string]$Block) {
  New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
  $text = ''
  if (Test-Path $path) { $text = [IO.File]::ReadAllText($path) }
  $pattern = '(?s)\r?\n?' + [regex]::Escape($AgentsStart) + '.*?' + [regex]::Escape($AgentsEnd) + '\r?\n?'
  $text = [regex]::Replace($text, $pattern, "`n").Trim()
  if ($Block) {
    if ($text) { $text += "`n`n" }
    $text += "$AgentsStart`n$Block`n$AgentsEnd"
  }
  if ($text) { Write-Utf8 $path "$text`n" } elseif (Test-Path $path) { Remove-Item $path }
}

function Set-AgentsBlock([string]$Block) { Set-RulesBlock (Join-Path (Get-CodexHome) 'AGENTS.md') $Block }
function Set-ClaudeBlock([string]$Block) { Set-RulesBlock (Join-Path (Get-ClaudeHome) 'CLAUDE.md') $Block }

<#
  Installs the BrainAI app for this Windows user (D6, docs/DESKTOP.md): no admin rights, no SmartScreen stop.

  From the internet (the latest release):
    irm https://github.com/jsr1292/brainai/releases/latest/download/install-app.ps1 | iex
  With a Setup .exe at hand (SHA256SUMS next to it):
    powershell -ExecutionPolicy Bypass -File install-app.ps1 -Installer .\BrainAI_1.0.0_x64-setup.exe

  The installer is run only if its SHA-256 matches the release's SHA256SUMS. Works in Windows PowerShell 5.1.
#>

function Install-BrainAI {
  [CmdletBinding()]
  param(
    # A Setup .exe already on this computer; otherwise it is downloaded from the release.
    [string]$Installer,
    [string]$Release = 'https://github.com/jsr1292/brainai/releases/latest/download',
    # Check everything, then say what would run, and stop there.
    [switch]$DryRun
  )
  $ErrorActionPreference = 'Stop'
  # Windows PowerShell 5.1 downloads many times slower while drawing its progress bar.
  $ProgressPreference = 'SilentlyContinue'
  # Windows PowerShell 5.1 may still default to old TLS; GitHub needs 1.2.
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

  $work = Join-Path ([IO.Path]::GetTempPath()) ('brainai-install-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    if ($Installer) {
      if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw "BrainAI was not installed: $Installer does not exist." }
      $exe = (Resolve-Path -LiteralPath $Installer).Path
      $sums = Join-Path (Split-Path -Parent $exe) 'SHA256SUMS'
      if (-not (Test-Path -LiteralPath $sums -PathType Leaf)) { throw "BrainAI was not installed: SHA256SUMS is missing next to $exe." }
    } else {
      $sums = Join-Path $work 'SHA256SUMS'
      try { Invoke-WebRequest -UseBasicParsing -Uri "$Release/SHA256SUMS" -OutFile $sums }
      catch { throw "BrainAI was not installed: the release's SHA256SUMS could not be downloaded ($($_.Exception.Message))." }
      $first = (Get-Content -LiteralPath $sums | Where-Object { $_ -match '_x64-setup\.exe$' } | Select-Object -First 1)
      if (-not $first) { throw 'BrainAI was not installed: the release lists no Windows installer.' }
      $name = ($first -split '\s+', 2)[1].Trim().TrimStart('*')
      $exe = Join-Path $work $name
      try { Invoke-WebRequest -UseBasicParsing -Uri "$Release/$name" -OutFile $exe }
      catch { throw "BrainAI was not installed: $name could not be downloaded ($($_.Exception.Message))." }
    }

    $leaf = Split-Path -Leaf $exe
    $entry = Get-Content -LiteralPath $sums | Where-Object { ($_ -split '\s+', 2)[1] -and (($_ -split '\s+', 2)[1].Trim().TrimStart('*') -eq $leaf) } | Select-Object -First 1
    if (-not $entry) { throw "BrainAI was not installed: SHA256SUMS has no checksum for $leaf." }
    $want = ($entry -split '\s+', 2)[0].ToLowerInvariant()
    $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
    if ($got -ne $want) { throw "BrainAI was not installed: $leaf does not match its checksum (expected $want, got $got). Download it again." }

    if ($DryRun) {
      Write-Output "Checked $leaf. Would run: `"$exe`" /S, then start BrainAI."
      return
    }

    # A copy brought from elsewhere carries the internet mark that makes Windows stop it; this one was just checked.
    if (Get-Command Unblock-File -ErrorAction SilentlyContinue) { Unblock-File -LiteralPath $exe }
    # An update while BrainAI runs: close it first (its files are in use), only the copy in its own folder.
    $dir = Join-Path $env:LOCALAPPDATA 'BrainAI'
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path.StartsWith($dir + '\', [StringComparison]::OrdinalIgnoreCase) } |
      Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Output "Installing BrainAI for $env:USERNAME ..."
    $p = Start-Process -FilePath $exe -ArgumentList '/S' -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "BrainAI was not installed: the installer stopped with code $($p.ExitCode)." }

    $app = Join-Path $dir 'brainai.exe'
    if (Test-Path -LiteralPath $app) {
      Start-Process -FilePath $app
      Write-Output 'BrainAI is installed and starting. Its icon is in the system tray.'
    } else {
      Write-Output 'BrainAI is installed. Open it from the Start menu.'
    }
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Install-BrainAI @args

<#
  Tests for install-app.ps1 (D6), runnable anywhere PowerShell runs (pwsh -NoProfile -File install-app.tests.ps1):
  each case runs the script in a fresh PowerShell with a local "installer" and checks its exit code and words.
  Nothing is installed: the good case uses -DryRun.
#>
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'install-app.ps1'
$shell = (Get-Process -Id $PID).Path
$failed = 0

function New-Case($sums) {
  $dir = Join-Path ([IO.Path]::GetTempPath()) ('brainai-test-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $dir | Out-Null
  $exe = Join-Path $dir 'BrainAI_1.0.0_x64-setup.exe'
  [IO.File]::WriteAllText($exe, 'not really an installer')
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
  if ($null -ne $sums) { [IO.File]::WriteAllText((Join-Path $dir 'SHA256SUMS'), $sums.Replace('HASH', $hash)) }
  return @{ Dir = $dir; Exe = $exe }
}

function Check([string]$name, [hashtable]$case, [int]$code, [string]$words) {
  # Windows PowerShell 5.1 turns a child's stderr into stopping errors under 'Stop': collect it with 'Continue'.
  $out = & { $ErrorActionPreference = 'Continue'; & $shell -NoProfile -File $script -Installer $case.Exe -DryRun 2>&1 | Out-String }
  $exit = $LASTEXITCODE
  # PowerShell wraps an error message across lines (with '|' in front): match the words on one line.
  $flat = ($out -replace '\s*\|\s*', ' ') -replace '\s+', ' '
  $ok = ($exit -eq $code) -and ($flat -match $words)
  Remove-Item -LiteralPath $case.Dir -Recurse -Force
  if ($ok) { Write-Output "ok   $name" } else { Write-Output "FAIL $name (exit $exit): $out"; $script:failed++ }
}

Check 'a good checksum: checked, and nothing run with -DryRun' (New-Case "HASH  BrainAI_1.0.0_x64-setup.exe`n") 0 'Checked BrainAI_1\.0\.0_x64-setup\.exe\. Would run'
Check 'a wrong checksum stops before anything runs' (New-Case ("0" * 64 + "  BrainAI_1.0.0_x64-setup.exe`n")) 1 'does not match its checksum'
Check 'no entry for the installer stops' (New-Case "HASH  something-else.exe`n") 1 'has no checksum for BrainAI_1\.0\.0_x64-setup\.exe'
Check 'no SHA256SUMS next to it stops' (New-Case $null) 1 'SHA256SUMS is missing'
$gone = @{ Dir = (New-Case "HASH  x`n").Dir; Exe = 'C:\nowhere\BrainAI_1.0.0_x64-setup.exe' }
Check 'a missing installer stops' $gone 1 'does not exist'

if ($failed -gt 0) { exit 1 }

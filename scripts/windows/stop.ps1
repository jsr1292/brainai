# Stops the work memory until the next login or the next run of start.ps1.
. (Join-Path $PSScriptRoot 'common.ps1')
Stop-Memory
Write-Host 'Work memory stopped.'

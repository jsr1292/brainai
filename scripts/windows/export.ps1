# Writes every memory to a readable Markdown file (default: your Documents folder). Changes nothing.
param([string]$Path = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) "work-memory-$(Get-Date -Format yyyy-MM-dd).md"))
. (Join-Path $PSScriptRoot 'common.ps1')
Invoke-MemoryCli export $Path

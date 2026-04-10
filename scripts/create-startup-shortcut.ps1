#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
# Repo root = parent of scripts/
$root = Split-Path -Parent $PSScriptRoot
$bat = Join-Path $root 'start_app.bat'
if (-not (Test-Path -LiteralPath $bat)) {
  Write-Error "start_app.bat not found: $bat"
  exit 1
}

$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'Claude Hybrid Router.lnk'

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnkPath)
$sc.TargetPath = $bat
$sc.WorkingDirectory = $root
$sc.Description = 'Claude Hybrid router (npm start) — repo root'
# 7 = minimized (SW_SHOWMINNOACTIVE)
$sc.WindowStyle = 7
$sc.Save()

Write-Host "Shortcut created:"
Write-Host "  $lnkPath"
Write-Host "Target: $bat"

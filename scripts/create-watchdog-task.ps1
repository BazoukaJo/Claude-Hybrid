# Create Windows scheduled task for Claude Hybrid router watchdog
# Runs at user login; continuously monitors router health and auto-restarts

param(
    [string]$ScriptPath = "$PSScriptRoot\watchdog-router.ps1",
    [string]$TaskName = 'Claude Hybrid Watchdog',
    [string]$TaskDescription = 'Monitors Claude Hybrid router health; auto-restarts if crashed'
)

$ErrorActionPreference = 'Stop'

# Resolve to absolute path
$ScriptPath = (Get-Item $ScriptPath).FullName

Write-Host "Registering scheduled task: '$TaskName'"
Write-Host "Script: $ScriptPath"

# Check if task already exists
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($ExistingTask) {
    Write-Host "Task '$TaskName' already exists; updating..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Create trigger: At user logon
$LogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Create action: Run PowerShell with watchdog script
$Action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""

# Create settings: Run indefinitely, restart if fails
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable

# Register the task (current user, no elevation needed)
Register-ScheduledTask `
    -TaskName $TaskName `
    -Trigger $LogonTrigger `
    -Action $Action `
    -Settings $Settings `
    -Description $TaskDescription `
    -User $env:USERNAME | Out-Null

Write-Host '[OK] Task registered successfully'
Write-Host ''
Write-Host 'Task details:'
Write-Host "  Name: $TaskName"
Write-Host '  Trigger: At logon'
Write-Host '  Location: Task Scheduler Library (root)'
Write-Host ''
Write-Host 'To test immediately, run:'
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ''
Write-Host 'To view logs:'
Write-Host "  Get-Content (Join-Path `$env:USERPROFILE '.claude\watchdog.log')"

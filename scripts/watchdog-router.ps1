# Claude Hybrid Router Watchdog
# Monitors router health and automatically restarts or reverts on persistent failure
# Runs continuously as a scheduled task at login

param(
    [int]$HealthCheckIntervalSeconds = 30,
    [int]$FailureThresholdForRestart = 2,
    [int]$FailureThresholdForRevert = 3
)

$ErrorActionPreference = 'Continue'
$RoutePort = if ($env:ROUTER_PORT) { [int]$env:ROUTER_PORT } else { 8082 }
$HealthUrl = "http://127.0.0.1:$RoutePort/api/health"
$WatchdogHome = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($HOME) { $HOME } else { $PSScriptRoot }
$ClaudeDir = Join-Path $WatchdogHome '.claude'
$LogFile = Join-Path $ClaudeDir 'watchdog.log'
$StateFile = Join-Path $ClaudeDir 'watchdog.state'

# Ensure .claude directory exists
if (!(Test-Path $ClaudeDir)) {
    New-Item -ItemType Directory -Path $ClaudeDir -Force | Out-Null
}

function Write-WatchdogLog {
    param(
        [string]$Level,
        [string]$Message
    )
    $Timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $LogEntry = "[$Timestamp] [$Level] $Message"
    Add-Content -Path $LogFile -Value $LogEntry -ErrorAction SilentlyContinue
    if ($Level -eq 'ERROR') {
        Write-Host $LogEntry -ForegroundColor Red
    }
    elseif ($Level -eq 'WARN') {
        Write-Host $LogEntry -ForegroundColor Yellow
    }
}

function Get-WatchdogState {
    if (Test-Path $StateFile) {
        try {
            $State = Get-Content $StateFile -Raw | ConvertFrom-Json
            return $State
        }
        catch {
            return [pscustomobject]@{ fail_count = 0; mode = 'monitoring'; last_check_time = $null }
        }
    }
    return [pscustomobject]@{ fail_count = 0; mode = 'monitoring'; last_check_time = $null }
}

function Set-WatchdogState {
    param(
        $State
    )
    try {
        $State | ConvertTo-Json | Set-Content -Path $StateFile -Force -ErrorAction SilentlyContinue
    }
    catch {
        Write-WatchdogLog 'WARN' "Failed to write state file: $_"
    }
}

function Test-RouterHealth {
    try {
        $Response = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 5 -ErrorAction Stop
        if ($Response.StatusCode -eq 200) {
            $HealthData = $Response.Content | ConvertFrom-Json
            return $HealthData.status -eq 'healthy'
        }
        return $false
    }
    catch {
        return $false
    }
}

function Restart-Router {
    Write-WatchdogLog 'WARN' 'Attempting to restart router...'

    # Kill existing process on port
    try {
        $ConnState = Get-NetTCPConnection -LocalPort $RoutePort -State Listen -ErrorAction SilentlyContinue
        if ($ConnState) {
            $Process = Get-Process -Id $ConnState.OwningProcess -ErrorAction SilentlyContinue
            if ($Process) {
                Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 2
            }
        }
    }
    catch {
        Write-WatchdogLog 'WARN' "Could not stop existing process: $_"
    }

    # Start router as a background process. start_app.bat ends with 'node router/server.js'
    # which blocks the terminal it runs in; calling it with '& cmd /c' would hang the watchdog
    # forever (never returning from Restart-Router). Start-Process is non-blocking — it spawns
    # the cmd/node child and immediately returns so the watchdog loop can continue.
    try {
        $StartScript = Join-Path $PSScriptRoot '..\start_app.bat'
        if (Test-Path $StartScript) {
            $StartScript = (Resolve-Path $StartScript).Path
            Start-Process -FilePath 'cmd.exe' `
                -ArgumentList "/c `"$StartScript`"" `
                -WindowStyle Hidden
            Write-WatchdogLog 'INFO' 'Router restart initiated (background)'
            return $true
        }
        Write-WatchdogLog 'WARN' "start_app.bat not found at $StartScript"
    }
    catch {
        Write-WatchdogLog 'WARN' "Failed to restart router: $_"
    }

    return $false
}

function Invoke-EnvironmentCloudFallback {
    Write-WatchdogLog 'ERROR' "Router unhealthy after $FailureThresholdForRevert+ restart attempts; reverting to cloud mode"

    try {
        # Call revert-hybrid-core.bat via PowerShell
        $RevertScript = "$PSScriptRoot\revert-hybrid-core.bat"
        if (Test-Path $RevertScript) {
            & cmd /c $RevertScript 2>&1 | Out-Null
            Write-WatchdogLog 'INFO' 'Environment reverted to cloud; watching for recovery...'
        }
    }
    catch {
        Write-WatchdogLog 'ERROR' "Failed to revert environment: $_"
    }
}

function Test-ReferenceRevert {
    # Check if ANTHROPIC_BASE_URL is currently set
    $ClaudeSettings = Join-Path $WatchdogHome '.claude\settings.json'
    if (Test-Path $ClaudeSettings) {
        try {
            $Settings = Get-Content $ClaudeSettings -Raw | ConvertFrom-Json
            return [string]::IsNullOrEmpty($Settings.env.ANTHROPIC_BASE_URL)
        }
        catch {
            return $false
        }
    }
    return $false
}

# Main watchdog loop
Write-WatchdogLog 'INFO' "Watchdog started on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

$State = Get-WatchdogState
$State.last_check_time = Get-Date -AsUTC -Format 'O'
$State.mode = 'monitoring'
$State.fail_count = 0
Set-WatchdogState $State

while ($true) {
    try {
        $State = Get-WatchdogState

        # Check router health
        if (Test-RouterHealth) {
            # Health check passed
            if ($State.fail_count -gt 0) {
                Write-WatchdogLog 'INFO' 'Router recovered from failure state'
            }
            $State.fail_count = 0
            $State.mode = 'monitoring'
        }
        else {
            # Health check failed
            $State.fail_count = $State.fail_count + 1

            if ($State.fail_count -eq $FailureThresholdForRestart) {
                Write-WatchdogLog 'WARN' "Health check failed $($State.fail_count) times; attempting restart..."
                if (Restart-Router) {
                    Write-WatchdogLog 'INFO' 'Restart triggered; allowing 30s for recovery'
                    Start-Sleep -Seconds 30
                    $State.fail_count = 0  # Reset after restart attempt
                }
                else {
                    Write-WatchdogLog 'WARN' 'Restart failed; incrementing fail count'
                }
            }
            elseif ($State.fail_count -ge $FailureThresholdForRevert) {
                if ($State.mode -ne 'reverted') {
                    Invoke-EnvironmentCloudFallback
                    $State.mode = 'reverted'
                }
                # Continue waiting but don't spam logs
                if ($State.fail_count -eq $FailureThresholdForRevert) {
                    Write-WatchdogLog 'WARN' 'Watchdog in fallback mode; waiting for manual recovery or router restart'
                }
            }
            else {
                Write-WatchdogLog 'WARN' "Health check failed ($($State.fail_count)/$FailureThresholdForRevert)"
            }
        }

        $State.last_check_time = Get-Date -AsUTC -Format 'O'
        Set-WatchdogState $State

        # Wait before next check
        Start-Sleep -Seconds $HealthCheckIntervalSeconds
    }
    catch {
        Write-WatchdogLog 'ERROR' "Watchdog error: $_"
        Start-Sleep -Seconds 10
    }
}

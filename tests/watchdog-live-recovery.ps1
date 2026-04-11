# Live watchdog recovery test
# Kills the running router and confirms it restarts via the same Start-Process path the watchdog uses.
# Run while the router is already up on ROUTER_PORT (default 8082).
#
# Usage:
#   .\tests\watchdog-live-recovery.ps1
#   .\tests\watchdog-live-recovery.ps1 -WaitSeconds 60
#   .\tests\watchdog-live-recovery.ps1 -SkipIfDown    # CI-safe: skip silently if router not running

param(
    [int]$WaitSeconds = 45,
    [switch]$SkipIfDown
)

$ErrorActionPreference = 'Continue'
$RoutePort = if ($env:ROUTER_PORT) { [int]$env:ROUTER_PORT } else { 8082 }
$HealthUrl = "http://127.0.0.1:$RoutePort/api/health"
$RepoRoot  = Split-Path $PSScriptRoot -Parent
$StartScript = Join-Path $RepoRoot 'start_app.bat'

Write-Host ''
Write-Host '=== Watchdog Live Recovery Test ===' -ForegroundColor Cyan
Write-Host "  Router port : $RoutePort"
Write-Host "  start_app   : $StartScript"
Write-Host ''

function Test-Health {
    try {
        $r = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 3 -ErrorAction Stop
        if ($r.StatusCode -eq 200) {
            return ($r.Content | ConvertFrom-Json).status -eq 'healthy'
        }
        return $false
    }
    catch { return $false }
}

# ── Pre-check: router must be up ──────────────────────────────────────────────
Write-Host 'Pre-check: router health' -ForegroundColor Gray
if (-not (Test-Health)) {
    if ($SkipIfDown) {
        Write-Host '  [SKIP] Router not running — skipping live recovery test' -ForegroundColor Yellow
        exit 0
    }
    Write-Host "  [SKIP] Router not responding on port $RoutePort. Start it first with start_app.bat." -ForegroundColor Yellow
    exit 0
}
Write-Host '  [OK] Router healthy before test' -ForegroundColor Green

# ── Kill the router process ───────────────────────────────────────────────────
Write-Host ''
Write-Host 'Kill router process' -ForegroundColor Gray
$Killed = $false
try {
    $Conn = Get-NetTCPConnection -LocalPort $RoutePort -State Listen -ErrorAction SilentlyContinue
    if ($Conn) {
        $Proc = Get-Process -Id $Conn.OwningProcess -ErrorAction SilentlyContinue
        if ($Proc) {
            Write-Host "  Killing PID $($Proc.Id) ($($Proc.Name))..."
            Stop-Process -Id $Proc.Id -Force -ErrorAction Stop
            $Killed = $true
            Start-Sleep -Seconds 1
        }
    }
}
catch {
    Write-Host "  [FAIL] Could not kill router process: $_" -ForegroundColor Red
    exit 1
}

if (-not $Killed) {
    Write-Host "  [SKIP] No listening process found on port $RoutePort" -ForegroundColor Yellow
    exit 0
}
Write-Host '  [OK] Process killed' -ForegroundColor Green

# ── Confirm health check detects the failure ──────────────────────────────────
Write-Host ''
Write-Host 'Confirm health detects failure' -ForegroundColor Gray
Start-Sleep -Seconds 1
if (Test-Health) {
    Write-Host '  [WARN] Router still healthy immediately after kill (possible port reuse or fast restart)' -ForegroundColor Yellow
}
else {
    Write-Host '  [OK] Health check correctly reports failure' -ForegroundColor Green
}

# ── Restart via the same non-blocking path the watchdog uses ─────────────────
Write-Host ''
Write-Host 'Restart via start_app.bat (same path as fixed watchdog)' -ForegroundColor Gray
if (-not (Test-Path $StartScript)) {
    Write-Host "  [FAIL] start_app.bat not found at $StartScript" -ForegroundColor Red
    exit 1
}
try {
    # Must use Start-Process, not & cmd /c: start_app.bat blocks on 'node router/server.js',
    # so & cmd /c would hang here (the same bug this test validates the fix for).
    Start-Process -FilePath 'cmd.exe' `
        -ArgumentList "/c `"$StartScript`"" `
        -WindowStyle Hidden
    Write-Host '  [OK] Background restart launched' -ForegroundColor Green
}
catch {
    Write-Host "  [FAIL] Failed to launch restart: $_" -ForegroundColor Red
    exit 1
}

# ── Poll until healthy or timeout ─────────────────────────────────────────────
Write-Host ''
Write-Host "Polling for recovery (up to ${WaitSeconds}s)..." -ForegroundColor Gray
$Elapsed   = 0
$Recovered = $false
while ($Elapsed -lt $WaitSeconds) {
    Start-Sleep -Seconds 2
    $Elapsed += 2
    if (Test-Health) {
        $Recovered = $true
        break
    }
    Write-Host ("  {0,3}s / {1}s — still down..." -f $Elapsed, $WaitSeconds) -ForegroundColor DarkGray
}

Write-Host ''
if ($Recovered) {
    Write-Host "  [OK] Router recovered in ~${Elapsed}s" -ForegroundColor Green
    Write-Host ''
    Write-Host '=== Live Recovery Test PASSED ===' -ForegroundColor Green
    exit 0
}
else {
    Write-Host "  [FAIL] Router did not recover within ${WaitSeconds}s" -ForegroundColor Red
    Write-Host ''
    Write-Host '=== Live Recovery Test FAILED ===' -ForegroundColor Red
    exit 1
}

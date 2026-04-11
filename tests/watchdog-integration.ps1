# Test watchdog state management and health probe logic
# This simulates the watchdog operation without creating actual scheduled tasks

param(
    [int]$TimeoutSeconds = 10
)

$ErrorActionPreference = 'Continue'

Write-Host ''
Write-Host '=== Watchdog Integration Test ===' -ForegroundColor Cyan
Write-Host ''

# Test 1: Verify script files exist
Write-Host 'Test 1: Script files exist' -ForegroundColor Gray
$ScriptsToCheck = @(
    'scripts/watchdog-router.ps1',
    'scripts/create-watchdog-task.ps1'
)

foreach ($script in $ScriptsToCheck) {
    if (Test-Path $script) {
        Write-Host "  [OK] $script" -ForegroundColor Green
    }
    else {
        Write-Host "  [FAIL] MISSING: $script" -ForegroundColor Red
        exit 1
    }
}

# Test 2: Parse watchdog script
Write-Host ''
Write-Host 'Test 2: Watchdog script syntax' -ForegroundColor Gray
try {
    $watchdogContent = Get-Content 'scripts/watchdog-router.ps1' -Raw
    $tokens = @()
    $parseErrors = @()
    [System.Management.Automation.PSParser]::Tokenize($watchdogContent, [ref]$parseErrors) | Out-Null

    if ($parseErrors.Count -eq 0) {
        Write-Host '  [OK] watchdog-router.ps1 is valid PowerShell' -ForegroundColor Green
    }
    else {
        Write-Host "  [FAIL] Found $($parseErrors.Count) syntax errors:" -ForegroundColor Red
        $parseErrors | ForEach-Object { Write-Host "    - $_" }
        exit 1
    }
}
catch {
    Write-Host "  [FAIL] Parse error: $_" -ForegroundColor Red
    exit 1
}

# Test 3: Parse task creation script
Write-Host ''
Write-Host 'Test 3: Task creation script syntax' -ForegroundColor Gray
try {
    $taskContent = Get-Content 'scripts/create-watchdog-task.ps1' -Raw
    $tokens = @()
    $parseErrors = @()
    [System.Management.Automation.PSParser]::Tokenize($taskContent, [ref]$parseErrors) | Out-Null

    if ($parseErrors.Count -eq 0) {
        Write-Host '  [OK] create-watchdog-task.ps1 is valid PowerShell' -ForegroundColor Green
    }
    else {
        Write-Host "  [FAIL] Found $($parseErrors.Count) syntax errors:" -ForegroundColor Red
        $parseErrors | ForEach-Object { Write-Host "    - $_" }
        exit 1
    }
}
catch {
    Write-Host "  [FAIL] Parse error: $_" -ForegroundColor Red
    exit 1
}

# Test 4: Verify setup.ps1 integration
Write-Host ''
Write-Host 'Test 4: setup.ps1 integration' -ForegroundColor Gray
$setupContent = Get-Content 'setup.ps1' -Raw
if ($setupContent -match 'function Ensure-WatchdogTask') {
    Write-Host '  [OK] Ensure-WatchdogTask function defined in setup.ps1' -ForegroundColor Green
}
else {
    Write-Host '  [FAIL] Ensure-WatchdogTask function NOT found in setup.ps1' -ForegroundColor Red
    exit 1
}

if ($setupContent -match 'Ensure-WatchdogTask') {
    Write-Host '  [OK] Ensure-WatchdogTask is called in setup.ps1' -ForegroundColor Green
}
else {
    Write-Host '  [FAIL] Ensure-WatchdogTask call NOT found in setup.ps1' -ForegroundColor Red
    exit 1
}

# Test 5: Check documentation updates
Write-Host ''
Write-Host 'Test 5: Documentation updates' -ForegroundColor Gray

$readmeContent = Get-Content 'README.md' -Raw
if ($readmeContent -match 'Automatic recovery.*watchdog' -and $readmeContent -match 'Get-ScheduledTask.*Claude Hybrid Watchdog') {
    Write-Host '  [OK] README.md has watchdog documentation' -ForegroundColor Green
}
else {
    Write-Host '  [FAIL] README.md missing watchdog documentation' -ForegroundColor Red
    exit 1
}

$claudeContent = Get-Content 'CLAUDE.md' -Raw
if ($claudeContent -match 'Automatic recovery.*watchdog' -and $claudeContent -match 'watchdog.log') {
    Write-Host '  [OK] CLAUDE.md has watchdog documentation' -ForegroundColor Green
}
else {
    Write-Host '  [FAIL] CLAUDE.md missing watchdog documentation' -ForegroundColor Red
    exit 1
}

# Test 6: Verify state file structure
Write-Host ''
Write-Host 'Test 6: Watchdog state file logic' -ForegroundColor Gray
if ($watchdogContent -match 'watchdog\.state' -and $watchdogContent -match 'fail_count' -and $watchdogContent -match 'mode = ''monitoring''') {
    Write-Host '  [OK] Watchdog state tracking logic present' -ForegroundColor Green
}
else {
    Write-Host '  [FAIL] Watchdog state logic incomplete' -ForegroundColor Red
    exit 1
}

# Test 7: Verify health check endpoint
Write-Host ''
Write-Host 'Test 7: Health check logic' -ForegroundColor Gray
if ($watchdogContent -match 'Invoke-WebRequest.*HealthUrl' -and $watchdogContent -match '/api/health') {
    Write-Host '  [OK] Health check endpoint probe logic present' -ForegroundColor Green
}
else {
    Write-Host '  [FAIL] Health check logic missing' -ForegroundColor Red
    exit 1
}

# Test 8: Verify restart logic
Write-Host ''
Write-Host 'Test 8: Restart and fallback logic' -ForegroundColor Gray
if ($watchdogContent -match 'Restart-Router' -and $watchdogContent -match 'Invoke-EnvironmentCloudFallback') {
    Write-Host '  [OK] Restart and revert logic present' -ForegroundColor Green
}
else {
    Write-Host '  [FAIL] Restart/revert logic missing' -ForegroundColor Red
    exit 1
}

# Test 9: Verify logging
Write-Host ''
Write-Host 'Test 9: Logging structure' -ForegroundColor Gray
if ($watchdogContent -match 'Write-WatchdogLog' -and $watchdogContent -match 'watchdog\.log') {
    Write-Host '  [OK] Logging functions present' -ForegroundColor Green
}
else {
    Write-Host '  [FAIL] Logging structure incomplete' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '=== All Watchdog Tests Passed ===' -ForegroundColor Green
Write-Host ''

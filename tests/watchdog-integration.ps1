# Test self-revert mechanism: router clears ANTHROPIC_BASE_URL on exit
# Replaces the old watchdog-router.ps1 tests (that script was removed).

param(
    [int]$TimeoutSeconds = 10
)

$ErrorActionPreference = 'Continue'

Write-Host ''
Write-Host '=== Self-Revert Integration Test ===' -ForegroundColor Cyan
Write-Host ''

# Test 1: server.js has self-revert exit handlers
Write-Host 'Test 1: server.js exit handler present' -ForegroundColor Gray
$serverContent = Get-Content 'router/server.js' -Raw
if ($serverContent -match '_revertEnvOnExit' -and $serverContent -match 'revert-claude-hybrid-env\.js' -and $serverContent -match 'process\.on\(.exit.') {
    Write-Host '  [OK] server.js has self-revert exit handler' -ForegroundColor Green
}
else {
    Write-Host '  [FAIL] server.js missing self-revert exit handler' -ForegroundColor Red
    exit 1
}

# Test 2: exit handler covers SIGINT, SIGTERM, and uncaughtException
Write-Host ''
Write-Host 'Test 2: Exit handler covers all signal paths' -ForegroundColor Gray
$hasSigInt   = $serverContent -match 'process\.on\(.SIGINT.'
$hasSigTerm  = $serverContent -match 'process\.on\(.SIGTERM.'
$hasUncaught = $serverContent -match 'process\.on\(.uncaughtException.'
if ($hasSigInt -and $hasSigTerm -and $hasUncaught) {
    Write-Host '  [OK] SIGINT, SIGTERM, and uncaughtException handlers present' -ForegroundColor Green
}
else {
    Write-Host '  [FAIL] One or more signal handlers missing' -ForegroundColor Red
    if (-not $hasSigInt)   { Write-Host '    Missing: SIGINT'            -ForegroundColor Red }
    if (-not $hasSigTerm)  { Write-Host '    Missing: SIGTERM'           -ForegroundColor Red }
    if (-not $hasUncaught) { Write-Host '    Missing: uncaughtException' -ForegroundColor Red }
    exit 1
}

# Test 3: revert script exists
Write-Host ''
Write-Host 'Test 3: revert-claude-hybrid-env.js exists' -ForegroundColor Gray
if (Test-Path 'scripts/revert-claude-hybrid-env.js') {
    Write-Host '  [OK] scripts/revert-claude-hybrid-env.js present' -ForegroundColor Green
}
else {
    Write-Host '  [FAIL] scripts/revert-claude-hybrid-env.js missing' -ForegroundColor Red
    exit 1
}

# Test 4: create-watchdog-task.ps1 gracefully skips missing watchdog script
Write-Host ''
Write-Host 'Test 4: create-watchdog-task.ps1 handles missing watchdog script' -ForegroundColor Gray
if (Test-Path 'scripts/create-watchdog-task.ps1') {
    $taskContent = Get-Content 'scripts/create-watchdog-task.ps1' -Raw
    if ($taskContent -match 'Test-Path' -and $taskContent -match 'self-reverts on exit') {
        Write-Host '  [OK] create-watchdog-task.ps1 gracefully skips missing script' -ForegroundColor Green
    }
    else {
        Write-Host '  [FAIL] create-watchdog-task.ps1 missing graceful skip guard' -ForegroundColor Red
        exit 1
    }
}
else {
    Write-Host '  [SKIP] create-watchdog-task.ps1 not present' -ForegroundColor Yellow
}

# Test 5: setup.ps1 Ensure-WatchdogTask still present (graceful no-op when script missing)
Write-Host ''
Write-Host 'Test 5: setup.ps1 integration' -ForegroundColor Gray
$setupContent = Get-Content 'setup.ps1' -Raw
if ($setupContent -match 'function Ensure-WatchdogTask') {
    Write-Host '  [OK] Ensure-WatchdogTask in setup.ps1 (graceful no-op without watchdog script)' -ForegroundColor Green
}
else {
    Write-Host '  [SKIP] Ensure-WatchdogTask not in setup.ps1' -ForegroundColor Yellow
}

# Test 6: PID file mechanism
Write-Host ''
Write-Host 'Test 6: PID file mechanism' -ForegroundColor Gray
$hasPidWrite  = $serverContent -match '_pidFile' -and $serverContent -match 'router\.pid'
$hasPidDelete = $serverContent -match 'unlinkSync.*_pidFile'
$mergeContent = Get-Content 'scripts/merge-claude-hybrid-env.js' -Raw
$hasStaleCheck = $mergeContent -match 'clearStalePid' -and $mergeContent -match 'router\.pid'
if ($hasPidWrite -and $hasPidDelete -and $hasStaleCheck) {
    Write-Host '  [OK] PID file written on listen, deleted on exit, stale check in merge-env' -ForegroundColor Green
} else {
    if (-not $hasPidWrite)   { Write-Host '  [FAIL] server.js missing PID file write'          -ForegroundColor Red }
    if (-not $hasPidDelete)  { Write-Host '  [FAIL] server.js missing PID file delete on exit' -ForegroundColor Red }
    if (-not $hasStaleCheck) { Write-Host '  [FAIL] merge-env missing stale PID check'         -ForegroundColor Red }
    exit 1
}

# Test 7: spawnSync timeout guard
Write-Host ''
Write-Host 'Test 7: spawnSync timeout guard' -ForegroundColor Gray
if ($serverContent -match 'timeout:\s*5000') {
    Write-Host '  [OK] spawnSync has 5 s timeout in exit handler' -ForegroundColor Green
} else {
    Write-Host '  [FAIL] spawnSync missing timeout in exit handler' -ForegroundColor Red
    exit 1
}

# Test 8: Documentation updated
Write-Host ''
Write-Host 'Test 8: Documentation describes self-revert' -ForegroundColor Gray
$readmeContent = Get-Content 'README.md' -Raw
$claudeContent = Get-Content 'CLAUDE.md' -Raw
$readmeOk = $readmeContent -match 'self-revert' -or $readmeContent -match 'revert.*on exit' -or $readmeContent -match 'exit.*revert'
$claudeOk  = $claudeContent -match 'self-revert' -or $claudeContent -match 'revert.*on exit' -or $claudeContent -match 'exit.*revert'
if ($readmeOk) {
    Write-Host '  [OK] README.md describes self-revert mechanism' -ForegroundColor Green
} else {
    Write-Host '  [WARN] README.md may not describe self-revert (check manually)' -ForegroundColor Yellow
}
if ($claudeOk) {
    Write-Host '  [OK] CLAUDE.md describes self-revert mechanism' -ForegroundColor Green
} else {
    Write-Host '  [WARN] CLAUDE.md may not describe self-revert (check manually)' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '=== All Self-Revert Tests Passed ===' -ForegroundColor Green

Write-Host ''

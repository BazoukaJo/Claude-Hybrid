param(
    [string]$RouterBaseUrl = "http://localhost:8082",
    [switch]$SkipLiveRouting
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

Write-Host "== Node tests (unit + HTTP integration — full npm test suite) ==" -ForegroundColor Cyan
npm test
if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: Node tests exited $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}
Write-Host "PASS: Node tests" -ForegroundColor Green

Write-Host "== Watchdog integration (static analysis, no router needed) ==" -ForegroundColor Cyan
& powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\watchdog-integration.ps1"
if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: Watchdog integration exited $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}
Write-Host "PASS: Watchdog integration" -ForegroundColor Green

if ($SkipLiveRouting) {
    Write-Host "SKIP: Live routing (--SkipLiveRouting)" -ForegroundColor Yellow
    exit 0
}

try {
    $null = Invoke-WebRequest -Uri "$RouterBaseUrl/api/health" -UseBasicParsing -TimeoutSec 3
} catch {
    Write-Host "SKIP: validate-routing.ps1 (no router at $RouterBaseUrl). Start router or pass -SkipLiveRouting." -ForegroundColor Yellow
    exit 0
}

Write-Host "== validate-routing.ps1 (router at $RouterBaseUrl) ==" -ForegroundColor Cyan
& "$PSScriptRoot\validate-routing.ps1" -RouterBaseUrl $RouterBaseUrl
exit $LASTEXITCODE

param(
    [string]$RouterBaseUrl = "http://localhost:8082",
    [switch]$SkipLiveRouting
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

Write-Host "== Node tests (unit + HTTP integration on TEST_ROUTER_PORT) ==" -ForegroundColor Cyan
node --test tests/model-utils.test.cjs tests/routing-logic.test.cjs tests/daily-routing-scenarios.test.cjs tests/local-model-picker.test.cjs tests/router-http.test.cjs tests/router-admin-http.test.cjs tests/dashboard-recent-smoke.cjs
if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: Node tests exited $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}
Write-Host "PASS: Node tests" -ForegroundColor Green

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

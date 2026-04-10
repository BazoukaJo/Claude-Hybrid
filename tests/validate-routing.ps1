param(
    [string]$RouterBaseUrl = "http://localhost:8082"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-RouterLogs {
    $resp = Invoke-WebRequest -Uri "$RouterBaseUrl/api/logs" -UseBasicParsing -TimeoutSec 8
    $json = $resp.Content | ConvertFrom-Json
    if ($null -eq $json.logs) { return @() }
    return @($json.logs)
}

function Wait-ForLog {
    param(
        [int]$StartIndex,
        [scriptblock]$Match,
        [int]$TimeoutSec = 45
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $logs = @(Get-RouterLogs)
        if ($logs.Count -gt $StartIndex) {
            for ($i = $StartIndex; $i -lt $logs.Count; $i++) {
                $entry = $logs[$i]
                if (& $Match $entry) {
                    return $entry
                }
            }
        }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

function Send-MessageProbe {
    param(
        [string]$JsonBody,
        [int]$TimeoutSec = 1
    )

    try {
        Invoke-WebRequest -Uri "$RouterBaseUrl/v1/messages" -Method POST -ContentType "application/json" -Body $JsonBody -TimeoutSec $TimeoutSec | Out-Null
    } catch {
        # Intentionally ignored: routing decision is logged before response completion.
    }
}

Write-Host "== Claude Hybrid routing validation ==" -ForegroundColor Cyan

# Basic router + Ollama availability check
$health = Invoke-WebRequest -Uri "$RouterBaseUrl/api/health" -UseBasicParsing -TimeoutSec 8
Write-Host "Router health: $($health.StatusCode) $($health.Content)" -ForegroundColor Gray

$tags = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -UseBasicParsing -TimeoutSec 8
Write-Host "Ollama tags endpoint: $($tags.StatusCode)" -ForegroundColor Gray

# 1) Local route check for basic prompt
$beforeLocal = @(Get-RouterLogs)
$localStart = $beforeLocal.Count

$localBody = @{
    model = "claude-sonnet-4-5"
    max_tokens = 24
    stream = $false
    messages = @(
        @{
            role = "user"
            content = @(
                @{
                    type = "text"
                    text = "hi"
                }
            )
        }
    )
} | ConvertTo-Json -Depth 8

Write-Host "Sending basic prompt to validate LOCAL routing..." -ForegroundColor Gray
Send-MessageProbe -JsonBody $localBody -TimeoutSec 1

$localHit = Wait-ForLog -StartIndex $localStart -TimeoutSec 45 -Match {
    param($entry)
    return ($entry.dest -eq "local" -and -not $entry.fallback)
}

if ($null -eq $localHit) {
    Write-Host "FAIL: No LOCAL routing log found for basic prompt." -ForegroundColor Red
    exit 1
}
Write-Host "PASS: Basic prompt routed LOCAL at $($localHit.time)." -ForegroundColor Green

# 2) Cloud route check for complexity keyword
$beforeCloud = @(Get-RouterLogs)
$cloudStart = $beforeCloud.Count

$cloudBody = @{
    model = "claude-sonnet-4-5"
    max_tokens = 24
    stream = $false
    messages = @(
        @{
            role = "user"
            content = @(
                @{
                    type = "text"
                    text = "help me with system design for a resilient API"
                }
            )
        }
    )
} | ConvertTo-Json -Depth 8

Write-Host "Sending keyword prompt to validate CLOUD routing..." -ForegroundColor Gray
Send-MessageProbe -JsonBody $cloudBody -TimeoutSec 1

$cloudHit = Wait-ForLog -StartIndex $cloudStart -TimeoutSec 20 -Match {
    param($entry)
    return ($entry.dest -eq "cloud")
}

if ($null -eq $cloudHit) {
    Write-Host "FAIL: No CLOUD routing log found for complexity keyword prompt." -ForegroundColor Red
    exit 1
}
Write-Host "PASS: Keyword prompt routed CLOUD at $($cloudHit.time)." -ForegroundColor Green

Write-Host ""
Write-Host "All routing checks passed." -ForegroundColor Cyan
exit 0


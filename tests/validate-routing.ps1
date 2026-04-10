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

function Get-RouterStats {
    $resp = Invoke-WebRequest -Uri "$RouterBaseUrl/api/stats" -UseBasicParsing -TimeoutSec 8
    return $resp.Content | ConvertFrom-Json
}

Write-Host "== Claude Hybrid routing validation ==" -ForegroundColor Cyan
Write-Host "Daily use (limited Claude Code / Opus API): local for routine turns;" -ForegroundColor DarkGray
Write-Host "  cloud when tokens high, tool results this turn > fileReadThreshold, or a routing keyword matches." -ForegroundColor DarkGray
Write-Host ""

# Basic router + Ollama availability check
$health = Invoke-WebRequest -Uri "$RouterBaseUrl/api/health" -UseBasicParsing -TimeoutSec 8
Write-Host "Router health: $($health.StatusCode) $($health.Content)" -ForegroundColor Gray

$tags = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -UseBasicParsing -TimeoutSec 8
Write-Host "Ollama tags endpoint: $($tags.StatusCode)" -ForegroundColor Gray

$stats = Get-RouterStats
$mode = $stats.config.routing_mode
$keywords = @()
if ($null -ne $stats.config.routing_keywords) {
    $keywords = @($stats.config.routing_keywords | ForEach-Object { [string]$_ })
}
Write-Host "Routing mode: $mode | tokenThreshold=$($stats.config.tokenThreshold) fileReadThreshold=$($stats.config.fileReadThreshold) keywords=$($keywords.Count)" -ForegroundColor Gray

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

# --- Test 1: basic prompt ---
$before1 = @(Get-RouterLogs)
$start1 = $before1.Count

Write-Host "Sending basic prompt..." -ForegroundColor Gray
Send-MessageProbe -JsonBody $localBody -TimeoutSec 1

$expectLocal = ($mode -eq "hybrid" -or $mode -eq "local")
$expectCloud = ($mode -eq "cloud")

if ($expectLocal) {
    $hit1 = Wait-ForLog -StartIndex $start1 -TimeoutSec 45 -Match {
        param($entry)
        return ($entry.dest -eq "local" -and -not $entry.fallback)
    }
    if ($null -eq $hit1) {
        Write-Host "FAIL: Expected LOCAL for basic prompt (mode=$mode)." -ForegroundColor Red
        exit 1
    }
    Write-Host "PASS: Basic prompt routed LOCAL at $($hit1.time)." -ForegroundColor Green
}

if ($expectCloud) {
    $hit1 = Wait-ForLog -StartIndex $start1 -TimeoutSec 45 -Match {
        param($entry)
        return ($entry.dest -eq "cloud")
    }
    if ($null -eq $hit1) {
        Write-Host "FAIL: Expected CLOUD for basic prompt (routing mode: cloud only)." -ForegroundColor Red
        exit 1
    }
    Write-Host "PASS: Basic prompt routed CLOUD at $($hit1.time) (Claude-only mode)." -ForegroundColor Green
}

# --- Test 2: keyword / rule contrast (hybrid + local only) ---
if ($mode -eq "cloud") {
    Write-Host "SKIP: Second probe (keyword routing) not applicable in Claude-only mode." -ForegroundColor Yellow
} elseif ($keywords.Count -eq 0 -and $mode -eq "hybrid") {
    Write-Host "WARN: No routing keywords in config — add routing.keywords in hybrid.config.json to test cloud escalation." -ForegroundColor Yellow
} elseif ($keywords.Count -eq 0) {
    Write-Host "SKIP: No keywords to probe." -ForegroundColor Yellow
} else {
    $kw = $keywords[0]
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
                        text = "help me with $kw for a small project"
                    }
                )
            }
        )
    } | ConvertTo-Json -Depth 8

    $before2 = @(Get-RouterLogs)
    $start2 = $before2.Count

    if ($mode -eq "hybrid") {
        Write-Host "Sending hybrid keyword probe (first config keyword: '$kw') — expect CLOUD..." -ForegroundColor Gray
        Send-MessageProbe -JsonBody $cloudBody -TimeoutSec 1
        $hit2 = Wait-ForLog -StartIndex $start2 -TimeoutSec 20 -Match {
            param($entry)
            return ($entry.dest -eq "cloud")
        }
        if ($null -eq $hit2) {
            Write-Host "FAIL: No CLOUD routing log for keyword probe." -ForegroundColor Red
            exit 1
        }
        Write-Host "PASS: Keyword probe routed CLOUD at $($hit2.time)." -ForegroundColor Green
    } elseif ($mode -eq "local") {
        Write-Host "Sending keyword probe in Ollama-only mode — expect LOCAL (keywords ignored)..." -ForegroundColor Gray
        Send-MessageProbe -JsonBody $cloudBody -TimeoutSec 1
        $hit2 = Wait-ForLog -StartIndex $start2 -TimeoutSec 45 -Match {
            param($entry)
            return ($entry.dest -eq "local" -and -not $entry.fallback)
        }
        if ($null -eq $hit2) {
            Write-Host "FAIL: Expected LOCAL for keyword probe in Ollama-only mode." -ForegroundColor Red
            exit 1
        }
        Write-Host "PASS: Keyword probe stayed LOCAL at $($hit2.time)." -ForegroundColor Green
    }
}

# --- Test 3: heavy tool turn (hybrid) — same shape as Claude Code after many read_file results ---
if ($mode -eq "hybrid") {
    $ft = [int]$stats.config.fileReadThreshold
    $n = $ft + 1
    $toolBlocks = @()
    for ($i = 0; $i -lt $n; $i++) {
        $toolBlocks += @{
            type        = "tool_result"
            tool_use_id = "validate-heavy-$i"
            content     = "{}"
        }
    }
    $heavyBody = @{
        model      = "claude-sonnet-4-5"
        max_tokens = 24
        stream     = $false
        messages   = @(
            @{
                role    = "user"
                content = $toolBlocks
            }
        )
    } | ConvertTo-Json -Depth 12

    $before3 = @(Get-RouterLogs)
    $start3 = $before3.Count
    Write-Host "Sending heavy tool-turn probe ($n tool_result blocks) — expect CLOUD..." -ForegroundColor Gray
    Send-MessageProbe -JsonBody $heavyBody -TimeoutSec 1
    $hit3 = Wait-ForLog -StartIndex $start3 -TimeoutSec 25 -Match {
        param($entry)
        return ($entry.dest -eq "cloud")
    }
    if ($null -eq $hit3) {
        Write-Host "FAIL: No CLOUD routing log for heavy tool-turn probe." -ForegroundColor Red
        exit 1
    }
    Write-Host "PASS: Heavy tool-turn probe routed CLOUD at $($hit3.time)." -ForegroundColor Green
}

Write-Host ""
Write-Host "All routing checks passed." -ForegroundColor Cyan
Write-Host "Claude Code: same /v1/messages shape — watch http://127.0.0.1:8082/ log or GET /events (SSE)." -ForegroundColor DarkGray
exit 0

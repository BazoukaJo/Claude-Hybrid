param(
    [string]$RouterBaseUrl = 'http://127.0.0.1:8082',
    [int]$TimeoutSec = 25
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Status {
    param(
        [string]$Label,
        [string]$Value,
        [string]$Color = 'Gray'
    )
    Write-Host ('  {0,-36} {1}' -f $Label, $Value) -ForegroundColor $Color
}

function Get-Json {
    param([string]$Url)
    $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 10
    return $resp.Content | ConvertFrom-Json
}

function Get-RouterLogs {
    $json = Get-Json -Url "$RouterBaseUrl/api/logs"
    if ($null -eq $json.logs) { return @() }
    return @($json.logs)
}

function Wait-ForNewRouteLog {
    param(
        [int]$StartIndex,
        [int]$WaitSec
    )

    $deadline = (Get-Date).AddSeconds($WaitSec)
    while ((Get-Date) -lt $deadline) {
        $logs = @(Get-RouterLogs)
        if ($logs.Count -gt $StartIndex) {
            for ($i = $StartIndex; $i -lt $logs.Count; $i++) {
                $entry = $logs[$i]
                if ($null -ne $entry -and $null -ne $entry.dest) {
                    return $entry
                }
            }
        }
        Start-Sleep -Milliseconds 400
    }
    return $null
}

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $null }
    try {
        return (Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable)
    }
    catch {
        try {
            return (Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
        }
        catch {
            return $null
        }
    }
}

function Get-ObjectPropValue {
    param(
        [object]$Obj,
        [string]$Name
    )
    if ($null -eq $Obj) { return $null }
    if ($Obj -is [hashtable]) {
        return $Obj[$Name]
    }
    $prop = $Obj.PSObject.Properties[$Name]
    if ($null -ne $prop) { return $prop.Value }
    return $null
}

function Get-TerminalEnvValue {
    param([object]$Settings)
    if ($null -eq $Settings) { return '' }
    $envBlock = Get-ObjectPropValue -Obj $Settings -Name 'terminal.integrated.env.windows'
    $v = Get-ObjectPropValue -Obj $envBlock -Name 'ANTHROPIC_BASE_URL'
    if ($null -ne $v) { return [string]$v }
    return ''
}

Write-Host ''
Write-Host '  Claude Hybrid - strict routing verification' -ForegroundColor Cyan
Write-Host '  ------------------------------------------' -ForegroundColor DarkGray
Write-Host ''

$failed = $false

$routerPort = [System.Environment]::GetEnvironmentVariable('ROUTER_PORT', 'User')
if (-not $routerPort) { $routerPort = $env:ROUTER_PORT }
if (-not $routerPort) { $routerPort = '8082' }
$routerPort = "$routerPort".Trim()
$expectedBase = "http://127.0.0.1:$routerPort"

Write-Status -Label 'Expected router base:' -Value $expectedBase
Write-Status -Label 'Router probe URL:' -Value $RouterBaseUrl

try {
    $health = Get-Json -Url "$RouterBaseUrl/api/health"
    Write-Status -Label 'Router health:' -Value ([string]$health.status) -Color 'Green'
}
catch {
    Write-Status -Label 'Router health:' -Value "FAILED ($($_.Exception.Message))" -Color 'Red'
    $failed = $true
}

$userBase = [string]([System.Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL', 'User'))
$sessionBase = [string]$env:ANTHROPIC_BASE_URL
$settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
$settingsJson = Read-JsonFile -Path $settingsPath
$settingsBase = ''
if ($settingsJson) {
    $envObj = Get-ObjectPropValue -Obj $settingsJson -Name 'env'
    $v = Get-ObjectPropValue -Obj $envObj -Name 'ANTHROPIC_BASE_URL'
    if ($null -ne $v) { $settingsBase = [string]$v }
}

$vsSettingsPath = Join-Path $env:APPDATA 'Code\User\settings.json'
$vsBase = Get-TerminalEnvValue -Settings (Read-JsonFile -Path $vsSettingsPath)

Write-Status -Label 'User env base URL:' -Value ($(if ($userBase) { $userBase } else { '(not set)' })) -Color $(if ($userBase -eq $expectedBase) { 'Green' } else { 'Yellow' })
Write-Status -Label 'Session env base URL:' -Value ($(if ($sessionBase) { $sessionBase } else { '(not set)' })) -Color $(if ($sessionBase -eq $expectedBase) { 'Green' } else { 'Yellow' })
Write-Status -Label '~/.claude base URL:' -Value ($(if ($settingsBase) { $settingsBase } else { '(missing)' })) -Color $(if ($settingsBase -eq $expectedBase) { 'Green' } else { 'Yellow' })
Write-Status -Label 'VS Code terminal env URL:' -Value ($(if ($vsBase) { $vsBase } else { '(missing)' })) -Color $(if ($vsBase -eq $expectedBase) { 'Green' } else { 'Yellow' })

if ($settingsBase -ne $expectedBase) {
    Write-Status -Label 'Routing precheck:' -Value 'WARN (~/.claude/settings.json not aligned)' -Color 'Yellow'
}

if ($vsBase -ne $expectedBase) {
    Write-Status -Label 'Routing precheck:' -Value 'WARN (IDE terminal env not aligned)' -Color 'Yellow'
}

$alignedSources = @(@($userBase, $sessionBase, $settingsBase, $vsBase) | Where-Object { $_ -eq $expectedBase })
if ($alignedSources.Count -eq 0) {
    Write-Status -Label 'Routing precheck:' -Value 'FAILED (no config source points to expected router URL)' -Color 'Red'
    $failed = $true
}

$logsBefore = @()
$startIndex = 0
try {
    $logsBefore = @(Get-RouterLogs)
    $startIndex = $logsBefore.Count
    Write-Status -Label 'Route logs before probe:' -Value "$startIndex"
}
catch {
    Write-Status -Label 'Route log fetch:' -Value "FAILED ($($_.Exception.Message))" -Color 'Red'
    $failed = $true
}

$probeBody = @{
    model      = 'claude-sonnet-4-5'
    max_tokens = 24
    stream     = $false
    messages   = @(
        @{
            role    = 'user'
            content = @(
                @{
                    type = 'text'
                    text = 'strict route verification'
                }
            )
        }
    )
} | ConvertTo-Json -Depth 8

try {
    Invoke-WebRequest -Uri "$RouterBaseUrl/v1/messages" -Method POST -ContentType 'application/json' -Body $probeBody -TimeoutSec 2 | Out-Null
}
catch {
    # Route decision is logged before full response completion. Timeout is acceptable here.
}

$entry = Wait-ForNewRouteLog -StartIndex $startIndex -WaitSec $TimeoutSec
if ($null -eq $entry) {
    Write-Status -Label 'Probe result:' -Value 'FAILED (no new route log after probe)' -Color 'Red'
    $failed = $true
}
else {
    $dest = [string]$entry.dest
    $time = [string]$entry.time
    $reason = [string]$entry.reason
    $reason = $reason -replace '[\u00B7\u2022]', ' | '
    $reason = $reason -replace '[\u2192\u2794\u27A4\u21D2]', ' -> '
    $reason = [System.Text.RegularExpressions.Regex]::Replace($reason, '[^\x20-\x7E]', ' ')
    $reason = [System.Text.RegularExpressions.Regex]::Replace($reason, '\s+', ' ').Trim()
    Write-Status -Label 'Probe result:' -Value ('PASS (dest={0} time={1})' -f $dest, $time) -Color 'Green'
    Write-Status -Label 'Probe route reason:' -Value $reason -Color 'DarkGray'
}

Write-Host ''
if ($failed) {
    Write-Host 'Strict verification: FAILED' -ForegroundColor Red
    Write-Host 'Fix with: npm run merge-env, restart IDE, then re-run this check.' -ForegroundColor Yellow
    exit 1
}

Write-Host 'Strict verification: PASS' -ForegroundColor Green
Write-Host 'This machine is configured to route Claude Code or IDE terminal traffic through the router.' -ForegroundColor DarkGray
exit 0

# Diagnose why Claude Code / IDE may not use the hybrid router.
$ErrorActionPreference = 'Continue'

Write-Host ''
Write-Host '  Claude Hybrid - client routing diagnosis' -ForegroundColor Cyan
Write-Host '  -----------------------------------------' -ForegroundColor DarkGray
Write-Host ''

$routerPort = [System.Environment]::GetEnvironmentVariable('ROUTER_PORT', 'User')
if (-not $routerPort) { $routerPort = $env:ROUTER_PORT }
if (-not $routerPort) { $routerPort = '8082' }
$routerPort = "$routerPort".Trim()
$portRx = [regex]::Escape($routerPort)
$kitRx = "^https?://(127\.0\.0\.1|localhost):${portRx}/?$"

$userBase = [System.Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL', 'User')
$sessBase = $env:ANTHROPIC_BASE_URL
$settingsBase = $null
$prevBase = $null

Write-Host '  ROUTER_PORT (expected):              ' -NoNewline
Write-Host $routerPort -ForegroundColor Gray

Write-Host '  ANTHROPIC_BASE_URL (User registry):  ' -NoNewline
if ($userBase) {
    $okUser = ($userBase -match $kitRx)
    Write-Host $userBase -ForegroundColor $(if ($okUser) { 'Green' } else { 'Yellow' })
}
else { Write-Host '(not set)' -ForegroundColor Red }

Write-Host '  ANTHROPIC_BASE_URL (this session):   ' -NoNewline
if ($sessBase) { Write-Host $sessBase -ForegroundColor Gray } else { Write-Host '(empty)' -ForegroundColor DarkGray }

$settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
Write-Host '  ~/.claude/settings.json:             ' -NoNewline
if (Test-Path $settingsPath) {
    try {
        $j = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $eb = $j.env.ANTHROPIC_BASE_URL
        $settingsBase = "$eb".Trim()
        $prevBase = "$($j.env.CLAUDE_HYBRID_PREV_ANTHROPIC_BASE_URL)".Trim()
        Write-Host $settingsPath -ForegroundColor Gray
        Write-Host '    env.ANTHROPIC_BASE_URL = ' -NoNewline
        $okEb = ($eb -match $kitRx)
        if ($okEb) { Write-Host $eb -ForegroundColor Green }
        elseif ($eb) { Write-Host $eb -ForegroundColor Yellow }
        else { Write-Host '(missing - npm run merge-env or .\setup.ps1)' -ForegroundColor Red }
        if ($prevBase) {
            Write-Host '    saved pre-router URL = ' -NoNewline
            Write-Host $prevBase -ForegroundColor DarkGray
        }
        Write-Host '    env.ANTHROPIC_API_KEY = ' -NoNewline
        if ($j.env.ANTHROPIC_API_KEY -and "$($j.env.ANTHROPIC_API_KEY)".Trim().Length -gt 0) {
            Write-Host '(set - API / pay-as-you-go; see README quota section)' -ForegroundColor Green
        }
        else {
            Write-Host '(not set - subscription auth only for Claude Code)' -ForegroundColor DarkGray
        }
    }
    catch {
        Write-Host 'exists but JSON parse failed - fix file' -ForegroundColor Red
    }
}
else {
    Write-Host 'missing (Claude Code may not see ANTHROPIC_BASE_URL)' -ForegroundColor Yellow
}

Write-Host ''
$listen = $false
$healthJson = $null
try {
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        $pNum = 0
        if ([int]::TryParse($routerPort, [ref]$pNum)) {
            $c = Get-NetTCPConnection -LocalPort $pNum -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
            $listen = [bool]$c
        }
    }
}
catch {}
if (-not $listen) {
    try {
        $rx = "^\s*TCP\s+\S+:${portRx}\s+\S+\s+LISTENING\s+\d+\s*$"
        $line = netstat -ano | Select-String $rx | Select-Object -First 1
        $listen = [bool]$line
    }
    catch {}
}
if ($listen) {
    try {
        $healthJson = Invoke-RestMethod -Uri "http://127.0.0.1:${routerPort}/api/stats" -TimeoutSec 3
    }
    catch {}
}

Write-Host "  Router listening on port ${routerPort}:      " -NoNewline
if ($listen) { Write-Host 'yes' -ForegroundColor Green } else { Write-Host 'no - start router (npm start or .\start_app.bat)' -ForegroundColor Red }

$clientUrl = if ($settingsBase) { $settingsBase } elseif ($userBase) { $userBase } else { $sessBase }
$mode = 'unknown'
if ($clientUrl -match $kitRx -and $listen) { $mode = 'hybrid-active' }
elseif ($clientUrl -match $kitRx -and -not $listen) { $mode = 'hybrid-misconfigured-router-down' }
elseif ($clientUrl -and $clientUrl -notmatch $kitRx -and -not $listen) { $mode = 'direct-proxy' }
elseif ($clientUrl -and $clientUrl -notmatch $kitRx -and $listen) { $mode = 'direct-proxy-bypasses-router' }
elseif (-not $clientUrl -and $listen) { $mode = 'hybrid-partial-settings-missing' }
else { $mode = 'direct-anthropic-default' }

Write-Host '  Routing mode:                        ' -NoNewline
switch ($mode) {
    'hybrid-active' { Write-Host 'hybrid active (client -> router -> local/cloud)' -ForegroundColor Green }
    'hybrid-misconfigured-router-down' { Write-Host 'client points at router but router is down' -ForegroundColor Red }
    'direct-proxy' { Write-Host 'direct proxy (client -> custom URL, no hybrid)' -ForegroundColor Yellow }
    'direct-proxy-bypasses-router' { Write-Host 'custom URL bypasses router while router is up' -ForegroundColor Yellow }
    'hybrid-partial-settings-missing' { Write-Host 'router up but Claude settings.json missing client URL' -ForegroundColor Yellow }
    default { Write-Host 'direct Anthropic default / unset' -ForegroundColor DarkGray }
}

$cloudHost = 'api.anthropic.com'
$cloudProto = 'https'
$cloudPort = 443
if ($healthJson -and $healthJson.config -and $healthJson.config.cloud_upstream) {
    $cloudHost = "$($healthJson.config.cloud_upstream.host)"
    $cloudProto = "$($healthJson.config.cloud_upstream.protocol)"
    $cloudPort = "$($healthJson.config.cloud_upstream.port)"
}
else {
    $repoRoot = Split-Path $PSScriptRoot -Parent
    $hc = Join-Path $repoRoot 'router\hybrid.config.json'
    if (Test-Path $hc) {
        try {
            $cfg = Get-Content $hc -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($cfg.cloud.base_url) {
                $u = [Uri]$cfg.cloud.base_url
                $cloudHost = $u.Host
                $cloudProto = $u.Scheme
                if ($u.Port -gt 0) { $cloudPort = $u.Port }
            }
            elseif ($cfg.cloud.host) {
                $cloudHost = "$($cfg.cloud.host)"
                if ($cfg.cloud.protocol) { $cloudProto = "$($cfg.cloud.protocol)" }
                if ($cfg.cloud.port) { $cloudPort = "$($cfg.cloud.port)" }
            }
        }
        catch {}
    }
    elseif ($prevBase) {
        try {
            $u = [Uri]$prevBase
            $cloudHost = $u.Host
            $cloudProto = $u.Scheme
            if ($u.Port -gt 0) { $cloudPort = $u.Port }
        }
        catch {}
    }
    elseif ($userBase -and $userBase -notmatch $kitRx) {
        try {
            $u = [Uri]$userBase
            $cloudHost = $u.Host
            $cloudProto = $u.Scheme
            if ($u.Port -gt 0) { $cloudPort = $u.Port }
        }
        catch {}
    }
}

Write-Host '  Cloud upstream (hybrid -> cloud):    ' -NoNewline
Write-Host "${cloudProto}://${cloudHost}:${cloudPort}" -ForegroundColor Gray

Write-Host ''
Write-Host '  Claude Code CLI install test:        ' -NoNewline
$defaultCliPath = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
$cliCmd = Get-Command claude -ErrorAction SilentlyContinue
if ($cliCmd) {
    Write-Host "found ($($cliCmd.Source))" -ForegroundColor Green
}
elseif (Test-Path $defaultCliPath) {
    Write-Host "found at default path ($defaultCliPath)" -ForegroundColor Green
}
else {
    Write-Host "not found (expected default: $defaultCliPath)" -ForegroundColor Yellow
}

$rh = [System.Environment]::GetEnvironmentVariable('ROUTER_HOST', 'User')
if (-not $rh) { $rh = $env:ROUTER_HOST }
Write-Host '  ROUTER_HOST (optional):              ' -NoNewline
if ($rh) { Write-Host $rh -ForegroundColor Gray } else { Write-Host '(unset = bind 127.0.0.1; use 0.0.0.0 for LAN)' -ForegroundColor DarkGray }

$repoRoot = Split-Path $PSScriptRoot -Parent
$hc = Join-Path $repoRoot 'router\hybrid.config.json'
Write-Host '  router\hybrid.config.json:           ' -NoNewline
if (Test-Path $hc) { Write-Host 'present' -ForegroundColor Green } else { Write-Host 'optional - run setup.ps1 to copy example' -ForegroundColor DarkGray }

$adm = $env:ROUTER_ADMIN_TOKEN
Write-Host '  ROUTER_ADMIN_TOKEN:                  ' -NoNewline
if ($adm) { Write-Host 'set (dashboard: use Admin token field)' -ForegroundColor Yellow } else { Write-Host '(unset - mutating API open)' -ForegroundColor DarkGray }

Write-Host '  Notes:' -ForegroundColor DarkGray
Write-Host '    - Hybrid mode: client -> http://127.0.0.1:<port>, cloud -> custom proxy or Anthropic.' -ForegroundColor DarkGray
Write-Host '    - Direct mode: keep custom ANTHROPIC_BASE_URL and do not run start_app.bat / merge-env.' -ForegroundColor DarkGray
Write-Host '    - start_app.bat / merge-env auto-detect a custom client URL and keep it as cloud upstream.' -ForegroundColor DarkGray
Write-Host '    - Apps started from the taskbar often ignore User env until restart or settings.json merge.' -ForegroundColor DarkGray
Write-Host '    - Need proof of real routed traffic? Run: npm run diagnose:strict' -ForegroundColor DarkGray
Write-Host ''

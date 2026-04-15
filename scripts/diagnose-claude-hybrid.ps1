# Diagnose why Claude Code / IDE may not use the hybrid router (local Gemma + cloud fallback).
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

$userBase = [System.Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL', 'User')
$sessBase = $env:ANTHROPIC_BASE_URL
Write-Host '  ROUTER_PORT (expected):              ' -NoNewline
Write-Host $routerPort -ForegroundColor Gray

Write-Host '  ANTHROPIC_BASE_URL (User registry):  ' -NoNewline
if ($userBase) {
    $okUser = ($userBase -match "^https?://(127\.0\.0\.1|localhost):${portRx}/?$")
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
        Write-Host $settingsPath -ForegroundColor Gray
        Write-Host '    env.ANTHROPIC_BASE_URL = ' -NoNewline
        $okEb = ($eb -match "^https?://(127\.0\.0\.1|localhost):${portRx}/?$")
        if ($okEb) { Write-Host $eb -ForegroundColor Green }
        elseif ($eb) { Write-Host $eb -ForegroundColor Yellow }
        else { Write-Host '(missing - npm run merge-env or .\setup.ps1)' -ForegroundColor Red }
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
Write-Host "  Router listening on port ${routerPort}:      " -NoNewline
if ($listen) { Write-Host 'yes' -ForegroundColor Green } else { Write-Host 'no - start router (npm start or node router\server.js)' -ForegroundColor Red }

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
Write-Host '    - Claude Code reads env from your shell OR from ~/.claude/settings.json (env key).' -ForegroundColor DarkGray
Write-Host '    - Apps started from the taskbar (VS Code) often ignore User env until you' -ForegroundColor DarkGray
Write-Host '      sign out/in or add env via settings.json (merge script above).' -ForegroundColor DarkGray
Write-Host '    - Apply routing to Claude + VS Code terminals:  npm run merge-env   (or: setup.ps1)' -ForegroundColor DarkGray
Write-Host '    - Need proof of real routed traffic? Run: npm run diagnose:strict' -ForegroundColor DarkGray
Write-Host "    - Quota / pay-as-you-go: README section 'Claude Code: hit your limit'" -ForegroundColor DarkGray
Write-Host '    - Quota text (e.g. hit your limit for Claude messages) can be from (A) Claude' -ForegroundColor DarkGray
Write-Host '      Code subscription/auth paths that never hit this router, or (B) Anthropic API' -ForegroundColor DarkGray
Write-Host '      after the router forwarded a cloud request. Check: when the message appears,' -ForegroundColor DarkGray
Write-Host '      does the router dashboard footer log show a new request? If not, fix env/' -ForegroundColor DarkGray
Write-Host '      settings.json first - not the hybrid routing code.' -ForegroundColor DarkGray
Write-Host ''

# Diagnose why Claude Code / IDE may not use the hybrid router (local Gemma + cloud fallback).
$ErrorActionPreference = "Continue"

Write-Host ""
Write-Host "  Claude Hybrid - client routing diagnosis" -ForegroundColor Cyan
Write-Host "  -----------------------------------------" -ForegroundColor DarkGray
Write-Host ""

$userBase = [System.Environment]::GetEnvironmentVariable("ANTHROPIC_BASE_URL", "User")
$sessBase = $env:ANTHROPIC_BASE_URL
Write-Host "  ANTHROPIC_BASE_URL (User registry):  " -NoNewline
if ($userBase) { Write-Host $userBase -ForegroundColor $(if ($userBase -eq "http://localhost:8082") { "Green" } else { "Yellow" }) }
else { Write-Host "(not set)" -ForegroundColor Red }

Write-Host "  ANTHROPIC_BASE_URL (this session):   " -NoNewline
if ($sessBase) { Write-Host $sessBase -ForegroundColor Gray } else { Write-Host "(empty - normal in GUI-launched apps)" -ForegroundColor DarkGray }

$settingsPath = Join-Path $env:USERPROFILE ".claude\settings.json"
Write-Host "  ~/.claude/settings.json:             " -NoNewline
if (Test-Path $settingsPath) {
    try {
        $j = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $eb = $j.env.ANTHROPIC_BASE_URL
        Write-Host $settingsPath -ForegroundColor Gray
        Write-Host "    env.ANTHROPIC_BASE_URL = " -NoNewline
        if ($eb -eq "http://localhost:8082") { Write-Host $eb -ForegroundColor Green }
        elseif ($eb) { Write-Host $eb -ForegroundColor Yellow }
        else { Write-Host "(missing - run setup.ps1 or: node scripts\merge-claude-hybrid-env.js)" -ForegroundColor Red }
    } catch {
        Write-Host "exists but JSON parse failed - fix file" -ForegroundColor Red
    }
} else {
    Write-Host "missing (Claude Code may not see ANTHROPIC_BASE_URL)" -ForegroundColor Yellow
}

Write-Host ""
$listen = $false
try {
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        $c = Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        $listen = [bool]$c
    }
} catch {}
if (-not $listen) {
    try {
        $line = netstat -ano | Select-String "^\s*TCP\s+\S+:8082\s+\S+\s+LISTENING\s+\d+\s*$" | Select-Object -First 1
        $listen = [bool]$line
    } catch {}
}
Write-Host "  Router :8082 listening:              " -NoNewline
if ($listen) { Write-Host "yes" -ForegroundColor Green } else { Write-Host "no - start router (.\setup.ps1 -Autostart or node router\server.js)" -ForegroundColor Red }

Write-Host ""
$rh = [System.Environment]::GetEnvironmentVariable("ROUTER_HOST", "User")
if (-not $rh) { $rh = $env:ROUTER_HOST }
Write-Host "  ROUTER_HOST (optional):              " -NoNewline
if ($rh) { Write-Host $rh -ForegroundColor Gray } else { Write-Host "(unset = bind 127.0.0.1; use 0.0.0.0 for LAN)" -ForegroundColor DarkGray }

$repoRoot = Split-Path $PSScriptRoot -Parent
$hc = Join-Path $repoRoot "router\hybrid.config.json"
Write-Host "  router\hybrid.config.json:           " -NoNewline
if (Test-Path $hc) { Write-Host "present" -ForegroundColor Green } else { Write-Host "optional — run setup.ps1 to copy example" -ForegroundColor DarkGray }

$adm = $env:ROUTER_ADMIN_TOKEN
Write-Host "  ROUTER_ADMIN_TOKEN:                  " -NoNewline
if ($adm) { Write-Host "set (dashboard: use Admin token field)" -ForegroundColor Yellow } else { Write-Host "(unset — mutating API open)" -ForegroundColor DarkGray }

Write-Host "  Notes:" -ForegroundColor DarkGray
Write-Host "    - Claude Code reads env from your shell OR from ~/.claude/settings.json (env key)." -ForegroundColor DarkGray
Write-Host "    - Apps started from the taskbar (Cursor, VS Code) often ignore User env until you" -ForegroundColor DarkGray
Write-Host "      sign out/in or add env via settings.json (merge script above)." -ForegroundColor DarkGray
Write-Host "    - The consumer Claude desktop app (claude.ai) does not use this proxy; use" -ForegroundColor DarkGray
Write-Host "      Claude Code CLI, Cursor, or other API-compatible clients." -ForegroundColor DarkGray
Write-Host ""

# Optional PowerShell profile additions for Claude Hybrid
# These are NOT required - hybrid routing works automatically via ANTHROPIC_BASE_URL.
# Add these only if you want convenient manual overrides.
#
# Open profile: notepad $PROFILE
# Paste below, save, then reload: . $PROFILE

# Force cloud for current session (bypass proxy, useful for testing)
function claude-cloud {
    $saved = $env:ANTHROPIC_BASE_URL
    Remove-Item Env:ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
    Write-Host "  [cloud] Bypassing proxy - direct Anthropic API" -ForegroundColor Cyan
    claude @args
    $env:ANTHROPIC_BASE_URL = $saved
}

# Check routing status
function claude-mode {
    $url = [System.Environment]::GetEnvironmentVariable("ANTHROPIC_BASE_URL", "User")
    $session = $env:ANTHROPIC_BASE_URL
    $hybrid = ($session -match '^https?://(127\.0\.0\.1|localhost):8082/?$') -or ($url -match '^https?://(127\.0\.0\.1|localhost):8082/?$')
    if ($hybrid) {
        Write-Host "Hybrid routing active (ANTHROPIC_BASE_URL points at this kit's router)" -ForegroundColor Green
    } elseif ($session -match '^https?://(127\.0\.0\.1|localhost):\d+/?$' -or $url -match '^https?://(127\.0\.0\.1|localhost):\d+/?$') {
        Write-Host "Proxy URL set on localhost (check ROUTER_PORT if not 8082)" -ForegroundColor Green
    } elseif (-not $session -and -not $url) {
        Write-Host "No ANTHROPIC_BASE_URL in session or User env (Claude Code may use ~/.claude/settings.json)" -ForegroundColor DarkGray
    } else {
        Write-Host "Cloud or custom API path (session or User env differs from localhost router)" -ForegroundColor Cyan
    }
}

# Start Ollama server in background if not running
function ollama-start {
    if (-not (Get-Process -Name "ollama" -ErrorAction SilentlyContinue)) {
        Start-Process ollama -ArgumentList "serve" -WindowStyle Hidden
        Write-Host "Ollama started" -ForegroundColor Green
    } else {
        Write-Host "Ollama already running" -ForegroundColor Gray
    }
}
